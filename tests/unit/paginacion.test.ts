import { describe, expect, it } from "vitest";
import {
  TAMANOS_DE_PAGINA,
  normalizarOffset,
  normalizarTamanio,
  rangoDePagina,
} from "@/lib/paginacion";

describe("normalizarTamanio", () => {
  it("acepta los tamaños que ofrece la pantalla", () => {
    for (const n of TAMANOS_DE_PAGINA) {
      expect(normalizarTamanio(String(n))).toBe(n);
    }
  });

  // Sin este freno, un `?limit=999999` llegaría a Postgres tal cual.
  it("cualquier otra cosa vuelve al valor por defecto", () => {
    expect(normalizarTamanio("999999")).toBe(50);
    expect(normalizarTamanio("-1")).toBe(50);
    expect(normalizarTamanio("abc")).toBe(50);
    expect(normalizarTamanio(null)).toBe(50);
  });
});

describe("normalizarOffset", () => {
  it("un offset inválido o negativo es la primera página", () => {
    expect(normalizarOffset("100")).toBe(100);
    expect(normalizarOffset("-50")).toBe(0);
    expect(normalizarOffset("abc")).toBe(0);
    expect(normalizarOffset(null)).toBe(0);
  });
});

describe("rangoDePagina", () => {
  it("cuenta desde 1 y dice cuántas páginas hay", () => {
    expect(rangoDePagina(2847, 0, 50)).toEqual({
      desde: 1,
      hasta: 50,
      pagina: 1,
      paginas: 57,
    });
  });

  it("la última página no se pasa del total", () => {
    // 2.847 con 50 por página: la 57 empieza en 2.801 y acaba en 2.847.
    expect(rangoDePagina(2847, 2800, 50)).toEqual({
      desde: 2801,
      hasta: 2847,
      pagina: 57,
      paginas: 57,
    });
  });

  it("una lista vacía es «0–0», en la página 1 de 1", () => {
    expect(rangoDePagina(0, 0, 50)).toEqual({
      desde: 0,
      hasta: 0,
      pagina: 1,
      paginas: 1,
    });
  });

  it("un offset más allá del final se queda en la última página", () => {
    const r = rangoDePagina(120, 10_000, 50);
    expect(r.pagina).toBe(3);
    expect(r.hasta).toBe(120);
  });

  it("con menos contactos que una página, hay una sola página", () => {
    expect(rangoDePagina(8, 0, 50)).toEqual({
      desde: 1,
      hasta: 8,
      pagina: 1,
      paginas: 1,
    });
  });
});
