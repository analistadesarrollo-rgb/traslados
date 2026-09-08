# Dockerfile para WhatsApp Transfer Bot
# Imagen: node:22 (incluye node:sqlite, estable para la aplicación)
FROM node:22-slim

# Dependencias para Chromium (necesarias para Pizza/con Puppeteer y WhatsApp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrender1 \
    libxshmfence1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    tzdata \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Directorio de trabajo
WORKDIR /app

# Copiar manifests e instalar dependencias (capa cacheable)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar el código fuente
COPY src ./src

# Directorios de datos/sesiones/lestados
RUN mkdir -p /app/data /app/logs /app/screenshots

# Variable de entorno por defecto para el ejecutable de Chrome en la imagen
ENV CHROME_PATH=/usr/bin/chromium
ENV NODE_ENV=production

# Exponer el puerto del panel admin
EXPOSE 3000

# Volumen para persistir la sesión de WhatsApp y la BD
VOLUME ["/app/data", "/app/logs", "/app/screenshots"]

# Salud: comprueba la API de health
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

ENTRYPOINT ["node", "src/index.js"]