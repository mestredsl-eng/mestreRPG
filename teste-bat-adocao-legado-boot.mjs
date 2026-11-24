// Item 2 da ordem do Dono (#318) — E2E do procedimento OFICIAL de boot
// sobre instalação legada 1.0.8, em fixture 100% descartável:
//
//   árvore-fonte da candidata via `git archive HEAD` (sem .git) +
//   banco REAL no schema 1.0.8 (journal truncado nas 34 migrations de
//   main@7e17c9b — arquivos idênticos, diff vazio vs. candidata) +
//   usuário/campanha/personagem → iniciar-mestre-rpg.bat REAL via
//   cmd.exe → adoção assistida → auto-update (sem .git ⇒ skip
//   conservador) → builds → migrate → servidor → /api/health + login +
//   dados preservados → taskkill (interrupção) → novo BAT → health de
//   novo (retomada).
//
// Nunca toca a instalação real: fixture em temp, state/backups/arquivos
// isolados por env, node_modules por junction (npm ci é pulado).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { hashSenha } from "./servidor/dist/lib/password.js";
import { lerReciboInstalacao } from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.error("  FALHOU", n, extra); }
};
const ROOT = dirname(fileURLToPath(import.meta.url));
const ULTIMO_IDX_108 = 33; // main@7e17c9b: 34 migrations, idx 0..33
const TEMP = mkdtempSync(join(tmpdir(), "mrpg-adocao-e2e-"));
const FIX = join(TEMP, "instalacao-legada");
const STATE = join(TEMP, "state");
let batLog = "";

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120000, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} → ${r.status}: ${(r.stderr ?? r.stdout ?? "").slice(0, 300)}`);
  return (r.stdout ?? "").trim();
};
const portaLivre = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
async function esperarHealth(base, timeoutMs = 480000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    try {
      const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(3000) });
      if (r.ok) return await r.json().catch(() => ({}));
    } catch { }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout aguardando /api/health em ${base}`);
}
function matarArvore(proc) {
  if (!proc || proc.exitCode !== null) return Promise.resolve();
  return new Promise((res) => {
    spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { encoding: "utf8" });
    proc.once("exit", res);
    setTimeout(res, 10000);
  });
}

let batProc = null;
try {
  if (process.platform !== "win32") {
    console.log("E2E do BAT exige Windows (cmd.exe + taskkill).");
    process.exitCode = 2;
  } else {
    console.log("== E2E oficial: BAT real sobre instalação 1.0.8 em fixture descartável ==");

    // 1. Árvore-fonte da candidata via git archive (somente arquivos
    //    rastreados do HEAD testado — sem .git, node_modules, dados).
    const tarPath = join(TEMP, "fonte.tar");
    sh("git", ["-C", ROOT, "archive", "--format=tar", "-o", tarPath, "HEAD"]);
    mkdirSync(FIX, { recursive: true });
    sh("tar", ["--force-local", "-xf", tarPath, "-C", FIX]);
    t("árvore da candidata extraída", existsSync(join(FIX, "iniciar-mestre-rpg.bat"))
      && existsSync(join(FIX, "scripts", "adotar-legado.mjs"))
      && !existsSync(join(FIX, ".git")));

    // 2. Banco legado REAL: subconjunto de migrations idêntico ao de
    //    main@7e17c9b (entries idx<=33; diff dos arquivos vs. 1.0.8 é
    //    vazio — migrations são append-only) + dados de usuário.
    const journal = JSON.parse(
      readFileSync(join(ROOT, "servidor", "migrations", "meta", "_journal.json"), "utf8"),
    );
    const antigas = journal.entries.filter((e) => e.idx <= ULTIMO_IDX_108);
    const pastaAntigas = join(TEMP, "migrations-108");
    mkdirSync(join(pastaAntigas, "meta"), { recursive: true });
    const MIGRATIONS = join(ROOT, "servidor", "migrations");
    for (const e of antigas) {
      copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(pastaAntigas, `${e.tag}.sql`));
    }
    writeFileSync(join(pastaAntigas, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: antigas }));
    t("subconjunto 1.0.8 montado", antigas.length === 34, String(antigas.length));

    const BANCO = join(FIX, "banco", "mestre-rpg.db");
    mkdirSync(dirname(BANCO), { recursive: true });
    {
      const sqlite = new Database(BANCO);
      sqlite.pragma("journal_mode = WAL");
      await migrate(drizzle(sqlite), { migrationsFolder: pastaAntigas });
      const agora = Date.now();
      const senha = await hashSenha("senha-e2e-123");
      sqlite.prepare("insert into users (id,username,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,1,'ativo',?,?)")
        .run("u-e2e", "mestre_e2e", senha, agora, agora);
      sqlite.prepare("insert into campaigns (id,name,status,owner_id,settings,created_at,updated_at) values (?,?,?,?,?,?,?)")
        .run("c-e2e", "Campanha E2E 1.0.8", "andamento", "u-e2e", "{}", agora, agora);
      sqlite.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run("m-e2e", "c-e2e", "u-e2e", "mestre", "{}", "ativo", agora, agora, agora);
      sqlite.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run("ch-e2e", "c-e2e", "m-e2e", "Herói E2E", "{}", "{}", "aprovada", agora, agora);
      sqlite.close();
    }
    {
      const db = new Database(BANCO, { readonly: true });
      const n = db.prepare("select count(*) c from __drizzle_migrations").get().c;
      db.close();
      t("banco legado com 34 migrations", n === 34, String(n));
    }

    // 3. node_modules por junction — `if not exist node_modules` do BAT
    //    pula npm ci; dependências idênticas às da árvore testada.
    symlinkSync(join(ROOT, "node_modules"), join(FIX, "node_modules"), "junction");
    t("node_modules junction criado", existsSync(join(FIX, "node_modules", "better-sqlite3")));

    const PORTA = await portaLivre();
    const env = {
      ...process.env,
      PATH: dirname(process.execPath) + ";" + (process.env.PATH || ""),
      MESTRE_STATE_DIR: STATE,
      MESTRE_PORTA: String(PORTA),
      MESTRE_BANCO: BANCO,
      MESTRE_BACKUPS: join(FIX, "backups"),
      MESTRE_ARQUIVOS: join(FIX, "arquivos", "campanhas"),
    };
    const BASE = `http://127.0.0.1:${PORTA}`;

    const dispararBat = (entrada) => {
      batLog = "";
      const proc = spawn("cmd.exe", ["/d", "/c", "iniciar-mestre-rpg.bat"], {
        cwd: FIX, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      proc.stdout.on("data", (d) => { batLog += d; });
      proc.stderr.on("data", (d) => { batLog += d; });
      proc.stdin.write(entrada);
      return proc;
    };

    // 4. PRIMEIRO BOOT do launcher novo sobre instalação 1.0.8.
    console.log("  … primeiro boot do BAT (build + adoção + migrate + start) — pode levar minutos");
    batProc = dispararBat("S\r\nx\r\nx\r\n");
    const health1 = await esperarHealth(BASE);
    t("/api/health OK no primeiro boot", !!health1, JSON.stringify(health1).slice(0, 200));

    const login = await fetch(BASE + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mestre_e2e", password: "senha-e2e-123" }),
    });
    const lj = await login.json().catch(() => ({}));
    t("login do usuário legado funciona", login.ok && !!lj.usuario, `status ${login.status}`);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const camps = await (await fetch(BASE + "/api/campaigns", { headers: { cookie } })).json().catch(() => ({}));
    const lista = camps.campanhas ?? camps.campaigns ?? (Array.isArray(camps) ? camps : []);
    t("campanha legada listada na API", lista.some((c) => c.name === "Campanha E2E 1.0.8"), JSON.stringify(camps).slice(0, 160));

    const envClone = { ...process.env, MESTRE_STATE_DIR: STATE, MESTRE_BANCO: BANCO };
    t("recibo de instalação concluída (adoção)", lerReciboInstalacao(FIX, envClone).status === "ok");
    const backupsDir = join(FIX, "backups");
    const adocaoBackups = existsSync(backupsDir)
      ? readdirSync(backupsDir).filter((n) => n.startsWith("pre_adocao_")) : [];
    t("backup pre_adocao criado", adocaoBackups.length === 1, adocaoBackups.join(","));

    // 5. Migrações aplicadas: banco agora no schema completo — a contagem
    //    esperada é derivada do journal (não hardcoded), para não quebrar
    //    a cada migration futura.
    {
      const db = new Database(BANCO, { readonly: true });
      const n = db.prepare("select count(*) c from __drizzle_migrations").get().c;
      const users = db.prepare("select count(*) c from users").get().c;
      const campsDb = db.prepare("select count(*) c from campaigns").get().c;
      const chars = db.prepare("select count(*) c from characters").get().c;
      db.close();
      t("migrations completas aplicadas no boot", n === journal.entries.length, `${n} vs ${journal.entries.length}`);
      t("dados preservados após migrate", users === 1 && campsDb === 1 && chars === 1,
        `users=${users} campaigns=${campsDb} characters=${chars}`);
    }

    // 6. INTERrupção: mata a árvore cmd→npm→node e sobe de novo.
    console.log("  … taskkill da árvore do servidor (interrupção)");
    await matarArvore(batProc);
    batProc = null;
    await new Promise((r) => setTimeout(r, 1500));

    console.log("  … segundo boot do BAT (retomada pós-interrupção)");
    batProc = dispararBat("\r\n");
    const health2 = await esperarHealth(BASE, 240000);
    t("/api/health OK no segundo boot (retomada)", !!health2);
    const login2 = await fetch(BASE + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mestre_e2e", password: "senha-e2e-123" }),
    });
    t("login funciona após retomada", login2.ok, `status ${login2.status}`);
  }
} catch (e) {
  fail++;
  console.error("  FALHOU exceção:", e?.message ?? e);
  if (batLog) console.error("  --- últimas linhas do BAT ---\n" + batLog.slice(-3000));
} finally {
  await matarArvore(batProc);
  try { rmSync(join(FIX, "node_modules"), { force: true }); } catch { }
  rmSync(TEMP, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
