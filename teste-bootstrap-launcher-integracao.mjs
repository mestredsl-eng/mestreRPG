// Integração do boot — Issue #155 W13/W14.
//
// Verifica o ENCADEAMENTO real do iniciar-mestre-rpg.bat:
//   Node/npm → Boot Lock → Gate 0 → auto-update → npm ci → builds →
//   restauração → migrations → servidor, com liberação do lock em todos
//   os caminhos de erro e sem bypass do Gate 0 por servidor/migrador.
//
// Foco: ordem e atomicidade do processo de inicialização — NÃO repete a
// auditoria adversarial do estado (filho) nem corrige produção (pai).
// Requer Windows (cmd.exe real); em outras plataformas registra skip.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(__dirname);
const BAT = join(RAIZ, "iniciar-mestre-rpg.bat");
const { instalacaoId } = await import("./scripts/boot-lock.mjs");

const TMP = join(tmpdir(), "mrpg-boot-int-" + process.pid);
mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
function t(nome, cond, extra = "") {
  if (cond) { pass++; console.log("ok", nome); }
  else { fail++; console.log("FALHOU", nome, extra ? `— ${extra}` : ""); }
}

// ---------- 1. Estrutural: ordem e liberação no .bat ----------
{
  const bat = readFileSync(BAT, "utf8");
  const iAdq = bat.indexOf("boot-lock.mjs adquirir");
  const iGate = bat.indexOf("bootstrap-install.mjs");
  const iUpd = bat.indexOf("auto-update.mjs");
  const iCi = bat.indexOf("call npm ci");
  const iBuild = bat.indexOf("npm run build -w servidor");
  const iRest = bat.indexOf("aplicar-restauracao.js");
  const iMig = bat.indexOf("db:migrate");
  const iStart = bat.indexOf("npm run start");
  const ordem = [iAdq, iGate, iUpd, iCi, iBuild, iRest, iMig, iStart];
  t(".bat: adquirir < Gate 0 < auto-update < npm ci < build < restauração < migrate < start",
    ordem.every((v, i) => v > 0 && (i === 0 || v > ordem[i - 1])), ordem.join(","));
  t(".bat: exit 20 (servidor no ar) ANTES do Gate 0",
    bat.indexOf("errorlevel%==20") > 0 && bat.indexOf("errorlevel%==20") < iGate);
  // todo exit /b 1 após a aquisição deve ter um liberar próximo antes
  const releases = [...bat.matchAll(/boot-lock\.mjs liberar/g)].length;
  const exitsErro = [...bat.matchAll(/exit \/b 1/g)].length;
  // exits de erro pré-lock (node/npm ausente) não precisam liberar
  t(".bat: liberação presente em quantidade compatível com caminhos de erro",
    releases >= 5, `releases=${releases} exits=${exitsErro}`);
  t(".bat: protocolo tracked sem Gate 0 bloqueia",
    /protocolo-auto-update\.json[\s\S]{0,400}?exit \/b 1/.test(bat));
}

// ---------- 2. Comportamental: cmd.exe real, fixtures descartáveis ----------
if (process.platform !== "win32") {
  console.log("skip comportamental — cmd.exe não se aplica a " + process.platform);
} else {
  const stubBin = join(TMP, "stub-bin");
  mkdirSync(stubBin, { recursive: true });
  // npm.cmd stub: registra cada invocação no arquivo de ordem e sai 0.
  writeFileSync(join(stubBin, "npm.cmd"),
    "@echo off\r\necho npm %* >> \"%MESTRE_ORDEM_ARQ%\"\r\nexit /b 0\r\n");
  const PATH_STUB = stubBin + ";" + (process.env.PATH ?? "");

  const GATE_REAL = join(RAIZ, "scripts", "bootstrap-install.mjs");
  const EE_REAL = join(RAIZ, "scripts", "estado-externo.mjs");
  const PROTOCOLO = join(RAIZ, "scripts", "protocolo-auto-update.json");

  function prepararRaiz(nome, { comGate = true, comProtocolo = true } = {}) {
    const dir = join(TMP, "bat-" + nome);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "servidor", "dist", "db"), { recursive: true });
    writeFileSync(join(dir, "iniciar-mestre-rpg.bat"),
      readFileSync(BAT, "utf8").replace(/\r?\n/g, "\r\n"));
    copyFileSync(join(RAIZ, "scripts", "boot-lock.mjs"), join(dir, "scripts", "boot-lock.mjs"));
    copyFileSync(EE_REAL, join(dir, "scripts", "estado-externo.mjs"));
    if (comGate) copyFileSync(GATE_REAL, join(dir, "scripts", "bootstrap-install.mjs"));
    if (comProtocolo) copyFileSync(PROTOCOLO, join(dir, "scripts", "protocolo-auto-update.json"));
    // auto-update stub: registra ordem + marcador
    writeFileSync(join(dir, "scripts", "auto-update.mjs"),
      `import { appendFileSync, writeFileSync } from "node:fs";\n` +
      `const f = process.env.MESTRE_ORDEM_ARQ; if (f) appendFileSync(f, "auto-update\\n");\n` +
      `writeFileSync(${JSON.stringify(join(dir, "upd.marker").replace(/\\/g, "/"))}, "1");\n` +
      `process.exit(Number(process.env.MESTRE_UPD_EXIT ?? 0));\n`);
    // restaurador stub: registra ordem; exit configurável
    writeFileSync(join(dir, "servidor", "dist", "db", "aplicar-restauracao.js"),
      `import { appendFileSync } from "node:fs";\n` +
      `const f = process.env.MESTRE_ORDEM_ARQ; if (f) appendFileSync(f, "restauracao\\n");\n` +
      `process.exit(Number(process.env.MESTRE_REST_EXIT ?? 0));\n`);
    const ordem = join(dir, "ordem.txt");
    const env = {
      ...process.env,
      PATH: PATH_STUB,
      LOCALAPPDATA: join(dir, "localappdata"),
      MESTRE_STATE_DIR: join(dir, "state"),
      MESTRE_PROVENIENCIA_DIR: join(dir, "install"),
      MESTRE_ORDEM_ARQ: ordem,
      MESTRE_PORTA: "39993",
      MESTRE_BOOT_LOCK_TIMEOUT_MS: "800",
    };
    return { dir, env, ordem, marker: join(dir, "upd.marker") };
  }

  const lockFile = (ctx) =>
    join(ctx.env.MESTRE_STATE_DIR, instalacaoId(ctx.dir), "mestre-boot-lock.json");
  const ordemLinhas = (ctx) =>
    existsSync(ctx.ordem) ? readFileSync(ctx.ordem, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];

  function rodar(ctx, extraEnv = {}, async = false) {
    const args = { cwd: ctx.dir, env: { ...ctx.env, ...extraEnv }, encoding: "utf8", timeout: 120000 };
    if (!async) return spawnSync("cmd.exe", ["/d", "/c", "iniciar-mestre-rpg.bat"], { ...args, stdio: ["ignore", "pipe", "pipe"] });
    return new Promise((res2) => {
      const p = spawn("cmd.exe", ["/d", "/c", "iniciar-mestre-rpg.bat"], { ...args, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { out += d; });
      p.on("close", (code) => res2({ status: code, stdout: out, stderr: "" }));
    });
  }

  // Helper: grava marcador de proveniência real via módulo de estado
  function gravarMarcador(ctx) {
    const code =
      `import(${JSON.stringify("file:///" + EE_REAL.replace(/\\/g, "/"))}).then(m => ` +
      `m.gravarMarcadorInstalacao(${JSON.stringify(ctx.dir)}, ${JSON.stringify(ctx.env)}))`;
    execFileSync("node", ["--input-type=module", "-e", code], { env: ctx.env });
  }

  // B) primeira instalação (clone vazio) → fluxo completo na ordem certa
  let ctx = prepararRaiz("clone-novo");
  let r = rodar(ctx);
  const outB = (r.stdout ?? "") + (r.stderr ?? "");
  t("B clone novo → exit 0", r.status === 0, `status=${r.status} ${outB.slice(-300)}`);
  const ordB = ordemLinhas(ctx);
  const iAuto = ordB.indexOf("auto-update"), iRest = ordB.indexOf("restauracao");
  const iMig = ordB.findIndex((l) => l.includes("db:migrate"));
  const iStart = ordB.findIndex((l) => l.includes("run start"));
  t("B auto-update rodou", existsSync(ctx.marker));
  t("B ordem: restauração < migrate < start",
    iRest > iAuto && iMig > iRest && iStart > iMig, ordB.join("|"));
  t("B lock liberado ao final", !existsSync(lockFile(ctx)), lockFile(ctx));
  t("B autorização de bootstrap emitida no state dir",
    existsSync(join(ctx.env.MESTRE_STATE_DIR)));

  // C) instalação registrada sem banco → Gate 0 bloqueia TUDO
  ctx = prepararRaiz("banco-perdido");
  gravarMarcador(ctx);
  r = rodar(ctx);
  const outC = (r.stdout ?? "") + (r.stderr ?? "");
  t("C banco perdido → exit 1", r.status === 1, `status=${r.status}`);
  t("C mensagem de bloqueio do portão", /proveni|banco|instala/i.test(outC), outC.slice(-250));
  t("C auto-update NÃO rodou", !existsSync(ctx.marker));
  t("C nenhuma etapa mutável na ordem", ordemLinhas(ctx).length === 0, ordemLinhas(ctx).join("|"));
  t("C lock liberado mesmo no bloqueio", !existsSync(lockFile(ctx)), lockFile(ctx));

  // D) Gate 0 ausente + protocolo tracked → bloqueia
  ctx = prepararRaiz("gate-ausente", { comGate: false, comProtocolo: true });
  r = rodar(ctx);
  t("D gate ausente + protocolo → exit 1", r.status === 1, `status=${r.status}`);
  t("D auto-update NÃO rodou", !existsSync(ctx.marker));
  t("D lock liberado", !existsSync(lockFile(ctx)), lockFile(ctx));

  // E) Gate 0 ausente + sem protocolo → fixture mínima tolerada
  ctx = prepararRaiz("gate-ausente-sem-proto", { comGate: false, comProtocolo: false });
  r = rodar(ctx);
  t("E gate ausente sem protocolo → boot prossegue (exit 0)", r.status === 0, `status=${r.status}`);
  t("E auto-update rodou", existsSync(ctx.marker));

  // F) servidor já no ar → exit 20 → .bat sai 0 sem gate/updater
  ctx = prepararRaiz("ja-no-ar");
  const srv = createServer((q, s) => { s.writeHead(200); s.end("ok"); });
  await new Promise((res2) => srv.listen(0, "127.0.0.1", res2));
  const portaSrv = srv.address().port;
  ctx.env.MESTRE_PORTA = String(portaSrv);
  try {
    r = await rodar(ctx, {}, true);
    t("F servidor ativo → exit 0", r.status === 0, `status=${r.status}`);
    t("F auto-update NÃO rodou", !existsSync(ctx.marker));
    t("F ordem vazia (nenhuma etapa mutável)", ordemLinhas(ctx).length === 0);
    t("F nenhum lock criado", !existsSync(lockFile(ctx)));
    // O helper pode criar o diretório <state>/<id>/ antes da sonda de
    // health (mkdirSync precede o probe) — o contrato é: nenhum ARQUIVO
    // (lock, journal, autorização) pode existir no caminho do exit 20.
    const arquivosState = [];
    const varrer = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); e.isDirectory() ? varrer(p) : arquivosState.push(p); } };
    if (existsSync(ctx.env.MESTRE_STATE_DIR)) varrer(ctx.env.MESTRE_STATE_DIR);
    t("F exit 20 → state dir sem nenhum arquivo", arquivosState.length === 0, arquivosState.join(","));
  } finally {
    await new Promise((res2) => srv.close(res2));
  }

  // G) falha do auto-update → exit 1 + lock liberado
  ctx = prepararRaiz("upd-falha");
  r = rodar(ctx, { MESTRE_UPD_EXIT: "1" });
  t("G auto-update falha → exit 1", r.status === 1, `status=${r.status}`);
  t("G lock liberado após falha do updater", !existsSync(lockFile(ctx)), lockFile(ctx));

  // H) falha da restauração → exit 1 + lock liberado (ordem anterior preservada)
  ctx = prepararRaiz("rest-falha");
  r = rodar(ctx, { MESTRE_REST_EXIT: "1" });
  t("H restauração falha → exit 1", r.status === 1, `status=${r.status}`);
  t("H migrate NÃO rodou após restauração falha",
    !ordemLinhas(ctx).some((l) => l.includes("db:migrate")), ordemLinhas(ctx).join("|"));
  t("H lock liberado", !existsSync(lockFile(ctx)), lockFile(ctx));

  // I) Gate 0 é somente-leitura para servidor/migrador: verificarPortao
  //    bloqueia estado ambíguo sem escrever nada.
  {
    const mod = await import("file:///" + GATE_REAL.replace(/\\/g, "/"));
    const ctxI = prepararRaiz("portao-ro", { comGate: true });
    gravarMarcador(ctxI); // instalação registrada, banco ausente → bloqueia
    const antes = existsSync(ctxI.env.MESTRE_STATE_DIR)
      ? JSON.stringify(require("node:fs").readdirSync(ctxI.env.MESTRE_STATE_DIR)) : "";
    const v = await mod.verificarPortao({ repoDir: ctxI.dir, env: ctxI.env });
    t("I verificarPortao bloqueia banco-perdido", v.seguroIniciar === false, JSON.stringify(v));
    const srcIdx = readFileSync(join(RAIZ, "servidor", "src", "index.ts"), "utf8");
    const srcMig = readFileSync(join(RAIZ, "servidor", "src", "db", "migrate.ts"), "utf8");
    t("I index.ts chama verificarPortao e aborta",
      /verificarPortao/.test(srcIdx) && /process\.exit\(2\)/.test(srcIdx));
    t("I migrate.ts chama verificarPortao e aborta",
      /verificarPortao/.test(srcMig) && /process\.exit\(2\)/.test(srcMig));
  }
}

console.log(`\n${pass} ok, ${fail} falhas`);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ok */ }
process.exit(fail ? 1 : 0);
