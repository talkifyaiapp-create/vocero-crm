import { withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

export const dynamic = "force-dynamic";

/**
 * 067 — Las etiquetas que existen en esta organización.
 *
 * Se calculan sobre los contactos y no sobre una tabla de etiquetas a propósito:
 * así no hay que mantener un catálogo sincronizado, y borrar la última persona
 * con una etiqueta la retira del filtro sola. Una etiqueta sin nadie es ruido en
 * el desplegable.
 *
 * Sin tope de contactos: se leen solo los arreglos de etiquetas, no las filas.
 */
export const GET = withAuth(async (session) => {
  const db = getDb();
  const filas = await db
    .select({ tags: schema.contact.tags })
    .from(schema.contact)
    .where(scoped(schema.contact.organizationId, session.organizationId));

  // Sin distinguir mayúsculas ("VIP" y "vip" son la misma), quedándose con la
  // primera forma escrita: es la que el dueño reconocerá.
  const porClave = new Map<string, string>();
  for (const f of filas) {
    for (const tag of (f.tags as string[] | null) ?? []) {
      const limpio = String(tag ?? "").trim();
      if (!limpio) continue;
      const clave = limpio.toLowerCase();
      if (!porClave.has(clave)) porClave.set(clave, limpio);
    }
  }

  const tags = [...porClave.values()].sort((a, b) => a.localeCompare(b, "es"));
  return Response.json({ tags });
});
