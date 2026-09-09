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
 * Resuelve el número de teléfono real del remitente.
 *
 * WhatsApp multi-dispositivo a veces identifica al chat con un "@lid" (id
 * interno) en vez del número real. Esta función intenta múltiples fuentes:
 *  1. contact.pushName + contact.number si parece número real (>=8 dígitos)
 *  2. msg.from si tiene formato number@c.us (no @lid)
 *  3. Fallback: cualquier cosa que tenga >=8 dígitos
 */
async function resolvePhoneNumber(msg) {
  try {
    const contact = await msg.getContact();
    if (contact) {
      // contact.number puede ser un LID (@lid) o el número real
      const num = sanitizePhone(contact.number);
      if (num.length >= 8 && !String(contact.number || '').includes('@lid')) {
        return num;
      }
      // Si number es un LID, intentar extraer del id del contacto
      if (contact.id && contact.id._serialized) {
        const fromId = sanitizePhone(contact.id._serialized);
        if (fromId.length >= 8 && !String(contact.id._serialized || '').includes('@lid')) {
          return fromId;
        }
      }
    }
  } catch (_) {
    /* ignore */
  }

  // Fallback: msg.from
  const from = sanitizePhone(msg.from);
  if (from.length >= 8 && !String(msg.from || '').includes('@lid')) {
    return from;
  }

  // Último recurso: devolver lo que sea que tengamos (LID incluido)
  // para que al menos quede registrado en logs y BD
  const fallback = sanitizePhone(msg.from || '');
  logger.warn('No se pudo resolver número real del remitente, usando fallback', {
    from: msg.from,
    fallback,
    isLid: String(msg.from || '').includes('@lid'),
  });
  return fallback;
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

  // Log detallado para diagnosticar resolución de número
  try {
    const contact = await msg.getContact();
    logger.info('Contacto resuelto', {
      messageId,
      phoneNumber,
      chatId,
      contactNumber: contact ? contact.number : null,
      contactId: contact && contact.id ? contact.id._serialized : null,
      pushName: contact ? contact.pushName : null,
      isLid: String(phoneNumber).includes('@lid') || String(chatId).includes('@lid'),
    });
  } catch (_) {
    logger.info('Datos de mensaje', { messageId, phoneNumber, chatId });
  }

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
