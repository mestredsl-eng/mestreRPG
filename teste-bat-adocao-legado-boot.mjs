// Item 2 da ordem do Dono (#318) — E2E do procedimento OFICIAL de boot
// sobre instalação legada 1.0.8, em clone 100% descartável:
//
//   clone do repo → checkout main@7e17c9b (1.0.8) → banco real no schema
//   1.0.8 (34 migrations) + usuário/campanha → checkout da candidata →
//   iniciar-mestre-rpg.bat REAL via cmd.exe → adoção assistida →
//   auto-update (remoto local ⇒ skip conservador) → builds → migrate
//   → servidor sobe → /api/health + login + dados preservados →
//   taskkill (interrupção) → novo BAT → health de novo (retomada).
//
// Nunca toca a instalação real: clone em temp, state/backups/arquivos
// isolados por env, node_modules por junction (npm ci é pulado).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync,
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
const SHA_108 = "7e17c9bca9a893e5f4e05967f91629d0ccddbd0d"; // main = v1.0.8
const REF_CANDIDATA = "origin/release/1.0.9-candidata"; // tip da branch (merge ref não existe em clone local)
const TEMP = mkdtempSync(join(tmpdir(), "mrpg-adocao-e2e-"));
const CLONE = join(TEMP, "clone-legado");
const STATE = join(TEMP, "state");
let batLog = "";

const git = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} → ${r.status}: ${(r.stderr ?? "").slice(0, 300)}`);
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
    const killer = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { encoding: "utf8" });
    void killer;
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
    console.log("== E2E oficial: BAT real sobre instalação 1.0.8 em clone descartável ==");

    // 1. Clone descartável + checkout 1.0.8.
    git(["clone", "--quiet", ROOT, CLONE]);
    git(["-C", CLONE, "checkout", "--quiet", "--detach", SHA_108]);
    t("clone em 1.0.8", git(["-C", CLONE, "rev-parse", "HEAD"]) === SHA_108);

    // 2. Banco legado REAL: migrations da própria árvore 1.0.8 + dados.
    const BANCO = join(CLONE, "banco", "mestre-rpg.db");
    mkdirSync(dirname(BANCO), { recursive: true });
    {
      const sqlite = new Database(BANCO);
      sqlite.pragma("journal_mode = WAL");
      await migrate(drizzle(sqlite), { migrationsFolder: join(CLONE, "servidor", "migrations") });
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

    // 3. Atualiza o CÓDIGO para a candidata (equivale ao auto-update do
    //    boot anterior) sem tocar no banco — primeiro boot do launcher novo.
    git(["-C", CLONE, "checkout", "--quiet", "--detach", REF_CANDIDATA]);
    t("clone atualizado para a candidata", existsSync(join(CLONE, "scripts", "adotar-legado.mjs")));

    // 4. node_modules por junction — `if not exist node_modules` do BAT
    //    pula npm ci; dependências são idênticas entre os SHAs.
    symlinkSync(join(ROOT, "node_modules"), join(CLONE, "node_modules"), "junction");
    t("node_modules junction criado", existsSync(join(CLONE, "node_modules", "better-sqlite3")));

    const PORTA = await portaLivre();
    const env = {
      ...process.env,
      PATH: dirname(process.execPath) + ";" + (process.env.PATH || ""),
      MESTRE_STATE_DIR: STATE,
      MESTRE_PORTA: String(PORTA),
      MESTRE_BANCO: BANCO,
      MESTRE_BACKUPS: join(CLONE, "backups"),
      MESTRE_ARQUIVOS: join(CLONE, "arquivos", "campanhas"),
    };
    const BASE = `http://127.0.0.1:${PORTA}`;

    const dispararBat = (entrada) => {
      batLog = "";
      const proc = spawn("cmd.exe", ["/d", "/c", "iniciar-mestre-rpg.bat"], {
        cwd: CLONE, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      proc.stdout.on("data", (d) => { batLog += d; });
      proc.stderr.on("data", (d) => { batLog += d; });
      proc.stdin.write(entrada);
      return proc;
    };

    // 5. PRIMEIRO BOOT do launcher novo sobre instalação 1.0.8.
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

    // Recibo de adoção + backup pre_adocao gravados no clone.
    const envClone = { ...process.env, MESTRE_STATE_DIR: STATE, MESTRE_BANCO: BANCO };
    t("recibo de instalação concluída (adoção)", lerReciboInstalacao(CLONE, envClone).status === "ok");
    const backupsDir = join(CLONE, "backups");
    const adocaoBackups = existsSync(backupsDir)
      ? readdirSync(backupsDir).filter((n) => n.startsWith("pre_adocao_")) : [];
    t("backup pre_adocao criado", adocaoBackups.length === 1, adocaoBackups.join(","));

    // 6. Migrações aplicadas: banco agora no schema completo (36).
    {
      const db = new Database(BANCO, { readonly: true });
      const n = db.prepare("select count(*) c from __drizzle_migrations").get().c;
      const users = db.prepare("select count(*) c from users").get().c;
      const campsDb = db.prepare("select count(*) c from campaigns").get().c;
      const chars = db.prepare("select count(*) c from characters").get().c;
      db.close();
      t("migrations completas aplicadas no boot", n === 36, String(n));
      t("dados preservados após migrate", users === 1 && campsDb === 1 && chars === 1,
        `users=${users} campaigns=${campsDb} characters=${chars}`);
    }

    // 7. INTERrupção: mata a árvore cmd→npm→node e sobe de novo.
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
  // Remove a junction ANTES do rm recursivo (não tocar node_modules real).
  try { rmSync(join(CLONE, "node_modules"), { force: true }); } catch { }
  rmSync(TEMP, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
