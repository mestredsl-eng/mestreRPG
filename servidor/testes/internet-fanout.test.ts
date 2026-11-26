/**
 * Testes unitários do helper puro de destinatários do fan-out Internet
 * (incremento F3 absorvido — #350/#351). Executar:
 *   npx tsx servidor/testes/internet-fanout.test.ts
 *
* Cobre a chave de dedup (userId, contaId): mesma pessoa com duas contas
 * participantes recebe um evento por conta; duplicatas exatas caem;
 * ordem de entrada é preservada.
 */
import assert from "node:assert/strict";
import { selecionarDestinatariosInternet } from "../src/lib/internet-fanout.js";

let falhas = 0;
function teste(nome: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok ${nome}`);
  } catch (e) {
    falhas += 1;
    console.error(`  FALHOU ${nome}:`, e);
  }
}

function main() {
  console.log("internet-fanout — dedup (userId, contaId)");

  teste("mesma pessoa com duas contas recebe um evento por conta", () => {
    const out = selecionarDestinatariosInternet([
      { contaId: "c1", userId: "u1" },
      { contaId: "c2", userId: "u1" },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((d) => d.contaId), ["c1", "c2"]);
  });

  teste("duplicata exata (mesmo userId+contaId) cai", () => {
    const out = selecionarDestinatariosInternet([
      { contaId: "c1", userId: "u1" },
      { contaId: "c1", userId: "u1" },
      { contaId: "c2", userId: "u2" },
    ]);
    assert.equal(out.length, 2);
  });

  teste("mesmo userId em contas distintas NÃO deduplica (roteamento)", () => {
    const out = selecionarDestinatariosInternet([
      { contaId: "c1", userId: "u1" },
      { contaId: "c9", userId: "u1" },
    ]);
    assert.equal(out.length, 2);
  });

  teste("mesma contaId sob userIds distintos são destinos distintos", () => {
    // defesa: se a resolução conta→userId mudar, a chave continua correta
    const out = selecionarDestinatariosInternet([
      { contaId: "c1", userId: "u1" },
      { contaId: "c1", userId: "u2" },
    ]);
    assert.equal(out.length, 2);
  });

  teste("ordem de entrada preservada (primeira ocorrência vence)", () => {
    const out = selecionarDestinatariosInternet([
      { contaId: "c3", userId: "u1" },
      { contaId: "c1", userId: "u1" },
      { contaId: "c3", userId: "u1" },
      { contaId: "c2", userId: "u2" },
    ]);
    assert.deepEqual(out.map((d) => `${d.userId}:${d.contaId}`), ["u1:c3", "u1:c1", "u2:c2"]);
  });

  teste("lista vazia → lista vazia", () => {
    assert.deepEqual(selecionarDestinatariosInternet([]), []);
  });

  if (falhas) {
    console.error(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log("\ninternet-fanout: tudo verde");
}

main();
