/**
 * Gateway WebSocket Manager
 * Maintains a persistent connection to the OpenClaw Gateway
 */

const EventEmitter = require('events');
const WebSocket = require('ws');
const crypto = require('crypto');
const fs = require('fs');

class GatewayWsManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.wsUrl = options.wsUrl || process.env.GATEWAY_WS_URL || 'ws://openclaw.llm.svc.cluster.local:18789';
        this.clientId = options.clientId || 'miso-chat';
        this.clientVersion = options.clientVersion || 'miso-chat/1.0.0';
        this.clientMode = options.clientMode || 'ui';
        this.headers = options.headers || {};
        this.deviceIdentityPath = options.deviceIdentityPath || process.env.GATEWAY_DEVICE_IDENTITY_PATH;
        this.authToken = options.authToken || process.env.GATEWAY_TOKEN || '';
        
        this.ws = null;
        this.connected = false;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
        this.reconnectDelay = options.reconnectDelay || 1000;
        this.reconnectBackoff = options.reconnectBackoff || 2;
        this._deviceIdentity = null;
        
        this._lastOrigin = options.origin || 'http://localhost:3000';
        this.pendingRequests = new Map();
        this.requestIdCounter = 0;
    }

    createRequestId(prefix = 'req') {
        return `${prefix}-${Date.now()}-${++this.requestIdCounter}`;
    }

    connect(origin = 'http://localhost:3000') {
        return new Promise((resolve, reject) => {
            if (this.connected) return resolve(true);
            if (this.connecting) {
                this.once('connected', () => resolve(true));
                this.once('error', (err) => reject(err));
                return;
            }

            this.connecting = true;
            const headers = { ...this.headers, origin };
            this.ws = new WebSocket(this.wsUrl, { headers });

            this.ws.on('open', () => {
                this.connected = true;
                this.connecting = false;
                this.reconnectAttempts = 0;
                this._lastOrigin = origin;
                this.emit('connected');
                resolve(true);
            });

            this.ws.on('close', (code, reason) => {
                const wasConnected = this.connected;
                this.connected = false;
                this.connecting = false;
                this.emit('close', code, reason);
                if (wasConnected) this._attemptReconnect(this._lastOrigin);
            });

            this.ws.on('error', (error) => {
                this.connecting = false;
                this.emit('error', error);
                if (this.connected || this.reconnectAttempts > 0) this._attemptReconnect(this._lastOrigin);
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

    _handleFrame(frame) { console.log("[WS Manager] Frame:", JSON.stringify(frame).slice(0, 200));
        // Handle connect.challenge
        if ((frame.type === 'event' && frame.event === 'connect.challenge' && frame.payload?.nonce) ||
            (frame.type === 'connect.challenge' && frame.nonce)) {
            const nonce = frame.payload?.nonce || frame.nonce;
            this._respondToChallenge(nonce);
            return;
        }

        if (frame.id && this.pendingRequests.has(frame.id)) {
            const { resolve, reject, timeout } = this.pendingRequests.get(frame.id);
            clearTimeout(timeout);
            this.pendingRequests.delete(frame.id);
            if (frame.error) reject(new Error(frame.error.message || frame.error));
            else resolve(frame);
            return;
        }

        this.emit('frame', frame);
        if (frame.type === 'event') this.emit('gateway-event', frame.event, frame.data);
    }

    _respondToChallenge(nonce) {
        try {
            const deviceAuth = this._buildDeviceAuth(nonce);
            this.ws.send(JSON.stringify({
                type: 'req',
                id: this.createRequestId('connect'),
                method: 'connect',
                params: {
                    minProtocol: 3,
                    maxProtocol: 3,
                    client: { id: this.clientId, version: this.clientVersion, platform: process.platform, mode: this.clientMode },
                    role: 'operator',
                    scopes: ['chat'],
                    caps: [],
                    ...(this.authToken ? { auth: { token: this.authToken } } : {}),
                    ...(deviceAuth ? { device: deviceAuth } : {}),
                }
            }));
            console.log('[WS Manager] Sent connect response with device auth');
        } catch (err) {
            console.error('[WS Manager] Failed to respond to connect.challenge:', err.message);
        }
    }

    _buildDeviceAuth(nonce) {
        const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
        
        if (!this._deviceIdentity && this.deviceIdentityPath) {
            try {
                const data = fs.readFileSync(this.deviceIdentityPath, 'utf8');
                this._deviceIdentity = JSON.parse(data);
            } catch (err) {
                console.error('[WS Manager] Failed to load device identity:', err.message);
                return null;
            }
        }
        if (!this._deviceIdentity) return null;
        
        const { deviceId, privateKeyPem, publicKeyPem } = this._deviceIdentity;
        if (!deviceId || !privateKeyPem) return null;

        const signedAt = Date.now();
        const payload = ['v2', deviceId, this.clientId, this.clientMode, 'operator', 'chat', String(signedAt), this.authToken || '', nonce].join('|');
        const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem));
        
        // Convert public key to base64url
        const publicKeyDer = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
        // Extract raw 32-byte Ed25519 public key from SPKI format
        let rawPublicKey;
        if (publicKeyDer.length === ED25519_SPKI_PREFIX.length + 32 && 
            publicKeyDer.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
            rawPublicKey = publicKeyDer.subarray(ED25519_SPKI_PREFIX.length);
        } else {
            rawPublicKey = publicKeyDer;
        }
        const publicKey = rawPublicKey.toString('base64url');

        return { 
            id: deviceId, 
            publicKey: publicKey,
            signature: Buffer.from(signature).toString('base64url'),
            signedAt: signedAt,
            nonce: nonce
        };
    }

    _attemptReconnect(origin) {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.emit('reconnect-failed', new Error('Max reconnection attempts reached'));
            return;
        }
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(this.reconnectBackoff, this.reconnectAttempts - 1);
        this.emit('reconnecting', this.reconnectAttempts, delay);
        setTimeout(() => this.connect(origin).catch(() => {}), delay);
    }

    send(method, params = {}, timeoutSeconds = 30) {
        return new Promise((resolve, reject) => {
            if (!this.connected) return reject(new Error('WebSocket not connected'));
            const id = this.createRequestId(`req-${method}`);
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${method} timed out`));
                }
            }, timeoutSeconds * 1000);
            this.pendingRequests.set(id, { resolve, reject, timeout });
            this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
        });
    }

    isConnected() { return this.connected; }
}

module.exports = { GatewayWsManager };
