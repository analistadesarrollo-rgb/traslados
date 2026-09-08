'use strict';

// Script de aplicación de migraciones. Uso: npm run migrate

(async () => {
  try {
    const { migrate } = require('./migrations');
    const result = migrate();
    console.log(
      `[migrate] OK: ${result.applied} migración(es) aplicada(s) de ${result.total}.`
    );
  } catch (err) {
    console.error('[migrate] ERROR:', err.message);
    process.exit(1);
  }
})();
