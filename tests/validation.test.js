'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { validateDocument, validateBranch, parseCommand } = require('../src/services/validation');

test('documento vacío', () => {
  assert.equal(validateDocument('').ok, false);
  assert.equal(validateDocument(null).ok, false);
  assert.equal(validateDocument(undefined).ok, false);
});

test('documento inválido', () => {
  assert.equal(validateDocument('abc').ok, false);
  assert.equal(validateDocument('123').ok, false); // muy corto
  assert.equal(validateDocument('1234567890123').ok, false); // muy largo (13)
  assert.equal(validateDocument('12345a').ok, false);
});

test('documento válido', () => {
  assert.equal(validateDocument('1234567890').ok, true);
  assert.equal(validateDocument('123456').ok, true);
  assert.equal(validateDocument('123456789012').ok, true);
});

test('sucursal vacía', () => {
  assert.equal(validateBranch('').ok, false);
  assert.equal(validateBranch(null).ok, false);
});

test('sucursal válida', () => {
  assert.equal(validateBranch('SUCURSAL SUR').ok, true);
});

test('comandos desconocidos', () => {
  const r = parseCommand('VER TURNO');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Comando desconocido');
});

test('formato multi-línea con etiquetas', () => {
  const msg = 'Traslado\nDocumento: 38668841\nSucursal: 39653';
  const r = parseCommand(msg);
  assert.equal(r.ok, true);
  assert.equal(r.document, '38668841');
  assert.equal(r.branch, '39653');
});

test('formato multi-línea con espacios extra', () => {
  const msg = '  Traslado  \n  Documento:  1112461905  \n  Sucursal:  045  ';
  const r = parseCommand(msg);
  assert.equal(r.ok, true);
  assert.equal(r.document, '1112461905');
  assert.equal(r.branch, '045');
});

test('formato multi-línea case-insensitive', () => {
  const msg = 'TRASLADO\nDOCUMENTO: 805003010\nSUCURSAL: 901';
  const r = parseCommand(msg);
  assert.equal(r.ok, true);
  assert.equal(r.document, '805003010');
  assert.equal(r.branch, '901');
});

test('formato línea única', () => {
  const r = parseCommand('TRASLADO 38668841 39653');
  assert.equal(r.ok, true);
  assert.equal(r.document, '38668841');
  assert.equal(r.branch, '39653');
});

test('formato multi-línea sin documento', () => {
  const r = parseCommand('Traslado\nSucursal: 39653');
  assert.equal(r.ok, false);
});

test('formato multi-línea sin sucursal', () => {
  const r = parseCommand('Traslado\nDocumento: 38668841');
  assert.equal(r.ok, false);
});

test('formato multi-línea documento inválido', () => {
  const r = parseCommand('Traslado\nDocumento: 123\nSucursal: 39653');
  assert.equal(r.ok, false);
});

test('formato multi-línea con sucursal actual (ignorada)', () => {
  const msg = 'Traslado\nDocumento: 1006364690\nSucursal: 39653\nSucursal actual: 39657';
  const r = parseCommand(msg);
  assert.equal(r.ok, true);
  assert.equal(r.document, '1006364690');
  assert.equal(r.branch, '39653');
  assert.equal(r.currentBranch, undefined);
});

test('formato multi-línea sin sucursal actual (opcional)', () => {
  const msg = 'Traslado\nDocumento: 1006364690\nSucursal: 39653';
  const r = parseCommand(msg);
  assert.equal(r.ok, true);
  assert.equal(r.document, '1006364690');
  assert.equal(r.branch, '39653');
  assert.equal(r.currentBranch, undefined);
});
