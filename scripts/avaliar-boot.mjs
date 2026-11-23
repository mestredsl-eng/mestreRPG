#!/usr/bin/env node
// Gate executável de boot (P10-C / Issue #155).
// Exit 0: instalação conhecida e boot seguro.
// Exit 10: primeiro bootstrap limpo; o BAT deve perguntar S/N.
// Exit 1: estado ambíguo, corrompido, interrompido ou recuperação pendente.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  avaliarBoot,
  diagnosticarBootstrap,
  validarPrecondicoesBootstrap,
} from "./estado-externo.mjs";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modo = process.argv[2] ?? "preflight";
if (modo !== "preflight" && modo !== "validar") {
  console.error("[boot] uso: node scripts/avaliar-boot.mjs preflight|validar");
  process.exit(1);
}

const estado = diagnosticarBootstrap(repoDir);
const boot = avaliarBoot(repoDir);

if (estado === "instalacao-concluida" || estado === "primeiro-bootstrap") {
  if (!boot.seguroIniciar) {
    console.error(`[boot] BLOQUEADO (${boot.motivo}) — estado de recuperação não permite iniciar.`);
    process.exit(1);
  }
  console.log(`[boot] estado conhecido (${estado}); avaliação segura (${boot.motivo}).`);
  process.exit(0);
}

if (estado === "desconhecido" && modo === "preflight") {
  const pre = validarPrecondicoesBootstrap(repoDir);
  // Só oferece consentimento se a prova completa de instalação limpa
  // passou. Qualquer journal, banco, backup, recibo ou estado divergente
  // é bloqueio e nunca deve virar uma pergunta que permita sobrescrever.
  if (pre.pronto && pre.motivo === "limpo") {
    console.log("[boot] primeiro bootstrap limpo detectado; aguardando confirmação explícita do operador.");
    process.exit(10);
  }
  console.error(`[boot] BLOQUEADO (${pre.motivo}) — precondições de primeiro bootstrap não satisfeitas.`);
  process.exit(1);
}

if (estado === "desconhecido" && modo === "validar") {
  console.error("[boot] BLOQUEADO — confirmação não produziu autorização válida.");
  process.exit(1);
}

console.error(`[boot] BLOQUEADO (${estado}) — estado de instalação não reconhecido; nenhum dado será alterado.`);
process.exit(1);
