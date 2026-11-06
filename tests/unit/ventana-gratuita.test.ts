import { describe, expect, it } from "vitest";
import {
  VENTANA_DE_ATENCION_MS,
  VENTANA_GRATUITA_MS,
  msHasta,
  ventanaGratuita,
} from "@/lib/ventana-gratuita";

const ENTRANTE = new Date("2026-11-06T10:00:00-05:00");
const horas = (n: number) => new Date(ENTRANTE.getTime() + n * 60 * 60 * 1000);

describe("ventanaGratuita", () => {
  it("si no vino de un anuncio, no hay nada que contar", () => {
    expect(
      ventanaGratuita({
        llegoPorAnuncio: false,
        primerEntrante: ENTRANTE,
        primerSaliente: horas(1),
        ahora: horas(2),
      })
    ).toEqual({ estado: "no_aplica", limite: null });
  });

  it("sin mensaje entrante tampoco: no hay conversación que abrir", () => {
    expect(
      ventanaGratuita({
        llegoPorAnuncio: true,
        primerEntrante: null,
        primerSaliente: null,
        ahora: horas(2),
      })
    ).toEqual({ estado: "no_aplica", limite: null });
  });

  it("recién llegado y sin respuesta: hay plazo y se sabe hasta cuándo", () => {
    const v = ventanaGratuita({
      llegoPorAnuncio: true,
      primerEntrante: ENTRANTE,
      primerSaliente: null,
      ahora: horas(3),
    });
    expect(v.estado).toBe("por_abrir");
    expect(v.limite?.getTime()).toBe(
      ENTRANTE.getTime() + VENTANA_DE_ATENCION_MS
    );
  });

  // El caso que cuesta dinero: nadie contestó y se pasaron las 24 h.
  it("pasadas las 24 h sin respuesta, la ventana se perdió", () => {
    expect(
      ventanaGratuita({
        llegoPorAnuncio: true,
        primerEntrante: ENTRANTE,
        primerSaliente: null,
        ahora: horas(25),
      }).estado
    ).toBe("perdida");
  });

  it("respuesta dentro de las 24 h: abierta 7 días desde ESA respuesta", () => {
    const respuesta = horas(2);
    const v = ventanaGratuita({
      llegoPorAnuncio: true,
      primerEntrante: ENTRANTE,
      primerSaliente: respuesta,
      ahora: horas(3),
    });
    expect(v.estado).toBe("abierta");
    expect(v.limite?.getTime()).toBe(respuesta.getTime() + VENTANA_GRATUITA_MS);
  });

  it("respuesta tardía (más de 24 h): no se abrió", () => {
    expect(
      ventanaGratuita({
        llegoPorAnuncio: true,
        primerEntrante: ENTRANTE,
        primerSaliente: horas(30),
        ahora: horas(31),
      }).estado
    ).toBe("perdida");
  });

  it("respondida justo en el límite de 24 h sí cuenta", () => {
    const justo = new Date(ENTRANTE.getTime() + VENTANA_DE_ATENCION_MS);
    expect(
      ventanaGratuita({
        llegoPorAnuncio: true,
        primerEntrante: ENTRANTE,
        primerSaliente: justo,
        ahora: horas(25),
      }).estado
    ).toBe("abierta");
  });

  it("una respuesta anterior al mensaje del cliente no abre nada", () => {
    expect(
      ventanaGratuita({
        llegoPorAnuncio: true,
        primerEntrante: ENTRANTE,
        // Una plantilla que la empresa mandó antes no es "la respuesta".
        primerSaliente: horas(-5),
        ahora: horas(1),
      }).estado
    ).toBe("por_abrir");
  });

  it("pasados los 7 días, la ventana está expirada y se dice cuándo terminó", () => {
    const respuesta = horas(2);
    const v = ventanaGratuita({
      llegoPorAnuncio: true,
      primerEntrante: ENTRANTE,
      primerSaliente: respuesta,
      ahora: new Date(respuesta.getTime() + VENTANA_GRATUITA_MS + 1000),
    });
    expect(v.estado).toBe("expirada");
    expect(v.limite?.getTime()).toBe(respuesta.getTime() + VENTANA_GRATUITA_MS);
  });
});

describe("msHasta", () => {
  it("dice cuánto falta, y negativo cuando ya pasó", () => {
    const ahora = horas(3);
    expect(
      msHasta({ estado: "por_abrir", limite: horas(4) }, ahora)
    ).toBe(60 * 60 * 1000);
    expect(
      msHasta({ estado: "expirada", limite: horas(2) }, ahora)
    ).toBe(-60 * 60 * 1000);
    expect(msHasta({ estado: "perdida", limite: null }, ahora)).toBeNull();
  });
});
