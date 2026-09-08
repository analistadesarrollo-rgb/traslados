'use strict';

const config = require('../config');
const repo = require('../database/repository');
const logger = require('../logger').child('worker');
const automation = require('../automation');
const transferService = require('../services/transferService');
const errors = require('../automation/errors');

/**
 * Worker de procesamiento de traslados.
 *
 * Extrae trabajos de la cola (job_queue), los procesa de forma SERIALIZADA
 * por documento (el lock atómico por documento de repository.claimNextJob
 * garantiza que dos traslados del mismo colocador nunca corran a la vez),
 * actualiza la solicitud y envía la respuesta de WhatsApp.
 */

/**
 * Arranca el bucle del worker. Debe recibir un sender de WhatsApp para
 * poder notificar al usuario. Acepta un mock en los tests.
 *
 * @param {object} deps
 * @param {object} deps.sender  {connected:boolean, sendText(phone, text):Promise}
 * @param {object} [deps.transferExecutor] función ejecutora (para pruebas)
 */
function startWorker(deps) {
  const sender = deps.sender;
  const executor =
    deps.transferExecutor ||
    ((jobPayload) =>
      automation.executeTransfer({
        document: jobPayload.document,
        branch: jobPayload.branch,
        requestId: jobPayload.requestId,
      }));

  const owner = `worker-${process.pid}-${Date.now()}`;
  let running = false;
  let stopRequested = false;

  logger.info('Worker iniciado', {
    owner,
    concurrency: config.queue.concurrency,
    pollIntervalMs: config.queue.pollIntervalMs,
  });

  async function processOne() {
    const job = repo.claimNextJob(owner, config.queue.jobLeaseMs);
    if (!job) return false;

    const payload = safeParse(job.payload);
    const requestId = job.request_id;
    logger.info('Iniciando procesamiento de job', {
      jobId: job.id,
      requestId,
      document: job.document,
    });

    // Marcar solicitud como PROCESSING
    repo.updateTransferRequest(requestId, { status: 'PROCESSING', started_at: new Date().toISOString() });

    let result;
    try {
      result = await executor(payload);
    } catch (err) {
      result = {
        ok: false,
        errorCode: 'UNEXPECTED',
        error: err.message || String(err),
      };
    }

    // Actualizar solicitud según resultado
    if (result.ok) {
      repo.updateTransferRequest(requestId, {
        status: 'SUCCESS',
        source_branch: result.sourceBranch,
        completed_at: new Date().toISOString(),
        error_message: null,
      });
      repo.markJobDone(job.id, { result });
      const tr = repo.getTransferRequestById(requestId);
      const reply = transferService.buildSuccessReply({
        document: tr.document,
        source_branch: result.sourceBranch,
        destination_branch: tr.destination_branch,
      });
      const replyTo = payload.chatId || payload.phoneNumber;
      await safeSend(sender, replyTo, reply);
      logger.info('Traslado realizado', { requestId, jobId: job.id });
    } else {
      repo.updateTransferRequest(requestId, {
        status: 'FAILED',
        error_message: result.error,
        completed_at: new Date().toISOString(),
      });
      repo.markJobFailed(job.id, result.error);
      const tr = repo.getTransferRequestById(requestId);
      const reply = buildErrorReply(result, tr);
      const replyTo = payload.chatId || payload.phoneNumber;
      await safeSend(sender, replyTo, reply);
      logger.info('Traslado fallido', { requestId, jobId: job.id, code: result.errorCode });
    }

    return true;
  }

  async function tick() {
    if (stopRequested) return;
    try {
      const processed = await processOne();
      if (processed) {
        // hay más trabajo, procesar de inmediato
        setTimeout(tick, 20);
      } else {
        setTimeout(tick, config.queue.pollIntervalMs);
      }
    } catch (err) {
      logger.error('Error en el tick del worker', { error: err.message });
      setTimeout(tick, config.queue.pollIntervalMs);
    }
  }

  function start() {
    if (running) return;
    running = true;
    tick();
  }

  function stop() {
    stopRequested = true;
    running = false;
    logger.info('Worker detenido (petición)');
  }

  return { start, stop, owner };
}

function safeParse(json) {
  try {
    return JSON.parse(json || '{}');
  } catch (_) {
    return {};
  }
}

function buildErrorReply(result, tr) {
  switch (result.errorCode) {
    case 'DOCUMENT_NOT_FOUND':
      return transferService.buildNoDocumentReply(tr.document);
    case 'NO_ACTIVE_SHIFT':
      return transferService.buildNoActiveShiftReply(tr.document);
    case 'MULTIPLE_ACTIVE_SHIFTS':
      return transferService.buildMultipleActiveReply(tr.document);
    case 'BRANCH_NOT_FOUND':
      return transferService.buildBranchNotFoundReply(tr.destination_branch);
    case 'NOT_IN_BRANCH':
      return transferService.buildNotInBranchReply(tr.document, result.extra?.branch || 'desconocida');
    case 'AUTOMATION_NOT_CONFIGURED':
      return '❌ El sistema de automatización aún no está configurado. Contacte al administrador.\n\n' + result.error;
    default:
      return transferService.buildFailureReply(tr, result.error);
  }
}

async function safeSend(sender, phone, text) {
  try {
    if (!sender || typeof sender.sendText !== 'function') {
      logger.warn('No hay sender de WhatsApp disponible, no se envió respuesta', { phone });
      return;
    }
    if (typeof sender.connected === 'function' && !sender.connected()) {
      logger.warn('WhatsApp no conectado, respuesta pendiente no enviada', { phone });
      return;
    }
    await sender.sendText(phone, text);
  } catch (err) {
    logger.error('Error al enviar respuesta de WhatsApp', { error: err.message, phone });
  }
}

module.exports = { startWorker, buildErrorReply };
