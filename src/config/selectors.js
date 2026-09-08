'use strict';

/**
 * =====================================================================
 * CONFIGURACIÓN CENTRALIZADA DE LA AUTOMATIZACIÓN DEL SISTEMA WEB
 * =====================================================================
 *
 * Este archivo contiene TODOS los selectores y rutas reales del sistema
 * de negocio (Java Server Faces + PrimeFaces) "BusinessNET":
 *   - Login: portal de seguridad "Seguridad-WEB" (Cerberus)
 *   - Módulo: APUESTAS (BNET ADMINISTRATIVO)
 *   - Pantalla: .../adminventa/horariopersonas.xhtml "Programación de personal"
 *
 * Mecánica del traslado (confirmada con el usuario):
 *   1) Buscar la persona por su documento.
 *   2) En "Horarios y sucursales asignadas a la persona", ELIMINAR el
 *      horario de la sucursal de origen (tabla dtHorariopersona).
 *   3) AGREGAR un nuevo horario en la sucursal de destino (diálogo
 *      formPopupNueva) con la fecha actual como Fecha inicio y sin Fecha final
 *      (quedando ACTIVO).
 *
 * Si algo cambia de versión, ajuste aquí sin tocar el resto del código.
 * =====================================================================
 */

/**
 * Textos / heurísticos usados para identificar estados en pantalla.
 */
const TEXT = {
  // Título / encabezado de la sección de horarios de personas
  schedulesSectionTitle: 'Programación de personal',
  // Texto mostrado cuando no hay registros en una tabla
  emptyTableIndicator: 'No se han encontrado registros',
  // Dialogo de confirmación al guardar nuevo horario cuando ya existen
  // horarios previos (se cierran automáticamente). Texto parcial del mensaje.
  closePreviousConfirmation: 'cierre de los mismos',
};

/**
 * Rutas / URLs del sistema web.
 * baseUrl y login se completan dinámicamente: la app real redirige al
 * portal de seguridad, pero WEB_SYSTEM_URL es la de negocio (horariopersonas).
 */
const ROUTES = {
  baseUrl: '',
  login: '', // redirige automáticamente al portal de seguridad (Seguridad-WEB)
  schedules: '/XHTML/azar/adminventa/horariopersonas.xhtml',
};

/**
 * Selectores para la pantalla de LOGIN del portal de seguridad (Cerberus).
 */
const LOGIN_SELECTORS = {
  usernameField: '#frmLogin\\:user',
  passwordField: '#frmLogin\\:password',
  submitButton: '#frmLogin\\:send',
  // Selector que existe cuando la sesión ya inició (home del portal de seguridad)
  sessionActiveIndicator: 'form#frmInicio',
};

/**
 * Selector del módulo APUESTAS en el home del portal de seguridad.
 * Es un commandLink PrimeFaces que redirige al proxy de la app de negocio.
 */
const MODULE_SELECTORS = {
  // commandLink del módulo APUESTAS (BNET ADMINISTRATIVO)
  moduleButton: '#frmInicio\\:grid\\:0\\:j_idt41',
  // Texto de respaldo para localizar el módulo por contenido
  moduleText: 'APUESTAS',
};

/**
 * Selectores de la BÚSQUEDA DE PERSONAS por documento (pantalla horariopersonas).
 * Flujo: escribir documento en txtPrsDocumento -> btnConsultarPer abre el
 * diálogo de personas -> filtrar por Código -> pulsar Seleccionar.
 */
const SEARCH_SELECTORS = {
  // Campo "Persona (solo consulta)"
  documentInput: '#formHorariopersonas\\:txtPrsDocumento',
  // Botón "Consultar" que abre el diálogo de personas
  searchButton: '#formHorariopersonas\\:btnConsultarPer',
  // Contenedor del diálogo de personas
  resultsDialog: '#frmdlgPersonas',
  // Tabla de resultados de personas (del diálogo)
  resultsTable: '#frmdlgPersonas\\:dtbPersonas_data',
  // Filtro de la columna "Código" del diálogo (para ubicar por documento)
  codeFilterInput: '#frmdlgPersonas\\:dtbPersonas\\:j_idt149\\:filter',
  // Botón "Seleccionar" de una fila (se busca por prefijo id, fila data-rk == doc)
  selectPersonButtonOp: 'button[id*="btnCapturarPersona"]',
  // Mensaje mostrado cuando no hay filas (persona no encontrada)
  noResultsIndicator: 'No se han encontrado',
};

/**
 * Selectores de la tabla "Horarios y sucursales asignadas a la persona".
 */
const SHIFT_SELECTORS = {
  // Tabla / cuerpo de datos de horarios
  shiftsContainer: '#formHorariopersonas\\:dtHorariopersona_data',
  shiftRow: 'tr',
  // Índices 0-based de las celdas de cada fila:
  // 0: checkbox, 1: Sucursal, 2: Nombre, 3: Tipo horario,
  // 4: Hora inicio, 5: Hora final, 6: Tipo día,
  // 7: Fecha inicial, 8: Fecha final, 9: lápiz(editar), 10: basura(eliminar)
  shiftCells: {
    branch: 1,
    name: 2,
    shiftType: 3,
    startTime: 4,
    endTime: 5,
    dayType: 6,
    startDate: 7,
    endDate: 8,
  },
  // Diálogo de edición de horario (al hacer click en lápiz)
  editDialog: '#formEditarHorario',
  editEndDateField: '#formEditarHorario\\:popupButtonCal_input',
  editSaveButton: '#formEditarHorario\\:guardar',
  // Checkbox de selección "todos" de la tabla
  selectAllCheckbox: '#formHorariopersonas\\:dtHorariopersona_checkbox',
  // Input oculto de selección de la tabla
  selectionInput: '#formHorariopersonas\\:dtHorariopersona_selection',
  // Botón "Agregar" (abre el formulario de nuevo horario)
  newShiftButton: '#formHorariopersonas\\:btnAgregarHorario',
  // Botón "Eliminar" (borra los horarios seleccionados)
  deleteButton: '#formHorariopersonas\\:eliminarDetalleParametro',
  // Diálogo de confirmación de eliminación (varios registros)
  confirmDeleteDialog: '#formconfirmEliminarM',
  confirmDeleteYes: '#formconfirmEliminarM\\:btnEliminarVariosHorarios',
  // Diálogo de confirmación de eliminación (un solo registro)
  confirmDeleteOneDialog: '#formConfirmEliminar',
  confirmDeleteOneYes: '#formConfirmEliminar\\:btnEliminarUnHorario',
  // Diálogo de cierre de horarios anteriores (al crear nuevo horario)
  confirmClosePrevDialog: '#formConfirmCierreFechaFinal',
  confirmClosePrevYes: '#formConfirmCierreFechaFinal\\:j_idt239',
  // Checkbox de selección de fila
  rowCheckboxOp: 'input[type="checkbox"][name*="dtHorariopersona:"]',
  // Botón cerrar del diálogo "Personas" (si quedó abierto)
  personasDialogClose: '#frmdlgPersonas .ui-dialog-titlebar-close',
  // Paginación de la tabla de horarios
  nextPageButton: '#formHorariopersonas\\:dtHorariopersona_paginator .ui-paginator-next',
};

/**
 * Selectores del diálogo/formulario para CREAR un nuevo horario.
 */
const SHIFT_FORM_SELECTORS = {
  // Diálogo del nuevo horario
  dialog: '#formPopupNueva',
  // Campo sucursal (código). Al pulsar Enter resuelve el nombre (buscarPuntodeventa)
  branchField: '#formPopupNueva\\:txtSucursal',
  // Campo de solo-lectura que muestra el NOMBRE de la sucursal resuelto
  branchNameReadonly: '#formPopupNueva\\:txtSucursalNombre',
  // Select de Tipo horario (valores 1..7)
  shiftTypeField: '#formPopupNueva\\:smeTipoHorario_input',
  // Select de Tipo día (N=Normal, E=Extra)
  dayTypeField: '#formPopupNueva\\:smeTipodia_input',
  // Campo de Fecha inicio (autocompletado por el sistema, normalmente disabled)
  startDateField: '#formPopupNueva\\:popupButtonCalini_input',
  // Campo de Fecha final (se deja vacío para que el turno quede activo)
  endDateField: '#formPopupNueva\\:popupButtonCal_input',
  // Botón Guardar
  saveShiftButton: '#formPopupNueva\\:guardar2',
};

/**
 * Configuración del flujo de creación del nuevo horario.
 */
const SHIFT_CREATION = {
  // 'now' usa la fecha/hora actual
  startDateMode: 'now',
  // El nuevo horario se crea SIN fecha final (activo)
  endDateMode: 'empty',
  // Tipo día por defecto al crear el horario de un traslado
  defaultDayType: 'N',
  // Valor "Seleccionar"/vacío del select de tipo de horario
  shiftTypeEmptyValue: '-1',
};

module.exports = {
  TEXT,
  ROUTES,
  MODULE_SELECTORS,
  LOGIN_SELECTORS,
  SEARCH_SELECTORS,
  SHIFT_SELECTORS,
  SHIFT_FORM_SELECTORS,
  SHIFT_CREATION,
};
