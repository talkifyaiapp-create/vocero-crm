"use client";

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { AnuncioDto, ContactDto, FichaDto, FichaValue } from "@/lib/types";
import { formatPhone } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FichaPanel } from "@/components/ficha-panel";
import { AnuncioOrigen } from "@/components/anuncio-origen";
import { SOURCE_LABELS } from "@/server/contact-source";

type Detalle = {
  contact: ContactDto;
  anuncio: AnuncioDto | null;
  stage: { id: string; name: string } | null;
};

/**
 * 067 — La ventana de un contacto: lo que se sabe de él, donde se vea.
 *
 * Antes, la ficha solo aparecía en la Bandeja y en el cajón del Pipeline. Un
 * contacto importado no tiene conversación ni lead, así que sus datos (email,
 * fuente, anuncio de origen) existían en la base y no había forma de verlos.
 *
 * Es la misma ventana para TODOS los contactos, no solo para los importados: la
 * pregunta "¿qué sé de esta persona?" se hace igual venga de donde venga.
 *
 * Lo editable se guarda por dos caminos distintos a propósito:
 * - etiquetas y ficha, al momento (son aditivos, y un dato a medio guardar
 *   porque alguien cerró la ventana se pierde para siempre);
 * - nombre, notas e interruptor del agente, con el botón Guardar.
 */
export function ContactDetailDialog({
  contact,
  sugerencias = [],
  onClose,
  onSaved,
}: {
  contact: ContactDto;
  /** Etiquetas que ya existen en la organización, para el autocompletado. */
  sugerencias?: string[];
  onClose: () => void;
  /** Avisa al listado de que algo cambió. */
  onSaved: () => void;
}) {
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [nombre, setNombre] = useState(contact.name);
  const [notas, setNotas] = useState(contact.notes ?? "");
  const [aiPaused, setAiPaused] = useState(contact.aiPaused ?? false);
  const [tags, setTags] = useState<string[]>(contact.tags ?? []);
  const [ficha, setFicha] = useState<FichaDto>(contact.ficha ?? {});
  const [nuevaTag, setNuevaTag] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // El anuncio de origen y la etapa no vienen en el listado: se piden al abrir.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      const res = await fetch(`/api/contacts/${contact.id}`).catch(() => null);
      if (!res?.ok) return;
      const data = (await res.json()) as Detalle;
      if (!vivo) return;
      setDetalle(data);
      if (data.contact.ficha) setFicha(data.contact.ficha);
      if (data.contact.tags) setTags(data.contact.tags);
    })();
    return () => {
      vivo = false;
    };
  }, [contact.id]);

  async function guardarTags(next: string[]) {
    setTags(next);
    setError(null);
    const res = await fetch(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: next }),
    }).catch(() => null);
    if (!res?.ok) {
      setError("No se pudieron guardar las etiquetas.");
      return;
    }
    onSaved();
    void recargarEtiquetas();
  }

  /** Relee la ficha: el servidor fusiona y devuelve lo que quedó de verdad. */
  async function recargarEtiquetas() {
    const res = await fetch(`/api/contacts/${contact.id}`).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as Detalle;
    setTags(data.contact.tags ?? []);
    if (data.contact.ficha) setFicha(data.contact.ficha);
  }

  async function guardarFicha(patch: Record<string, FichaValue | null>) {
    const res = await fetch(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ficha: patch }),
    }).catch(() => null);
    if (!res?.ok) {
      setError("No se pudo guardar la ficha.");
      return;
    }
    const data = (await res.json()) as { contact?: ContactDto };
    if (data.contact?.ficha) setFicha(data.contact.ficha);
    onSaved();
  }

  function agregarTag() {
    const limpia = nuevaTag.replace(/\s+/g, " ").trim();
    if (!limpia) return;
    if (tags.some((t) => t.toLowerCase() === limpia.toLowerCase())) {
      setNuevaTag("");
      return;
    }
    setNuevaTag("");
    void guardarTags([...tags, limpia]);
  }

  async function guardar() {
    setGuardando(true);
    setError(null);
    const res = await fetch(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: nombre.trim(),
        notes: notas,
        // Solo si cambió: mandarlo siempre reescribiría el interruptor de la
        // Bandeja cada vez que alguien corrige un nombre.
        ...(aiPaused !== (contact.aiPaused ?? false) ? { aiPaused } : {}),
      }),
    }).catch(() => null);
    setGuardando(false);
    if (!res?.ok) {
      setError("No se pudo guardar. Revisa tu conexión.");
      return;
    }
    onSaved();
    onClose();
  }

  const etapa = detalle?.stage?.name ?? contact.stageName ?? null;
  const fuente = contact.source;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-overlay p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Contacto ${contact.name}`}
        className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-lg border bg-popover shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b p-5">
          <ContactAvatar name={contact.name} seed={contact.id} />
          <div className="min-w-0 flex-1">
            <Input
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              aria-label="Nombre del contacto"
              className="h-8 border-transparent bg-transparent px-1 text-base font-semibold hover:border-input"
            />
            <p className="px-1 text-xs text-text-3">{formatPhone(contact.phone)}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 px-1">
              {etapa && <Badge variant="outline">{etapa}</Badge>}
              {fuente && fuente.source === "capturada" && (
                <Badge variant="secondary">{SOURCE_LABELS[fuente.value]}</Badge>
              )}
              {contact.archivedAt && <Badge variant="secondary">Archivado</Badge>}
            </div>
          </div>
          <Button variant="ghost" size="icon" aria-label="Cerrar" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        {detalle?.anuncio && (
          <section className="border-b p-4">
            <p className="kicker mb-2">Anuncio de origen</p>
            <AnuncioOrigen anuncio={detalle.anuncio} />
          </section>
        )}

        <section className="border-b p-4">
          <p className="kicker mb-2">Etiquetas</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.length === 0 && (
              <p className="text-xs text-text-3">
                Sin etiquetas. Sirven para agrupar por producto, cliente, ciudad…
                sin tocar el embudo.
              </p>
            )}
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2 py-0.5 text-xs"
              >
                {t}
                <button
                  type="button"
                  aria-label={`Quitar la etiqueta ${t}`}
                  onClick={() => void guardarTags(tags.filter((x) => x !== t))}
                  className="rounded-full p-0.5 text-text-3 hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <div className="mt-2 flex gap-1.5">
            <Input
              list={`tags-${contact.id}`}
              value={nuevaTag}
              onChange={(e) => setNuevaTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  agregarTag();
                }
              }}
              placeholder="Añadir etiqueta…"
              aria-label="Nueva etiqueta"
              className="h-8 text-xs"
            />
            <datalist id={`tags-${contact.id}`}>
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
              onClick={agregarTag}
              disabled={!nuevaTag.trim()}
              className="shrink-0"
            >
              <Plus className="h-3.5 w-3.5" />
              Añadir
            </Button>
          </div>
          {/* 067 — Se crean al usarlas: no hay un catálogo aparte que mantener, y
              esconder eso hacía pensar que no se podían crear desde aquí. */}
          <p className="mt-1.5 text-[11px] leading-relaxed text-text-3">
            Escribe la etiqueta y pulsa Enter. Se crea al usarla: no hay un
            catálogo aparte.
            {sugerencias.length > 0 && " Al escribir verás las que ya existen."}
          </p>
        </section>

        <FichaPanel ficha={ficha} onSave={guardarFicha} />

        <section className="space-y-3 p-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="detalle-notas">
              Notas
            </label>
            <Textarea
              id="detalle-notas"
              rows={3}
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={aiPaused}
              onChange={(e) => setAiPaused(e.target.checked)}
              className="mt-0.5 accent-primary"
            />
            <span>
              El agente no le responde
              <span className="block text-[11px] text-text-3">
                Sus mensajes llegan a la Bandeja y los atiendes tú.
              </span>
            </span>
          </label>
        </section>

        {error && <p className="px-4 pb-2 text-xs text-danger-text">{error}</p>}

        <footer className="flex justify-end gap-2 border-t p-4">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
          <Button disabled={!nombre.trim() || guardando} onClick={() => void guardar()}>
            {guardando ? "Guardando…" : "Guardar"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
