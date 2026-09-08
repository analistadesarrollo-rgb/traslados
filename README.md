# WhatsApp Transfer Bot

Sistema de automatización de **traslados de colocadores entre sucursales** mediante comandos enviados por **WhatsApp**.

Cuando un usuario envía un mensaje como:

```
TRASLADO 1234567890 SUCURSAL SUR
```

el bot:
1. Parsea y valida el comando.
2. Registra la solicitud de forma idempotente (evita duplicados por `message_id`).
3. Encola el trabajo con bloqueo por documento (impide traslados concurrentes del mismo colocador).
4. Abre una sesión automatizada (Puppeteer/Chrome) contra el **sistema web real** de horarios/personas.
5. Cierra el **turno activo** actual, verifica que quedó cerrado (0 turnos activos).
6. Crea un **nuevo turno** en la sucursal destino, verifica que quedó exactamente 1 turno activo.
7. Persiste una auditoría completa y **responde al usuario por WhatsApp** con el resultado.

---

## Índice
- [Arquitectura](#arquitectura)
- [Requisitos](#requisitos)
- [Instalación](#instalación)
- [Configuración](#configuración)
  - [El archivo `.env`](#el-archivo-env)
  - [Selectores del sistema web (IMPORTANTE)](#selectores-del-sistema-web-importante)
- [Cómo ejecutar](#cómo-ejecutar)
  - [Modos de ejecución](#modos-de-ejecución)
  - [Primer inicio y escaneo del QR de WhatsApp](#primer-inicio-y-escaneo-del-qr-de-whatsapp)
- [Comandos de WhatsApp](#comandos-de-whatsapp)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Base de datos](#base-de-datos)
- [Panel administrativo](#panel-administrativo)
- [Pruebas](#pruebas)
- [Docker](#docker)
- [Solución de problemas](#solución-de-problemas)

---

## Arquitectura

```
                    ┌──────────────────────────────────────┐
 WhatsApp  ──────►  │  WhatsApp Client (whatsapp-web.js)   │
 (user)             │  LocalAuth, reconexión automática, QR│
   ▲                └──────────────────┬───────────────────┘
   │                                   │ mensaje entrante
   │                                   ▼
   │                ┌──────────────────────────────────────┐
   │                │  Transfer Service                    │
   │                │  - parsea y valida comando           │
   │                │  - idempotencia por message_id       │
   │                └──────────────────┬───────────────────┘
   │                                   │
   │                                   ▼
   │                ┌──────────────────────────────────────┐
   │                │  Queue (DB job_queue)                │
   │                │  - cola persistente en SQLite        │
   │                │  - bloqueo por documento             │
   │                │  - lease/expiración y reclamación    │
   │                └──────────────────┬───────────────────┘
   │                                   ▼
   │                ┌──────────────────────────────────────┐
   │                │  Worker                              │
   │                └──────────────────┬───────────────────┘
   │                                   ▼
   │                ┌──────────────────────────────────────┐
   │                │  Automation (Puppeteer)              │
   │                │  - Login al sistema web              │
   │                │  - buscar colocador por documento    │
   │                │  - cerrar turno activo               │
   │                │  - crear turno en sucursal destino   │
   │                └──────────────────┬───────────────────┘
   │                                   │ resultado
   └───────────────────────────────────┘  respuesta al usuario
```

- **WhatsApp:** `whatsapp-web.js` con `LocalAuth` (sesión persistente en `data/wa-session`). El QR solo se necesita en el **primer** escaneo.
- **Navegador:** Puppeteer usando **Chrome del sistema** (web real) o **Chromium** (contenedor Docker).
- **Cola:** respaldada en SQLite (tabla `job_queue`) para supervivencia ante reinicios. Sin dependencias externas (Redis/BullMQ).
- **Persistencia:** `node:sqlite` (módulo incluido en Node ≥ 22.5). La capa de repositorio aísla el SQL para permitir migrar a MySQL/PostgreSQL posteriormente.
- **Regla crítica:** antes de crear un turno nuevo debe haber **exactamente 0** turnos activos; después, **exactamente 1**. Si no se verifica el cierre, **no** se crea el nuevo y se genera un error de consistencia.

---

## Requisitos

- **Node.js ≥ 22.5** (por el módulo nativo `node:sqlite`).
- **Google Chrome o Chromium** instalado (para la automatización del sistema web).
- Una cuenta de **WhatsApp** para el bot (se recomienda un número dedicado).
- Acceso de red al **sistema web interno** (`WEB_SYSTEM_URL`).
- Para ejecución local en Windows: la ruta a Chrome.
- (Opcional) **Docker** para desplegar en contenedor.

---

## Instalación

```bash
# 1. Clonar / copiar el proyecto y entrar
cd "automatizacion de traslados"

# 2. Instalar dependencias
npm install

# 3. Crear el archivo de entorno
copy .env.example .env        # Windows
# cp .env.example .env        # Linux/macOS

# 4. Editar .env (ver sección Configuración)

# 5. Inicializar la base de datos (crea las tablas)
npm run db:init

# 6. Arrancar
npm start
```

---

## Configuración

### El archivo `.env`

| Variable | Descripción |
|---|---|
| `PORT` | Puerto del panel admin (por defecto `3000`). |
| `WEB_SYSTEM_URL` | URL real del sistema web a automatizar (login + sección de turnos). |
| `WEB_SYSTEM_USER` | Usuario del sistema web. |
| `WEB_SYSTEM_PASSWORD` | Contraseña del sistema web. |
| `DB_FILE` | Ruta del archivo SQLite (por defecto `./data/transfer-bot.sqlite`). |
| `WA_SESSION_DIR` | Carpeta de sesión persistente de WhatsApp. |
| `WA_QR_TIMEOUT_MS` | Tiempo (ms) de espera para escanear el QR. |
| `ALLOWED_PHONE_NUMBERS` | Números autorizados (coma separada). Vacío = todos. |
| `AUTOMATION_HEADLESS` | `true`/`false` → modo headless del navegador de automatización. |
| `CHROME_PATH` | Ruta al ejecutable de Chrome. Vacío usa la detectada. |
| `WORKER_CONCURRENCY` | Workers en paralelo (máx. 1 por documento). |
| `JOB_LEASE_MS` | Lease máximo de un job en `PROCESSING`. |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Credenciales básicas del panel admin. |
| `LOG_LEVEL` / `LOG_DIR` | Nivel y carpeta de logs. |

> ⚠️ **`WEB_SYSTEM_USER`, `WEB_SYSTEM_PASSWORD` y `ADMIN_PASSWORD` deben rellenarse en `.env`** (nunca en código ni en `.env.example`).

### Selectores del sistema web (IMPORTANTE)

La automatización **no inventa selectores**. Todas las rutas, campos y elementos del sistema web real están centralizados en:

```
src/config/selectors.js
```

Con valores `{{ TBD }}` (pendientes). Para que el bot funcione contra el sistema real, debes rellenarlos con los **selectores reales**, basándote en capturas/HTML del sistema:

- `TEXT` → indicadores de sesión activa / error de login / título de sección.
- `LOGIN_SELECTORS` → campos de usuario, contraseña y botón de login.
- `SEARCH_SELECTORS` → campo de búsqueda por documento y contenedor de resultados.
- `SHIFT_SELECTORS` → tabla de turnos, fila, columna de cada dato (documento, sucursal, fecha inicio, fecha fin, estado), botones de nuevo turno / cerrar, y (si aplica) el diálogo de confirmación.
- `SHIFT_FORM_SELECTORS` → formulario para crear el nuevo turno (documento, sucursal, fechas, botón guardar).
- `ROUTES` → URLs específicas (login, sección de turnos) dentro del sistema.

Si falta algún selector, el sistema responde `AUTOMATION_NOT_CONFIGURED` indicando **exactamente cuáles** hacen falta. Esto permite que el bot corra (y sus pruebas despierten) aun sin datos reales.

> **Cómo obtenerlos:** entra al sistema real en tu navegador, abre **DevTools → Elements**, inspecciona los campos y copia sus selectores (id, name, clase). Si tienes dudas, proporciona capturas/HTML del sistema y los completamos.

---

## Cómo ejecutar

### Modos de ejecución

```bash
npm start            # todo: web + worker + whatsapp
npm run worker       # solo worker (procesa la cola)
npm run web          # solo panel admin + API
npm run whatsapp     # solo cliente de WhatsApp
```

O de forma selectiva con flags:

```bash
node src/index.js --web --worker
node src/index.js --worker --whatsapp
```

### Primer inicio y escaneo del QR de WhatsApp

En el primer arranque (o si se borra `data/wa-session`), WhatsApp genera un **código QR**.

- Si hay un terminal con capacidad de imágenes, se imprime una versión ASCII y se muestra la URL como **data URL** (pégala en tu navegador para escanearla con el móvil).
- También puedes ejecutar el script dedicado de QR:

  ```bash
  npm run qr
  ```

- En **WhatsApp → Dispositivos vinculados → Vincular dispositivo** escanea el QR con el teléfono del bot.

---

## Comandos de WhatsApp

Formato general:

```
TRASLADO <DOCUMENTO> <SUCURSAL>
```

- `<DOCUMENTO>`: 6 a 12 dígitos.
- `<SUCURSAL>`: texto después del documento (se normaliza a mayúsculas), p. ej. `SUCURSAL SUR`, `SUR`.

Ejemplo:

```
TRASLADO 1234567890 SUCURSAL SUR
```

Respuestas posibles al usuario:

| Respuesta | Significado |
|---|---|
| `✅ Traslado completado...` | El turno se cerró y se creó el nuevo en la sucursal destino. |
| `❌ Formato incorrecto...` | El mensaje no cumple `TRASLADO <DOC> <SUCURSAL>`. |
| `❌ Documento inválido...` | El documento no es numérico de 6–12 dígitos. |
| `❌ Sucursal vacía...` | Falta la sucursal destino. |
| `❌ El documento no se encontró...` | No existe en el sistema web. |
| `❌ No tiene un turno activo...` | No hay turno activo para cerrar. |
| `❌ Hay varios turnos activos...` | Inconsistencia → requiere revisión manual. |
| `❌ No se pudo cerrar...` | El cierre no pudo verificarse; no se creó turno nuevo (regla crítica). |
| `❌ No se pudo crear...` | La creación no pudo verificarse; requiere revisión manual. |
| `❌ No configurado...` | `AUTOMATION_NOT_CONFIGURED` → faltan selectores/credenciales. |

> El bot responde **en el mismo chat** desde el que se envió el mensaje.

---

## Estructura del proyecto

```
src/
├── index.js                 # punto de entrada (modos web/worker/whatsapp)
├── app.js                   # app Express + startServer
├── config/
│   ├── index.js             # configuración desde variables de entorno
│   └── selectors.js         # selectores del sistema web (a completar)
├── database/
│   ├── index.js             # conexión node:sqlite
│   ├── migrations.js        # esquema (tablas)
│   ├── migrate.js           # runner de migraciones
│   └── repository.js        # capa de acceso a datos
├── services/
│   ├── validation.js        # parseo/validación de comandos
│   └── transferService.js   # orquestación + idempotencia
├── queue/
│   ├── index.js             # helpers de cola
│   └── worker.js            # bucle de worker
├── automation/
│   ├── browser.js           # Puppeteer (persistente)
│   ├── session.js           # login/sesión
│   ├── shifts.js            # buscar/cerrar/crear/verificar turnos
│   ├── errors.js            # jerarquía de errores de transferencia
│   └── index.js             # executeTransfer (orquestador)
├── whatsapp/
│   ├── client.js            # cliente whatsapp-web.js
│   └── handlers.js          # enrutado de mensajes entrantes
├── routes/api.js            # endpoints REST
├── controllers/             # dashboard
├── views/
│   └── index.js             # panel admin (HTML embebido)
└── logger/index.js          # logger JSON (consola + archivo + BD)

tests/
├── mock/web-system.html     # sistema web "falso" para pruebas e2e
└── *.test.js                # pruebas unitarias y de integración
```

---

## Base de datos

- **SQLite** por defecto (módulo nativo `node:sqlite`), sin dependencias instalables.
- La capa `src/database/repository.js` aísla todo el SQL → se puede migrar a MySQL/MariaDB cambiando solo esa capa y añadiendo el driver.

Tablas:

- `schema_migrations` – control de versiones del esquema.
- `transfer_requests` – solicitudes (documento, sucursal, estado, errores, respuesta enviada).
- `job_queue` – cola persistente de trabajo (pénding → processing → done/failed), con lease y reclamación + **bloqueo por documento**.
- `activity_logs` – auditoría (eventos de automatización, whatsapp, cola).

La **idempotencia** se garantiza por `message_id` de WhatsApp: si llega un comando repetido, no se re-procesa y se responde con el estado anterior.

---

## Panel administrativo

Con Docker, Nginx queda disponible en la red Docker externa `red-gane-int`, para que el proxy compartido del servidor lo publique. Configura el proxy público hacia `transfer-bot-nginx:80`. Sin Docker, usa `http://localhost:3000/`.

- Resumen del estado de la cola y conteos por estado.
- Historial de traslados (navegable por estado/sucursal).
- Detalle de una solicitud con logs de auditoría.
- Endpoint de salud: `GET /api/health`.

---

## Pruebas

Usa el runner integrado de Node (`node:test`).

```bash
npm test                 # todas las pruebas
npm run test:unit        # pruebas unitarias (sin navegador)
npm run test:parser      # parser/validación

# Solo la integración con el navegador contra el mock:
node --test tests/automation.integration.test.js
```

Las pruebas incluyen:

- **Parser/validación**: formatos correctos e incorrectos, documento/sucursal.
- **Idempotencia**: ¿qué ocurre si llega el mismo `message_id` dos veces?
- **Lógica de turnos**: detección de activo, cierre, verificación.
- **Cola/worker**: encolado, bloqueo por documento, lease/expiración.
- **Integración e2e con Puppeteer** contra `tests/mock/web-system.html` (un "sistema web" simulado localmente) que ejecuta el flujo real: login → búsqueda → cerrar turno → verificar → crear turno → verificar.
  - Escenarios: éxito, sin turno activo, múltiples turnos activos, documento inexistente.

> Las pruebas e2e **no** requieren el sistema web real ni credenciales; usan el mock local y Chrome/Chromium únicamente.

---

## Docker

Existe `Dockerfile` y `docker-compose.yml`.

```bash
cp .env.example .env      # y rellena credenciales
docker compose up -d --build
```

Notas:

- Se usa `network_mode: host` para que el contenedor alcance el **sistema web interno** (`192.168.60.66:8090`). Si tu red Docker no alcanza esa IP en modo bridge, es la opción más simple en Linux.
- El contenedor instala `chromium` y define `CHROME_PATH=/usr/bin/chromium`.
- Volúmenes para `data/` (sesión de WhatsApp + SQLite), `logs/` y `screenshots/`.

---

## Solución de problemas

- **`AUTOMATION_NOT_CONFIGURED`**: faltan selectores reales en `src/config/selectors.js` o credenciales `WEB_SYSTEM_*` en `.env`. Completa los selectores con las capturas reales.
- **El QR no aparece / sesión perdida**: borra `data/wa-session` y reinicia, luego escanea de nuevo.
- **Chrome no inicia**: revisa `CHROME_PATH`; en Docker se usa `/usr/bin/chromium`.
- **"El sistema web no está accesible"**: verifica la URL y que el bot tenga red hacia `192.168.*`.
- **`node --test tests/` falla en Node 24**: usa el script `npm test` (ya usa el patrón glob correcto).
- **Dos turnos activos**: el bot **no** crea uno nuevo si el anterior no se cerró (regla crítica de consistencia). Revisa manualmente en el sistema web.

---

## Seguridad

- Las credenciales **solo** viven en `.env` (que está en `.gitignore`).
- El panel admin se puede proteger con Basic Auth (`ADMIN_USER` / `ADMIN_PASSWORD`).
- Se puede restringir quién usa el bot con `ALLOWED_PHONE_NUMBERS`.
- Nunca registres contraseñas en los logs ni en pantalla.
