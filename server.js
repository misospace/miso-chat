const express = require('express');
const session = require('express-session');
const http = require('http');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const rateLimit = require('express-rate-limit');
const https = require('https');
require('dotenv').config();

const securityMiddleware = require('./security');

const app = express();
const server = http.createServer(app);

// Trust proxy for rate limiting behind Envoy
app.set('trust proxy', 1);

// Apply security middleware
securityMiddleware.forEach(middleware => app.use(middleware));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  proxyTrust: true
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
    sameSite: 'strict',
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
if (process.env.OIDC_ENABLED !== 'true') {
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
} else {
  passport.use('oidc', new (require('passport-openidconnect').Strategy)({
    issuer: process.env.OIDC_ISSUER,
    authorizationURL: process.env.OIDC_ISSUER + '/authorization/',
    tokenURL: process.env.OIDC_ISSUER + '/token/',
    userInfoURL: process.env.OIDC_ISSUER + '/userinfo/',
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
app.get('/login', (req, res) => res.sendFile(__dirname + '/public/login.html'));
app.post('/login', passport.authenticate('local', { successRedirect: '/', failureRedirect: '/login?error=invalid' }));
app.get('/auth/oidc', passport.authenticate('oidc'));
app.get('/auth/oidc/callback', passport.authenticate('oidc', { successRedirect: '/', failureRedirect: '/login?error=oidc_failed' }));
app.post('/logout', (req, res) => {
  req.logout(() => {
    if (process.env.OIDC_ENABLED === 'true' && process.env.OIDC_ISSUER) {
      return res.redirect(process.env.OIDC_ISSUER + '/logout/?next=' + encodeURIComponent(req.protocol + '://' + req.get('host') + '/login'));
    }
    res.redirect('/login');
  });
});

// Protected routes
app.get('/', isAuthenticated, (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/api/auth', (req, res) => res.json({ authenticated: req.isAuthenticated(), user: req.user, oidc: process.env.OIDC_ENABLED === 'true' }));
app.get('/api/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime(), timestamp: new Date().toISOString() }));

// ============ GATEWAY HTTP API ============

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://openclaw.llm.svc.cluster.local:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || process.env.GATEWAY_AUTH_TOKEN || '';

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

// GET /api/sessions - List all sessions via gateway
app.get('/api/sessions', isAuthenticated, async (req, res) => {
  try {
    const result = await gatewayInvoke('sessions_list', {
      limit: 50,
      includeLastMessage: true,
      includeDerivedTitles: true,
    });
    const payload = unwrapToolResult(result);
    const sessions = (payload?.sessions || []).map((s) => ({
      sessionKey: s.key || s.sessionKey || s.sessionId,
      displayName: s.displayName || s.key || s.sessionKey,
      updatedAt: s.updatedAt,
      kind: s.kind,
      channel: s.channel,
      lastMessage: s.lastMessage,
      title: s.derivedTitle || s.title,
    }));
    res.json({ sessions });
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
    const messages = raw.map((m) => ({
      role: m.role || 'assistant',
      content:
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
                .filter(Boolean)
                .join('\n')
            : m.content?.text || m.text || JSON.stringify(m.content || ''),
      timestamp: m.timestamp,
    }));
    res.json({ sessionKey, messages });
  } catch (error) {
    console.error('Error getting history:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/sessions/:sessionKey/send - Send message via gateway
app.post('/api/sessions/:sessionKey/send', isAuthenticated, async (req, res) => {
  try {
    const { sessionKey } = req.params;
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    console.log(`Sending to ${sessionKey}:`, message);
    
    // Use sessions_send via gateway tools API (requires gateway.tools.allow override)
    const result = await gatewayInvoke('sessions_send', {
      sessionKey,
      message,
    });

    const payload = unwrapToolResult(result);
    res.json({ success: true, response: payload });
  } catch (error) {
    console.error('Error sending:', error.message);
    const msg = String(error.message || 'send failed');
    if (msg.includes('Tool not available')) {
      return res.status(500).json({
        error:
          'sessions_send is blocked by gateway.tools deny list. Add gateway.tools.allow: ["sessions_send"] in OpenClaw config.',
      });
    }
    res.status(500).json({ error: msg });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
🎉 Miso-Chat Server v0.1.9-hotfix running on port ${PORT}
   
   Gateway: ${GATEWAY_URL}
   Auth: ${process.env.OIDC_ENABLED === 'true' ? 'OIDC' : 'Local'}
   Node Env: ${process.env.NODE_ENV || 'development'}
   
   Login: http://localhost:${PORT}/login
   
   API:
   - GET  /api/sessions
   - GET  /api/sessions/:key/history
   - POST /api/sessions/:key/send
  `);
});
