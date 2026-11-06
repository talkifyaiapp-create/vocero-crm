import { fichaLabel, fichaValueText } from "@/lib/ficha";
import type { FichaDto, FichaValue } from "@/lib/types";

/**
 * De contactos a CSV: la parte PURA del exportador (067).
 *
 * Vive aparte del route handler para poder probarla sin base de datos, igual
 * que la importación. El CSV que sale de aquí se puede volver a importar: los
 * encabezados son los mismos que `detectColumns` sabe leer y las etiquetas van
 * separadas por comas, que es justo lo que `parseTags` entiende.
 */

/**
 * Separador `;` y no `,`: Excel en español abre `;` en columnas y un `,` en una
 * sola. El importador de este mismo CRM detecta los dos, así que ida y vuelta
 * funcionan igual.
 */
const SEPARADOR = ";";

/** Columnas fijas, en el orden en que se leen. */
const FIJAS = [
  "Nombre",
  "Teléfono",
  "Email",
  "Etiquetas",
  "Etapa",
  "Fuente",
  "Anuncio",
  "Ad ID",
  "URL del anuncio",
  "Notas",
  "Archivado",
] as const;

/**
 * Claves de la ficha que ya tienen columna propia. Las demás se añaden al final
 * como columnas dinámicas, para no perder ni un dato de calificación.
 */
const CLAVES_CON_COLUMNA = new Set([
  "email",
  "source",
  "source_url",
  "source_id",
  "anuncio",
  "ad id",
  "ad_id",
]);

export type ExportContacto = {
  name: string;
  /** Dígitos sin `+`, como se guarda. Null en contactos BSUID. */
  phone: string | null;
  stageName: string | null;
  /**
   * De dónde salió, TAL CUAL lo capturó alguien: el valor del enum
   * (`referido`) o el texto libre que trajo el archivo (`facebook`).
   *
   * Vacío cuando nadie la capturó. No se escribe aquí la fuente DEDUCIDA
   * ("Anuncio" porque vino de un anuncio): eso ya lo dicen las columnas del
   * anuncio, y guardarlo como texto haría que reimportar el archivo convirtiera
   * una deducción en un dato.
   */
  source: string;
  /** Titular del anuncio de origen, si se conoce. */
  anuncio: string | null;
  adId: string | null;
  adUrl: string | null;
  notes: string | null;
  archived: boolean;
  tags: string[];
  ficha: FichaDto;
};

/** Una celda escapada: comillas si el texto trae el separador o un salto. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV completo con BOM y CRLF: Excel necesita el BOM para leer los acentos como
 * UTF-8, y sin CRLF algunas versiones pegan todos los renglones en uno.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  separador = SEPARADOR
): string {
  const lineas = [headers, ...rows].map((r) => r.map(csvCell).join(separador));
  return `\uFEFF${lineas.join("\r\n")}\r\n`;
}

/** Las claves de ficha que no tienen columna propia, ordenadas y sin repetir. */
export function clavesExtraDeFicha(items: readonly ExportContacto[]): string[] {
  const vistas = new Map<string, string>();
  for (const c of items) {
    for (const clave of Object.keys(c.ficha)) {
      const normal = clave.toLowerCase();
      if (CLAVES_CON_COLUMNA.has(normal)) continue;
      if (!vistas.has(normal)) vistas.set(normal, clave);
    }
  }
  return [...vistas.values()].sort((a, b) => a.localeCompare(b, "es"));
}

/** Encabezados y filas del archivo, listos para `toCsv`. */
export function filasDeExportacion(items: readonly ExportContacto[]): {
  headers: string[];
  rows: string[][];
} {
  const extra = clavesExtraDeFicha(items);
  const headers = [...FIJAS, ...extra.map((k) => fichaLabel(k))];

  const rows = items.map((c) => {
    const valor = (clave: string): string => {
      const v: FichaValue | undefined = c.ficha[clave];
      return v === undefined ? "" : fichaValueText(v);
    };
    return [
      c.name,
      // El `+` que se ve en la app: el importador lo ignora al normalizar.
      c.phone ? `+${c.phone}` : "",
      valor("email"),
      c.tags.join(", "),
      c.stageName ?? "",
      c.source,
      // Lo que dijo Meta manda; si no hubo conversación, lo que trajo el archivo.
      c.anuncio ?? valor("Anuncio"),
      c.adId ?? valor("source_id"),
      c.adUrl ?? valor("source_url"),
      c.notes ?? "",
      c.archived ? "Sí" : "No",
      ...extra.map((clave) => valor(clave)),
    ];
  });

  return { headers, rows };
}
