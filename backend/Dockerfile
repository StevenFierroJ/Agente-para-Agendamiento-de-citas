# Imagen del backend: la misma para `preparar` (migraciones y seed), `api` y `trabajador`.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Dependencias primero: la capa se reutiliza mientras no cambie el lockfile.
# Solo las de producción; tsx (que ejecuta el TypeScript) es una de ellas.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY seed ./seed
COPY migraciones ./migraciones
COPY scripts ./scripts

# El modelo de embeddings queda dentro de la imagen (~118 MB): el arranque no
# depende de la red ni espera la descarga.
RUN node --import tsx scripts/descargar-modelo.ts

USER node
CMD ["node", "--import", "tsx", "src/api.ts"]
