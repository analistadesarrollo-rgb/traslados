'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const logger = require('../logger').child('automation');

/**
 * Gestión del navegador automatizado (Puppeteer + Chrome del sistema).
 *
 * Proporciona:
 *  - Un único navegador persistente reutilizado entre operaciones.
 *  - Apertura/cierre controlado.
 *  - Guardado de evidencias (screenshot) ante errores.
 *
 * El diseño es "resistente": el worker reutiliza una página de un mismo
 * contexto de navegador inmutable (perfil limpio) para que las sesiones del
 * sistema web no se compartan entre operaciones, mientras el navegador en sí
 * persiste para ahorrar costes de arranque.
 */

let browser = null;

async function getChromePath() {
  if (fs.existsSync(config.automation.chromePath)) {
    return config.automation.chromePath;
  }
  // Intentar detectar Chrome/Edge en rutas comunes
  const candidates = [
    '/Program Files/Google/Chrome/Application/chrome.exe',
    '/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : '',
    '/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return config.automation.chromePath;
}

/**
 * Obtiene (o lanza) el navegador Puppeteer persistente.
 * @returns {Promise<import('puppeteer').Browser>}
 */
async function getBrowser() {
  // Resolución diferida para que la dependencia de puppeteer solo se
  // cargue cuando realmente se automatiza (evita costes si se usa --web).
  const puppeteer = require('puppeteer');
  if (browser && browser.isConnected()) return browser;

  const executablePath = await getChromePath();
  logger.info('Lanzando navegador', { executablePath, headless: config.automation.headless });

  browser = await puppeteer.launch({
    headless: config.automation.headless,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  browser.on('disconnected', () => {
    logger.warn('Navegador desconectado');
    browser = null;
  });

  return browser;
}

/**
 * Crea una nueva página en el navegador persistente.
 */
async function newPage() {
  const b = await getBrowser();
  const page = await b.newPage();
  page.setDefaultTimeout(config.automation.timeoutMs);
  return page;
}

/**
 * Cierra el navegador persistente (libera recursos).
 */
async function closeBrowser() {
  if (browser && browser.isConnected()) {
    await browser.close();
  }
  browser = null;
}

/**
 * Guarda un screenshot con metadatos para investigación de errores.
 * @param {import('puppeteer').Page} page
 * @param {string} label
 * @returns {Promise<string|null>} ruta del screenshot
 */
async function captureEvidence(page, label) {
  try {
    fs.mkdirSync(path.resolve(config.root, 'screenshots'), { recursive: true });
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.resolve(config.root, 'screenshots', `${safeLabel}-${stamp}.png`);
    let url = '';
    try {
      url = page ? page.url() : '';
    } catch (_) {
      url = '';
    }
    await page.screenshot({ path: file, fullPage: true });
    logger.info('Evidencia guardada', { file, url, label });
    return file;
  } catch (err) {
    logger.error('No se pudo guardar evidencia', { error: err.message });
    return null;
  }
}

/** @returns {boolean} si el navegador persistente está lanzado */
function isLaunched() {
  return browser !== null && browser.isConnected();
}

/**
 * Espera (con timeout) a que la página alcance readyState 'complete'
 * y quede "tranquila" (sin navegaciones en curso). Equivalente Puppeteer
 * de waitForLoadState('networkidle') de Playwright.
 * @param {import('puppeteer').Page} page
 * @param {number} timeoutMs
 */
async function settle(page, timeoutMs = 8000) {
  try {
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: timeoutMs });
  } catch (_) {
    /* timeout tolerable */
  }
}

/**
 * Espera una cantidad de milisegundos (solo para pausas breves de UI).
 * Se usa únicamente como complemento de esperas inteligentes, no como
 * mecanismo principal.
 */
function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { getBrowser, newPage, closeBrowser, captureEvidence, getChromePath, isLaunched, settle, waitMs };
