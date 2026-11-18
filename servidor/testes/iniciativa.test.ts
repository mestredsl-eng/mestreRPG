import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calcularIniciativa } from "../src/lib/iniciativa.js";
import { npcFichaVisivel } from "../src/lib/npc-visibility.js";

describe("calcularIniciativa", () => {
  it("rola a quantidade configurada de d20 e ordena pela soma", () => {
    const valores = [10, 4, 10, 5, 20, 1];
    let chamadas = 0;
    const resultados = calcularIniciativa([
      { atorId: "jogador-b", nome: "Bia" },
      { atorId: "jogador-a", nome: "Ana" },
      { atorId: "npc:1", nome: "Oponente" },
    ], 2, (quantidade) => Array.from({ length: quantidade }, () => valores[chamadas++]));

    assert.equal(chamadas, 6);
    assert.deepEqual(resultados.map((r) => [r.atorId, r.total]), [
      ["npc:1", 21], ["jogador-a", 15], ["jogador-b", 14],
    ]);
    assert.deepEqual(resultados[0].dados, [20, 1]);
  });

  it("desempata por nome sem diferenciar caixa ou acentos", () => {
    const resultados = calcularIniciativa([
      { atorId: "z", nome: "Zelda" },
      { atorId: "b", nome: "Bia" },
      { atorId: "a", nome: "Álvaro" },
    ], 1, (quantidade) => Array.from({ length: quantidade }, () => 10));

    assert.deepEqual(resultados.map((r) => r.atorId), ["a", "b", "z"]);
  });

  it("rejeita quantidade de dados fora do limite", () => {
    assert.throws(() => calcularIniciativa([], 0, () => []), RangeError);
    assert.throws(() => calcularIniciativa([], 11, () => []), RangeError);
  });
});

describe("npcFichaVisivel", () => {
  it("só libera NPC com metadado explicitamente verdadeiro", () => {
    assert.equal(npcFichaVisivel({ __npcVisivel: { visivel: true } }), true);
    assert.equal(npcFichaVisivel({ __npcVisivel: { visivel: false } }), false);
    assert.equal(npcFichaVisivel({}), false);
    assert.equal(npcFichaVisivel(null), false);
  });
});