'use strict';

const repo = require('../database/repository');
const service = require('../services/scheduleService');
const logger = require('../logger').child('schedules');

/**
 * Programación de traslados (panel).
 * El rol admin ve y gestiona todas; el rol scheduler solo las propias.
 */

function statusForCode(code) {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'DUPLICATE':
    case 'NOT_EDITABLE':
    case 'NOT_CANCELLABLE':
      return 409;
    default:
      return 400;
  }
}

function handleError(res, err) {
  if (err instanceof service.ScheduleError) {
    return res.status(statusForCode(err.code)).json({ error: err.message, code: err.code });
  }
  logger.error('Error inesperado en programaciones', { error: err.message });
  return res.status(500).json({ error: 'Error interno del servidor.' });
}

function listSchedules(req, res) {
  try {
    const result = service.listSchedules(req.query, req.auth);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
}

function getSchedule(req, res) {
  try {
    const id = Number(req.params.id);
    const schedule = service.getScheduleForActor(id, req.auth);
    const audit = repo.listScheduleAudit(id);
    res.json({ item: schedule, audit });
  } catch (err) {
    handleError(res, err);
  }
}

function createSchedule(req, res) {
  try {
    const schedule = service.createSchedule(req.body || {}, req.auth);
    logger.info('Programación creada', {
      scheduleId: schedule.id,
      document: schedule.document,
      scheduledAtUtc: schedule.scheduled_at_utc,
      actor: req.auth ? req.auth.username : null,
    });
    res.status(201).json({ item: schedule });
  } catch (err) {
    handleError(res, err);
  }
}

function updateSchedule(req, res) {
  try {
    const id = Number(req.params.id);
    const schedule = service.updateSchedule(id, req.body || {}, req.auth);
    logger.info('Programación actualizada', {
      scheduleId: id,
      actor: req.auth ? req.auth.username : null,
    });
    res.json({ item: schedule });
  } catch (err) {
    handleError(res, err);
  }
}

function cancelSchedule(req, res) {
  try {
    const id = Number(req.params.id);
    const schedule = service.cancelSchedule(id, req.auth);
    logger.info('Programación cancelada', {
      scheduleId: id,
      actor: req.auth ? req.auth.username : null,
    });
    res.json({ item: schedule });
  } catch (err) {
    handleError(res, err);
  }
}

module.exports = {
  listSchedules,
  getSchedule,
  createSchedule,
  updateSchedule,
  cancelSchedule,
};
