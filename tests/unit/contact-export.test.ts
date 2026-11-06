import { describe, expect, it } from "vitest";
import {
  clavesExtraDeFicha,
  csvCell,
  filasDeExportacion,
  toCsv,
  type ExportContacto,
} from "@/lib/contact-export";
import { readImportFile } from "@/lib/contact-import";

const base: ExportContacto = {
  name: "Ana Pérez",
  phone: "573001234567",
  stageName: "Lead",
  source: "facebook",
  anuncio: "Curso de inglés",
  adId: "120210",
  adUrl: "https://fb.com/a1",
  notes: null,
  archived: false,
  tags: ["vip", "mayorista"],
  ficha: { email: "ana@x.com", source: "facebook", source_url: "https://fb.com/a1", source_id: "120210" },
};

describe("csvCell", () => {
  it("escapa comillas cuando el texto trae el separador o un salto", () => {
    expect(csvCell("Pérez, Ana")).toBe("Pérez, Ana");
    expect(csvCell("Pérez; Ana")).toBe('"Pérez; Ana"');
    expect(csvCell('dijo "hola"')).toBe('"dijo ""hola"""');
    expect(csvCell("dos\nlineas")).toBe('"dos\nlineas"');
  });

  it("null y undefined son celda vacía, no la palabra «null»", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("lleva BOM y CRLF: sin ellos Excel rompe los acentos y pega los renglones", () => {
    const csv = toCsv(["a", "b"], [["1", "2"]]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toBe("\uFEFFa;b\r\n1;2\r\n");
  });
});

describe("filasDeExportacion", () => {
  it("pone el bloque fijo en orden y añade las claves de ficha sin columna", () => {
    const { headers, rows } = filasDeExportacion([
      { ...base, ficha: { ...base.ficha, presupuesto: 50000 } },
    ]);
    expect(headers).toEqual([
      "Nombre",
      "Teléfono",
      "Email",
      "Etiquetas",
      "Etapa",
      "Fuente",
      "Anuncio",
      "Ad ID",
      "URL del anuncio",
      "Notas",
      "Archivado",
      "Presupuesto",
    ]);
    expect(rows[0]).toEqual([
      "Ana Pérez",
      "+573001234567",
      "ana@x.com",
      "vip, mayorista",
      "Lead",
      "facebook",
      "Curso de inglés",
      "120210",
      "https://fb.com/a1",
      "",
      "No",
      "50000",
    ]);
  });

  // La ficha tiene claves que el agente inventa: ninguna puede quedarse fuera.
  it("reúne las claves extra de todos los contactos, sin repetir y ordenadas", () => {
    const extra = clavesExtraDeFicha([
      { ...base, ficha: { presupuesto: 1, zona: "norte" } },
      { ...base, ficha: { zona: "sur", dolor: "precio" } },
    ]);
    expect(extra).toEqual(["dolor", "presupuesto", "zona"]);
  });

  it("las claves que ya tienen columna no se duplican al final", () => {
    const extra = clavesExtraDeFicha([base]);
    expect(extra).toEqual([]);
  });

  it("sin anuncio de Meta, usa lo que trajo la ficha del archivo", () => {
    const { headers, rows } = filasDeExportacion([
      {
        ...base,
        anuncio: null,
        adId: null,
        adUrl: null,
        ficha: { Anuncio: "Promo enero", source_id: "999", source_url: "https://x.co/a" },
      },
    ]);
    const i = (h: string) => headers.indexOf(h);
    expect(rows[0]![i("Anuncio")]).toBe("Promo enero");
    expect(rows[0]![i("Ad ID")]).toBe("999");
    expect(rows[0]![i("URL del anuncio")]).toBe("https://x.co/a");
  });
});

describe("ida y vuelta: exportar y volver a importar", () => {
  it("el CSV que sale se puede volver a importar sin perder etiquetas ni teléfono", () => {
    const { headers, rows } = filasDeExportacion([base]);
    const csv = toCsv(headers, rows);
    const read = readImportFile(csv);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.problems).toEqual([]);
    expect(read.valid).toEqual([
      {
        name: "Ana Pérez",
        // El `+` que se ve se ignora al normalizar: la identidad sigue igual.
        phone: "573001234567",
        email: "ana@x.com",
        source: "facebook",
        sourceUrl: "https://fb.com/a1",
        sourceId: "120210",
        tags: ["vip", "mayorista"],
      },
    ]);
  });
});
