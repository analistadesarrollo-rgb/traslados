# AGENTS.md

Bot de WhatsApp que automatiza los traslados de empleados (colocadores) entre sucursales en BusinessNET vía Puppeteer. Los comandos llegan como mensajes WhatsApp con formato `TRASLADO`, `DOCUMENTO` y `SUCURSAL` en líneas separadas.

## Comandos principales

```bash
npm install                 # instalar dependencias
npm run db:init             # inicializar schema SQLite (una vez)
npm start                   # arrancar todo (web + worker + whatsapp)
npm test                    # todos los tests (node --test)
npm run test:unit           # solo unitarios (sin browser)
npm run test:parser         # solo parser/validación
node --test tests/automation.integration.test.js  # e2e con Puppeteer + mock HTML
```

No hay build step. No TypeScript. No linter configurado.

## Requisitos de ejecución

- **Node ≥ 22.5** (usa `node:sqlite` nativo)
- **Chrome o Chromium** instalado (Puppeteer)
- Archivo `.env` con `WEB_SYSTEM_USER`, `WEB_SYSTEM_PASSWORD`, `ADMIN_PASSWORD` configurados
- `npm run db:init` antes del primer arranque

## Arquitectura (4 componentes, una entrada)

`src/index.js` ejecuta uno o más modos con flags (`--web`, `--worker`, `--whatsapp`):

1. **WhatsApp Client** (`whatsapp-web.js`, LocalAuth) → recibe comandos
2. **TransferService** → parsea, valida, encola (idempotente por `message_id`)
3. **Queue + Worker** → SQLite (`tabla job_queue`), lock atómico por documento, lease/expiry
4. **Automation** → Puppeteer contra el sistema web real (login, buscar, editar turno, verificar)

## Regla de negocio crítica

Verificación de turnos innegociable: **antes** de editar debe haber exactamente **1** turno activo; **después** de editar, se verifica que el turno activo tenga la sucursal destino correcta. Si la verificación falla, la transferencia se marca como `FAILED` con error `CONSISTENCY`. Nunca omitir esta verificación.

## Selectores web

Todos los selectores Puppeteer para el sistema web objetivo (BusinessNET / JSF + PrimeFaces) están centralizados en `src/config/selectors.js`. Verificar que coincidan con el estado actual del sistema antes de asumir que la automatización funcionará.

## Notas de testing

- Tests usan `node:test` (runner nativo), sin framework externo.
- Los tests e2e corren contra `tests/mock/web-system.html` (mock local), **no** contra el sistema web real. No necesitan credenciales.
- Si `node --test tests/` falla en Node 24, usar `npm test` (tiene el glob correcto).

## Docker

- Dockerfile usa `node:22-slim` + Chromium. `CHROME_PATH=/usr/bin/chromium`.
- `docker-compose.yml`: App + Nginx en red `red-gane-int` (externa).
- Volumes: `data/` (sesión WhatsApp + SQLite), `logs/`, `screenshots/`.
- Timezone: `America/Bogota`.

## CI/CD

Jenkins pipeline (`Jenkinsfile`): copia `.env` desde credenciales Jenkins, ejecuta `docker compose up -d --build`, verifica health con curl dentro del contenedor.

## Errores comunes

- `AUTOMATION_NOT_CONFIGURED` → selectores faltantes en `src/config/selectors.js` o `WEB_SYSTEM_*` faltante en `.env`
- `LOGIN_FAILED` → el login prueba `WEB_SYSTEM_PASSWORD` y luego las alternativas de `WEB_SYSTEM_PASSWORDS` (por defecto las contraseñas de rotación conocidas). Las contraseñas nunca se escriben en los logs.
- QR necesario solo en la primera conexión de WhatsApp (se persiste en `data/wa-session`)
- `ALLOWED_PHONE_NUMBERS` vacío = todos los números permitidos
- `WORKER_CONCURRENCY` debe mantenerse en 1 (supuesto de lock por documento)

## Autenticación del panel admin

- Login con cookie firmada HMAC-SHA256 (HttpOnly, SameSite=Strict, 24h). El token incluye usuario/rol y se revalida contra la BD en cada request.
- Administrador principal desde `.env`: `ADMIN_USER` / `ADMIN_PASSWORD` (no vive en la tabla `users`, no se puede deshabilitar).
- Usuarios adicionales en la tabla `users`, con roles `admin` y `scheduler`. Contraseñas con `scrypt` + salt (`node:crypto`), nunca en texto plano.
- `/api/health` no requiere autenticación. El resto de `/api/*` acepta cookie o Basic Auth.

## Usuarios y programación de traslados

- Migración v3 crea `users`, `schedules` y `schedule_audit`, y agrega `origin`, `created_by_username` y `schedule_id` a `transfer_requests`.
- El rol `scheduler` solo ve/gestiona sus propias programaciones; `admin` ve todas. La UI oculta funciones administrativas a `scheduler` y la API responde 403.
- `scheduled_at_utc` guarda el instante absoluto calculado desde hora de Bogotá (UTC-5). La validación rechaza fechas/horas pasadas.
- El planificador (`src/scheduler/index.js`) corre en el proceso worker: despacha `SCHEDULED -> QUEUED` de forma atómica e idempotente (transacción + `message_id = sched:<id>` + índice único parcial) y sincroniza el estado con `transfer_requests`.
- Los traslados programados reutilizan la cola/worker/automatización existentes. El job lleva `notify:false` para no intentar enviar WhatsApp.
- Si el servidor estuvo apagado, la programación vencida se despacha al arrancar y se marca `late=1` (visible en la UI).
- Los formularios de fecha/hora usan un selector propio (`public/picker.js` + `public/picker.css`): calendario mensual y columnas de hora/minuto en zona Bogotá, sin dependencias externas.
- Variables: `SCHEDULER_ENABLED`, `SCHEDULER_POLL_INTERVAL_MS`, `SCHEDULER_BATCH_SIZE`, `SCHEDULER_LATE_THRESHOLD_MS`, `APP_TIMEZONE`.

## Inconsistencias conocidas (documentación vs código)

- `src/config/selectors.js` describe el traslado como "eliminar horario origen + agregar horario destino", pero `src/automation/index.js` usa `shifts.closeCurrentShift()` (edita la sucursal del turno activo). `addNewShift()` existe pero el orquestador no lo usa.
- `.env.example` tenía `WORKER_CONcurrency` (corregido a `WORKER_CONCURRENCY`).

## Comando de despliegue

```bash
docker compose up -d --build
```
