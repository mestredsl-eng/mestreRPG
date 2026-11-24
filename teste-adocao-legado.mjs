// Adoção assistida de instalação legada 1.0.8 → 1.0.9 (Issue #274).
// Cobre scripts/adotar-legado.mjs e o novo exit 11 de avaliar-boot.mjs:
// fixture de banco 1.0.8 REAL (34 migrations do journal truncado),
// integridade, esquema exato, backup validado, recibo, idempotência,
// retomada de journal e rejeições fail-closed. Roda em qualquer SO —
// o BAT/cmd.exe é coberto por teste-bat-adocao-legado.mjs (Windows).
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  avaliarCandidatoAdocaoLegada, gravarEstado, lerJournal,
  lerReciboInstalacao,
} from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ok", name); }
  else { fail++; console.error("  FALHOU", name, detail); }
};
const ROOT = process.cwd();
const SCRIPTS_NECESSARIOS = [
  "adotar-legado.mjs", "estado-externo.mjs", "boot-lock.mjs",
  "autorizar-bootstrap.mjs", "avaliar-boot.mjs",
  "protocolo-auto-update.json",
];
// Stub do auto-update: avaliar-boot.mjs importa recuperarAtualizacaoPendente
// antes do diagnóstico. O sentinela respeita o contrato de módulo e não
// executa nada — a fixture nunca chega ao updater.
const AUTO_UPDATE_STUB = `export async function recuperarAtualizacaoPendente() {\n  return { ok: true, recuperado: false, motivo: "fixture-sem-journal" };\n}\n`;
const MIGRATIONS = join(ROOT, "servidor", "migrations");
const ULTIMO_IDX_108 = 33;

function sha256(caminho) {
  return createHash("sha256").update(readFileSync(caminho)).digest("hex");
}

/** Monta uma "instalação" fixture DENTRO do repo (resolução de
 *  better-sqlite3 sobe até o node_modules da raiz) com banco no esquema
 *  1.0.8 exato: journal truncado nas 34 primeiras entradas. */
async function fixtureLegada(nome, { dados = true } = {}) {
  const dir = mkdtempSync(join(ROOT, `.tmp-adocao-${nome}-`));
  const app = join(dir, "instalacao legada");
  mkdirSync(join(app, "scripts"), { recursive: true });
  mkdirSync(join(app, "servidor", "migrations", "meta"), { recursive: true });
  for (const s of SCRIPTS_NECESSARIOS) {
    cpSync(join(ROOT, "scripts", s), join(app, "scripts", s));
  }
  writeFileSync(join(app, "scripts", "auto-update.mjs"), AUTO_UPDATE_STUB);
  cpSync(join(MIGRATIONS, "meta", "_journal.json"),
    join(app, "servidor", "migrations", "meta", "_journal.json"));

  const stateDir = join(dir, "state");
  const banco = join(dir, "banco", "mestre-rpg.db");
  mkdirSync(dirname(banco), { recursive: true });

  // Migrations 1.0.8: primeiras 34 entradas do journal vigente.
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
  const antigas = journal.entries.filter((e) => e.idx <= ULTIMO_IDX_108);
  const pastaAntigas = join(dir, "migrations-108");
  mkdirSync(join(pastaAntigas, "meta"), { recursive: true });
  for (const e of antigas) {
    cpSync(join(MIGRATIONS, `${e.tag}.sql`), join(pastaAntigas, `${e.tag}.sql`));
  }
  writeFileSync(join(pastaAntigas, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: antigas }));

  {
    const sqlite = new Database(banco);
    sqlite.pragma("journal_mode = WAL");
    await migrate(drizzle(sqlite), { migrationsFolder: pastaAntigas });
    if (dados) {
      const agora = Date.now();
      sqlite.prepare("insert into users (id,username,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,1,'ativo',?,?)")
        .run("u-legado-1", "mestre_legado", "x", agora, agora);
      sqlite.prepare("insert into campaigns (id,name,status,owner_id,settings,created_at,updated_at) values (?,?,?,?,?,?,?)")
        .run("c-legado-1", "Campanha 1.0.8", "andamento", "u-legado-1", "{}", agora, agora);
    }
    sqlite.close();
  }

  // Dados de apoio: configuração e arquivos de campanha.
  mkdirSync(join(app, "configuracao"), { recursive: true });
  writeFileSync(join(app, "configuracao", "servidor.json"), JSON.stringify({ porta: 3199 }));
  const arquivos = join(dir, "arquivos", "campanhas", "legada");
  mkdirSync(arquivos, { recursive: true });
  writeFileSync(join(arquivos, "cenario.txt"), "cenario da campanha legada");

  const env = {
    ...process.env,
    MESTRE_STATE_DIR: stateDir,
    MESTRE_BANCO: banco,
    MESTRE_BACKUPS: join(dir, "backups"),
    MESTRE_ARQUIVOS: join(dir, "arquivos", "campanhas"),
  };
  return { dir, app, env, banco, stateDir };
}

function rodarAdocao(f, args = ["--confirmar"]) {
  return spawnSync("node", [join(f.app, "scripts", "adotar-legado.mjs"), ...args], {
    cwd: f.app, env: f.env, encoding: "utf8", timeout: 60000,
  });
}
function rodarPreflight(f) {
  return spawnSync("node", [join(f.app, "scripts", "avaliar-boot.mjs"), "preflight"], {
    cwd: f.app, env: f.env, encoding: "utf8", timeout: 30000,
  });
}
function contarPreAdocao(f) {
  const dirB = f.env.MESTRE_BACKUPS;
  return existsSync(dirB) ? readdirSync(dirB).filter((n) => n.startsWith("pre_adocao_")).length : 0;
}

console.log("== Adoção assistida de instalação legada (1.0.8 → 1.0.9) ==");

try {
  // --- diagnóstico sem flag: nada é escrito ---
  {
    const f = await fixtureLegada("dry");
    const r = rodarAdocao(f, []);
    t("sem --confirmar → exit 2", r.status === 2, `status=${r.status}`);
    t("sem flag → nenhum estado gravado",
      lerReciboInstalacao(f.app, f.env).status === "ausente"
      && lerJournal(f.app, "adocao-legado.json", f.env).status === "ausente"
      && contarPreAdocao(f) === 0);
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- caminho feliz: adoção completa ---
  {
    const f = await fixtureLegada("ok");
    const hashAntes = sha256(f.banco);
    const pre = rodarPreflight(f);
    t("preflight legado → exit 11", pre.status === 11, `status=${pre.status} ${pre.stderr}`);
    t("preflight legado → candidato adotável",
      avaliarCandidatoAdocaoLegada(f.app, f.env).adotavel === true);

    const r = rodarAdocao(f);
    t("adoção → exit 0", r.status === 0, `status=${r.status} ${r.stderr} ${r.stdout}`);
    const recibo = lerReciboInstalacao(f.app, f.env);
    t("recibo de instalação concluída gravado", recibo.status === "ok" && recibo.dados?.origem === "adocao-legado",
      JSON.stringify(recibo).slice(0, 200));
    const journal = lerJournal(f.app, "adocao-legado.json", f.env);
    t("journal de adoção fase concluida", journal.status === "ok" && journal.dados?.fase === "concluida");
    t("backup pre_adocao criado", contarPreAdocao(f) === 1);
    const manifestPath = join(f.env.MESTRE_BACKUPS,
      readdirSync(f.env.MESTRE_BACKUPS).find((n) => n.startsWith("pre_adocao_")), "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    t("manifest cobre banco+config+arquivos",
      manifest.arquivos.some((e) => e.destino.includes("mestre-rpg.db"))
      && manifest.arquivos.some((e) => e.destino.includes("servidor.json"))
      && manifest.arquivos.some((e) => e.destino.includes("cenario.txt")));
    t("banco fonte byte-idêntico após adoção", sha256(f.banco) === hashAntes);
    const db = new Database(f.banco, { readonly: true });
    t("dados preservados (users+campaigns)",
      db.prepare("select count(*) c from users").get().c === 1
      && db.prepare("select count(*) c from campaigns").get().c === 1);
    db.close();

    // idempotência
    const r2 = rodarAdocao(f);
    t("reexecução → exit 0 idempotente", r2.status === 0 && /já adotada/.test(r2.stdout), r2.stdout);
    t("reexecução → sem backup extra", contarPreAdocao(f) === 1);

    // após adoção, preflight reconhece instalação concluída
    const pre2 = rodarPreflight(f);
    t("preflight pós-adoção → exit 0", pre2.status === 0, `status=${pre2.status} ${pre2.stderr}`);
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- retomada: journal backup-ok pula etapa de backup ---
  {
    const f = await fixtureLegada("resume");
    const r1 = rodarAdocao(f);
    t("primeira adoção ok (setup retomada)", r1.status === 0);
    // Simula crash entre backup e recibo: remove recibo e volta o
    // journal para backup-ok.
    const dirEstado = join(f.stateDir, (await import("./scripts/boot-lock.mjs")).instalacaoId(f.app));
    rmSync(join(dirEstado, "instalacao-recibo.json"), { force: true });
    const jr = JSON.parse(readFileSync(join(dirEstado, "adocao-legado.json"), "utf8"));
    jr.fase = "backup-ok";
    writeFileSync(join(dirEstado, "adocao-legado.json"), JSON.stringify(jr, null, 2));
    const antes = contarPreAdocao(f);
    const r2 = rodarAdocao(f);
    t("retomada backup-ok → exit 0 sem refazer backup",
      r2.status === 0 && contarPreAdocao(f) === antes, `${r2.status} ${r2.stderr}`);
    t("retomada → recibo regravado", lerReciboInstalacao(f.app, f.env).status === "ok");
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- esquema desconhecido: fail-closed ---
  {
    const f = await fixtureLegada("esquema-x");
    {
      const db = new Database(f.banco);
      db.prepare("insert into __drizzle_migrations (hash, created_at) values ('adulterado', 1)").run();
      db.close();
    }
    const r = rodarAdocao(f);
    t("esquema adulterado → exit 1", r.status === 1, `status=${r.status}`);
    t("esquema adulterado → motivo correto", /esquema-nao-reconhecido/.test(r.stderr + r.stdout), r.stderr);
    t("esquema adulterado → sem recibo/backup",
      lerReciboInstalacao(f.app, f.env).status === "ausente" && contarPreAdocao(f) === 0);
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- banco não-SQLite: fail-closed ---
  {
    const f = await fixtureLegada("lixo", { dados: false });
    rmSync(f.banco, { force: true });
    writeFileSync(f.banco, "isto nao e um banco sqlite");
    const r = rodarAdocao(f);
    t("banco inválido → exit 1", r.status === 1, `status=${r.status}`);
    t("banco inválido → sem recibo", lerReciboInstalacao(f.app, f.env).status === "ausente");
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- state dir com arquivo desconhecido: nem candidato ---
  {
    const f = await fixtureLegada("state-x");
    mkdirSync(f.stateDir, { recursive: true });
    // dirEstado = <MESTRE_STATE_DIR>/<instalacaoId>; descobre o id.
    const { instalacaoId } = await import("./scripts/boot-lock.mjs");
    const dirId = join(f.stateDir, instalacaoId(f.app));
    mkdirSync(dirId, { recursive: true });
    writeFileSync(join(dirId, "arquivo-estranho.json"), "{}");
    const pre = rodarPreflight(f);
    t("state ambíguo → preflight exit 1 (não oferece adoção)", pre.status === 1, `status=${pre.status}`);
    const r = rodarAdocao(f);
    t("state ambíguo → adoção exit 1", r.status === 1);
    rmSync(f.dir, { recursive: true, force: true });
  }
} finally {
  // Limpeza de fixtures remanescentes em caso de falha.
  for (const n of readdirSync(ROOT)) {
    if (n.startsWith(".tmp-adocao-")) rmSync(join(ROOT, n), { recursive: true, force: true });
  }
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
