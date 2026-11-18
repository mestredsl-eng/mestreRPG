import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  avaliarD10, classificarD10, facesExibidasD10, resumoFacesD10, totalD10,
} from "../src/lib/d10.js";

describe("classificarD10 — convenção interno 1–10 / face 0–9", () => {
  it("interno 10 é face 0 e acerto crítico (sempre sucesso, soma 10)", () => {
    for (const minimo of [1, 5, 6, 10]) {
      const r = classificarD10(10, minimo);
      assert.equal(r.face, 0);
      assert.equal(r.classe, "acerto_critico");
      assert.equal(r.sucesso, true);
    }
  });

  it("interno 1 é erro crítico e NUNCA sucesso, mesmo com mínimo 1", () => {
    for (const minimo of [1, 2, 6, 10]) {
      const r = classificarD10(1, minimo);
      assert.equal(r.face, 1);
      assert.equal(r.classe, "erro_critico");
      assert.equal(r.sucesso, false);
    }
  });

  it("faces 2–9 obedecem ao mínimo da campanha", () => {
    assert.equal(classificarD10(9, 6).sucesso, true);
    assert.equal(classificarD10(6, 6).sucesso, true);
    assert.equal(classificarD10(5, 6).sucesso, false);
    assert.equal(classificarD10(2, 1).sucesso, true);
    assert.equal(classificarD10(2, 6).sucesso, false);
    assert.equal(classificarD10(9, 6).classe, "acerto");
    assert.equal(classificarD10(5, 6).classe, "erro");
  });
});

describe("avaliarD10 — fixtures determinísticas", () => {
  it("exemplo oficial: faces 0, 1, 4, 8 → total 23, 2 sucessos / 2 falhas (mín 6)", () => {
    // internos equivalentes: 10, 1, 4, 8
    const internos = [10, 1, 4, 8];
    const av = avaliarD10(internos, 6);
    assert.deepEqual(facesExibidasD10(internos), [0, 1, 4, 8]);
    assert.deepEqual(resumoFacesD10(internos), "0, 1, 4, 8");
    assert.equal(totalD10(internos), 23);
    assert.equal(av.sucessos, 2); // 0 (crítico) + 8
    assert.equal(av.falhas, 2);   // 1 (crítico) + 4
    assert.deepEqual(av.avaliacao.map((a) => a.classe), [
      "acerto_critico", "erro_critico", "erro", "acerto",
    ]);
  });

  it("rolagem livre 4 + 8 → total 12 (sem classificação D10)", () => {
    assert.equal(totalD10([4, 8]), 12);
  });

  it("mínimo 1: erro crítico continua falha; demais passam", () => {
    const av = avaliarD10([10, 1, 2, 9], 1);
    assert.equal(av.sucessos, 3); // 10, 2, 9
    assert.equal(av.falhas, 1);   // 1 — erro crítico
    assert.equal(av.avaliacao[1].classe, "erro_critico");
  });

  it("mínimo 10: só o crítico (face 0) passa", () => {
    const av = avaliarD10([10, 9, 1], 10);
    assert.equal(av.sucessos, 1);
    assert.equal(av.falhas, 2);
  });
});
