const express = require('express');
const session = require('express-session');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const config = require('../config');
const { router: authRouter, requireAuth } = require('./auth');
const { createApiRouter } = require('./api');
const { initSockets } = require('./sockets');

function createServer(client, voiceManager) {
  const app = express();
  app.set('trust proxy', 1);

  const sessionMiddleware = session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: 30 * 24 * 60 * 60 * 1000,
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
