#!/usr/bin/env node
// Produtor do primeiro bootstrap (P10-A / Issue #155).
//
// Entry point para o instalador/.bat (integração P10-C): emite
// `bootstrap-autorizacao.json` de USO ÚNICO somente quando a prova
// combinada de instalação limpa passa — banco configurado ausente,
// recibo ausente, autorização consumida ausente, journals de
// update/restauração ausentes, state legível e identidade canônica
// coerente. Qualquer estado corrompido/divergente/desconhecido/
// interrompido bloqueia (fail-closed).
//
// Exit 0 = autorizada agora ou já autorizada (idempotente).
// Exit 1 = bloqueada — nenhuma autorização é emitida.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { autorizarPrimeiroBootstrap } from "./estado-externo.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const r = autorizarPrimeiroBootstrap(repoDir);
if (r.autorizado) {
  console.log(`[bootstrap] ${r.motivo}: autorização de primeiro bootstrap ${r.motivo === "emitida" ? "emitida" : "já existente"} (${repoDir})`);
  process.exit(0);
}
console.log(`[bootstrap] BLOQUEADO (${r.motivo}): não é um primeiro bootstrap limpo — nenhuma autorização emitida.`);
process.exit(1);
