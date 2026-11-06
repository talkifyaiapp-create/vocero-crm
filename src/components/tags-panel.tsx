"use client";

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Tope de cada etiqueta; el mismo que aplica el servidor. */
const MAX_TAG_LEN = 40;

/**
 * 067 — Las etiquetas del contacto, donde se trabaja con él.
 *
 * Existe en TRES sitios (ventana del contacto, panel de la Bandeja y cajón del
 * Pipeline) y por eso es un solo componente: el mismo dato con tres puertas, no
 * tres implementaciones que se separan al primer cambio. Antes vivía solo en la
 * ventana del contacto, y quien atendía el chat tenía que salir a otra pantalla
 * para etiquetar.
 *
 * Guarda al momento y no con un botón: una etiqueta es aditiva y no hay nada
 * que confirmar; un cambio a medias porque alguien cerró el panel se perdería
 * sin que nadie se entere.
 *
 * Las etiquetas se crean al usarlas: no hay catálogo aparte. Las que ya existen
 * en la organización se ofrecen como sugerencia para no inventar sinónimos.
 */
export function TagsPanel({
  contactId,
  tags,
  onChange,
}: {
  contactId: string;
  tags: string[];
  /** La lista que quedó, ya guardada y normalizada por el servidor. */
  onChange: (tags: string[]) => void;
}) {
  const [nueva, setNueva] = useState("");
  const [sugerencias, setSugerencias] = useState<string[]>([]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    void (async () => {
      const res = await fetch("/api/contacts/tags").catch(() => null);
      if (!res?.ok) return;
      const data = (await res.json()) as { tags: string[] };
      if (vivo) setSugerencias(data.tags);
    })();
    return () => {
      vivo = false;
    };
  }, [contactId]);

  async function guardar(next: string[]) {
    const previas = tags;
    // Optimista: la etiqueta aparece al instante y se revierte si el guardado
    // falla. Un panel que "piensa" medio segundo por etiqueta invita a repetir.
    onChange(next);
    setGuardando(true);
    setError(null);
    const res = await fetch(`/api/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: next }),
    }).catch(() => null);
    setGuardando(false);
    if (!res?.ok) {
      onChange(previas);
      setError("No se pudieron guardar las etiquetas.");
      return;
    }
    const data = (await res.json().catch(() => null)) as
      | { contact?: { tags?: string[] } }
      | null;
    // El servidor normaliza: sin repetir, sin distinguir mayúsculas.
    if (data?.contact?.tags) onChange(data.contact.tags);
  }

  function agregar() {
    const limpia = nueva.replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LEN);
    if (!limpia) return;
    setNueva("");
    if (tags.some((t) => t.toLowerCase() === limpia.toLowerCase())) return;
    void guardar([...tags, limpia]);
  }

  const idLista = `tags-${contactId}`;

  return (
    <section className="border-b p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="kicker">Etiquetas</p>
      </div>

      {tags.length === 0 ? (
        <p className="text-xs leading-relaxed text-text-3">
          Sin etiquetas. Sirven para agrupar por producto, cliente, ciudad… sin
          tocar el embudo.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2 py-0.5 text-xs"
            >
              {t}
              <button
                type="button"
                aria-label={`Quitar la etiqueta ${t}`}
                disabled={guardando}
                onClick={() => void guardar(tags.filter((x) => x !== t))}
                className="rounded-full p-0.5 text-text-3 hover:text-danger"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 flex gap-1.5">
        <Input
          list={idLista}
          value={nueva}
          onChange={(e) => setNueva(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              agregar();
            }
          }}
          placeholder="Añadir etiqueta…"
          aria-label="Nueva etiqueta"
          className="h-8 text-xs"
        />
        <datalist id={idLista}>
          {sugerencias
            .filter((s) => !tags.some((t) => t.toLowerCase() === s.toLowerCase()))
            .map((s) => (
              <option key={s} value={s} />
            ))}
        </datalist>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={agregar}
          disabled={!nueva.trim() || guardando}
          className="shrink-0"
        >
          <Plus className="h-3.5 w-3.5" />
          Añadir
        </Button>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-text-3">
        Escribe la etiqueta y pulsa Enter. Se crea al usarla: no hay un catálogo
        aparte.
      </p>

      {error && <p className="mt-1 text-[11px] text-danger-text">{error}</p>}
    </section>
  );
}
