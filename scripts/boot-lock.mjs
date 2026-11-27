#!/usr/bin/env node
// Lock de boot por instalação (Issue #155).
//
// Impede que dois processos executem em paralelo as etapas mutáveis do
// iniciar-mestre-rpg.bat: auto-update, npm ci, builds, restauração,
// migrations e o próprio servidor — no MESMO diretório de instalação.
//
// Protocolo:
//   adquirir — ANTES de tocar no lock, resolve a porta efetiva do
//     servidor com a MESMA precedência de servidor/src/config.ts
//     (MESTRE_PORTA > configuracao/servidor.json > 3001) e sonda
//     /api/health: se já responde, sai com código 20 sem adquirir nada
//     — cobre o caso do lock ter sido apagado externamente.
//   Depois: criação atômica (open 'wx') de um arquivo de lock FORA
//     do worktree, em diretório PERSISTENTE por usuário:
//       Windows:   %LOCALAPPDATA%\MestreRPG\state\<instalacaoId>\
//       demais:    $XDG_STATE_HOME/mestre-rpg/state/<instalacaoId>/ ou
//                  ~/.local/state/mestre-rpg/state/<instalacaoId>/
//     Override:   %MESTRE_STATE_DIR%\<instalacaoId>\
//     onde instalacaoId = SHA-256 do realpath canônico e normalizado
//     do repositório — a MESMA convenção que a futura
//     scripts/estado-externo.mjs deve reproduzir. (tmpdir é volátil —
//     Storage Sense poderia apagar o lock durante um boot longo e
//     permitir segunda instância.) ATENÇÃO: o base é por usuário —
//     duas contas Windows distintas NÃO compartilham exclusão mútua
//     na mesma instalação.
//   Ocupado por pid VIVO na mesma máquina → aguarda /api/health por até
//     120s; se o servidor responder, sai com código 20 ("outra instância
//     assumiu") sem executar nada mutável; se não responder, aborta.
//   Recuperação de lock obsoleto — SERIALIZADA por mutex `.recover`:
//     1. o recuperante cria `<lock>.recover` atomicamente ('wx') com um
//        nonce único — SOMENTE criação, nunca reivindicação;
//     2. DENTRO da seção crítica relê o lock principal do zero e
//        revalida: metadados íntegros, mesmo host/repo e pidVivo=false;
//     3. só então renomeia o lock obsoleto para quarentena, revalida o
//        arquivo CAPTURADO (pid+ts idênticos ao validado) e o remove;
//     4. libera o mutex COM prova de ownership (pid + nonce) e retenta
//        o 'wx'.
//     Como o mutex `.recover` NUNCA é reivindicado — um `.recover`
//     existente, mesmo com pid morto, é fail-closed com instrução de
//     remoção manual — não existe caminho de código que renomeie ou
//     remova o mutex de outro processo. Se a prova de exclusividade
//     falhar (mutex ocupado, captura divergente, restore impossível),
//     o resultado é fail-closed: aguardar/abortar, nunca assumir, e o
//     arquivo capturado é PRESERVADO como evidência.
//   Metadados inválidos, hostname divergente ou pid não verificável →
//     fail-closed: nunca assume o lock, apenas aguarda/aborta.
//   liberar — somente o processo proprietário (mesmo pid E host E repo
//     registrados) remove o arquivo.
//
// Códigos de saída do CLI: 0 = lock adquirido; 20 = servidor de outra
// instância respondeu (boot deve encerrar sem erro); 1 = abortar.

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { hostname, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

/** Base do estado por usuário — Windows: %LOCALAPPDATA%\MestreRPG\state;
 *  demais: $XDG_STATE_HOME/mestre-rpg/state ou ~/.local/state/mestre-rpg/state.
 *  Override global: MESTRE_STATE_DIR substitui TODO o base (o
 *  <instalacaoId> continua sendo anexado). */
export function diretorioBaseEstado() {
  const override = (process.env.MESTRE_STATE_DIR ?? "").trim();
  if (override) return override;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(local, "MestreRPG", "state");
  }
  const xdg = (process.env.XDG_STATE_HOME ?? "").trim();
  const base = xdg || join(homedir(), ".local", "state");
  return join(base, "mestre-rpg", "state");
}

/** Identidade da instalação: SHA-256 do caminho canônico real.
 *  Exportada para que scripts/estado-externo.mjs reproduza o MESMO
 *  resultado — não criar identidade paralela. */
export function instalacaoId(dir) {
  return createHash("sha256").update(caminhoCanonicoRepo(dir)).digest("hex");
}

/** Diretório de estado desta instalação: <base>\<instalacaoId>. */
export function diretorioEstado(dir, baseOverride) {
  return join(baseOverride ?? diretorioBaseEstado(), instalacaoId(dir));
}

/** Arquivo de lock por instalação — <estado>/<instalacaoId>/mestre-boot-lock.json,
 *  fora do worktree para nunca sujar `git status` (o updater exige árvore limpa). */
export function caminhoLock(dir, baseOverride) {
  return join(diretorioEstado(dir, baseOverride), "mestre-boot-lock.json");
}

/**
 * Porta efetiva do servidor — MESMA precedência de
 * servidor/src/config.ts:
 *   envNum = Number(MESTRE_PORTA) || null   (inválida/ausente → null)
 *   jsonPorta = servidor.json.porta se o arquivo existir, for JSON
 *     válido e tiver o campo; JSON ausente/inválido → null
 *   porta = envNum ?? jsonPorta ?? 3001
 * Manter sincronizado com config.ts — divergência faz o lock sondar
 * uma porta e o servidor escutar outra (ver contrato em
 * teste-runtime-processos-298.mjs, seção C10).
 * Fail-closed: porta resolvida que não for inteiro 1..65535 é erro —
 * nunca assumir 3001 silenciosamente.
 * Retorno: { ok:true, porta, origem } ou { ok:false, motivo }.
 */
export function resolverPortaServidor(cwd) {
  const envNum = Number(process.env.MESTRE_PORTA) || null;
  const arquivo = join(cwd, "configuracao", "servidor.json");
  let json = null;
  try {
    if (existsSync(arquivo)) json = JSON.parse(readFileSync(arquivo, "utf8"));
  } catch {
    json = null; // inválido → ignorado (config.ts avisa e usa padrões)
  }
  const jsonPorta = json && typeof json === "object" && json.porta != null ? json.porta : null;
  // Cadeia || idêntica a config.ts: env inválida/ausente (NaN→null),
  // json.porta falsy (0/""/false) e ausente caem no próximo degrau.
  const porta = envNum || jsonPorta || PORTA_PADRAO;
  const origem = envNum ? "MESTRE_PORTA" : (jsonPorta ? "servidor.json" : "padrao");
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
    return { ok: false, motivo: `porta-invalida:${origem}=${String(jsonPorta ?? process.env.MESTRE_PORTA)}` };
  }
  return { ok: true, porta, origem };
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
 * com 'wx'. O mutex NUNCA é reivindicado: se `.recover` já existe —
 * vivo, obsoleto ou corrompido — o resultado é fail-closed. Um mutex
 * com pid morto só pode significar crash no meio da seção crítica
 * (janela de microssegundos); exigir remoção manual é o preço de não
 * existir primitiva de mutex com staleness segura no Windows sem deps.
 * O pid gravado é o DESTE processo node (process.pid) e o nonce é
 * único por tentativa — a liberação exige os dois.
 * Retorno: { ok:true, recPath, nonce } — seção nossa;
 *          { ok:false, ocupado:true, motivo, pid? } — outro recuperante
 *            vivo ou sendo tratado: tratar lock como ocupado;
 *          { ok:false, fatal:true, motivo } — fail-closed.
 */
function entrarSecaoRecuperacao({ lockPath, repoDir, host, pidVivo, log }) {
  const recPath = lockPath + SUFIXO_MUTEX;
  const nonce = randomUUID();
  const metaRec = { v: VERSAO_LOCK, pid: process.pid, host, repo: repoDir, ts: Date.now(), nonce };
  try {
    gravarLockAtomic(recPath, metaRec);
    return { ok: true, recPath, nonce };
  } catch (e) {
    if (!e || e.code !== "EEXIST") {
      return { ok: false, fatal: true, motivo: `falha-criar-mutex:${e?.code ?? e?.message}` };
    }
  }
  const rec = lerLock(recPath);
  if (!rec || rec.host !== host || rec.repo !== repoDir || typeof rec.nonce !== "string") {
    return { ok: false, fatal: true, motivo: "mutex-invalido" };
  }
  if (pidVivo(rec.pid)) {
    return { ok: false, ocupado: true, motivo: "mutex-ocupado", pid: rec.pid };
  }
  // Mutex obsoleto ou de processo morto: NÃO reivindicar — abortar com
  // instrução de intervenção manual. O arquivo é preservado intacto.
  return {
    ok: false,
    fatal: true,
    motivo: "mutex-obsoleto",
    instrucao: `Remova manualmente o arquivo de recuperação residual: ${recPath} e tente novamente.`,
  };
}

/** Libera o mutex SOMENTE se o arquivo atual ainda for o nosso —
 *  mesmo pid e mesmo nonce. Se outro processo substituiu o arquivo,
 *  não removemos nada (fail-closed por preservação). */
function sairSecaoRecuperacao(recPath, nonce) {
  const atual = lerLock(recPath);
  if (atual && atual.pid === process.pid && atual.nonce === nonce) {
    try { rmSync(recPath, { force: true }); } catch { /* ok */ }
    return;
  }
  // Ausente ou de outro dono: nada a liberar — preserva evidência.
}

/**
 * Dentro da seção crítica (.recover nosso): relê o lock principal do
 * zero, revalida obsolescência e só então o remove. Retorno:
 *   "removido" — lock obsoleto eliminado, retentar aquisição
 *   "ocupado"  — lock agora pertence a processo vivo/inválido
 *   "fatal"    — fail-closed
 */
function reivindicarLockObsoleto({ lockPath, repoDir, host, pidVivo, log, renomear = renameSync }) {
  // Releitura OBRIGATÓRIA dentro da seção: a leitura anterior pode ter
  // envelhecido — outro processo pode ter reivindicado e recriado.
  const fresco = lerLock(lockPath);
  if (!fresco) return "removido"; // sumiu — 'wx' vai criar
  if (fresco.host !== host || fresco.repo !== repoDir || pidVivo(fresco.pid)) {
    return "ocupado";
  }
  const quarentena = `${lockPath}.quar-${process.pid}-${Date.now()}`;
  try {
    renomear(lockPath, quarentena);
  } catch (e) {
    // Somente ENOENT prova que o arquivo sumiu → retenta a aquisição.
    // EACCES/EPERM/EBUSY e demais falhas são fail-closed: não fingir
    // sucesso nem tratar como "removido".
    if (e && e.code === "ENOENT") return "removido";
    log(`[boot-lock] Falha ao mover lock obsoleto para quarentena (${e?.code ?? e?.message}) — fail-closed.`);
    return "fatal";
  }
  // Revalida o arquivo CAPTURADO: deve ser exatamente o obsoleto lido.
  const cap = lerLock(quarentena);
  if (!cap || cap.pid !== fresco.pid || cap.ts !== fresco.ts || cap.repo !== repoDir || pidVivo(cap.pid)) {
    // Não é o lock obsoleto esperado (ex.: lock novo de outro dono).
    // Restaura sem sobrescrever; se o caminho já foi ocupado, fail-closed.
    try {
      restaurarAtomico(quarentena, lockPath);
    } catch {
      // NUNCA remover o capturado: ele é a evidência do lock de outro
      // dono. Preserva o arquivo de quarentena e aborta fail-closed.
      log("[boot-lock] Não foi possível restaurar lock capturado — quarentena preservada, abortando por segurança.");
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
  // stateBase é injetável SOMENTE para testes — produção usa a convenção
  // compartilhada <MESTRE_STATE_DIR|LOCALAPPDATA>/.../<instalacaoId>.
  const lockPath = opts.lockPath ?? caminhoLock(cwd, opts.stateBase);
  const pidDono = opts.pid ?? process.ppid; // cmd.exe do .bat, não este node
  const host = opts.host ?? hostname();
  const pidVivo = opts.pidVivo ?? pidVivoReal;
  const fetchHealth = opts.fetchHealth ?? saudeReal;
  const envTimeout = Number(process.env.MESTRE_BOOT_LOCK_TIMEOUT_MS);
  const timeoutEspera = opts.timeoutEsperaMs
    ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : TIMEOUT_ESPERA_MS);
  const intervalo = opts.intervaloEsperaMs ?? INTERVALO_ESPERA_MS;
  const log = opts.log ?? (() => {});
  const renomear = opts.renomear ?? renameSync; // seam de teste apenas

  // Porta efetiva = mesma resolução do servidor (config.ts). Inválida
  // ou ambígua → aborta; nunca assumir 3001 silenciosamente.
  const porta = resolverPortaServidor(repoDir);
  if (!porta.ok) {
    return { codigo: 1, motivo: porta.motivo, lockPath };
  }
  const healthUrl = opts.healthUrl
    ?? `http://127.0.0.1:${porta.porta}/api/health`;

  // Cria o diretório de locks com segurança antes de qualquer escrita.
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch (e) {
    return { codigo: 1, motivo: `falha-criar-dir-locks:${e?.code ?? e?.message}`, lockPath };
  }

  const meta = { v: VERSAO_LOCK, pid: pidDono, host, repo: repoDir, ts: Date.now() };

  // Instância já ativa? Sonda o health na porta EFETIVA antes de tentar
  // lock — cobre servidor no ar com lock apagado externamente.
  if (await fetchHealth(healthUrl)) {
    log("[boot-lock] /api/health já responde — outra instância está ativa.");
    return { codigo: 20, motivo: "servidor-ja-no-ar", lockPath, porta: porta.porta };
  }

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
      const resultado = reivindicarLockObsoleto({ lockPath, repoDir, host, pidVivo, log, renomear });
      sairSecaoRecuperacao(secao.recPath, secao.nonce);
      if (resultado === "removido") continue; // lock obsoleto eliminado — retenta 'wx'
      if (resultado === "fatal") {
        return { codigo: 1, motivo: "falha-recuperacao-lock", lockPath };
      }
      // "ocupado" — outro dono assumiu durante a seção; trata como tal
      return aguardarOuAbortar({ fetchHealth, healthUrl, timeoutEspera, intervalo, log, lockPath, motivo: "lock-ocupado" });
    }
    if (secao.fatal) {
      if (secao.instrucao) log(`[boot-lock] ${secao.instrucao}`);
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
  const lockPath = opts.lockPath ?? caminhoLock(cwd, opts.stateBase);
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
