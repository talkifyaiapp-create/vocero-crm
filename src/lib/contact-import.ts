import { normalizeMx } from "@/lib/meta/client";
import { isSourceValue } from "@/server/contact-source";
import type { SourceValue } from "@/lib/types";

/**
 * Importación de contactos desde un CSV: la parte PURA.
 *
 * La usan los dos lados: el diálogo, para enseñar qué se va a importar antes
 * de mandar nada, y el endpoint, que vuelve a validar porque no confía en lo
 * que diga el navegador. Con una sola copia, lo que el dueño ve en la vista
 * previa es exactamente lo que el servidor acepta.
 *
 * 067 — Además de nombre y teléfono, entiende email, etiquetas y la atribución
 * que trae un export de otra herramienta (`source`, `source_url`, `source_id`).
 * Nada de eso toca la columna `contact.source`, que es un enum cerrado: un CSV
 * con "facebook" ahí reventaría el lote entero. Esos datos van a la FICHA, que
 * es texto libre a propósito.
 */

/**
 * Tope por archivo.
 *
 * 067 — Subió de 2.000 a 5.000: un export real de una herramienta de WhatsApp
 * (yCloud, 360dialog…) ronda las 3.000 filas, y obligar a partir el archivo en
 * dos era trabajo manual con un error de dedo esperando. El tope sigue
 * existiendo para que un archivo absurdo no tumbe la petición: la lista viaja
 * entera en un JSON y se escribe en el proceso.
 */
export const IMPORT_MAX_ROWS = 5000;

/** Tope de etiquetas por renglón; el resto se descarta en silencio. */
export const MAX_TAGS_PER_ROW = 20;
/** Tope de cada etiqueta: una etiqueta es una palabra, no un párrafo. */
export const MAX_TAG_LEN = 40;
const MAX_EMAIL = 200;
const MAX_SOURCE = 80;
const MAX_SOURCE_URL = 500;
const MAX_SOURCE_ID = 200;

export type ImportRow = {
  name: string;
  phone: string;
  /** Columna `email` del archivo, si venía. */
  email?: string;
  /** De dónde salió el prospecto, tal como lo escribió la otra herramienta. */
  source?: string;
  sourceUrl?: string;
  sourceId?: string;
  /** Etiquetas del archivo, ya normalizadas y sin repetir. */
  tags?: string[];
  /**
   * 067 — Cuándo entró esta persona, según el sistema de donde salió el archivo
   * (`Create time` en yCloud).
   *
   * Va a la FICHA y no a `contact.created_at` a propósito: `created_at` es
   * "cuándo llegó a ESTE CRM" y sostiene el orden del listado y los números de
   * Resultados. Reescribirlo con una fecha de febrero cambiaría el histórico del
   * negocio sin que nadie lo pidiera.
   */
  primeraEntrada?: string;
  /** Último contacto según el archivo de origen (`Last contacted`). */
  ultimoContacto?: string;
};

export type ImportProblem = {
  /** Renglón del archivo, contando el encabezado como 1. */
  line: number;
  name: string;
  reason: "sin_telefono" | "sin_codigo_pais" | "telefono_invalido" | "repetido";
};

export const PROBLEM_LABELS: Record<ImportProblem["reason"], string> = {
  sin_telefono: "sin teléfono",
  sin_codigo_pais: "le falta el código de país",
  telefono_invalido: "teléfono inválido",
  repetido: "repetido en el archivo",
};

/**
 * CSV a tabla. Soporta comillas, comillas dobles escapadas, saltos de línea
 * dentro de un campo, y `;` o tabulador como separador (Excel en español
 * exporta con `;`).
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"]
    .map((d) => ({ d, n: firstLine.split(d).length }))
    .sort((a, b) => b.n - a.n)[0]!.d;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const plain = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

const PHONE_HEADERS = ["telefono", "phone", "whatsapp", "celular", "movil", "numero", "tel"];
/**
 * 067 — `nickname` es como yCloud llama al nombre en su export. Sin él, un
 * archivo real de esa herramienta no se reconocía y la importación moría con
 * "no encontré las columnas" aunque el archivo fuera perfecto.
 */
const NAME_HEADERS = [
  "nombre",
  "name",
  "contacto",
  "first name",
  "firstname",
  "nickname",
  "full name",
  "fullname",
  "display name",
];
const SURNAME_HEADERS = ["apellido", "apellidos", "last name", "lastname"];
const EMAIL_HEADERS = ["email", "e-mail", "correo", "correo electronico", "mail"];
const TAGS_HEADERS = ["tags", "tag", "etiquetas", "etiqueta", "labels", "label"];
const SOURCE_HEADERS = ["source", "fuente", "origen"];
/** Cuándo entró y cuándo habló por última vez, del sistema de origen. */
const FIRST_SEEN_HEADERS = [
  "create time",
  "created at",
  "primera entrada",
  "fecha de creacion",
  "fecha de alta",
];
const LAST_SEEN_HEADERS = [
  "last contacted",
  "last contact",
  "ultimo contacto",
  "última interaccion",
  "ultima interaccion",
  "last message",
];
/** Sin `source` a secas: ese ya lo toma SOURCE_HEADERS, y este lo reclamaría. */
const SOURCE_URL_HEADERS = [
  "source_url",
  "source url",
  "sourceurl",
  "url de origen",
  "url del anuncio",
  "ad_url",
];
const SOURCE_ID_HEADERS = [
  "source_id",
  "source id",
  "sourceid",
  "ad_id",
  "ad id",
  "id del anuncio",
  "id de anuncio",
  "anuncio id",
];

export type ImportColumns = {
  name: number;
  surname: number | null;
  phone: number;
  email: number | null;
  tags: number | null;
  source: number | null;
  sourceUrl: number | null;
  sourceId: number | null;
  /** 067 — `Create time`: cuándo entró la persona. */
  primeraEntrada: number | null;
  /** 067 — `Last contacted`: su última interacción. */
  ultimoContacto: number | null;
};

/**
 * Qué columna es cuál, por el encabezado. Devuelve null si no hay columna de
 * teléfono: sin ella no hay nada que importar, y adivinarla por el contenido
 * acabaría importando una columna de montos como teléfonos.
 *
 * El orden en que se reclaman las columnas importa: `source_id` y `source_url`
 * van ANTES que `source`, porque el buscador cae a "empieza por" y `source`
 * reclamaría la columna de `source_url` dejando la atribución a medias.
 */
export function detectColumns(header: string[]): ImportColumns | null {
  const cols = header.map(plain);
  const claimed = new Set<number>();

  const find = (candidates: string[]): number | null => {
    const libre = (i: number) => !claimed.has(i);
    let idx = cols.findIndex((c, i) => libre(i) && candidates.includes(c));
    if (idx < 0) {
      idx = cols.findIndex(
        (c, i) => libre(i) && candidates.some((k) => c.startsWith(k))
      );
    }
    if (idx < 0) return null;
    claimed.add(idx);
    return idx;
  };

  const phone = find(PHONE_HEADERS);
  const name = find(NAME_HEADERS);
  if (phone === null || name === null) return null;
  const surname = find(SURNAME_HEADERS);
  const email = find(EMAIL_HEADERS);
  const tags = find(TAGS_HEADERS);
  const sourceId = find(SOURCE_ID_HEADERS);
  const sourceUrl = find(SOURCE_URL_HEADERS);
  const source = find(SOURCE_HEADERS);
  const primeraEntrada = find(FIRST_SEEN_HEADERS);
  const ultimoContacto = find(LAST_SEEN_HEADERS);

  return {
    name,
    surname,
    phone,
    email,
    tags,
    source,
    sourceUrl,
    sourceId,
    primeraEntrada,
    ultimoContacto,
  };
}

/**
 * Celda de etiquetas a lista. Acepta `,`, `;` y `|` porque cada herramienta
 * exporta a su manera —yCloud usa listas de etiquetas separadas por comas, y
 * Excel en español mete `;`— y no hay por qué obligar a nadie a reformatear el
 * archivo a mano.
 *
 * Sin repetir y sin distinguir mayúsculas ("VIP" y "vip" son la misma etiqueta),
 * conservando cómo la escribió el dueño.
 */
export function parseTags(cell: string): string[] {
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const bruto of cell.split(/[,;|]/)) {
    const tag = bruto.replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LEN);
    if (!tag) continue;
    const clave = tag.toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_ROW) break;
  }
  return out;
}

/**
 * Une etiquetas sin duplicar ni pisar las que ya estaban.
 *
 * Es la regla del punto 1 del pedido: reimportar una lista SUMA etiquetas, no
 * reemplaza las que el dueño puso a mano. La comparación es sin mayúsculas por
 * la misma razón que en `parseTags`.
 */
export function mergeTags(
  existing: readonly string[],
  incoming: readonly string[]
): string[] {
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const tag of [...existing, ...incoming]) {
    const limpio = String(tag ?? "").trim().slice(0, MAX_TAG_LEN);
    if (!limpio) continue;
    const clave = limpio.toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push(limpio);
  }
  return out;
}

/**
 * Lo que del renglón va a la FICHA. Claves estables y en el idioma en que se
 * ven: son las que el dueño leerá en la ventana del contacto y las que saldrán
 * en el CSV de vuelta.
 *
 * `source` NO se escribe en la columna homónima (`contact.source`), que es un
 * enum de cinco valores: un "facebook" del archivo haría fallar la inserción
 * entera. En la ficha cabe cualquier texto.
 */
export function fichaDeFila(row: ImportRow): Record<string, string> {
  const out: Record<string, string> = {};
  if (row.email) out.email = row.email;
  if (row.source) out.source = row.source;
  if (row.sourceUrl) out.source_url = row.sourceUrl;
  if (row.sourceId) out.source_id = row.sourceId;
  // 067 — Las fechas del sistema de origen, con nombre de negocio: en la ficha
  // se leen como una etiqueta más, y así aparecen igual en la Bandeja y en la
  // ventana del contacto sin cablear nada.
  if (row.primeraEntrada) out["Primera entrada"] = row.primeraEntrada;
  if (row.ultimoContacto) out["Último contacto"] = row.ultimoContacto;
  return out;
}

/**
 * Teléfono a identidad de WhatsApp, o el motivo por el que no sirve.
 *
 * Exige código de país igual que el alta manual: diez dígitos son un número
 * local en varios países, y asumir uno produciría un contacto que jamás casa
 * con quien escriba después.
 *
 * Devuelve SOLO dígitos, sin `+`: es la identidad con la que Meta manda el
 * `from` en cada mensaje. El `+` que se ve en pantalla lo pone `formatPhone`.
 */
export function normalizeImportPhone(
  raw: string
): { ok: true; phone: string } | { ok: false; reason: ImportProblem["reason"] } {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "sin_telefono" };
  if (digits.length > 15) return { ok: false, reason: "telefono_invalido" };
  if (digits.length < 11) return { ok: false, reason: "sin_codigo_pais" };
  return { ok: true, phone: normalizeMx(digits) };
}

/** Texto de una celda, recortado y con los espacios colapsados. */
function texto(v: string | undefined, max: number): string | undefined {
  const t = (v ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

/**
 * 067 — Fecha del sistema de origen, en una forma que se lea igual en todos
 * lados (`2026-02-25 06:15`).
 *
 * No se convierte de zona horaria a propósito: es un dato HISTÓRICO de otra
 * herramienta, no un instante que vayamos a comparar con los nuestros.
 * Reinterpretarlo con la zona del servidor lo correría unas horas —o un día
 * entero cerca de medianoche— sin que nadie lo pidiera.
 */
export function fechaDeArchivo(v: string | undefined): string | undefined {
  const t = texto(v, 40);
  if (!t) return undefined;
  const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(t);
  if (iso) return `${iso[1]} ${iso[2]}`;
  return t;
}

/**
 * 067 — La fuente del archivo, traducida al enum del CRM cuando no admite duda.
 *
 * yCloud escribe `AD` para lo que llegó de un anuncio. Guardarlo tal cual lo
 * dejaba en la ficha (el dato no se pierde) pero sin el distintivo "Anuncio" en
 * la lista. Solo se traducen los casos inequívocos: `Post` puede ser orgánico o
 * promocionado, y adivinarlo sería inventar un dato.
 *
 * Lo que no se reconoce NO se pierde: se guarda como texto en la ficha.
 */
const ALIAS_DE_FUENTE: Record<string, SourceValue> = {
  ad: "anuncio",
  ads: "anuncio",
  ad_paid: "anuncio",
  organic: "organico",
};

export function fuenteCanonica(raw: string | undefined): SourceValue | null {
  const v = (raw ?? "").trim().toLowerCase();
  const alias = ALIAS_DE_FUENTE[v];
  if (alias) return alias;
  return isSourceValue(v) ? v : null;
}

/**
 * De dos fechas del mismo archivo, la más reciente. `YYYY-MM-DD HH:MM` ordena
 * bien como texto, que es justo el formato al que lleva `fechaDeArchivo`.
 */
function masReciente(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return b > a ? b : a;
}

/** Filas crudas a filas importables + lo que se quedó fuera y por qué. */
export function prepareImport(rows: ImportRow[]): {
  valid: ImportRow[];
  problems: ImportProblem[];
} {
  const valid: ImportRow[] = [];
  const problems: ImportProblem[] = [];
  /** Teléfono → fila ya aceptada, para sumarle lo que traiga la repetida. */
  const porTelefono = new Map<string, ImportRow>();

  rows.forEach((r, i) => {
    const line = i + 2;
    const name = (r.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    const res = normalizeImportPhone(r.phone ?? "");
    if (!res.ok) {
      problems.push({ line, name, reason: res.reason });
      return;
    }

    const extra = {
      email: texto(r.email, MAX_EMAIL),
      source: texto(r.source, MAX_SOURCE),
      sourceUrl: texto(r.sourceUrl, MAX_SOURCE_URL),
      sourceId: texto(r.sourceId, MAX_SOURCE_ID),
      tags: mergeTags([], r.tags ?? []),
      primeraEntrada: fechaDeArchivo(r.primeraEntrada),
      ultimoContacto: fechaDeArchivo(r.ultimoContacto),
    };

    const previa = porTelefono.get(res.phone);
    if (previa) {
      // Repetido en el archivo: el renglón se descarta (para eso lo dice), pero
      // sus etiquetas y datos se suman a la fila que sí entra. Botar la segunda
      // renglón entera perdería etiquetas que el archivo sí traía.
      const unidas = mergeTags(previa.tags ?? [], extra.tags);
      // Solo si hay alguna: dejar `tags: []` en una fila sin etiquetas la haría
      // parecer etiquetada con una lista vacía, en la vista previa y en el JSON.
      if (unidas.length > 0) previa.tags = unidas;
      previa.email ??= extra.email;
      previa.source ??= extra.source;
      previa.sourceUrl ??= extra.sourceUrl;
      previa.sourceId ??= extra.sourceId;
      previa.primeraEntrada ??= extra.primeraEntrada;
      // La fecha de último contacto SÍ se pisa: entre dos renglones del mismo
      // archivo, el bueno es el más reciente.
      previa.ultimoContacto = masReciente(
        previa.ultimoContacto,
        extra.ultimoContacto
      );
      problems.push({ line, name, reason: "repetido" });
      return;
    }

    // Sin nombre se importa igual, con el teléfono como nombre: es lo mismo
    // que hace la ingesta cuando alguien escribe sin nombre de perfil.
    const fila: ImportRow = {
      name: name || res.phone,
      phone: res.phone,
      ...(extra.email ? { email: extra.email } : {}),
      ...(extra.source ? { source: extra.source } : {}),
      ...(extra.sourceUrl ? { sourceUrl: extra.sourceUrl } : {}),
      ...(extra.sourceId ? { sourceId: extra.sourceId } : {}),
      ...(extra.tags.length > 0 ? { tags: extra.tags } : {}),
      ...(extra.primeraEntrada ? { primeraEntrada: extra.primeraEntrada } : {}),
      ...(extra.ultimoContacto ? { ultimoContacto: extra.ultimoContacto } : {}),
    };
    valid.push(fila);
    porTelefono.set(res.phone, fila);
  });
  return { valid, problems };
}

/** Del texto del archivo a filas listas, o el motivo por el que no se pudo leer. */
export function readImportFile(
  text: string
):
  | { ok: true; valid: ImportRow[]; problems: ImportProblem[]; total: number }
  | { ok: false; error: string } {
  const table = parseCsv(text);
  if (table.length < 2) {
    return { ok: false, error: "El archivo está vacío o solo trae el encabezado." };
  }
  const cols = detectColumns(table[0]!);
  if (!cols) {
    return {
      ok: false,
      error:
        "No encontré las columnas. El archivo necesita una columna «nombre» y una «telefono» en el primer renglón.",
    };
  }
  const body = table.slice(1);
  if (body.length > IMPORT_MAX_ROWS) {
    return {
      ok: false,
      error: `El archivo trae ${body.length} renglones; el máximo por importación es ${IMPORT_MAX_ROWS}.`,
    };
  }
  const celda = (r: string[], col: number | null) =>
    col === null ? "" : (r[col] ?? "");
  const rows: ImportRow[] = body.map((r) => ({
    name: [celda(r, cols.name), celda(r, cols.surname)]
      .map((v) => v.trim())
      .filter(Boolean)
      .join(" "),
    phone: celda(r, cols.phone),
    email: celda(r, cols.email),
    source: celda(r, cols.source),
    sourceUrl: celda(r, cols.sourceUrl),
    sourceId: celda(r, cols.sourceId),
    tags: parseTags(celda(r, cols.tags)),
    primeraEntrada: celda(r, cols.primeraEntrada),
    ultimoContacto: celda(r, cols.ultimoContacto),
  }));
  return { ok: true, ...prepareImport(rows), total: body.length };
}
