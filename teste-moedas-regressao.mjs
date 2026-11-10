// Regressão de moedas — PRs #29 (formatação) e #32 (moeda da conta).
// Banco isolado: valida casas decimais 0–4, PATCH de moeda rejeitado/
// preservado, metadados sem tocar saldo/histórico, nova conta em moeda
// configurada e permissões mestre/jogador.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-moedas";
const BANCO = `${DIR}/mestre-rpg-teste.db`;
mkdirSync(DIR, { recursive: true });
for (const suf of ["", "-wal", "-shm"]) rmSync(BANCO + suf, { force: true });
{
  const orig = new Database("banco/mestre-rpg.db", { readonly: true });
  orig.prepare(`VACUUM INTO '${BANCO.replace(/\\/g, "/")}'`).run();
  orig.close();
}

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

function portaLivre() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function esperarSaudavel(base, proc) {
  const limite = Date.now() + 30000;
  while (Date.now() < limite) {
    try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { }
    if (proc.exitCode !== null) throw new Error("servidor morreu: " + proc.exitCode);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("timeout");
}
function subir(porta) {
  return spawn("node", ["servidor/dist/index.js"], {
    env: { ...process.env, MESTRE_PORTA: String(porta), MESTRE_BANCO: BANCO, MESTRE_ARQUIVOS: DIR + "/arq", MESTRE_BACKUPS: DIR + "/bks" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function sessao(userId) {
  const db = new Database(BANCO);
  const token = "t-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  db.close();
  return `mestre_rpg_session=${encodeURIComponent(token)}`;
}
function comDb(fn) {
  const db = new Database(BANCO, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const saldoDb = (id) => comDb((db) => db.prepare("select balance_cents from financial_accounts where id=?").get(id)?.balance_cents);
const txCount = (id) => comDb((db) => db.prepare("select count(*) c from money_transactions where account_id=?").get(id).c);
const moedaDb = (id) => comDb((db) => db.prepare("select currency from financial_accounts where id=?").get(id)?.currency);

async function req(base, metodo, path, { cookie, body } = {}) {
  const r = await fetch(base + "/api" + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie: cookie ?? "" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// Ajusta financeiro.casasDecimais e financeiro.moedas no ruleset ativo
function setFinanceiro(campId, patch) {
  const db = new Database(BANCO);
  const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campId);
  const cfg = JSON.parse(rs.config);
  cfg.financeiro = { ...cfg.financeiro, ...patch };
  db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
  db.close();
}

// ---------- seed ----------
const ids = (() => {
  const db = new Database(BANCO);
  const admin = db.prepare("select id from users where username='administrador'").get().id;
  const jogador = db.prepare("select id from users where username='fernandoqc_@hotmail.com'").get().id;
  const camp = db.prepare("select id from campaigns where name='teste'").get().id;
  const membM = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(camp, admin).id;
  let membJ = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(camp, jogador)?.id;
  const agora = Date.now();
  if (!membJ) {
    membJ = crypto.randomUUID();
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(membJ, camp, jogador, "jogador", "ativo", agora, agora);
  }
  const charM = crypto.randomUUID(), charJ = crypto.randomUUID();
  db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
    .run(charM, camp, membM, "Mestre Moedas", "{}", "{}", "aprovada", 0, agora, agora);
  db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
    .run(charJ, camp, membJ, "Jogador Moedas", "{}", "{}", "aprovada", 0, agora, agora);
  db.close();
  return { admin, jogador, camp, charM, charJ };
})();
console.log("seed:", ids);

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
const cm = sessao(ids.admin), cj = sessao(ids.jogador);
let proc;

async function saldoApi(charId, cookie) {
  const r = await req(BASE, "GET", `/characters/${charId}/financeiro`, { cookie });
  return r.json?.contas ?? [];
}

try {
  proc = subir(porta);
  await esperarSaudavel(BASE, proc);
  // Config base: moeda principal BRL + EUR/USD configuradas
  setFinanceiro(ids.camp, { casasDecimais: 2, moedaPrincipal: "BRL", moedas: [{ codigo: "EUR", nome: "Euro" }, { codigo: "USD", nome: "Dólar" }] });

  // ===== PATCH de moeda (PR #32) =====
  sec("PATCH de moeda na conta");
  {
    const conta = (await req(BASE, "POST", `/characters/${ids.charM}/financeiro/contas`, {
      cookie: cm, body: { type: "especie", name: "Carteira", balanceReais: 100 },
    })).json?.id;
    const txAntes = txCount(conta), saldoAntes = saldoDb(conta);

    const mesmo = await req(BASE, "PATCH", `/characters/${ids.charM}/financeiro/contas/${conta}`, {
      cookie: cm, body: { currency: "BRL" },
    });
    t("PATCH com mesma moeda → 200", mesmo.status === 200, `status=${mesmo.status}`);

    const outra = await req(BASE, "PATCH", `/characters/${ids.charM}/financeiro/contas/${conta}`, {
      cookie: cm, body: { currency: "EUR" },
    });
    t("PATCH para moeda configurada diferente → 400", outra.status === 400, `status=${outra.status} ${JSON.stringify(outra.json).slice(0, 120)}`);
    t("moeda permanece BRL", moedaDb(conta) === "BRL", `moeda=${moedaDb(conta)}`);

    const naoConf = await req(BASE, "PATCH", `/characters/${ids.charM}/financeiro/contas/${conta}`, {
      cookie: cm, body: { currency: "BTC" },
    });
    t("PATCH para moeda não configurada → 400", naoConf.status === 400, `status=${naoConf.status}`);

    const meta = await req(BASE, "PATCH", `/characters/${ids.charM}/financeiro/contas/${conta}`, {
      cookie: cm, body: { name: "Carteira Renomeada" },
    });
    t("PATCH de metadados → 200", meta.status === 200, `status=${meta.status}`);
    t("saldo inalterado após PATCH", saldoDb(conta) === saldoAntes, `db=${saldoDb(conta)} antes=${saldoAntes}`);
    t("histórico inalterado após PATCH", txCount(conta) === txAntes, `tx=${txCount(conta)} antes=${txAntes}`);
    t("moeda continua BRL", moedaDb(conta) === "BRL");
  }

  // ===== Nova conta em outra moeda configurada =====
  sec("Nova conta em moeda configurada");
  {
    const eur = await req(BASE, "POST", `/characters/${ids.charM}/financeiro/contas`, {
      cookie: cm, body: { type: "especie", name: "Conta EUR", currency: "EUR", balanceReais: 50 },
    });
    t("conta EUR → 201", eur.status === 201, `status=${eur.status} ${JSON.stringify(eur.json).slice(0, 120)}`);
    t("moeda gravada = EUR", moedaDb(eur.json?.id) === "EUR", `moeda=${moedaDb(eur.json?.id)}`);
    const btc = await req(BASE, "POST", `/characters/${ids.charM}/financeiro/contas`, {
      cookie: cm, body: { type: "especie", name: "Conta BTC", currency: "BTC" },
    });
    t("conta BTC (não configurada) → 400", btc.status === 400, `status=${btc.status}`);
  }

  // ===== Casas decimais 0–4 =====
  sec("Casas decimais 0 a 4");
  for (const casas of [0, 1, 2, 3, 4]) {
    setFinanceiro(ids.camp, { casasDecimais: casas });
    const valor = casas === 0 ? 42 : casas === 1 ? 42.5 : casas === 2 ? 42.55 : casas === 3 ? 42.555 : 42.5555;
    const esperado = Math.round(valor * 10 ** casas);
    const conta = (await req(BASE, "POST", `/characters/${ids.charM}/financeiro/contas`, {
      cookie: cm, body: { type: "especie", name: `Conta ${casas} casas`, balanceReais: valor },
    })).json?.id;
    const mov = await req(BASE, "POST", `/characters/${ids.charM}/financeiro/movimentar`, {
      cookie: cm, body: { accountId: conta, tipo: "entrada", valor: casas === 0 ? 8 : casas === 1 ? 8.5 : casas === 2 ? 8.55 : casas === 3 ? 8.555 : 8.5555 },
    });
    const esperadoFinal = esperado + Math.round((casas === 0 ? 8 : casas === 1 ? 8.5 : casas === 2 ? 8.55 : casas === 3 ? 8.555 : 8.5555) * 10 ** casas);
    t(`casas=${casas}: saldo inicial persistido`, saldoDb(conta) >= esperado, `db=${saldoDb(conta)} esp=${esperado}`);
    t(`casas=${casas}: movimentação → saldo final correto`, mov.status === 201 && saldoDb(conta) === esperadoFinal, `status=${mov.status} db=${saldoDb(conta)} esp=${esperadoFinal}`);
    const contas = await saldoApi(ids.charM, cm);
    const c = contas.find((x) => x.id === conta);
    t(`casas=${casas}: GET /financeiro devolve saldo escalado`, c && Math.abs(c.saldo - esperadoFinal / 10 ** casas) < 1e-9, `saldo=${c?.saldo} esp=${esperadoFinal / 10 ** casas}`);
  }
  setFinanceiro(ids.camp, { casasDecimais: 2 });

  // ===== Permissões =====
  sec("Permissões mestre/jogador");
  {
    const contaJ = (await req(BASE, "POST", `/characters/${ids.charJ}/financeiro/contas`, {
      cookie: cj, body: { type: "especie", name: "Carteira J", balanceReais: 10 },
    })).json?.id;
    t("jogador cria conta → 201", !!contaJ);
    const patchJ = await req(BASE, "PATCH", `/characters/${ids.charJ}/financeiro/contas/${contaJ}`, {
      cookie: cj, body: { currency: "EUR", name: "Carteira J2" },
    });
    t("jogador PATCH moeda diferente → 400", patchJ.status === 400, `status=${patchJ.status}`);
    t("moeda do jogador continua BRL", moedaDb(contaJ) === "BRL");
    const patchJMeta = await req(BASE, "PATCH", `/characters/${ids.charJ}/financeiro/contas/${contaJ}`, {
      cookie: cj, body: { name: "Carteira J2" },
    });
    t("jogador PATCH metadados próprios → 200", patchJMeta.status === 200, `status=${patchJMeta.status}`);
  }
} finally {
  proc?.kill();
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
