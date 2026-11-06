-- 067: etiquetas del contacto. Aditiva y anulable: una instancia que nunca las
-- use sigue igual, el código viejo ignora la columna, y no hace falta backfill
-- (NULL = nadie lo ha etiquetado, que no es lo mismo que una lista vacía).
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "tags" jsonb;
