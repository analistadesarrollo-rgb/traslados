'use strict';

/**
 * Jerarquía de errores específicos del dominio de traslados.
 * El worker los mapea a respuestas de WhatsApp claras.
 */

class TransferError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
    this.extra = extra;
  }
}

class DocumentNotFoundError extends TransferError {
  constructor(document) {
    super('DOCUMENT_NOT_FOUND', `No se encontró el colocador con documento ${document}.`, { document });
  }
}

class NoActiveShiftError extends TransferError {
  constructor(document) {
    super('NO_ACTIVE_SHIFT', 'El colocador no tiene un turno activo.', { document });
  }
}

class MultipleActiveShiftsError extends TransferError {
  constructor(document, count) {
    super('MULTIPLE_ACTIVE_SHIFTS', `El colocador tiene ${count} turnos activos.`, { document, count });
  }
}

class BranchNotFoundError extends TransferError {
  constructor(branch) {
    super('BRANCH_NOT_FOUND', `La sucursal ${branch} no existe.`, { branch });
  }
}

class CloseShiftError extends TransferError {
  constructor(message = 'No se pudo cerrar el turno activo.') {
    super('CLOSE_SHIFT_FAILED', message);
  }
}

class CreateShiftError extends TransferError {
  constructor(message = 'No se pudo crear el nuevo turno.') {
    super('CREATE_SHIFT_FAILED', message);
  }
}

class ConsistencyError extends TransferError {
  constructor(message) {
    super('CONSISTENCY', message);
  }
}

class AutomationNotConfiguredError extends TransferError {
  constructor(message) {
    super('AUTOMATION_NOT_CONFIGURED', message);
  }
}

class WebSystemUnreachableError extends TransferError {
  constructor(message = 'El sistema web no está accesible.') {
    super('WEB_UNREACHABLE', message);
  }
}

class LoginFailedError extends TransferError {
  constructor(message = 'No se pudo iniciar sesión en el sistema web (usuario o contraseña incorrectos).') {
    super('LOGIN_FAILED', message);
  }
}

class SessionExpiredError extends TransferError {
  constructor(message = 'La sesión del sistema web expiró.') {
    super('SESSION_EXPIRED', message);
  }
}

class NotInBranchError extends TransferError {
  constructor(document, branch) {
    super('NOT_IN_BRANCH', `El colocador ${document} no se encuentra activo en la sucursal ${branch}.`, { document, branch });
  }
}

module.exports = {
  TransferError,
  DocumentNotFoundError,
  NoActiveShiftError,
  MultipleActiveShiftsError,
  BranchNotFoundError,
  CloseShiftError,
  CreateShiftError,
  ConsistencyError,
  AutomationNotConfiguredError,
  WebSystemUnreachableError,
  LoginFailedError,
  SessionExpiredError,
  NotInBranchError,
};
