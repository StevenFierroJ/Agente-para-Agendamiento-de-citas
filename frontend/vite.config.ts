import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// /api → la API en el puerto 3000. Mismo origen para el navegador: sin CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['API_URL'] ?? 'http://localhost:3000',
        rewrite: (ruta) => ruta.replace(/^\/api/, ''),
      },
    },
  },
});
