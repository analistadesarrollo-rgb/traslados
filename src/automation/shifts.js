'use strict';

const config = require('../config');
const selectors = require('../config/selectors');
const logger = require('../logger').child('automation.shifts');
const { settle, waitMs } = require('./browser');

/**
 * Operaciones sobre HORARIOS de una persona dentro del sistema web real.
 *
 * Flujo real (confirmado con el usuario):
 *   1) Buscar persona por documento (Enter).
 *   2) Filtrar tabla por sucursal actual (escribir código + Enter).
 *   3) Click en lápiz de la fila filtrada → modal de edición.
 *   4) En el modal: click ícono calendario → "Fecha Actual" → Guardar.
 *   5) Click botón "+ Agregar" → modal de nuevo horario.
 *   6) Escribir sucursal destino + Enter → flecha abajo (TODO EL DIA) →
 *      Tab → flecha abajo (Normal) → Tab Tab Enter (fecha inicio) →
 *      Tab Tab Enter (Guardar).
 */

function requireConfigured(selectorsObj, name) {
  const missing = Object.entries(selectorsObj).filter(
    ([k, v]) => v !== undefined && String(v).includes('{{')
  );
  if (missing.length > 0) {
    throw new Error(
      `Selectores no configurados (${name}): ${missing.map(([k]) => k).join(', ')}`
    );
  }
}

/**
 * Busca persona por documento.
 * @returns {Promise<{found:boolean, name?:string, cargo?:string, code?:string}>}
 */
async function searchPerson(page, document) {
  requireConfigured(selectors.SEARCH_SELECTORS, 'selectors.SEARCH_SELECTORS');
  const S = selectors.SEARCH_SELECTORS;
  const doc = String(document).trim();

  logger.info('Paso 1: Escribiendo documento');
  await page.waitForSelector(S.documentInput, { timeout: config.automation.timeoutMs, visible: true });
  await page.click(S.documentInput, { clickCount: 3 });
  await waitMs(500);
  await page.type(S.documentInput, doc, { delay: 80 });
  await waitMs(500);

  logger.info('Paso 2: Presionando Enter');
  await page.keyboard.press('Enter');

  logger.info('Paso 3: Esperando carga de la persona');
  try {
    await page.waitForFunction(
      () => {
        const url = window.location.href;
        if (url.includes('noautorizado')) return true;
        const el = document.getElementById('formHorariopersonas:txtNombre');
        return el && el.value && el.value.trim() !== '';
      },
      { timeout: 20000 }
    );
  } catch (_) {
    logger.warn('Timeout esperando nombre de persona');
  }
  await settle(page, 2000);

  const currentUrl = page.url();
  if (currentUrl.includes('noautorizado')) {
    logger.warn('Sesión perdida al cargar persona', { url: currentUrl });
    return { found: false, reason: 'session-retry' };
  }

  const info = await page.evaluate(() => {
    const g = (id) => {
      const el = document.getElementById(id);
      return el ? el.value : '';
    };
    return {
      name: g('formHorariopersonas:txtNombre'),
      cargo: g('formHorariopersonas:txtCargo'),
      code: g('formHorariopersonas:txtPrsDocumento'),
    };
  });

  if (!info.name || !info.name.trim()) {
    logger.warn('Nombre de persona vacío tras Enter', { document: doc });
    return { found: false };
  }

  logger.info('Persona seleccionada', { document: doc, name: info.name, cargo: info.cargo });
  return { found: true, name: info.name, cargo: info.cargo, code: info.code || doc };
}

/**
 * Filtra la tabla de horarios por "Fecha final" = "null" para encontrar registros activos.
 * Busca el campo de filtro debajo de la columna "Fecha final" y escribe "null".
 * @param {import('puppeteer').Page} page
 * @returns {Promise<{filtered:boolean, rowCount:number}>}
 */
async function filterByActiveShift(page) {
  logger.info('Filtrando tabla por Fecha final = null (horarios activos)');

  // Buscar el input de filtro de la columna Fecha final (thead > tr > th > input)
  const filterInput = await page.evaluate(() => {
    const table = document.querySelector('#formHorariopersonas\\:dtHorariopersona');
    if (!table) return null;
    const headers = table.querySelectorAll('thead th');
    for (const th of headers) {
      const text = th.textContent.trim().toLowerCase();
      if (text.includes('fecha final') || text.includes('fecha\nfinal')) {
        const input = th.querySelector('input[type="text"], input:not([type="hidden"])');
        if (input) return input.id;
      }
    }
    return null;
  });

  if (!filterInput) {
    logger.warn('No se encontró campo de filtro de Fecha final');
    return { filtered: false, rowCount: 0 };
  }

  logger.info('Campo de filtro de Fecha final encontrado', { filterInput });
  const sel = `#${filterInput.replace(/:/g, '\\:')}`;
  await page.waitForSelector(sel, { timeout: 5000, visible: true });
  await page.click(sel, { clickCount: 3 });
  await waitMs(300);
  await page.type(sel, 'null', { delay: 80 });
  await waitMs(500);
  await page.keyboard.press('Enter');
  await waitMs(2000);
  await settle(page, 3000);

  // Contar filas resultantes
  const rowCount = await page.evaluate(() => {
    const container = document.querySelector('#formHorariopersonas\\:dtHorariopersona_data');
    if (!container) return 0;
    return container.querySelectorAll('tr').length;
  });

  logger.info('Filtrado completado', { rowCount });
  return { filtered: true, rowCount };
}

/**
 * Hace click en el ícono de lápiz (editar) de la primera fila de la tabla.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function clickEditIcon(page) {
  logger.info('Buscando ícono de lápiz en la primera fila');

  const result = await page.evaluate(() => {
    const container = document.querySelector('#formHorariopersonas\\:dtHorariopersona_data');
    if (!container) return { ok: false, error: 'table-not-found' };
    const firstRow = container.querySelector('tr');
    if (!firstRow) return { ok: false, error: 'no-rows' };

    const cells = firstRow.querySelectorAll('td');
    // El lápiz está en la penúltima columna
    const editCell = cells[cells.length - 2];
    if (!editCell) return { ok: false, error: 'edit-cell-not-found', totalCells: cells.length };

    // Buscar cualquier elemento clickeable
    const btn = editCell.querySelector('button, a, span, i, div');
    if (btn) {
      btn.click();
      return { ok: true, method: 'inner-element', tag: btn.tagName };
    }
    editCell.click();
    return { ok: true, method: 'cell-click' };
  });

  if (!result.ok) {
    logger.warn('No se pudo hacer click en lápiz', { error: result.error });
    return { ok: false, error: result.error };
  }

  logger.info('Click en lápiz realizado', { method: result.method });
  await waitMs(3000);
  return { ok: true };
}

/**
 * En el modo edición (después de click lápiz): Tab 8 veces → Enter (calendario) →
 * Fecha Actual → Enter (Guardar) → cerrar modal con X.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function setEndDateToday(page) {
  logger.info('Editando fecha final con navegación por teclado');

  // 1) Tab 6 veces para llegar al ícono de calendario
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    await waitMs(800);
  }
  logger.info('Tab x6 completado');
  await waitMs(1000);

  // 2) Enter para abrir el calendario
  await page.keyboard.press('Enter');
  await waitMs(3000);
  logger.info('Enter presionado (calendario)');

  // 3) Buscar y hacer click en "Fecha Actual"
  const clicked = await page.evaluate(() => {
    const allElements = document.querySelectorAll('span, a, div, button, td');
    for (const el of allElements) {
      const text = el.textContent.trim().toLowerCase();
      if ((text === 'fecha actual' || text === 'fecha de hoy') && el.offsetParent !== null) {
        el.click();
        return { found: true, text: el.textContent.trim() };
      }
    }
    return { found: false };
  });

  if (clicked.found) {
    logger.info('Click en "Fecha Actual" realizado', { text: clicked.text });
    await waitMs(2000);
  } else {
    logger.warn('Opción "Fecha Actual" no encontrada');
  }

  // 4) Enter para Guardar
  await page.keyboard.press('Enter');
  await waitMs(3000);
  logger.info('Enter presionado (Guardar)');

  // 5) Cerrar el modal de edición con la X de "Horarios y sucursales asignadas a la persona"
  const closed = await page.evaluate(() => {
    // Buscar el título que contiene "Horarios y sucursales"
    const titles = document.querySelectorAll('.ui-dialog-title');
    for (const title of titles) {
      if (title.textContent.includes('Horarios') || title.textContent.includes('sucursales')) {
        const dialog = title.closest('.ui-dialog');
        if (dialog) {
          const closeBtn = dialog.querySelector('.ui-dialog-titlebar-close');
          if (closeBtn && closeBtn.offsetParent !== null) {
            closeBtn.click();
            return { found: true, title: title.textContent.trim() };
          }
        }
      }
    }
    // Fallback: cerrar cualquier diálogo visible
    const dialogs = document.querySelectorAll('.ui-dialog');
    for (const dialog of dialogs) {
      if (dialog.style.display === 'none') continue;
      const closeBtn = dialog.querySelector('.ui-dialog-titlebar-close');
      if (closeBtn && closeBtn.offsetParent !== null) {
        closeBtn.click();
        return { found: true, title: 'fallback' };
      }
    }
    return { found: false };
  });

  if (closed.found) {
    logger.info('Modal de edición cerrado');
    await waitMs(5000); // Esperar a que la página se recargue completamente
  } else {
    logger.warn('No se encontró botón de cerrar modal');
  }

  return { ok: true };
}

/**
 * Cierra el horario activo (sin fecha final).
 * Flujo: filtrar por null en Fecha final → click lápiz → calendario → Fecha Actual → Guardar.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function closeCurrentShift(page) {
  // 1) Filtrar por Fecha final = null (registros activos)
  const filtered = await filterByActiveShift(page);
  if (!filtered.filtered) {
    return { ok: false, error: 'filter-failed' };
  }
  if (filtered.rowCount === 0) {
    return { ok: false, error: 'no-active-shift' };
  }

  // 2) Click en lápiz de la primera fila
  const editClicked = await clickEditIcon(page);
  if (!editClicked.ok) {
    return { ok: false, error: editClicked.error };
  }

  // 3) Calendario → Fecha Actual → Guardar
  const endDateSet = await setEndDateToday(page);
  if (!endDateSet.ok) {
    return { ok: false, error: endDateSet.error };
  }

  return { ok: true };
}

/**
 * Abre el modal de nuevo horario y lo llena con la sucursal destino.
 * Flujo exacto:
 *   1) Click "+ Agregar"
 *   2) Escribir sucursal + Enter
 *   3) Esperar
 *   4) Down (TODO EL DIA)
 *   5) Tab → Down (Normal)
 *   6) Tab Tab → Enter (calendario fecha inicio)
 *   7) Click "Fecha Actual"
 *   8) Enter (Guardar)
 *   9) Cerrar modal con X
 */
async function addNewShift(page, branchCode) {
  requireConfigured(selectors.SHIFT_FORM_SELECTORS, 'selectors.SHIFT_FORM_SELECTORS');
  const F = selectors.SHIFT_FORM_SELECTORS;
  const S = selectors.SHIFT_SELECTORS;

  // 1) Click en botón "+ Agregar"
  logger.info('Paso 1: Abriendo modal de nuevo horario');
  await waitMs(3000);

  // DIAGNÓSTICO: buscar todos los botones visibles
  const diagButtons = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button, a[role="button"], span.ui-button');
    const results = [];
    for (const btn of buttons) {
      if (btn.offsetParent !== null) {
        results.push({
          id: btn.id,
          text: btn.textContent.trim().substring(0, 50),
          className: btn.className.substring(0, 80),
          tag: btn.tagName,
        });
      }
    }
    return results;
  });
  logger.info('DIAGNÓSTICO BOTONES VISIBLES', { buttons: JSON.stringify(diagButtons) });

  // Intentar con el selector configurado
  let clicked = false;
  if (S.newShiftButton && !String(S.newShiftButton).includes('{{')) {
    try {
      await page.waitForSelector(S.newShiftButton, { timeout: 5000, visible: true });
      await page.click(S.newShiftButton);
      clicked = true;
      logger.info('Click en botón Agregar (selector configurado)', { selector: S.newShiftButton });
    } catch (e) {
      logger.warn('Selector configurado no funcionó', { error: e.message });
    }
  }

  // Fallback: buscar botón por texto "+ Agregar" o "Agregar"
  if (!clicked) {
    clicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, a[role="button"], span');
      for (const btn of buttons) {
        const text = btn.textContent.trim().toLowerCase();
        if ((text.includes('agregar') || text.includes('+')) && btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      logger.info('Click en botón Agregar (búsqueda por texto)');
    }
  }

  if (!clicked) {
    logger.warn('No se encontró botón Agregar');
    return { ok: false, error: 'add-button-not-found' };
  }

  await waitMs(4000);

  // Esperar a que abra el modal
  const modalVisible = await page.waitForSelector('.ui-dialog:visible', { timeout: 10000 })
    .then(() => true).catch(() => false);
  if (!modalVisible) {
    logger.warn('No se abrió modal de nuevo horario');
    return { ok: false, error: 'add-modal-not-found' };
  }
  await waitMs(2000);

  // DIAGNÓSTICO: capturar todos los inputs visibles del modal
  const diagInputs = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('.ui-dialog');
    const results = [];
    for (const dialog of dialogs) {
      if (dialog.style.display === 'none') continue;
      const title = dialog.querySelector('.ui-dialog-title');
      const inputs = dialog.querySelectorAll('input');
      for (const inp of inputs) {
        results.push({
          dialogTitle: title ? title.textContent.trim() : '',
          id: inp.id,
          type: inp.type,
          value: inp.value,
          readOnly: inp.readOnly,
          disabled: inp.disabled,
          visible: inp.offsetParent !== null,
          placeholder: inp.placeholder || '',
        });
      }
    }
    return results;
  });
  logger.info('DIAGNÓSTICO INPUTS EN MODAL', { inputs: JSON.stringify(diagInputs) });

  // 2) Escribir sucursal destino + Enter
  logger.info('Paso 2: Buscando campo de sucursal en modal');
  
  // Intentar con el selector configurado primero
  let useSelector = null;
  if (F.branchField && !String(F.branchField).includes('{{')) {
    const testEl = await page.$(F.branchField);
    if (testEl) {
      useSelector = F.branchField;
      logger.info('Usando selector configurado', { selector: useSelector });
    }
  }

  // Si no funcionó, buscar por ID parcial
  if (!useSelector) {
    useSelector = await page.evaluate(() => {
      // Buscar input que contenga "txtSucursal" o "Sucursal" en el ID
      const inputs = document.querySelectorAll('input[id*="txtSucursal"], input[id*="Sucursal"]');
      for (const inp of inputs) {
        if (inp.offsetParent !== null && !inp.readOnly && !inp.disabled) {
          return inp.id;
        }
      }
      return null;
    });
    if (useSelector) {
      useSelector = `#${useSelector.replace(/:/g, '\\:')}`;
      logger.info('Encontrado por ID parcial', { selector: useSelector });
    }
  }

  // Último fallback: buscar el primer input editable del modal
  if (!useSelector) {
    const branchInputId = await page.evaluate(() => {
      const dialogs = document.querySelectorAll('.ui-dialog');
      for (const dialog of dialogs) {
        if (dialog.style.display === 'none') continue;
        const inputs = dialog.querySelectorAll('input[type="text"], input:not([type="hidden"]):not([type="checkbox"])');
        for (const inp of inputs) {
          if (inp.offsetParent !== null && !inp.readOnly && !inp.disabled) {
            return inp.id;
          }
        }
      }
      return null;
    });
    if (branchInputId) {
      useSelector = `#${branchInputId.replace(/:/g, '\\:')}`;
      logger.info('Encontrado primer input visible', { selector: useSelector });
    }
  }

  if (useSelector) {
    await page.waitForSelector(useSelector, { timeout: 5000, visible: true });
    await page.click(useSelector, { clickCount: 3 });
    await waitMs(800);
    await page.type(useSelector, String(branchCode).trim(), { delay: 100 });
    await waitMs(1500);
  } else {
    logger.warn('No se encontró campo de sucursal en el modal');
    return { ok: false, error: 'branch-field-not-found' };
  }

  // 3) Enter para resolver la sucursal
  logger.info('Paso 3: Enter para resolver sucursal');
  await page.keyboard.press('Enter');
  await waitMs(4000);

  // Verificar que la sucursal se resolvió (buscar campo de nombre de sucursal)
  const resolvedName = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('.ui-dialog');
    for (const dialog of dialogs) {
      if (dialog.style.display === 'none') continue;
      // Buscar inputs de solo lectura o con nombre de sucursal
      const inputs = dialog.querySelectorAll('input[readonly], input[id*="Nombre"], input[id*="nombre"]');
      for (const inp of inputs) {
        if (inp.offsetParent !== null && inp.value && inp.value.trim()) {
          return inp.value.trim();
        }
      }
    }
    return null;
  });

  if (resolvedName) {
    logger.info('Sucursal resuelta', { branchCode, name: resolvedName });
  } else {
    logger.warn('No se pudo verificar el nombre de la sucursal', { branchCode });
  }

  // 4) Flecha abajo para Tipo horario → TODO EL DIA
  logger.info('Paso 4: Down para Tipo horario');
  await page.keyboard.press('ArrowDown');
  await waitMs(2000);

  // 5) Tab para ir a Tipo día
  logger.info('Paso 5: Tab para Tipo día');
  await page.keyboard.press('Tab');
  await waitMs(1500);

  // 6) Flecha abajo para Tipo día → Normal
  logger.info('Paso 6: Down para Tipo día');
  await page.keyboard.press('ArrowDown');
  await waitMs(2000);

  // 7) Tab Tab para llegar al calendario de Fecha inicio
  logger.info('Paso 7: Tab Tab para calendario fecha inicio');
  await page.keyboard.press('Tab');
  await waitMs(1500);
  await page.keyboard.press('Tab');
  await waitMs(1500);

  // 8) Enter para abrir calendario de Fecha inicio
  logger.info('Paso 8: Enter para abrir calendario');
  await page.keyboard.press('Enter');
  await waitMs(3000);

  // 9) Click en "Fecha Actual"
  logger.info('Paso 9: Buscando Fecha Actual');
  const clickedFecha = await page.evaluate(() => {
    const allElements = document.querySelectorAll('span, a, div, button, td');
    for (const el of allElements) {
      const text = el.textContent.trim().toLowerCase();
      if ((text === 'fecha actual' || text === 'fecha de hoy') && el.offsetParent !== null) {
        el.click();
        return { found: true };
      }
    }
    return { found: false };
  });

  if (clickedFecha.found) {
    logger.info('Click en "Fecha Actual" realizado');
    await waitMs(2000);
  } else {
    logger.warn('Opción "Fecha Actual" no encontrada');
  }

  // 10) Enter para Guardar
  logger.info('Paso 10: Enter para Guardar');
  await page.keyboard.press('Enter');
  await waitMs(5000);

  // 11) Manejar diálogo de cierre de horarios anteriores (si aparece)
  if (S.confirmClosePrevYes && !String(S.confirmClosePrevYes).includes('{{')) {
    try {
      await page.waitForSelector(S.confirmClosePrevYes, { timeout: 8000, visible: true });
      await waitMs(1500);
      logger.info('Diálogo de cierre detectado, confirmando');
      await page.click(S.confirmClosePrevYes);
      await waitMs(4000);
    } catch (_) {
      logger.info('No apareció diálogo de cierre');
    }
  }

  // 12) Cerrar el modal con la X
  logger.info('Paso 12: Cerrando modal');
  const closed = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('.ui-dialog');
    for (const dialog of dialogs) {
      if (dialog.style.display === 'none') continue;
      const title = dialog.querySelector('.ui-dialog-title');
      const closeBtn = dialog.querySelector('.ui-dialog-titlebar-close');
      if (closeBtn && closeBtn.offsetParent !== null) {
        closeBtn.click();
        return { found: true, title: title ? title.textContent.trim() : '' };
      }
    }
    return { found: false };
  });

  if (closed.found) {
    logger.info('Modal cerrado', { title: closed.title });
    await waitMs(2000);
  } else {
    logger.warn('No se encontró modal para cerrar');
  }

  await settle(page, 5000);
  logger.info('Nuevo horario creado');
  return { ok: true };
}

/**
 * Determina si un horario está ACTIVO (Fecha final vacía).
 * @param {string[]} cells  Arreglo de celdas de la fila
 * @returns {boolean}
 */
function isActiveHorario(cells) {
  const cfg = selectors.SHIFT_SELECTORS.shiftCells || {};
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  if (cfg.endDate === undefined) {
    throw new Error('Configure selectors.SHIFT_SELECTORS.shiftCells.endDate (columna Fecha final).');
  }
  const endDate = cells[cfg.endDate] !== undefined ? cells[cfg.endDate] : '';
  return !has(endDate);
}

module.exports = {
  searchPerson,
  filterByActiveShift,
  clickEditIcon,
  setEndDateToday,
  closeCurrentShift,
  addNewShift,
  isActiveHorario,
  fmtDate,
};

/** Formatea una fecha como dd/mm/yyyy. */
function fmtDate(d) {
  const t = (n) => String(n).padStart(2, '0');
  return `${t(d.getDate())}/${t(d.getMonth() + 1)}/${d.getFullYear()}`;
}
