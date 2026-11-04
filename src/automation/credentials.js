'use strict';

/**
 * Construye la lista de contraseñas que se probarán en el login del sistema
 * web externo. La contraseña principal siempre va primero; después las de
 * respaldo, eliminando duplicados y valores vacíos.
 *
 * Esto permite tolerar la rotación automática de contraseña sin reconstruir
 * la aplicación.
 *
 * @param {string} primary Contraseña principal (WEB_SYSTEM_PASSWORD).
 * @param {string[]} fallbacks Contraseñas alternativas (WEB_SYSTEM_PASSWORDS).
 * @returns {string[]}
 */
function passwordCandidates(primary, fallbacks) {
  const list = [primary, ...(Array.isArray(fallbacks) ? fallbacks : [])];
  return [...new Set(list.filter((p) => typeof p === 'string' && p.length > 0))];
}

module.exports = { passwordCandidates };
