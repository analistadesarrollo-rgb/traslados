'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const config = require('./config');
const { apiRouter } = require('./routes/api');
const { renderDashboard, renderHistory, renderDetail, renderNumbers, renderLogin } = require('./views');

const SESSION_SECRET = config.admin.password || 'transfer-bot-session';
const COOKIE_NAME = 'tb_session';

function signSession(val) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(val).digest('hex');
}

function checkSession(req, res, next) {
  const cookie = req.cookies[COOKIE_NAME];
  if (cookie) {
    const [user, sig] = cookie.split('.');
    if (sig === signSession(user) && user === config.admin.user) {
      req.authenticatedUser = user;
      return next();
    }
  }
  if (req.path === '/login') return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Autenticación requerida' });
  }
  return res.redirect('/login');
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Cookie parser simple (sin dependencia)
  app.use((req, res, next) => {
    req.cookies = {};
    const raw = req.headers.cookie || '';
    for (const pair of raw.split(';')) {
      const [k, ...v] = pair.split('=');
      if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
    }
    next();
  });

  // Login routes (antes del middleware de auth)
  app.get('/login', (req, res) => {
    res.send(renderLogin());
  });

  app.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === config.admin.user && password === config.admin.password) {
      const token = `${username}.${signSession(username)}`;
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
      return res.redirect('/');
    }
    return res.send(renderLogin('Usuario o contraseña incorrectos'));
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
    res.redirect('/login');
  });

  // Auth middleware para el resto
  app.use(checkSession);

  // API
  app.use('/api', apiRouter);

  // Panel administrativo (server-side render)
  app.get('/', (req, res) => {
    res.send(renderDashboard());
  });
  app.get('/dashboard', (req, res) => {
    res.send(renderDashboard());
  });
  app.get('/history', (req, res) => {
    res.send(renderHistory());
  });
  app.get('/history/:id', (req, res) => {
    res.send(renderDetail(req.params.id));
  });
  app.get('/numbers', (req, res) => {
    res.send(renderNumbers());
  });

  // Estática
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 404
  app.use((req, res) => {
    res.status(404).send('No encontrado');
  });

  return app;
}

function startServer() {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, () => {
      console.log(`[admin] Panel administrativo en http://localhost:${config.port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

module.exports = { createApp, startServer };
