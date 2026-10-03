import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { VerificadorAfirmaciones } from '../src/aplicacion/puertos.js';
import { LlmGuionado } from '../src/infraestructura/llm/falso.js';
import type { Sistema } from '../src/sistema.js';
import { esperarProcesados, levantarSistemaDeTest, limpiarConversaciones, mensaje, prepararBasesDeTest } from './ayudas/sistema.js';

// Una paráfrasis que las reglas no reconocen, pero que pasa el filtro amplio (cita + "apart" + ✅).
const PARAFRASIS = 'Tu espacio de cita ya está apartado ✅ para el martes.';

describe('barandilla de cita afirmada con verificador', () => {
  let sistema: Sistema;
  let llm: LlmGuionado;
  const consultas: string[] = [];
  let veredicto: 'si' | 'no' | 'falla' = 'si';
  const verificador: VerificadorAfirmaciones = {
    afirmaCitaAgendada: async (texto) => {
      consultas.push(texto);
      if (veredicto === 'falla') throw new Error('verificador caído');
      return veredicto === 'si';
    },
  };

  beforeAll(async () => {
    await prepararBasesDeTest();
    llm = new LlmGuionado();
    ({ sistema } = await levantarSistemaDeTest({ llm, verificador }));
  });
  afterAll(async () => {
    await sistema.detener();
  });
  afterEach(async () => {
    await limpiarConversaciones(sistema);
    llm.olvidar();
    consultas.length = 0;
  });

  async function turno(id: string) {
    await sistema.api.inject({ method: 'POST', url: '/webhooks/messages', payload: mensaje(id, 'Sí, esa me sirve') });
    await esperarProcesados(sistema.pool, [id]);
    return (await sistema.mongo.turnos.findOne({ _id: id }))!;
  }

  it('el verificador detecta la paráfrasis y el modelo corrige', async () => {
    veredicto = 'si';
    llm.guionar('v.1', [{ tipo: 'texto', texto: PARAFRASIS }, { tipo: 'texto', texto: 'Para agendarla necesito tu nombre completo, por favor.' }]);
    const t = await turno('v.1');
    expect(consultas[0]).toBe(PARAFRASIS);
    expect(t.controles.map((c) => `${c.tipo}:${c.accion}`)).toEqual(['cita_no_agendada:corregir']);
    expect(t.estado_final).toBe('resuelta_por_ia');
  });

  it('si el verificador dice que no afirma, la respuesta pasa', async () => {
    veredicto = 'no';
    llm.guionar('v.2', [{ tipo: 'texto', texto: PARAFRASIS }]);
    const t = await turno('v.2');
    expect(t.controles).toEqual([]);
    expect(t.estado_final).toBe('resuelta_por_ia');
  });

  it('si el verificador falla, deciden las reglas y la falla queda en la traza', async () => {
    veredicto = 'falla';
    llm.guionar('v.3', [{ tipo: 'texto', texto: PARAFRASIS }]);
    const t = await turno('v.3');
    expect(t.controles).toEqual([{ tipo: 'verificador_no_disponible', datos: ['Error: verificador caído'], accion: 'solo_reglas' }]);
    expect(t.estado_final).toBe('resuelta_por_ia');
  });

  it('una frase conocida no consulta al verificador: la regla basta', async () => {
    veredicto = 'no';
    llm.guionar('v.4', [{ tipo: 'texto', texto: 'He agendado tu cita.' }, { tipo: 'texto', texto: '¿Me confirmas tu nombre?' }]);
    const t = await turno('v.4');
    expect(consultas).toEqual([]);
    expect(t.controles.map((c) => c.accion)).toEqual(['corregir']);
  });
});
