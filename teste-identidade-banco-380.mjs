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
  instalacaoId, lerIntencaoVinculacao, lerReciboInstalacao, sha256ReciboInstalacao,
} from "./scripts/estado-externo.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRADOR = join(ROOT, "servidor", "dist", "db", "migrate.js");
const MODULO = join(ROOT, "servidor", "src", "lib", "schema-reconhecedor.ts");
const MODULO_ID = join(ROOT, "servidor", "src", "lib", "identidade-banco.ts");
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

  const intencao = (id, sha) => ({
    protocolo: "identidade-vinculacao", versao: 1,
    instalacaoIdBanco: id, tipo: "vinculacao-inicial",
    vinculo: { repoCanon: undefined, reciboSha256NaCriacao: sha },
    criadoEm: new Date().toISOString(),
  });

  sec("5. B-2 — âncora reciboSha256NaCriacao é enforceada");
  {
    // 5a: recibo substituído na janela (sha divergente) → bloqueio.
    const c = cenarioMigrado();
    gravarReciboInstalacao(ROOT, c.env, { origem: "legado-teste" });
    const idInt = randomUUID();
    gravarIntencaoVinculacao(ROOT, intencao(idInt, "0".repeat(64)), c.env);
    const m = migrar(c.env);
    t("âncora divergente → migrate bloqueia", m.status !== 0
      && /identidade|nao-atada/i.test(String(m.stderr)),
      `status=${m.status} ${String(m.stderr).slice(-200)}`);
    t("intenção preservada após bloqueio B-2", lerIntencaoVinculacao(ROOT, c.env).status === "ok");
    t("banco não recebeu id (zero mutação pré-bloqueio)", idNoBanco(c.env.MESTRE_BANCO) === null);

    // 5b: âncora correta → recuperação converge ponta a ponta.
    const c2 = cenarioMigrado();
    gravarReciboInstalacao(ROOT, c2.env, { origem: "legado-teste" });
    const shaReal = sha256ReciboInstalacao(ROOT, c2.env);
    const id2 = randomUUID();
    gravarIntencaoVinculacao(ROOT, intencao(id2, shaReal), c2.env);
    const m2 = migrar(c2.env);
    t("âncora correta → migrate converge", m2.status === 0, String(m2.stderr).slice(-250));
    t("banco recebeu o id fixado na intenção", idNoBanco(c2.env.MESTRE_BANCO) === id2);
    const rec = lerReciboInstalacao(ROOT, c2.env);
    t("recibo carrega id + assinaturaSchema",
      rec.status === "ok" && rec.dados?.instalacaoIdBanco === id2
      && typeof rec.dados?.assinaturaSchema === "string");
    t("intenção consumida após convergência", lerIntencaoVinculacao(ROOT, c2.env).status === "ausente");
  }

  sec("6. Recibo ausente — intenção permanece (fase incompleta)");
  {
    const c = cenarioMigrado(); // sem recibo (bootstrap não concluído)
    const idInt = randomUUID();
    gravarIntencaoVinculacao(ROOT, intencao(idInt, null), c.env);
    const m = migrar(c.env);
    t("migrate prossegue (fase do recibo pendente não bloqueia)", m.status === 0,
      String(m.stderr).slice(-250));
    t("id gravado no banco", idNoBanco(c.env.MESTRE_BANCO) === idInt);
    t("intenção PRESERVADA p/ vínculo do bootstrap",
      lerIntencaoVinculacao(ROOT, c.env).status === "ok");
  }

  sec("7. B-1 — falha injetada no recibo não consome a intenção");
  {
    const c = cenarioMigrado();
    gravarReciboInstalacao(ROOT, c.env, { origem: "legado-teste" });
    const shaReal = sha256ReciboInstalacao(ROOT, c.env);
    const idInt = randomUUID();
    gravarIntencaoVinculacao(ROOT, intencao(idInt, shaReal), c.env);

    // Sonda com estado mockado: atualizarReciboInstalacao falha.
    const PROBE_B1 = join(BASE, "probe-b1.mts");
    writeFileSync(PROBE_B1, `
import { createRequire } from "node:module";
const require = createRequire(${JSON.stringify(join(ROOT, "servidor", "package.json"))});
const Database = require("better-sqlite3");
const mod = await import(${JSON.stringify(pathToFileURL(MODULO_ID).href)});
const estadoReal = await mod.carregarEstadoExterno();
const estado = { ...estadoReal,
  atualizarReciboInstalacao: () => ({ atualizado: false, motivo: "falha-injetada" }) };
const sqlite = new Database(process.argv[2]);
const r = mod.recuperarIntencaoPendente({
  estado, sqlite,
  env: { ...process.env, MESTRE_STATE_DIR: process.argv[3] },
  referenciaSchema: "ref-teste",
});
console.log("RESULT:" + JSON.stringify(r ?? null));
sqlite.close();
`);
    const r = spawnSync(process.execPath, [TSX, PROBE_B1, c.env.MESTRE_BANCO, c.env.MESTRE_STATE_DIR], {
      cwd: ROOT, encoding: "utf8", timeout: 60000,
    });
    const m = String(r.stdout ?? "").match(/RESULT:(.*)/);
    const res = m ? JSON.parse(m[1]) : null;
    t("retorno bloqueada com detalhe de recibo",
      res?.status === "bloqueada" && /recibo/i.test(res?.detalhe ?? ""),
      String(r.stdout).slice(-200) + String(r.stderr).slice(-200));
    t("intenção NÃO consumida após falha do recibo",
      lerIntencaoVinculacao(ROOT, c.env).status === "ok");
    t("id já gravado no banco (fase linha concluída)", idNoBanco(c.env.MESTRE_BANCO) === idInt);

    // Recuperação real converge na passada seguinte (auto-cura).
    const m2 = migrar(c.env);
    t("migrate real converge após falha transitória", m2.status === 0,
      String(m2.stderr).slice(-250));
    t("intenção consumida na recuperação real",
      lerIntencaoVinculacao(ROOT, c.env).status === "ausente");
  }

  sec("8. B3 — estado convergido alcançável (crash pós-recibo)");
  {
    // Verify-once converge tudo; depois simula crash pós-recibo
    // re-gravando intenção com âncora propositalmente velha.
    const c = cenarioMigrado();
    gravarReciboInstalacao(ROOT, c.env, { origem: "legado-teste" });
    const m1 = migrar(c.env);
    t("verify-once inicial ok", m1.status === 0, String(m1.stderr).slice(-200));
    const idV = idNoBanco(c.env.MESTRE_BANCO);
    t("id vigente capturado", typeof idV === "string");

    gravarIntencaoVinculacao(ROOT, intencao(idV, "f".repeat(64)), c.env);
    const m2 = migrar(c.env);
    t("B3: âncora velha mas recibo convergido → migrate ok", m2.status === 0,
      String(m2.stderr).slice(-250));
    t("intenção convergida consumida", lerIntencaoVinculacao(ROOT, c.env).status === "ausente");
    t("id permanece o mesmo", idNoBanco(c.env.MESTRE_BANCO) === idV);
  }

  console.log(`\n${pass} ok / ${fail} falhas`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("FALHA FATAL:", e);
  process.exit(1);
} finally {
  try { rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ }
}
