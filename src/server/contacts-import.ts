import { eq, inArray, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  fichaDeFila,
  fuenteCanonica,
  mergeTags,
  type ImportRow,
} from "@/lib/contact-import";
import { mergeFichaEnLote, normalizeFicha } from "@/server/bot/ficha";
import { createLeadForContact } from "@/server/inbox/lead-activity";
import type { SourceValue } from "@/lib/types";

/** Postgres admite ~65k parámetros por consulta; con margen de sobra. */
const CHUNK = 500;
/** Updates en paralelo por tanda: más que esto satura el pool sin ganar nada. */
const UPDATE_PARALLEL = 25;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

export type ImportResult = {
  /** Contactos nuevos. */
  created: number;
  /** Ya existían: no se duplican ni se les cambia el nombre. */
  existing: number;
  /** A cuántos se les apagó el agente (nuevos + existentes). */
  paused: number;
  /** Existentes a los que se les SUMÓ algo: etiquetas, ficha o fuente. */
  updated: number;
  /** Contactos que ganaron al menos una etiqueta. */
  tagged: number;
  /** Leads nuevos en el embudo (solo si se pidió). */
  leads: number;
};

export type ImportOptions = {
  aiPaused: boolean;
  /**
   * 067 — Meter también a los importados al embudo, en la primera etapa abierta.
   * Apagado por defecto: una lista de clientes viejos no es un embudo, y quien
   * ya tiene lead NO se mueve de etapa (ver `createLeadForContact`).
   */
  createLeads?: boolean;
  actorUserId?: string | null;
};

/**
 * 067 — `fuenteCanonica` (en el módulo puro) ya traduce los alias inequívocos
 * de las herramientas de origen (`AD` de yCloud) al enum del CRM. Lo que no
 * reconoce no se descarta: se queda como texto en la ficha, que es donde cabe
 * un "facebook" sin romper la columna.
 */

/**
 * 027 + 067 — Importa contactos de WhatsApp en lote. Re-ejecutable: importar dos
 * veces el mismo archivo no duplica a nadie.
 *
 * - NO crea conversación: un hilo vacío ensuciaría la Bandeja. La pausa del
 *   agente se guarda en el contacto y la conversación la hereda al nacer.
 * - A quien ya existía se le respeta el nombre y la etapa: pudo editarlos el
 *   dueño. Lo que SÍ se le suma son las etiquetas y los datos de la ficha, que
 *   es aditivo por definición.
 * - La ficha se fusiona clave a clave (el `||` de jsonb), nunca se reemplaza:
 *   el agente puede estar escribiendo en ella mientras el dueño importa.
 * - El nombre del archivo lo escribió una persona: queda como `manual`, y el
 *   nombre de perfil de WhatsApp no lo pisa cuando el importado escriba. Un
 *   renglón sin nombre entra con el teléfono como nombre y `perfil`, para que
 *   el de WhatsApp lo reemplace en cuanto exista.
 */
export async function importContacts(
  organizationId: string,
  rows: ImportRow[],
  opts: ImportOptions
): Promise<ImportResult> {
  const db = getDb();
  let created = 0;
  let existing = 0;
  let paused = 0;
  let updated = 0;
  let tagged = 0;
  let leads = 0;

  for (const batch of chunks(rows)) {
    const phones = batch.map((r) => r.phone);

    // Mismo criterio que la ingesta: alguien puede existir por identidad o por
    // teléfono (un contacto que llegó por BSUID y luego adquirió su número).
    const found = await db
      .select({
        id: schema.contact.id,
        waIdentity: schema.contact.waIdentity,
        phone: schema.contact.phone,
        source: schema.contact.source,
        tags: schema.contact.tags,
      })
      .from(schema.contact)
      .where(
        scoped(
          schema.contact.organizationId,
          organizationId,
          eq(schema.contact.channel, "whatsapp"),
          or(
            inArray(schema.contact.waIdentity, phones),
            inArray(schema.contact.phone, phones)
          )
        )
      );
    const porTelefono = new Map<string, (typeof found)[number]>();
    for (const c of found) {
      if (c.phone) porTelefono.set(c.phone, c);
      porTelefono.set(c.waIdentity, c);
    }
    existing += batch.filter((r) => porTelefono.has(r.phone)).length;

    const fresh = batch.filter((r) => !porTelefono.has(r.phone));
    let insertedIds: string[] = [];
    if (fresh.length > 0) {
      const inserted = await db
        .insert(schema.contact)
        .values(
          fresh.map((r) => {
            const ficha = normalizeFicha(fichaDeFila(r));
            const tags = mergeTags([], r.tags ?? []);
            const source = fuenteCanonica(r.source);
            return {
              id: newId("contact"),
              organizationId,
              name: r.name,
              nameSource: r.name === r.phone ? ("perfil" as const) : ("manual" as const),
              phone: r.phone,
              waIdentity: r.phone,
              aiPaused: opts.aiPaused,
              ...(Object.keys(ficha).length > 0 ? { ficha } : {}),
              ...(tags.length > 0 ? { tags } : {}),
              ...(source ? { source } : {}),
            };
          })
        )
        .onConflictDoNothing({
          target: [
            schema.contact.organizationId,
            schema.contact.channel,
            schema.contact.waIdentity,
          ],
        })
        .returning({ id: schema.contact.id });
      insertedIds = inserted.map((c) => c.id);
      created += insertedIds.length;
      // Carrera con la ingesta: alguien escribió entre el SELECT y el INSERT.
      existing += fresh.length - insertedIds.length;
    }

    // A los que ya existían se les SUMA. Nada se sobrescribe: las etiquetas
    // nuevas se unen a las que había y la ficha se fusiona por su propia puerta.
    const updates: {
      id: string;
      tags: string[];
      ganoEtiqueta: boolean;
      source: SourceValue | null;
    }[] = [];
    const fichas: { contactId: string; ficha: Record<string, unknown> }[] = [];
    for (const r of batch) {
      const prev = porTelefono.get(r.phone);
      if (!prev) continue;

      const antes = (prev.tags as string[] | null) ?? [];
      const tags = mergeTags(antes, r.tags ?? []);
      const ganoEtiqueta = tags.length > antes.length;
      const ficha = normalizeFicha(fichaDeFila(r));
      // Solo se rellena una fuente que nadie había capturado: lo que puso el
      // dueño manda, igual que en el alta manual.
      const source = prev.source === null ? fuenteCanonica(r.source) : null;

      if (Object.keys(ficha).length > 0) fichas.push({ contactId: prev.id, ficha });
      if (!ganoEtiqueta && !source) continue;
      updates.push({ id: prev.id, tags, ganoEtiqueta, source });
    }

    for (let i = 0; i < updates.length; i += UPDATE_PARALLEL) {
      await Promise.all(
        updates.slice(i, i + UPDATE_PARALLEL).map((u) =>
          db
            .update(schema.contact)
            .set({
              ...(u.ganoEtiqueta ? { tags: u.tags } : {}),
              ...(u.source ? { source: u.source } : {}),
              updatedAt: new Date(),
            })
            .where(
              scoped(
                schema.contact.organizationId,
                organizationId,
                eq(schema.contact.id, u.id)
              )
            )
        )
      );
    }
    // La ficha va por `mergeFichaEnLote`: es la puerta única de la ficha, y el
    // guardarraíl (`tests/unit/ficha-guard.test.ts`) no admite otra.
    if (fichas.length > 0) {
      await mergeFichaEnLote({ organizationId, items: fichas });
    }
    // Un contacto puede haber recibido etiquetas Y ficha: se cuenta una vez.
    const tocados = new Set(updates.map((u) => u.id));
    for (const f of fichas) tocados.add(f.contactId);
    updated += tocados.size;
    tagged += updates.filter((u) => u.ganoEtiqueta).length;

    // 027: la pausa se guarda en el contacto y la conversación la hereda.
    if (opts.aiPaused) {
      paused += insertedIds.length;

      const existingIds = found.map((c) => c.id);
      if (existingIds.length > 0) {
        await db
          .update(schema.contact)
          .set({ aiPaused: true, updatedAt: new Date() })
          .where(
            scoped(
              schema.contact.organizationId,
              organizationId,
              inArray(schema.contact.id, existingIds)
            )
          );
        paused += existingIds.length;
        await pauseConversations(organizationId, existingIds, true);
      }
    }

    // 067 — opcional y apagado por defecto. Va después de escribir los
    // contactos: un lead sin contacto no existe (la FK lo impide).
    if (opts.createLeads) {
      const ids = [...insertedIds, ...updates.map((u) => u.id)];
      leads += await crearLeads(organizationId, ids, opts.actorUserId ?? null);
    }
  }

  return { created, existing, paused, updated, tagged, leads };
}

/**
 * Crea el lead de cada contacto que aún no lo tenga, en la primera etapa abierta.
 *
 * Pasa por `createLeadForContact` —la misma puerta que el webhook y el alta
 * manual— y por eso NO mueve a quien ya está en el embudo: `onConflictDoNothing`
 * sobre el contacto lo deja donde el dueño lo tenía.
 */
async function crearLeads(
  organizationId: string,
  contactIds: string[],
  actorUserId: string | null
): Promise<number> {
  if (contactIds.length === 0) return 0;
  const db = getDb();

  const conLead = await db
    .select({ contactId: schema.lead.contactId })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        inArray(schema.lead.contactId, contactIds)
      )
    );
  const yaTienen = new Set(conLead.map((r) => r.contactId));

  let creados = 0;
  for (const contactId of contactIds) {
    if (yaTienen.has(contactId)) continue;
    const lead = await createLeadForContact({
      organizationId,
      contactId,
      source: "dueno",
      actorUserId,
    });
    if (lead) creados++;
  }
  return creados;
}

/**
 * Lleva la pausa del contacto a su conversación real, si ya existe.
 *
 * Sin esto, apagar el agente a alguien con quien ya se está hablando no
 * tendría efecto hasta que su conversación se borrara y naciera otra.
 * Reanudar NO toca `handoff_at`: una escalada que el agente decidió se levanta
 * desde la Bandeja, donde se ve por qué ocurrió.
 */
export async function pauseConversations(
  organizationId: string,
  contactIds: string[],
  paused: boolean
): Promise<void> {
  if (contactIds.length === 0) return;
  await getDb()
    .update(schema.conversation)
    .set({ aiEnabled: !paused, updatedAt: new Date() })
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        inArray(schema.conversation.contactId, contactIds),
        eq(schema.conversation.isTest, false)
      )
    );
}
