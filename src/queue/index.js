'use strict';

const repo = require('../database/repository');
const config = require('../config');
const logger = require('../logger').child('queue');

/**
 * Cola de trabajos respaldada por base de datos.
 *
 * No se requiere un broker externo (Redis/RabbitMQ) para el alcance y la
 * infraestructura objetivo (un único nodo en la red local). Esto simplifica
 * el despliegue y evita un punto de fallo adicional, manteniendo:
 *   - Persistencia (los trabajos viven en SQLite, sobreviven reinicios).
 *   - Idempotencia (un job por request_id).
 *   - Lock atómico por documento (nunca dos traslados simultáneos del mismo
 *     colocador).
 *   - Reasignación de jobs huérfanos tras caducidad del lease.
 *
 * Si en el futuro se necesita escalar horizontalmente (varios nodos worker),
 * se puede reemplazar la capa claimNextJob por Redis + BullMQ sin cambiar
 * la interfaz de enqueueJob aquí definida. Ver README.
 */

/**
 * Encola un trabajo. Devuelve {id, duplicated}.
 */
function enqueue(document, requestId, payload, priority = 0) {
  return repo.enqueueJob({ request_id: requestId, document, payload, priority });
}

/**
 * Post-condición de idempotencia: si ya existe un trabajo ACTIVO
 * (PENDING o PROCESSING) para el documento, no debería encolarse otro
 * traslado para el mismo documento hasta que termine.
 * Devuelve true si ya hay un job activo para el documento.
 */
function hasActiveJobForDocument(document) {
  try {
    const db = require('../database').getDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM job_queue
          WHERE document = ? AND status IN ('PENDING','PROCESSING')`
      )
      .get(document);
    return row ? row.c > 0 : false;
  } catch (_) {
    return false;
  }
}

module.exports = { enqueue, hasActiveJobForDocument };
