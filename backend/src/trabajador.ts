// Punto de entrada del trabajador: consume la cola y llama al LLM.
import { crearHerramientas } from './aplicacion/herramientas/registro.js';
import { leerConfig, preciosLlm } from './config.js';
import { crearLlmReal } from './infraestructura/llm/crear.js';
import { registroConsola } from './infraestructura/registro.js';
import { levantarSistema } from './sistema.js';

const config = leerConfig();
const sistema = await levantarSistema({
  databaseUrl: config.DATABASE_URL,
  mongoUrl: config.MONGO_URL,
  registro: registroConsola,
  trabajador: {
    llm: crearLlmReal(config),
    crearHerramientas: ({ agenda, mensajes }) => crearHerramientas({ agenda, catalogo: mensajes }),
    timeoutMs: config.LLM_TIMEOUT_MS,
    maxIteraciones: config.LLM_MAX_ITERACIONES,
    precios: preciosLlm(config),
    concurrencia: config.TRABAJADOR_CONCURRENCIA,
  },
});
registroConsola.info('trabajador iniciado', { modelo: config.LLM_MODEL, concurrencia: config.TRABAJADOR_CONCURRENCIA });

for (const senal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(senal, () => {
    registroConsola.info('deteniendo trabajador', { senal });
    sistema.detener().then(
      () => process.exit(0),
      (error: unknown) => {
        registroConsola.error('error al detener', { error: String(error) });
        process.exit(1);
      },
    );
  });
}
