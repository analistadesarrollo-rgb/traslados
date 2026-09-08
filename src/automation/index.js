'use strict';

const config = require('../config');
const selectors = require('../config/selectors');
const logger = require('../logger').child('automation');
const browser = require('./browser');
const session = require('./session');
const shifts = require('./shifts');
const errors = require('./errors');
const { waitMs } = require('./browser');

/**
 * Orquestador del traslado completo dentro del sistema web real.
 *
 * Flujo:
 *   1) Login → módulo APUESTAS → horariopersonas
 *   2) Buscar persona por documento (Enter)
 *   3) Filtrar tabla por Fecha final = "null" (registros activos)
 *   4) Click lápiz → modal edición → calendario → Fecha Actual → Guardar
 *   5) Click "+ Agregar" → modal nuevo horario
 *   6) Sucursal destino + Enter → Down (TODO EL DIA) → Tab → Down (Normal) →
 *      Tab Tab Enter → Tab Tab Enter (Guardar)
 */

function ensureSelectorsConfigured() {
  const critical = [
    ['LOGIN_SELECTORS.usernameField', selectors.LOGIN_SELECTORS.usernameField],
    ['LOGIN_SELECTORS.passwordField', selectors.LOGIN_SELECTORS.passwordField],
    ['LOGIN_SELECTORS.submitButton', selectors.LOGIN_SELECTORS.submitButton],
    ['SEARCH_SELECTORS.documentInput', selectors.SEARCH_SELECTORS.documentInput],
    ['SHIFT_SELECTORS.newShiftButton', selectors.SHIFT_SELECTORS.newShiftButton],
    ['SHIFT_FORM_SELECTORS.branchField', selectors.SHIFT_FORM_SELECTORS.branchField],
  ];
  const missing = critical.filter(([k, v]) => !v || String(v).includes('{{'));
  if (missing.length > 0) {
    throw new errors.AutomationNotConfiguredError(
      `Faltan selectores: ${missing.map(([k]) => k).join(', ')}.`
    );
  }
  if (!config.webSystem.url || !config.webSystem.user || !config.webSystem.password) {
    throw new errors.AutomationNotConfiguredError(
      'Faltan WEB_SYSTEM_URL / WEB_SYSTEM_USER / WEB_SYSTEM_PASSWORD en .env.'
    );
  }
}

/**
 * Ejecuta el traslado de un colocador a una sucursal.
 * @param {object} params
 * @param {string} params.document   Documento del colocador.
 * @param {string} params.branch     Código de la sucursal destino.
 * @param {number} [params.requestId]
 */
async function executeTransfer({ document, branch, requestId = null }) {
  const log = (msg, meta = {}) => logger.info(msg, Object.assign({ requestId, document }, meta));
  const logWarn = (msg, meta = {}) => logger.warn(msg, Object.assign({ requestId, document }, meta));

  let page = null;
  try {
    ensureSelectorsConfigured();

    log('Inicio de automatización', { branch });
    page = await browser.newPage();

    // 1) Sesión
    log('Estableciendo sesión en el sistema web');
    const logged = await session.ensureLoggedIn(page);
    if (!logged) {
      logWarn('Login fallido');
      throw new errors.LoginFailedError();
    }

    // 2) Buscar persona por documento
    log('Buscando persona por documento');
    const persona = await shifts.searchPerson(page, document);
    if (!persona.found) {
      if (persona.reason === 'session-retry') {
        logWarn('Sesión perdida al cargar persona');
        throw new errors.LoginFailedError();
      }
      logWarn('Persona no encontrada');
      throw new errors.DocumentNotFoundError(document);
    }
    log('Persona encontrada', { name: persona.name });

    // 2b) Cerrar diálogo "Personas" si quedó abierto
    await page.evaluate(() => {
      const closeBtn = document.querySelector('#frmdlgPersonas .ui-dialog-titlebar-close');
      if (closeBtn && closeBtn.offsetParent !== null) closeBtn.click();
    }).catch(() => {});
    await waitMs(1000);

    // 3) Editar horario activo: filtrar → lápiz → cambiar sucursal → Guardar → cerrar X
    log('Editando horario activo con sucursal destino', { branch });
    const edited = await shifts.closeCurrentShift(page, branch);
    if (!edited.ok) {
      if (edited.error === 'no-active-shift') {
        logWarn('No se encontró horario activo');
        throw new errors.NoActiveShiftError(document);
      }
      logWarn('No se pudo editar el horario', { error: edited.error });
      throw new errors.CreateShiftError(`No se pudo editar el horario. Requiere revisión manual.`);
    }
    log('Horario editado correctamente');

    // 4) Verificar que el traslado se realizó correctamente
    log('Verificando traslado');
    const verified = await shifts.verifyTransfer(page, document, branch);
    if (!verified.verified) {
      logWarn('Verificación fallida', { error: verified.error, actualBranch: verified.actualBranch });
      throw new errors.CreateShiftError(`La verificación falló: ${verified.error}. Requiere revisión manual.`);
    }
    log('Verificación exitosa', { actualBranch: verified.actualBranch });

    // 5) Éxito
    log('Traslado completado exitosamente');
    return {
      ok: true,
      sourceBranch: verified.actualBranch,
      destinationBranch: branch,
      at: new Date(),
    };
  } catch (err) {
    if (page) {
      try {
        await browser.captureEvidence(page, err.code || 'error');
      } catch (_) {
        /* ignore */
      }
    }
    if (err instanceof errors.TransferError) {
      logWarn('Error de transferencia', { code: err.code, message: err.message });
      return { ok: false, errorCode: err.code, error: err.message };
    }
    const netErr = detectNetworkError(err);
    if (netErr) {
      logWarn('Error de red/web', { message: netErr.message });
      return { ok: false, errorCode: netErr.code, error: netErr.message };
    }
    logWarn('Error inesperado', { message: err.message, stack: err.stack });
    return { ok: false, errorCode: 'UNEXPECTED', error: `Error inesperado: ${err.message}` };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function detectNetworkError(err) {
  const msg = String((err && err.message) || '');
  if (/net::ERR|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|navigation|net::ERR_CONNECTION/i.test(msg)) {
    return new errors.WebSystemUnreachableError(`El sistema web no está accesible: ${msg}`);
  }
  return null;
}

module.exports = { executeTransfer, ensureSelectorsConfigured };
