'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const qrcode = require('qrcode');
const config = require('../config');
const logger = require('../logger').child('whatsapp');

/**
 * Cliente de WhatsApp Web (whatsapp-web.js).
 *
 * Estrategia de disponibilidad 24/7:
 *  - LocalAuth: la sesión persiste en disco (data/wa-session) y se RESPALDA
 *    en `session-transfer-bot.bak` tras cada `ready` (y periódicamente).
 *  - Si un reinicio/reconexión detecta que el perfil quedó corrupto (p. ej.
 *    kill forzado del navegador) o falla la inicialización, se restaura el
 *    respaldo automáticamente y se reintenta SIN pedir un nuevo QR.
 *  - Versión de WhatsApp Web fijada a la actual del repo
 *    wppconnect-team/wa-version (evita recargas/redirecciones que invalidan
 *    la sesión). Sobrescribible con WA_WVERSION.
 *  - Reconexión: destruye el navegador con cierre GRADUAL (SIGTERM y solo
 *    SIGKILL como último recurso) para no corromper el perfil, limpia
 *    lockfiles, y crea un cliente NUEVO (no reusa el mismo objeto).
 *  - Keepalive basado en `browser.isConnected()`: no fuerza reconexiones por
 *    recargas de página ni evalua JS.
 *  - Backoff exponencial sin límite destructivo: NUNCA borra la sesión salvo
 *    que el usuario cierre sesión explícitamente desde el celular.
 */

let client = null;
let qrHandler = null;
let reconnecting = false;
let keepaliveInterval = null;
let respaldoInterval = null;
let intentosReconexion = 0;
let messageHandler = null;
let waState = null;
let seIntentoRestaurar = false;

const MAX_INTENTOS_RECONEXION = 6;
const MAX_INTENTOS_INICIALIZACION = 6;
const KEEPALIVE_MS = 30_000;
const BACKOFF_BASE_MS = 5_000;
const RESPALDO_INTERVALO_MS = 6 * 60 * 60 * 1000;
// Versión de WhatsApp Web compatible (repo wppconnect-team/wa-version).
// Sobrescribible con WA_WVERSION si el pin queda desactualizado.
const WA_VVERSION = process.env.WA_WVERSION || '2.3000.1048354754-alpha';

function getProfileDir() {
  return path.join(config.whatsapp.sessionDir, 'session-transfer-bot');
}

function getBackupDir() {
  return `${getProfileDir()}.bak`;
}

function limpiarLockfiles() {
  const profileDir = getProfileDir();
  for (const file of ['SingletonCookie', 'SingletonLock', 'SingletonSocket']) {
    fs.rmSync(path.join(profileDir, file), { force: true });
  }
}

/**
 * Respalda el perfil completo de la sesión (localStorage/IndexedDB del
 * usuario de WhatsApp) a un directorio `.bak` para poder restaurarlo si el
 * perfil principal se corrompe por un kill forzado o un inicio fallido.
 */
function respaldarSesion() {
  try {
    const dir = getProfileDir();
    const bak = getBackupDir();
    if (!fs.existsSync(dir)) return;
    if (fs.existsSync(bak)) {
      fs.rmSync(bak, { recursive: true, force: true });
    }
    fs.cpSync(dir, bak, { recursive: true, force: true });
    logger.info('Sesión de WhatsApp respaldada en disco');
  } catch (err) {
    logger.warn('Error al respaldar sesión de WhatsApp', { error: err.message });
  }
}

/**
 * Restaura el respaldo de la sesión sobre el perfil principal. Devuelve
 * true si lo hizo; false si no hay respaldo disponible.
 */
function restaurarSesion() {
  try {
    const dir = getProfileDir();
    const bak = getBackupDir();
    if (!fs.existsSync(bak)) return false;
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.cpSync(bak, dir, { recursive: true, force: true });
    logger.warn('Perfil de sesión de WhatsApp restaurado desde respaldo');
    return true;
  } catch (err) {
    logger.error('No se pudo restaurar respaldo de la sesión', {
      error: err.message,
    });
    return false;
  }
}

/**
 * Destruye el navegador del cliente de forma GRADUAL: primero `destroy()`
 * (cierre limpio de Puppeteer), luego espera a que el proceso termine, sigue
 * con SIGTERM y solo usa SIGKILL como último recurso tras una gracia. Esto
 * evita corromper el perfil donde vive la sesión (causa de re-escanear QR).
 */
async function destruirNavegador(wc) {
  if (!wc) return;
  let pid = null;
  try {
    const browser = wc.pupBrowser;
    if (browser) {
      try {
        const proc = browser.process && browser.process();
        pid = proc && proc.pid ? proc.pid : null;
      } catch (_) {}
    }
  } catch (_) {}
  try {
    await wc.destroy();
  } catch (_) {}
  if (!pid) return;

  let terminado = false;
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch (_) {
      terminado = true;
      break;
    }
    await dormir(250);
  }
  if (terminado) return;

  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {}
  await dormir(1000);
  let vivo = false;
  try {
    process.kill(pid, 0);
    vivo = true;
  } catch (_) {}
  if (vivo) {
    try {
      process.kill(pid, 'SIGKILL');
      logger.debug('Navegador WhatsApp terminado por fuerza', { pid });
    } catch (_) {}
  }
}

/**
 * Solo se usa al arrancar el proceso: limpia lockfiles y procesos Chrome
 * restantes de una ejecución anterior que quedaron muertos en el disco
 * (común tras un kill -9 o caída del contenedor).
 */
function limpiarEstadoArranque() {
  limpiarLockfiles();
  const profile = getProfileDir().replace(/\\/g, '/');
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { ($_.CommandLine -ne $null) -and ($_.CommandLine -like '*${profile}*') } | ForEach-Object { $_.ProcessId }"`,
        { encoding: 'utf8', windowsHide: true }
      ).toString();
      const pids = (out.match(/\d+/g) || []).filter(
        (p) => Number(p) && Number(p) !== process.pid
      );
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch (_) {}
      }
    } else {
      const out = execSync(`pgrep -f "${profile}" || true`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const pids = (out.match(/\d+/g) || []).filter(
        (p) => Number(p) && Number(p) !== process.pid
      );
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch (_) {}
      }
    }
  } catch (_) {
    // Sin procesos restantes o sin permiso: OK.
  }
}

function dormir(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function iniciarKeepalive(state) {
  if (keepaliveInterval) clearInterval(keepaliveInterval);
  keepaliveInterval = setInterval(() => {
    if (!state.connected) return;
    let ok = false;
    try {
      const browser = client.pupBrowser;
      ok = !!(
        browser &&
        (typeof browser.isConnected === 'function'
          ? browser.isConnected()
          : true)
      );
    } catch (_) {
      ok = false;
    }
    if (!ok && state.connected && !reconnecting) {
      logger.warn('Keepalive detectó navegador desconectado, forzando reconexión');
      state.connected = false;
      state.ready = false;
      reconectar('keepalive_failed');
    }
  }, KEEPALIVE_MS);
}

function detenerKeepalive() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

function iniciarRespaldoPeriodico() {
  detenerRespaldoPeriodico();
  respaldoInterval = setInterval(respaldarSesion, RESPALDO_INTERVALO_MS);
}

function detenerRespaldoPeriodico() {
  if (respaldoInterval) {
    clearInterval(respaldoInterval);
    respaldoInterval = null;
  }
}

/**
 * Reconexión robusta:
 *  1. Cerrar el navegador actual de forma gradual (evita corromper el perfil).
 *  2. Restaurar el respaldo si lo hay y aún no se usó (perfil corrupto).
 *  3. Limpiar lockfiles Singleton.
 *  4. Crear un cliente NUEVO y reinicializar.
 * Backoff exponencial; si revienta, se sigue reintentando SIN borrar la sesión.
 */
async function reconectar(reason) {
  if (reconnecting) return;
  reconnecting = true;
  intentosReconexion++;

  const delay = Math.min(
    BACKOFF_BASE_MS * Math.pow(2, intentosReconexion - 1),
    60_000
  );
  logger.warn('Reconectando WhatsApp', {
    reason,
    intento: intentosReconexion,
    esperandoMs: delay,
  });

  try {
    await dormir(delay);
    await destruirNavegador(client);
    if (!seIntentoRestaurar && fs.existsSync(getBackupDir())) {
      seIntentoRestaurar = true;
      restaurarSesion();
    }
    limpiarLockfiles();

    client = buildClient();
    await client.initialize();
    intentosReconexion = 0;
    logger.info('WhatsApp reconectado correctamente');
  } catch (err) {
    logger.error('Fallo en reconexión de WhatsApp', {
      error: err.message,
      intento: intentosReconexion,
    });
    if (intentosReconexion >= MAX_INTENTOS_RECONEXION) {
      intentosReconexion = 0;
      logger.warn('Reintentando ciclo de reconexión sin borrar la sesión');
    }
    const próximoDelay = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, intentosReconexion),
      60_000
    );
    reconnecting = false;
    setTimeout(() => reconectar(reason), próximoDelay);
    return;
  }
  reconnecting = false;
}

async function clearSessionLoggedOut(wc, reason) {
  logger.warn('Sesión cerrada desde el celular; se generará un nuevo QR', {
    reason,
  });
  detenerKeepalive();
  detenerRespaldoPeriodico();
  await destruirNavegador(wc);
  try {
    const dir = getProfileDir();
    const bak = getBackupDir();
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      logger.warn('Sesión de WhatsApp eliminada de disco');
    }
    if (fs.existsSync(bak)) {
      fs.rmSync(bak, { recursive: true, force: true });
      logger.warn('Respaldo de sesión eliminado de disco');
    }
  } catch (err) {
    logger.error('Error al limpiar sesión', { error: err.message });
  }
  process.exit(1);
}

function onQr(handler) {
  qrHandler = handler;
}

function resolveClientModule() {
  return require('whatsapp-web.js');
}

function handleQr(qr) {
  logger.warn('QR recibido, escanee con WhatsApp Web para vincular', {});
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

/**
 * Crea un cliente de WhatsApp y registra TODOS los handlers de eventos.
 * Cada reconexión crea una instancia nueva (evita estado corrupto).
 */
function buildClient() {
  const { Client, LocalAuth } = resolveClientModule();

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
      '--disable-session-crashed-bubble',
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
      remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${WA_VVERSION}.html`,
    },
  });

  waClient.on('qr', (qr) => {
    waState.qr = qr;
    if (!seIntentoRestaurar && fs.existsSync(getBackupDir())) {
      seIntentoRestaurar = true;
      logger.warn('QR solicitado pero hay respaldo: restaurando sesión para no pedir re-escan');
      restaurarSesion();
      try {
        const browser = waClient.pupBrowser;
        if (browser && typeof browser.close === 'function') {
          browser.close().catch(() => {});
        }
      } catch (_) {}
      return;
    }
    handleQr(qr);
  });

  waClient.on('authenticated', () => {
    logger.info('WhatsApp autenticado');
    intentosReconexion = 0;
  });

  waClient.on('auth_failure', (message) => {
    logger.error('Fallo de autenticación de WhatsApp', { message });
    reconectar('auth_failure');
  });

  waClient.on('ready', () => {
    waState.connected = true;
    waState.ready = true;
    waState.qr = null;
    global.__lastQr = null;
    intentosReconexion = 0;
    logger.info('Cliente de WhatsApp listo y conectado');
    // Backup inmediato de la sesión sana + backup periódico.
    respaldarSesion();
    iniciarRespaldoPeriodico();
    iniciarKeepalive(waState);
  });

  waClient.on('disconnected', (reason) => {
    waState.connected = false;
    waState.ready = false;
    waState.lastDisconnectReason = reason;
    waState.reconnectCount += 1;
    detenerKeepalive();
    detenerRespaldoPeriodico();
    logger.warn('Cliente de WhatsApp desconectado', {
      reason,
      reconnectCount: waState.reconnectCount,
    });

    if (reason === 'loggedOut' || reason === 'LOGOUT') {
      clearSessionLoggedOut(waClient, reason);
    } else {
      reconectar(reason);
    }
  });

  waClient.on('message', (msg) => {
    if (!messageHandler) return;
    try {
      messageHandler(msg, waClient, waState);
    } catch (err) {
      logger.error('Error en manejador de mensaje', { error: err.message });
    }
  });

  waClient.on('error', (err) => {
    logger.error('Error del cliente de WhatsApp', { error: err.message });
  });

  return waClient;
}

/**
 * Inicia la conexión de WhatsApp. Crea el cliente, registra eventos y lanza
 * la inicialización con reintentos. Si falla la inicialización, se restaura
 * el respaldo de la sesión (si existe) y se reintenta antes de pedir un QR.
 *
 * @param {object} deps
 * @param {function} deps.onMessage callback(message, client, state)
 * @returns {Promise<{client:object, state:object, sender:object}>}
 */
async function createClient() {
  if (client) return client;

  fs.mkdirSync(config.whatsapp.sessionDir, { recursive: true });
  limpiarEstadoArranque();
  client = buildClient();
  return client;
}

async function startWhatsApp(deps) {
  messageHandler = deps.onMessage || null;

  if (!waState) {
    waState = {
      connected: false,
      ready: false,
      qr: null,
      lastDisconnectReason: null,
      reconnectCount: 0,
      startedAt: new Date().toISOString(),
    };
  }

  await createClient();

  async function initializeWithRetry(attempt) {
    try {
      await client.initialize();
    } catch (err) {
      const delay = Math.min(5000 * Math.pow(2, attempt), 30_000);
      logger.error('Error al inicializar WhatsApp, reintentando', {
        error: err.message,
        attempt: attempt + 1,
        retryMs: delay,
      });
      // Perfil corrupto (kill forzado/inicio fallido): restaurar el respaldo
      // una única vez antes de reintentar para no pedir un nuevo QR.
      if (!seIntentoRestaurar && fs.existsSync(getBackupDir())) {
        seIntentoRestaurar = true;
        restaurarSesion();
      }
      if (attempt >= MAX_INTENTOS_INICIALIZACION - 1) {
        logger.fatal('No se pudo inicializar WhatsApp tras varios intentos. Reiniciando proceso limpio', {
          intentos: MAX_INTENTOS_INICIALIZACION,
        });
        // El reinicio limpio (Docker restart:always) reutiliza la sesión
        // persistida en disco: NO requiere re-escanear QR.
        await destruirNavegador(client).catch(() => {});
        limpiarLockfiles();
        process.exit(1);
        return;
      }
      // Destruir el navegador que pudo quedar a medias (cierre gradual) y
      // recrear el cliente: evita acumular procesos Chrome que bloquean el
      // userDataDir.
      await destruirNavegador(client).catch(() => {});
      limpiarLockfiles();
      setTimeout(() => {
        client = buildClient();
        initializeWithRetry(attempt + 1);
      }, delay);
    }
  }

  initializeWithRetry(0);

  const sender = {
    connected: () => waState.connected,
    sendText: async (phoneNumber, text) => {
      const chatId = formatChatId(phoneNumber);
      await client.sendMessage(chatId, String(text));
    },
  };

  return { client, state: waState, sender };
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