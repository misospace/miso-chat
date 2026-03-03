/**
 * Gateway WebSocket Manager
 * Maintains a persistent connection to the OpenClaw Gateway
 *
 * Issue: #111 - WebSocket manager class for persistent connection
 * Parent: #110 - Persistent WebSocket connection for real-time events
 */

const EventEmitter = require('events');
const WebSocket = require('ws');

class GatewayWsManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.wsUrl = options.wsUrl || process.env.GATEWAY_WS_URL || 'ws://openclaw.llm.svc.cluster.local:18789';
    this.clientId = options.clientId || 'miso-chat';
    this.clientVersion = options.clientVersion || 'miso-chat/1.0.0';
    this.clientMode = options.clientMode || 'ui';
    this.headers = options.headers || {};

    this.role = options.role || 'operator';
    this.scopes = Array.isArray(options.scopes) ? options.scopes : [];
    this.token = options.token || '';
    this.waitChallengeMs = Number(options.waitChallengeMs || process.env.GATEWAY_WS_WAIT_CHALLENGE_MS || 1200);
    this.buildDeviceAuth = typeof options.buildDeviceAuth === 'function' ? options.buildDeviceAuth : null;

    this.ws = null;
    this.connected = false; // protocol-connected (not just socket-open)
    this.connecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.reconnectBackoff = options.reconnectBackoff || 2;

    // Store origin for reconnection
    this._lastOrigin = options.origin || 'http://localhost:3000';

    this.pendingRequests = new Map();
    this.requestIdCounter = 0;

    this._connectId = null;
    this._challengeWaitTimer = null;
  }

  /**
   * Generate a unique request ID for tracking WebSocket messages
   * @public
   * @param {string} prefix - Prefix for the request ID (default: 'req')
   * @returns {string} Unique request ID in format `{prefix}-{timestamp}-{counter}`
   */
  createRequestId(prefix = 'req') {
    return `${prefix}-${Date.now()}-${++this.requestIdCounter}`;
  }

  _clearChallengeTimer() {
    if (this._challengeWaitTimer) {
      clearTimeout(this._challengeWaitTimer);
      this._challengeWaitTimer = null;
    }
  }

  _extractConnectChallengeNonce(frame) {
    if (!frame || typeof frame !== 'object') return '';
    if (frame.type === 'connect.challenge' && typeof frame.nonce === 'string') return frame.nonce;
    if (frame.type === 'event' && frame.event === 'connect.challenge' && typeof frame.payload?.nonce === 'string') {
      return frame.payload.nonce;
    }
    return '';
  }

  _extractGatewayError(frame) {
    if (!frame || typeof frame !== 'object') return '';
    const candidates = [
      frame.error,
      frame.err,
      frame.message,
      frame.reason,
      frame.details?.error,
      frame.payload?.error,
    ].filter(Boolean);

    for (const item of candidates) {
      if (typeof item === 'string') return item;
      if (typeof item === 'object') {
        if (typeof item.message === 'string') return item.message;
        if (typeof item.error === 'string') return item.error;
        if (typeof item.reason === 'string') return item.reason;
      }
    }
    return '';
  }

  _frameMatchesId(frame, id) {
    if (!frame || !id) return false;
    return frame.id === id || frame.requestId === id || frame.reqId === id;
  }

  _sendConnect(nonce = '') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this._connectId) return;

    const deviceAuth = nonce && this.buildDeviceAuth ? this.buildDeviceAuth({ nonce, scopes: this.scopes }) : null;

    this.ws.send(JSON.stringify({
      type: 'req',
      id: this._connectId,
      method: 'connect',
      params: {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: this.clientId,
          version: this.clientVersion,
          platform: process.platform,
          mode: this.clientMode,
        },
        role: this.role,
        scopes: this.scopes,
        caps: [],
        ...(this.token ? { auth: { token: this.token } } : {}),
        ...(deviceAuth ? { device: deviceAuth } : {}),
      },
    }));
  }

  /**
   * Connect to the Gateway WebSocket server
   * @public
   * @param {string} origin - Origin header for the connection (used for reconnection)
   * @returns {Promise<boolean>} Resolves when protocol connected, rejects on error
   */
  connect(origin = 'http://localhost:3000') {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        return resolve(true);
      }

      if (this.connecting) {
        this.once('connected', () => resolve(true));
        this.once('error', (err) => reject(err));
        return;
      }

      this.connecting = true;
      this._connectId = this.createRequestId('connect');
      let settled = false;

      const headers = {
        ...this.headers,
        origin,
      };

      this.ws = new WebSocket(this.wsUrl, { headers });

      this.ws.on('open', () => {
        this._lastOrigin = origin;

        this._challengeWaitTimer = setTimeout(() => {
          this.emit('challenge-timeout', this.waitChallengeMs);
          this._sendConnect('');
        }, Math.max(200, this.waitChallengeMs));
      });

      this.ws.on('close', (code, reason) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.connecting = false;
        this._clearChallengeTimer();
        this.emit('close', code, reason);

        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before Gateway connect handshake (code=${code})`));
        }

        if (wasConnected) {
          this._attemptReconnect(this._lastOrigin);
        }
      });

      this.ws.on('error', (error) => {
        this.connecting = false;
        this._clearChallengeTimer();
        this.emit('error', error);

        if (!settled) {
          settled = true;
          reject(error);
        }

        if (this.connected || this.reconnectAttempts > 0) {
          this._attemptReconnect(this._lastOrigin);
        }
      });

      this.ws.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString());

          // Challenge arrives before connect response
          if (!this.connected && this._extractConnectChallengeNonce(frame)) {
            const nonce = this._extractConnectChallengeNonce(frame);
            this._clearChallengeTimer();
            this._sendConnect(nonce);
            return;
          }

          // Connect response gate: manager is only usable after this succeeds
          if (!this.connected && this._frameMatchesId(frame, this._connectId)) {
            const connectError = this._extractGatewayError(frame);
            if (connectError || frame.status === 'error' || frame.type === 'error') {
              const err = new Error(connectError || 'Gateway connect failed');
              this.emit('error', err);
              try { this.ws.close(); } catch {
                // noop
              }
              return;
            }

            this.connected = true;
            this.connecting = false;
            this.reconnectAttempts = 0;
            this._clearChallengeTimer();
            this.emit('connected');

            if (!settled) {
              settled = true;
              resolve(true);
            }
            return;
          }

          this._handleFrame(frame);
        } catch (err) {
          this.emit('parse-error', err, data);
        }
      });
    });
  }

  /**
   * Handle incoming WebSocket frames from Gateway
   * @private
   * @param {Object} frame - Parsed WebSocket frame object
   */
  _handleFrame(frame) {
    if (frame.id && this.pendingRequests.has(frame.id)) {
      const { resolve, reject, timeout } = this.pendingRequests.get(frame.id);
      clearTimeout(timeout);
      this.pendingRequests.delete(frame.id);

      if (frame.error || frame.status === 'error' || frame.type === 'error') {
        reject(new Error(this._extractGatewayError(frame) || 'Gateway request failed'));
      } else {
        resolve(frame);
      }
      return;
    }

    this.emit('frame', frame);

    if (frame.type === 'event') {
      this.emit('gateway-event', frame.event, frame.payload ?? frame.data ?? null);
    }
  }

  /**
   * Attempt to reconnect with exponential backoff strategy
   * @private
   * @param {string} origin - Origin header for reconnection attempt
   */
  _attemptReconnect(origin) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('reconnect-failed', new Error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached. Gateway may be down or network issues.`));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(this.reconnectBackoff, this.reconnectAttempts - 1);

    this.emit('reconnecting', this.reconnectAttempts, delay);

    setTimeout(() => {
      this.connect(origin).catch((err) => {
        this.emit('reconnect-error', err);
      });
    }, delay);
  }

  /**
   * Send a request to the Gateway and wait for response
   * @public
   * @param {string} method - Gateway API method name (e.g., 'chat.send', 'sessions.list')
   * @param {Object} params - Parameters object for the gateway method
   * @param {number} timeoutSeconds - Request timeout in seconds (default: 30)
   * @returns {Promise<Object>} Resolves with Gateway response frame, rejects on error/timeout
   */
  send(method, params = {}, timeoutSeconds = 30) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        return reject(new Error(`WebSocket not connected. Method: ${method}. Is the Gateway accessible at ${this.wsUrl}?`));
      }

      const id = this.createRequestId(`req-${method}`);
      const timeout = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} (${id}) timed out after ${timeoutSeconds}s - Gateway may be overloaded or unreachable`));
        }
      }, timeoutSeconds * 1000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      this.ws.send(JSON.stringify({
        type: 'req',
        id,
        method,
        params,
      }));
    });
  }

  /**
   * Send a WebSocket frame without waiting for response (fire-and-forget)
   * @public
   * @param {Object} frame - Frame object to send (must have 'type' field)
   * @returns {Promise<boolean>} Resolves when frame is sent, rejects on error
   */
  sendFrame(frame) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        return reject(new Error(`Cannot send frame: WebSocket not connected. Frame type: ${frame.type || 'unknown'}`));
      }

      this.ws.send(JSON.stringify(frame), (err) => {
        if (err) reject(err);
        else resolve(true);
      });
    });
  }

  /**
   * Disconnect from the Gateway
   */
  disconnect() {
    this._clearChallengeTimer();
    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject?.(new Error('Gateway WS manager disconnected'));
    }
    this.pendingRequests.clear();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.connecting = false;
  }

  /**
   * Check if currently connected
   */
  isConnected() {
    return this.connected;
  }
}

module.exports = { GatewayWsManager };
