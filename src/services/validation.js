'use strict';

/**
 * Parseo y validación de comandos de WhatsApp.
 *
 * Comando soportado:
 *   TRASLADO DOCUMENTO SUCURSAL
 *
 * Ejemplos:
 *   TRASLADO 1234567890 SUR
 *   TRASLADO 1234567890 SUCURSAL SUR
 *   traslado 1234567890 sucursal norte   (case-insensitive)
 *
 * El documento es el primer token que es totalmente numérico.
 * La sucursal son los tokens restantes unidos por espacios.
 */

const COMMAND_TRANSFER = 'TRASLADO';

const DOCUMENT_RE = /^\d{6,12}$/; // entre 6 y 12 dígitos (configurable)

/**
 * Normaliza un mensaje: quita espacios extra, acentos opcionales y
 * deja tokens en mayúsculas para el comando.
 * @param {string} raw
 * @returns {string}
 */
function normalizeCommand(raw) {
  return String(raw || '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Parsea un mensaje de texto en un comando.
 * Formato multi-línea con etiquetas:
 *   Traslado
 *   Documento: 38668841
 *   Sucursal: 39653
 *
 * @param {string} raw
 * @returns {{ok:boolean, error?:string, command?:string, document?:string, branch?:string}}
 */
function parseCommand(raw) {
  const norm = normalizeCommand(raw);
  if (!norm) {
    return { ok: false, error: 'Mensaje vacío' };
  }

  const upper = norm.toUpperCase();
  if (!upper.includes(COMMAND_TRANSFER)) {
    return { ok: false, error: 'Comando desconocido' };
  }

  // Formato multi-línea con etiquetas
  const docMatch = norm.match(/Documento:\s*(\d{6,12})/i);
  const sucMatch = norm.match(/Sucursal:\s*(\d+)/i);

  if (docMatch && sucMatch) {
    const document = docMatch[1];
    const branch = sucMatch[1];
    return { ok: true, command: COMMAND_TRANSFER, document, branch };
  }

  if (/Documento:/i.test(norm) || /Sucursal:/i.test(norm)) {
    return { ok: false, error: 'Formato inválido' };
  }

  if (upper === COMMAND_TRANSFER || upper === COMMAND_TRANSFER + ' ') {
    return { ok: false, error: 'Formato incorrecto' };
  }

  // Formato una sola línea (legacy): TRASLADO DOC SUCURSAL
  const tokens = norm.split(' ');
  const docIndex = tokens.findIndex((t) => DOCUMENT_RE.test(t));
  if (docIndex === -1) {
    return { ok: false, error: 'Documento inválido' };
  }

  const document = tokens[docIndex];
  const branchTokens = tokens.slice(docIndex + 1);
  if (branchTokens.length === 0) {
    return { ok: false, error: 'Sucursal vacía' };
  }

  const branch = branchTokens.join(' ').trim().toUpperCase();
  return { ok: true, command: COMMAND_TRANSFER, document, branch };
}

/**
 * Valida que un documento tenga formato correcto.
 * @param {string} doc
 * @returns {{ok:boolean, error?:string}}
 */
function validateDocument(doc) {
  if (doc === undefined || doc === null || String(doc).trim() === '') {
    return { ok: false, error: 'Documento vacío' };
  }
  if (!DOCUMENT_RE.test(String(doc))) {
    return { ok: false, error: 'Documento inválido' };
  }
  return { ok: true };
}

/**
 * Valida que una sucursal no esté vacía.
 * @param {string} branch
 * @returns {{ok:boolean, error?:string}}
 */
function validateBranch(branch) {
  if (branch === undefined || branch === null || String(branch).trim() === '') {
    return { ok: false, error: 'Sucursal vacía' };
  }
  return { ok: true };
}

module.exports = {
  COMMAND_TRANSFER,
  DOCUMENT_RE,
  parseCommand,
  validateDocument,
  validateBranch,
  normalizeCommand,
};
