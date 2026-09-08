'use strict';

const path = require('node:path');
const express = require('express');
const config = require('./config');
const { apiRouter } = require('./routes/api');
const { renderDashboard, renderHistory, renderDetail } = require('./views');

/**
 * Aplicación Express: panel administrativo + API + health checks.
 */

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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
