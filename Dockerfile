# Usa la imagen oficial de Puppeteer (trae Chromium + librerías)
FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

# Instala dependencias (solo producción)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia el proyecto
COPY . .

# Ajustes comunes
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true

# Railway expone 8080 por defecto. Tu app usa process.env.PORT.
EXPOSE 8080

# Arranque
CMD ["node", "server.js"]
