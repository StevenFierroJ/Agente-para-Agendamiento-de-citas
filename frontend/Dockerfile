# Compila el frontend y lo sirve con nginx; /api va a la API (como el proxy de Vite en desarrollo).
FROM node:22-bookworm-slim AS compilar
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=compilar /app/dist /usr/share/nginx/html
