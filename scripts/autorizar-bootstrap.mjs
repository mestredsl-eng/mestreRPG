#!/usr/bin/env node
// Produtor do primeiro bootstrap (P10-A / Issue #155).
//
// Entry point para o instalador/.bat (integração P10-C). A autorização
// de primeiro bootstrap exige AÇÃO EXPLÍCITA de provisionamento:
//
//   node scripts/autorizar-bootstrap.mjs --confirmar-provisionamento
//
// Com a flag, o entrypoint grava o marcador `provisionamento.json`
// (prova positiva e independente — SEM a flag nada é gravado e o
// produtor bloqueia) e então emite `bootstrap-autorizacao.json` de USO
// ÚNICO somente quando a prova combinada de instalação limpa passa —
// state dir existente e legível, marcador de provisionamento válido,
// banco configurado ausente, recibo ausente, autorização consumida
// ausente, journals de update/restauração ausentes e identidade
// canônica coerente. Qualquer estado corrompido/divergente/
// desconhecido/interrompido bloqueia (fail-closed).
//
// Exit 0 = autorizada agora ou já autorizada (idempotente).
// Exit 1 = bloqueada — nenhuma autorização é emitida.
// Exit 2 = uso incorreto — flag obrigatória ausente.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  autorizarPrimeiroBootstrap, gravarProvisionamento, lerProvisionamento,
} from "./estado-externo.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.argv.slice(2).includes("--confirmar-provisionamento")) {
  console.log("uso: node scripts/autorizar-bootstrap.mjs --confirmar-provisionamento");
  console.log("A autorização de primeiro bootstrap exige ação explícita de provisionamento.");
  process.exit(2);
}

// Ação explícita de provisionamento: grava o marcador SOMENTE se ainda
// não existir — marcador inválido/divergente/corrompido NUNCA é
// sobrescrito; o produtor abaixo bloqueia com o motivo exato.
if (lerProvisionamento(repoDir).status === "ausente") {
  gravarProvisionamento(repoDir);
}

const r = autorizarPrimeiroBootstrap(repoDir);
if (r.autorizado) {
  console.log(`[bootstrap] ${r.motivo}: autorização de primeiro bootstrap ${r.motivo === "emitida" ? "emitida" : "já existente"} (${repoDir})`);
  process.exit(0);
}
console.log(`[bootstrap] BLOQUEADO (${r.motivo}): não é um primeiro bootstrap limpo — nenhuma autorização emitida.`);
process.exit(1);
