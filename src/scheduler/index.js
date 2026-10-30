'use strict';

const config = require('../config');
const repo = require('../database/repository');
const logger = require('../logger').child('scheduler');

/**
 * Planificador de traslados programados.
 *
 * En cada tick:
 *  1) Despacha a la cola existente las programaciones vencidas (SCHEDULED ->
 *     QUEUED) de forma atómica e idempotente.
 *  2) Sincroniza el estado de las programaciones ya despachadas con el
 *     estado real del transfer_request/job (QUEUED/PROCESSING/SUCCESS/FAILED).
 *
 * No ejecuta Puppeteer: reutiliza el worker/cola ya existentes.
 */

let timer = null;
let running = false;

function tick() {
  if (running) return { dispatched: [], synced: [], skipped: 'busy' };
  running = true;
  try {
    const nowUtc = new Date().toISOString();
    const due = repo.listDueSchedules(nowUtc, config.scheduler.batchSize);
    const dispatched = [];

    for (const schedule of due) {
      try {
        const res = repo.dispatchSchedule(schedule.id, {
          nowUtc,
          lateThresholdMs: config.scheduler.lateThresholdMs,
        });
        if (res.dispatched) {
          dispatched.push({ id: schedule.id, ...res });
          logger.info('Programación despachada a la cola', {
            scheduleId: schedule.id,
            requestId: res.requestId,
            jobId: res.jobId,
            late: res.late,
            scheduledAtUtc: schedule.scheduled_at_utc,
          });
        }
      } catch (err) {
        logger.error('Error al despachar programación', {
          scheduleId: schedule.id,
          error: err.message,
        });
      }
    }

    let synced = [];
    try {
      synced = repo.syncScheduleStatuses();
    } catch (err) {
      logger.error('Error al sincronizar estados de programaciones', {
        error: err.message,
      });
    }

    return { dispatched, synced };
  } finally {
    running = false;
  }
}

function start() {
  if (!config.scheduler.enabled) {
    logger.info('Planificador deshabilitado por configuración');
    return;
  }
  if (timer) return;
  logger.info('Planificador iniciado', {
    pollIntervalMs: config.scheduler.pollIntervalMs,
    batchSize: config.scheduler.batchSize,
    lateThresholdMs: config.scheduler.lateThresholdMs,
  });
  tick();
  timer = setInterval(tick, config.scheduler.pollIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Planificador detenido');
  }
}

module.exports = { start, stop, tick };
