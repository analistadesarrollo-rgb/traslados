# Transfer Bot - Flujo Operativo y Componentes del Sistema

## Resumen

Bot de WhatsApp que automatiza los traslados de empleados (colocadores) entre sucursales en BusinessNET. Los mensajes llegan por WhatsApp, se parsean, se validan, y se ejecutan automáticamente via Puppeteer contra el sistema web real.

---

## Arquitectura (4 componentes, una sola entrada)

`src/index.js` ejecuta todos los componentes con flags (`--web`, `--worker`, `--whatsapp`):

```
┌─────────────────────────────────────────────────────────────┐
│                    UN SOLO PROCESO NODE.JS                  │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  WhatsApp     │  │  Express Web │  │  Queue Worker    │  │
│  │  Client       │  │  Server      │  │  (1 hilo)        │  │
│  │              │  │  :3000       │  │                  │  │
│  │  whatsapp-   │  │  Panel Admin │  │  SQLite polling  │  │
│  │  web.js      │  │  API REST    │  │  Lock por doc.   │  │
│  └──────┬───────┘  └──────────────┘  └────────┬─────────┘  │
│         │                                      │            │
│         ▼                                      ▼            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           Transfer Service + Validation             │   │
│  │     (parseo, validación, idempotencia, encolado)    │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              SQLite (node:sqlite nativo)            │   │
│  │   transfer_requests | job_queue | activity_logs     │   │
│  │   allowed_numbers                                    │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ┌─────────────────────────────────────────────────────┐   │
│  │         Puppeteer Automation (Chromium)             │   │
│  │   Login → Menú → Buscar → Editar turno → Verificar │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Flujo Completo: Mensaje WhatsApp → Traslado Completado

### 1. Recepción del mensaje
- **WhatsApp Client** (`whatsapp-web.js` + LocalAuth) recibe el mensaje
- **Handler** (`handlers.js`) filtra: ignora mensajes propios, grupos, no-texto
- Resuelve número real (maneja IDs `@lid` de multi-device)
- Construye `message_id` único para idempotencia

### 2. Parseo y validación
- **Transfer Service** verifica idempotencia (mensaje ya procesado?)
- **Validation** parsea el comando:
  - Formato preferido: `Traslado\nDocumento: 38668841\nSucursal: 39653`
  - Formato legacy: `TRASLADO 1234567890 SUR`
- Valida: documento (6-12 dígitos), sucursal (no vacía)
- Verifica autorización del número en `allowed_numbers`

### 3. Encolado
- Crea registro en `transfer_requests` (estado: PENDING)
- Encola job en `job_queue` (idempotente por `request_id`)
- Responde inmediatamente por WhatsApp: "Procesando traslado..."

### 4. Procesamiento (Worker)
- Worker hace polling cada 2 segundos
- `claimNextJob()` usa **lock atómico por documento** (solo 1 job por documento a la vez)
- Actualiza estado a PROCESSING
- Llama a `executeTransfer()`

### 5. Automatización Puppeteer
1. **Login**: Navega al sistema web → detecta Cerberus → ingresa credenciales
2. **Módulo**: Ingresa a APUESTAS → espera redirect a BusinessNET (puerto 8090)
3. **Menú**: Navega a horariopersonas.xhtml
4. **Buscar persona**: Escribe documento → Enter → espera resultados
5. **Filtrar turnos activos**: Busca columna "Fecha Final" → escribe "null"
6. **Verificar**: Debe haber exactamente 1 turno activo
7. **Editar**: Click en lápiz → doble click en sucursal → escribe código → Enter
8. **Guardar**: Click Guardar → cierra modal con X
9. **Verificar transferencia**: Recarga página → re-busca persona → compara sucursal

### 6. Respuesta
- **Éxito**: WhatsApp: `✅ Traslado realizado correctamente\n\nColocador: XXX\nSucursal nueva: XXX\nFecha y Hora: XXX`
- **Error**: WhatsApp con mensaje específico (NO_ACTIVE_SHIFT, DOCUMENT_NOT_FOUND, etc.)
- Evidence screenshots guardados en `screenshots/` en caso de error

---

## Archivos Principales

### Entrada y Configuración
| Archivo | Función |
|---------|---------|
| `src/index.js` | Punto de entrada. Parsea flags, inicia DB, arranca componentes |
| `src/config/index.js` | Configuración desde `.env` |
| `src/config/selectors.js` | Selectores CSS/XPath del sistema web (BusinessNET) |
| `.env.example` | Template de variables de entorno |

### WhatsApp
| Archivo | Función |
|---------|---------|
| `src/whatsapp/client.js` | Cliente WhatsApp (whatsapp-web.js, LocalAuth, reconexión) |
| `src/whatsapp/handlers.js` | Manejo de mensajes entrantes, resolución de números |

### Lógica de Negocio
| Archivo | Función |
|---------|---------|
| `src/services/transferService.js` | Servicio central: parseo, validación, idempotencia, encolado |
| `src/services/validation.js` | Parser de comandos multi-línea y legacy |

### Base de Datos
| Archivo | Función |
|---------|---------|
| `src/database/index.js` | Conexión SQLite (node:sqlite nativo, WAL mode) |
| `src/database/migrations.js` | Schema versioning (tablas + índices) |
| `src/database/repository.js` | Capa de acceso a datos (todas las queries SQL) |

### Cola y Worker
| Archivo | Función |
|---------|---------|
| `src/queue/worker.js` | Loop de procesamiento, lock por documento, ejecución |

### Automatización (Puppeteer)
| Archivo | Función |
|---------|---------|
| `src/automation/index.js` | Orquestador principal de automatización |
| `src/automation/browser.js` | Gestión de Chromium (instancia persistente, screenshots) |
| `src/automation/session.js` | Login al sistema web, navegación de menú |
| `src/automation/shifts.js` | Operaciones de turnos (buscar, filtrar, editar, verificar) |
| `src/automation/errors.js` | Jerarquía de errores tipados |

### Panel Administrativo
| Archivo | Función |
|---------|---------|
| `src/app.js` | Express app con auth por cookies HMAC |
| `src/routes/api.js` | Rutas API REST (dashboard, history, qr, numbers) |
| `src/controllers/dashboardController.js` | Handlers de la API |
| `src/views/index.js` | Renderizado HTML server-side (dark theme) |

### Logger
| Archivo | Función |
|---------|---------|
| `src/logger/index.js` | Logger JSON estructurado (consola + archivo diario + SQLite) |

---

## Selectores del Sistema Web (BusinessNET)

### Login (Cerberus - Puerto 8100)
- Usuario: `#frmLogin\:user`
- Contraseña: `#frmLogin\:password`
- Submit: `#frmLogin\:send`

### Navegación
- Módulo APUESTAS: `#frmInicio\:grid\:0\:j_idt41`
- Página de turnos: `horariopersonas.xhtml`

### Búsqueda de Persona
- Input documento: `#formHorariopersonas\:txtPrsDocumento`
- Resultados: `#frmdlgPersonas\:dtbPersonas_data`

### Tabla de Turnos
- Container: `#formHorariopersonas\:dtHorariopersona_data`
- Columnas: checkbox(0), sucursal(1), nombre(2), tipo(3), horaInicio(4), horaFin(5), tipoDia(6), fechaInicio(7), fechaFinal(8)

### Formulario Nuevo Turno
- Campo sucursal: `#formPopupNueva\:txtSucursal`
- Nombre sucursal (readonly): `#formPopupNueva\:txtSucursalNombre`
- Guardar: `#formPopupNueva\:guardar2`

---

## Reglas de Negocio Críticas

### Formato del Comando
- Comando: `TRASLADO` (case-insensitive)
- Documento: 6-12 dígitos numéricos
- Sucursal: string no vacío (generalmente código numérico)

### Autorización
- Solo números en `allowed_numbers` pueden solicitar traslados
- Matching por últimos 10 dígitos (`573001234567` = `3001234567`)
- **Tabla vacía = todos los números permitidos** (modo permisivo)

### Idempotencia
- Cada mensaje tiene `message_id` único
- UNIQUE index en `transfer_requests.message_id`
- Mensaje duplicado → respuesta "ya recibido/procesando" sin re-encolar

### Lock por Documento (CRÍTICO)
- `claimNextJob()` usa transacción atómica
- Solo un job por documento se ejecuta a la vez
- Si el worker muere, el lease expira (5 min) y se reasigna

### Verificación de Turno (INNEGOCIABLE)
- **Antes**: exactamente 1 turno activo (0 = NO_ACTIVE_SHIFT, >1 = MULTIPLE_ACTIVE_SHIFTS)
- **Después**: recarga, re-busca, compara sucursal destino
- Si falla → estado FAILED con error CONSISTENCY

### Flujo de Edición (Actual)
- **Edita el turno existente** (cambia el código de sucursal in-place)
- NO crea un turno nuevo ni cierra el anterior
- Turno activo = "Fecha Final = null"

### Zona Horaria
- Todas las fechas se almacenan en **America/Bogota** (UTC-5)
- Función `nowLocal()` genera timestamps correctos

---

## Panel Administrativo

### Autenticación
- Login con usuario/contraseña desde `.env`
- Cookie HMAC-SHA256, HttpOnly, SameSite=Strict, 24h
- `/api/health` no requiere auth

### Dashboard (`/`)
- Tarjetas: éxitos, pendientes, procesando, fallidos, hoy
- Estado: WhatsApp, Worker, Browser, reconexiones
- QR de WhatsApp cuando no está conectado
- Errores recientes (últimos 10)
- Auto-refresh cada 5 segundos

### Historial (`/history`)
- Tabla filtrable: por estado, por documento
- Columnas: Fecha, Solicitante, Documento, Hacia, Estado, Error, Detalle
- Auto-refresh cada 8 segundos

### Números Autorizados (`/numbers`)
- CRUD de números con etiquetas
- Preview de clave normalizada
- Modo permisivo cuando la tabla está vacía

---

## Despliegue (Docker + Jenkins)

### Docker
- **Imagen**: `node:22-slim` + Chromium + dependencias
- **docker-compose.yml**: App + Nginx en red `red-gane-int`
- **Volumes**: `data/` (sesión WhatsApp + SQLite), `logs/`, `screenshots/`
- **Timezone**: `America/Bogota`

### Jenkins Pipeline
1. Copia `.env` desde credenciales Jenkins
2. `docker compose down --remove-orphans`
3. `docker compose up -d --build`
4. Verifica health (curl dentro del contenedor)
5. En fallo: muestra logs

---

## Testing

### Comandos
```bash
npm test                    # Todos los tests (node --test)
npm run test:unit           # Solo unitarios (sin browser)
npm run test:parser         # Solo parser/validación
node --test tests/automation.integration.test.js  # E2E con Puppeteer
```

### Archivos de Test
| Test | Tipo | Qué verifica |
|------|------|-------------|
| `parser.test.js` | Unit | Parseo de comandos multi-línea y legacy |
| `validation.test.js` | Unit | Validación de documento y sucursal |
| `idempotency.test.js` | Unit | Manejo de mensajes duplicados |
| `shift.test.js` | Unit | Lógica de turnos |
| `queue.test.js` | Unit | Operaciones de cola y lock |
| `worker.test.js` | Unit | Lógica del worker |
| `automation.integration.test.js` | E2E | Flujo completo contra mock HTML |

### E2E Test
- Usa `tests/mock/web-system.html` (mock local de BusinessNET)
- Reconfigura selectores para apuntar al mock
- 5 escenarios: éxito, sin turno, múltiples turnos, documento inexistente, sucursal inexistente
- No necesita credenciales reales

---

## Comandos de Ejecución

```bash
npm install                 # Instalar dependencias
npm run db:init             # Inicializar schema SQLite (una vez)
npm start                   # Arrancar todo (web + worker + whatsapp)
npm test                    # Ejecutar tests
```

### Requisitos
- Node ≥ 22.5 (node:sqlite nativo)
- Chrome/Chromium instalado
- Archivo `.env` con credenciales completas
- `npm run db:init` antes del primer arranque
