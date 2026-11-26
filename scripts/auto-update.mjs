#!/usr/bin/env node
// Auto-update seguro do Mestre RPG (Issue #155).
//
// Executado por iniciar-mestre-rpg.bat SOMENTE depois da checagem da
// porta 3001 — se ja ha servidor no ar, este script nem roda.
//
// Filosofia: e preferivel NAO atualizar e subir a versao local do que
// comprometer uma instalacao funcional. Qualquer pre-requisito
// ausente, falha de rede, arvore suja, divergencia ou erro de build
// resulta em aviso + continuacao com o codigo local. A unica saida
// com erro e quando nem o rollback seguro pode ser garantido.
//
// Nunca executa: stash, clean, merge commit, rebase, force ou descarte
// preventivo de arquivos. A única movimentação para frente é `merge --ff-only`
// de um SHA remoto já verificado; reset --hard só ocorre no rollback controlado
// com árvore limpa, branch conferida e HEAD exatamente no SHA registrado.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { caminhoCanonicoRepo } from "./boot-lock.mjs";
import {
  gravarEstado as gravarEstadoExterno,
  lerJournal as lerJournalExterno,
  removerEstado,
  JOURNAL_UPDATE,
} from "./estado-externo.mjs";

export const REPO_OFICIAL = "https://github.com/mestredsl-eng/mestreRPG";

const TIMEOUT_GIT_MS = 30_000;
const TIMEOUT_FETCH_MS = 30_000;
const TIMEOUT_PULL_MS = 60_000;
const TIMEOUT_NPM_MS = 10 * 60_000;
const TIMEOUT_BUILD_MS = 5 * 60_000;

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10",
};

// Issue #373 — exceção estrita e auditável para artefatos runtime que o
// .gitignore legado (<= v1.1.0) não cobria. Sem ela, o arquivo de trava
// de instância (`banco/*.db.trava`, criado por trava-instancia.ts como
// caminhoBanco + ".trava" e persistente após o shutdown) deixa TODA
// instalação real permanentemente "árvore suja": o updater nunca
// alcança o novo `.gitignore` `/banco/` que resolveria o problema —
// ovo-e-galinha comprovado pelo Técnico Geral na homologação Windows.
//
// Allowlist: SOMENTE caminhos `banco/<nome>.db.trava` — a forma exata
// que trava-instancia.ts produz para qualquer MESTRE_BANCO *.db dentro
// de banco/. O banco de trava usa journal SQLite default (sem WAL),
// logo não existem -wal/-shm persistentes; um `-journal` eventual é
// transitório e segue bloqueando (fail-closed).
// Fora da lista, tudo continua bloqueando: `.bak-*` (o app não gera —
// sem prova de nome/caminho), qualquer outro untracked, e TODO arquivo
// rastreado modificado/staged/renomeado. Nada é apagado, movido ou
// ignorado de verdade — apenas deixa de contar como sujeira.
/**
 * Caminhos dos artefatos SQLite de trava derivados da MESMA configuração
 * que servidor/src/db/index.ts: MESTRE_BANCO ou banco/mestre-rpg.db.
 * O SQLite usa "<banco>.trava" e "<banco>.trava-journal".
 *
 * Só toleramos esses dois caminhos exatos quando estão dentro do clone.
 * Backups antigos, outros bancos, caminhos externos, nomes parecidos e
 * qualquer artefato não comprovado continuam fail-closed.
 */
function caminhosTravaRuntime(repoDir, env = process.env) {
  const banco = env.MESTRE_BANCO
    ? resolve(repoDir, env.MESTRE_BANCO)
    : resolve(repoDir, "banco", "mestre-rpg.db");
  const trava = banco + ".trava";
  const relativo = (arquivo) => {
    const caminho = relative(repoDir, arquivo);
    if (!caminho || caminho === ".." || caminho.startsWith(".." + sep) || isAbsolute(caminho)) {
      return null;
    }
    return caminho.split(sep).join("/");
  };
  return new Set([relativo(trava), relativo(trava + "-journal")].filter(Boolean));
}

/** lstat rejeita symlinks, diretórios e caminhos quebrados. */
function ehArquivoRegular(caminho) {
  try { return lstatSync(caminho).isFile(); } catch { return false; }
}

/**
 * Interpreta \`git status --porcelain -z\` (registros NUL-separados,
 * \`XY <path>\`). Só tolera untracked nos dois caminhos runtime exatos
 * do banco configurado, e apenas quando são arquivos regulares.
 * Qualquer outra entrada (inclusive staged/modified/rename) é sujeira.
 */
export function avaliarStatusPorcelain(stdout, repoDir = process.cwd(), env = process.env) {
  const tolerados = [];
  const permitidos = caminhosTravaRuntime(repoDir, env);
  let sujo = false;
  for (const reg of String(stdout ?? "").split("\0")) {
    if (reg.length === 0) continue;
    const xy = reg.slice(0, 2);
    const caminho = reg.slice(3);
    if (xy !== "??" || !permitidos.has(caminho)) { sujo = true; break; }
    if (!ehArquivoRegular(resolve(repoDir, caminho))) { sujo = true; break; }
    tolerados.push(caminho);
  }
  return { sujo, tolerados };
}

/** Execucao real de comandos. Injetavel nos testes. */
export function executarReal(cmd, args, { cwd, env, timeoutMs } = {}) {
  // O updater não herda variáveis GIT_* do processo pai: GIT_DIR,
  // GIT_WORK_TREE, GIT_INDEX_FILE e GIT_CONFIG_* podem redirecionar
  // comandos para outro repositório ou alterar sua configuração. Mantemos
  // somente as duas variáveis operacionais que este fluxo controla.
  const ambiente = { ...process.env, ...(env ?? {}) };
  for (const chave of Object.keys(ambiente)) {
    if (/^GIT_/i.test(chave)) delete ambiente[chave];
  }
  ambiente.GIT_TERMINAL_PROMPT = env?.GIT_TERMINAL_PROMPT ?? GIT_ENV.GIT_TERMINAL_PROMPT;
  ambiente.GIT_SSH_COMMAND = env?.GIT_SSH_COMMAND ?? GIT_ENV.GIT_SSH_COMMAND;
  const npmWindows = process.platform === "win32" && (cmd === "npm" || cmd === "npm.cmd");

  // npm no Windows e um .cmd, que nao pode ser iniciado diretamente por
  // spawnSync sem terminal. Invoca o ComSpec explicitamente e restringe
  // os argumentos a comandos fixos usados por este updater; nao aceita
  // texto livre/metacaracteres de shell.
  const npmArgsPermitidos = Array.isArray(args) && (
    (args.length === 1 && (args[0] === "ci" || args[0] === "--version")) ||
    (args.length === 4 && args[0] === "run" && args[1] === "build" && args[2] === "-w" && (args[3] === "servidor" || args[3] === "site"))
  );
  if (npmWindows && !npmArgsPermitidos) {
    return { code: 1, stdout: "", stderr: "Argumentos npm nao permitidos pelo auto-update." };
  }

  const executavel = npmWindows ? (ambiente.ComSpec ?? ambiente.COMSPEC ?? "cmd.exe") : cmd;
  const argumentos = npmWindows ? ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`] : args;
  const r = spawnSync(executavel, argumentos, {
    cwd,
    env: ambiente,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    // npm ci pode exceder o maxBuffer padrao do Node em instalacoes
    // verbosas. O limite maior evita rollback espurio por truncamento
    // de stdout/stderr; continua finito para proteger memoria.
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) {
    return { code: typeof r.status === "number" ? r.status : 1, stdout: r.stdout ?? "", stderr: `${r.error.message ?? r.error}`, morto: true };
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const npmCmd = () => (process.platform === "win32" ? "npm.cmd" : "npm");

/** Normaliza URL do remoto para comparacao com o repositorio oficial. */
export function normalizarUrlRepo(url) {
  let u = String(url ?? "").trim();
  u = u.replace(/\/+$/, "");
  u = u.replace(/\.git$/i, "");
  u = u.replace(/^git@github\.com:/i, "https://github.com/");
  u = u.replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/");
  return u.toLowerCase();
}

const REPO_OFICIAL_NORM = normalizarUrlRepo(REPO_OFICIAL);

function estadoPadrao(cwd, stateFile) {
  const arquivo = stateFile
    ?? join(tmpdir(), `mestre-rpg-auto-update-${createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12)}.json`);
  return arquivo;
}

/**
 * Verifica pre-requisitos e, se seguro, aplica `git pull --ff-only`.
 * Nao roda npm/build — isso e responsabilidade de executarBoot.
 *
 * Retorno: { atualizou, motivo, shaAnterior, shaNovo, commits, depsMudaram }
 */
export async function verificarAtualizacao(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const executar = opts.executar ?? executarReal;
  const log = opts.log ?? (() => {});
  const envGit = { ...GIT_ENV, ...(opts.envGit ?? {}) };
  const tGit = opts.timeoutGitMs ?? TIMEOUT_GIT_MS;
  const tFetch = opts.timeoutFetchMs ?? TIMEOUT_FETCH_MS;
  const tPull = opts.timeoutPullMs ?? TIMEOUT_PULL_MS;
  const oficialNorm = normalizarUrlRepo(opts.urlOficial ?? REPO_OFICIAL);

  const pular = (motivo, extra = {}) => ({ atualizou: false, motivo, ...extra });
  const git = (args, timeoutMs = tGit) =>
    executar("git", args, { cwd, env: envGit, timeoutMs });

  // 1. Git no PATH
  const v = git(["--version"]);
  if (v.code !== 0) return pular("git-indisponivel");

  // 2. .git presente (worktree .git-file tambem resolve via rev-parse)
  const wt = git(["rev-parse", "--is-inside-work-tree"]);
  if (wt.code !== 0 || String(wt.stdout).trim() !== "true") return pular("sem-repositorio-git");

  // raiz real do repo (suporta worktrees)
  const top = git(["rev-parse", "--show-toplevel"]);
  const repoDir = top.code === 0 ? String(top.stdout).trim() : cwd;

  // 3. URL efetiva do origin — inclui reescritas url.*.insteadOf e
  // TODAS as URLs configuradas. Validar apenas remote.origin.url cru
  // permitiria que o fetch fosse redirecionado a outro host (supply chain).
  const remote = git(["remote", "get-url", "--all", "origin"]);
  if (remote.code !== 0) return pular("sem-remoto-origin", { repoDir });
  const urlsEfetivas = String(remote.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (urlsEfetivas.length !== 1 || normalizarUrlRepo(urlsEfetivas[0]) !== oficialNorm) {
    return pular("remoto-desconhecido", { repoDir });
  }

  // 4. branch atual (detached HEAD nao atualiza)
  const ref = git(["symbolic-ref", "-q", "HEAD"]);
  if (ref.code !== 0) return pular("head-detached", { repoDir });
  const branch = String(ref.stdout).trim().replace(/^refs\/heads\//, "");

  // 5. upstream configurado — nao adivinhar branch E nao aceitar
  //    upstream de outro remoto/fork: validar 'origin' nao valida o
  //    upstream. Exigimos exatamente origin/<branch-atual>; qualquer
  //    outra configuracao cancela a atualizacao (B1).
  const up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (up.code !== 0) return pular("sem-upstream", { repoDir, branch });
  const upstreamBruto = String(up.stdout).trim();
  const upstream = upstreamBruto.startsWith("refs/remotes/")
    ? upstreamBruto.slice("refs/remotes/".length)
    : upstreamBruto;
  if (upstream !== `origin/${branch}`) {
    return pular("upstream-invalido", { repoDir, branch, upstream });
  }

  // 6. arvore limpa — qualquer alteracao (rastreada ou nao) aborta so a
  //    atualizacao; proibido stash/clean/reset preventivo.
  const status = git(["-c", "status.showUntrackedFiles=all", "status", "--porcelain", "-z", "--untracked-files=all"]);
  if (status.code !== 0) return pular("falha-status", { repoDir, branch });
  const arvore = avaliarStatusPorcelain(status.stdout, repoDir);
  if (arvore.sujo) return pular("arvore-suja", { repoDir, branch });
  if (arvore.tolerados.length) {
    log(`[auto-update] Artefatos runtime tolerados na guarda de árvore: ${arvore.tolerados.join(", ")}`);
  }

  // 7. fetch nao interativo, com timeout — rede/auth/timeout nunca bloqueiam
  const f = git(["fetch", "origin"], tFetch);
  if (f.code !== 0) return pular("falha-fetch", { repoDir, branch, detalhe: String(f.stderr).trim().slice(0, 300) });

  // 8. comparacao HEAD x upstream
  const behind = git(["rev-list", "--count", `HEAD..${upstream}`]);
  const ahead = git(["rev-list", "--count", `${upstream}..HEAD`]);
  if (behind.code !== 0 || ahead.code !== 0) return pular("falha-comparacao", { repoDir, branch });
  const nBehind = Number(String(behind.stdout).trim());
  const nAhead = Number(String(ahead.stdout).trim());
  if (!Number.isFinite(nBehind) || !Number.isFinite(nAhead)) return pular("falha-comparacao", { repoDir, branch });
  if (nBehind === 0) return pular("sem-atualizacao", { repoDir, branch, commits: 0 });
  if (nAhead > 0) return pular("divergente", { repoDir, branch, commits: nBehind });

  // 8b. Integridade do upstream: a referencia de rastreio
  //     refs/remotes/origin/<branch> precisa refletir a branch de
  //     mesmo nome no remoto oficial. Um refspec customizado
  //     (remote.origin.fetch) combinado com branch.<nome>.merge
  //     apontando para outra branch poderia fazer 'origin/main'
  //     carregar codigo de uma ref diferente do mesmo repositorio.
  //     ls-remote consulta o remoto diretamente — nao depende do
  //     mapeamento local.
  const ls = git(["ls-remote", "origin", `refs/heads/${branch}`], tFetch);
  if (ls.code !== 0) {
    return pular("falha-fetch", { repoDir, branch, detalhe: String(ls.stderr).trim().slice(0, 300) });
  }
  const shaRemoto = String(ls.stdout).split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find(([, ref]) => ref === `refs/heads/${branch}`)?.[0] ?? "";
  const shaTracking = String(git(["rev-parse", `refs/remotes/${upstream}`]).stdout).trim();
  if (!shaRemoto || shaRemoto !== shaTracking) {
    return pular("upstream-nao-reflete-remoto", { repoDir, branch });
  }

  // 9. Persistir intenção ANTES de qualquer mudança do HEAD.
  // O alvo é shaRemoto, já verificado contra refs/remotes/origin/<branch>;
  // usamos merge --ff-only <SHA> para não perseguir um remoto que avance
  // entre a verificação e a aplicação.
  const shaAnterior = String(git(["rev-parse", "HEAD"]).stdout).trim();
  const diffArquivos = git(["diff", "--name-only", shaAnterior, shaRemoto]);
  if (diffArquivos.code !== 0) {
    return pular("falha-diagnostico-pre-pull", {
      repoDir, branch, shaAnterior, shaNovo: shaRemoto,
      detalhe: String(diffArquivos.stderr).trim().slice(0, 300),
    });
  }
  const arquivosMudados = String(diffArquivos.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const depsMudaram = arquivosMudados.some((p) =>
    p === "package-lock.json" || p.endsWith("/package-lock.json") ||
    p === "package.json" || p.endsWith("/package.json")
  ) || !existsSync(join(repoDir, "node_modules"));
  // Qualquer mudança do workspace site/ (inclui vite.config.ts/index.html)
  // exige rebuild, mesmo quando site/src não tem timestamp mais recente.
  const siteMudou = arquivosMudados.some((p) =>
    p.startsWith("site/") || p === "package.json" || p === "package-lock.json"
  );
  const intencao = {
    fase: "pull-iniciado",
    etapa: "merge-fast-forward",
    branch,
    repoDir,
    shaAnterior,
    shaNovo: shaRemoto,
    commits: nBehind,
    depsMudaram,
    siteMudou,
    iniciadoEm: new Date().toISOString(),
  };
  if (typeof opts.registrarPullAntes === "function") {
    try {
      const gravado = opts.registrarPullAntes(intencao);
      if (gravado !== true) {
        return pular("falha-registro-journal", { repoDir, branch, shaAnterior, shaNovo: shaRemoto });
      }
    } catch (e) {
      log(`[auto-update] Journal durável não pôde ser gravado antes do pull: ${String(e?.message ?? e).slice(0, 200)}`);
      return pular("falha-registro-journal", { repoDir, branch, shaAnterior, shaNovo: shaRemoto });
    }
  }

  try {
    log(`[auto-update] ${nBehind} commit(s) novo(s) em ${upstream} — aplicando fast-forward para ${shaRemoto.slice(0, 12)}...`);
    const merge = git(["merge", "--ff-only", shaRemoto], tPull);
    if (merge.code !== 0) {
      const headAgora = String(git(["rev-parse", "HEAD"]).stdout).trim();
      if (headAgora !== shaAnterior) {
        return pular("estado-incerto-pos-pull", {
          repoDir, branch, shaAnterior,
          rollback: { shaAnterior, shaNovo: headAgora, repoDir, depsMudaram, siteMudou, branch },
          detalhe: String(merge.stderr).trim().slice(0, 300),
        });
      }
      try { opts.limparJournalSemPull?.(repoDir); } catch { /* journal pendente será limpo no próximo boot */ }
      return pular("falha-pull", { repoDir, branch, shaAnterior, detalhe: String(merge.stderr).trim().slice(0, 300) });
    }

    const shaNovo = String(git(["rev-parse", "HEAD"]).stdout).trim();
    const anc = git(["merge-base", "--is-ancestor", shaAnterior, shaNovo]);
    if (shaNovo !== shaRemoto || shaNovo === shaAnterior || anc.code !== 0) {
      return pular("pull-nao-foi-ff", {
        repoDir, branch, shaAnterior, shaNovo,
        rollback: { shaAnterior, shaNovo, repoDir, depsMudaram, siteMudou, branch },
      });
    }
    const commits = git(["rev-list", "--count", `${shaAnterior}..${shaNovo}`]);
    const nCommits = commits.code === 0 ? Number(String(commits.stdout).trim()) : nBehind;

    return {
      atualizou: true, motivo: "atualizado", repoDir, branch,
      shaAnterior, shaNovo, commits: Number.isFinite(nCommits) ? nCommits : nBehind,
      depsMudaram, siteMudou,
    };
  } catch (e) {
    // Exceção após registrar a intenção: o HEAD pode estar no SHA anterior
    // ou no alvo. O journal persiste ambos para recuperação segura.
    let headAgora = "";
    try { headAgora = String(git(["rev-parse", "HEAD"]).stdout).trim(); } catch { /* ignora */ }
    if (headAgora === shaAnterior) {
      try { opts.limparJournalSemPull?.(repoDir); } catch { /* recupera no próximo boot */ }
      return pular("erro-inesperado-antes-aplicar", {
        repoDir, branch, shaAnterior,
        detalhe: String(e?.message ?? e).slice(0, 300),
      });
    }
    return pular("erro-inesperado-pos-pull", {
      repoDir, branch, shaAnterior,
      rollback: { shaAnterior, shaNovo: headAgora || shaRemoto, repoDir, depsMudaram, siteMudou, branch },
      detalhe: String(e?.message ?? e).slice(0, 300),
    });
  }
}

/** Arquivo de estado do rollback (fora do repo — nunca suja a arvore). */
function caminhoEstado(opts, repoDir) {
  return opts.stateFile ?? estadoPadrao(repoDir);
}

function gravarEstado(arquivo, dados) {
  mkdirSync(dirname(arquivo), { recursive: true });
  writeFileSync(arquivo, JSON.stringify(dados, null, 2));
}

function lerEstado(arquivo) {
  try { return JSON.parse(readFileSync(arquivo, "utf8")); } catch { return null; }
}

function gravarJournalDuravel(repoDir, dados, env = process.env) {
  return gravarEstadoExterno(repoDir, JOURNAL_UPDATE, {
    ...dados,
    atualizadoEm: new Date().toISOString(),
  }, env);
}

function lerJournalDuravel(repoDir, env = process.env) {
  return lerJournalExterno(repoDir, JOURNAL_UPDATE, env);
}

function limparJournalDuravel(repoDir, env = process.env) {
  removerEstado(repoDir, JOURNAL_UPDATE, env);
}

/** npm ci — sem fallback indiscriminado: falha e reportada. */
function npmCi(opts, executar, cwd, log) {
  log("[auto-update] Sincronizando dependencias (npm ci)...");
  const r = executar(npmCmd(), ["ci"], { cwd, timeoutMs: TIMEOUT_NPM_MS });
  if (r.code !== 0) {
    log(`[auto-update] npm ci falhou (codigo ${r.code}): ${String(r.stderr).trim().slice(0, 300)}`);
    return false;
  }
  return true;
}

/** Build do servidor (tsc) — sempre executado apos atualizacao. */
function buildServidor(opts, executar, cwd, log) {
  log("[auto-update] Compilando servidor...");
  const r = executar(npmCmd(), ["run", "build", "-w", "servidor"], { cwd, timeoutMs: TIMEOUT_BUILD_MS });
  if (r.code !== 0) {
    log(`[auto-update] Build do servidor falhou (codigo ${r.code}): ${String(r.stderr).trim().slice(0, 300)}`);
    return false;
  }
  return true;
}

function maisRecente(dir) {
  let max = 0;
  const pilha = [dir];
  while (pilha.length) {
    const d = pilha.pop();
    let itens;
    try { itens = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const it of itens) {
      const p = join(d, it.name);
      if (it.isDirectory()) pilha.push(p);
      else {
        try { const m = statSync(p).mtimeMs; if (m > max) max = m; } catch { /* ignora */ }
      }
    }
  }
  return max;
}

/** Mesma regra do .bat: recompila o site so quando src e mais novo que dist. */
function sitePrecisaBuild(cwd) {
  const src = join(cwd, "site", "src");
  const dist = join(cwd, "site", "dist");
  if (!existsSync(src)) return false;
  const tSrc = maisRecente(src);
  if (tSrc === 0) return false;
  if (!existsSync(dist)) return true;
  return tSrc > maisRecente(dist);
}

function buildSite(opts, executar, cwd, log, forcar = false) {
  if (!forcar && !sitePrecisaBuild(cwd)) { log("[auto-update] Frontend ja esta atualizado — pulando build do site."); return true; }
  log("[auto-update] Compilando frontend...");
  const r = executar(npmCmd(), ["run", "build", "-w", "site"], { cwd, timeoutMs: TIMEOUT_BUILD_MS });
  if (r.code !== 0) {
    log(`[auto-update] Build do frontend falhou (codigo ${r.code}): ${String(r.stderr).trim().slice(0, 300)}`);
    return false;
  }
  return true;
}

/**
 * Nucleo do rollback: executa `git reset --hard <shaAnterior>` somente
 * quando TODAS as garantias valem — estado com SHA anterior e SHA do
 * pull registrados, arvore limpa e HEAD exatamente no commit obtido
 * pelo pull (nada de sobrescrever alteracoes locais surgidas durante
 * o processo). Usado tanto pelo estado em memoria do boot quanto pelo
 * arquivo de estado (reverterAtualizacao).
 */
async function executarRollback(estado, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const executar = opts.executar ?? executarReal;
  const log = opts.log ?? (() => {});
  const envGit = { ...GIT_ENV, ...(opts.envGit ?? {}) };
  const git = (args, repoDir = cwd) => executar("git", args, { cwd: repoDir, env: envGit, timeoutMs: TIMEOUT_GIT_MS });

  if (!estado?.shaAnterior || !estado?.shaNovo) {
    return { ok: false, motivo: "sem-estado-de-atualizacao" };
  }
  const top = git(["rev-parse", "--show-toplevel"]);
  const repoDir = top.code === 0 ? String(top.stdout).trim() : cwd;
  const caminhoCanonico = (p) => caminhoCanonicoRepo(p);
  if (estado.repoDir && caminhoCanonico(estado.repoDir) !== caminhoCanonico(repoDir)) {
    return { ok: false, motivo: "repositorio-divergente" };
  }
  // Não mover outra branch caso alguém troque HEAD durante deps/build.
  // O SHA pode continuar igual após checkout de uma branch recém-criada;
  // SHA+árvore limpos, sozinhos, não identificam a branch autorizada.
  if (estado.branch) {
    const branchAtual = git(["symbolic-ref", "--quiet", "--short", "HEAD"], repoDir);
    if (branchAtual.code !== 0 || String(branchAtual.stdout).trim() !== estado.branch) {
      return { ok: false, motivo: "branch-alterada-durante-atualizacao" };
    }
  }

  const status = git(["-c", "status.showUntrackedFiles=all", "status", "--porcelain", "-z", "--untracked-files=all"], repoDir);
  if (status.code !== 0 || avaliarStatusPorcelain(status.stdout, repoDir).sujo) {
    return { ok: false, motivo: "arvore-suja-rollback-bloqueado" };
  }
  const marcar = (fase) => {
    if (typeof opts.gravarJournal !== "function") return true;
    try {
      return opts.gravarJournal({ ...estado, fase, atualizadoEm: new Date().toISOString() }) === true;
    } catch {
      return false;
    }
  };
  if (!marcar("rollback-iniciado")) {
    return { ok: false, motivo: "falha-journal-rollback" };
  }

  const head = String(git(["rev-parse", "HEAD"], repoDir).stdout).trim();
  if (head !== estado.shaNovo && head !== estado.shaAnterior) {
    return { ok: false, motivo: "head-diferente-do-pull", head };
  }
  const anc = git(["merge-base", "--is-ancestor", estado.shaAnterior, head], repoDir);
  if (anc.code !== 0) {
    return { ok: false, motivo: "sha-anterior-nao-e-ancestral" };
  }

  if (head === estado.shaNovo) {
    log(`[auto-update] Revertendo para ${estado.shaAnterior.slice(0, 12)}...`);
    if (!marcar("rollback-reset-iniciado")) {
      return { ok: false, motivo: "falha-journal-rollback-reset" };
    }
    const reset = git(["reset", "--hard", estado.shaAnterior], repoDir);
    if (reset.code !== 0) {
      return { ok: false, motivo: "falha-reset-rollback" };
    }
  } else {
    // Um crash pode acontecer depois do reset e antes do rebuild/cleanup.
    // HEAD já está no SHA anterior; repetimos deps/builds sem reset adicional.
    log("[auto-update] HEAD ja esta no SHA anterior; retomando deps/builds do rollback...");
  }
  if (!marcar("rollback-codigo-restaurado")) {
    return { ok: false, motivo: "falha-journal-codigo-restaurado", revertido: true };
  }

  // Restaura dependencias e artefatos compilados da versao anterior.
  // O site/dist e ignorado pelo Git, portanto sempre recompilamos ambos
  // os workspaces antes de declarar a recuperacao concluida.
  if (estado.depsMudaram) {
    if (!marcar("rollback-dependencias-iniciado")) {
      return { ok: false, motivo: "falha-journal-dependencias", revertido: true };
    }
    if (!npmCi(opts, executar, repoDir, log)) {
      return { ok: false, motivo: "npm-ci-pos-rollback-falhou", revertido: true };
    }
    if (!marcar("rollback-dependencias-concluido")) {
      return { ok: false, motivo: "falha-journal-dependencias-concluidas", revertido: true };
    }
  }
  if (!marcar("rollback-build-servidor-iniciado")) {
    return { ok: false, motivo: "falha-journal-build-servidor", revertido: true };
  }
  if (!buildServidor(opts, executar, repoDir, log)) {
    return { ok: false, motivo: "build-servidor-pos-rollback-falhou", revertido: true };
  }
  if (!marcar("rollback-build-servidor-concluido")) {
    return { ok: false, motivo: "falha-journal-build-servidor-concluido", revertido: true };
  }
  if (!marcar("rollback-build-site-iniciado")) {
    return { ok: false, motivo: "falha-journal-build-site", revertido: true };
  }
  if (!buildSite(opts, executar, repoDir, log, true)) {
    return { ok: false, motivo: "build-site-pos-rollback-falhou", revertido: true };
  }
  if (!marcar("rollback-concluido")) {
    return { ok: false, motivo: "falha-journal-rollback-concluido", revertido: true };
  }
  if (opts.stateFile) { try { rmSync(opts.stateFile, { force: true }); } catch { /* ok */ } }
  return { ok: true, shaAnterior: estado.shaAnterior };
}

/**
 * Rollback orientado pelo SHA anterior, a partir do arquivo de estado
 * gravado pelo boot (recuperacao manual/persistencia entre processos).
 */
export async function reverterAtualizacao(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const executar = opts.executar ?? executarReal;
  const envGit = { ...GIT_ENV, ...(opts.envGit ?? {}) };
  const git = (args, repoDir = cwd) => executar("git", args, { cwd: repoDir, env: envGit, timeoutMs: TIMEOUT_GIT_MS });
  const top = git(["rev-parse", "--show-toplevel"]);
  const repoDir = top.code === 0 ? String(top.stdout).trim() : cwd;
  const arquivo = caminhoEstado(opts, repoDir);
  const estado = lerEstado(arquivo);
  if (!estado?.shaAnterior || !estado?.shaNovo) {
    return { ok: false, motivo: "sem-estado-de-atualizacao" };
  }
  return executarRollback(estado, { ...opts, cwd: repoDir, stateFile: arquivo });
}

/**
 * Recupera journal durável de auto-update antes de qualquer etapa mutável
 * do próximo boot. Nunca tenta "adivinhar": exige mesma instalação, branch,
 * árvore limpa e HEAD igual ao SHA anterior ou ao SHA-alvo registrado.
 */
export async function recuperarAtualizacaoPendente(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const executar = opts.executar ?? executarReal;
  const log = opts.log ?? (() => {});
  const envGit = { ...GIT_ENV, ...(opts.envGit ?? {}) };
  const envEstado = opts.envEstado ?? process.env;
  // Estado/journal é consultado primeiro: instalações ZIP sem .git são
  // suportadas quando não há atualização pendente. Se houver journal,
  // a ausência de Git impede rollback e permanece fail-closed.
  const journalInicial = lerJournalDuravel(cwd, envEstado);
  if (journalInicial.status === "ausente") {
    return { ok: true, recuperado: false, motivo: "sem-journal" };
  }
  if (journalInicial.status !== "ok") {
    return { ok: false, motivo: `journal-${journalInicial.status}`, detalhes: journalInicial };
  }
  const git = (args, repoDir = cwd) => executar("git", args, { cwd: repoDir, env: envGit, timeoutMs: TIMEOUT_GIT_MS });
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ok: false, motivo: "sem-repositorio-git-com-journal" };
  const repoDir = String(top.stdout).trim();
  const journal = lerJournalDuravel(repoDir, envEstado);
  if (journal.status === "ausente") return { ok: true, recuperado: false, motivo: "sem-journal" };
  if (journal.status !== "ok") {
    return { ok: false, motivo: `journal-${journal.status}`, detalhes: journal };
  }

  const estado = journal.dados ?? {};
  if (estado.fase === "concluido") {
    try { limparJournalDuravel(repoDir, envEstado); }
    catch (e) { return { ok: false, motivo: "falha-limpar-journal-concluido", detalhe: String(e?.message ?? e) }; }
    return { ok: true, recuperado: false, motivo: "journal-concluido" };
  }

  const shaValido = (s) => typeof s === "string" && /^[0-9a-f]{40}$/i.test(s);
  if (!shaValido(estado.shaAnterior) || !shaValido(estado.shaNovo)
      || !estado.branch || !estado.repoDir || typeof estado.depsMudaram !== "boolean") {
    return { ok: false, motivo: "journal-incompleto" };
  }
  const canon = (p) => caminhoCanonicoRepo(p);
  if (canon(estado.repoDir) !== canon(repoDir)) {
    return { ok: false, motivo: "repositorio-divergente" };
  }

  const branchAtual = git(["symbolic-ref", "--quiet", "--short", "HEAD"], repoDir);
  if (branchAtual.code !== 0 || String(branchAtual.stdout).trim() !== estado.branch) {
    return { ok: false, motivo: "branch-alterada-durante-atualizacao" };
  }
  const status = git(["-c", "status.showUntrackedFiles=all", "status", "--porcelain", "-z", "--untracked-files=all"], repoDir);
  if (status.code !== 0 || avaliarStatusPorcelain(status.stdout, repoDir).sujo) {
    return { ok: false, motivo: "arvore-suja-recuperacao-bloqueada" };
  }
  const head = String(git(["rev-parse", "HEAD"], repoDir).stdout).trim();

  // A intenção foi persistida antes do fast-forward. Se o HEAD ainda é o
  // SHA anterior e o worktree está limpo, o merge não chegou a aplicar.
  if (head === estado.shaAnterior && estado.fase === "pull-iniciado") {
    try { limparJournalDuravel(repoDir, envEstado); }
    catch (e) { return { ok: false, motivo: "falha-limpar-intencao-sem-pull", detalhe: String(e?.message ?? e) }; }
    log("[auto-update] Journal indica que o fast-forward não foi aplicado; estado anterior intacto.");
    return { ok: true, recuperado: true, motivo: "pull-nao-aplicado" };
  }
  if (head !== estado.shaNovo && head !== estado.shaAnterior) {
    return { ok: false, motivo: "head-diferente-dos-shas-do-journal", head };
  }

  log(`[auto-update] Recuperação pendente detectada (fase=${estado.fase}, HEAD=${head.slice(0, 12)}).`);
  const gravar = (dados) => {
    gravarJournalDuravel(repoDir, dados, envEstado);
    return true;
  };
  const rollback = await executarRollback(estado, {
    ...opts, cwd: repoDir, executar, log, gravarJournal: gravar,
  });
  if (!rollback.ok) {
    log(`[auto-update] Recuperação não concluída (${rollback.motivo}); boot bloqueado.`);
    return { ok: false, motivo: rollback.motivo, rollback };
  }
  try {
    gravar({ ...estado, fase: "concluido", concluidoEm: new Date().toISOString() });
    limparJournalDuravel(repoDir, envEstado);
  } catch (e) {
    return { ok: false, motivo: "falha-finalizar-journal", detalhe: String(e?.message ?? e), rollback };
  }
  log(`[auto-update] Recuperação concluída; código retornou ao SHA ${estado.shaAnterior.slice(0, 12)}.`);
  return { ok: true, recuperado: true, motivo: "rollback-concluido", shaAnterior: estado.shaAnterior };
}

function instrucaoRecuperacao(log, branchOriginal) {
  log("[auto-update] RECUPERACAO MANUAL NECESSARIA:");
  log("  1. Verifique 'git status' — nenhuma alteracao local foi descartada.");
  if (branchOriginal) {
    log(`  2. Confira 'git branch --show-current': a branch original era '${branchOriginal}'. Se estiver em outra branch, NAO execute reset nela.`);
    log("  3. Só na branch original e com a arvore limpa, avalie o reset para <SHA-ANTERIOR>.");
  } else {
    log("  2. Confirme manualmente a branch original antes de qualquer reset.");
    log("  3. Só com a branch original e arvore limpa, avalie o reset para <SHA-ANTERIOR>.");
  }
  log("  4. Rode 'npm ci' e 'npm run build' manualmente.");
  log("  5. Detalhes em docs/GUIA-OPERACAO.md — secao 'Atualizacao automatica'.");
}

/**
 * Fluxo completo chamado pelo .bat: verificar → (se aplicou) deps →
 * builds → rollback seguro em qualquer falha. Retorna codigo de saida:
 * 0 = seguir boot normal; 1 = estado inseguro, .bat deve abortar.
 */
export async function executarBoot(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const executar = opts.executar ?? executarReal;
  const log = opts.log ?? ((m) => console.log(m));
  const persistirDuravel = opts.persistirDuravel === true;
  const envEstado = opts.envEstado ?? process.env;
  const persistir = (dados) => {
    if (!persistirDuravel) return true;
    try {
      gravarJournalDuravel(dados.repoDir ?? cwd, dados, envEstado);
      return true;
    } catch (e) {
      log(`[auto-update] Falha ao persistir journal durável (${String(e?.message ?? e).slice(0, 200)}).`);
      return false;
    }
  };
  const limparJournal = (repoDir) => {
    if (!persistirDuravel) return true;
    try {
      limparJournalDuravel(repoDir, envEstado);
      return true;
    } catch (e) {
      log(`[auto-update] Journal concluído, mas não pôde ser removido (${String(e?.message ?? e).slice(0, 160)}).`);
      return false;
    }
  };

  // Kill-switch por configuracao (Issue #156): MESTRE_AUTO_UPDATE=0
  // desativa o atualizador nesta instalacao. Verificado antes de
  // qualquer operacao Git/npm — nenhum comando e executado neste
  // caminho e o boot normal segue sem atualizacao.
  if (String(process.env.MESTRE_AUTO_UPDATE ?? "").trim() === "0") {
    log("[auto-update] Desativado por configuracao (MESTRE_AUTO_UPDATE=0) — seguindo com a versao local.");
    return { codigo: 0, atualizou: false, motivo: "desativado-por-configuracao" };
  }

  let v;
  try {
    v = await verificarAtualizacao({
      ...opts, cwd, executar, log,
      registrarPullAntes: persistirDuravel
        ? (dados) => persistir(dados)
        : opts.registrarPullAntes,
      limparJournalSemPull: persistirDuravel
        ? (repoDir) => limparJournal(repoDir)
        : opts.limparJournalSemPull,
    });
  } catch (e) {
    // excecao ANTES do pull nao pode ter atualizado o HEAD — boot local
    log(`[auto-update] Erro inesperado na verificacao: ${String(e?.message ?? e).slice(0, 200)} — seguindo com a versao local.`);
    return { codigo: 0, atualizou: false, motivo: "erro-verificacao" };
  }

  // pull aplicado mas pos-pull falhou dentro do verificar (ou estado
  // incerto): tentar rollback controlado; nunca sair 0 sem integridade.
  if (v.rollback) {
    const gravarRollback = persistirDuravel
      ? (dados) => persistir(dados)
      : undefined;
    if (persistirDuravel && !persistir({ ...v.rollback, fase: "rollback-iniciado" })) {
      instrucaoRecuperacao(log, v.rollback.branch);
      return { codigo: 1, atualizou: true, revertido: false, motivo: "falha-journal-rollback" };
    }
    let rb;
    try {
      rb = await executarRollback(v.rollback, {
        ...opts, cwd: v.repoDir ?? cwd, executar, log,
        gravarJournal: gravarRollback,
      });
    } catch (e) {
      log(`[auto-update] Excecao durante o rollback: ${String(e?.message ?? e).slice(0, 200)}`);
      rb = { ok: false, motivo: "excecao-rollback" };
    }
    if (rb.ok) {
      if (persistirDuravel) {
        if (!persistir({ ...v.rollback, fase: "concluido", concluidoEm: new Date().toISOString() })) {
          return { codigo: 1, atualizou: true, revertido: false, motivo: "falha-finalizar-journal-rollback" };
        }
        limparJournal(v.repoDir ?? cwd);
      }
      log(`[auto-update] Rollback concluido — boot segue com a versao local (${v.rollback.shaAnterior.slice(0, 12)}).`);
      return { codigo: 0, atualizou: false, revertido: true, motivo: v.motivo };
    }
    log(`[auto-update] Rollback NAO foi possivel com seguranca (${rb.motivo}).`);
    instrucaoRecuperacao(log, v.rollback.branch);
    return { codigo: 1, atualizou: true, revertido: false, motivo: rb.motivo };
  }

  if (!v.atualizou) {
    const msgs = {
      "git-indisponivel": "Git nao encontrado — seguindo com a versao local.",
      "sem-repositorio-git": "Sem .git (instalacao ZIP) — sem atualizacao automatica.",
      "remoto-desconhecido": `Remoto 'origin' nao e o repositorio oficial (${v.remoto ?? "?"}) — atualizacao ignorada.`,
      "head-detached": "HEAD destacado — atualizacao ignorada.",
      "sem-upstream": "Branch sem upstream configurado — atualizacao ignorada.",
      "upstream-invalido": `Upstream '${v.upstream ?? "?"}' nao e 'origin/${v.branch}' — atualizacao ignorada (remoto nao oficial).`,
      "upstream-nao-reflete-remoto": "O upstream local nao corresponde a branch homonima do remoto — atualizacao ignorada (fetch/merge customizado).",
      "arvore-suja": "Alteracoes locais detectadas — atualizacao adiada para nao conflitar; revise e rode 'git pull' manualmente se quiser.",
      "falha-fetch": "Falha ao buscar atualizacoes (sem rede ou autenticacao) — seguindo com a versao local.",
      "falha-pull": "Nao foi possivel aplicar o pull --ff-only — seguindo com a versao local.",
      "divergente": "Branch local divergiu do remoto — atualizacao cancelada; faca merge/rebase manual se desejado.",
      "sem-atualizacao": null,
      "estado-incerto-pos-pull": "Estado incerto apos tentativa de pull — verifique 'git status' manualmente.",
      "pull-nao-foi-ff": "Pull nao resultou em fast-forward — verifique manualmente.",
      "falha-status": "Nao foi possivel ler 'git status' — atualizacao ignorada.",
      "falha-comparacao": "Nao foi possivel comparar com o remoto — atualizacao ignorada.",
    };
    const msg = msgs[v.motivo];
    if (msg) log(`[auto-update] ${msg}`);
    return { codigo: 0, atualizou: false, motivo: v.motivo };
  }

  log(`[auto-update] Atualizacao aplicada: ${v.commits} commit(s) (${v.shaAnterior.slice(0, 12)} → ${v.shaNovo.slice(0, 12)}, branch ${v.branch}).`);
  const repoDir = v.repoDir;
  const arquivo = caminhoEstado(opts, repoDir);
  const estadoMemoria = {
    shaAnterior: v.shaAnterior,
    shaNovo: v.shaNovo,
    repoDir,
    branch: v.branch,
    commits: v.commits,
    depsMudaram: v.depsMudaram,
    siteMudou: v.siteMudou,
  };
  const gravarFase = (fase, extra = {}) => {
    if (!persistirDuravel) return true;
    return persistir({ ...estadoMemoria, fase, ...extra });
  };
  if (persistirDuravel) {
    // A intenção pull-iniciado já está persistida desde ANTES do merge.
    // Atualizamos agora com o SHA realmente aplicado antes de npm/build.
    if (!gravarFase("pull-concluido")) {
      log("[auto-update] Não foi possível confirmar o SHA aplicado no journal; boot bloqueado para recuperação.");
      return { codigo: 1, atualizou: true, motivo: "falha-journal-pos-pull" };
    }
  } else {
    // Compatibilidade com os testes/integradores que injetam stateFile:
    // mantém o formato de rollback em arquivo fora do worktree.
    try {
      gravarEstado(arquivo, { ...estadoMemoria, em: new Date().toISOString() });
    } catch (e) {
      log(`[auto-update] Aviso: nao foi possivel gravar o estado de rollback em disco (${String(e?.message ?? e).slice(0, 120)}) — a reversao continua protegida em memoria.`);
    }
  }

  const gravarJournalRollback = persistirDuravel
    ? (dados) => persistir(dados)
    : undefined;
  const tentarRollback = async () => {
    if (persistirDuravel && !gravarFase("rollback-iniciado")) {
      return { ok: false, motivo: "falha-journal-rollback" };
    }
    return executarRollback(estadoMemoria, {
      ...opts, cwd: repoDir, executar, log,
      ...(persistirDuravel
        ? { gravarJournal: gravarJournalRollback }
        : { stateFile: arquivo }),
    });
  };

  // Cada etapa começa SOMENTE depois de seu checkpoint durável.
  // Um SIGKILL em qualquer ponto deixa SHA anterior/alvo e fase suficiente
  // para o próximo boot reverter sem adivinhar o que ficou pela metade.
  const etapas = [];
  if (v.depsMudaram) etapas.push(["dependencias", () => npmCi(opts, executar, repoDir, log)]);
  etapas.push(["build-servidor", () => buildServidor(opts, executar, repoDir, log)]);
  etapas.push(["build-site", () => buildSite(opts, executar, repoDir, log, v.siteMudou)]);

  for (const [etapa, fn] of etapas) {
    if (!gravarFase(`${etapa}-iniciado`, { etapa })) {
      log(`[auto-update] Não foi possível gravar checkpoint antes de ${etapa}; boot bloqueado.`);
      return { codigo: 1, atualizou: true, motivo: `falha-journal-${etapa}-inicio` };
    }
    let okEtapa;
    try {
      okEtapa = fn();
    } catch (e) {
      log(`[auto-update] Excecao inesperada em etapa de build/deps: ${String(e?.message ?? e).slice(0, 200)}`);
      okEtapa = false;
    }
    if (!okEtapa) {
      let rb;
      try {
        rb = await tentarRollback();
      } catch (e) {
        log(`[auto-update] Excecao durante o rollback: ${String(e?.message ?? e).slice(0, 200)}`);
        rb = { ok: false, motivo: "excecao-rollback" };
      }
      if (rb.ok) {
        if (persistirDuravel) {
          if (!gravarFase("concluido", { concluidoEm: new Date().toISOString() })) {
            return { codigo: 1, atualizou: true, revertido: true, motivo: "falha-finalizar-journal-rollback" };
          }
          limparJournal(repoDir);
        }
        log(`[auto-update] Rollback concluido — boot segue com a versao local (${v.shaAnterior.slice(0, 12)}).`);
        return { codigo: 0, atualizou: false, revertido: true, shaAnterior: v.shaAnterior };
      }
      log(`[auto-update] Rollback NAO foi possivel com seguranca (${rb.motivo}).`);
      instrucaoRecuperacao(log, estadoMemoria.branch);
      return { codigo: 1, atualizou: true, revertido: false, motivo: rb.motivo };
    }
    if (!gravarFase(`${etapa}-concluido`, { etapa })) {
      log(`[auto-update] Etapa ${etapa} terminou, mas seu checkpoint não pôde ser persistido; boot bloqueado.`);
      return { codigo: 1, atualizou: true, motivo: `falha-journal-${etapa}-conclusao` };
    }
  }

  if (persistirDuravel) {
    if (!gravarFase("concluido", { concluidoEm: new Date().toISOString() })) {
      log("[auto-update] Build concluído, mas o journal não pôde ser finalizado; boot bloqueado.");
      return { codigo: 1, atualizou: true, motivo: "falha-finalizar-journal" };
    }
    // Se a remoção falhar, a fase concluido permanece válida e o preflight
    // seguinte fará somente a limpeza segura do journal.
    limparJournal(repoDir);
  } else {
    try { rmSync(arquivo, { force: true }); } catch { /* ok */ }
  }
  return { codigo: 0, atualizou: true, shaNovo: v.shaNovo };
}

// ---------- CLI ----------
const ehCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ehCli) {
  executarBoot({ cwd: process.cwd(), persistirDuravel: true }).then((r) => process.exit(r.codigo)).catch((e) => {
    // excecao que escapou do fluxo: nao da para garantir integridade —
    // bloqueia o boot em vez de subir possivelmente sobre codigo
    // atualizado sem deps/build (B2).
    console.error(`[auto-update] Erro inesperado: ${e?.message ?? e}`);
    console.error("[auto-update] Verifique 'git status' e docs/GUIA-OPERACAO.md — secao 'Atualizacao automatica'.");
    process.exit(1);
  });
}
