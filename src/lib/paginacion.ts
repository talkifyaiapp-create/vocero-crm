/**
 * 067 — Paginación de la lista de contactos: la parte pura.
 *
 * La comparten la API (para no aceptar un `limit` arbitrario) y la pantalla
 * (para pintar «1–100 de 2.847» y saber cuántas páginas hay). Con una sola
 * copia, el número que se enseña y el que se corta no pueden discrepar.
 */

/** Lo que ofrece el desplegable de la pantalla. */
export const TAMANOS_DE_PAGINA = [50, 100, 200] as const;
export type TamanioDePagina = (typeof TAMANOS_DE_PAGINA)[number];
export const TAMANIO_POR_DEFECTO: TamanioDePagina = 50;

/**
 * Cualquier cosa que no sea uno de los tamaños ofrecidos vuelve al de por
 * defecto. Sin esto, un `?limit=999999` llegaría a Postgres tal cual.
 */
export function normalizarTamanio(valor: unknown): TamanioDePagina {
  const n = Number(valor);
  return TAMANOS_DE_PAGINA.includes(n as TamanioDePagina)
    ? (n as TamanioDePagina)
    : TAMANIO_POR_DEFECTO;
}

/** Un offset negativo o no numérico es la primera página. */
export function normalizarOffset(valor: unknown): number {
  const n = Math.trunc(Number(valor));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export type RangoDePagina = {
  /** Primera fila que se ve, contando desde 1 (0 si no hay nada). */
  desde: number;
  /** Última fila que se ve, contando desde 1. */
  hasta: number;
  /** Página actual, contando desde 1. */
  pagina: number;
  /** Total de páginas; mínimo 1, para que «1 de 1» no sea «1 de 0». */
  paginas: number;
};

/**
 * Los números que van en el pie. Con `total` 0 devuelve 0–0 de 57 páginas 1:
 * una lista vacía tiene una página, no cero.
 */
export function rangoDePagina(
  total: number,
  offset: number,
  limit: number
): RangoDePagina {
  const tam = limit > 0 ? limit : TAMANIO_POR_DEFECTO;
  const paginas = Math.max(1, Math.ceil(total / tam));
  const pagina = Math.min(paginas, Math.floor(offset / tam) + 1);
  if (total === 0) return { desde: 0, hasta: 0, pagina: 1, paginas: 1 };
  const desde = Math.min(total, (pagina - 1) * tam + 1);
  const hasta = Math.min(total, pagina * tam);
  return { desde, hasta, pagina, paginas };
}
