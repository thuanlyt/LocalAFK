const express = require('express');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const config = require('../config');
const { router: authRouter, requireAuth } = require('./auth');
const { createApiRouter } = require('./api');
const { initSockets } = require('./sockets');

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// How often MemoryStore sweeps for expired sessions. Independent from SESSION_MAX_AGE_MS —
// that value (30 days) overflows Node's 32-bit setInterval limit (~24.8 days) if reused here.
const SESSION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function createServer(client, voiceManager) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Minimal unauthenticated liveness check for systemd/reverse-proxy health checks.
  // Deliberately does not depend on session/Discord gateway state.
  app.get('/healthz', (req, res) => {
    res.status(200).json({ ok: true });
  });

  const sessionMiddleware = session({
    // In-memory store with automatic pruning of expired sessions (unlike the default
    // express-session MemoryStore, which never evicts). Not persistent across restarts —
    // acceptable for this single-owner dashboard; see README "Giới hạn hiện tại".
    store: new MemoryStore({ checkPeriod: SESSION_PRUNE_INTERVAL_MS }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: SESSION_MAX_AGE_MS,
    },
  });
  app.use(sessionMiddleware);

  app.use('/auth', authRouter);
  app.use('/api', requireAuth, createApiRouter(client, voiceManager));
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  initSockets(io, sessionMiddleware, client, voiceManager);

  return { app, httpServer, io };
}

module.exports = { createServer };
