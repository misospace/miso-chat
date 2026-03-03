const express = require('express');
const session = require('express-session');
const http = require('http');
const WebSocket = require('ws');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const { GatewayWsManager } = require('./lib/gateway-ws');
const securityMiddleware = require('./security');
const { reactions } = require('./lib/db');

const app = express();
const server = http.createServer(app);

const oidcEnabled = process.env.OIDC_ENABLED === 'true';
const localAuthEnabled = process.env.LOCAL_AUTH_ENABLED !== 'false';

// SSE clients for real-time gateway event forwarding
const sseClients = new Set();

// Trust proxy for rate limiting behind Envoy
app.set('trust proxy', 1);
// Enable CORS for frontend connection
const corsOptions = {
  origin: process.env.CORS_ORIGIN || true,
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));

// Apply security middleware
securityMiddleware.forEach(middleware => app.use(middleware));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// Middleware
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
// Protect direct access to index file
app.use((req, res, next) => {
  if (req.path === '/index.html' && !req.isAuthenticated?.()) {
    return res.redirect('/login');
  }
  next();
});

// Serve static assets, but do NOT auto-serve /index.html at root (keeps auth gate on /)
app.use(express.static('public', { index: false }));

// Session config
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    // OIDC auth redirects are cross-site; Strict drops session cookie on callback and causes loops.
    sameSite: oidcEnabled ? 'lax' : 'strict',
    maxAge: 24 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);

// Passport initialization
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Local Auth Strategy
if (localAuthEnabled) {
  const localUsers = (process.env.LOCAL_USERS || 'admin:password123').split(',');
  const validUsers = localUsers.map(u => {
    const [user, pass] = u.split(':');
    return { user: user.trim(), pass: pass.trim() };
  });

  passport.use(new LocalStrategy(
    (username, password, done) => {
      const valid = validUsers.find(u => u.user === username && u.pass === password);
      if (valid) return done(null, { username });
      return done(null, false, { message: 'Invalid credentials' });
    }
  ));
}

if (oidcEnabled) {
  const providerUrl = (process.env.OIDC_PROVIDER_URL || '').trim();
  const providerIssuer = providerUrl
    ? providerUrl.replace(/\/\.well-known\/openid-configuration\/?$/, '/')
    : '';

  const issuer = providerIssuer || process.env.OIDC_ISSUER;

  // Authentik-compatible defaults (works with app-specific provider URL)
  const oidcOrigin = (() => {
    try {
      return new URL(process.env.OIDC_ISSUER || issuer).origin;
    } catch {
      return process.env.OIDC_ISSUER || issuer;
    }
  })();

  const authorizationURL =
    process.env.OIDC_AUTHORIZATION_URL || `${oidcOrigin}/application/o/authorize/`;
  const tokenURL = process.env.OIDC_TOKEN_URL || `${oidcOrigin}/application/o/token/`;
  const userInfoURL =
    process.env.OIDC_USERINFO_URL || `${oidcOrigin}/application/o/userinfo/`;

  passport.use('oidc', new (require('passport-openidconnect').Strategy)({
    issuer,
    authorizationURL,
    tokenURL,
    userInfoURL,
    clientID: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    callbackURL: process.env.OIDC_CALLBACK_URL || '/auth/oidc/callback',
    scope: ['openid', 'profile', 'email']
  },
  (issuer, profile, done) => {
    return done(null, { username: profile.displayName || profile.username, email: profile.emails?.[0]?.value });
  }
  ));
}

const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
};

// Login
app.get('/login', (req, res) => {
  return res.sendFile(__dirname + '/public/login.html');
});

app.get('/api/login-options', (req, res) => {
  const issuerLabel = process.env.OIDC_ISSUER_LABEL
    || process.env.OIDC_PROVIDER_NAME
    || (process.env.OIDC_ISSUER ? String(process.env.OIDC_ISSUER).replace(/^https?:\/\//, '').replace(/\/.*/, '') : 'OIDC');
  res.json({
    localAuthEnabled,
    oidcEnabled,
    oidcLabel: issuerLabel,
  });
});

app.post('/login', (req, res, next) => {
  if (!localAuthEnabled) {
    return res.redirect('/login?error=local_disabled');
  }
  return passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login?error=invalid',
  })(req, res, next);
});
app.get('/auth/oidc', (req, res, next) => {
  if (!oidcEnabled) return res.redirect('/login?error=oidc_disabled');
  return passport.authenticate('oidc')(req, res, next);
});
app.get('/auth/oidc/callback', passport.authenticate('oidc', { successRedirect: '/', failureRedirect: '/login?error=oidc_failed' }));
app.post('/logout', (req, res) => {
  req.logout((logoutErr) => {
    if (logoutErr) {
      console.error('Logout error:', logoutErr.message || logoutErr);
    }

    req.session?.destroy(() => {
      res.clearCookie('connect.sid');
      if (process.env.OIDC_ENABLED === 'true' && process.env.OIDC_ISSUER) {
        return res.redirect(
          process.env.OIDC_ISSUER + '/logout/?next=' + encodeURIComponent(req.protocol + '://' + req.get('host') + '/login')
        );
      }
      return res.redirect('/login');
    });
  });
});

// Protected routes
app.get('/', isAuthenticated, (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/api/auth', (req, res) => res.json({ authenticated: req.isAuthenticated(), user: req.user, oidc: process.env.OIDC_ENABLED === 'true' }));

let gatewayWsLastError = '';
let gatewayWsLastClose = null;

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    gatewayWsConnected: gatewayWsManager?.isConnected?.() || false,
    gatewayWsReconnectAttempts: gatewayWsManager?.reconnectAttempts || 0,
    gatewayWsLastError,
    gatewayWsLastClose,
  });
});

/**
 * Infer a readable agent name from session key metadata
 * Handles formats like: agent:main:main, agent:chatgpt:thread-123, etc.
 * @param {string} sessionKey - The session key
 * @returns {string|null} - Formatted agent name or null if cannot infer
 */
function inferAgentNameFromKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") return null;
  
  // Handle agent:agentName:thread format (most common)
  if (sessionKey.startsWith("agent:")) {
    const parts = sessionKey.split(":");
    if (parts.length >= 2) {
      const agentName = parts[1];
      // Capitalize first letter, replace dashes/underscores with spaces
      return agentName
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  
  return null;
}

const CHAT_DISPLAY_NAME = process.env.CHAT_DISPLAY_NAME || process.env.ASSISTANT_NAME || 'Miso';
const APP_TITLE = process.env.APP_TITLE || `${CHAT_DISPLAY_NAME} Chat`;
const DEFAULT_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || process.env.MISO_CHAT_SESSION_KEY || 'agent:main:main';

app.get('/api/config', isAuthenticated, (req, res) => {
  res.json({
    title: APP_TITLE,
    assistantName: CHAT_DISPLAY_NAME,
    defaultSessionKey: DEFAULT_SESSION_KEY,
  });
});

// SSE endpoint for real-time gateway events (typing, message delta, errors)
app.get('/api/events', isAuthenticated, (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  // Add client to connected set
  sseClients.add(res);
  console.log(`📡 SSE client connected (${sseClients.size} total)`);

  // Remove client on close
  req.on('close', () => {
    sseClients.delete(res);
    console.log(`📡 SSE client disconnected (${sseClients.size} total)`);
  });
});

// Helper to broadcast events to all SSE clients
function broadcastToSseClients(event, data) {
  const payload = JSON.stringify({ event, data, timestamp: Date.now() });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

// ============ GATEWAY HTTP API ============

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://openclaw.llm.svc.cluster.local:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || process.env.GATEWAY_AUTH_TOKEN || '';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || (() => {
  try {
    const parsed = new URL(GATEWAY_URL);
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    return parsed.toString();
  } catch {
    return 'ws://openclaw.llm.svc.cluster.local:18789';
  }
})();

// Helper function to get GATEWAY_WS_URL value (handles both string and function types)
const getGatewayWsUrl = () => typeof GATEWAY_WS_URL === 'function' ? GATEWAY_WS_URL() : GATEWAY_WS_URL;
const GATEWAY_WS_ORIGIN = process.env.GATEWAY_WS_ORIGIN || '';
const GATEWAY_WS_CLIENT_ID = process.env.GATEWAY_WS_CLIENT_ID || 'webchat-ui';
const GATEWAY_WS_CLIENT_MODE = process.env.GATEWAY_WS_CLIENT_MODE || 'webchat';
const GATEWAY_DEVICE_IDENTITY_PATH = process.env.GATEWAY_DEVICE_IDENTITY_PATH
  || path.join(process.env.HOME || '/home/node', '.openclaw', 'identity', 'device.json');
const GATEWAY_WS_WAIT_CHALLENGE_MS = Number(process.env.GATEWAY_WS_WAIT_CHALLENGE_MS || 1200);

// Persistent WebSocket manager for gateway connections
const REQUESTED_GATEWAY_SCOPES = [
  'operator.read',
  'operator.write',
  'operator.pairing',
  'chat.send',
  'sessions.send',
  'sessions.list',
  'sessions.history',
];

const gatewayWsManager = new GatewayWsManager({
  wsUrl: getGatewayWsUrl(),
  clientId: GATEWAY_WS_CLIENT_ID,
  clientMode: GATEWAY_WS_CLIENT_MODE,
  token: GATEWAY_TOKEN,
  role: 'operator',
  scopes: REQUESTED_GATEWAY_SCOPES,
  waitChallengeMs: GATEWAY_WS_WAIT_CHALLENGE_MS,
  buildDeviceAuth: ({ nonce, scopes }) => buildGatewayDeviceAuth({ nonce, scopes }),
  headers: {
    ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
    ...(GATEWAY_WS_ORIGIN ? { Origin: GATEWAY_WS_ORIGIN } : {}),
  },
  maxReconnectAttempts: 5,
  reconnectDelay: 1000,
  reconnectBackoff: 2,
});

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
let cachedGatewayDeviceIdentity = null;

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function derivePublicKeyRawFromPem(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function buildDeviceAuthPayload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce }) {
  const scopesList = Array.isArray(scopes) ? scopes : [];
  return [
    'v2',
    deviceId,
    clientId,
    clientMode,
    role,
    scopesList.join(','),
    String(signedAtMs),
    token || '',
    nonce,
  ].join('|');
}

function fingerprintPublicKeyPem(publicKeyPem) {
  const raw = derivePublicKeyRawFromPem(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function persistGatewayDeviceIdentity(identity) {
  try {
    fs.mkdirSync(path.dirname(GATEWAY_DEVICE_IDENTITY_PATH), { recursive: true });
    fs.writeFileSync(GATEWAY_DEVICE_IDENTITY_PATH, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(GATEWAY_DEVICE_IDENTITY_PATH, 0o600);
    } catch {}
  } catch {}
}

function ensureGatewayDeviceIdentity() {
  if (cachedGatewayDeviceIdentity !== null) return cachedGatewayDeviceIdentity;

  // Try to load existing and self-heal bad deviceId derivation if needed.
  try {
    if (fs.existsSync(GATEWAY_DEVICE_IDENTITY_PATH)) {
      const raw = fs.readFileSync(GATEWAY_DEVICE_IDENTITY_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.deviceId && parsed?.publicKeyPem && parsed?.privateKeyPem) {
        const derivedDeviceId = fingerprintPublicKeyPem(parsed.publicKeyPem);
        const publicKey = base64UrlEncode(derivePublicKeyRawFromPem(parsed.publicKeyPem));
        const deviceId = typeof derivedDeviceId === 'string' && derivedDeviceId ? derivedDeviceId : parsed.deviceId;

        if (deviceId !== parsed.deviceId) {
          persistGatewayDeviceIdentity({
            ...parsed,
            version: parsed?.version === 1 ? parsed.version : 1,
            deviceId,
            createdAtMs: typeof parsed?.createdAtMs === 'number' ? parsed.createdAtMs : Date.now(),
          });
        }

        cachedGatewayDeviceIdentity = {
          deviceId,
          publicKey,
          privateKeyPem: parsed.privateKeyPem,
        };
        return cachedGatewayDeviceIdentity;
      }
    }
  } catch {}

  // Generate new identity
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = fingerprintPublicKeyPem(publicKeyPem);
  const identity = {
    version: 1,
    deviceId,
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now(),
  };
  persistGatewayDeviceIdentity(identity);

  cachedGatewayDeviceIdentity = {
    deviceId,
    publicKey: base64UrlEncode(derivePublicKeyRawFromPem(publicKeyPem)),
    privateKeyPem,
  };
  return cachedGatewayDeviceIdentity;
}

function loadGatewayDeviceIdentity() {
  if (cachedGatewayDeviceIdentity !== null) return cachedGatewayDeviceIdentity;

  try {
    const raw = fs.readFileSync(GATEWAY_DEVICE_IDENTITY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.publicKeyPem || !parsed?.privateKeyPem) {
      cachedGatewayDeviceIdentity = null;
      return null;
    }

    const publicKey = base64UrlEncode(derivePublicKeyRawFromPem(parsed.publicKeyPem));
    const deviceId = fingerprintPublicKeyPem(parsed.publicKeyPem);
    cachedGatewayDeviceIdentity = {
      deviceId,
      publicKey,
      privateKeyPem: parsed.privateKeyPem,
    };
    return cachedGatewayDeviceIdentity;
  } catch {
    cachedGatewayDeviceIdentity = null;
    return null;
  }
}

function buildGatewayDeviceAuth({ nonce, scopes }) {
  const identity = ensureGatewayDeviceIdentity();
  if (!identity || !nonce) return null;

  const signedAt = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: GATEWAY_WS_CLIENT_ID,
    clientMode: GATEWAY_WS_CLIENT_MODE,
    role: 'operator',
    scopes,
    signedAtMs: signedAt,
    token: GATEWAY_TOKEN,
    nonce,
  });

  const signature = base64UrlEncode(
    crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(identity.privateKeyPem))
  );

  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature,
    signedAt,
    nonce,
  };
}

function extractConnectChallengeNonce(frame) {
  if (!frame || typeof frame !== 'object') return '';

  if (frame.type === 'connect.challenge' && typeof frame.nonce === 'string') {
    return frame.nonce;
  }

  if (frame.type === 'event' && frame.event === 'connect.challenge' && typeof frame.payload?.nonce === 'string') {
    return frame.payload.nonce;
  }

  return '';
}

// Helper to call gateway via HTTP
function gatewayInvoke(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ tool, args });
    const url = new URL('/tools/invoke', GATEWAY_URL);
    const transport = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${GATEWAY_TOKEN}`
      }
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) return resolve(json.result);
          return reject(new Error(json.error?.message || 'Gateway invoke failed'));
        } catch {
          return reject(new Error(`Invalid gateway response: ${String(data).slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function unwrapToolResult(result) {
  if (!result) return {};
  if (result.details && typeof result.details === 'object') return result.details;
  const text = result?.content?.find?.((x) => x?.type === 'text')?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return result;
}

function extractReplyText(reply) {
  if (!reply) return '';
  if (typeof reply === 'string') return reply;
  if (Array.isArray(reply)) {
    return reply.map((x) => extractReplyText(x)).filter(Boolean).join('\n');
  }
  if (typeof reply.text === 'string') return reply.text;
  if (typeof reply.message === 'string') return reply.message;
  if (typeof reply.content === 'string') return reply.content;
  if (Array.isArray(reply.content)) {
    return reply.content
      .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Normalize a single tool call from OpenAI (tool_calls) or Anthropic (tool_use) style. */
function normalizeToolCall(part) {
  if (part?.type === 'tool_calls' && Array.isArray(part.tool_calls)) {
    return part.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name || tc.name || 'tool',
      arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
      result: tc.result,
      error: tc.error,
      status: tc.error ? 'error' : (tc.result !== undefined ? 'success' : 'calling'),
    }));
  }
  if (part?.type === 'tool_use') {
    const name = part.name || part.tool_use?.name || 'tool';
    const args = part.input ?? part.tool_use?.input ?? {};
    return [{
      id: part.id || part.tool_use?.id,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
      result: part.result,
      error: part.error,
      status: part.error ? 'error' : (part.result !== undefined ? 'success' : 'calling'),
    }];
  }
  return [];
}

function extractReplyToolCalls(reply) {
  const out = [];
  function walk(r) {
    if (!r) return;
    if (Array.isArray(r)) {
      r.forEach(walk);
      return;
    }
    if (typeof r !== 'object') return;
    if (Array.isArray(r.content)) {
      r.content.forEach((p) => {
        const list = normalizeToolCall(p);
        list.forEach((tc) => out.push(tc));
      });
    }
    if (Array.isArray(r.tool_calls)) {
      normalizeToolCall({ type: 'tool_calls', tool_calls: r.tool_calls }).forEach((tc) => out.push(tc));
    }
    walk(r.reply);
    walk(r.response);
    walk(r.details?.reply);
  }
  walk(reply);
  return out;
}

function buildGatewayWsHeaders({ origin } = {}) {
  const headers = {};
  if (GATEWAY_TOKEN) {
    headers.Authorization = `Bearer ${GATEWAY_TOKEN}`;
  }
  // Must match gateway.controlUi.allowedOrigins
  const requestOrigin = typeof origin === 'string' ? origin.trim() : '';
  const wsOrigin = requestOrigin || GATEWAY_WS_ORIGIN;
  if (wsOrigin) {
    headers.Origin = wsOrigin;
  }
  return headers;
}

function createRequestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseGatewayFrame(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  try {
    return JSON.parse(text);
  } catch {
    return { type: 'text', text };
  }
}

function frameMatchesId(frame, id) {
  if (!frame || !id) return false;
  return frame.id === id || frame.requestId === id || frame.replyTo === id;
}

function extractGatewayError(frame) {
  if (!frame) return '';
  if (typeof frame.error === 'string') return frame.error;
  if (frame.error?.message) return frame.error.message;
  if (frame.message && frame.status === 'error') return frame.message;
  return '';
}

function extractGatewayResult(frame) {
  if (!frame) return null;
  if (frame.result !== undefined) return frame.result;
  if (frame.reply !== undefined) return frame.reply;
  if (frame.data !== undefined) return frame.data;
  if (frame.payload !== undefined) return frame.payload;
  return frame;
}

// Use persistent WebSocket manager if available and connected, otherwise fall back to per-request WS
async function gatewayChatSendWithManager({ sessionKey, message, timeoutSeconds }) {
  if (!gatewayWsManager.isConnected()) {
    return null; // Signal to use fallback
  }

  // gatewayWsManager.send() handles timeouts internally
  try {
    const frame = await gatewayWsManager.send('chat.send', {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: gatewayWsManager.createRequestId('msg'),
    }, timeoutSeconds || 180);

    const error = extractGatewayError(frame);
    if (error) {
      throw new Error(error);
    }
    return extractGatewayResult(frame);
  } catch (err) {
    throw err; // Let main function handle fallback
  }
}

// Per-request WebSocket fallback (original implementation)
function gatewayChatSendFallback({ sessionKey, message, timeoutSeconds, origin }) {
  return new Promise((resolve, reject) => {
    const wsUrl = getGatewayWsUrl();
    const ws = new WebSocket(wsUrl, { headers: buildGatewayWsHeaders({ origin }) });
    const connectId = createRequestId('connect');
    const sendId = createRequestId('chat-send');
    const timeoutMs = Math.max(1000, Number(timeoutSeconds || 180) * 1000);

    let closed = false;
    let connected = false;

    const done = (err, result) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (challengeWaitTimer) {
        clearTimeout(challengeWaitTimer);
        challengeWaitTimer = null;
      }
      try {
        ws.close();
      } catch {
        // noop
      }
      if (err) return reject(err);
      return resolve(result);
    };

    const timeout = setTimeout(() => {
      done(new Error(`Gateway websocket timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const requestedScopes = ['operator.read', 'operator.write', 'operator.pairing', 'chat.send', 'sessions.send', 'sessions.list', 'sessions.history'];
    const hasDeviceIdentity = Boolean(ensureGatewayDeviceIdentity());
    let connectSent = false;
    let challengeWaitTimer = null;

    const sendConnect = (nonce = '') => {
      if (connectSent) return;
      connectSent = true;
      if (challengeWaitTimer) {
        clearTimeout(challengeWaitTimer);
        challengeWaitTimer = null;
      }

      const deviceAuth = nonce ? buildGatewayDeviceAuth({ nonce, scopes: requestedScopes }) : null;

      ws.send(
        JSON.stringify({
          type: 'req',
          id: connectId,
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: GATEWAY_WS_CLIENT_ID,
              version: 'miso-chat/1.0.0',
              platform: process.platform,
              mode: GATEWAY_WS_CLIENT_MODE,
            },
            role: 'operator',
            scopes: requestedScopes,
            caps: [],
            ...(GATEWAY_TOKEN
              ? {
                  auth: {
                    token: GATEWAY_TOKEN,
                  },
                }
              : {}),
            ...(deviceAuth ? { device: deviceAuth } : {}),
          },
        })
      );
    };

    ws.on('open', () => {
      if (hasDeviceIdentity) {
        challengeWaitTimer = setTimeout(() => {
          console.warn('Gateway connect.challenge not received in time; falling back to unsigned connect request');
          sendConnect('');
        }, Math.max(200, GATEWAY_WS_WAIT_CHALLENGE_MS));
      } else {
        sendConnect('');
      }
    });

    ws.on('message', (raw) => {
      const frame = parseGatewayFrame(raw);
      if (closed) return;

      if (!connected) {
        const challengeNonce = extractConnectChallengeNonce(frame);
        if (challengeNonce) {
          sendConnect(challengeNonce);
          return;
        }

        if (frameMatchesId(frame, connectId) || frame.type === 'connected' || frame.type === 'connect.ok') {
          const connectError = extractGatewayError(frame);
          if (connectError) {
            return done(new Error(connectError));
          }

          connected = true;
          ws.send(
            JSON.stringify({
              type: 'req',
              id: sendId,
              method: 'chat.send',
              params: {
                sessionKey,
                message,
                deliver: false,
                idempotencyKey: createRequestId('msg'),
              },
            })
          );
          return;
        }

        if (frame.type === 'error' || frame.status === 'error') {
          const err = extractGatewayError(frame) || 'Gateway connect failed';
          return done(new Error(err));
        }

        return;
      }

      if (frameMatchesId(frame, sendId) || frame.type === 'chat.send.ok' || frame.type === 'chat.send.result') {
        const sendError = extractGatewayError(frame);
        if (sendError) {
          return done(new Error(sendError));
        }
        return done(null, extractGatewayResult(frame));
      }
    });

    ws.on('error', (error) => {
      done(error);
    });

    ws.on('close', () => {
      if (!closed) {
        done(new Error('Gateway websocket closed before chat.send response'));
      }
    });
  });
}

// Main gatewayChatSend - tries persistent manager first, falls back to per-request
async function gatewayChatSend({ sessionKey, message, timeoutSeconds, origin }) {
  // Try persistent manager first
  try {
    const result = await gatewayChatSendWithManager({ sessionKey, message, timeoutSeconds });
    if (result !== null) {
      return result; // Used persistent manager successfully
    }
  } catch (err) {
    console.warn('⚠️ Persistent WS manager failed, falling back to per-request:', err.message);
  }
  
  // Fall back to per-request WebSocket
  return gatewayChatSendFallback({ sessionKey, message, timeoutSeconds, origin });
}

const ANNOUNCE_NOISE_MARKERS = ['ANNOUNCE_SKIP', 'Agent-to-agent announce step.'];
function isAnnounceNoiseLine(line) {
  const value = (line || '').trim();
  if (!value) return false;
  return ANNOUNCE_NOISE_MARKERS.some((marker) =>
    marker === 'ANNOUNCE_SKIP' ? value.includes(marker) : value === marker
  );
}

function sanitizeAssistantText(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value.trim()) return '';

  const cleaned = value
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !isAnnounceNoiseLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

// GET /api/sessions - List all sessions via gateway
app.get('/api/sessions', isAuthenticated, async (req, res) => {
  try {
    let rawSessions = [];

    const baseSessionsParams = {
      limit: 200,
      includeLastMessage: true,
      includeDerivedTitles: true,
    };

    const wsSessionsList = async () => {
      try {
        return await gatewayWsManager.send('sessions.list', { ...baseSessionsParams, includeArchived: true }, 15);
      } catch (err) {
        if (String(err?.message || '').includes('includeArchived')) {
          return gatewayWsManager.send('sessions.list', baseSessionsParams, 15);
        }
        throw err;
      }
    };

    const toolSessionsList = async () => {
      try {
        return await gatewayInvoke('sessions_list', { ...baseSessionsParams, includeArchived: true });
      } catch (err) {
        if (String(err?.message || '').includes('includeArchived')) {
          return gatewayInvoke('sessions_list', baseSessionsParams);
        }
        throw err;
      }
    };

    if (gatewayWsManager?.isConnected?.()) {
      try {
        const wsFrame = await wsSessionsList();
        rawSessions = wsFrame?.result?.sessions || wsFrame?.sessions || [];
      } catch (wsErr) {
        console.warn('sessions.list via WS failed, falling back to tools invoke:', wsErr.message);
      }
    }

    if (!Array.isArray(rawSessions) || rawSessions.length === 0) {
      const result = await toolSessionsList();
      const payload = unwrapToolResult(result);
      rawSessions = payload?.sessions || [];
    }

    const sessions = rawSessions
      .map((s) => {
        const sessionKey = s.key || s.sessionKey || s.sessionId;
        if (!sessionKey || sessionKey.includes(':cron:')) return null;

        const inferredAgentName = inferAgentNameFromKey(sessionKey);
        return {
          sessionKey,
          displayName: s.displayName || s.derivedTitle || s.title || s.agentName || inferredAgentName || sessionKey,
          updatedAt: s.updatedAt,
          kind: s.kind,
          channel: s.channel,
          lastMessage: s.lastMessage,
          title: s.derivedTitle || s.title || s.displayName,
          agentId: s.agentId,
          agentName: s.agentName || inferredAgentName,
        };
      })
      .filter(Boolean);

    const deduped = [];
    const seen = new Set();
    for (const s of sessions) {
      if (!s?.sessionKey || seen.has(s.sessionKey)) continue;
      seen.add(s.sessionKey);
      deduped.push(s);
    }

    res.json({ sessions: deduped, defaultSessionKey: DEFAULT_SESSION_KEY });
  } catch (error) {
    console.error('Error listing sessions:', error.message);
    res.json({ sessions: [], error: error.message });
  }
});

// GET /api/sessions/:sessionKey/history - Get session history via gateway
app.get('/api/sessions/:sessionKey/history', isAuthenticated, async (req, res) => {
  try {
    const { sessionKey } = req.params;
    const result = await gatewayInvoke('sessions_history', { sessionKey, limit: 100 });
    const payload = unwrapToolResult(result);
    const raw = payload?.history || payload?.messages || [];

    // Get reactions for this session (grouped by message_id)
    const sessionReactions = reactions.getForSession(sessionKey);

    const messages = raw
      .map((m) => {
        const role = m.role || 'assistant';
        let content;
        let toolCalls = [];

        if (typeof m.content === 'string') {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          const textParts = [];
          m.content.forEach((p) => {
            if (typeof p === 'string') {
              textParts.push(p);
            } else if (p?.text) {
              textParts.push(p.text);
            } else if (p?.content) {
              textParts.push(p.content);
            } else {
              const list = normalizeToolCall(p);
              list.forEach((tc) => toolCalls.push(tc));
            }
          });
          content = textParts.filter(Boolean).join('\n');
        } else {
          content = m.content?.text || m.text || JSON.stringify(m.content || '');
        }

        const text = role === 'assistant' ? sanitizeAssistantText(content) : content;
        const hasContent = typeof text === 'string' && text.trim().length > 0;
        const hasToolCalls = toolCalls.length > 0;
        if (!hasContent && !hasToolCalls) return null;

        // Get reaction counts for this message (match by timestamp prefix)
        const timestamp = m.timestamp;
        const messageReactions = [];
        if (timestamp && sessionReactions) {
          // Look for reactions with timestamp prefix (format: history:timestamp:role:...)
          for (const [msgId, emojis] of Object.entries(sessionReactions)) {
            if (msgId.startsWith(`history:${timestamp}:`) || msgId.startsWith(`reply:${timestamp}:`) || msgId.startsWith(`queued:${timestamp}`)) {
              for (const [emoji, users] of Object.entries(emojis)) {
                messageReactions.push({ emoji, count: users.length });
              }
            }
          }
        }

        return {
          role,
          content: hasContent ? text : (hasToolCalls ? ' ' : ''),
          timestamp: m.timestamp,
          ...(hasToolCalls ? { toolCalls } : {}),
          ...(messageReactions.length > 0 ? { reactions: messageReactions } : {}),
        };
      })
      .filter(Boolean);
    res.json({ sessionKey, messages });
  } catch (error) {
    console.error('Error getting history:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sessions/:sessionKey/send - Send message via gateway
app.post('/api/sessions/:sessionKey/send', isAuthenticated, async (req, res) => {
  try {
    const requestedSessionKey = req.params.sessionKey;
    const sessionKey = requestedSessionKey && requestedSessionKey !== 'default'
      ? requestedSessionKey
      : DEFAULT_SESSION_KEY;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    console.log(`Sending to ${sessionKey}: [message hidden]`);

    const timeoutSeconds = Number(process.env.SEND_TIMEOUT_SECONDS || 180);
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const payload = await gatewayChatSend({ sessionKey, message, timeoutSeconds, origin: requestOrigin });
    const replyPayload = payload?.reply || payload?.response || payload?.details?.reply || payload;
    const responseText = extractReplyText(replyPayload);
    const filteredResponseText = sanitizeAssistantText(responseText);
    const toolCalls = extractReplyToolCalls(replyPayload);

    res.json({ success: true, response: payload, responseText: filteredResponseText, toolCalls });
  } catch (error) {
    console.error('Error sending:', error.message);
    const msg = String(error.message || 'send failed');
    if (msg.includes('invalid connect params')) {
      return res.status(500).json({
        error:
          'Gateway rejected websocket connect params. Verify Origin is allowed, and ensure device identity is available at GATEWAY_DEVICE_IDENTITY_PATH so websocket scopes (operator.write) can be granted.',
      });
    }
    res.status(500).json({ error: msg });
  }
});

// ============ REACTION API ENDPOINTS ============

// GET /api/reactions/:sessionKey - Get all reactions for a session (batch load)
app.get('/api/reactions/:sessionKey', isAuthenticated, (req, res) => {
  try {
    const { sessionKey } = req.params;
    const allReactions = reactions.getForSession(sessionKey);
    res.json({ sessionKey, reactions: allReactions });
  } catch (error) {
    console.error('Error getting reactions:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/messages/:messageId/reactions - Get reactions for a specific message
app.get('/api/messages/:messageId/reactions', isAuthenticated, (req, res) => {
  try {
    const { messageId } = req.params;
    const messageReactions = reactions.getForMessage(messageId);
    res.json({ messageId, reactions: messageReactions });
  } catch (error) {
    console.error('Error getting message reactions:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/messages/:messageId/reactions - Add or remove a reaction (toggle)
app.post('/api/messages/:messageId/reactions', isAuthenticated, (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji, sessionKey } = req.body;
    const username = req.user?.username || req.user?.email || 'anonymous';

    if (!emoji) {
      return res.status(400).json({ error: 'Emoji is required' });
    }
    if (!sessionKey) {
      return res.status(400).json({ error: 'Session key is required' });
    }

    const result = reactions.toggle(messageId, sessionKey, emoji, username);
    res.json({ success: true, messageId, ...result });
  } catch (error) {
    console.error('Error toggling reaction:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

// Initialize WebSocket manager at startup
const initGatewayWsManager = async () => {
  try {
    const origin = GATEWAY_WS_ORIGIN || 'http://localhost:3000';
    await gatewayWsManager.connect(origin);
    gatewayWsLastError = '';
    gatewayWsLastClose = null;
    console.log('✅ Persistent Gateway WS manager connected');
    
    // Set up reconnection event handlers
    gatewayWsManager.on('reconnecting', (attempt, delay) => {
      console.log(`🔄 Gateway WS reconnecting (attempt ${attempt}) in ${delay}ms...`);
    });
    
    gatewayWsManager.on('reconnect-failed', (err) => {
      console.error('❌ Gateway WS reconnection failed:', err.message);
    });
    
    gatewayWsManager.on('close', (code, reason) => {
      gatewayWsLastClose = {
        code,
        reason: typeof reason === 'string' ? reason : String(reason || ''),
        at: new Date().toISOString(),
      };
      console.log(`🔌 Gateway WS closed: ${code} ${reason}`);
    });
    
    gatewayWsManager.on('error', (err) => {
      gatewayWsLastError = String(err?.message || err || 'unknown error');
      console.error('⚠️ Gateway WS error:', err.message);
    });
    
    // Forward gateway events to SSE clients
    gatewayWsManager.on('gateway-event', (eventType, eventData) => {
      console.log(`📡 Gateway event: ${eventType}`, eventData ? JSON.stringify(eventData).slice(0, 100) : '');
      broadcastToSseClients(eventType, eventData);
    });
    
  } catch (err) {
    console.error('❌ Failed to initialize persistent Gateway WS manager:', err.message);
    console.log('   Will fall back to per-request WebSocket connections');
  }
};

// Start server and initialize WS manager
server.listen(PORT, async () => {
  console.log(`
🎉 ${APP_TITLE} server running on port ${PORT}
   
   Gateway: ${GATEWAY_URL}
   Gateway WS: ${getGatewayWsUrl()}
   Gateway WS Origin: ${GATEWAY_WS_ORIGIN || '(none)'}
   Gateway WS Client: ${GATEWAY_WS_CLIENT_ID} (${GATEWAY_WS_CLIENT_MODE})
   Gateway Device Identity: ${fs.existsSync(GATEWAY_DEVICE_IDENTITY_PATH) ? GATEWAY_DEVICE_IDENTITY_PATH : 'missing'}
   Default Session: ${DEFAULT_SESSION_KEY}
   Auth: ${process.env.OIDC_ENABLED === 'true' ? 'OIDC' : 'Local'}
   Node Env: ${process.env.NODE_ENV || 'development'}
   
   Login: http://localhost:${PORT}/login
   
   API:
   - GET  /api/sessions
   - GET  /api/sessions/:key/history
   - POST /api/sessions/:key/send
  `);
  
  // Initialize persistent WebSocket manager
  await initGatewayWsManager();
});
