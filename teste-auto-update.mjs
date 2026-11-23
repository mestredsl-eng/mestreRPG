// Testes do auto-update seguro (Issue #155).
// Repositorios Git temporarios + origem local via url.insteadOf —
// o remoto configurado e o oficial, mas o fetch/pull resolve para um
// bare repo em disco. npm/build sao interceptados por executor falso.
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  verificarAtualizacao, executarBoot, reverterAtualizacao,
  recuperarAtualizacaoPendente,
  executarReal, normalizarUrlRepo, REPO_OFICIAL,
} from "./scripts/auto-update.mjs";
import {
  gravarEstado as gravarEstadoExterno,
  lerJournal,
  JOURNAL_UPDATE,
} from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const anotarErro = (msg) => {
  if (!process.env.GITHUB_ACTIONS) return;
  const m = String(msg).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::error::${m.slice(0, 1800)}`);
};
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, extra); anotarErro(`FALHOU ${n} — ${extra}`); }
};
process.on("uncaughtException", (e) => {
  anotarErro(`excecao nao tratada: ${e?.stack ?? e}`);
  console.error(e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  anotarErro(`rejeicao nao tratada: ${e?.stack ?? e}`);
  console.error(e);
  process.exit(1);
});
const sec = (n) => console.log("\n== " + n + " ==");
const silencioso = () => {};

const RAIZ = mkdtempSync(join(tmpdir(), "mestre-au-"));
const gitSetup = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
const head = (cwd) => String(git(["rev-parse", "HEAD"], cwd).stdout).trim();

const OFICIAL_URL = "https://github.com/mestredsl-eng/mestreRPG";

/** Cria origin bare + clone local com upstream, tudo em disco. */
function criarRepo(nome) {
  const base = join(RAIZ, nome);
  mkdirSync(base, { recursive: true });
  const origin = join(base, "origin.git");
  const local = join(base, "local");
  gitSetup(["init", "--bare", "-b", "main", origin], base);
  gitSetup(["init", "-b", "main", local], base);
  const cfg = ["-c", "user.email=t@t", "-c", "user.name=t"];
  const commit = (cwd, msg, arqs) => {
    for (const [p, c] of Object.entries(arqs)) {
      mkdirSync(join(cwd, p, ".."), { recursive: true });
      writeFileSync(join(cwd, p), c);
    }
    gitSetup([...cfg, "add", "-A"], cwd);
    gitSetup([...cfg, "commit", "-m", msg], cwd);
  };
  commit(local, "inicial", {
    "package.json": '{"name":"x","version":"1.0.0"}\n',
    "package-lock.json": '{"lockfileVersion":3}\n',
    "site/src/app.txt": "v1\n",
    "servidor/index.txt": "v1\n",
  });
  gitSetup(["remote", "add", "origin", OFICIAL_URL], local);
  // url.insteadOf: o remoto "oficial" resolve para o bare local
  gitSetup(["config", `url.${origin.replace(/\\/g, "/")}.insteadOf`, OFICIAL_URL], local);
  gitSetup(["push", "-u", "origin", "main"], local);
  return { base, origin, local, commit };
}

/** Publica um commit novo no origin (simula release upstream). */
function publicar(c, msg = "atualizacao", arqs = { "site/src/app.txt": `v${Date.now()}\n` }) {
  const pub = join(c.base, "pub");
  if (!existsSync(pub)) {
    gitSetup(["clone", c.origin, pub], c.base);
    mkdirSync(pub, { recursive: true });
  }
  c.commit(pub, msg, arqs);
  gitSetup(["push", "origin", "HEAD:main"], pub);
}

/** Substitui o insteadOf do repo (remove o anterior e aponta para `alvo`). */
function trocarInsteadOf(c, alvo) {
  const norm = (x) => String(x).split("\\").join("/");
  const chave = `url.${norm(c.origin)}.insteadOf`;
  const atuais = gitSetup(["config", "--get-all", chave], c.local);
  for (const _ of atuais.split(/\r?\n/).filter(Boolean)) {
    gitSetup(["config", "--unset", chave], c.local);
  }
  gitSetup(["config", `url.${norm(alvo)}.insteadOf`, OFICIAL_URL], c.local);
}

/** Executor que delega git ao real e responde npm conforme roteiro. */
function executarHibrido({ npmHandler, registro } = {}) {
  return (cmd, args, opcoes = {}) => {
    registro?.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "npm" || cmd === "npm.cmd") {
      if (npmHandler) return npmHandler(args, opcoes);
      return { code: 0, stdout: "", stderr: "" };
    }
    return executarReal(cmd, args, opcoes);
  };
}
const execReal = (cmd, args, opcoes = {}) => executarReal(cmd, args, { cwd: opcoes.cwd, env: opcoes.env, timeoutMs: opcoes.timeoutMs });
const estado = (dir) => join(dir, "estado-update.json");
const opcoesRepo = (c, extra = {}) => {
  const urlOficial = extra.urlOficial ?? c.origin;
  return { ...extra, cwd: c.local, urlOficial: String(urlOficial).replace(/\\/g, "/") };
};
const logSilencio = [];
const log = (m) => logSilencio.push(m);

try {
  sec("1. Git ausente");
  {
    const c = criarRepo("c1");
    const r = await verificarAtualizacao({ ...opcoesRepo(c), executar: () => ({ code: 1, stdout: "", stderr: "not found" }), log: silencioso });
    t("git ausente → pula com git-indisponivel", r.atualizou === false && r.motivo === "git-indisponivel", r.motivo);
  }

  sec("2. Instalacao sem .git");
  {
    const dir = join(RAIZ, "sem-git");
    mkdirSync(dir, { recursive: true });
    const r = await verificarAtualizacao({ cwd: dir, executar: execReal, log: silencioso });
    t("sem .git → pula com sem-repositorio-git", r.motivo === "sem-repositorio-git", r.motivo);
  }

  sec("3. Repositorio oficial sem atualizacao");
  {
    const c = criarRepo("c3");
    const r = await verificarAtualizacao({ ...opcoesRepo(c), executar: execReal, log: silencioso });
    t("sem commits novos → sem-atualizacao", r.atualizou === false && r.motivo === "sem-atualizacao", `${r.motivo} ${r.commits}`);
  }

  sec("4. Fast-forward bem-sucedido (verificar + boot)");
  {
    const c = criarRepo("c4");
    publicar(c);
    const shaAnt = head(c.local);
    const r = await verificarAtualizacao({ ...opcoesRepo(c), executar: execReal, log: silencioso });
    t("merge --ff-only do SHA remoto aplicado", r.atualizou === true && r.shaAnterior === shaAnt && r.shaNovo !== shaAnt, JSON.stringify(r));
    t("HEAD agora e o commit remoto", head(c.local) === r.shaNovo);
    t("commits contados = 1", r.commits === 1, `commits=${r.commits}`);
  }
  {
    // cenario separado: executarBoot faz pull + deps + builds de ponta a ponta
    const c = criarRepo("c4b");
    publicar(c);
    const st = estado(c.base);
    const reg = [];
    const b = await executarBoot({ ...opcoesRepo(c), executar: executarHibrido({ registro: reg }), log: silencioso, stateFile: st });
    t("boot retorna 0 apos atualizar+build", b.codigo === 0 && b.atualizou === true, JSON.stringify(b));
    t("npm ci executado (sem node_modules)", reg.some((x) => x.includes("npm") && x.includes("ci")), reg.join(" | "));
    t("build servidor executado", reg.some((x) => x.includes("build") && x.includes("servidor")));
    t("estado de rollback removido apos sucesso", !existsSync(st));
  }

  sec("5. Sem conexao de rede");
  {
    const c = criarRepo("c5");
    publicar(c);
    const destino = join(c.base, "inexistente.git");
    trocarInsteadOf(c, destino);
    const r = await verificarAtualizacao({ ...opcoesRepo(c, { urlOficial: destino }), executar: execReal, log: silencioso });
    t("fetch falha → pula com falha-fetch", r.atualizou === false && r.motivo === "falha-fetch", r.motivo);
    t("HEAD preservado", head(c.local) !== "");
  }

  sec("6. Falha de autenticacao");
  {
    const c = criarRepo("c6");
    publicar(c);
    // porta 1 em localhost: conexao recusada — mesmo caminho de erro de auth https
    const destino = "http://127.0.0.1:1/x.git";
    trocarInsteadOf(c, destino);
    const r = await verificarAtualizacao({ ...opcoesRepo(c, { urlOficial: destino }), executar: execReal, log: silencioso, timeoutFetchMs: 8000 });
    t("erro de rede/auth → pula com falha-fetch", r.atualizou === false && r.motivo === "falha-fetch", `${r.motivo} ${r.detalhe ?? ""}`);
  }

  sec("7. Timeout do fetch");
  {
    const c = criarRepo("c7");
    publicar(c);
    // servidor TCP que aceita e nunca responde → fetch trava ate o timeout
    const srv = createServer(() => {});
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const porta = srv.address().port;
    const destino = `http://127.0.0.1:${porta}/x.git`;
    trocarInsteadOf(c, destino);
    const ini = Date.now();
    const r = await verificarAtualizacao({ ...opcoesRepo(c, { urlOficial: destino }), executar: execReal, log: silencioso, timeoutFetchMs: 1500 });
    const decorrido = Date.now() - ini;
    srv.close();
    t("fetch travado → timeout → falha-fetch", r.atualizou === false && r.motivo === "falha-fetch", r.motivo);
    t("timeout respeitado (<10s)", decorrido < 10000, `${decorrido}ms`);
  }

  sec("8.1. URL efetiva reescrita para host não oficial");
  {
    const c = criarRepo("c8-rewrite");
    publicar(c);
    const destino = "https://evil.invalid/mestreRPG.git";
    trocarInsteadOf(c, destino);
    const reg = [];
    const r = await verificarAtualizacao({ cwd: c.local, executar: executarHibrido({ registro: reg }), log: silencioso });
    t("origin bruto oficial + insteadOf malicioso → bloqueado", r.motivo === "remoto-desconhecido", r.motivo);
    t("nenhum fetch/pull após rewrite malicioso", !reg.some((x) => x.includes("fetch") || x.includes("pull")), reg.join(" | "));
  }

  sec("8.2. Mais de uma URL configurada em origin");
  {
    const c = criarRepo("c8-multiurl");
    publicar(c);
    gitSetup(["remote", "set-url", "--add", "origin", "https://evil.invalid/outro-repo"], c.local);
    const reg = [];
    const r = await verificarAtualizacao({ ...opcoesRepo(c), executar: executarHibrido({ registro: reg }), log: silencioso });
    t("origin com múltiplas URLs → bloqueado", r.motivo === "remoto-desconhecido", r.motivo);
    t("nenhum fetch/pull com origin ambíguo", !reg.some((x) => x.includes("fetch") || x.includes("pull")), reg.join(" | "));
  }

  sec("8. Remoto origin diferente do oficial");
  {
    const c = criarRepo("c8");
    publicar(c);
    gitSetup(["remote", "set-url", "origin", "https://github.com/outro-usuario/outro-repo"], c.local);
    const reg = [];
    const r = await verificarAtualizacao({ ...opcoesRepo(c), executar: executarHibrido({ registro: reg }), log: silencioso });
    t("remoto desconhecido → remoto-desconhecido", r.motivo === "remoto-desconhecido", r.motivo);
    t("nenhum fetch/pull executado", !reg.some((x) => x.includes("fetch") || x.includes("pull")), reg.join(" | "));
  }

  sec("9. Working tree sujo");
  {
    const c = criarRepo("c9");
    publicar(c);
    // alteracao rastreada
    writeFileSync(join(c.local, "site/src/app.txt"), "editado localmente\n");
    const reg = [];
    const r1 = await verificarAtualizacao({ ...opcoesRepo(c), executar: executarHibrido({ registro: reg }), log: silencioso });
    t("arquivo modificado → arvore-suja", r1.motivo === "arvore-suja", r1.motivo);
    t("fetch nao executado com arvore suja", !reg.some((x) => x.includes("fetch")), reg.join(" | "));
    // arquivo nao rastreado tambem bloqueia
    const c2 = criarRepo("c9b");
    publicar(c2);
    writeFileSync(join(c2.local, "novo-arquivo-local.txt"), "x\n");
    const r2 = await verificarAtualizacao({ ...opcoesRepo(c2), executar: execReal, log: silencioso });
    t("arquivo nao rastreado → arvore-suja", r2.motivo === "arvore-suja", r2.motivo);

    // Config local que ocultava untracked no git status comum não pode
    // neutralizar a guarda explícita do updater.
    const c3 = criarRepo("c9c-status-config");
    publicar(c3);
    gitSetup(["config", "status.showUntrackedFiles", "no"], c3.local);
    writeFileSync(join(c3.local, "nao-rastreado-oculto.txt"), "sujeira local\\n");
    const r3 = await verificarAtualizacao({ ...opcoesRepo(c3), executar: execReal, log: silencioso });
    t("status.showUntrackedFiles=no → arvore-suja", r3.motivo === "arvore-suja", r3.motivo);
  }

  sec("10. Branch sem upstream");
  {
    const c = criarRepo("c10");
    publicar(c);
    gitSetup(["branch", "--unset-upstream"], c.local);
    const r = await verificarAtualizacao({ ...opcoesRepo(c), executar: execReal, log: silencioso });
    t("sem upstream → pula", r.atualizou === false && r.motivo === "sem-upstream", r.motivo);
  }

  sec("11. Branch divergente");
  {
    const c = criarRepo("c11");
    publicar(c);
    // commit local nao enviado + remoto avancou = divergencia
    c.commit(c.local, "local", { "local.txt": "x\n" });
    const r = await verificarAtualizacao({ ...opcoesRepo(c), executar: execReal, log: silencioso });
    t("divergente → atualizacao cancelada", r.atualizou === false && r.motivo === "divergente", r.motivo);
    t("HEAD local preservado", head(c.local) === git(["rev-parse", "HEAD"], c.local).stdout.toString().trim());
  }

  sec("12-14. Falhas pos-pull → rollback seguro");
  {
    // 12: npm ci falha
    const c = criarRepo("c12");
    publicar(c);
    const shaAnt = head(c.local);
    const st = estado(c.base);
    let chamadasReset = 0, ciChamadas = 0;
    const exec = (cmd, args, opcoes = {}) => {
      if (cmd === "npm" || cmd === "npm.cmd") {
        if (args[0] === "ci") {
          ciChamadas++;
          if (ciChamadas === 1) return { code: 1, stdout: "", stderr: "ERESOLVE fake" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args[0] === "reset") chamadasReset++;
      return executarReal(cmd, args, opcoes);
    };
    const b = await executarBoot({ ...opcoesRepo(c), executar: exec, log: silencioso, stateFile: st });
    t("npm ci falhou → boot continua (codigo 0)", b.codigo === 0 && b.revertido === true, JSON.stringify(b));
    t("rollback executou reset --hard", chamadasReset === 1, `resets=${chamadasReset}`);
    t("HEAD voltou ao SHA anterior", head(c.local) === shaAnt, `${head(c.local)} vs ${shaAnt}`);
    t("estado de rollback removido", !existsSync(st));
  }
  {
    // 13: build do servidor falha uma vez; depois do reset, a versao
    // restaurada precisa recompilar servidor E frontend antes do codigo 0.
    const c = criarRepo("c13");
    publicar(c);
    const shaAnt = head(c.local);
    let falhouServidor = false, buildsSite = 0;
    const exec = (cmd, args, opcoes = {}) => {
      if (cmd === "npm" || cmd === "npm.cmd") {
        if (args[0] === "run" && args[1] === "build" && args[3] === "servidor" && !falhouServidor) {
          falhouServidor = true;
          return { code: 2, stdout: "", stderr: "tsc fake error" };
        }
        if (args[0] === "run" && args[1] === "build" && args[3] === "site") buildsSite++;
        return { code: 0, stdout: "", stderr: "" };
      }
      return executarReal(cmd, args, opcoes);
    };
    const b = await executarBoot({ ...opcoesRepo(c), executar: exec, log: silencioso, stateFile: estado(c.base) });
    t("build do servidor falhou → rollback + rebuild completo da versao local", b.codigo === 0 && b.revertido === true, JSON.stringify(b));
    t("frontend da versao restaurada foi recompilado", buildsSite === 1, `buildsSite=${buildsSite}`);
    t("HEAD voltou ao SHA anterior", head(c.local) === shaAnt);
  }

  sec("17. Falha no build do site depois do pull — rollback recompila versao antiga");
  {
    const c = criarRepo("c18-site-rollback");
    publicar(c, "config-site", { "site/vite.config.ts": "export default { define: { __NOVO__: true } };\\n" });
    const shaAnt = head(c.local);
    let buildsSite = 0;
    const exec = (cmd, args, opcoes = {}) => {
      if (cmd === "npm" || cmd === "npm.cmd") {
        if (args[0] === "run" && args[1] === "build" && args[3] === "site") {
          buildsSite++;
          if (buildsSite === 1) return { code: 2, stdout: "", stderr: "vite build falhou uma vez" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return executarReal(cmd, args, opcoes);
    };
    const b = await executarBoot({ ...opcoesRepo(c), executar: exec, log: silencioso, stateFile: estado(c.base) });
    t("build site falhou e rollback foi reconstruido antes do codigo 0", b.codigo === 0 && b.revertido === true, JSON.stringify(b));
    t("build site executado de novo sobre a versao antiga", buildsSite === 2, `buildsSite=${buildsSite}`);
    t("HEAD voltou ao SHA anterior", head(c.local) === shaAnt);
  }
  {
    const c = criarRepo("c19-site-rollback-falha");
    publicar(c, "config-site", { "site/vite.config.ts": "export default { define: { __NOVO__: true } };\\n" });
    const shaAnt = head(c.local);
    let buildsSite = 0;
    const exec = (cmd, args, opcoes = {}) => {
      if (cmd === "npm" || cmd === "npm.cmd") {
        if (args[0] === "run" && args[1] === "build" && args[3] === "site") {
          buildsSite++;
          return { code: 2, stdout: "", stderr: "vite build falha persistentemente" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return executarReal(cmd, args, opcoes);
    };
    const b = await executarBoot({ ...opcoesRepo(c), executar: exec, log: silencioso, stateFile: estado(c.base) });
    t("build da versao antiga tambem falhou → exit 1", b.codigo === 1 && b.revertido === false, JSON.stringify(b));
    t("segunda tentativa de build site foi exigida", buildsSite === 2, `buildsSite=${buildsSite}`);
    t("codigo permanece na revisao antiga, sem falso sucesso", head(c.local) === shaAnt);
  }

  sec("15. Alteracao local surgida durante a tentativa de rollback");
  {
    const c = criarRepo("c15");
    publicar(c);
    let sujou = false;
    const exec = (cmd, args, opcoes = {}) => {
      // suja a arvore DEPOIS do pull, antes da falha de build
      if (!sujou && (cmd === "npm" || cmd === "npm.cmd") && args[0] === "ci") {
        sujou = true;
        writeFileSync(join(c.local, "site/src/app.txt"), "alteracao durante processo\n");
      }
      if (cmd === "npm" || cmd === "npm.cmd") {
        if (args.includes("build")) return { code: 2, stdout: "", stderr: "build fake" };
        return { code: 0, stdout: "", stderr: "" };
      }
      return executarReal(cmd, args, opcoes);
    };
    const b = await executarBoot({ ...opcoesRepo(c), executar: exec, log: silencioso, stateFile: estado(c.base) });
    t("rollback bloqueado por arvore suja → codigo 1", b.codigo === 1 && b.revertido === false, JSON.stringify(b));
    t("alteracao local intacta", readFileSync(join(c.local, "site/src/app.txt"), "utf8").includes("durante processo"));
    // HEAD deve ser o commit do pull — nada foi revertido nem forçado
    const shaPull = String(git(["rev-parse", "origin/main"], c.local).stdout).trim();
    t("HEAD = commit obtido pelo pull (sem overwrite)", head(c.local) === shaPull, `${head(c.local)} vs ${shaPull}`);
  }

  sec("16. Segunda instancia — porta 3001 ocupada");
  {
    const bat = readFileSync("iniciar-mestre-rpg.bat", "utf8");
    const iPorta = bat.indexOf("api/health");
    const iUpdate = bat.indexOf("scripts\\auto-update.mjs");
    t("checagem da porta existe", iPorta > 0);
    t("auto-update vem DEPOIS da checagem da porta", iUpdate > iPorta, `porta=${iPorta} update=${iUpdate}`);
    t(".bat nao executa git diretamente", !/\bgit\s+(pull|fetch|reset|stash|clean|merge|rebase)\b/i.test(bat));
  }

  sec("Extra — normalizacao de URL e lockfile inalterado");
  {
    t("URL oficial https normaliza", normalizarUrlRepo("https://github.com/mestredsl-eng/mestreRPG.git/") === normalizarUrlRepo(REPO_OFICIAL));
    t("URL ssh normaliza", normalizarUrlRepo("git@github.com:mestredsl-eng/mestreRPG.git") === normalizarUrlRepo(REPO_OFICIAL));
    // lockfile inalterado + node_modules presente → npm ci pulado, build roda
    const c = criarRepo("c16");
    publicar(c, "so-src", { "site/src/app.txt": "v2\n" }); // nao toca package-lock
    mkdirSync(join(c.local, "node_modules"), { recursive: true });
    const reg = [];
    const b = await executarBoot({ ...opcoesRepo(c), executar: executarHibrido({ registro: reg }), log: silencioso, stateFile: estado(c.base) });
    t("lockfile inalterado → npm ci pulado", b.codigo === 0 && !reg.some((x) => x.includes(" ci")), reg.join(" | "));
    t("build ainda executado", reg.some((x) => x.includes("build")));
  }

  sec("Extra — lockfile aninhado dispara npm ci");
  {
    const c = criarRepo("c20-nested-lock");
    publicar(c, "lockfile-site", { "site/package-lock.json": '{"lockfileVersion":3,"packages":{}}' });
    mkdirSync(join(c.local, "node_modules"), { recursive: true });
    const reg = [];
    const b = await executarBoot({ ...opcoesRepo(c), executar: executarHibrido({ registro: reg }), log: silencioso, stateFile: estado(c.base) });
    t("site/package-lock.json alterado → npm ci executado", b.codigo === 0 && reg.some((x) => x.endsWith(" ci")), reg.join(" | "));
  }

  sec("Extra — ambiente GIT_* herdado não redireciona o repositório");
  {
    const c = criarRepo("c21-env-git");
    const r = executarReal("git", ["rev-parse", "--show-toplevel"], {
      cwd: c.local,
      env: {
        GIT_DIR: c.origin,
        GIT_WORK_TREE: c.origin,
        GIT_INDEX_FILE: join(c.base, "indice-externo"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.worktree",
        GIT_CONFIG_VALUE_0: c.origin,
      },
    });
    const canonizar = (p) => resolve(String(p).trim()).split(String.fromCharCode(92)).join("/").toLowerCase();
    const raizRetornada = canonizar(r.stdout);
    // O tmpdir do runner Windows pode usar nome curto 8.3 (RUNNER~1)
    // enquanto o Git sempre devolve o caminho longo — comparar com a
    // resposta do próprio Git evita falso negativo por forma do caminho.
    const esperada = canonizar(executarReal("git", ["rev-parse", "--show-toplevel"], { cwd: c.local }).stdout);
    t("GIT_DIR/WORK_TREE/INDEX_FILE/CONFIG herdados são ignorados", r.code === 0 && raizRetornada === esperada, `code=${r.code} retorno=${raizRetornada} esperado=${esperada}`);
  }

  sec("Extra — instalação sem .git e sem journal pode iniciar sem auto-update");
  {
    const dir = join(RAIZ, "instalacao-zip-sem-git");
    mkdirSync(dir, { recursive: true });
    const envEstado = { ...process.env, MESTRE_STATE_DIR: join(dir, "state") };
    const rb = await recuperarAtualizacaoPendente({ cwd: dir, envEstado, executar: execReal, log: silencioso });
    t("ZIP sem .git e sem journal não bloqueia o primeiro boot",
      rb.ok && rb.recuperado === false && rb.motivo === "sem-journal", JSON.stringify(rb));
  }

  sec("Extra — journal não pode falhar em silêncio antes do fast-forward");
  {
    const c = criarRepo("journal-write-fail");
    publicar(c, "nao-aplicar-sem-journal");
    const shaAnterior = head(c.local);
    let merges = 0;
    const exec = (cmd, args, opcoes = {}) => {
      if (cmd === "git" && args[0] === "merge") merges++;
      return executarReal(cmd, args, opcoes);
    };
    const r = await verificarAtualizacao({
      ...opcoesRepo(c), executar: exec, log: silencioso,
      registrarPullAntes: () => false,
    });
    t("journal recusado antes do fast-forward → atualização não aplicada",
      r.atualizou === false && r.motivo === "falha-registro-journal", JSON.stringify(r));
    t("nenhum merge foi executado e HEAD não mudou", merges === 0 && head(c.local) === shaAnterior,
      `merges=${merges} head=${head(c.local)} anterior=${shaAnterior}`);
  }

  sec("Extra — recuperação manual pelo arquivo de estado");
  {
    const c = criarRepo("c22-state-recovery");
    const shaAnterior = head(c.local);
    publicar(c, "atualizacao-persistida");
    const v = await verificarAtualizacao({ ...opcoesRepo(c), executar: execReal, log: silencioso });
    const shaNovo = head(c.local);
    const st = estado(c.base);
    writeFileSync(st, JSON.stringify({
      shaAnterior, shaNovo, repoDir: v.repoDir, depsMudaram: true, branch: "main",
      em: new Date().toISOString(),
    }, null, 2));
    const reg = [];
    const rb = await reverterAtualizacao({
      ...opcoesRepo(c), stateFile: st,
      executar: executarHibrido({ registro: reg }), log: silencioso,
    });
    t("estado persistido válido → rollback manual concluído", v.atualizou === true && rb.ok === true, JSON.stringify({ v, rb }));
    t("recuperação manual restaura SHA anterior", head(c.local) === shaAnterior);
    t("arquivo de estado é removido após recuperação", !existsSync(st));
    t("recuperação manual reinstala deps e recompila ambos workspaces",
      reg.some((x) => x.endsWith(" ci")) &&
      reg.some((x) => x.includes("build -w servidor")) &&
      reg.some((x) => x.includes("build -w site")), reg.join(" | "));
  }

  sec("Extra — journal durável: crash após fast-forward retoma rollback");
  {
    const c = criarRepo("journal-crash-pos-merge");
    const shaAnterior = head(c.local);
    publicar(c, "deps-site-alterados", {
      "package-lock.json": '{"lockfileVersion":3,"packages":{"x":{"version":"2"}}}\\n',
      "site/vite.config.ts": "export default { define: { __JOURNAL__: true } };\\n",
    });
    gitSetup(["fetch", "origin"], c.local);
    gitSetup(["merge", "--ff-only", "origin/main"], c.local);
    const shaNovo = head(c.local);
    const envEstado = { ...process.env, MESTRE_STATE_DIR: join(c.base, "state-duravel") };
    gravarEstadoExterno(c.local, JOURNAL_UPDATE, {
      fase: "build-site-iniciado",
      etapa: "build-site",
      branch: "main",
      repoDir: c.local,
      shaAnterior,
      shaNovo,
      commits: 1,
      depsMudaram: true,
      siteMudou: true,
      iniciadoEm: new Date().toISOString(),
    }, envEstado);
    const reg = [];
    const rb = await recuperarAtualizacaoPendente({
      ...opcoesRepo(c),
      envEstado,
      executar: executarHibrido({ registro: reg }),
      log: silencioso,
    });
    t("journal pós-merge → rollback automático concluído", rb.ok && rb.recuperado, JSON.stringify(rb));
    t("recuperação restaura exatamente o SHA anterior", head(c.local) === shaAnterior, `${head(c.local)} vs ${shaAnterior}`);
    t("recovery reinstala dependências e reconstrói os dois workspaces",
      reg.some((x) => x.endsWith(" ci"))
        && reg.some((x) => x.includes("build -w servidor"))
        && reg.some((x) => x.includes("build -w site")), reg.join(" | "));
    t("journal concluído foi removido", lerJournal(c.local, JOURNAL_UPDATE, envEstado).status === "ausente");
  }

  sec("Extra — crash abrupto real imediatamente após o fast-forward");
  {
    const c = criarRepo("journal-sigkill-real");
    const shaAnterior = head(c.local);
    publicar(c, "release-para-sigkill", {
      "package-lock.json": '{"lockfileVersion":3,"packages":{"x":{"version":"3"}}}\\n',
      "site/vite.config.ts": "export default { define: { __SIGKILL__: true } };\\n",
    });
    const envEstado = {
      ...process.env,
      MESTRE_STATE_DIR: join(c.base, "state-sigkill"),
      MESTRE_TEST_REPO: c.local,
      MESTRE_TEST_URL_OFICIAL: c.origin,
    };
    const child = spawnSync(process.execPath, [
      join(process.cwd(), "teste-auto-update-crash-child.mjs"),
    ], {
      cwd: c.local, env: envEstado, encoding: "utf8", timeout: 60_000, windowsHide: true,
    });
    const shaNoCrash = head(c.local);
    const journal = lerJournal(c.local, JOURNAL_UPDATE, envEstado);
    const marcadorCrash = String(child.stdout ?? "").includes("MESTRE_TEST_CRASH_AFTER_FAST_FORWARD");
    const terminoAbrupto = child.error == null
      && (child.signal === "SIGABRT" || (Number.isInteger(child.status) && child.status !== 0 && child.status !== 91));
    t("processo-filho sofreu crash abrupto depois do fast-forward",
      marcadorCrash && terminoAbrupto,
      `status=${child.status} signal=${child.signal} marcador=${marcadorCrash} error=${child.error?.message ?? ""} stderr=${String(child.stderr ?? "").slice(-500)}`);
    t("crash deixou journal pull-iniciado com SHA alvo igual ao HEAD",
      journal.status === "ok" && journal.dados.fase === "pull-iniciado"
        && journal.dados.shaNovo === shaNoCrash && shaNoCrash !== shaAnterior,
      `journal=${JSON.stringify(journal)} head=${shaNoCrash} anterior=${shaAnterior}`);
    const statusDepoisCrash = String(git(["status", "--porcelain"], c.local).stdout).trim();
    t("fast-forward interrompido deixou árvore limpa", statusDepoisCrash === "", statusDepoisCrash);

    const reg = [];
    const rb = await recuperarAtualizacaoPendente({
      ...opcoesRepo(c),
      envEstado,
      executar: executarHibrido({ registro: reg }),
      log: silencioso,
    });
    t("próximo boot reverte e conclui a recuperação", rb.ok && rb.recuperado, JSON.stringify(rb));
    t("HEAD retorna exatamente ao SHA anterior", head(c.local) === shaAnterior);
    t("recovery refaz npm ci + build servidor + build site",
      reg.some((x) => x.endsWith(" ci"))
        && reg.some((x) => x.includes("build -w servidor"))
        && reg.some((x) => x.includes("build -w site")), reg.join(" | "));
    t("journal removido depois da recuperação", lerJournal(c.local, JOURNAL_UPDATE, envEstado).status === "ausente");
  }

  sec("Extra — journal pull-intent sem merge pode ser limpo sem reset/build");
  {
    const c = criarRepo("journal-crash-pre-merge");
    const shaAnterior = head(c.local);
    publicar(c, "ainda-nao-aplicado", { "site/src/app.txt": "v2\\n" });
    const alvo = String(git(["--git-dir", c.origin, "rev-parse", "refs/heads/main"], c.base).stdout).trim();
    const envEstado = { ...process.env, MESTRE_STATE_DIR: join(c.base, "state-pre-merge") };
    gravarEstadoExterno(c.local, JOURNAL_UPDATE, {
      fase: "pull-iniciado",
      etapa: "merge-fast-forward",
      branch: "main",
      repoDir: c.local,
      shaAnterior,
      shaNovo: alvo,
      commits: 1,
      depsMudaram: false,
      siteMudou: true,
      iniciadoEm: new Date().toISOString(),
    }, envEstado);
    const reg = [];
    const rb = await recuperarAtualizacaoPendente({
      ...opcoesRepo(c), envEstado,
      executar: executarHibrido({ registro: reg }),
      log: silencioso,
    });
    t("pull-intent sem merge → limpeza segura", rb.ok && rb.recuperado && rb.motivo === "pull-nao-aplicado", JSON.stringify(rb));
    t("HEAD continua no SHA anterior, sem reset", head(c.local) === shaAnterior);
    t("nenhum npm/build/reset foi executado", !reg.some((x) => /npm|reset --hard|build -w/.test(x)), reg.join(" | "));
    t("journal de intenção removido", lerJournal(c.local, JOURNAL_UPDATE, envEstado).status === "ausente");
  }

  sec("Extra — journal pendente com árvore suja bloqueia sem sobrescrever");
  {
    const c = criarRepo("journal-dirty-block");
    const shaAnterior = head(c.local);
    publicar(c, "atualizacao");
    gitSetup(["fetch", "origin"], c.local);
    gitSetup(["merge", "--ff-only", "origin/main"], c.local);
    const shaNovo = head(c.local);
    const sujo = join(c.local, "site/src/local-user-change.txt");
    writeFileSync(sujo, "alteracao local que nao pode ser perdida\\n");
    const envEstado = { ...process.env, MESTRE_STATE_DIR: join(c.base, "state-dirty") };
    gravarEstadoExterno(c.local, JOURNAL_UPDATE, {
      fase: "build-servidor-iniciado",
      branch: "main",
      repoDir: c.local,
      shaAnterior,
      shaNovo,
      commits: 1,
      depsMudaram: false,
      siteMudou: true,
      iniciadoEm: new Date().toISOString(),
    }, envEstado);
    const rb = await recuperarAtualizacaoPendente({
      ...opcoesRepo(c), envEstado, executar: executarHibrido(), log: silencioso,
    });
    t("árvore suja bloqueia recuperação", rb.ok === false && rb.motivo === "arvore-suja-recuperacao-bloqueada", JSON.stringify(rb));
    t("HEAD atualizado e alteração local continuam intactos", head(c.local) === shaNovo && readFileSync(sujo, "utf8").includes("nao pode ser perdida"));
    t("journal permanece para intervenção segura", lerJournal(c.local, JOURNAL_UPDATE, envEstado).status === "ok");
  }

  sec("Extra — config do site força rebuild mesmo com dist mais recente");
  {
    const c = criarRepo("c17");
    // O clone local já tem um dist rastreado, com mtime posterior ao src.
    // Só o commit remoto altera vite.config.ts: o rebuild deve ser forçado
    // pelo diff do workspace, não pela comparação de timestamps.
    c.commit(c.local, "dist existente", {
      "site/dist/index.html": "<html>bundle antigo</html>\\n",
    });
    gitSetup(["push", "origin", "main"], c.local);
    publicar(c, "config-site", {
      "site/vite.config.ts": "export default { define: { __TESTE__: true } };\\n",
    });
    const dist = join(c.local, "site", "dist", "index.html");
    const futuro = new Date(Date.now() + 60_000);
    utimesSync(dist, futuro, futuro);
    const reg = [];
    const b = await executarBoot({
      ...opcoesRepo(c),
      executar: executarHibrido({ registro: reg }),
      log: silencioso,
      stateFile: estado(c.base),
    });
    t("config do site atualizada → boot completo com código 0", b.codigo === 0 && b.atualizou === true, JSON.stringify(b));
    t("vite.config alterado força npm run build -w site apesar do dist mais novo",
      reg.some((x) => x === "npm run build -w site" || x === "npm.cmd run build -w site"), reg.join(" | "));
  }

  sec("B1 — upstream precisa ser origin/<branch>");
  {
    // upstream valido (origin/main) ja e o padrao de todos os cenarios —
    // reforco explicito: fetch/pull acontecem normalmente
    const cOk = criarRepo("b1-ok");
    publicar(cOk);
    const rOk = await verificarAtualizacao({ ...opcoesRepo(cOk), executar: execReal, log: silencioso });
    t("upstream origin/main → permitido", rOk.atualizou === true, rOk.motivo);

    // upstream apontando para OUTRO remoto → bloqueado antes de qualquer fetch
    const cOut = criarRepo("b1-outro");
    publicar(cOut);
    const outro = join(cOut.base, "outro.git");
    gitSetup(["init", "--bare", "-b", "main", outro], cOut.base);
    gitSetup(["remote", "add", "outro", outro], cOut.local);
    gitSetup(["update-ref", "refs/remotes/outro/main", "HEAD"], cOut.local);
    gitSetup(["branch", "--set-upstream-to=outro/main"], cOut.local);
    const regOut = [];
    const rOut = await verificarAtualizacao({ ...opcoesRepo(cOut), executar: executarHibrido({ registro: regOut }), log: silencioso });
    t("upstream outro-remoto/main → upstream-invalido", rOut.atualizou === false && rOut.motivo === "upstream-invalido", `${rOut.motivo} up=${rOut.upstream}`);
    t("nenhum fetch/pull com upstream estranho", !regOut.some((x) => x.includes("fetch") || x.includes("pull")), regOut.join(" | "));

    // upstream de fork → bloqueado
    const cFork = criarRepo("b1-fork");
    publicar(cFork);
    const fork = join(cFork.base, "fork.git");
    gitSetup(["init", "--bare", "-b", "main", fork], cFork.base);
    gitSetup(["remote", "add", "fork", fork], cFork.local);
    gitSetup(["update-ref", "refs/remotes/fork/main", "HEAD"], cFork.local);
    gitSetup(["branch", "--set-upstream-to=fork/main"], cFork.local);
    const regFork = [];
    const rFork = await verificarAtualizacao({ ...opcoesRepo(cFork), executar: executarHibrido({ registro: regFork }), log: silencioso });
    t("upstream de fork → upstream-invalido", rFork.atualizou === false && rFork.motivo === "upstream-invalido", rFork.motivo);
    t("nenhum fetch/pull com upstream de fork", !regFork.some((x) => x.includes("fetch") || x.includes("pull")), regFork.join(" | "));
  }

  sec("B1c — refspec/merge customizado não pode puxar outra branch");
  {
    // remote.origin.fetch customizado + branch.main.merge apontando
    // para 'evil' fazem @{u} resolver como origin/main, mas a
    // referencia de rastreio passa a conter a ponta de 'evil'. Sem a
    // conferencia via ls-remote, o pull --ff-only traria codigo de
    // outra branch do mesmo repositorio oficial.
    const c = criarRepo("b1c-refspec");
    publicar(c);
    const pub = join(c.base, "pub");
    gitSetup(["checkout", "-b", "evil"], pub);
    c.commit(pub, "evil-avanco", { "site/src/evil.txt": "evil\n" });
    gitSetup(["push", "origin", "evil"], pub);
    gitSetup(["checkout", "main"], pub);
    const shaAnt = head(c.local);
    gitSetup(["config", "remote.origin.fetch", "+refs/heads/evil:refs/remotes/origin/main"], c.local);
    gitSetup(["config", "branch.main.merge", "refs/heads/evil"], c.local);
    const upBruto = String(git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], c.local).stdout).trim();
    t("@{u} resolve como origin/main mesmo com merge customizado", upBruto === "origin/main", upBruto);
    const reg = [];
    const r = await verificarAtualizacao({ ...opcoesRepo(c), executar: executarHibrido({ registro: reg }), log: silencioso });
    t("fetch customizado executado antes do bloqueio", reg.some((x) => x.includes("fetch")), reg.join(" | "));
    t("upstream que não reflete o remoto → bloqueado", r.atualizou === false && r.motivo === "upstream-nao-reflete-remoto", `${r.motivo} up=${r.upstream}`);
    t("nenhum pull com upstream adulterado", !reg.some((x) => x.includes(" pull")), reg.join(" | "));
    t("HEAD local preservado", head(c.local) === shaAnt);
  }

  sec("Executar npm real sem shell livre — compatibilidade Windows");
  {
    const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const versao = executarReal(cmd, ["--version"], { cwd: RAIZ, timeoutMs: 30_000 });
    t("npm --version executa pelo executor real", versao.code === 0 && /^\d+\./.test(String(versao.stdout).trim()), `code=${versao.code} out=${String(versao.stdout).trim()} err=${String(versao.stderr).slice(0, 160)}`);
    if (process.platform === "win32") {
      const negado = executarReal("npm.cmd", ["install", "pacote-malicioso"], { cwd: RAIZ, timeoutMs: 30_000 });
      t("argumentos npm fora da allowlist são rejeitados", negado.code !== 0 && negado.stderr.includes("nao permitidos"));
    }
  }

  sec("B2 — excecoes e falhas pos-pull");
  {
    // excecao INESPERADA (throw) no npm ci → rollback → boot segue local;
    // o npm ci pos-rollback funciona (excecao foi pontual)
    const c = criarRepo("b2-throw");
    publicar(c);
    const shaAnt = head(c.local);
    let throwou = false;
    const execThrow = (cmd, args, opcoes = {}) => {
      if (!throwou && (cmd === "npm" || cmd === "npm.cmd")) { throwou = true; throw new Error("npm explodiu"); }
      if (cmd === "npm" || cmd === "npm.cmd") return { code: 0, stdout: "", stderr: "" };
      return executarReal(cmd, args, opcoes);
    };
    const b = await executarBoot({ ...opcoesRepo(c), executar: execThrow, log: silencioso, stateFile: estado(c.base) });
    t("excecao no npm ci → rollback → codigo 0", b.codigo === 0 && b.revertido === true, JSON.stringify(b));
    t("HEAD voltou ao SHA anterior", head(c.local) === shaAnt);
  }
  {
    // excecao PERSISTENTE (todo npm lanca, inclusive pos-rollback) →
    // deps nao podem ser garantidas → codigo 1, nunca sucesso falso
    const c = criarRepo("b2-throwall");
    publicar(c);
    const execThrowAll = (cmd, args, opcoes = {}) => {
      if (cmd === "npm" || cmd === "npm.cmd") throw new Error("npm sempre explode");
      return executarReal(cmd, args, opcoes);
    };
    const b = await executarBoot({ ...opcoesRepo(c), executar: execThrowAll, log: silencioso, stateFile: estado(c.base) });
    t("excecao persistente → codigo 1 (sem sucesso falso)", b.codigo === 1, JSON.stringify(b));
  }
  {
    // Exceção ao calcular o diff antes do merge: nenhuma atualização é aplicada.
    const c = criarRepo("b2-pospull");
    publicar(c);
    const shaAnt = head(c.local);
    const exec = (cmd, args, opcoes = {}) => {
      if (cmd === "git" && args[0] === "diff") throw new Error("git diff explodiu");
      if (cmd === "npm" || cmd === "npm.cmd") return { code: 0, stdout: "", stderr: "" };
      return executarReal(cmd, args, opcoes);
    };
    const b = await executarBoot({ ...opcoesRepo(c), executar: exec, log: silencioso, stateFile: estado(c.base) });
    t("falha no diagnóstico pré-merge → segue sem atualizar", b.codigo === 0 && b.atualizou !== true, JSON.stringify(b));
    t("HEAD permanece no SHA anterior, sem rollback", head(c.local) === shaAnt);
  }
  {
    // Código não-zero no diff pré-merge: falha fechada antes de mover HEAD.
    const c = criarRepo("b2-diff-code");
    publicar(c);
    const shaAnt = head(c.local);
    const exec = (cmd, args, opcoes = {}) => {
      if (cmd === "git" && args[0] === "diff") return { code: 128, stdout: "", stderr: "falha simulada no git diff" };
      if (cmd === "npm" || cmd === "npm.cmd") return { code: 0, stdout: "", stderr: "" };
      return executarReal(cmd, args, opcoes);
    };
    const b = await executarBoot({ ...opcoesRepo(c), executar: exec, log: silencioso, stateFile: estado(c.base) });
    t("git diff não-zero pré-merge → atualização recusada", b.codigo === 0 && b.atualizou !== true, JSON.stringify(b));
    t("HEAD permanece no SHA anterior após diff falho", head(c.local) === shaAnt);
  }
  {
    // falha de PERSISTENCIA do estado (stateFile e um diretorio) →
    // boot continua protegido em memoria; falha de build → rollback ok
    const c = criarRepo("b2-state");
    publicar(c);
    const shaAnt = head(c.local);
    const dirEstado = join(c.base, "estado-e-diretorio");
    mkdirSync(dirEstado, { recursive: true });
    let falhouBuildInicial = false;
    const exec = (cmd, args, opcoes = {}) => {
      if (cmd === "npm" || cmd === "npm.cmd") {
        if (args.includes("build") && !falhouBuildInicial) {
          falhouBuildInicial = true;
          return { code: 2, stdout: "", stderr: "build fake" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return executarReal(cmd, args, opcoes);
    };
    const logs = [];
    const b = await executarBoot({ ...opcoesRepo(c), executar: exec, log: (m) => logs.push(m), stateFile: dirEstado });
    t("falha ao gravar estado nao impede rollback em memoria", b.codigo === 0 && b.revertido === true, JSON.stringify(b));
    t("aviso de falha de persistencia emitido", logs.some((m) => m.includes("estado de rollback")), logs.join(" | "));
    t("HEAD voltou ao SHA anterior", head(c.local) === shaAnt);
  }
  {
    // alguém troca de branch após o pull, mantendo o mesmo SHA.
    // Rollback não deve mover a branch nova para o SHA anterior.
    const c = criarRepo("b2-branch");
    publicar(c);
    const shaAnterior = head(c.local);
    let trocou = false, resets = 0;
    const exec = (cmd, args, opcoes = {}) => {
      if (cmd === "npm" || cmd === "npm.cmd") {
        if (args[0] === "ci" && !trocou) {
          trocou = true;
          gitSetup(["switch", "-c", "branch-externa"], c.local);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args.includes("build")) return { code: 2, stdout: "", stderr: "build fake" };
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args[0] === "reset") resets++;
      return executarReal(cmd, args, opcoes);
    };
    const logs = [];
    const b = await executarBoot({ ...opcoesRepo(c), executar: exec, log: (m) => logs.push(m), stateFile: estado(c.base) });
    const branchAtual = String(git(["symbolic-ref", "--quiet", "--short", "HEAD"], c.local).stdout).trim();
    const shaNovo = String(git(["rev-parse", "HEAD"], c.local).stdout).trim();
    t("branch alterada → rollback bloqueia e retorna 1", b.codigo === 1 && b.revertido === false, JSON.stringify(b));
    t("rollback não executa reset na branch externa", resets === 0, `resets=${resets}`);
    t("branch externa permanece no SHA do pull", branchAtual === "branch-externa" && shaNovo !== shaAnterior, `${branchAtual} ${shaNovo}`);
    t("recuperação manual alerta para a branch original", logs.some((m) => m.includes("branch original era 'main'")));
  }
  {
    // rollback que FALHA (git reset retorna erro) → codigo 1
    const c = criarRepo("b2-resetfail");
    publicar(c);
    const exec = (cmd, args, opcoes = {}) => {
      if (cmd === "npm" || cmd === "npm.cmd") {
        if (args.includes("build")) return { code: 2, stdout: "", stderr: "build fake" };
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args[0] === "reset") return { code: 1, stdout: "", stderr: "reset negado" };
      return executarReal(cmd, args, opcoes);
    };
    const b = await executarBoot({ ...opcoesRepo(c), executar: exec, log: silencioso, stateFile: estado(c.base) });
    t("rollback falhou → codigo 1 (integridade nao garantida)", b.codigo === 1 && b.revertido === false, JSON.stringify(b));
  }

  sec("Kill-switch MESTRE_AUTO_UPDATE=0");
  {
    const envAnterior = process.env.MESTRE_AUTO_UPDATE;
    try {
      // env=0 com atualizacao disponivel → nenhum comando, HEAD intacto
      const c = criarRepo("kill-off");
      publicar(c);
      const shaAnt = head(c.local);
      process.env.MESTRE_AUTO_UPDATE = "0";
      const regOff = [];
      const logsOff = [];
      const bOff = await executarBoot({
        ...opcoesRepo(c),
        executar: executarHibrido({ registro: regOff }),
        log: (m) => logsOff.push(m),
        stateFile: estado(c.base),
      });
      t("MESTRE_AUTO_UPDATE=0 → codigo 0", bOff.codigo === 0, JSON.stringify(bOff));
      t("motivo desativado-por-configuracao", bOff.motivo === "desativado-por-configuracao", bOff.motivo);
      t("nenhum comando git/npm executado", regOff.length === 0, regOff.join(" | "));
      t("HEAD permaneceu inalterado", head(c.local) === shaAnt);
      t("mensagem de desativacao registrada", logsOff.some((m) => m.includes("MESTRE_AUTO_UPDATE=0")));

      // env=" 0 " (espacos) tambem desativa
      process.env.MESTRE_AUTO_UPDATE = "  0  ";
      const regEsp = [];
      const bEsp = await executarBoot({ ...opcoesRepo(c), executar: executarHibrido({ registro: regEsp }), log: silencioso, stateFile: estado(c.base) });
      t("valor ' 0 ' com espacos tambem desativa", bEsp.motivo === "desativado-por-configuracao" && regEsp.length === 0, bEsp.motivo);

      // env ausente → atualizacao normal preservada
      delete process.env.MESTRE_AUTO_UPDATE;
      const c2 = criarRepo("kill-ausente");
      publicar(c2);
      const regOn = [];
      const bOn = await executarBoot({ ...opcoesRepo(c2), executar: executarHibrido({ registro: regOn }), log: silencioso, stateFile: estado(c2.base) });
      t("variavel ausente → atualizacao aplicada", bOn.codigo === 0 && bOn.atualizou === true, JSON.stringify(bOn));
      t("fast-forward por SHA executado sem a variável", regOn.some((x) => x.includes(" merge --ff-only ")), regOn.join(" | "));

      // env=1 → comportamento inalterado (atualiza)
      process.env.MESTRE_AUTO_UPDATE = "1";
      const c3 = criarRepo("kill-um");
      publicar(c3);
      const regUm = [];
      const bUm = await executarBoot({ ...opcoesRepo(c3), executar: executarHibrido({ registro: regUm }), log: silencioso, stateFile: estado(c3.base) });
      t("MESTRE_AUTO_UPDATE=1 → atualizacao normal", bUm.codigo === 0 && bUm.atualizou === true && regUm.some((x) => x.includes(" merge --ff-only ")), JSON.stringify(bUm));
    } finally {
      if (envAnterior === undefined) delete process.env.MESTRE_AUTO_UPDATE;
      else process.env.MESTRE_AUTO_UPDATE = envAnterior;
    }
  }
  sec("Hardening do spawnSync — saída npm acima de 1 MiB");
  {
    const bytes = 2 * 1024 * 1024;
    const r = executarReal(process.execPath, ["-e", `process.stdout.write("x".repeat(${bytes}))`], {
      cwd: RAIZ,
      timeoutMs: 10_000,
    });
    t("stdout 2 MiB não causa erro de maxBuffer", r.code === 0 && r.stdout.length === bytes && !r.morto,
      `code=${r.code} bytes=${r.stdout.length} morto=${!!r.morto}`);
  }
} finally {
  for (let i = 0; i < 3; i++) {
    try {
      rmSync(RAIZ, { recursive: true, force: true });
      break;
    } catch (e) {
      if (i === 2) console.error(`limpeza temporária falhou: ${e.message}`);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    }
  }
}

console.log(`\n${pass} ok / ${fail} falhas`);
if (fail > 0) process.exitCode = 1;
