// Punto de entrada de la API: webhook y lectura. No llama al LLM.
import { leerConfig } from './config.js';
import { registroConsola } from './infraestructura/registro.js';
import { levantarSistema } from './sistema.js';

const config = leerConfig();
const sistema = await levantarSistema({ databaseUrl: config.DATABASE_URL, mongoUrl: config.MONGO_URL, registro: registroConsola });
await sistema.api.listen({ port: config.PUERTO, host: '0.0.0.0' });
registroConsola.info('api escuchando', { puerto: config.PUERTO });

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(senal, () => {
    registroConsola.info('deteniendo api', { senal });
    sistema.detener().then(
      () => process.exit(0),
      (error: unknown) => {
        registroConsola.error('error al detener', { error: String(error) });
        process.exit(1);
      },
    );
  });
}
