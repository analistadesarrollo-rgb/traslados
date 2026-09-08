'use strict';

// Prueba de integración REAL del flujo con Puppeteer contra un sistema web
// simulado que replica la estructura del BusinessNET real:
// login (Cerberus) -> módulo APUESTAS -> horariopersonas
// -> buscar persona -> agregar horario en destino (cierre automático del anterior).

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

const config = require('../src/config');
const selectors = require('../src/config/selectors');
const { executeTransfer } = require('../src/automation');
const browser = require('../src/automation/browser');

function configureForMock() {
  const mockUrl =
    'file://' +
    path.resolve(__dirname, 'mock', 'web-system.html').replace(/\\/g, '/');

  config.webSystem.url = mockUrl;
  config.webSystem.user = 'admin';
  config.webSystem.password = 'secret';

  selectors.TEXT = {
    schedulesSectionTitle: 'Programación de personal',
    emptyTableIndicator: 'No se han encontrado',
    closePreviousConfirmation: 'cierre de los mismos',
  };

  selectors.ROUTES = { baseUrl: mockUrl, login: mockUrl, schedules: mockUrl };

  selectors.LOGIN_SELECTORS = {
    usernameField: '#frmLogin\\:user',
    passwordField: '#frmLogin\\:password',
    submitButton: '#frmLogin\\:send',
    sessionActiveIndicator: 'form#frmInicio',
  };

  selectors.MODULE_SELECTORS = {
    moduleButton: '#frmInicio\\:grid\\:0\\:j_idt41',
    moduleText: 'APUESTAS',
  };

  selectors.SEARCH_SELECTORS = {
    documentInput: '#formHorariopersonas\\:txtPrsDocumento',
    searchButton: '#formHorariopersonas\\:btnConsultarPer',
    resultsDialog: '#frmdlgPersonas',
    resultsTable: '#frmdlgPersonas\\:dtbPersonas_data',
    codeFilterInput: '#frmdlgPersonas\\:dtbPersonas\\:j_idt149\\:filter',
    selectPersonButtonOp: 'button[id*="btnCapturarPersona"]',
    noResultsIndicator: 'No se han encontrado',
  };

  selectors.SHIFT_SELECTORS = {
    shiftsContainer: '#formHorariopersonas\\:dtHorariopersona_data',
    shiftRow: 'tr',
    shiftCells: {
      branch: 0, name: 1, shiftType: 2, startTime: 3,
      endTime: 4, dayType: 5, startDate: 6, endDate: 7,
    },
    selectAllCheckbox: '#formHorariopersonas\\:dtHorariopersona_checkbox',
    selectionInput: '#formHorariopersonas\\:dtHorariopersona_selection',
    newShiftButton: '#formHorariopersonas\\:btnAgregarHorario',
    deleteButton: '#formHorariopersonas\\:eliminarDetalleParametro',
    confirmDeleteDialog: '#formconfirmEliminarM',
    confirmDeleteYes: '#formconfirmEliminarM\\:btnEliminarVariosHorarios',
    confirmDeleteOneDialog: '#formConfirmEliminar',
    confirmDeleteOneYes: '#formConfirmEliminar\\:btnEliminarUnHorario',
    rowCheckboxOp: 'input[type="checkbox"][name*="dtHorariopersona:"]',
    confirmClosePrevDialog: '#formConfirmCierreFechaFinal',
    confirmClosePrevYes: '#formConfirmCierreFechaFinal\\:j_idt239',
  };

  selectors.SHIFT_FORM_SELECTORS = {
    dialog: '#formPopupNueva',
    branchField: '#formPopupNueva\\:txtSucursal',
    branchNameReadonly: '#formPopupNueva\\:txtSucursalNombre',
    shiftTypeField: '#formPopupNueva\\:smeTipoHorario_input',
    dayTypeField: '#formPopupNueva\\:smeTipodia_input',
    startDateField: '#formPopupNueva\\:popupButtonCalini_input',
    endDateField: '#formPopupNueva\\:popupButtonCal_input',
    saveShiftButton: '#formPopupNueva\\:guardar2',
  };

  selectors.SHIFT_CREATION = {
    startDateMode: 'now',
    endDateMode: 'empty',
    defaultDayType: 'N',
    shiftTypeEmptyValue: '-1',
  };
}

test('flujo completo: traslado real con Puppeteer contra mock (add con cierre automático)', async () => {
  configureForMock();
  const result = await executeTransfer({
    document: '1234567890', // tiene horario activo en Sucursal Norte
    branch: 'SUR', // código que resuelve a Sucursal Sur
    requestId: 1,
  });
  await browser.closeBrowser();
  assert.equal(result.ok, true, 'El traslado debe tener éxito. Error: ' + result.error);
  assert.equal(result.sourceBranch, 'Sucursal Norte');
  assert.equal(result.destinationBranch, 'SUR');
  assert.ok(result.at instanceof Date);
});

test('persona sin horario activo -> error NO_ACTIVE_SHIFT', async () => {
  configureForMock();
  const result = await executeTransfer({
    document: '7777777777', // solo horario cerrado (fecha final no vacía)
    branch: 'SUR',
    requestId: 2,
  });
  await browser.closeBrowser();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'NO_ACTIVE_SHIFT');
});

test('persona con múltiples horarios activos -> error MULTIPLE_ACTIVE_SHIFTS', async () => {
  configureForMock();
  const result = await executeTransfer({
    document: '6666666666', // dos horarios activos
    branch: 'SUR',
    requestId: 3,
  });
  await browser.closeBrowser();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'MULTIPLE_ACTIVE_SHIFTS');
});

test('persona inexistente -> error DOCUMENT_NOT_FOUND', async () => {
  configureForMock();
  const result = await executeTransfer({
    document: '5555555555', // no existe en el mock
    branch: 'SUR',
    requestId: 4,
  });
  await browser.closeBrowser();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'DOCUMENT_NOT_FOUND');
});

test('sucursal destino inexistente -> error BRANCH_NOT_FOUND', async () => {
  configureForMock();
  const result = await executeTransfer({
    document: '1234567890',
    branch: 'ZZZ', // código que no resuelve a ninguna sucursal
    requestId: 5,
  });
  await browser.closeBrowser();
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'BRANCH_NOT_FOUND');
});
