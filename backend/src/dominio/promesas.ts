// Barandillas sobre acciones que el modelo afirma en su respuesta (D-29):
// la cita agendada tiene que existir y la promesa de un humano se cumple.
//
// Si la respuesta dice "te paso con un asesor" y el modelo no llamó a
// escalar_a_humano, el paciente espera a una persona que nunca llega: la
// conversación no aparece como escalada en la bandeja. El código escala igual.
// Una oferta ("¿quieres que te pase con un asesor?") no es una promesa.

// \b de JavaScript solo entiende límites ASCII (falla tras "escalé"): límites Unicode a mano.
const I = String.raw`(?<!\p{L})`;
const F = String.raw`(?!\p{L})`;
const PROMESA = new RegExp(
  [
    String.raw`${I}(te|lo|la)\s+(paso|pasamos|comunico|comunicamos|transfiero|transferimos|conecto|conectamos|remito)${F}`,
    String.raw`${I}pasarte\s+con${F}`,
    String.raw`${I}un\s+(asesor|agente|humano)[^.?!]*${I}(continuar[áa]|te\s+(contactar[áa]|responder[áa]|atender[áa]|escribir[áa]))${F}`,
    String.raw`${I}(ya\s+)?(escal[ée]|he\s+escalado)${F}`,
  ].join('|'),
  'iu',
);

/** Separa en oraciones conservando el signo final, para saber si una frase es pregunta. */
function oraciones(texto: string): string[] {
  return texto.split(/(?<=[.!?\n])\s+/).map((o) => o.trim()).filter(Boolean);
}

/** ¿La respuesta promete (no ofrece) pasar al paciente con un humano? */
export function prometeEscalamiento(texto: string): boolean {
  return oraciones(texto).some((o) => PROMESA.test(o) && !o.includes('?') && !o.includes('¿'));
}

const CITA_AFIRMADA = new RegExp(
  [
    String.raw`${I}cita${F}[^.?!]{0,40}${I}(est[áa]|qued[óo]|queda|ha\s+quedado|fue|ha\s+sido)\s+(agendada|confirmada|reservada|programada|lista)${F}`,
    // Pasado y presente: "agendé tu cita", "confirmo tu cita" (pasó con Haiku real).
    String.raw`${I}(agend[ée]|reserv[ée]|confirm[ée]|program[ée]|agendo|reservo|confirmo|agendamos|reservamos|confirmamos|programamos)\s+(tu|la|su)\s+cita${F}`,
    String.raw`${I}(dejo|dejamos|qued[óo]|queda)\s+(tu|la|su)\s+cita\s+(agendada|confirmada|reservada)${F}`,
    String.raw`${I}(he|hemos|ha|han)\s+(agendado|reservado|confirmado|programado)\s+(tu|la|su)\s+cita${F}`,
    String.raw`${I}(tienes|tiene)\s+(tu\s+|su\s+)?cita\s+(agendada|confirmada|reservada)${F}`,
    String.raw`${I}(listo|hecho)${F}[^.?!]{0,30}${I}cita${F}`,
  ].join('|'),
  'iu',
);

/** ¿La respuesta afirma (no pregunta) que una cita quedó agendada? */
export function afirmaCitaAgendada(texto: string): boolean {
  return oraciones(texto).some((o) => CITA_AFIRMADA.test(o) && !o.includes('?') && !o.includes('¿'));
}

const RAIZ_DE_RESERVA = /agend|reserv|confirm|program|apart|separ|✅/iu;

/**
 * Filtro amplio y barato: alguna oración afirmativa menciona una cita y una raíz
 * de reservar. No decide que hubo afirmación (eso lo hace afirmaCitaAgendada o el
 * verificador); decide cuándo vale la pena verificar.
 */
export function mencionaReservaDeCita(texto: string): boolean {
  return oraciones(texto).some((o) => /cita/iu.test(o) && RAIZ_DE_RESERVA.test(o) && !o.includes('?') && !o.includes('¿'));
}

// Abstención sin búsqueda (D-41): "no tengo información sobre coberturas" dicho
// sin haber consultado los documentos. No afirma ningún dato, así que la
// barandilla de datos no la ve, pero niega lo que la clínica sí publica.
const NO_SABE = new RegExp(
  [
    String.raw`${I}no\s+(tengo|tenemos|cuento\s+con|contamos\s+con|dispongo\s+de|disponemos\s+de|manejo|manejamos)\s+(esa\s+|la\s+|el\s+|ese\s+|)(informaci[óo]n|datos?|detalles?)${F}`,
    String.raw`${I}no\s+tengo\s+acceso\s+a${F}`,
    String.raw`${I}no\s+(puedo|podemos)\s+(confirmar|informar)te${F}`,
  ].join('|'),
  'iu',
);

/** ¿La respuesta dice que no tiene la información? */
export function diceNoSaber(texto: string): boolean {
  return NO_SABE.test(texto);
}

// Temas que solo responden los documentos de la clínica. Si el paciente pregunta
// por uno y el modelo contesta sin buscar, lo que diga sale de su memoria (D-41):
// "no tengo información de coberturas" o "consulta con un asesor", cuando el
// documento dice que la clínica atiende Colsanitas.
const TEMA_DE_LOS_DOCUMENTOS = new RegExp(
  [
    String.raw`${I}(colsanitas|sura|coomeva|allianz|sanitas|compensar|nueva\s+eps|eps|prepagada|p[óo]liza|seguros?|aseguradora)${F}`,
    String.raw`${I}(cobertura|cubre|cubren|copago|cuota\s+moderadora)${F}`,
    String.raw`${I}(precio|precios|tarifa|tarifas|valor|cu[áa]nto\s+(vale|cuesta|cobran)|pagar|pago|pagos|efectivo|tarjeta|transferencia)${F}`,
    String.raw`${I}(ayuno|ayunas|preparaci[óo]n|ex[áa]menes?|laboratorio)${F}`,
    String.raw`${I}(cancelar|cancelaci[óo]n|reprogramar|cambiar\s+la\s+cita)${F}`,
    String.raw`${I}(qu[ée]\s+(debo\s+)?llevar|documentos?|direcci[óo]n|d[óo]nde\s+(queda|quedan|est[áa]n?)|ubicaci[óo]n|parqueadero|urgencias?)${F}`,
  ].join('|'),
  'iu',
);

/** ¿El mensaje del paciente pregunta por algo que solo responden los documentos? */
export function preguntaPorLosDocumentos(textoDelPaciente: string): boolean {
  return TEMA_DE_LOS_DOCUMENTOS.test(textoDelPaciente);
}
