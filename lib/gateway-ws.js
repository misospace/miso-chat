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
        
        this.ws = null;
        this.connected = false;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
        this.reconnectDelay = options.reconnectDelay || 1000;
        this.reconnectBackoff = options.reconnectBackoff || 2;
        
        // Store origin for reconnection
        this._lastOrigin = options.origin || 'http://localhost:3000';
        
        this.pendingRequests = new Map();
        this.requestIdCounter = 0;
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

    /**
     * Connect to the Gateway WebSocket server
     * @public
     * @param {string} origin - Origin header for the connection (used for reconnection)
     * @returns {Promise<boolean>} Resolves when connected, rejects on error
     */
    connect(origin = 'http://localhost:3000') {
        return new Promise((resolve, reject) => {
            if (this.connected) {
                return resolve(true);
            }
            
            if (this.connecting) {
                // Wait for existing connection attempt
                this.once('connected', () => resolve(true));
                this.once('error', (err) => reject(err));
                return;
            }

            this.connecting = true;
            
            const headers = {
                ...this.headers,
                origin: origin,
            };

            this.ws = new WebSocket(this.wsUrl, { headers });

            this.ws.on('open', () => {
                this.connected = true;
                this.connecting = false;
                this.reconnectAttempts = 0;
                // Update stored origin for future reconnections
                this._lastOrigin = origin;
                this.emit('connected');
                resolve(true);
            });

            this.ws.on('close', (code, reason) => {
                const wasConnected = this.connected;
                this.connected = false;
                this.connecting = false;
                this.emit('close', code, reason);
                
                if (wasConnected) {
                    this._attemptReconnect(this._lastOrigin);
                }
            });

            this.ws.on('error', (error) => {
                this.connecting = false;
                this.emit('error', error);
                // If we were connected before, try to reconnect
                if (this.connected || this.reconnectAttempts > 0) {
                    this._attemptReconnect(this._lastOrigin);
                }
                reject(error);
            });

            this.ws.on('message', (data) => {
                try {
                    const frame = JSON.parse(data.toString());
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
        // Handle response to a pending request
        if (frame.id && this.pendingRequests.has(frame.id)) {
            const { resolve, reject, timeout } = this.pendingRequests.get(frame.id);
            clearTimeout(timeout);
            this.pendingRequests.delete(frame.id);
            
            if (frame.error) {
                reject(new Error(frame.error.message || frame.error));
            } else {
                resolve(frame);
            }
            return;
        }

        // Emit event for other frames
        this.emit('frame', frame);
        
        if (frame.type === 'event') {
            this.emit('gateway-event', frame.event, frame.data);
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
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
        this.connecting = false;
        this.pendingRequests.clear();
    }

    /**
     * Check if currently connected
     */
    isConnected() {
        return this.connected;
    }
}

module.exports = { GatewayWsManager };
