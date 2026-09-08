'use strict';

const validation = require('./validation');
const repo = require('../database/repository');
const config = require('../config');
const logger = require('../logger').child('transferService');

/**
 * Servicio de transferencia (traslado).
 *
 * Responsabilidades:
 *  1. Recibir un mensaje de WhatsApp (messageId único).
 *  2. Parsear y validar el comando.
 *  3. Registrar la solicitud en la BD (idempotencia por message_id).
 *  4. Encolar el trabajo para que el worker lo procese.
 *  5. Devolver la respuesta inmediata al usuario ("Procesando...").
 *
 * La ejecución real del traslado (navegación + Playwright/Puppeteer)
 * ocurre en el worker, de forma asíncrona y serializada por documento.
 */

/**
 * Estados de una solicitud.
 */
const STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  DUPLICATE: 'DUPLICATE',
};

/**
 * Valida el mensaje y, si es válido, registra y encola el traslado.
 * Devuelve la respuesta inmediata que debe enviarse al usuario.
 *
 * @param {object} ctx
 * @param {string} ctx.messageId  Identificador único del mensaje de WhatsApp.
 * @param {string} ctx.phoneNumber Número de teléfono del remitente (formato digital).
 * @param {string} ctx.rawMessage  Texto original del mensaje.
 * @returns {Promise<{type:string, text:string, status?:string}>}
 */
async function handleMessage(ctx) {
  const { messageId, phoneNumber, chatId, rawMessage } = ctx;

  logger.info('Solicitud recibida', { messageId, phoneNumber });

  // 1) Idempotencia: si este messageId ya se procesó, no hacer nada.
  const existing = repo.findTransferRequestByMessageId(messageId);
  if (existing) {
    logger.info('Mensaje duplicado ignorado', {
      messageId,
      requestId: existing.id,
      status: existing.status,
    });
    if (existing.status === STATUS.SUCCESS) {
      return {
        type: 'duplicate-success',
        text: 'Este mensaje ya fue procesado (traslado duplicado).',
        status: existing.status,
      };
    }
    return { type: 'duplicate', text: 'Este mensaje ya fue recibido y está siendo procesado.', status: existing.status };
  }

  // 2) Parseo y validación del comando
  const parsed = validation.parseCommand(rawMessage);
  if (!parsed.ok) {
    logger.warn('Formato inválido', { messageId, error: parsed.error });
    // Registrar igualmente la solicitud fallida (auditoría + formato)
    repo.createTransferRequest({
      message_id: messageId,
      phone_number: phoneNumber,
      document: '',
      destination_branch: '',
      status: STATUS.FAILED,
      error_message: parsed.error,
      raw_message: rawMessage,
    });
    return { type: 'format-error', text: buildFormatErrorReply(parsed.error) };
  }

  // 3) Verificar número autorizado (si está configurado)
  const allowed = config.whatsapp.allowedPhoneNumbers;
  if (allowed.length > 0 && !allowed.includes(phoneNumber)) {
    logger.warn('Número no autorizado', { messageId, phoneNumber });
    repo.createTransferRequest({
      message_id: messageId,
      phone_number: phoneNumber,
      document: parsed.document,
      destination_branch: parsed.branch,
      status: STATUS.FAILED,
      error_message: 'Número no autorizado',
      raw_message: rawMessage,
    });
    return { type: 'unauthorized', text: 'Número no autorizado para realizar traslados.' };
  }

  // 4) Registrar solicitud PENDING
  const requestId = repo.createTransferRequest({
    message_id: messageId,
    phone_number: phoneNumber,
    document: parsed.document,
    destination_branch: parsed.branch,
    status: STATUS.PENDING,
    raw_message: rawMessage,
  });
  logger.info('Solicitud registrada', { requestId, document: parsed.document, branch: parsed.branch });

  // 5) Encolar el trabajo
  const job = repo.enqueueJob({
    request_id: requestId,
    document: parsed.document,
    payload: JSON.stringify({
      messageId,
      phoneNumber,
      chatId: chatId || phoneNumber,
      document: parsed.document,
      branch: parsed.branch,
    }),
    priority: 0,
  });
  logger.info('Trabajo encolado', { requestId, jobId: job.id, duplicated: job.duplicated });

  return {
    type: 'processing',
    text: buildProcessingReply(parsed.document, parsed.branch),
    requestId,
  };
}

/**
 * Intentos de reencolar tras fallo de red del worker (no usado directamente,
 * pero expuesto para el worker cuando requiera reintento).
 */
async function requeue(jobId, error) {
  logger.warn('Reintentando job', { jobId, error });
  repo.markJobFailed(jobId, error);
}

function buildProcessingReply(document, branch) {
  return [
    'Procesando traslado...',
    '',
    `Documento: ${document}`,
    `Sucursal destino: ${branch}`,
  ].join('\n');
}

function buildFormatErrorReply(reason) {
  return [
    '⚠️ Formato incorrecto.',
    '',
    'Utilice:',
    'TRASLADO DOCUMENTO SUCURSAL',
    '',
    `(Detalle: ${reason})`,
  ].join('\n');
}

function buildSuccessReply(transfer) {
  const now = new Date();
  const dateStr =
    now.toLocaleDateString('es-AR') + ' ' +
    now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return [
    '✅ Traslado realizado correctamente.',
    '',
    `Colocador: ${transfer.document}`,
    `Sucursal nueva: ${transfer.destination_branch || '?'}`,
    `Hora: ${dateStr}`,
  ].join('\n');
}

function buildFailureReply(transfer, reason) {
  return [
    '❌ No fue posible realizar el traslado.',
    '',
    `Documento: ${transfer.document}`,
    '',
    'Motivo:',
    reason || 'Error desconocido',
  ].join('\n');
}

function buildNoActiveShiftReply(document) {
  return `❌ El colocador ${document} no tiene un turno activo actualmente.`;
}

function buildNoDocumentReply(document) {
  return `❌ No se encontró ningún colocador con el documento ${document}.`;
}

function buildMultipleActiveReply(document) {
  return [
    '⚠️ No fue posible realizar el traslado.',
    '',
    `Colocador: ${document}`,
    'El colocador tiene múltiples turnos activos y requiere revisión manual.',
  ].join('\n');
}

function buildBranchNotFoundReply(branch) {
  return `❌ No se encontró la sucursal "${branch}".`;
}

function buildNotInBranchReply(document, currentBranch) {
  return [
    `❌ El colocador ${document} no se encuentra activo en la sucursal ${currentBranch}.`,
    '',
    'El turno en esa sucursal ya tiene fecha final o no existe.',
  ].join('\n');
}

module.exports = {
  STATUS,
  handleMessage,
  requeue,
  // builders
  buildSuccessReply,
  buildFailureReply,
  buildNoActiveShiftReply,
  buildNoDocumentReply,
  buildMultipleActiveReply,
  buildBranchNotFoundReply,
  buildNotInBranchReply,
  buildProcessingReply,
  buildFormatErrorReply,
};
