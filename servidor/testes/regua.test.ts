import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  pontoNormalizadoValido,
  dimensoesMapaValidas,
  calibracaoValida,
  distanciaMapa,
  distanciaReal,
  medirRegua,
  arredondarParaApresentacao,
  type CalibracaoRegua,
} from "../src/lib/regua.js";

const QUADRADO = { largura: 1000, altura: 1000 };
const PANORAMICO = { largura: 2000, altura: 500 };
const VERTICAL = { largura: 400, altura: 1600 };
const p = (x: number, y: number) => ({ x, y });

describe("pontoNormalizadoValido", () => {
  it("aceita pontos em [0,1] inclusive nas bordas", () => {
    for (const pt of [p(0, 0), p(1, 1), p(0.5, 0.25), p(1, 0), p(0, 1)]) {
      assert.equal(pontoNormalizadoValido(pt), true);
    }
  });
  it("rejeita fora de [0,1], NaN, infinito e tipos errados", () => {
    for (const pt of [p(-0.1, 0.5), p(0.5, 1.01), p(NaN, 0.5), p(0.5, Infinity), p(-Infinity, 0), null, "x", { x: "0.5", y: 0.5 }, {}]) {
      assert.equal(pontoNormalizadoValido(pt), false, JSON.stringify(pt));
    }
  });
});

describe("dimensoesMapaValidas", () => {
  it("aceita dimensões positivas finitas", () => {
    assert.equal(dimensoesMapaValidas(QUADRADO), true);
    assert.equal(dimensoesMapaValidas({ largura: 0.001, altura: 1e9 }), true);
  });
  it("rejeita zero, negativo, NaN, infinito e ausente", () => {
    for (const d of [
      { largura: 0, altura: 100 }, { largura: 100, altura: 0 },
      { largura: -5, altura: 100 }, { largura: 100, altura: -5 },
      { largura: NaN, altura: 100 }, { largura: Infinity, altura: 100 },
      { largura: 100 }, {}, null, undefined,
    ]) {
      assert.equal(dimensoesMapaValidas(d), false, JSON.stringify(d));
    }
  });
});

describe("distanciaMapa", () => {
  it("horizontal em mapa quadrado", () => {
    const r = distanciaMapa(p(0, 0.5), p(1, 0.5), QUADRADO);
    assert.deepEqual(r, { ok: true, valor: 1000 });
  });
  it("vertical em mapa quadrado", () => {
    const r = distanciaMapa(p(0.5, 0), p(0.5, 1), QUADRADO);
    assert.deepEqual(r, { ok: true, valor: 1000 });
  });
  it("diagonal em mapa quadrado (Pitágoras)", () => {
    const r = distanciaMapa(p(0, 0), p(1, 1), QUADRADO);
    assert.ok(r.ok);
    assert.ok(Math.abs(r.valor - Math.SQRT2 * 1000) < 1e-9);
  });
  it("mesma distância normalizada em mapa panorâmico estica o eixo X", () => {
    const r = distanciaMapa(p(0, 0), p(1, 1), PANORAMICO);
    assert.ok(r.ok);
    assert.ok(Math.abs(r.valor - Math.sqrt(2000 ** 2 + 500 ** 2)) < 1e-9);
    // vertical no mesmo mapa é 4x menor que a horizontal para mesmo delta
    const v = distanciaMapa(p(0, 0), p(0, 1), PANORAMICO);
    assert.ok(v.ok && Math.abs(v.valor - 500) < 1e-9);
  });
  it("mapa vertical inverte a correção de aspecto", () => {
    const r = distanciaMapa(p(0, 0), p(1, 1), VERTICAL);
    assert.ok(r.ok);
    assert.ok(Math.abs(r.valor - Math.sqrt(400 ** 2 + 1600 ** 2)) < 1e-9);
  });
  it("não depende do viewport: dimensões do mapa bastam", () => {
    // Duas "telas" diferentes renderizando o mesmo mapa normalizado
    // produzem a mesma distância — a função nem recebe viewport.
    const a = distanciaMapa(p(0.1, 0.2), p(0.9, 0.8), QUADRADO);
    const b = distanciaMapa(p(0.1, 0.2), p(0.9, 0.8), QUADRADO);
    assert.deepEqual(a, b);
  });
  it("pontos nas bordas 0 e 1 são medidos normalmente", () => {
    const r = distanciaMapa(p(0, 0), p(1, 1), QUADRADO);
    assert.ok(r.ok && r.valor > 0);
  });
  it("pontos idênticos medem zero", () => {
    const r = distanciaMapa(p(0.3, 0.7), p(0.3, 0.7), QUADRADO);
    assert.deepEqual(r, { ok: true, valor: 0 });
  });
  it("rejeita pontos inválidos e dimensões inválidas", () => {
    assert.equal(distanciaMapa(p(-0.1, 0), p(0.5, 0.5), QUADRADO).ok, false);
    assert.equal(distanciaMapa(p(0, 0), p(1.2, 0.5), QUADRADO).ok, false);
    assert.equal(distanciaMapa(p(0, 0), p(0.5, 0.5), { largura: 0, altura: 10 }).ok, false);
    assert.equal(distanciaMapa(p(NaN, 0), p(0.5, 0.5), QUADRADO).ok, false);
  });
  it("valores extremamente grandes permanecem finitos ou falham limpo", () => {
    const dims = { largura: Number.MAX_VALUE, altura: Number.MAX_VALUE };
    const r = distanciaMapa(p(0, 0), p(1, 1), dims);
    // estouro para Infinity deve retornar erro, nunca Infinity silencioso
    if (r.ok) assert.ok(Number.isFinite(r.valor));
    else assert.equal(r.ok, false);
  });
});

describe("calibracaoValida", () => {
  const base: CalibracaoRegua = { unidade: "m", distanciaReferencia: 100, valorReferencia: 1.5 };
  it("aceita calibração válida", () => {
    assert.equal(calibracaoValida(base), true);
    assert.equal(calibracaoValida({ unidade: "hex", distanciaReferencia: 0.5, valorReferencia: 1 }), true);
    assert.equal(calibracaoValida({ unidade: "  casa  ", distanciaReferencia: 2, valorReferencia: 3 }), true);
  });
  it("rejeita unidade vazia, longa demais ou não-string", () => {
    for (const u of ["", "   ", "x".repeat(25), 42, null, undefined]) {
      assert.equal(calibracaoValida({ ...base, unidade: u }), false, String(u));
    }
  });
  it("rejeita referência zero, negativa, NaN ou infinita", () => {
    for (const v of [0, -1, NaN, Infinity, -Infinity]) {
      assert.equal(calibracaoValida({ ...base, distanciaReferencia: v }), false);
      assert.equal(calibracaoValida({ ...base, valorReferencia: v }), false);
    }
  });
  it("rejeita objeto nulo/não-objeto", () => {
    for (const c of [null, undefined, "m", 5, []]) assert.equal(calibracaoValida(c), false);
  });
});

describe("distanciaReal", () => {
  const cal: CalibracaoRegua = { unidade: "m", distanciaReferencia: 100, valorReferencia: 1.5 };
  it("converte proporcionalmente: 50 unidades do mapa = 0,75 m", () => {
    const r = distanciaReal(50, cal);
    assert.ok(r.ok);
    assert.ok(Math.abs(r.valor - 0.75) < 1e-12);
  });
  it("aceita unidades textuais distintas sem mudar a matemática", () => {
    for (const unidade of ["m", "pol", "hex", "casa", "km", "ft"]) {
      const r = distanciaReal(100, { unidade, distanciaReferencia: 100, valorReferencia: 1.5 });
      assert.ok(r.ok);
      assert.ok(Math.abs(r.valor - 1.5) < 1e-12);
    }
  });
  it("rejeita distância negativa, NaN e infinita", () => {
    for (const d of [-1, NaN, Infinity, -Infinity, "10" as unknown as number]) {
      assert.equal(distanciaReal(d, cal).ok, false, String(d));
    }
  });
  it("rejeita calibração inválida", () => {
    assert.equal(distanciaReal(10, { unidade: "", distanciaReferencia: 100, valorReferencia: 1 }).ok, false);
    assert.equal(distanciaReal(10, { unidade: "m", distanciaReferencia: 0, valorReferencia: 1 }).ok, false);
  });
});

describe("medirRegua", () => {
  const cal: CalibracaoRegua = { unidade: "m", distanciaReferencia: 2000, valorReferencia: 3 };
  it("mede sem calibração (unidade nula)", () => {
    const r = medirRegua(p(0, 0), p(0.5, 0), QUADRADO);
    assert.deepEqual(r, { ok: true, valor: { distanciaMapa: 500, distanciaReal: null, unidade: null } });
  });
  it("mede com calibração e converte", () => {
    const r = medirRegua(p(0, 0), p(0.5, 0), QUADRADO, cal);
    assert.ok(r.ok);
    assert.equal(r.valor.distanciaMapa, 500);
    // 500/2000 * 3 = 0,75
    assert.ok(Math.abs((r.valor.distanciaReal ?? 0) - 0.75) < 1e-12);
    assert.equal(r.valor.unidade, "m");
  });
  it("propaga erro de ponto inválido antes de calibrar", () => {
    const r = medirRegua(p(2, 0), p(0.5, 0), QUADRADO, cal);
    assert.equal(r.ok, false);
  });
  it("calibração inválida é erro explícito", () => {
    const r = medirRegua(p(0, 0), p(0.5, 0), QUADRADO, { unidade: "m", distanciaReferencia: -1, valorReferencia: 1 });
    assert.equal(r.ok, false);
  });
  it("calibração null/undefined é tratada como não calibrada", () => {
    for (const c of [null, undefined]) {
      const r = medirRegua(p(0, 0), p(1, 0), QUADRADO, c);
      assert.ok(r.ok && r.valor.distanciaReal === null);
    }
  });
});

describe("arredondarParaApresentacao", () => {
  it("arredonda só para exibição sem tocar o valor interno", () => {
    const interno = 0.7555555555;
    assert.equal(arredondarParaApresentacao(interno, 2), 0.76);
    assert.equal(interno, 0.7555555555); // intocado
  });
  it("respeita casas configuráveis e limites", () => {
    assert.equal(arredondarParaApresentacao(1.23456, 3), 1.235);
    assert.equal(arredondarParaApresentacao(1.2, 0), 1);
    assert.equal(arredondarParaApresentacao(1.005, 2), 1); // float64: 1.005*100 < 100.5
    assert.equal(arredondarParaApresentacao(2.675, 2), 2.68); // Math.round half-up do float64
  });
  it("valores não finitos passam intactos (defesa)", () => {
    assert.equal(arredondarParaApresentacao(NaN), NaN);
    assert.equal(arredondarParaApresentacao(Infinity), Infinity);
  });
});
