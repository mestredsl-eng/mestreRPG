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
// Nunca executa: stash, clean, reset --hard preventivo, merge,
// rebase, force ou descarte de arquivos. O unico reset rollback
// verificado (arvore limpa + HEAD exatamente no commit do pull).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Execucao real de comandos. Injetavel nos testes. */
export function executarReal(cmd, args, { cwd, env, timeoutMs } = {}) {
  const ambiente = { ...process.env, ...(env ?? {}) };
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
  const status = git(["status", "--porcelain"]);
  if (status.code !== 0) return pular("falha-status", { repoDir, branch });
  if (String(status.stdout).trim() !== "") return pular("arvore-suja", { repoDir, branch });

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

  // 9. pull exclusivamente fast-forward; SHA anterior registrado antes.
  //    A partir daqui qualquer excecao inesperada pode deixar o HEAD
  //    atualizado sem deps/build — devolvemos `rollback` para o boot
  //    tentar a reversao controlada em vez de propagar erro (B2).
  const shaAnterior = String(git(["rev-parse", "HEAD"]).stdout).trim();
  try {
    log(`[auto-update] ${nBehind} commit(s) novo(s) em ${upstream} — aplicando fast-forward...`);
    const pull = git(["pull", "--ff-only"], tPull);
    if (pull.code !== 0) {
      const headAgora = String(git(["rev-parse", "HEAD"]).stdout).trim();
      if (headAgora !== shaAnterior) {
        return pular("estado-incerto-pos-pull", {
          repoDir, branch, shaAnterior,
          rollback: { shaAnterior, shaNovo: headAgora, repoDir, depsMudaram: true, branch },
          detalhe: String(pull.stderr).trim().slice(0, 300),
        });
      }
      return pular("falha-pull", { repoDir, branch, shaAnterior, detalhe: String(pull.stderr).trim().slice(0, 300) });
    }

    const shaNovo = String(git(["rev-parse", "HEAD"]).stdout).trim();
    const anc = git(["merge-base", "--is-ancestor", shaAnterior, shaNovo]);
    if (shaNovo === shaAnterior || anc.code !== 0) {
      return pular("pull-nao-foi-ff", {
        repoDir, branch, shaAnterior, shaNovo,
        rollback: { shaAnterior, shaNovo, repoDir, depsMudaram: true, branch },
      });
    }
    const commits = git(["rev-list", "--count", `${shaAnterior}..${shaNovo}`]);
    const nCommits = commits.code === 0 ? Number(String(commits.stdout).trim()) : nBehind;

    // dependencias mudaram? (lockfile ou package.json) ou node_modules ausente
    const diffDeps = git(["diff", "--name-only", shaAnterior, shaNovo, "--", "package-lock.json", "package.json"]);
    if (diffDeps.code !== 0) {
      // Depois do pull, não presumir que deps ficaram iguais quando o
      // diagnóstico falha: marcar como potencialmente alteradas e reverter.
      return pular("falha-diagnostico-dependencias", {
        repoDir, branch, shaAnterior, shaNovo,
        rollback: { shaAnterior, shaNovo, repoDir, depsMudaram: true, branch },
        detalhe: String(diffDeps.stderr).trim().slice(0, 300),
      });
    }
    const depsMudaram = String(diffDeps.stdout).trim() !== ""
      || !existsSync(join(repoDir, "node_modules"));

    return {
      atualizou: true, motivo: "atualizado", repoDir, branch,
      shaAnterior, shaNovo, commits: Number.isFinite(nCommits) ? nCommits : nBehind,
      depsMudaram,
    };
  } catch (e) {
    // excecao apos (ou durante) o pull: HEAD pode estar atualizado.
    // Rollback so e tentado pelo boot com as mesmas garantias de sempre.
    let headAgora = "";
    try { headAgora = String(git(["rev-parse", "HEAD"]).stdout).trim(); } catch { /* ignora */ }
    return pular("erro-inesperado-pos-pull", {
      repoDir, branch, shaAnterior,
      rollback: { shaAnterior, shaNovo: headAgora || shaAnterior, repoDir, depsMudaram: true, branch },
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

function buildSite(opts, executar, cwd, log) {
  if (!sitePrecisaBuild(cwd)) { log("[auto-update] Frontend ja esta atualizado — pulando build do site."); return true; }
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
  if (estado.repoDir && resolve(estado.repoDir) !== resolve(repoDir)) {
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

  const status = git(["status", "--porcelain"], repoDir);
  if (status.code !== 0 || String(status.stdout).trim() !== "") {
    return { ok: false, motivo: "arvore-suja-rollback-bloqueado" };
  }
  const head = String(git(["rev-parse", "HEAD"], repoDir).stdout).trim();
  if (head !== estado.shaNovo) {
    return { ok: false, motivo: "head-diferente-do-pull", head };
  }
  const anc = git(["merge-base", "--is-ancestor", estado.shaAnterior, head], repoDir);
  if (anc.code !== 0) {
    return { ok: false, motivo: "sha-anterior-nao-e-ancestral" };
  }

  log(`[auto-update] Revertendo para ${estado.shaAnterior.slice(0, 12)}...`);
  const reset = git(["reset", "--hard", estado.shaAnterior], repoDir);
  if (reset.code !== 0) {
    return { ok: false, motivo: "falha-reset-rollback" };
  }

  // restaura dependencias da versao anterior quando o lockfile mudou
  if (estado.depsMudaram) {
    if (!npmCi(opts, executar, repoDir, log)) {
      return { ok: false, motivo: "npm-ci-pos-rollback-falhou", revertido: true };
    }
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

  let v;
  try {
    v = await verificarAtualizacao({ ...opts, cwd, executar, log });
  } catch (e) {
    // excecao ANTES do pull nao pode ter atualizado o HEAD — boot local
    log(`[auto-update] Erro inesperado na verificacao: ${String(e?.message ?? e).slice(0, 200)} — seguindo com a versao local.`);
    return { codigo: 0, atualizou: false, motivo: "erro-verificacao" };
  }

  // pull aplicado mas pos-pull falhou dentro do verificar (ou estado
  // incerto): tentar rollback controlado; nunca sair 0 sem integridade.
  if (v.rollback) {
    let rb;
    try {
      rb = await executarRollback(v.rollback, { ...opts, cwd: v.repoDir ?? cwd, executar, log });
    } catch (e) {
      log(`[auto-update] Excecao durante o rollback: ${String(e?.message ?? e).slice(0, 200)}`);
      rb = { ok: false, motivo: "excecao-rollback" };
    }
    if (rb.ok) {
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
  // SHA anterior e SHA do pull ficam registrados em memoria para o
  // rollback; a persistencia em arquivo e best-effort (B2) — sua
  // falha nao pode impedir a protecao dentro deste processo.
  const estadoMemoria = {
    shaAnterior: v.shaAnterior, shaNovo: v.shaNovo, repoDir,
    depsMudaram: v.depsMudaram, branch: v.branch,
  };
  try {
    gravarEstado(arquivo, { ...estadoMemoria, em: new Date().toISOString() });
  } catch (e) {
    log(`[auto-update] Aviso: nao foi possivel gravar o estado de rollback em disco (${String(e?.message ?? e).slice(0, 120)}) — a reversao continua protegida em memoria.`);
  }

  const tentarRollback = () => executarRollback(estadoMemoria, { ...opts, cwd: repoDir, executar, log, stateFile: arquivo });

  // deps → build servidor → build site; qualquer falha ou excecao
  // tenta rollback — excecao pos-pull NUNCA retorna sucesso (B2).
  const etapas = [];
  if (v.depsMudaram) etapas.push(["dependencias", () => npmCi(opts, executar, repoDir, log)]);
  etapas.push(["build-servidor", () => buildServidor(opts, executar, repoDir, log)]);
  etapas.push(["build-site", () => buildSite(opts, executar, repoDir, log)]);

  for (const [, fn] of etapas) {
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
        log(`[auto-update] Rollback concluido — boot segue com a versao local (${v.shaAnterior.slice(0, 12)}).`);
        return { codigo: 0, atualizou: false, revertido: true, shaAnterior: v.shaAnterior };
      }
      log(`[auto-update] Rollback NAO foi possivel com seguranca (${rb.motivo}).`);
      instrucaoRecuperacao(log, estadoMemoria.branch);
      return { codigo: 1, atualizou: true, revertido: false, motivo: rb.motivo };
    }
  }

  try { rmSync(arquivo, { force: true }); } catch { /* ok */ }
  return { codigo: 0, atualizou: true, shaNovo: v.shaNovo };
}

// ---------- CLI ----------
const ehCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (ehCli) {
  executarBoot({ cwd: process.cwd() }).then((r) => process.exit(r.codigo)).catch((e) => {
    // excecao que escapou do fluxo: nao da para garantir integridade —
    // bloqueia o boot em vez de subir possivelmente sobre codigo
    // atualizado sem deps/build (B2).
    console.error(`[auto-update] Erro inesperado: ${e?.message ?? e}`);
    console.error("[auto-update] Verifique 'git status' e docs/GUIA-OPERACAO.md — secao 'Atualizacao automatica'.");
    process.exit(1);
  });
}
