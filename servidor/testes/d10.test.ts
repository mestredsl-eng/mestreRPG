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

// ---------- R1.2: elegibilidade de Poderes (selecao_nivel) em testes D10 ----------
// Mesmo critério do socket mesa:teste:pedir — usadoEmTestes explícito
// manda; sem flag, fallback semântico (agora inclui "poder"). O desafio de
// Poder é SEMPRE por elemento: cada item da lista entra como opção própria
// com seu nível individual — nunca soma dos poderes nem custo de aquisição.
import { campoElegivelParaTeste, campoElegivelParaTesteNivel } from "../src/lib/ficha.js";

describe("elegibilidade D10 — Poderes (R1.2)", () => {
  const poder = { tipo: "selecao_nivel" as const, semantico: "poder" as const };

  it("selecao_nivel + semantico poder + flag ausente → elegível (fallback)", () => {
    assert.equal(campoElegivelParaTesteNivel({ ...poder }), true);
  });

  it("selecao_nivel + poder + usadoEmTestes:true → elegível", () => {
    assert.equal(campoElegivelParaTesteNivel({ ...poder, usadoEmTestes: true }), true);
  });

  it("selecao_nivel + poder + usadoEmTestes:false → inelegível (flag vence)", () => {
    assert.equal(campoElegivelParaTesteNivel({ ...poder, usadoEmTestes: false }), false);
  });

  it("selecao_nivel + semântico livre/idade + flag ausente → inelegível", () => {
    assert.equal(campoElegivelParaTesteNivel({ tipo: "selecao_nivel", semantico: "livre" }), false);
    assert.equal(campoElegivelParaTesteNivel({ tipo: "selecao_nivel", semantico: "defeito" }), false);
    assert.equal(campoElegivelParaTesteNivel({ tipo: "selecao_nivel", semantico: "vantagem" }), false);
  });

  it("moeda/item seguem inelegíveis mesmo com usadoEmTestes:true", () => {
    for (const semantico of ["moeda", "item"] as const) {
      assert.equal(campoElegivelParaTesteNivel({ tipo: "selecao_nivel", semantico, usadoEmTestes: true }), false);
      assert.equal(campoElegivelParaTeste({ tipo: "inteiro", semantico, usadoEmTestes: true }), false);
    }
  });

  it("tipos incompatíveis seguem inelegíveis", () => {
    // o helper de elemento só aceita selecao_nivel; o escalar só numérico
    for (const tipo of ["texto", "calculado", "moeda", "data"] as const) {
      assert.equal(campoElegivelParaTesteNivel({ tipo, semantico: "poder", usadoEmTestes: true }), false);
    }
    for (const tipo of ["texto", "selecao_nivel", "lista"] as const) {
      assert.equal(campoElegivelParaTeste({ tipo: tipo as never, semantico: "poder", usadoEmTestes: true }), false);
    }
    // distinção explícita: selecao_nivel NÃO é campo escalar — o nível de
    // cada elemento é resolvido por elementoKey no socket, nunca somado.
    assert.equal(campoElegivelParaTeste({ tipo: "selecao_nivel", semantico: "poder", usadoEmTestes: true }), false);
  });
});
