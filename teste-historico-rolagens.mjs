import assert from "node:assert/strict";
import { resumirRolagemHistorico } from "./site/src/lib/rolagensHistorico.ts";

const d20 = resumirRolagemHistorico(
  [{ sides: 20, count: 2 }],
  [{ sides: 20, count: 2, resultados: [13, 18] }],
);
assert.equal(d20.descricao, "2d20");
assert.deepEqual(d20.valores, [13, 18]);

const d10 = resumirRolagemHistorico(
  [{ sides: 10, count: 3 }],
  [{ sides: 10, count: 3, resultados: [6, 2, 9] }],
);
assert.equal(d10.descricao, "3d10");
assert.deepEqual(d10.valores, [6, 2, 9]);

const dano = resumirRolagemHistorico(
  [{ sides: 6, count: 2 }, { sides: 8, count: 1 }],
  [
    { sides: 6, count: 2, resultados: [4, 5] },
    { sides: 8, count: 1, resultados: [7] },
  ],
);
assert.equal(dano.descricao, "2d6 + 1d8");
assert.deepEqual(dano.valores, [4, 5, 7]);

// Compatibilidade com o formato legado do Socket.IO.
const legado = resumirRolagemHistorico(
  [{ sides: 8, count: 2 }],
  [{ lados: 8, resultados: [3, 6] }],
);
assert.equal(legado.descricao, "2d8");
assert.deepEqual(legado.valores, [3, 6]);

// Registros históricos sem groups continuam usando dice.
const fallback = resumirRolagemHistorico([{ sides: 4, count: 3 }], []);
assert.equal(fallback.descricao, "3d4");
assert.deepEqual(fallback.valores, []);

console.log("histórico de rolagens: 5 cenários passaram");
