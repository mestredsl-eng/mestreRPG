// Homologacao E2E Issue #155 — matriz W0-W16 (contrato congelado).
// Uso: node homologacao-155-w.mjs <caso>
//   casos implementados: w0 w6 w8 w9 w10 w14 w16
//   casos bloqueados (N nao integrada): w1 w2 w3 w5 w7 w11 w12 w13 w15
// Nenhum cenario toca banco/, backups/, configuracao/ ou %TEMP% fora de
// diretorios criados pelo proprio teste (os.tmpdir()/homolog-155-w-*).
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, symlinkSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { createServer } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = __dirname;
const NODE = process.execPath;
const DIST_REST = join(RAIZ, "servidor", "dist", "db", "aplicar-restauracao.js");
const DIST_MIGRATE = join(RAIZ, "servidor", "dist", "db", "migrate.js");
const DIST_INDEX = join(RAIZ, "servidor", "dist", "index.js");
const SHA_N1 = "7ce5b99bb20a0f951ffe5b70a96fe46ee5a157a0";
const RESULTADOS = [];

function log(...a) { console.log("[homolog]", ...a); }
function reg(caso, decisao, resumo, artefatos = []) {
  RESULTADOS.push({ caso, decisao, resumo, artefatos });
  console.log(`\n=== ${caso}: ${decisao} — ${resumo}`);
}
function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}
function git(args, cwd) { return sh(`git ${args}`, { cwd }).trim(); }
function mkfixture(prefix) {
  const d = join(tmpdir(), `homolog-155-w-${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function envHome(home, extra = {}) {
  return { ...process.env, MESTRE_HOME: home, MESTRE_BANCO: join(home, "banco", "mestre-rpg.db"),
    MESTRE_ARQUIVOS: join(home, "arquivos", "campanhas"), MESTRE_BACKUPS: join(home, "backups"), ...extra };
}
function rodarRestaurador(home, extraEnv = {}) {
  return spawnSync(NODE, [DIST_REST], { env: envHome(home, extraEnv), encoding: "utf8", timeout: 60000 });
}
function novoBanco(caminho, fn) {
  mkdirSync(dirname(caminho), { recursive: true });
  const db = new Database(caminho);
  fn(db);
  db.close();
}

// ---------- W14: fail-open do detector de restauracao pendente ----------
function w14() {
  const casos = [];
  // a) banco inexistente legitimo -> deve criar dir e sair 0
  {
    const home = mkfixture("w14-a");
    const r = rodarRestaurador(home);
    casos.push({ nome: "a-banco-inexistente", exit: r.status, esperado: 0, ok: r.status === 0 && /instalação limpa|nada a restaurar/i.test(r.stdout + r.stderr) });
    rmSync(home, { recursive: true, force: true });
  }
  // b) banco existente SEM server_settings -> contrato exige falha; codigo trata como "nada a restaurar"?
  {
    const home = mkfixture("w14-b");
    const dbPath = join(home, "banco", "mestre-rpg.db");
    novoBanco(dbPath, (d) => d.exec("create table outra(x)"));
    const r = rodarRestaurador(home);
    casos.push({ nome: "b-sem-server_settings", exit: r.status, log: (r.stdout + r.stderr).trim().split("\n").pop(), esperado: "!=0 conforme contrato", ok: r.status !== 0 });
    rmSync(home, { recursive: true, force: true });
  }
  // c) banco valido mas server_settings e VIEW quebrada -> erro de consulta real
  {
    const home = mkfixture("w14-c");
    const dbPath = join(home, "banco", "mestre-rpg.db");
    novoBanco(dbPath, (d) => d.exec("create view server_settings as select * from tabela_inexistente"));
    const r = rodarRestaurador(home);
    casos.push({ nome: "c-erro-de-consulta", exit: r.status, log: (r.stdout + r.stderr).trim().split("\n").pop(), esperado: "!=0 conforme contrato", ok: r.status !== 0 });
    rmSync(home, { recursive: true, force: true });
  }
  // d) arquivo que nao e sqlite -> comportamento do open
  {
    const home = mkfixture("w14-d");
    const dbPath = join(home, "banco", "mestre-rpg.db");
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "isto nao e um banco sqlite\n".repeat(50));
    const r = rodarRestaurador(home);
    casos.push({ nome: "d-arquivo-corrompido", exit: r.status, log: (r.stdout + r.stderr).trim().split("\n").pop(), esperado: "!=0 conforme contrato", ok: r.status !== 0 });
    rmSync(home, { recursive: true, force: true });
  }
  // e) server_settings existe mas flag aponta backup inexistente -> deve sair !=0 (ja tratado no codigo)
  {
    const home = mkfixture("w14-e");
    const dbPath = join(home, "banco", "mestre-rpg.db");
    novoBanco(dbPath, (d) => {
      d.exec("create table server_settings(key text primary key, value text)");
      d.prepare("insert into server_settings values('restauracao_pendente',?)").run(JSON.stringify({ filePath: join(home, "backups", "nao-existe") }));
    });
    const r = rodarRestaurador(home);
    casos.push({ nome: "e-flag-backup-inexistente", exit: r.status, log: (r.stdout + r.stderr).trim().split("\n").pop(), esperado: "!=0", ok: r.status !== 0 });
    rmSync(home, { recursive: true, force: true });
  }
  const falhas = casos.filter((c) => !c.ok);
  console.log(JSON.stringify(casos, null, 2));
  if (falhas.length === 0) reg("W14", "aprovado", "todos os cenarios conforme contrato");
  else reg("W14", "reprovado", `${falhas.length} cenario(s) fail-open: ${falhas.map((f) => f.nome).join(", ")} — erro de consulta tratado como 'nada a restaurar' com exit 0`, ["stdout dos 5 cenarios"]);
}

// ---------- W8: ausencia de proveniencia backup<->migration no legado ----------
function w8() {
  const home = mkfixture("w8");
  // reproduz a sequencia do .bat N-1: aplicar-restauracao (sem flag) -> db:migrate -> (servidor nao sobe: kill simulado = nao executamos start)
  const r1 = rodarRestaurador(home);
  const r2 = spawnSync(NODE, [DIST_MIGRATE], { env: envHome(home), encoding: "utf8", timeout: 120000 });
  const dbPath = join(home, "banco", "mestre-rpg.db");
  const artefatos = {
    saidaRestaurador: (r1.stdout + r1.stderr).trim(),
    saidaMigrate: (r2.stdout + r2.stderr).trim().split("\n").slice(-5).join("\n"),
    exitRestaurador: r1.status, exitMigrate: r2.status,
  };
  let migracoes = -1;
  if (existsSync(dbPath)) {
    const d = new Database(dbPath, { readonly: true });
    try { migracoes = d.prepare("select count(*) c from __drizzle_migrations").get().c; } catch { migracoes = -2; }
    d.close();
  }
  const backupsDir = join(home, "backups");
  const conteudoBackups = existsSync(backupsDir) ? readdirSync(backupsDir) : [];
  // procura qualquer marcador externo de "sessao/fase" fora do banco
  const marcadores = [];
  const varrer = (dir, prof) => {
    if (prof > 3) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) varrer(p, prof + 1);
      else if (/state|fase|journal|pendente|manifest/i.test(e.name)) marcadores.push(p);
    }
  };
  varrer(home, 0);
  artefatos.resumo = { migracoesAplicadas: migracoes, backups: conteudoBackups, marcadoresExternos: marcadores, dbExiste: existsSync(dbPath) };
  console.log(JSON.stringify(artefatos, null, 2));
  // PASS = lacuna demonstrada: migrate ok, zero backups, zero marcadores externos
  const lacuna = r2.status === 0 && conteudoBackups.filter((f) => f !== ".gitkeep").length === 0 && marcadores.length === 0;
  reg("W8", lacuna ? "aprovado" : "reprovado", lacuna
    ? `lacuna confirmada: migrate exit ${r2.status} aplicou ${migracoes} migrations sem backup previo, sem manifesto e sem journal externo — nada permite ao proximo boot distinguir 'migration recem-aplicada' de estado normal`
    : "comportamento diverge do esperado — investigar", ["artefatos.json (stdout acima)"]);
  rmSync(home, { recursive: true, force: true });
}

// ---------- W6: smoke HTTP em copia ISOLADA da aplicacao ----------
// Fixture completa em %TEMP%: servidor/dist + site/dist + configuracao/
// com porta dedicada + node_modules (junction) + MESTRE_HOME com
// banco/arquivos/backups proprios. O filho NUNCA roda da worktree real:
// RAIZ do dist copiado resolve para a fixture, entao configuracao/,
// banco/ e qualquer escrita ficam dentro do temporario.

async function portaLivre() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

function instantaneoInstalacaoReal() {
  // lista recursiva de {path, mtimeMs, size} das areas que o servidor pode tocar
  const mapa = new Map();
  for (const d of ["banco", "arquivos", "backups", "configuracao"]) {
    const base = join(RAIZ, d);
    if (!existsSync(base)) continue;
    const pilha = [base];
    while (pilha.length) {
      const dir = pilha.pop();
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) pilha.push(p);
        else { const st = statSync(p); mapa.set(p, `${st.mtimeMs}:${st.size}`); }
      }
    }
  }
  return mapa;
}
function diffInstalacaoReal(antes) {
  const depois = instantaneoInstalacaoReal();
  const alterados = [];
  for (const [p, sig] of depois) if (antes.get(p) !== sig) alterados.push(p);
  for (const p of antes.keys()) if (!depois.has(p)) alterados.push(p + " (removido)");
  return alterados;
}

async function w6() {
  const home = mkfixture("w6");
  const app = join(home, "app");
  const porta = await portaLivre();
  // copia minima da aplicacao: dist do servidor + dist do site (se houver)
  // + configuracao/servidor.json com a porta dedicada.
  // ATENCAO (achado real): config.ts resolve RAIZ 3 niveis acima de
  // dist/config.js = PAI do app — ou seja, o caminho que o servidor
  // REALMENTE le e <pai-do-app>/configuracao/servidor.json. Replicamos
  // os dois: o caminho efetivo (home/configuracao) e o layout canonico
  // (app/configuracao) para nao depender do off-by-one.
  cpSync(join(RAIZ, "servidor", "dist"), join(app, "servidor", "dist"), { recursive: true });
  // migrate.js resolve <app>/servidor/migrations — sem ela o banco fica
  // sem schema e /api/health responde 503 (falso negativo de isolamento)
  cpSync(join(RAIZ, "servidor", "migrations"), join(app, "servidor", "migrations"), { recursive: true });
  const siteDist = join(RAIZ, "site", "dist");
  if (existsSync(siteDist)) cpSync(siteDist, join(app, "site", "dist"), { recursive: true });
  const cfg = {
    host: "127.0.0.1", porta, sitePorta: 0,
    caminhos: { banco: "banco/mestre-rpg.db", arquivos: "arquivos/campanhas", backups: "backups" },
  };
  mkdirSync(join(home, "configuracao"), { recursive: true });
  writeFileSync(join(home, "configuracao", "servidor.json"), JSON.stringify(cfg));
  mkdirSync(join(app, "configuracao"), { recursive: true });
  writeFileSync(join(app, "configuracao", "servidor.json"), JSON.stringify(cfg));
  try { symlinkSync(join(RAIZ, "node_modules"), join(app, "node_modules"), "junction"); }
  catch (e) { reg("W6", "bloqueado", `junction node_modules falhou: ${e.message}`); rmSync(home, { recursive: true, force: true }); return; }
  // dados do filho vivem no MESTRE_HOME (banco/arquivos/backups), nao no app
  const dados = join(home, "dados");
  mkdirSync(join(dados, "banco"), { recursive: true });
  mkdirSync(join(dados, "arquivos"), { recursive: true });
  mkdirSync(join(dados, "backups"), { recursive: true });
  // schema minimo para /api/health responder com banco valido
  const mig = spawnSync(NODE, [join(app, "servidor", "dist", "db", "migrate.js")], {
    env: { ...process.env, MESTRE_HOME: dados, MESTRE_BANCO: join(dados, "banco", "mestre-rpg.db"),
      MESTRE_ARQUIVOS: join(dados, "arquivos", "campanhas"), MESTRE_BACKUPS: join(dados, "backups") },
    encoding: "utf8", timeout: 120000,
  });
  if (mig.status !== 0) {
    reg("W6", "bloqueado", `migrate da fixture falhou (status ${mig.status}): ${String(mig.stderr).slice(0, 300)}`);
    rmSync(home, { recursive: true, force: true });
    return;
  }

  // prova de que a porta dedicada estava LIVRE antes do filho
  let portaLivreAntes = true;
  try { await fetch(`http://127.0.0.1:${porta}/api/health`, { signal: AbortSignal.timeout(800) }); portaLivreAntes = false; }
  catch { /* nada ouvindo — esperado */ }

  const antes = instantaneoInstalacaoReal();
  const envFilho = { ...process.env, MESTRE_HOME: dados, MESTRE_PORTA: String(porta),
    MESTRE_BANCO: join(dados, "banco", "mestre-rpg.db"),
    MESTRE_ARQUIVOS: join(dados, "arquivos", "campanhas"), MESTRE_BACKUPS: join(dados, "backups") };
  const filho = spawn(NODE, [join(app, "servidor", "dist", "index.js")], {
    cwd: app, env: envFilho, stdio: ["ignore", "pipe", "pipe"],
  });
  let saida = "";
  filho.stdout.on("data", (d) => { saida += d; });
  filho.stderr.on("data", (d) => { saida += d; });
  const ok = await new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${porta}/api/health`, { signal: AbortSignal.timeout(1500) });
        // qualquer resposta HTTP prova que o filho dono da porta respondeu
        clearInterval(iv); res({ health: r.status, ms: Date.now() - t0 });
      } catch { /* ainda subindo */ }
      if (Date.now() - t0 > 60000) { clearInterval(iv); res({ health: null, ms: Date.now() - t0 }); }
    }, 400);
  });
  // prova de posse: filho VIVO enquanto responde + porta morre com ele
  const filhoVivo = filho.exitCode === null && filho.signalCode === null;
  filho.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  try { filho.kill("SIGKILL"); } catch { /* ja morto */ }
  await new Promise((r) => filho.exitCode !== null || setTimeout(r, 3000));
  let portaMorreu = true;
  try { await fetch(`http://127.0.0.1:${porta}/api/health`, { signal: AbortSignal.timeout(800) }); portaMorreu = false; }
  catch { /* esperado: filho morto => porta livre */ }
  const alterados = diffInstalacaoReal(antes);
  console.log(JSON.stringify({ porta, portaLivreAntes, health: ok, filhoVivo, portaMorreuAposKill: portaMorreu,
    bancoDoFilho: existsSync(join(dados, "banco", "mestre-rpg.db")),
    instalacaoRealAlterada: alterados, saidaFinal: saida.trim().split("\n").slice(-8) }, null, 2));
  rmSync(home, { recursive: true, force: true });
  const isolado = portaLivreAntes && ok.health === 200 && filhoVivo && portaMorreu && alterados.length === 0;
  if (isolado) reg("W6", "aprovado",
    `smoke isolado REAL: app copiada p/ %TEMP% com configuracao/servidor.json porta ${porta} dedicada (estava livre); filho vivo respondeu /api/health 200 e a porta morreu com ele; banco em MESTRE_HOME; ZERO alteracoes em banco/arquivos/backups/configuracao da instalacao real (snapshot antes/depois)`);
  else reg("W6", "reprovado", `portaLivreAntes=${portaLivreAntes} health=${ok.health} filhoVivo=${filhoVivo} portaMorreu=${portaMorreu} alterados=${JSON.stringify(alterados.slice(0, 5))}`);
}

// ---------- W16: manifesto obrigatorio / backup invalido falha ----------
async function w16() {
  // Nucleo testavel sem servidor: verificarBackup valida hashes do manifesto.
  // Fixture: MESTRE_HOME temp + banco com schema + linha em backups + dir de backup.
  const home = mkfixture("w16");
  process.env.MESTRE_HOME = home;
  process.env.MESTRE_BANCO = join(home, "banco", "mestre-rpg.db");
  process.env.MESTRE_ARQUIVOS = join(home, "arquivos", "campanhas");
  process.env.MESTRE_BACKUPS = join(home, "backups");
  // migrate para criar schema
  const rm = spawnSync(NODE, [DIST_MIGRATE], { env: envHome(home), encoding: "utf8", timeout: 120000 });
  if (rm.status !== 0) { reg("W16", "bloqueado", `migrate fixture falhou: ${(rm.stdout + rm.stderr).slice(-300)}`); rmSync(home, { recursive: true, force: true }); return; }
  // arquivo de campanha para o manifesto ter ao menos uma entrada verificavel
  mkdirSync(join(home, "arquivos", "campanhas"), { recursive: true });
  writeFileSync(join(home, "arquivos", "campanhas", "doc-w16.txt"), "conteudo original w16\n");
  const { getDb, fecharBanco } = await import(pathToFileURL(join(RAIZ, "servidor", "dist", "db", "index.js")).href);
  const backupMod = await import(pathToFileURL(join(RAIZ, "servidor", "dist", "lib", "backup.js")).href);
  const { verificarBackup, criarBackup } = backupMod;
  getDb();
  const bk = await criarBackup("manual", "homolog-w16");
  const idValido = bk?.id ?? null;
  const dirBk = bk?.dir ?? null;
  const cenarios = [];
  cenarios.push({ nome: "backup-criado", ok: !!(bk?.sucesso) , dir: dirBk, erros: bk?.erros });
  if (idValido) {
    const v = await verificarBackup(idValido);
    cenarios.push({ nome: "valido", ok: v.ok === true, detalhes: v.detalhes });
  } else cenarios.push({ nome: "valido", ok: false, nota: "sem id" });
  // cenario 2: adultera arquivo coberto pelo manifesto -> deve falhar
  if (dirBk) {
    const vitima = join(dirBk, "arquivos", "doc-w16.txt");
    if (existsSync(vitima)) {
      writeFileSync(vitima, readFileSync(vitima, "utf8") + "adulterado\n");
      const v2 = await verificarBackup(idValido);
      cenarios.push({ nome: "arquivo-adulterado", ok: v2.ok === false, detalhes: v2.detalhes });
    } else cenarios.push({ nome: "arquivo-adulterado", ok: false, nota: "arquivo nao encontrado no backup: " + vitima });
  }
  // cenario 3: manifesto ausente -> contrato exige falha; codigo pula validacao se ausente?
  if (dirBk) {
    // recria backup limpo para este cenario
    const bk2 = await criarBackup("manual", "homolog-w16-manifesto");
    const man2 = join(bk2.dir, "manifesto.json");
    rmSync(man2, { force: true });
    const v3 = await verificarBackup(bk2.id);
    cenarios.push({ nome: "manifesto-ausente", ok: v3.ok === false, detalhes: v3.detalhes, nota: "contrato W16 exige falha; se ok=true e fail-open" });
  }
  fecharBanco();
  console.log(JSON.stringify(cenarios, null, 2));
  const ruins = cenarios.filter((c) => !c.ok);
  rmSync(home, { recursive: true, force: true });
  if (ruins.length === 0) reg("W16", "aprovado-parcial", "verificarBackup rejeita backup adulterado e sem manifesto; metadados db/config sha256 e retencao de backup transacional NAO existem no codigo — permanecem BLOCKED/CORRECAO", ["cenarios.json"]);
  else reg("W16", "reprovado", `cenarios falharam: ${ruins.map((c) => c.nome).join(", ")}`);
}

// ---------- W0/W9/W10: .bat legado real via fixture Git ----------
// REMOTO: bare local em %TEMP% — NENHUM push/fetch toca o origin oficial.
// O auto-update.mjs exige origin == repositorio oficial, entao com remoto
// local ele responde "remoto-desconhecido" e segue sem atualizar (exit 0).
// Isso e suficiente para W9/W10 (interrupcao/reconciliacao do boot, que
// nao dependem do pull) e deixa W0 explicitamente BLOQUEADO: o pull ff-only
// que traz o commit do .bat so pode ser exercitado contra o remoto oficial,
// o que exige branch efemera autorizada (ver HOMOLOG_W_REMOTO_GITHUB).
const BRANCH_FIXTURE = "homolog/w-fixture-155";

function prepararFixtureBat(w) {
  const tmp = mkfixture(`w${w}-prep`);
  const bareDir = join(tmp, "remote.git");
  sh(`git init --bare "${bareDir}"`, {});
  const cloneDir = join(tmp, "install");
  sh(`git clone --no-hardlinks "${RAIZ}" "${cloneDir}"`, {});
  // origin aponta para o bare LOCAL (file:///) — push/fetch/pull nunca
  // saem da maquina; o auto-update valida a URL e pula a atualizacao.
  git(`remote set-url origin "${pathToFileURL(bareDir).href}"`, cloneDir);
  const branchFixture = `${BRANCH_FIXTURE}-${Date.now().toString(36)}`;
  // branch fixture baseada em N-1; commit altera o .bat (marcador apos :sem_auto_update)
  git(`checkout -B ${branchFixture} ${SHA_N1}`, cloneDir);
  const batPath = join(cloneDir, "iniciar-mestre-rpg.bat");
  const bat = readFileSync(batPath, "utf8");
  // insere o marcador na LINHA DE ROTULO :sem_auto_update (nao no "goto :sem_auto_update")
  const re = /^:sem_auto_update[ \t]*$/m;
  if (!re.test(bat)) throw new Error("rotulo :sem_auto_update nao encontrado no .bat");
  const batNovo = bat.replace(re, `:sem_auto_update\r\necho [HOMOLOG-W${w}] marcador-pos-update: .bat novo em execucao`);
  writeFileSync(batPath, batNovo);
  git(`add iniciar-mestre-rpg.bat`, cloneDir);
  git(`-c user.name=homolog -c user.email=homolog@local commit -m "homolog: altera .bat para W${w}"`, cloneDir);
  const shaN = git(`rev-parse HEAD`, cloneDir);
  git(`push origin ${branchFixture}`, cloneDir);
  git(`fetch origin`, cloneDir);
  git(`branch --set-upstream-to=origin/${branchFixture}`, cloneDir);
  // volta o clone para N-1: upstream fica 1 commit a frente -> pull --ff-only traria o commit do .bat
  // (com remoto local o auto-update pula antes do pull — ver nota W0)
  git(`reset --hard ${SHA_N1}`, cloneDir);
  try { symlinkSync(join(RAIZ, "node_modules"), join(cloneDir, "node_modules"), "junction"); } catch (e) { log("junction node_modules falhou:", e.message); }
  return { tmp, cloneDir, shaN, branchFixture };
}

// Stub de npm restrito a fixture: intercepta `npm run db:migrate` e
// `npm run start` para criar BARREIRA determinística — escreve
// <ponto>.chegou, espera <ponto>.liberar (o harness decide), e so entao
// delega ao npm real. Sem corrida stdout×taskkill: o harness só mata
// depois de confirmar que o processo ATINGIU o ponto exato, e a prova de
// "migration/start nao executou" e a ausencia de <ponto>.executou.
function prepararStubNpm(tmp) {
  const dir = join(tmp, "stubbin");
  mkdirSync(dir, { recursive: true });
  const onde = spawnSync("where", ["npm.cmd"], { encoding: "utf8" });
  const npmReal = (onde.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    || "npm.cmd";
  writeFileSync(join(dir, "npm.cmd"), `@echo off\r\nnode "%~dp0stub-npm.mjs" %*\r\n`);
  writeFileSync(join(dir, "stub-npm.mjs"), `// stub-npm — barreira deterministica restrita a fixture W9/W10
import { writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const alvo = args.join(" ");
const barreira = process.env.HOMOLOG_BARRIER || "";
const dirBar = process.env.HOMOLOG_BARRIER_DIR || "";
const ponto = alvo.includes("db:migrate") ? "migrate" : alvo.includes("run start") ? "start" : null;
const NPM_REAL = ${JSON.stringify(npmReal)};
if (barreira === ponto && ponto) {
  writeFileSync(dirBar + "/" + ponto + ".chegou", String(Date.now()));
  // espera o harness liberar (ou timeout de seguranca de 5min)
  const t0 = Date.now();
  while (!existsSync(dirBar + "/" + ponto + ".liberar")) {
    if (Date.now() - t0 > 300000) { console.error("[stub-npm] timeout de barreira — abortando delegacao"); process.exit(2); }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  writeFileSync(dirBar + "/" + ponto + ".executou", String(Date.now()));
}
const r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", '"' + NPM_REAL + '" ' + args.map((a) => '"' + a + '"').join(" ")], { stdio: "inherit" });
process.exit(r.status ?? 1);
`);
  return { dir, npmReal };
}

async function esperarArquivo(caminho, timeoutMs = 120000) {
  const t0 = Date.now();
  while (!existsSync(caminho)) {
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return true;
}

function matarArvore(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { /* ja morto */ }
}

async function rodarBat(cloneDir, logFile, opts = {}) {
  // opts.killOn: regex no buffer acumulado; opts.ateSaude: espera health 200 na porta antes de encerrar a observacao
  // opts.env: variaveis extras (PATH do stub, HOMEOLOG_BARRIER*)
  const out = [];
  let buf = "";
  const filho = spawn("cmd.exe", ["/c", "iniciar-mestre-rpg.bat"], {
    cwd: cloneDir, stdio: ["ignore", "pipe", "pipe"],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  const estado = { morto: false, motivo: null, health: null };
  const aoDados = (d) => {
    const s = d.toString();
    out.push(s); buf += s;
    process.stdout.write(s);
    if (!estado.morto && opts.killOn && opts.killOn.test(buf)) {
      estado.morto = true; estado.motivo = "killOn:" + opts.killOn;
      log(`killOn disparado — taskkill /T no cmd pid=${filho.pid}`);
      matarArvore(filho.pid);
    }
  };
  filho.stdout.on("data", aoDados);
  filho.stderr.on("data", aoDados);
  // observador de saude: quando /api/health responde, marca e (se pedido) derruba a arvore
  const iv = setInterval(async () => {
    try {
      const r = await fetch("http://127.0.0.1:3001/api/health", { signal: AbortSignal.timeout(1200) });
      if (r.ok && !estado.health) {
        estado.health = r.status;
        log(`health 200 em ${cloneDir}`);
        if (opts.matarAposSaude !== false) { estado.morto = true; estado.motivo = "apos-saude"; matarArvore(filho.pid); }
      }
    } catch { /* ainda nao subiu */ }
  }, 700);
  const teto = setTimeout(() => { if (!estado.morto) { estado.morto = true; estado.motivo = "timeout-10min"; matarArvore(filho.pid); } }, 10 * 60 * 1000);
  const codigo = await new Promise((res) => filho.on("exit", (c) => res(c)));
  clearInterval(iv); clearTimeout(teto);
  await new Promise((r) => setTimeout(r, 800));
  writeFileSync(logFile, out.join(""));
  return { exitCmd: codigo, estado, log: out.join(""), buf };
}

async function porta3001Ocupada() {
  try {
    const r = await fetch("http://127.0.0.1:3001/api/health", { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch { return false; }
}

async function executarBatE2E(w, cenario) {
  if (await porta3001Ocupada()) {
    // o .bat real aborta quando 3001 responde — e o guarda-roupa contra
    // tocar a instalacao do usuario. Reporta bloqueio em vez de excecao.
    reg(`W${w}`, "bloqueado",
      "porta 3001 ocupada (servidor real no ar — ex.: npm run start do worktree mestre-rpg). O .bat aborta por design; execute com a porta livre.");
    return { bloqueado: true, execucoes: [], logsPreservados: [] };
  }
  const { tmp, cloneDir, shaN, branchFixture } = prepararFixtureBat(w);
  const res = { tmp, cloneDir, shaN, branchFixture, execucoes: [], logsPreservados: [] };
  const logsDir = mkfixture(`w${w}-logs`); // preservado: artefatos fora do tmp removido
  const preservarLogs = () => {
    try {
      for (const f of readdirSync(tmp)) {
        if (f.endsWith(".log")) { cpSync(join(tmp, f), join(logsDir, f)); res.logsPreservados.push(join(logsDir, f)); }
      }
    } catch { /* tmp ja pode ter saido */ }
  };
  try {
    if (cenario === "w0") {
      // W0 exige o pull ff-only do auto-update — que so roda contra o
      // origin OFICIAL. Com remoto bare local o updater pula
      // ("remoto-desconhecido") e o marcador nunca aparece. Executar o
      // pull real exige branch efemera no GitHub + autorizacao explicita
      // (mutacao remota temporaria). Sem a flag, o cenario se declara
      // bloqueado em vez de produzir falso negativo.
      if (process.env.HOMOLOG_W_REMOTO_GITHUB !== "1") {
        res.bloqueio = "auto-update exige origin oficial; pull E2E requer branch efemera autorizada no GitHub (HOMOLOG_W_REMOTO_GITHUB=1)";
        return res;
      }
      throw new Error("modo remoto GitHub efemero ainda nao implementado — requer autorizacao e branch unica sem force");
    } else if (cenario === "w9" || cenario === "w10") {
      const ponto = cenario === "w9" ? "migrate" : "start";
      const stub = prepararStubNpm(tmp);
      const barDir = join(tmp, "barreira");
      mkdirSync(barDir, { recursive: true });
      const envBar = {
        PATH: stub.dir + ";" + process.env.PATH,
        HOMEOLOG_BARRIER: ponto, HOMEOLOG_BARRIER_DIR: barDir,
      };
      // run1: boot com stub — o processo PARA no ponto exato da barreira
      const r1 = await rodarBatParado(cloneDir, join(tmp, `w${w}-run1-kill.log`), barDir, ponto, envBar);
      res.execucoes.push({ fase: "kill-na-barreira", ...r1.estado, exitCmd: r1.exitCmd });
      res.chegouPonto = existsSync(join(barDir, `${ponto}.chegou`));
      res.executouPonto = existsSync(join(barDir, `${ponto}.executou`));
      res.headAposKill = git(`rev-parse HEAD`, cloneDir);
      if (cenario === "w10") {
        // prova: servidor NAO subiu antes do kill (start nunca delegado)
        try {
          const rr = await fetch("http://127.0.0.1:3001/api/health", { signal: AbortSignal.timeout(1200) });
          res.servidorNoArAposKill = rr.ok;
        } catch { res.servidorNoArAposKill = false; }
      }
      // run2: retomada com npm real — boot completo ate o servidor
      const r2 = await rodarBat(cloneDir, join(tmp, `w${w}-run2-retomada.log`), { matarAposSaude: true });
      res.execucoes.push({ fase: "retomada", ...r2.estado, exitCmd: r2.exitCmd });
    }
    res.headFinal = git(`rev-parse HEAD`, cloneDir);
    res.porcelain = git(`status --porcelain`, cloneDir);
    return res;
  } finally {
    preservarLogs();
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    res.tmpRemovido = true;
  }
}

// Versao do rodarBat para a fase de kill: dispara o kill quando o
// arquivo de barreira <ponto>.chegou aparece — deterministico, sem
// depender de linha de stdout nem de corrida com taskkill.
async function rodarBatParado(cloneDir, logFile, barDir, ponto, env) {
  const out = [];
  const filho = spawn("cmd.exe", ["/c", "iniciar-mestre-rpg.bat"], {
    cwd: cloneDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env },
  });
  const estado = { morto: false, motivo: null, health: null };
  const aoDados = (d) => { const s = d.toString(); out.push(s); process.stdout.write(s); };
  filho.stdout.on("data", aoDados);
  filho.stderr.on("data", aoDados);
  // vigia a barreira: o stub npm escreve <ponto>.chegou ANTES de esperar
  const iv = setInterval(async () => {
    if (!estado.morto && existsSync(join(barDir, `${ponto}.chegou`))) {
      estado.morto = true; estado.motivo = `barreira:${ponto}`;
      log(`barreira ${ponto} atingida — taskkill /T no cmd pid=${filho.pid}`);
      matarArvore(filho.pid);
    }
    try {
      const r = await fetch("http://127.0.0.1:3001/api/health", { signal: AbortSignal.timeout(1200) });
      if (r.ok && !estado.health) estado.health = r.status;
    } catch { /* ainda nao subiu */ }
  }, 250);
  const teto = setTimeout(() => { if (!estado.morto) { estado.morto = true; estado.motivo = "timeout-10min"; matarArvore(filho.pid); } }, 10 * 60 * 1000);
  const codigo = await new Promise((res) => filho.on("exit", (c) => res(c)));
  clearInterval(iv); clearTimeout(teto);
  await new Promise((r) => setTimeout(r, 800));
  writeFileSync(logFile, out.join(""));
  return { exitCmd: codigo, estado, log: out.join(""), buf: out.join("") };
}

const casos = {
  w14: () => w14(),
  w8: () => w8(),
  w6: () => w6(),
  w16: () => w16(),
  w0: () => executarBatE2E(0, "w0").then((r) => {
    if (r.bloqueio) { reg("W0", "bloqueado", r.bloqueio, r.logsPreservados); return; }
    const headOk = r.headFinal === r.shaN;
    reg("W0", headOk ? "aprovado" : "reprovado",
      `bat legado extraido executado via .bat real; pull trouxe commit ${r.shaN.slice(0, 12)} que altera o proprio .bat no meio da execucao; headFinal=${r.headFinal.slice(0, 12)} (esperado ${r.shaN.slice(0, 12)}); marcador-pos-update no log=${r.marcador}; execucoes=${JSON.stringify(r.execucoes)}; logs em ${r.logsPreservados.join(", ") || r.tmp}`,
      r.logsPreservados.length ? r.logsPreservados : [`${r.tmp}/w0-run1.log`]);
  }),
  w9: () => executarBatE2E(9, "w9").then((r) => {
    if (r.bloqueado) return;
    const subiu = r.execucoes[1]?.health === 200;
    const barreiraOk = r.chegouPonto === true && r.executouPonto === false;
    reg("W9", (subiu && barreiraOk) ? "aprovado" : "reprovado",
      `kill deterministico na barreira pre-migrate (stub npm): ponto.migrate.chegou=${r.chegouPonto} executou=${r.executouPonto} (prova: migration NUNCA delegada); retomada: health=${r.execucoes[1]?.health} motivo=${r.execucoes[1]?.motivo}; remoto=bare local em %TEMP% (zero push ao origin); logs em ${r.logsPreservados.join(", ") || r.tmp}`,
      r.logsPreservados);
  }),
  w10: () => executarBatE2E(10, "w10").then((r) => {
    if (r.bloqueado) return;
    const subiu = r.execucoes[1]?.health === 200;
    const barreiraOk = r.chegouPonto === true && r.executouPonto === false;
    reg("W10", (subiu && barreiraOk && r.servidorNoArAposKill === false) ? "aprovado" : "reprovado",
      `kill deterministico na barreira pre-start (stub npm): ponto.start.chegou=${r.chegouPonto} executou=${r.executouPonto}; servidorNoArAposKill=${r.servidorNoArAposKill}; proximo boot: health=${r.execucoes[1]?.health}; remoto=bare local; logs em ${r.logsPreservados.join(", ") || r.tmp}`,
      r.logsPreservados);
  }),
};
const bloqueados = {
  w1: "handoff :_fase2 nao existe em 7ce5b99 — requer versao N integrada (#188/#189)",
  w2: "depende de W1/maquina de fases — nao implementada",
  w3: "dois boots em N requerem Boot Lock corrigido (#189) integrado — helper atual nao cobre storage/porta",
  w5: "maquina de fases do protocolo externo nao implementada",
  w7: "estado externo de N nao implementado",
  w11: "scripts/boot-lock.mjs ausente em 7ce5b99 — cenario so existe em N",
  w12: "item 3 (smoke em dados reais) exige autorizacao/fixture de producao; itens 1-2 cobertos por W6/W8",
  w13: "marcador 'estado ja inicializado' nao implementado — casos indistinguiveis por construcao",
  w15: "journal externo de restauracao nao existe — BLOCKED por dependencia",
};

const alvo = process.argv[2];
if (!alvo) { console.log("uso: node homologacao-155-w.mjs <w0|w6|w8|w9|w10|w14|w16|todos-rapidos>"); process.exit(2); }
if (alvo === "todos-rapidos") {
  for (const c of ["w14", "w8", "w16", "w6"]) await casos[c]();
} else if (casos[alvo]) {
  await casos[alvo]();
} else if (bloqueados[alvo]) {
  reg(alvo.toUpperCase(), "bloqueado", bloqueados[alvo]);
} else { console.log("caso desconhecido:", alvo); process.exit(2); }
console.log("\n===== RESUMO =====");
for (const r of RESULTADOS) console.log(`${r.caso}: ${r.decisao} — ${r.resumo}`);
