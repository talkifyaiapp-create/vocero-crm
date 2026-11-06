import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  IMPORT_MAX_ROWS,
  MAX_TAGS_PER_ROW,
  MAX_TAG_LEN,
  prepareImport,
} from "@/lib/contact-import";
import { importContacts } from "@/server/contacts-import";

export const dynamic = "force-dynamic";

/**
 * Un renglón del archivo. Los topes del texto son los mismos que recorta
 * `prepareImport`; aquí solo se rechaza lo que no cabe de ninguna forma (un
 * email de 10 MB, un arreglo de etiquetas gigante) para no perder el lote
 * entero por un renglón.
 */
const rowSchema = z.object({
  name: z.string().max(200),
  phone: z.string().max(40),
  email: z.string().max(200).optional(),
  source: z.string().max(80).optional(),
  sourceUrl: z.string().max(500).optional(),
  sourceId: z.string().max(200).optional(),
  tags: z.array(z.string().max(MAX_TAG_LEN)).max(MAX_TAGS_PER_ROW).optional(),
  /**
   * 067 — Las dos fechas del archivo de origen.
   *
   * Están declaradas AQUÍ y no solo en `ImportRow` porque Zod descarta en
   * silencio las claves que el esquema no nombra: el navegador las mandaba, el
   * endpoint las borraba, y la ficha llegaba sin fechas sin que nada fallara.
   * Un campo nuevo del importador son DOS cambios, no uno.
   */
  primeraEntrada: z.string().max(40).optional(),
  ultimoContacto: z.string().max(40).optional(),
});

const importSchema = z.object({
  contacts: z.array(rowSchema).min(1).max(IMPORT_MAX_ROWS),
  /** El agente no les responde: los atiende el dueño. */
  aiPaused: z.boolean().optional(),
  /**
   * 067 — Meter a los importados al embudo, en la primera etapa abierta.
   * Apagado por defecto: una lista de clientes no es un embudo.
   */
  createLeads: z.boolean().optional(),
});

/**
 * Importación de contactos en lote (CSV leído en el navegador).
 *
 * El navegador ya validó para enseñar la vista previa, pero aquí se valida
 * otra vez con la MISMA función: lo que llega por la red no es de fiar, y un
 * teléfono sin código de país crearía un contacto que nunca casa con quien
 * escriba después.
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, importSchema);
  if (!body.ok) return body.response;

  const { valid, problems } = prepareImport(body.data.contacts);
  if (valid.length === 0) {
    return apiError(
      422,
      "nothing_to_import",
      "Ningún renglón trae un teléfono válido con código de país"
    );
  }

  const result = await importContacts(session.organizationId, valid, {
    aiPaused: body.data.aiPaused ?? false,
    createLeads: body.data.createLeads ?? false,
    actorUserId: session.userId,
  });
  return Response.json({ ...result, skipped: problems });
});
