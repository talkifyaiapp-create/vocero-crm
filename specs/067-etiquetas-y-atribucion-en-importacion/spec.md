# 067 — Etiquetas, atribución en la ficha y exportar contactos

**Carril**: Ligero, con el modelo de datos dentro.
**Migración**: aditiva `0027` (`contact.tags`).
**Extiende**: `027-importar-contactos` (el importador de nombre y teléfono) y
`018-anuncio-de-origen` (que ya guardaba el anuncio, pero solo por conversación).

## El problema

El CRM tenía una sola dimensión para clasificar personas: el embudo. "Cliente",
"mayorista" o "producto A" no cabían ahí sin inventar una columna por
combinación, así que acababan dentro del nombre o en las notas.

Además, un contacto **importado** no tenía dónde guardar lo que traía el archivo
de otra herramienta (email, fuente, id del anuncio), ni dónde verlo: la ficha
solo se pintaba en la Bandeja y en el cajón del Pipeline, y un importado no
tiene ni conversación ni lead.

## Qué hace

1. **Etiquetas** (`contact.tags`, jsonb). Varias por contacto, ilimitadas por
   organización, con filtro en `/contacts` y exportación por etiqueta. Es la
   segunda dimensión: la etapa dice *dónde está*, la etiqueta dice *qué es*.
2. **Importación enriquecida** (`POST /api/contacts/import`). Entiende
   `email`, `tags`, `source`, `source_url` y `source_id` además de `nombre` y
   `telefono`. Los cuatro últimos van a la **ficha** (texto libre), no a
   `contact.source`, que es un enum cerrado de cinco valores y reventaría el
   lote con un `facebook`.
   - Reimportar **suma** etiquetas; nunca reemplaza las que el dueño puso.
   - La ficha se fusiona (`||` de jsonb): lo que el agente escribió se conserva.
   - El teléfono se guarda **sin `+`** (solo dígitos): es la identidad con la que
     Meta manda el `from`. El `+` es presentación (`formatPhone`).
   - Opción «meterlos al embudo», **apagada por defecto**: quien ya tiene lead no
     se mueve de etapa.
3. **Exportación** (`GET /api/contacts/export`). CSV UTF-8 con BOM, `;` como
   separador y CRLF (lo que Excel en español abre en columnas). Bloque fijo +
   una columna por cada clave de ficha sin columna propia. Respeta los filtros
   de la pantalla (etapa, etiqueta, archivados).
4. **Ventana del contacto** (`ContactDetailDialog`). La misma para todos, no
   solo para los importados: teléfono, etapa, fuente, anuncio de origen,
   etiquetas, ficha editable y notas.

## Contratos

| Endpoint | Cambio |
|---|---|
| `GET /api/contacts` | Nuevo parámetro `tag`; cada contacto trae `tags: string[]` |
| `PATCH /api/contacts/[id]` | Acepta `tags: string[]` (reemplaza la lista completa) |
| `POST /api/contacts/import` | Filas con `email/source/sourceUrl/sourceId/tags`; nuevo `createLeads` |
| `GET /api/contacts/tags` | **Nuevo**: etiquetas vivas de la organización |
| `GET /api/contacts/export` | **Nuevo**: el CSV |

## Decisiones

- **`source` no se escribe en su columna** salvo que el valor sea uno de los
  cinco del enum y la columna esté en NULL. Lo que puso el dueño manda.
- **La ficha se escribe por `mergeFichaEnLote`**, dentro de la puerta única
  (`server/bot/ficha.ts`). El guardarraíl `ficha-guard.test.ts` lo exige: un
  importador que escribiera `ficha` por su cuenta filtraría organización a mano.
- **Los importados NO entran al embudo por defecto.** Es la decisión de 027 y
  sigue en pie: una lista de clientes viejos no es un embudo.
- **La fuente deducida no se exporta.** Si un contacto llegó por un anuncio sin
  que nadie capturara la fuente, la columna «Fuente» va vacía: escribir
  "Anuncio" haría que reimportar el archivo convirtiera una deducción en un dato.

## Pruebas

`tests/unit/contact-import.test.ts` (detección de columnas, `source` vs
`source_url`, normalización sin `+`, etiquetas, fusión de repetidos) y
`tests/unit/contact-export.test.ts` (escapado, BOM/CRLF, columnas dinámicas e
**ida y vuelta**: el CSV exportado se vuelve a importar sin perder nada).

## Lo que NO hace

- No hay multi-pipeline: sigue habiendo un solo embudo por organización.
- Las etiquetas no se crean en un catálogo aparte: existen mientras alguien las
  tenga puestas.
- No hay borrado masivo por etiqueta. 
