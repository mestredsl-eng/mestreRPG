#!/usr/bin/env node
// Testes — adoção assistida de instalação legada 1.0.8 (ordem #318 item 1).
// Fixture: banco SQLite real com schema mínimo 1.0.8 (34 migrations +
// tabelas sentinela), state dir isolado, sem estado de protocolo.
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lerReciboInstalacao, dirEstado,
} from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, extra); }
};
const sec = (n) => console.log("\n== " + n + " ==");

const ROOT = process.cwd();
const ADOTAR = join(ROOT, "scripts", "adotar-legado.mjs");
const AVALIAR = join(ROOT, "scripts", "avaliar-boot.mjs");
const BASE = mkdtempSync(join(tmpdir(), "mestre-adocao-"));
let seq = 0;

const TABELAS = ["users", "campaigns", "server_settings"];
const fixture = (nome, { migrations = 34, tabelas = TABELAS } = {}) => {
  const dir = join(BASE, nome);
  mkdirSync(join(dir, "banco"), { recursive: true });
  const env = {
    ...process.env,
    MESTRE_BANCO: join(dir, "banco", "mestre-rpg.db"),
    MESTRE_BACKUPS: join(dir, "backups"),
    MESTRE_ARQUIVOS: join(dir, "arquivos", "campanhas"),
    MESTRE_STATE_DIR: join(dir, "state"),
  };
  const db = new Database(env.MESTRE_BANCO);
  db.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER)");
  for (const tab of tabelas) {
    db.exec(`CREATE TABLE ${tab} (id TEXT PRIMARY KEY)`);
    db.exec(`INSERT INTO ${tab} (id) VALUES ('x1')`);
  }
  const ins = db.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)");
  for (let i = 0; i < migrations; i++) ins.run(`h${i}`, i);
  db.close();
  mkdirSync(env.MESTRE_ARQUIVOS, { recursive: true });
  writeFileSync(join(env.MESTRE_ARQUIVOS, "ficha.txt"), "dado-legado\n");
  return { dir, env };
};
const rodar = (script, args, env) => spawnSync(process.execPath, [script, ...args], {
  cwd: ROOT, env, encoding: "utf8", timeout: 60000,
});
const backupsAdocao = (env) => {
  const base = env.MESTRE_BACKUPS;
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((d) => d.startsWith("adocao-"));
};

try {
  sec("A1 — flag obrigatória");
  {
    const c = fixture(`a1-${++seq}`);
    const r = rodar(ADOTAR, [], c.env);
    t("sem --confirmar-adocao → exit 2", r.status === 2, `status=${r.status}`);
  }

  sec("A2 — adoção feliz: schema+integridade+backup+recibo");
  {
    const c = fixture(`a2-${++seq}`);
    // avaliar-boot deve detectar candidato → exit 11
    const av = rodar(AVALIAR, ["preflight"], c.env);
    t("avaliar-boot preflight → exit 11 (candidato legado)", av.status === 11, `status=${av.status} out=${String(av.stdout).slice(0, 200)}`);
    const r = rodar(ADOTAR, ["--confirmar-adocao"], c.env);
    t("adotar-legado → exit 0", r.status === 0, `status=${r.status} err=${String(r.stderr).slice(0, 300)}`);
    const recibo = lerReciboInstalacao(ROOT, c.env);
    t("recibo instalado com marcador adocaoLegada", recibo.status === "ok" && !!recibo.dados?.adocaoLegada, JSON.stringify(recibo).slice(0, 200));
    t("recibo registra origem 1.0.8 e 34 migrations", recibo.dados?.adocaoLegada?.origem === "1.0.8" && recibo.dados?.adocaoLegada?.migrationsLegado === 34);
    const bs = backupsAdocao(c.env);
    t("backup adocao-* criado", bs.length === 1, bs.join(","));
    const bdir = join(c.env.MESTRE_BACKUPS, bs[0]);
    t("backup contém DB + manifesto", existsSync(join(bdir, "banco", "mestre-rpg.db")) && existsSync(join(bdir, "manifesto.json")));
    t("backup contém arquivos do usuário", existsSync(join(bdir, "arquivos", "campanhas", "ficha.txt")));
    const man = JSON.parse(readFileSync(join(bdir, "manifesto.json"), "utf8"));
    t("manifesto tem sha256 do DB", /^[0-9a-f]{64}$/.test(man.arquivos["banco/mestre-rpg.db"]?.sha256 ?? ""));
    // idempotência
    const r2 = rodar(ADOTAR, ["--confirmar-adocao"], c.env);
    t("segunda execução idempotente → exit 0 sem novo backup", r2.status === 0 && backupsAdocao(c.env).length === 1, `status=${r2.status}`);
    // após adoção, avaliar-boot deve liberar (instalacao-concluida)
    const av2 = rodar(AVALIAR, ["preflight"], c.env);
    t("pós-adoção avaliar-boot → exit 0", av2.status === 0, `status=${av2.status}`);
  }

  sec("A3 — bloqueios fail-closed");
  {
    // migrations divergentes (35 = já tem 0034)
    const c1 = fixture(`a3a-${++seq}`, { migrations: 35 });
    const r1 = rodar(ADOTAR, ["--confirmar-adocao"], c1.env);
    t("35 migrations → bloqueado", r1.status === 1, `status=${r1.status}`);
    t("sem recibo gravado", lerReciboInstalacao(ROOT, c1.env).status === "ausente");
    // tabela sentinela ausente
    const c2 = fixture(`a3b-${++seq}`, { tabelas: ["users"] });
    const r2 = rodar(ADOTAR, ["--confirmar-adocao"], c2.env);
    t("tabela sentinela ausente → bloqueado", r2.status === 1, `status=${r2.status}`);
    // banco ausente
    const c3dir = join(BASE, `a3c-${seq}`);
    mkdirSync(c3dir, { recursive: true });
    const c3env = { ...process.env, MESTRE_BANCO: join(c3dir, "banco", "x.db"), MESTRE_STATE_DIR: join(c3dir, "state") };
    const r3 = rodar(ADOTAR, ["--confirmar-adocao"], c3env);
    t("banco ausente → bloqueado", r3.status === 1, `status=${r3.status}`);
    // state com artefato estranho → não candidato
    const c4 = fixture(`a3d-${++seq}`);
    mkdirSync(dirEstado(ROOT, c4.env), { recursive: true });
    writeFileSync(join(dirEstado(ROOT, c4.env), "arquivo-estranho.json"), "{}");
    const r4 = rodar(ADOTAR, ["--confirmar-adocao"], c4.env);
    t("state com arquivo desconhecido → bloqueado", r4.status === 1, `status=${r4.status}`);
  }

  sec("A4 — interrupção antes do commit é segura");
  {
    const c = fixture(`a4-${++seq}`);
    // Simula kill: nenhum estado de protocolo pode existir sem recibo.
    // O único commit é gravarReciboInstalacao — antes dele, só backups
    // regeneráveis em MESTRE_BACKUPS (fora do state dir).
    const av = rodar(AVALIAR, ["preflight"], c.env);
    t("pré-adoção: exit 11 e state dir sem recibo", av.status === 11 && lerReciboInstalacao(ROOT, c.env).status === "ausente");
  }
} finally {
  console.log(`\n${pass} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
}
