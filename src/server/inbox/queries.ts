import { and, desc, eq, gt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isWindowOpen, replyWindow, windowRemainingMs } from "@/server/inbox/window";
import { capabilitiesFor, windowMsFor } from "@/server/channels/capabilities";
import { ventanaGratuita } from "@/lib/ventana-gratuita";
import type { ConversationDto } from "@/lib/types";

/** Lo que devuelve `min(created_at)`: el driver puede dar Date o texto. */
function aFecha(v: string | Date | null): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 018 — El anuncio de origen viaja con la conversación. La llave única
 * (organización, conversación) garantiza a lo más una fila por renglón, así
 * que el LEFT JOIN no multiplica la lista.
 */
const anuncioDeLaConversacion = and(
  eq(schema.adAttribution.organizationId, schema.conversation.organizationId),
  eq(schema.adAttribution.conversationId, schema.conversation.id)
);

const anuncioDeLista = {
  id: schema.adAttribution.id,
  headline: schema.adAttribution.headline,
  sourceId: schema.adAttribution.sourceId,
  sourceType: schema.adAttribution.sourceType,
};

function aAnuncioDeLista(
  fila: {
    id: string | null;
    headline: string | null;
    sourceId: string | null;
    sourceType: string | null;
  } | null
): ConversationDto["anuncio"] {
  // Sin fila, drizzle devuelve el objeto con todo en null (o null a secas).
  if (!fila?.id) return null;
  return {
    headline: fila.headline,
    sourceId: fila.sourceId,
    sourceType: fila.sourceType,
  };
}

export async function listConversations(
  organizationId: string,
  since?: Date
): Promise<ConversationDto[]> {
  const db = getDb();
  // 064 — `organization_id` primero: es la primera columna de
  // `message_org_conv_idx`. Sin ella Postgres recorre TODOS los mensajes por
  // cada conversación de la lista (segundos con unas decenas de miles).
  const previewSql = sql<string | null>`(
    select coalesce(m.text, m.type)
    from message m
    where m.organization_id = ${schema.conversation.organizationId}
      and m.conversation_id = ${schema.conversation.id}
    order by m.created_at desc
    limit 1
  )`;
  const stageSql = sql<string | null>`(
    select s.name from lead l
    join pipeline_stage s on s.id = l.stage_id
    where l.contact_id = ${schema.contact.id}
    limit 1
  )`;

  /**
   * 067 — Para la ventana gratuita: cuándo escribió el cliente por primera vez y
   * cuándo se le contestó por primera vez. Con el índice
   * (organización, conversación, fecha) que ya existe, es barato.
   */
  const primerEntranteSql = sql<string | null>`(
    select min(m.created_at) from message m
    where m.conversation_id = ${schema.conversation.id} and m.direction = 'inbound'
  )`;
  const primerSalienteSql = sql<string | null>`(
    select min(m.created_at) from message m
    where m.conversation_id = ${schema.conversation.id} and m.direction = 'outbound'
  )`;

  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
      preview: previewSql,
      stageName: stageSql,
      anuncio: anuncioDeLista,
      primerEntrante: primerEntranteSql,
      primerSaliente: primerSalienteSql,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .leftJoin(schema.adAttribution, anuncioDeLaConversacion)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        since ? gt(schema.conversation.updatedAt, since) : undefined
      )
    )
    .orderBy(desc(sql`coalesce(${schema.conversation.lastMessageAt}, ${schema.conversation.createdAt})`));

  return rows.map((r) =>
    serializeConversation(
      r.conversation,
      r.contact,
      r.preview,
      r.stageName,
      aAnuncioDeLista(r.anuncio),
      { primerEntrante: r.primerEntrante, primerSaliente: r.primerSaliente }
    )
  );
}

export async function getConversation(
  organizationId: string,
  conversationId: string
) {
  const db = getDb();
  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
      anuncio: anuncioDeLista,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .leftJoin(schema.adAttribution, anuncioDeLaConversacion)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  const row = rows[0];
  return row ? { ...row, anuncio: aAnuncioDeLista(row.anuncio) } : null;
}

export async function listMessages(
  organizationId: string,
  conversationId: string,
  since?: Date
) {
  const db = getDb();
  return db
    .select({ message: schema.message, media: schema.mediaAsset })
    .from(schema.message)
    .leftJoin(
      schema.mediaAsset,
      eq(schema.message.mediaAssetId, schema.mediaAsset.id)
    )
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId),
        since ? gt(schema.message.createdAt, since) : undefined
      )
    )
    .orderBy(schema.message.createdAt);
}

export function serializeConversation(
  c: typeof schema.conversation.$inferSelect,
  contact: typeof schema.contact.$inferSelect,
  preview: string | null = null,
  stageName: string | null = null,
  anuncio: ConversationDto["anuncio"] = null,
  /** 067 — Primer mensaje del cliente y primera respuesta, para el costo. */
  mensajes: { primerEntrante: string | null; primerSaliente: string | null } | null = null
): ConversationDto {
  const caps = capabilitiesFor(c.channel);
  // 067 — Ventana gratuita: solo tiene sentido en una conversación que nació de
  // un anuncio. Se calcula aquí, con la hora del SERVIDOR: el reloj del
  // navegador no decide si la ventana está abierta.
  const ventana = mensajes
    ? ventanaGratuita({
        llegoPorAnuncio: anuncio !== null,
        primerEntrante: aFecha(mensajes.primerEntrante),
        primerSaliente: aFecha(mensajes.primerSaliente),
      })
    : null;
  // 024: la extensión humana solo existe en los canales que la declaran.
  const reply =
    caps.humanAgentWindowMs !== null
      ? replyWindow(c.channel, c.lastInboundAt)
      : null;
  return {
    id: c.id,
    channel: c.channel,
    contact: { id: contact.id, name: contact.name, phone: contact.phone },
    // 067 — Las etiquetas viajan con la conversación para poder filtrar la
    // Bandeja por ellas sin una petición más por hilo.
    tags: (contact.tags as string[] | null) ?? [],
    stageName,
    // 067 — Solo se manda cuando hay algo que contar (`no_aplica` viaja null).
    ventanaGratuita:
      ventana && ventana.estado !== "no_aplica"
        ? {
            estado: ventana.estado,
            limite: ventana.limite?.toISOString() ?? null,
          }
        : null,
    aiEnabled: c.aiEnabled,
    handoffAt: c.handoffAt?.toISOString() ?? null,
    handoffReason: c.handoffReason,
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    unreadCount: c.unreadCount,
    // 022: la ventana es la del canal (48 h en TikTok, 24 en los demás).
    windowOpen: isWindowOpen(c.lastInboundAt, new Date(), windowMsFor(c.channel)),
    windowRemainingMs: windowRemainingMs(
      c.lastInboundAt,
      new Date(),
      windowMsFor(c.channel)
    ),
    humanWindow: reply
      ? { open: reply.humanAgentTag, remainingMs: reply.humanAgentTag ? reply.operatorRemainingMs : 0 }
      : null,
    composer: {
      media: caps.outboundMedia,
      structured: caps.structuredMessages,
      // 039: la UI solo ofrece «Responder» donde el canal cita.
      quoteReply: caps.quoteReplies,
    },
    preview,
    anuncio,
  };
}

export async function updateConversation(
  organizationId: string,
  conversationId: string,
  patch: { aiEnabled?: boolean; reactivate?: boolean; markRead?: boolean }
) {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.aiEnabled !== undefined) set.aiEnabled = patch.aiEnabled;
  if (patch.reactivate) {
    set.handoffAt = null;
    set.handoffReason = null;
    set.aiEnabled = patch.aiEnabled ?? true;
  }
  if (patch.markRead) set.unreadCount = 0;

  const updated = await db
    .update(schema.conversation)
    .set(set)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, conversationId)
      )
    )
    .returning();
  return updated[0] ?? null;
}
