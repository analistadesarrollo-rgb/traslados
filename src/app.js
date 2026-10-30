'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const auth = require('./auth');
const { apiRouter } = require('./routes/api');
const {
  renderDashboard,
  renderHistory,
  renderDetail,
  renderNumbers,
  renderLogin,
  renderUsers,
  renderSchedules,
  renderScheduleNew,
} = require('./views');

function checkSession(req, res, next) {
  const token = req.cookies[auth.SESSION_COOKIE];
  if (token) {
    const payload = auth.verifySessionToken(token);
    const user = payload ? auth.resolveSessionUser(payload) : null;
    if (user) {
      req.auth = user;
      req.authenticatedUser = user.username;
      return next();
    }
  }
  if (req.path === '/login' || req.originalUrl === '/api/health') return next();
  // La API decide entre Basic Auth y 401 en requireAuth.
  if (req.path.startsWith('/api/')) return next();
  return res.redirect('/login');
}

function requirePageRole(role) {
  return (req, res, next) => {
    if (!req.auth) return res.redirect('/login');
    if (req.auth.role !== role && req.auth.role !== 'admin') {
      return res.status(403).send('No autorizado');
    }
    return next();
  };
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
    const user = auth.authenticate(username, password);
    if (user) {
      const token = auth.createSessionToken(user);
      const maxAge = Math.floor(auth.SESSION_TTL_MS / 1000);
      res.setHeader(
        'Set-Cookie',
        `${auth.SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`
      );
      return res.redirect(user.role === 'admin' ? '/' : '/schedules');
    }
    return res.send(renderLogin('Usuario o contraseña incorrectos'));
  });

  app.get('/logout', (req, res) => {
    res.setHeader(
      'Set-Cookie',
      `${auth.SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`
    );
    res.redirect('/login');
  });

  // Auth middleware para el resto
  app.use(checkSession);

  // API
  app.use('/api', apiRouter);

  // Panel administrativo (server-side render)
  app.get('/', requirePageRole('admin'), (req, res) => {
    res.send(renderDashboard(req.auth));
  });
  app.get('/dashboard', requirePageRole('admin'), (req, res) => {
    res.send(renderDashboard(req.auth));
  });
  app.get('/history', requirePageRole('admin'), (req, res) => {
    res.send(renderHistory(req.auth));
  });
  app.get('/history/:id', requirePageRole('admin'), (req, res) => {
    res.send(renderDetail(req.params.id, req.auth));
  });
  app.get('/numbers', requirePageRole('admin'), (req, res) => {
    res.send(renderNumbers(req.auth));
  });
  app.get('/users', requirePageRole('admin'), (req, res) => {
    res.send(renderUsers(req.auth));
  });

  // Programación de traslados (admin y scheduler)
  app.get('/schedules/new', (req, res) => {
    res.send(renderScheduleNew(req.auth));
  });
  app.get('/schedules', (req, res) => {
    res.send(renderSchedules(req.auth));
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
