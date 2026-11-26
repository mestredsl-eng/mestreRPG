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
  removerProvisionamento, validarPrecondicoesBootstrap,
} from "./estado-externo.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.argv.slice(2).includes("--confirmar-provisionamento")) {
  console.log("uso: node scripts/autorizar-bootstrap.mjs --confirmar-provisionamento");
  console.log("A autorização de primeiro bootstrap exige ação explícita de provisionamento.");
  process.exit(2);
}

// Ação explícita de provisionamento — CRASH-SAFE: quando o marcador
// está ausente, TODAS as demais precondições são validadas ANTES de
// gravar provisionamento.json. Assim, um caminho bloqueado não
// escreve nada (nem marcador para reverter) e um kill/crash/queda de
// energia em QUALQUER ponto anterior à escrita não deixa prova
// residual — não existe janela entre "marcador visível" e
// "validação concluída". O marcador só passa a existir depois que o
// estado já foi confirmado limpo, logo persistir após crash é
// verdadeiro (a prova é legítima). Marcador inválido/divergente/
// corrompido NUNCA é sobrescrito — o produtor bloqueia com o motivo.
// O try/rollback abaixo cobre apenas TOCTOU (estado mudou entre a
// pré-validação e a validação final do produtor).
const criadoAgora = lerProvisionamento(repoDir).status === "ausente";
if (criadoAgora) {
  const pre = validarPrecondicoesBootstrap(repoDir);
  if (!pre.pronto) {
    console.log(`[bootstrap] BLOQUEADO (${pre.motivo}): não é um primeiro bootstrap limpo — nada foi gravado.`);
    process.exit(1);
  }
  gravarProvisionamento(repoDir);
}

let r;
try {
  r = autorizarPrimeiroBootstrap(repoDir);
} catch (e) {
  if (criadoAgora) removerProvisionamento(repoDir);
  throw e;
}
if (!r.autorizado && criadoAgora) {
  removerProvisionamento(repoDir);
}
if (r.autorizado) {
  console.log(`[bootstrap] ${r.motivo}: autorização de primeiro bootstrap ${r.motivo === "emitida" ? "emitida" : "já existente"} (${repoDir})`);
  process.exit(0);
}
console.log(`[bootstrap] BLOQUEADO (${r.motivo}): não é um primeiro bootstrap limpo — nenhuma autorização emitida.`);
process.exit(1);
