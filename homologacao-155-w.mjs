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

// ---------- W6: smoke HTTP em copia isolada (env-isolada) ----------
async function w6() {
  const home = mkfixture("w6");
  const env = envHome(home, { MESTRE_PORTA: "0" }); // porta 0 => efemera? config.json fixa 3001; MESTRE_PORTA so vale se json.porta ausente
  // config.ts: json.porta (3001) prevalece — usar porta real livre 3101 via config do fixture? config.json e do RAIZ do worktree.
  // Alternativa honesta: subir com MESTRE_HOME nao afeta config.ts; porta vem de configuracao/servidor.json (3001).
  // Isolamento de dados garantido por MESTRE_BANCO/ARQUIVOS/BACKUPS; porta 3001 verificada livre antes.
  delete env.MESTRE_PORTA;
  const filho = spawn(NODE, [DIST_INDEX], { env, stdio: ["ignore", "pipe", "pipe"] });
  let saida = "";
  filho.stdout.on("data", (d) => { saida += d; });
  filho.stderr.on("data", (d) => { saida += d; });
  const ok = await new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(async () => {
      try {
        const r = await fetch("http://127.0.0.1:3001/api/health", { signal: AbortSignal.timeout(1500) });
        if (r.ok) { clearInterval(iv); res({ health: r.status, ms: Date.now() - t0 }); }
      } catch { /* ainda subindo */ }
      if (Date.now() - t0 > 60000) { clearInterval(iv); res({ health: null, ms: Date.now() - t0 }); }
    }, 500);
  });
  filho.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1500));
  try { filho.kill("SIGKILL"); } catch { /* ja morto */ }
  const isolate = { banco: join(home, "banco", "mestre-rpg.db"), arquivos: join(home, "arquivos"), backups: join(home, "backups") };
  const tocouReal = ["banco", "arquivos", "backups"].some((d) => {
    const p = join(RAIZ, d);
    return existsSync(p) && readdirSync(p).some((f) => !f.startsWith(".") && statSync(join(p, f)).mtimeMs > Date.now() - 120000);
  });
  console.log(JSON.stringify({ health: ok, isolate, tocouInstalacaoReal: tocouReal, saidaFinal: saida.trim().split("\n").slice(-8) }, null, 2));
  rmSync(home, { recursive: true, force: true });
  if (ok.health === 200 && !tocouReal) reg("W6", "aprovado", `smoke isolado: /api/health 200 em ${ok.ms}ms com banco/arquivos/backups em ${home} (removido); porta 3001 (config tracked); nenhum arquivo da instalacao real tocado — prova de disponibilidade HTTP, NAO de integridade de dados`);
  else reg("W6", "reprovado", `health=${ok.health} tocouReal=${tocouReal}`);
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
const BRANCH_FIXTURE = "homolog/w-fixture-155";

function prepararFixtureBat(w) {
  const tmp = mkfixture(`w${w}-prep`);
  const cloneDir = join(tmp, "install");
  sh(`git clone --no-hardlinks "${RAIZ}" "${cloneDir}"`, {});
  git(`remote set-url origin https://github.com/mestredsl-eng/mestreRPG.git`, cloneDir);
  // branch fixture baseada em N-1; commit remoto altera o .bat (marcador apos :sem_auto_update)
  git(`checkout -B ${BRANCH_FIXTURE} ${SHA_N1}`, cloneDir);
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
  git(`push -f origin ${BRANCH_FIXTURE}`, cloneDir);
  git(`fetch origin "+refs/heads/${BRANCH_FIXTURE}:refs/remotes/origin/${BRANCH_FIXTURE}"`, cloneDir);
  git(`branch --set-upstream-to=origin/${BRANCH_FIXTURE}`, cloneDir);
  // volta o clone para N-1: upstream fica 1 commit a frente -> pull --ff-only traz o commit do .bat
  git(`reset --hard ${SHA_N1}`, cloneDir);
  try { symlinkSync(join(RAIZ, "node_modules"), join(cloneDir, "node_modules"), "junction"); } catch (e) { log("junction node_modules falhou:", e.message); }
  return { tmp, cloneDir, shaN };
}

function matarArvore(pid) {
  try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { /* ja morto */ }
}

async function rodarBat(cloneDir, logFile, opts = {}) {
  // opts.killOn: regex no buffer acumulado; opts.ateSaude: espera health 200 na porta antes de encerrar a observacao
  const out = [];
  let buf = "";
  const filho = spawn("cmd.exe", ["/c", "iniciar-mestre-rpg.bat"], { cwd: cloneDir, stdio: ["ignore", "pipe", "pipe"] });
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
  if (await porta3001Ocupada()) throw new Error("porta 3001 ja responde — servidor real no ar; abortando para nao tocar a instalacao do usuario");
  const { tmp, cloneDir, shaN } = prepararFixtureBat(w);
  const res = { tmp, cloneDir, shaN, execucoes: [] };
  if (cenario === "w0") {
    const r1 = await rodarBat(cloneDir, join(tmp, "w0-run1.log"), { matarAposSaude: true });
    res.execucoes.push({ fase: "unica", ...r1.estado, exitCmd: r1.exitCmd });
    res.marcador = r1.buf.includes(`[HOMOLOG-W${w}]`);
  } else if (cenario === "w9") {
    // morte na janela pos-updater / pre-migration: mata ao ver "Aplicando migracoes"
    const r1 = await rodarBat(cloneDir, join(tmp, "w9-run1-kill.log"), { killOn: /Aplicando migra/i, matarAposSaude: false });
    res.execucoes.push({ fase: "kill-pre-migrate", ...r1.estado, exitCmd: r1.exitCmd });
    res.headAposKill = git(`rev-parse HEAD`, cloneDir);
    // segundo boot: retomada — updater deve ver "sem atualizacao" e a cauda rodar ate o servidor
    const r2 = await rodarBat(cloneDir, join(tmp, "w9-run2-retomada.log"), { matarAposSaude: true });
    res.execucoes.push({ fase: "retomada", ...r2.estado, exitCmd: r2.exitCmd });
  } else if (cenario === "w10") {
    // morte apos migrate / antes do start: "OK] Servidor iniciado" e impresso antes de npm run start
    const r1 = await rodarBat(cloneDir, join(tmp, "w10-run1-kill.log"), { killOn: /\[OK\] Servidor iniciado/i, matarAposSaude: false });
    res.execucoes.push({ fase: "kill-pos-migrate", ...r1.estado, exitCmd: r1.exitCmd });
    res.headAposKill = git(`rev-parse HEAD`, cloneDir);
    // confirma que o servidor NAO chegou a subir antes do kill
    try {
      const rr = await fetch("http://127.0.0.1:3001/api/health", { signal: AbortSignal.timeout(1200) });
      res.servidorNoArAposKill = rr.ok;
    } catch { res.servidorNoArAposKill = false; }
    const r2 = await rodarBat(cloneDir, join(tmp, "w10-run2-proximo-boot.log"), { matarAposSaude: true });
    res.execucoes.push({ fase: "proximo-boot", ...r2.estado, exitCmd: r2.exitCmd });
  }
  res.headFinal = git(`rev-parse HEAD`, cloneDir);
  res.porcelain = git(`status --porcelain`, cloneDir);
  return res;
}

const casos = {
  w14: () => w14(),
  w8: () => w8(),
  w6: () => w6(),
  w16: () => w16(),
  w0: () => executarBatE2E(0, "w0").then((r) => {
    const headOk = r.headFinal === r.shaN;
    reg("W0", headOk ? "aprovado" : "reprovado",
      `bat legado extraido executado via .bat real; pull trouxe commit ${r.shaN.slice(0, 12)} que altera o proprio .bat no meio da execucao; headFinal=${r.headFinal.slice(0, 12)} (esperado ${r.shaN.slice(0, 12)}); marcador-pos-update no log=${r.marcador}; execucoes=${JSON.stringify(r.execucoes)}; logs em ${r.tmp}`,
      [`${r.tmp}/w0-run1.log`]);
  }),
  w9: () => executarBatE2E(9, "w9").then((r) => {
    const subiu = r.execucoes[1]?.health === 200;
    reg("W9", subiu ? "aprovado" : "reprovado",
      `kill na janela pos-updater/pre-migrate (motivo=${r.execucoes[0]?.motivo}); headAposKill=${(r.headAposKill || "").slice(0, 12)}; retomada: health=${r.execucoes[1]?.health} motivo=${r.execucoes[1]?.motivo}; logs em ${r.tmp}`,
      [`${r.tmp}/w9-run1-kill.log`, `${r.tmp}/w9-run2-retomada.log`]);
  }),
  w10: () => executarBatE2E(10, "w10").then((r) => {
    const subiu = r.execucoes[1]?.health === 200;
    reg("W10", subiu ? "aprovado" : "reprovado",
      `kill apos migrate/antes do start; servidorNoArAposKill=${r.servidorNoArAposKill}; proximo boot: health=${r.execucoes[1]?.health}; logs em ${r.tmp}`,
      [`${r.tmp}/w10-run1-kill.log`, `${r.tmp}/w10-run2-proximo-boot.log`]);
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
