/**
 * Ventana gratuita de las conversaciones que nacen de un anuncio Click-to-WhatsApp.
 *
 * OJO: esto NO cambia lo que se puede enviar. Para escribir sigue habiendo UNA
 * regla, la de siempre: 24 h de atención desde el último mensaje del cliente, y
 * después solo plantilla. Lo que aquí se calcula es el COSTO: durante la ventana
 * gratuita Meta no cobra la mensajería.
 *
 * Las dos ventanas conviven y por eso se confunden:
 *
 *   atención (24 h, se reabre con cada mensaje del cliente)  → qué puedes enviar
 *   gratuita (hasta 7 días, una sola por conversación)       → cuánto pagas
 *
 * Y la condición que casi nadie mira: **la ventana gratuita solo se abre si la
 * empresa responde dentro de las primeras 24 h**. Si nadie contesta —el agente
 * apagado, un handoff esperando, un mensaje de madrugada— esos 7 días gratis se
 * pierden para siempre.
 *
 * Puro a propósito: se prueba sin base de datos y la pantalla y el servidor no
 * pueden discrepar. Todo lo que se muestra es una ESTIMACIÓN construida sobre la
 * regla publicada; la cuenta de Meta es la que manda.
 */

const HORA_MS = 60 * 60 * 1000;
/** Ventana de atención de WhatsApp: 24 h desde el último mensaje del cliente. */
export const VENTANA_DE_ATENCION_MS = 24 * HORA_MS;
/** Ventana gratuita de las conversaciones de anuncio: hasta 7 días. */
export const VENTANA_GRATUITA_MS = 7 * 24 * HORA_MS;

export type EstadoVentanaGratuita =
  /** No vino de un anuncio: aquí no hay nada que contar. */
  | "no_aplica"
  /** Vino de un anuncio y nadie ha contestado: se abre si respondes a tiempo. */
  | "por_abrir"
  /** Se abrió: la mensajería no cuesta hasta `limite`. */
  | "abierta"
  /** Se abrió y ya pasó. */
  | "expirada"
  /** Se dejó pasar la ventana de 24 h: no se abrió y ya no se abrirá. */
  | "perdida";

export type VentanaGratuita = {
  estado: EstadoVentanaGratuita;
  /**
   * Qué fecha importa según el estado: en `por_abrir`, la hora límite para
   * responder; en `abierta`, hasta cuándo es gratis; en `expirada`, cuándo
   * terminó. Null cuando no hay fecha que enseñar.
   */
  limite: Date | null;
};

const SIN_VENTANA: VentanaGratuita = { estado: "no_aplica", limite: null };

/**
 * `primerEntrante`: el primer mensaje del cliente en el hilo (el que abrió la
 * conversación desde el anuncio). `primerSaliente`: la primera respuesta de la
 * empresa. `ahora` se inyecta para poder probarlo.
 */
export function ventanaGratuita(input: {
  llegoPorAnuncio: boolean;
  primerEntrante: Date | null;
  primerSaliente: Date | null;
  ahora?: Date;
}): VentanaGratuita {
  const { llegoPorAnuncio, primerEntrante, primerSaliente } = input;
  const ahora = input.ahora ?? new Date();

  if (!llegoPorAnuncio || !primerEntrante) return SIN_VENTANA;

  const venceAtencion = new Date(
    primerEntrante.getTime() + VENTANA_DE_ATENCION_MS
  );

  // Una respuesta ANTERIOR al primer mensaje no cuenta: sería una plantilla que
  // la empresa mandó por su cuenta, no la respuesta que abre la ventana.
  const respondio =
    primerSaliente !== null && primerSaliente.getTime() >= primerEntrante.getTime();

  if (!respondio) {
    return venceAtencion.getTime() > ahora.getTime()
      ? { estado: "por_abrir", limite: venceAtencion }
      : { estado: "perdida", limite: null };
  }

  // Se contestó, pero tarde: la ventana no se abrió.
  if (primerSaliente.getTime() > venceAtencion.getTime()) {
    return { estado: "perdida", limite: null };
  }

  const hasta = new Date(primerSaliente.getTime() + VENTANA_GRATUITA_MS);
  return hasta.getTime() > ahora.getTime()
    ? { estado: "abierta", limite: hasta }
    : { estado: "expirada", limite: hasta };
}

/** Cuánto falta para la fecha que importa. Negativo si ya pasó. */
export function msHasta(
  ventana: VentanaGratuita,
  ahora: Date = new Date()
): number | null {
  if (!ventana.limite) return null;
  return ventana.limite.getTime() - ahora.getTime();
}
