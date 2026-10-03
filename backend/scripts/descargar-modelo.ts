// Descarga y carga una vez el modelo de embeddings, para que quede en .cache/modelos.
// Se usa al construir la imagen: el contenedor arranca sin red hacia Hugging Face.
import { EmbeddingE5, MODELO_EMBEDDINGS } from '../src/infraestructura/embeddings/e5.js';

const vector = await new EmbeddingE5().embeberConsulta('prueba');
if (vector.length !== 384) throw new Error(`Se esperaban 384 dimensiones; llegaron ${vector.length}`);
console.log(`${MODELO_EMBEDDINGS} listo (${vector.length} dimensiones)`);
