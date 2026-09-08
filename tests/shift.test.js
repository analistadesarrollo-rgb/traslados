'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

process.env.DB_FILE = ':memory:';

const selectors = require('../src/config/selectors');

// Configurar shiftCells para que coincida con la tabla del mock:
// branch=0, name=1, shiftType=2, startTime=3, endTime=4, dayType=5, startDate=6, endDate=7
selectors.SHIFT_SELECTORS = selectors.SHIFT_SELECTORS || {};
selectors.SHIFT_SELECTORS.shiftCells = { branch: 0, name: 1, shiftType: 2, startTime: 3, endTime: 4, dayType: 5, startDate: 6, endDate: 7 };

const { isActiveHorario } = require('../src/automation/shifts');

test('horario activo: fecha final vacía', () => {
  const cells = ['Sucursal Norte', 'PEDRO PEREZ', 'TODO EL DIA', '04:00', '22:30', 'Normal', '02/09/2026', ''];
  assert.equal(isActiveHorario(cells), true);
});

test('horario cerrado: tiene fecha final', () => {
  const cells = ['Sucursal Norte', 'JUAN SIN TURNO', 'MANANA', '05:00', '13:15', 'Normal', '01/09/2026', '01/09/2026'];
  assert.equal(isActiveHorario(cells), false);
});

test('sin datos: fecha final vacía se considera activo (solo fecha final determina)', () => {
  const cells = ['', '', '', '', '', '', '', ''];
  assert.equal(isActiveHorario(cells), true);
});

test('fecha final con espacios en blanco se considera activo', () => {
  const cells = ['SUR', 'X', 'MANANA', '05:00', '13:00', 'Normal', '01/09', '  '];
  assert.equal(isActiveHorario(cells), true);
});

test('horario con fecha final vacía = activo', () => {
  const cells = ['SUR', 'ANA', 'TODO EL DIA', '04:00', '22:30', 'Normal', '02/09/2026', ''];
  assert.equal(isActiveHorario(cells), true);
});

test('detecta horarios múltiples activos (dos filas con final vacío)', () => {
  const c1 = ['NORTE', 'ANA', 'TODO EL DIA', '04:00', '22:30', 'Normal', '02/09', ''];
  const c2 = ['CENTRO', 'ANA', 'MANANA', '05:00', '13:15', 'Normal', '02/09', ''];
  const c3 = ['NORTE', 'ANA', 'MANANA', '06:00', '12:00', 'Normal', '02/09', '02/09'];
  const active = [c1, c2, c3].filter((cells) => isActiveHorario(cells));
  assert.equal(active.length, 2);
});
