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
//   Recuperação de lock obsoleto — SERIALIZADA por mutex `.recover`:
//     1. o recuperante cria `<lock>.recover` atomicamente ('wx');
//     2. DENTRO da seção crítica relê o lock principal do zero e
//        revalida: metadados íntegros, mesmo host/repo e pidVivo=false;
//     3. só então renomeia o lock obsoleto para quarentena, revalida o
//        arquivo CAPTURADO (pid+ts idênticos ao validado) e o remove;
//     4. libera o mutex e tenta o 'wx' de novo.
//     Como toda mutação do lock principal por terceiros exige o mesmo
//     mutex, nenhum processo consegue renomear/remover um lock criado
//     por outro DEPOIS da leitura — a revalidação acontece dentro da
//     seção crítica, não antes. Se a prova de exclusividade falhar em
//     qualquer ponto (mutex ocupado, captura divergente, restore
//     impossível), o resultado é fail-closed: aguardar/abortar, nunca
//     assumir.
//   Metadados inválidos, hostname divergente ou pid não verificável →
//     fail-closed: nunca assume o lock, apenas aguarda/aborta.
//   liberar — somente o processo proprietário (mesmo pid E host E repo
//     registrados) remove o arquivo.
//
// Códigos de saída do CLI: 0 = lock adquirido; 20 = servidor de outra
// instância respondeu (boot deve encerrar sem erro); 1 = abortar.

import { createHash } from "node:crypto";
import {
  closeSync, linkSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSAO_LOCK = 1;
const TIMEOUT_ESPERA_MS = 120_000;
const INTERVALO_ESPERA_MS = 1_000;
const PORTA_PADRAO = 3001;
const MAX_TENTATIVAS = 4;
const SUFIXO_MUTEX = ".recover";

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
    const meta = JSON.parse(readFileSync(arquivo, "utf8"));
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

/** Criação exclusiva: falha com EEXIST se o arquivo já existe. O
 *  conteúdo é pequeno e escrito imediatamente após o open — leitores
 *  que pegarem JSON parcial caem em "metadados inválidos" (fail-closed). */
function gravarLockAtomic(arquivo, meta) {
  const fd = openSync(arquivo, "wx");
  try {
    writeSync(fd, JSON.stringify(meta));
  } finally {
    closeSync(fd);
  }
}

/** Remove um arquivo capturado por rename sem sobrescrever destino
 *  existente: link é atômico e falha com EEXIST se o caminho já foi
 *  ocupado por outro processo. */
function restaurarAtomico(origem, destino) {
  linkSync(origem, destino); // EEXIST se destino apareceu — não clobbera
  rmSync(origem, { force: true });
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
 * Tenta entrar na seção crítica de recuperação criando `<lock>.recover`
 * com 'wx'. O pid gravado é o DESTE processo node (process.pid) — o
 * mutex só precisa de uma identidade viva durante a seção.
 * Retorno: { ok:true } — seção nossa; { ok:false, ocupado:true } —
 * alguém está recuperando ou o mutex é de pid vivo (tratar lock como
 * ocupado); { ok:false, fatal:true } — fail-closed.
 */
function entrarSecaoRecuperacao({ lockPath, repoDir, host, pidVivo, log }) {
  const recPath = lockPath + SUFIXO_MUTEX;
  const metaRec = { v: VERSAO_LOCK, pid: process.pid, host, repo: repoDir, ts: Date.now() };
  for (let i = 0; i < MAX_TENTATIVAS; i++) {
    try {
      gravarLockAtomic(recPath, metaRec);
      return { ok: true, recPath };
    } catch (e) {
      if (e && e.code !== "EEXIST") return { ok: false, fatal: true, motivo: `falha-criar-mutex:${e.code ?? e.message}` };
    }
    const rec = lerLock(recPath);
    if (!rec || rec.host !== host || rec.repo !== repoDir) {
      return { ok: false, fatal: true, motivo: "mutex-invalido" };
    }
    if (pidVivo(rec.pid)) {
      return { ok: false, ocupado: true, motivo: "mutex-ocupado", pid: rec.pid };
    }
    // Mutex obsoleto: reivindica por rename e REVALIDA o capturado —
    // se for um mutex novo (outro recuperante), restaura sem clobber.
    const claim = `${recPath}.stale-${process.pid}-${Date.now()}`;
    try {
      renameSync(recPath, claim);
    } catch {
      continue; // outro processo moveu primeiro — reavalia
    }
    const cap = lerLock(claim);
    if (!cap || cap.pid !== rec.pid || cap.ts !== rec.ts) {
      // Capturamos um mutex MAIS NOVO de outro recuperante — devolve.
      try {
        restaurarAtomico(claim, recPath);
      } catch {
        try { rmSync(claim, { force: true }); } catch { /* ok */ }
        return { ok: false, fatal: true, motivo: "falha-restaurar-mutex" };
      }
      return { ok: false, ocupado: true, motivo: "mutex-ocupado" };
    }
    try { rmSync(claim, { force: true }); } catch { /* ok */ }
    // mutex obsoleto removido — retenta a criação
  }
  return { ok: false, fatal: true, motivo: "falha-recuperar-mutex" };
}

function sairSecaoRecuperacao(recPath) {
  try { rmSync(recPath, { force: true }); } catch { /* ok */ }
}

/**
 * Dentro da seção crítica (.recover nosso): relê o lock principal do
 * zero, revalida obsolescência e só então o remove. Retorno:
 *   "removido" — lock obsoleto eliminado, retentar aquisição
 *   "ocupado"  — lock agora pertence a processo vivo/inválido
 *   "fatal"    — fail-closed
 */
function reivindicarLockObsoleto({ lockPath, repoDir, host, pidVivo, log }) {
  // Releitura OBRIGATÓRIA dentro da seção: a leitura anterior pode ter
  // envelhecido — outro processo pode ter reivindicado e recriado.
  const fresco = lerLock(lockPath);
  if (!fresco) return "removido"; // sumiu — 'wx' vai criar
  if (fresco.host !== host || fresco.repo !== repoDir || pidVivo(fresco.pid)) {
    return "ocupado";
  }
  const quarentena = `${lockPath}.quar-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockPath, quarentena);
  } catch {
    return "removido"; // sumiu entre leitura e rename — retenta
  }
  // Revalida o arquivo CAPTURADO: deve ser exatamente o obsoleto lido.
  const cap = lerLock(quarentena);
  if (!cap || cap.pid !== fresco.pid || cap.ts !== fresco.ts || cap.repo !== repoDir || pidVivo(cap.pid)) {
    // Não é o lock obsoleto esperado (ex.: lock novo de outro dono).
    // Restaura sem sobrescrever; se o caminho já foi ocupado, fail-closed.
    try {
      restaurarAtomico(quarentena, lockPath);
    } catch {
      try { rmSync(quarentena, { force: true }); } catch { /* ok */ }
      log("[boot-lock] Não foi possível restaurar lock capturado — abortando por segurança.");
      return "fatal";
    }
    return "ocupado";
  }
  try { rmSync(quarentena, { force: true }); } catch { /* ok */ }
  log(`[boot-lock] Lock obsoleto do pid ${cap.pid} removido com segurança — retentando aquisição.`);
  return "removido";
}

/**
 * Tenta adquirir o lock do boot.
 * Retorno: { codigo, motivo, lockPath?, esperaMotivo? }
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
  const envTimeout = Number(process.env.MESTRE_BOOT_LOCK_TIMEOUT_MS);
  const healthUrl = opts.healthUrl
    ?? `http://127.0.0.1:${process.env.MESTRE_PORTA ?? PORTA_PADRAO}/api/health`;
  const timeoutEspera = opts.timeoutEsperaMs
    ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : TIMEOUT_ESPERA_MS);
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

    // Lock existe — classifica o estado atual.
    const atual = lerLock(lockPath);
    if (!atual) {
      // Metadados inválidos/corrompidos: não sabemos quem é o dono.
      log("[boot-lock] Lock existe mas metadados são inválidos — fail-closed.");
      return aguardarOuAbortar({ fetchHealth, healthUrl, timeoutEspera, intervalo, log, lockPath, motivo: "lock-invalido" });
    }
    if (atual.host !== host || atual.repo !== repoDir) {
      // Arquivo de outra máquina/instalação no mesmo tmpdir (improvável,
      // mas possível com TMPDIR compartilhado/restaurado): não tocar.
      log("[boot-lock] Lock pertence a outra máquina ou instalação — fail-closed.");
      return aguardarOuAbortar({ fetchHealth, healthUrl, timeoutEspera, intervalo, log, lockPath, motivo: "lock-alheio" });
    }
    if (pidVivo(atual.pid)) {
      log(`[boot-lock] Lock ativo (pid ${atual.pid}) — aguardando servidor de outra instância.`);
      return aguardarOuAbortar({ fetchHealth, healthUrl, timeoutEspera, intervalo, log, lockPath, motivo: "lock-ocupado", pid: atual.pid });
    }

    // Candidato a obsoleto — recuperação SERIALIZADA por mutex .recover.
    const secao = entrarSecaoRecuperacao({ lockPath, repoDir, host, pidVivo, log });
    if (secao.ok) {
      const resultado = reivindicarLockObsoleto({ lockPath, repoDir, host, pidVivo, log });
      sairSecaoRecuperacao(secao.recPath);
      if (resultado === "removido") continue; // lock obsoleto eliminado — retenta 'wx'
      if (resultado === "fatal") {
        return { codigo: 1, motivo: "falha-recuperacao-lock", lockPath };
      }
      // "ocupado" — outro dono assumiu durante a seção; trata como tal
      return aguardarOuAbortar({ fetchHealth, healthUrl, timeoutEspera, intervalo, log, lockPath, motivo: "lock-ocupado" });
    }
    if (secao.fatal) {
      return { codigo: 1, motivo: secao.motivo ?? "falha-mutex-recuperacao", lockPath };
    }
    // mutex ocupado por recuperante vivo → o lock está sendo tratado;
    // aguarda health como se estivesse ocupado (fail-closed).
    return aguardarOuAbortar({ fetchHealth, healthUrl, timeoutEspera, intervalo, log, lockPath, motivo: "lock-sendo-recuperado", pid: secao.pid });
  }

  return { codigo: 1, motivo: "falha-recuperacao-lock", lockPath };
}

/**
 * Libera o lock SOMENTE se o chamador for o proprietário registrado —
 * mesmo pid, mesmo host e mesmo repositório canônico.
 */
export function liberarLock(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const repoDir = caminhoCanonicoRepo(cwd);
  const lockPath = opts.lockPath ?? caminhoLock(cwd, opts.tmp ?? tmpdir());
  const pidDono = opts.pid ?? process.ppid;
  const host = opts.host ?? hostname();

  const atual = lerLock(lockPath);
  if (!atual) return { ok: true, motivo: "sem-lock" }; // já liberado/ausente
  if (atual.repo !== repoDir || atual.pid !== pidDono || atual.host !== host) {
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
