'use strict';

const transferService = require('../services/transferService');
const logger = require('../logger').child('whatsapp.handler');

/**
 * Manejador de mensajes entrantes de WhatsApp.
 *
 * - Ignora mensajes propios (echo) y de grupos (por defecto solo DM).
 * - Deriva un messageId único a partir del id nativo del mensaje
 *   (idempotencia: el mismo mensaje no se procesa dos veces).
 * - Delega en transferService.handleMessage.
 */

function sanitizePhone(phone) {
  // Remover espacios, guiones, '+', '@c.us'
  return String(phone || '').replace(/[^0-9]/g, '');
}

/**
 * Resuelve el número de teléfono real del remitente. WhatsApp multi-dispositivo
 * a veces identifica al chat con un "@lid" (id interno) en vez del número real;
 * el contacto expone siempre el número verdadero en `contact.number`.
 */
async function resolvePhoneNumber(msg) {
  try {
    const contact = await msg.getContact();
    if (contact && contact.number) return sanitizePhone(contact.number);
  } catch (_) {
    /* ignore, se usa el fallback */
  }
  return sanitizePhone(msg.from);
}

async function handleIncomingMessage(msg, waClient, state) {
  // Ignorar mensajes no de texto o propios
  if (msg.fromMe) return;
  if (!msg.body || typeof msg.body !== 'string') return;

  // Por defecto atiende solo conversaciones privadas (no grupos).
  // Si se requieren grupos se puede quitar.
  const isGroup = String(msg.from || '').includes('@g.us');
  if (isGroup) return;

  const messageId = buildMessageId(msg);
  const phoneNumber = await resolvePhoneNumber(msg);
  const chatId = msg.from;

  logger.info('Nuevo mensaje de WhatsApp', {
    messageId,
    from: msg.from,
    hasBody: !!msg.body,
  });

  // Respuesta inmediata
  const result = await transferService.handleMessage({
    messageId,
    phoneNumber,
    chatId,
    rawMessage: msg.body,
  });

  // Enviar la respuesta inmediata
  try {
    await waClient.sendMessage(chatId, result.text);
    logger.info('Respuesta inmediata enviada', { messageId, type: result.type });
  } catch (err) {
    logger.error('No se pudo enviar la respuesta inmediata', {
      messageId,
      error: err.message,
    });
  }
}

/**
 * Construye un identificador único del mensaje.
 * whatsapp-web.js expone msg.id como {id, remote, fromMe, ...}.
 * También usamos msg.idSerial si existe.
 */
function buildMessageId(msg) {
  if (msg.id && msg.id.id) {
    return String(msg.id.id);
  }
  if (msg.idSerial) {
    return String(msg.idSerial);
  }
  // fallback: hash de from + timestamp + cuerpo
  return `wa_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = { handleIncomingMessage, buildMessageId, sanitizePhone };
