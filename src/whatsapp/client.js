'use strict';

const fs = require('node:fs');
const path = require('node:path');
const qrcode = require('qrcode');
const config = require('../config');
const logger = require('../logger').child('whatsapp');

/**
 * Cliente de WhatsApp Web (whatsapp-web.js).
 *
 * Estrategia de disponibilidad 24/7:
 *  - LocalAuth: sesión persiste en disco (data/wa-session).
 *  - Keepalive: ping cada 30s para detectar desconexiones tempranas.
 *  - Reconexión con backoff exponencial (5s → 10s → 20s → 40s → 60s).
 *  - Si falla 5 veces consecutivas, limpia sesión y reinicia para nuevo QR.
 *  - Limpieza de lockfiles de Chrome antes de cada reconexión.
 *  - takeoverOnConflict: si hay otra sesión activa, esta la toma.
 */

let client = null;
let qrHandler = null;
let reconnecting = false;
let keepaliveInterval = null;
let intentosReconexion = 0;
const MAX_INTENTOS_RECONEXION = 5;
const KEEPALIVE_MS = 30_000;
const BACKOFF_BASE_MS = 5_000;

function getProfileDir() {
  return path.join(config.whatsapp.sessionDir, 'session-transfer-bot');
}

function limpiarLockfiles() {
  const profileDir = getProfileDir();
  for (const file of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    fs.rmSync(path.join(profileDir, file), { force: true });
  }
}

function limpiarSesion() {
  try {
    const dir = getProfileDir();
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      logger.warn('Sesión de WhatsApp eliminada de disco');
    }
  } catch (err) {
    logger.error('Error al limpiar sesión', { error: err.message });
  }
}

function iniciarKeepalive(waClient, state) {
  if (keepaliveInterval) clearInterval(keepaliveInterval);
  keepaliveInterval = setInterval(async () => {
    if (!state.connected) return;
    try {
      await waClient.ping();
    } catch (err) {
      logger.warn('Keepalive ping falló, forzando reconexión', { error: err.message });
      if (state.connected && !reconnecting) {
        state.connected = false;
        state.ready = false;
        reconectarConBackoff(waClient, state, 'keepalive_failed');
      }
    }
  }, KEEPALIVE_MS);
}

function detenerKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

async function reconectarConBackoff(waClient, state, reason) {
  if (reconnecting) return;
  reconnecting = true;
  intentosReconexion++;

  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, intentosReconexion - 1), 60_000);
  logger.warn('Intentando reconexión de WhatsApp', {
    reason,
    intento: intentosReconexion,
    maxIntentos: MAX_INTENTOS_RECONEXION,
    esperandoMs: delay,
  });

  try {
    await new Promise((r) => setTimeout(r, delay));
    await waClient.destroy().catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    limpiarLockfiles();
    await waClient.initialize();
    intentosReconexion = 0;
    logger.info('WhatsApp reconectado correctamente');
  } catch (err) {
    logger.error('Error en reconexión de WhatsApp', {
      error: err.message,
      intento: intentosReconexion,
    });

    if (intentosReconexion >= MAX_INTENTOS_RECONEXION) {
      logger.error('Máximo de reconexiones alcanzado. Limpiando sesión para nuevo QR');
      detenerKeepalive();
      limpiarSesion();
      process.exit(1);
    }

    reconnecting = false;
    reconectarConBackoff(waClient, state, reason);
  } finally {
    reconnecting = false;
  }
}

async function clearSessionLoggedOut(waClient, reason) {
  logger.warn('Sesión cerrada desde el celular; se generará un nuevo QR', { reason });
  detenerKeepalive();
  await waClient.destroy().catch(() => {});
  limpiarSesion();
  process.exit(1);
}

function onQr(handler) {
  qrHandler = handler;
}

function resolveClientModule() {
  return require('whatsapp-web.js');
}

async function createClient() {
  const { Client, LocalAuth } = resolveClientModule();

  if (client) return client;

  fs.mkdirSync(config.whatsapp.sessionDir, { recursive: true });
  limpiarLockfiles();

  const auth = new LocalAuth({
    clientId: 'transfer-bot',
    dataPath: config.whatsapp.sessionDir,
  });

  const puppeteerOpts = {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  };
  const browserPath = config.whatsapp.browserPath || config.automation.chromePath;
  if (browserPath && fs.existsSync(browserPath)) {
    puppeteerOpts.executablePath = browserPath;
  }
  puppeteerOpts.headless = true;

  const waClient = new Client({
    authStrategy: auth,
    puppeteer: puppeteerOpts,
    takeoverOnConflict: true,
    webVersionCache: {
      type: 'remote',
      remotePath:
        'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1047094411-alpha.html',
    },
  });

  client = waClient;
  return client;
}

function handleQr(qr) {
  logger.warn('QR recibido, escanee con WhatsApp Web para vincular');
  let term = '';
  try {
    term = qrcode.toString(qr, { type: 'terminal', small: true });
  } catch (_) {
    term = qr;
  }
  try {
    qrcode.toDataURL(qr, { width: 300, margin: 2 }, (err, url) => {
      try {
        if (qrHandler) qrHandler(url || '', term);
      } catch (_) {
        /* ignore */
      }
      global.__lastQr = { dataUrl: url || '', term, at: new Date().toISOString() };
    });
  } catch (_) {
    /* ignore */
  }
}

async function startWhatsApp(deps) {
  const waClient = await createClient();

  const state = {
    connected: false,
    ready: false,
    qr: null,
    lastDisconnectReason: null,
    reconnectCount: 0,
    startedAt: new Date().toISOString(),
  };

  waClient.on('qr', (qr) => {
    state.qr = qr;
    handleQr(qr);
  });

  waClient.on('authenticated', () => {
    logger.info('WhatsApp autenticado');
    intentosReconexion = 0;
  });

  waClient.on('auth_failure', (message) => {
    logger.error('Fallo de autenticación de WhatsApp', { message });
    reconectarConBackoff(waClient, state, 'auth_failure');
  });

  waClient.on('ready', () => {
    state.connected = true;
    state.ready = true;
    state.qr = null;
    global.__lastQr = null;
    intentosReconexion = 0;
    reconectando = false;
    logger.info('Cliente de WhatsApp listo y conectado');
    iniciarKeepalive(waClient, state);
  });

  waClient.on('disconnected', (reason) => {
    state.connected = false;
    state.ready = false;
    state.lastDisconnectReason = reason;
    state.reconnectCount += 1;
    detenerKeepalive();
    logger.warn('Cliente de WhatsApp desconectado', {
      reason,
      reconnectCount: state.reconnectCount,
    });

    if (reason === 'loggedOut') {
      clearSessionLoggedOut(waClient, reason);
    } else {
      reconectarConBackoff(waClient, state, reason);
    }
  });

  waClient.on('message', (msg) => {
    if (!deps.onMessage) return;
    try {
      deps.onMessage(msg, waClient, state);
    } catch (err) {
      logger.error('Error en manejador de mensaje', { error: err.message });
    }
  });

  waClient.on('error', (err) => {
    logger.error('Error del cliente de WhatsApp', { error: err.message });
  });

  async function initializeWithRetry(attempt) {
    try {
      await waClient.initialize();
    } catch (err) {
      const delay = Math.min(5000 * Math.pow(2, attempt), 60_000);
      logger.error('Error al inicializar WhatsApp, reintentando', {
        error: err.message,
        attempt: attempt + 1,
        retryMs: delay,
      });
      setTimeout(() => initializeWithRetry(attempt + 1), delay);
    }
  }

  initializeWithRetry(0);

  const sender = {
    connected: () => state.connected,
    sendText: async (phoneNumber, text) => {
      const chatId = formatChatId(phoneNumber);
      await waClient.sendMessage(chatId, String(text));
    },
  };

  return { client: waClient, state, sender };
}

function formatChatId(phoneNumber) {
  const n = String(phoneNumber).trim();
  if (n.endsWith('@c.us') || n.endsWith('@lid') || n.endsWith('@g.us')) {
    return n;
  }
  const digits = n.replace(/[^\d]/g, '');
  return `${digits}@c.us`;
}

function getState() {
  return global.__waState || { connected: false, ready: false };
}

module.exports = {
  startWhatsApp,
  createClient,
  onQr,
  formatChatId,
  getState,
};
