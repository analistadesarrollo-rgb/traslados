'use strict';

const fs = require('node:fs');
const path = require('node:path');
const qrcode = require('qrcode');
const config = require('../config');
const logger = require('../logger').child('whatsapp');

/**
 * Cliente de WhatsApp Web (whatsapp-web.js).
 *
 * Características clave:
 *  - LocalAuth: la sesión se persiste en disco (data/wa-session). El QR solo
 *    debe escanearse la primera vez; en reinicios/desconexiones la sesión se
 *    reutiliza y NO es necesario volver a escanear.
 *  - Reconexión automática: se registran los eventos de desconexión y el
 *    cliente intenta reconectarse.
 *  - Carga diferida: la dependencia del cliente se resuelve dentro de la
 *    función para poder usar el bot solo con --whatsapp o integrado.
 */

let client = null;
let qrHandler = null;
let reconnecting = false;

function getProfileDir() {
  return path.join(config.whatsapp.sessionDir, 'session-transfer-bot');
}

/**
 * Destruye y recrea el cliente sin borrar la sesión en disco.
 * La sesión se mantiene en data/wa-session y se reutiliza al reinicializar.
 */
async function reconnectClient(waClient, reason) {
  if (reconnecting) return;
  reconnecting = true;
  logger.warn('Intentando reconexión de WhatsApp', { reason });
  try {
    await waClient.destroy().catch(() => {});
    // Esperar un momento antes de reinicializar
    await new Promise((r) => setTimeout(r, 5000));
    await waClient.initialize();
    logger.info('WhatsApp reconectado correctamente');
  } catch (err) {
    logger.error('Error en reconexión de WhatsApp', { error: err.message });
  } finally {
    reconnecting = false;
  }
}

/**
 * Limpia la sesión SOLO cuando el usuario cierra sesión desde el celular.
 * Destruye el cliente, borra la sesión y fuerza reinicio para nuevo QR.
 */
async function clearSessionLoggedOut(waClient, reason) {
  logger.warn('Sesión cerrada desde el celular; se generará un nuevo QR', { reason });
  await waClient.destroy().catch(() => {});
  fs.rmSync(getProfileDir(), { recursive: true, force: true });
  process.exit(1);
}

/**
 * Configura un callback para recibir el QR como imagen/terminal.
 * @param {(qrDataUrl:string, terminal:string)=>void} handler
 */
function onQr(handler) {
  qrHandler = handler;
}

function resolveClientModule() {
  return require('whatsapp-web.js');
}

/**
 * Crea el cliente de WhatsApp con sesión persistente (LocalAuth).
 * @returns {Promise<{client:object, connected:boolean}>}
 */
async function createClient() {
  const { Client, LocalAuth } = resolveClientModule();

  if (client) return client;

  fs.mkdirSync(config.whatsapp.sessionDir, { recursive: true });

  const profileDir = getProfileDir();
  for (const file of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    fs.rmSync(path.join(profileDir, file), { force: true });
  }

  const auth = new LocalAuth({
    clientId: 'transfer-bot',
    dataPath: config.whatsapp.sessionDir,
  });

  const puppeteerOpts = {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  };
  const browserPath = config.whatsapp.browserPath || config.automation.chromePath;
  if (browserPath && fs.existsSync(browserPath)) {
    puppeteerOpts.executablePath = browserPath;
    puppeteerOpts.headless = true;
  } else {
    puppeteerOpts.headless = true;
  }

  const waClient = new Client({
    authStrategy: auth,
    puppeteer: puppeteerOpts,
    takeoverOnConflict: true, // múltiples conexiones: la nueva toma el control
    // Fija una versión de WhatsApp Web conocida y estable; sin esto, WhatsApp
    // puede servir una versión nueva incompatible con whatsapp-web.js y
    // romper el envío de mensajes ("... is not a function").
    webVersionCache: {
      type: 'remote',
      remotePath:
        'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1047094411-alpha.html',
    },
  });

  client = waClient;
  return client;
}

/**
 * Detector de QR: recibe el string del código QR y lo emite al handler.
 */
function handleQr(qr) {
  logger.warn('QR recibido, escanee con WhatsApp Web para vincular');
  let term = '';
  try {
    term = qrcode.toString(qr, { type: 'terminal', small: true });
  } catch (_) {
    term = qr;
  }
  let dataUrl = '';
  try {
    qrcode.toDataURL(qr, { width: 300, margin: 2 }, (err, url) => {
      try {
        if (qrHandler) qrHandler(url || '', term);
      } catch (_) {
        /* ignore */
      }
      // persistencia del último QR para el panel admin
      global.__lastQr = { dataUrl: url || '', term, at: new Date().toISOString() };
    });
  } catch (_) {
    /* ignore */
  }
}

/**
 * Inicia la conexión de WhatsApp con todos los manejadores de eventos
 * para persistencia y reconexión automática. Devuelve un objeto de estado
 * que se expone al panel admin y al worker.
 *
 * @param {object} deps
 * @param {function} deps.onMessage callback(message, client) para mensajes.
 * @returns {Promise<object>} estado observable {connected, ready}
 */
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
  });

  waClient.on('auth_failure', (message) => {
    // No borrar sesión en auth_failure; intentar reconectar
    // Si la sesión está corrupta, la reconexión fallirá y se verá en logs
    logger.error('Fallo de autenticación de WhatsApp, intentando reconexión', { message });
    reconnectClient(waClient, 'auth_failure');
  });

  waClient.on('ready', () => {
    state.connected = true;
    state.ready = true;
    global.__lastQr = null;
    logger.info('Cliente de WhatsApp listo y conectado');
  });

  waClient.on('disconnected', (reason) => {
    state.connected = false;
    state.ready = false;
    state.lastDisconnectReason = reason;
    state.reconnectCount += 1;
    logger.warn('Cliente de WhatsApp desconectado', { reason, reconnectCount: state.reconnectCount });

    // Solo borrar sesión si el usuario cerró sesión desde el celular
    // (loggedOut = logout explícito desde WhatsApp → Dispositivos vinculados)
    // Para todo lo demás (error de red, timeout, etc.), reconectar sin borrar sesión
    if (reason === 'loggedOut') {
      clearSessionLoggedOut(waClient, reason);
    } else {
      reconnectClient(waClient, reason);
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

  function initializeWithRetry(delayMs) {
    waClient.initialize().catch(async (err) => {
      logger.error('Error al inicializar cliente de WhatsApp', { error: err.message });
      // No destruir el cliente ni borrar la sesión; solo reintentar después de un delay
      const nextDelay = Math.min(delayMs * 2, 60000);
      setTimeout(() => initializeWithRetry(nextDelay), delayMs);
    });
  }

  initializeWithRetry(5000);

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
  // Para el panel admin: expone el estado global si está corriendo
  return global.__waState || { connected: false, ready: false };
}

module.exports = {
  startWhatsApp,
  createClient,
  onQr,
  formatChatId,
  getState,
};
