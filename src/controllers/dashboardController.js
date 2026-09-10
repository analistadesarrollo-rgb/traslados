'use strict';

const config = require('../config');
const repo = require('../database/repository');
const logger = require('../logger').child('dashboard');
const whatsapp = require('../whatsapp/client');
const browser = require('../automation/browser');

/**
 * Controlador del panel administrativo (dashboard + historial).
 */

function getStatusSnapshot() {
  const counts = repo.getStatusCounts();
  const today = new Date().toISOString().slice(0, 10);

  const waState = whatsapp.getState();
  const errors = repo.listRecentErrors(10);

  return {
    counts: {
      pending: counts.PENDING,
      processing: counts.PROCESSING,
      success: counts.SUCCESS,
      failed: counts.FAILED,
    },
    today: repo.countTransferRequests({ date: today }),
    recentErrors: errors,
    whatsapp: {
      connected: !!waState.connected,
      ready: !!waState.ready,
      lastDisconnectReason: waState.lastDisconnectReason || null,
      reconnectCount: waState.reconnectCount || 0,
      startedAt: waState.startedAt || null,
    },
    worker: {
      running: !!global.__workerRunning,
      concurrency: config.queue.concurrency,
    },
    browser: {
      available: browserState(),
    },
    updatedAt: new Date().toISOString(),
  };
}

function browserState() {
  try {
    const b = require('../automation/browser');
    // no exponemos detalles internos; solo si el navegador está lanzado
    return { launched: b.isLaunched ? b.isLaunched() : false };
  } catch (_) {
    return { launched: false };
  }
}

/**
 * GET /api/dashboard -> snapshot JSON
 */
function dashboard(req, res) {
  res.json(getStatusSnapshot());
}

/**
 * GET /api/history -> lista paginada de traslados
 */
function history(req, res) {
  const { page = 1, limit = 50, status, document } = req.query;
  const offset = (Math.max(1, Number(page) || 1) - 1) * Number(limit) || 0;
  const items = repo.listTransferRequests({
    limit: Number(limit) || 50,
    offset,
    status,
    document,
  });
  // Enriquecer con etiqueta del número autorizado
  const itemsWithLabel = items.map((item) => {
    const label = repo.getNumberLabel(item.phone_number);
    return { ...item, caller_label: label || item.phone_number || '-' };
  });
  res.json({ items: itemsWithLabel, total: repo.countTransferRequests({ status, document }) });
}

/**
 * GET /api/history/:id -> detalle de una operación (incluye logs)
 */
function historyDetail(req, res) {
  const id = Number(req.params.id);
  const transfer = repo.getTransferRequestById(id);
  if (!transfer) {
    return res.status(404).json({ error: 'No encontrado' });
  }
  const logs = repo.listActivityLogs({ requestId: id, limit: 200 });
  res.json({ transfer, logs });
}

/**
 * GET /api/qr -> último QR generado (dataURL + terminal)
 */
function qr(req, res) {
  const lastQr = global.__lastQr || null;
  res.json({ qr: lastQr });
}

/**
 * GET /api/allowed-numbers -> lista de números autorizados
 */
function listAllowedNumbers(req, res) {
  res.json({ items: repo.listAllowedNumbers() });
}

/**
 * POST /api/allowed-numbers -> agrega un número autorizado
 */
function addAllowedNumber(req, res) {
  const digits = String(req.body.phone_number || '').replace(/[^0-9]/g, '');
  if (!digits || digits.length < 8) {
    return res.status(400).json({ error: 'Número inválido' });
  }
  const normalizedKey = repo.normalizePhoneKey(digits);
  repo.addAllowedNumber(digits, req.body.label || '');
  res.status(201).json({ items: repo.listAllowedNumbers(), normalizedKey });
}

/**
 * DELETE /api/allowed-numbers/:phone -> elimina un número autorizado
 */
function removeAllowedNumber(req, res) {
  repo.removeAllowedNumber(req.params.phone);
  res.json({ items: repo.listAllowedNumbers() });
}

module.exports = {
  dashboard,
  history,
  historyDetail,
  qr,
  getStatusSnapshot,
  listAllowedNumbers,
  addAllowedNumber,
  removeAllowedNumber,
};
