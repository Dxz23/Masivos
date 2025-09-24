# Usa la imagen oficial de Puppeteer (ya trae Chrome + libs)
FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

# Instala dependencias (solo prod)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia el proyecto
COPY . .

# Ajustes para Puppeteer/Chrome en contenedor
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Railway suele poner PORT=8080; tu app ya usa process.env.PORT
EXPOSE 8080

# Arranque
CMD ["node", "server.js"]
