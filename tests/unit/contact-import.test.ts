import { describe, expect, it } from "vitest";
import {
  detectColumns,
  fechaDeArchivo,
  fichaDeFila,
  fuenteCanonica,
  mergeTags,
  normalizeImportPhone,
  parseCsv,
  parseTags,
  prepareImport,
  readImportFile,
} from "@/lib/contact-import";

describe("parseCsv", () => {
  it("respeta comillas, comas dentro de un campo y BOM", () => {
    const rows = parseCsv('﻿nombre,telefono\r\n"Pérez, Ana",5215512345678\r\n');
    expect(rows).toEqual([
      ["nombre", "telefono"],
      ["Pérez, Ana", "5215512345678"],
    ]);
  });

  it("detecta el punto y coma de Excel en español", () => {
    expect(parseCsv("nombre;telefono\nAna;573001234567")).toEqual([
      ["nombre", "telefono"],
      ["Ana", "573001234567"],
    ]);
  });

  it("descarta renglones vacíos", () => {
    expect(parseCsv("nombre,telefono\n\n,\nAna,573001234567\n")).toHaveLength(2);
  });
});

describe("detectColumns", () => {
  it("encuentra nombre, apellido y teléfono sin importar acentos ni mayúsculas", () => {
    expect(detectColumns(["Nombre", "Apellido", "Email", "Teléfono"])).toEqual({
      name: 0,
      surname: 1,
      phone: 3,
      email: 2,
      tags: null,
      source: null,
      sourceUrl: null,
      sourceId: null,
      primeraEntrada: null,
      ultimoContacto: null,
    });
  });

  it("sin columna de teléfono no adivina", () => {
    expect(detectColumns(["nombre", "monto"])).toBeNull();
  });

  // 067: las columnas de la atribución que trae un export de otra herramienta.
  it("reconoce etiquetas y atribución en español y en inglés", () => {
    const cols = detectColumns([
      "nombre",
      "telefono",
      "email",
      "etiquetas",
      "fuente",
      "source_url",
      "source_id",
    ]);
    expect(cols).toEqual({
      name: 0,
      surname: null,
      phone: 1,
      email: 2,
      tags: 3,
      source: 4,
      sourceUrl: 5,
      sourceId: 6,
      primeraEntrada: null,
      ultimoContacto: null,
    });
  });

  /**
   * 067 — El encabezado REAL de un export de yCloud. Antes de los alias,
   * `Nickname` no casaba con nada y la importación moría entera.
   */
  it("reconoce el encabezado de yCloud, con Nickname y sus dos fechas", () => {
    expect(
      detectColumns([
        "Nickname",
        "PhoneNumber",
        "Username",
        "Email",
        "Country/Region",
        "Source",
        "Source URL",
        "Source ID",
        "Last contacted",
        "Create time",
        "Tags",
      ])
    ).toEqual({
      name: 0,
      surname: null,
      phone: 1,
      email: 3,
      tags: 10,
      source: 5,
      sourceUrl: 6,
      sourceId: 7,
      primeraEntrada: 9,
      ultimoContacto: 8,
    });
  });

  /**
   * El caso que rompía: `source` cae a "empieza por" y reclamaba la columna de
   * `source_url`, dejando la atribución a medias y la fuente con una URL.
   */
  it("`source` no se come la columna de `source_url`", () => {
    const cols = detectColumns([
      "nombre",
      "telefono",
      "source",
      "source_url",
      "source_id",
    ]);
    expect(cols?.source).toBe(2);
    expect(cols?.sourceUrl).toBe(3);
    expect(cols?.sourceId).toBe(4);
  });

  it("un archivo solo con source_url no deja la fuente apuntando a la URL", () => {
    const cols = detectColumns(["nombre", "telefono", "source_url"]);
    expect(cols?.sourceUrl).toBe(2);
    expect(cols?.source).toBeNull();
  });
});

describe("normalizeImportPhone", () => {
  it("normaliza el 521 de México igual que la ingesta", () => {
    expect(normalizeImportPhone("+52 1 55 1234 5678")).toEqual({
      ok: true,
      phone: "525512345678",
    });
  });

  it("rechaza un número local: sin código de país nunca casaría con quien escriba", () => {
    expect(normalizeImportPhone("55 1234 5678")).toEqual({
      ok: false,
      reason: "sin_codigo_pais",
    });
  });

  it("distingue vacío de inválido", () => {
    expect(normalizeImportPhone("")).toEqual({ ok: false, reason: "sin_telefono" });
    expect(normalizeImportPhone("1234567890123456")).toEqual({
      ok: false,
      reason: "telefono_invalido",
    });
  });

  /**
   * 067 — el `+` es de presentación. Guardarlo rompería la identidad: Meta
   * manda el `from` sin `+`, y el contacto importado nunca casaría.
   */
  it("guarda SOLO dígitos, con o sin `+` en el archivo", () => {
    const con = normalizeImportPhone("+57 300 123 4567");
    const sin = normalizeImportPhone("573001234567");
    expect(con).toEqual(sin);
    expect(con.ok && con.phone).toBe("573001234567");
    expect(con.ok && con.phone.includes("+")).toBe(false);
  });
});

describe("parseTags", () => {
  it("acepta coma, punto y coma y barra vertical", () => {
    expect(parseTags("vip, mayorista; bogotá|cliente")).toEqual([
      "vip",
      "mayorista",
      "bogotá",
      "cliente",
    ]);
  });

  it("no repite aunque cambien mayúsculas, y conserva cómo se escribió", () => {
    expect(parseTags("VIP, vip, Vip")).toEqual(["VIP"]);
  });

  it("ignora vacíos y recorta el espacios", () => {
    expect(parseTags("  dos   palabras ,, ")).toEqual(["dos palabras"]);
    expect(parseTags("")).toEqual([]);
  });
});

describe("mergeTags", () => {
  it("suma sin pisar las que ya estaban", () => {
    expect(mergeTags(["cliente"], ["vip", "Cliente"])).toEqual(["cliente", "vip"]);
  });

  it("no duplica ni distingue mayúsculas", () => {
    expect(mergeTags(["vip"], ["VIP", "nuevo"])).toEqual(["vip", "nuevo"]);
  });
});

describe("fichaDeFila", () => {
  it("lleva a la ficha lo que no cabe en columnas", () => {
    expect(
      fichaDeFila({
        name: "Ana",
        phone: "573001234567",
        email: "ana@x.com",
        source: "facebook",
        sourceUrl: "https://fb.com/anuncio",
        sourceId: "120210",
      })
    ).toEqual({
      email: "ana@x.com",
      source: "facebook",
      source_url: "https://fb.com/anuncio",
      source_id: "120210",
    });
  });

  it("no escribe claves vacías: una ficha con `email: ''` es basura visible", () => {
    expect(fichaDeFila({ name: "Ana", phone: "573001234567" })).toEqual({});
  });

  // 067: las fechas del sistema de origen se leen como una etiqueta más.
  it("guarda las dos fechas con nombre de negocio", () => {
    expect(
      fichaDeFila({
        name: "Ana",
        phone: "573001234567",
        primeraEntrada: "2026-02-23 17:12",
        ultimoContacto: "2026-02-25 06:15",
      })
    ).toEqual({
      "Primera entrada": "2026-02-23 17:12",
      "Último contacto": "2026-02-25 06:15",
    });
  });
});

describe("fuenteCanonica", () => {
  it("traduce el AD de yCloud al enum del CRM", () => {
    expect(fuenteCanonica("AD")).toBe("anuncio");
    expect(fuenteCanonica("ad")).toBe("anuncio");
    expect(fuenteCanonica("organic")).toBe("organico");
  });

  it("respeta los valores que ya son del enum", () => {
    expect(fuenteCanonica("referido")).toBe("referido");
    expect(fuenteCanonica("  Conocido ")).toBe("conocido");
  });

  // `Post` puede ser orgánico o promocionado: adivinarlo sería inventar.
  it("no inventa con lo que no reconoce", () => {
    expect(fuenteCanonica("Post")).toBeNull();
    expect(fuenteCanonica("facebook")).toBeNull();
    expect(fuenteCanonica("")).toBeNull();
    expect(fuenteCanonica(undefined)).toBeNull();
  });
});

describe("fechaDeArchivo", () => {
  it("deja la fecha legible, sin segundos", () => {
    expect(fechaDeArchivo("2026-02-25 06:15:32")).toBe("2026-02-25 06:15");
    expect(fechaDeArchivo("2026-02-25T06:15:32Z")).toBe("2026-02-25 06:15");
  });

  it("no toca una fecha sin hora ni un formato que no conoce", () => {
    expect(fechaDeArchivo("2026-02-25")).toBe("2026-02-25");
    expect(fechaDeArchivo("25/02/2026")).toBe("25/02/2026");
    expect(fechaDeArchivo("")).toBeUndefined();
  });
});

describe("prepareImport", () => {
  it("quita repetidos aunque vengan escritos distinto", () => {
    const { valid, problems } = prepareImport([
      { name: "Ana", phone: "5215512345678" },
      { name: "Ana otra vez", phone: "+52 55 1234 5678" },
    ]);
    expect(valid).toEqual([{ name: "Ana", phone: "525512345678" }]);
    expect(problems).toEqual([{ line: 3, name: "Ana otra vez", reason: "repetido" }]);
  });

  it("sin nombre usa el teléfono, como la ingesta", () => {
    expect(prepareImport([{ name: "  ", phone: "573001234567" }]).valid).toEqual([
      { name: "573001234567", phone: "573001234567" },
    ]);
  });

  /**
   * El renglón repetido se descarta, pero sus etiquetas NO se pierden: se suman
   * a la fila que sí entra. Botarlas enteras perdería datos que el archivo traía.
   */
  it("suma a la primera fila las etiquetas y datos de la repetida", () => {
    const { valid, problems } = prepareImport([
      { name: "Ana", phone: "573001234567", tags: ["vip"] },
      {
        name: "Ana",
        phone: "573001234567",
        tags: ["mayorista"],
        email: "ana@x.com",
      },
    ]);
    expect(valid).toEqual([
      {
        name: "Ana",
        phone: "573001234567",
        tags: ["vip", "mayorista"],
        email: "ana@x.com",
      },
    ]);
    expect(problems).toHaveLength(1);
  });
});

describe("readImportFile", () => {
  it("une nombre y apellido y reporta lo que se queda fuera con su renglón", () => {
    const read = readImportFile(
      "nombre,apellido,email,telefono,pais\nAna,Pérez,a@x.com,573001234567,CO\nLuis,Ruiz,l@x.com,,MX\n"
    );
    expect(read).toEqual({
      ok: true,
      total: 2,
      valid: [{ name: "Ana Pérez", phone: "573001234567", email: "a@x.com" }],
      problems: [{ line: 3, name: "Luis Ruiz", reason: "sin_telefono" }],
    });
  });

  it("lee un export completo de otra herramienta", () => {
    const csv = [
      "nombre;telefono;email;tags;source;source_url;source_id",
      "Ana Pérez;573001234567;ana@x.com;vip, mayorista;facebook;https://fb.com/a1;120210",
    ].join("\r\n");
    const read = readImportFile(csv);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.valid).toEqual([
      {
        name: "Ana Pérez",
        phone: "573001234567",
        email: "ana@x.com",
        source: "facebook",
        sourceUrl: "https://fb.com/a1",
        sourceId: "120210",
        tags: ["vip", "mayorista"],
      },
    ]);
  });

  /**
   * 067 — Una fila REAL de yCloud, con sus rarezas: el nombre se llama
   * `Nickname`, el teléfono viene como `="+57…"` (la trampa de Excel), la fuente
   * es `AD` y hay dos fechas.
   */
  it("lee una fila real de yCloud y normaliza el teléfono con `=\"+57…\"`", () => {
    const csv = [
      "Nickname,PhoneNumber,Username,Email,Country/Region,Source,Source URL,Source ID,Last contacted,Create time,Tags",
      '4l1p,"=""+573162414231""",,,"Colombia",AD,https://fb.me/5Bunjn88u,1202100000000010,2026-02-25 06:15:32,2026-02-23 17:12:21,"vip, cliente"',
    ].join("\r\n");
    const read = readImportFile(csv);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.problems).toEqual([]);
    expect(read.valid).toEqual([
      {
        name: "4l1p",
        phone: "573162414231",
        source: "AD",
        sourceUrl: "https://fb.me/5Bunjn88u",
        sourceId: "1202100000000010",
        tags: ["vip", "cliente"],
        primeraEntrada: "2026-02-23 17:12",
        ultimoContacto: "2026-02-25 06:15",
      },
    ]);
  });

  it("explica qué columnas faltan en vez de importar basura", () => {
    const read = readImportFile("a,b\n1,2\n");
    expect(read.ok).toBe(false);
  });
});
