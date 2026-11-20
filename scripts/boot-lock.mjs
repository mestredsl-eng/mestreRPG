#!/usr/bin/env node
// Lock de boot por instalação (Issue #155).
//
// Impede que dois processos executem em paralelo as etapas mutáveis do
// iniciar-mestre-rpg.bat: auto-update, npm ci, builds, restauração,
// migrations e o próprio servidor — no MESMO diretório de instalação.
//
// Protocolo:
//   adquirir — criação atômica (open 'wx') de um arquivo de lock FORA
//     do worktree (tmpdir), chaveado pelo caminho canônico real do
//     repositório. Metadados: pid do processo proprietário (o cmd.exe
//     do .bat, ou seja process.ppid do node auxiliar), hostname e
//     caminho canônico.
//   Ocupado por pid VIVO na mesma máquina → aguarda /api/health por até
//     120s; se o servidor responder, sai com código 20 ("outra instância
//     assumiu") sem executar nada mutável; se não responder, aborta.
//   Lock comprovadamente obsoleto (mesmo hostname + pid inexistente via
//     kill(pid,0)=ESRCH) → reivindicado por rename atômico e recriado.
//   Metadados inválidos, hostname divergente ou pid não verificável →
//     fail-closed: nunca assume o lock, apenas aguarda/aborta.
//   liberar — somente o processo proprietário (mesmo pid registrado)
//     remove o arquivo. Lock de pid morto é recuperado por `adquirir`,
//     não por `liberar`.
//
// Códigos de saída do CLI: 0 = lock adquirido; 20 = servidor de outra
// instância respondeu (boot deve encerrar sem erro); 1 = abortar.

import { createHash } from "node:crypto";
import {
  closeSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSAO_LOCK = 1;
const TIMEOUT_ESPERA_MS = 120_000;
const INTERVALO_ESPERA_MS = 1_000;
const PORTA_PADRAO = 3001;
const MAX_TENTATIVAS = 3;

/** Caminho canônico do repositório: realpath resolve junctions, 8.3 e
 *  diferenças de caixa no Windows; fallback para resolve(). */
export function caminhoCanonicoRepo(dir) {
  const abs = resolve(dir);
  try {
    const real = realpathSync.native ? realpathSync.native(abs) : realpathSync(abs);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  }
}

/** Arquivo de lock por instalação — fora do worktree para nunca sujar
 *  `git status` (o updater exige árvore limpa). */
export function caminhoLock(dir, baseTmp = tmpdir()) {
  const canon = caminhoCanonicoRepo(dir);
  const hash = createHash("sha1").update(canon).digest("hex").slice(0, 16);
  return join(baseTmp, `mestre-boot-lock-${hash}.json`);
}

/** pid vivo? kill(pid,0) lança ESRCH quando não existe; EPERM e demais
 *  erros significam "existe mas sem permissão" → assumir vivo
 *  (fail-closed). Injetável nos testes sem enfraquecer a produção. */
export function pidVivoReal(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "ESRCH" ? false : true;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Health check do servidor — injetável para testes. */
async function saudeReal(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return r.ok;
  } catch {
    return false;
  }
}

function lerLock(arquivo) {
  try {
    const bruto = readFileSync(arquivo, "utf8");
    const meta = JSON.parse(bruto);
    if (
      meta && meta.v === VERSAO_LOCK &&
      Number.isInteger(meta.pid) && meta.pid > 0 &&
      typeof meta.host === "string" && meta.host.length > 0 &&
      typeof meta.repo === "string" && meta.repo.length > 0 &&
      typeof meta.ts === "number"
    ) {
      return meta;
    }
  } catch { /* cai no retorno null */ }
  return null;
}

function gravarLockAtomic(arquivo, meta) {
  const json = JSON.stringify(meta);
  const fd = openSync(arquivo, "wx"); // falha se já existe — atomicidade real
  try {
    writeSync(fd, json);
  } finally {
    closeSync(fd);
  }
}

/**
 * Tenta adquirir o lock do boot.
 * Retorno: { codigo, motivo, lockPath?, esperaMs? }
 *   codigo 0  → lock adquirido (prosseguir com o boot)
 *   codigo 20 → lock ocupado por instância viva e o servidor respondeu
 *               no health — o chamador deve encerrar SEM erro
 *   codigo 1  → abortar (fail-closed)
 */
export async function adquirirLock(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const repoDir = caminhoCanonicoRepo(cwd);
  const lockPath = opts.lockPath ?? caminhoLock(cwd, opts.tmp ?? tmpdir());
  const pidDono = opts.pid ?? process.ppid; // cmd.exe do .bat, não este node
  const host = opts.host ?? hostname();
  const pidVivo = opts.pidVivo ?? pidVivoReal;
  const fetchHealth = opts.fetchHealth ?? saudeReal;
  const healthUrl = opts.healthUrl
    ?? `http://127.0.0.1:${process.env.MESTRE_PORTA ?? PORTA_PADRAO}/api/health`;
  const timeoutEspera = opts.timeoutEsperaMs ?? TIMEOUT_ESPERA_MS;
  const intervalo = opts.intervaloEsperaMs ?? INTERVALO_ESPERA_MS;
  const log = opts.log ?? (() => {});

  const meta = { v: VERSAO_LOCK, pid: pidDono, host, repo: repoDir, ts: Date.now() };

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS; tentativa++) {
    try {
      gravarLockAtomic(lockPath, meta);
      return { codigo: 0, motivo: "adquirido", lockPath, repoDir };
    } catch (e) {
      if (e && e.code !== "EEXIST") {
        // EACCES/EPERM/EROFS etc. → fail-closed, nunca assumir.
        return { codigo: 1, motivo: `falha-criar-lock:${e.code ?? e.message}`, lockPath };
      }
    }

    // Lock existe — decide entre ocupado, obsoleto ou inválido.
    const atual = lerLock(lockPath);
    if (!atual) {
      // Metadados inválidos/corrompidos: não sabemos quem é o dono.
      // Fail-closed: aguarda o servidor e aborta se não vier.
      log("[boot-lock] Lock existe mas metadados são inválidos — tratando como ocupado (fail-closed).");
      return aguardarOuAbortar({ fetchHealth, healthUrl, timeoutEspera, intervalo, log, lockPath, motivo: "lock-invalido" });
    }
    if (atual.host !== host || atual.repo !== repoDir) {
      // Arquivo de outra máquina/instalação no mesmo tmpdir (improvável,
      // mas possível com TMPDIR compartilhado/restaurado): não tocar.
      log("[boot-lock] Lock pertence a outra máquina ou instalação — tratando como ocupado.");
      return aguardarOuAbortar({ fetchHealth, healthUrl, timeoutEspera, intervalo, log, lockPath, motivo: "lock-alheio" });
    }
    if (pidVivo(atual.pid)) {
      log(`[boot-lock] Lock ativo (pid ${atual.pid}) — aguardando servidor de outra instância.`);
      return aguardarOuAbortar({ fetchHealth, healthUrl, timeoutEspera, intervalo, log, lockPath, motivo: "lock-ocupado", pid: atual.pid });
    }

    // pid morto na mesma máquina = prova de obsolescência. Reivindica
    // por rename atômico (outro processo pode ter reivindicado antes).
    const reivindicado = lockPath + `.stale.${process.pid}.${Date.now()}`;
    try {
      renameSync(lockPath, reivindicado);
      try { rmSync(reivindicado, { force: true }); } catch { /* ok */ }
      log(`[boot-lock] Lock obsoleto do pid ${atual.pid} reivindicado — retentando aquisição.`);
      continue;
    } catch {
      // sumiu ou outro processo reivindicou — reavalia do início
      continue;
    }
  }

  return { codigo: 1, motivo: "falha-recuperacao-lock", lockPath };
}

async function aguardarOuAbortar({ fetchHealth, healthUrl, timeoutEspera, intervalo, log, lockPath, motivo, pid }) {
  const limite = Date.now() + timeoutEspera;
  log(`[boot-lock] Aguardando /api/health por até ${Math.round(timeoutEspera / 1000)}s (${motivo}${pid ? `, pid ${pid}` : ""})...`);
  while (Date.now() < limite) {
    if (await fetchHealth(healthUrl)) {
      log("[boot-lock] Servidor respondeu — esta inicialização não é necessária.");
      return { codigo: 20, motivo: "servidor-ja-no-ar", lockPath, esperaMotivo: motivo };
    }
    await sleep(intervalo);
  }
  return { codigo: 1, motivo: `timeout-aguardando-servidor:${motivo}`, lockPath };
}

/**
 * Libera o lock SOMENTE se o chamador for o proprietário registrado
 * (mesmo pid — no .bat, o cmd.exe; o node auxiliar herda o mesmo ppid).
 */
export function liberarLock(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const repoDir = caminhoCanonicoRepo(cwd);
  const lockPath = opts.lockPath ?? caminhoLock(cwd, opts.tmp ?? tmpdir());
  const pidDono = opts.pid ?? process.ppid;

  const atual = lerLock(lockPath);
  if (!atual) return { ok: true, motivo: "sem-lock" }; // já liberado/ausente
  if (atual.repo !== repoDir || atual.pid !== pidDono) {
    return { ok: false, motivo: "nao-proprietario" };
  }
  try {
    rmSync(lockPath, { force: true });
    return { ok: true, motivo: "liberado" };
  } catch (e) {
    return { ok: false, motivo: `falha-remover:${e.code ?? e.message}` };
  }
}

// ---------- CLI ----------
const ehCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ehCli) {
  const cmd = process.argv[2];
  const log = (m) => console.log(m);
  if (cmd === "adquirir") {
    adquirirLock({ cwd: process.cwd(), log })
      .then((r) => {
        if (r.codigo === 0) log("[boot-lock] Lock de inicialização adquirido.");
        process.exit(r.codigo);
      })
      .catch((e) => {
        console.error(`[boot-lock] Erro inesperado: ${e?.message ?? e}`);
        process.exit(1);
      });
  } else if (cmd === "liberar") {
    const r = liberarLock({ cwd: process.cwd() });
    if (!r.ok && r.motivo !== "sem-lock") {
      console.error(`[boot-lock] Liberação recusada: ${r.motivo}`);
      process.exit(1);
    }
    process.exit(0);
  } else {
    console.error("Uso: node scripts/boot-lock.mjs <adquirir|liberar>");
    process.exit(1);
  }
}
