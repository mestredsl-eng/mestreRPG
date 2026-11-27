#!/usr/bin/env node
// Issue #380 — identidade do banco (L4): verify-once, divergência,
// recuperação de intenção pendente e idempotência pós-migrate.
// Complementa a suíte do FILHO (teste-schema-reconhecedor-380): aqui o
// foco é o ciclo de vida do instalacaoIdBanco e dos artefatos de estado.
// Fixtures 100% descartáveis; produção nunca é tocada.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  autorizarPrimeiroBootstrap, consumirAutorizacaoBootstrap, dirEstado,
  gravarIntencaoVinculacao, gravarProvisionamento, gravarReciboInstalacao,
  instalacaoId, lerIntencaoVinculacao, lerReciboInstalacao,
} from "./scripts/estado-externo.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRADOR = join(ROOT, "servidor", "dist", "db", "migrate.js");
const MODULO = join(ROOT, "servidor", "src", "lib", "schema-reconhecedor.ts");
const MIGRATIONS = join(ROOT, "servidor", "migrations");

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, extra); }
};
const sec = (n) => console.log("\n== " + n + " ==");

const BASE = mkdtempSync(join(tmpdir(), "mestre-380-id-"));
let seq = 0;
const cenario = () => {
  const dir = join(BASE, `c${++seq}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    env: {
      MESTRE_BANCO: join(dir, "banco", "mestre-rpg.db"),
      MESTRE_BACKUPS: join(dir, "backups"),
      MESTRE_ARQUIVOS: join(dir, "arquivos"),
      MESTRE_STATE_DIR: join(dir, "state"),
    },
  };
};
const bootstrapar = (c) => {
  gravarProvisionamento(ROOT, c.env);
  const a = autorizarPrimeiroBootstrap(ROOT, c.env);
  if (!a.autorizado) throw new Error(`bootstrap não autorizado: ${a.motivo}`);
};
const migrar = (env) => spawnSync(process.execPath, [MIGRADOR], {
  cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", timeout: 180000,
});
const comDb = (dbPath, fn) => {
  const db = new Database(dbPath);
  try { return fn(db); } finally { db.close(); }
};
const idNoBanco = (dbPath) => comDb(dbPath, (d) => {
  const r = d.prepare("select value from server_settings where key='protocolo.instalacaoIdBanco'").get();
  if (!r) return null;
  try { return JSON.parse(r.value)?.id ?? r.value; } catch { return r.value; }
});
const gravarIdNoBanco = (dbPath, id) => comDb(dbPath, (d) => {
  d.prepare("insert into server_settings (key,value,updated_at) values ('protocolo.instalacaoIdBanco',?,?) " +
    "on conflict(key) do update set value=excluded.value, updated_at=excluded.value")
    .run(JSON.stringify({ id, criadoEm: new Date().toISOString(), versaoProtocolo: 1 }), Date.now());
});

// Sonda do reconhecedor (mesmo padrão da suíte do FILHO).
const PROBE = join(BASE, "probe-id.mts");
writeFileSync(PROBE, `
const mod = await import(${JSON.stringify(pathToFileURL(MODULO).href)});
const r = await mod.reconhecerSchema(process.argv[2], process.argv[3]);
console.log("RESULT:" + JSON.stringify(r ?? null));
`);
function verificar(dbPath, envExtra = {}) {
  const r = spawnSync(process.execPath, [TSX, PROBE, dbPath, MIGRATIONS], {
    cwd: ROOT,
    env: { ...process.env, MESTRE_MOD_380: pathToFileURL(MODULO).href, ...envExtra },
    encoding: "utf8", timeout: 120000,
  });
  const m = String(r.stdout ?? "").match(/RESULT:(.*)/);
  if (!m) return { ok: null, erro: `sonda falhou: ${String(r.stderr).slice(-200)}` };
  try { return JSON.parse(m[1]); } catch { return { ok: null, erro: "JSON inválido" }; }
}

/** Cenário base: bootstrap + migrate completo → banco atual sem id e sem
 *  recibo (estado pré-#380 / primeiro bootstrap não concluído). */
function cenarioMigrado() {
  const c = cenario();
  bootstrapar(c);
  const r = migrar(c.env);
  if (r.status !== 0) throw new Error(`migrate falhou: ${String(r.stderr).slice(-300)}`);
  return c;
}

try {
  sec("1. Verify-once — recibo legado sem id + banco sem id");
  {
    const c = cenarioMigrado();
    // Simula instalação pré-#380: recibo permanente SEM instalacaoIdBanco.
    gravarReciboInstalacao(ROOT, c.env, { origem: "legado-teste" });
    const r = lerReciboInstalacao(ROOT, c.env);
    t("recibo legado gravado sem id", r.status === "ok" && !r.dados.instalacaoIdBanco);

    const antes = Date.now();
    const m = migrar(c.env);
    t("migrate pós-verify-once exit 0", m.status === 0, String(m.stderr).slice(-250));
    t("verify-once levou tempo plausível (replay)", Date.now() - antes > 0);

    const id = idNoBanco(c.env.MESTRE_BANCO);
    t("server_settings recebeu instalacaoIdBanco (uuid)",
      typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id), String(id));
    const recibo = lerReciboInstalacao(ROOT, c.env);
    t("recibo atualizado com instalacaoIdBanco == banco",
      recibo.status === "ok" && recibo.dados.instalacaoIdBanco === id,
      JSON.stringify(recibo.dados).slice(0, 200));
    t("recibo atualizado com assinaturaSchema",
      typeof recibo.dados?.assinaturaSchema === "string" && recibo.dados.assinaturaSchema.length === 64);
    t("intenção consumida (não sobrou pendente)",
      lerIntencaoVinculacao(ROOT, c.env).status === "ausente");

    // Idempotência: segundo migrate não troca o id nem bloqueia.
    const m2 = migrar(c.env);
    t("segundo migrate exit 0", m2.status === 0, String(m2.stderr).slice(-200));
    t("id preservado entre migrates", idNoBanco(c.env.MESTRE_BANCO) === id);
  }

  sec("2. T7a — banco de outra instalação (id divergente) bloqueia");
  {
    const c = cenarioMigrado();
    const idFalso = randomUUID();
    gravarIdNoBanco(c.env.MESTRE_BANCO, idFalso);
    gravarReciboInstalacao(ROOT, c.env, { instalacaoIdBanco: randomUUID() }); // recibo id ≠ banco
    const v = verificar(c.env.MESTRE_BANCO, { MESTRE_STATE_DIR: c.env.MESTRE_STATE_DIR });
    t("reconhecedor: banco-nao-pertence-a-esta-instalacao",
      v.ok === false && v.motivo === "banco-nao-pertence-a-esta-instalacao",
      JSON.stringify(v).slice(0, 200));
    const m = migrar(c.env);
    t("migrate bloqueia no gate (exit != 0)", m.status !== 0,
      `status=${m.status} ${String(m.stderr).slice(-160)}`);
  }

  sec("3. B4 — intenção pendente com id divergente do banco bloqueia");
  {
    const c = cenarioMigrado();
    const idIntencao = randomUUID();
    const idBanco = randomUUID();
    gravarIdNoBanco(c.env.MESTRE_BANCO, idBanco);
    gravarReciboInstalacao(ROOT, c.env, { instalacaoIdBanco: idBanco });
    gravarIntencaoVinculacao(ROOT, {
      protocolo: "identidade-vinculacao", versao: 1,
      instalacaoIdBanco: idIntencao, tipo: "vinculacao-inicial",
      vinculo: { repoCanon: undefined, reciboSha256NaCriacao: null },
      criadoEm: new Date().toISOString(),
    }, c.env);
    t("intenção pendente gravada", lerIntencaoVinculacao(ROOT, c.env).status === "ok");
    const m = migrar(c.env);
    t("migrate bloqueia identidade-nao-atada (B4)", m.status !== 0
      && /identidade|nao-atada/i.test(String(m.stderr)),
      `status=${m.status} ${String(m.stderr).slice(-200)}`);
    t("id do banco NÃO foi reescrito", idNoBanco(c.env.MESTRE_BANCO) === idBanco);
    t("intenção permanece para intervenção", lerIntencaoVinculacao(ROOT, c.env).status === "ok");
  }

  sec("4. Vínculo de bootstrap — id preservado quando já existe");
  {
    const c = cenario();
    bootstrapar(c);
    const r1 = migrar(c.env);
    t("migrate inicial ok", r1.status === 0);
    // Banco clonado: id bem-formado já presente antes do vínculo.
    const idExistente = randomUUID();
    gravarIdNoBanco(c.env.MESTRE_BANCO, idExistente);
    consumirAutorizacaoBootstrap(ROOT, c.env);
    // Boot real (dist) conclui bootstrap com vínculo.
    const { subirServidor, portaLivre, esperarSaudavel, encerrarServidor } = await import("./teste-base.mjs");
    const porta = await portaLivre();
    const proc = subirServidor(porta, {
      banco: c.env.MESTRE_BANCO, arquivos: c.env.MESTRE_ARQUIVOS,
      backups: c.env.MESTRE_BACKUPS, env: { MESTRE_STATE_DIR: c.env.MESTRE_STATE_DIR },
    });
    try {
      await esperarSaudavel(`http://127.0.0.1:${porta}`, proc, 90000);
      t("boot saudável", true);
    } catch (e) {
      t("boot saudável", false, String(e).slice(0, 300));
    } finally { await encerrarServidor(proc); }
    const recibo = lerReciboInstalacao(ROOT, c.env);
    t("recibo gravado com instalacaoIdBanco == id preexistente",
      recibo.status === "ok" && recibo.dados.instalacaoIdBanco === idExistente,
      JSON.stringify(recibo.dados).slice(0, 200));
    t("id do banco preservado (não regenerado)", idNoBanco(c.env.MESTRE_BANCO) === idExistente);
    t("intenção consumida após convergência",
      lerIntencaoVinculacao(ROOT, c.env).status === "ausente");
  }

  console.log(`\n${pass} ok / ${fail} falhas`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("FALHA FATAL:", e);
  process.exit(1);
} finally {
  try { rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ }
}
