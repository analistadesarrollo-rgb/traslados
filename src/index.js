'use strict';

const config = require('./config');
const logger = require('./logger');
const { migrate } = require('./database/migrations');
const repo = require('./database/repository');
const { startServer } = require('./app');
const whatsapp = require('./whatsapp/client');
const handlers = require('./whatsapp/handlers');
const { startWorker } = require('./queue/worker');

logger.bindRepo(repo);

const args = process.argv.slice(2);
const modes = {
  web: args.includes('--web'),
  whatsapp: args.includes('--whatsapp'),
  worker: args.includes('--worker'),
};

if (!modes.web && !modes.whatsapp && !modes.worker) {
  modes.web = true;
  modes.whatsapp = true;
  modes.worker = true;
}

let sender = null;
let waClient = null;

async function main() {
  logger.info('Iniciando Transfer Bot', { modes, env: config.env });

  const r = migrate();
  logger.info('Base de datos lista', { applied: r.applied });

  let server = null;
  if (modes.web) {
    server = await startServer();
  }

  if (modes.whatsapp) {
    const wa = await whatsapp.startWhatsApp({
      onMessage: (msg, client, state) => handlers.handleIncomingMessage(msg, client, state),
    });
    sender = wa.sender;
    waClient = wa.client;
    global.__waState = wa.state;

    whatsapp.onQr((dataUrl, term) => {
      console.log('\n\x1b[33mEscanea el QR de WhatsApp:\x1b[0m\n');
      console.log(term);
      console.log('\nEl QR también se puede ver en el panel admin.\n');
    });
  }

  let worker = null;
  if (modes.worker) {
    worker = startWorker({ sender });
    worker.start();
    global.__workerRunning = true;
  }

  logger.info('Transfer Bot arrancado correctamente');

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Deteniendo aplicación', { signal });
    if (worker) worker.stop();
    if (server) await new Promise((r) => server.close(r));
    if (waClient) {
      try {
        logger.info('Cerrando cliente de WhatsApp (sesión se guardará)');
        await waClient.destroy();
        logger.info('Cliente de WhatsApp cerrado correctamente');
      } catch (err) {
        logger.warn('Error al cerrar WhatsApp', { error: err.message });
      }
    }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal('Error fatal al arrancar', { error: err.message, stack: err.stack });
  process.exit(1);
});
