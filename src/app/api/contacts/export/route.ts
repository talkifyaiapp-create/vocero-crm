import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { filasDeExportacion, toCsv, type ExportContacto } from "@/lib/contact-export";
import type { FichaDto } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Tope duro del archivo: un CSV de 200 mil filas no lo abre ni Excel. */
const MAX_FILAS = 50_000;
const PAGINA = 1_000;

/**
 * 067 — La lista de contactos en CSV.
 *
 * No reusa el listado de la pantalla a propósito: aquel corta en 200 y filtra
 * en memoria por prioridad. Un export que se corta en silencio es peor que no
 * tener export, porque el dueño se entera cuando ya migró media base.
 *
 * Columnas fijas + una por cada clave de ficha que no tenga columna propia, así
 * que lo que el agente haya calificado no se queda por fuera.
 */
export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const tag = url.searchParams.get("tag")?.trim();
  const stage = url.searchParams.get("stage")?.trim();
  const includeArchived = url.searchParams.get("archived") === "true";

  const db = getDb();

  // Etapa de cada contacto. Sin join en la consulta principal: un contacto con
  // más de un lead duplicaría la fila, y el export no puede repetir gente.
  const leadStages = await db
    .select({
      contactId: schema.lead.contactId,
      stageName: schema.pipelineStage.name,
    })
    .from(schema.lead)
    .innerJoin(
      schema.pipelineStage,
      eq(schema.pipelineStage.id, schema.lead.stageId)
    )
    .where(scoped(schema.lead.organizationId, session.organizationId));
  const stageByContact = new Map(leadStages.map((r) => [r.contactId, r.stageName]));

  const stageContactIds = stage
    ? leadStages.filter((r) => r.stageName === stage).map((r) => r.contactId)
    : null;
  if (stageContactIds?.length === 0) {
    return csvDeRespuesta(toCsv(["Nombre"], []));
  }

  // Anuncio de origen: la PRIMERA fila de cada contacto, igual que la tarjeta
  // de la Bandeja (`primeraFilaDelContacto`). Un contacto que llegó dos veces
  // por anuncios distintos se cuenta con el que lo trajo.
  const anuncios = await db
    .select({
      contactId: schema.adAttribution.contactId,
      headline: schema.adAttribution.headline,
      sourceId: schema.adAttribution.sourceId,
      sourceUrl: schema.adAttribution.sourceUrl,
    })
    .from(schema.adAttribution)
    .where(scoped(schema.adAttribution.organizationId, session.organizationId))
    .orderBy(asc(schema.adAttribution.createdAt), asc(schema.adAttribution.id));
  const anuncioByContact = new Map<string, (typeof anuncios)[number]>();
  for (const a of anuncios) {
    if (!anuncioByContact.has(a.contactId)) anuncioByContact.set(a.contactId, a);
  }

  const where = scoped(
    schema.contact.organizationId,
    session.organizationId,
    stageContactIds ? inArray(schema.contact.id, stageContactIds) : undefined,
    tag ? sql`${schema.contact.tags} @> ${JSON.stringify([tag])}::jsonb` : undefined
  );

  const items: ExportContacto[] = [];
  for (let offset = 0; offset < MAX_FILAS; offset += PAGINA) {
    const filas = await db
      .select()
      .from(schema.contact)
      .where(where)
      .orderBy(desc(schema.contact.createdAt))
      .limit(PAGINA)
      .offset(offset);
    if (filas.length === 0) break;

    for (const c of filas) {
      if (!includeArchived && c.archivedAt) continue;
      const anuncio = anuncioByContact.get(c.id);
      const ficha = (c.ficha as FichaDto | null) ?? {};
      // Lo capturado manda: la columna del enum o, si el archivo de origen trajo
      // un texto libre ("facebook"), ese texto. Vacío si nadie lo capturó.
      const fuente =
        c.source ?? (typeof ficha.source === "string" ? ficha.source : "");
      items.push({
        name: c.name,
        phone: c.phone,
        stageName: stageByContact.get(c.id) ?? null,
        source: fuente,
        anuncio: anuncio?.headline ?? null,
        adId: anuncio?.sourceId ?? null,
        adUrl: anuncio?.sourceUrl ?? null,
        notes: c.notes,
        archived: c.archivedAt !== null,
        tags: (c.tags as string[] | null) ?? [],
        ficha,
      });
    }
    if (filas.length < PAGINA) break;
  }

  const { headers, rows } = filasDeExportacion(items);
  return csvDeRespuesta(toCsv(headers, rows));
});

/**
 * `no-store` porque el archivo lleva datos de clientes: ni el navegador ni un
 * proxy intermedio tienen por qué guardarlo. El nombre va con la fecha para que
 * dos exports no se pisen al descargar.
 */
function csvDeRespuesta(csv: string): Response {
  const hoy = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="contactos-${hoy}.csv"`,
      "cache-control": "no-store",
    },
  });
}
