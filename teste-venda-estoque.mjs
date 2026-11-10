// Testes — venda de estoque dentro da transação financeira (PR #31).
// Roda contra CÓPIA isolada do banco em porta livre — nunca toca o definitivo.
//
// Sobre "concorrência": requisições HTTP em paralelo, mas better-sqlite3 é
// síncrono em conexão única — não há corrida real entre conexões. Os testes
// verificam os valores PERSISTIDOS no banco após operações intercaladas.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-venda-estoque";
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
function cookieAdmin() {
  const db = new Database(BANCO);
  const u = db.prepare("select id from users where username='administrador'").get();
  const token = "t-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  db.close();
  return `mestre_rpg_session=${encodeURIComponent(token)}`;
}
function comDb(fn) {
  const db = new Database(BANCO, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const saldoDb = (contaId) => comDb((db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
const txCount = (contaId) => comDb((db) => db.prepare("select count(*) c from money_transactions where account_id=?").get(contaId).c);
const itemQtd = (itemId) => comDb((db) => db.prepare("select quantity from inventory_entries where id=?").get(itemId)?.quantity ?? null);
const itemExiste = (itemId) => comDb((db) => !!db.prepare("select 1 from inventory_entries where id=?").get(itemId));

async function req(base, metodo, path, { cookie, body } = {}) {
  const r = await fetch(base + "/api" + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie: cookie ?? "" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;
try {
  proc = subir(porta);
  await esperarSaudavel(BASE, proc);
  const cookie = cookieAdmin();

  // ---------- cenário: campanha 'teste' + personagem + conta ----------
  const cid = comDb((db) => db.prepare("select id from campaigns where name='teste'").get().id);
  const memb = comDb((db) => db.prepare(
    "select m.id from memberships m join users u on u.id=m.user_id where m.campaign_id=? and u.username='administrador' and m.status='ativo'"
  ).get(cid));
  const charId = crypto.randomUUID();
  {
    const w = new Database(BANCO);
    const agora = Date.now();
    w.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(charId, cid, memb.id, "PJ Vendas", "{}", "{}", "aprovada", 0, agora, agora);
    w.close();
  }
  t("personagem criado no banco isolado", !!memb);

  const conta = (await req(BASE, "POST", `/characters/${charId}/financeiro/contas`, {
    cookie, body: { type: "especie", name: "Caixa", balanceReais: 1000 },
  })).json?.id;
  t("conta criada com saldo 1000.00", saldoDb(conta) === 100000, `db=${saldoDb(conta)}`);

  const novoItem = async (qtd) => {
    const r = await req(BASE, "POST", `/characters/${charId}/inventario`, {
      cookie, body: { name: `Item ${crypto.randomUUID().slice(0, 6)}`, quantity: qtd },
    });
    return r.json?.id ?? r.json?.item?.id;
  };

  // ===== 1. Venda parcial =====
  sec("Venda parcial");
  {
    const itemId = await novoItem(5);
    const antes = saldoDb(conta);
    const v = await req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
      cookie, body: { tipo: "venda", accountId: conta, valor: 20, itemId, quantidade: 2, requestId: `vp-${crypto.randomUUID()}` },
    });
    t("venda parcial → 201", v.status === 201, `status=${v.status} ${JSON.stringify(v.json).slice(0, 120)}`);
    t("estoque 5→3", itemQtd(itemId) === 3, `qtd=${itemQtd(itemId)}`);
    t("saldo +20.00", saldoDb(conta) === antes + 2000, `db=${saldoDb(conta)}`);
  }

  // ===== 2. Venda total =====
  sec("Venda total");
  {
    const itemId = await novoItem(3);
    const v = await req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
      cookie, body: { tipo: "venda", accountId: conta, valor: 30, itemId, requestId: `vt-${crypto.randomUUID()}` },
    });
    t("venda total → 201", v.status === 201, `status=${v.status}`);
    t("item removido do inventário", !itemExiste(itemId));
  }

  // ===== 3. Venda acima do estoque =====
  sec("Venda acima do estoque");
  {
    const itemId = await novoItem(2);
    const antes = saldoDb(conta);
    const txAntes = txCount(conta);
    const v = await req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
      cookie, body: { tipo: "venda", accountId: conta, valor: 10, itemId, quantidade: 99, requestId: `vo-${crypto.randomUUID()}` },
    });
    t("venda > estoque → 400", v.status === 400, `status=${v.status}`);
    t("estoque intacto", itemQtd(itemId) === 2, `qtd=${itemQtd(itemId)}`);
    t("saldo intacto", saldoDb(conta) === antes, `db=${saldoDb(conta)}`);
    t("nenhuma transação gravada", txCount(conta) === txAntes, `tx=${txCount(conta)}`);
  }

  // ===== 4. Duas vendas simultâneas de 4 num estoque de 5 =====
  sec("Vendas concorrentes no limite do estoque");
  {
    const itemId = await novoItem(5);
    const antes = saldoDb(conta);
    const txAntes = txCount(conta);
    const [v1, v2] = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
        cookie, body: { tipo: "venda", accountId: conta, valor: 10, itemId, quantidade: 4, requestId: `vc1-${crypto.randomUUID()}` },
      }),
      req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
        cookie, body: { tipo: "venda", accountId: conta, valor: 10, itemId, quantidade: 4, requestId: `vc2-${crypto.randomUUID()}` },
      }),
    ]);
    const oks = [v1, v2].filter((r) => r.status === 201).length;
    t("exatamente uma venda confirma", oks === 1, `status=${v1.status},${v2.status}`);
    t("a outra é rejeitada (400/409)", [v1.status, v2.status].some((s) => s === 400 || s === 409), `status=${v1.status},${v2.status}`);
    t("estoque final = 1", itemQtd(itemId) === 1, `qtd=${itemQtd(itemId)}`);
    t("saldo creditado uma única vez (+10.00)", saldoDb(conta) === antes + 1000, `db=${saldoDb(conta)} antes=${antes}`);
    t("exatamente 1 transação de venda gravada", txCount(conta) === txAntes + 1, `tx=${txCount(conta)} antes=${txAntes}`);
  }

  // ===== 5. requestId repetido (idempotência) =====
  sec("Idempotência por requestId");
  {
    const itemId = await novoItem(4);
    const rid = `idem-${crypto.randomUUID()}`;
    const antes = saldoDb(conta);
    const txAntes = txCount(conta);
    const [r1, r2] = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
        cookie, body: { tipo: "venda", accountId: conta, valor: 15, itemId, quantidade: 1, requestId: rid },
      }),
      req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
        cookie, body: { tipo: "venda", accountId: conta, valor: 15, itemId, quantidade: 1, requestId: rid },
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    t("1×201 + 1×409", statuses[0] === 201 && statuses[1] === 409, `status=${r1.status},${r2.status}`);
    t("estoque baixou só 1 unidade (4→3)", itemQtd(itemId) === 3, `qtd=${itemQtd(itemId)}`);
    t("saldo creditado uma vez (+15.00)", saldoDb(conta) === antes + 1500, `db=${saldoDb(conta)} antes=${antes}`);
    t("exatamente 1 transação gravada", txCount(conta) === txAntes + 1, `tx=${txCount(conta)} antes=${txAntes}`);
  }

  // ===== 6. Duas operações financeiras simultâneas na mesma conta =====
  sec("Operações simultâneas na mesma conta");
  {
    const i1 = await novoItem(2);
    const i2 = await novoItem(2);
    const antes = saldoDb(conta);
    const txAntes = txCount(conta);
    const rs = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
        cookie, body: { tipo: "venda", accountId: conta, valor: 10, itemId: i1, quantidade: 1, requestId: `sim1-${crypto.randomUUID()}` },
      }),
      req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
        cookie, body: { tipo: "compra", accountId: conta, valor: 25, item: { name: "Comprado", quantity: 1 }, requestId: `sim2-${crypto.randomUUID()}` },
      }),
      req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
        cookie, body: { tipo: "venda", accountId: conta, valor: 5, itemId: i2, quantidade: 1, requestId: `sim3-${crypto.randomUUID()}` },
      }),
    ]);
    const oks = rs.filter((r) => r.status === 201).length;
    t("3 operações → 3×201", oks === 3, rs.map((r) => r.status).join(","));
    // +10 -25 +5 = -10.00
    t("saldo final = antes -10.00", saldoDb(conta) === antes - 1000, `db=${saldoDb(conta)} antes=${antes}`);
    t("3 transações gravadas", txCount(conta) === txAntes + 3, `tx=${txCount(conta)} antes=${txAntes}`);
    t("estoque i1 = 1", itemQtd(i1) === 1, `qtd=${itemQtd(i1)}`);
    t("estoque i2 = 1", itemQtd(i2) === 1, `qtd=${itemQtd(i2)}`);
  }

  // ===== 7. Falha no meio da operação → rollback completo =====
  sec("Falha durante operação (lock externo) → rollback");
  {
    const itemId = await novoItem(5);
    const antes = saldoDb(conta);
    const txAntes = txCount(conta);
    // Segura lock de escrita no banco isolado: a transação do servidor falha.
    const bloqueio = new Database(BANCO);
    bloqueio.pragma("busy_timeout = 0");
    bloqueio.exec("BEGIN IMMEDIATE");
    const v = await req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
      cookie, body: { tipo: "venda", accountId: conta, valor: 50, itemId, quantidade: 2, requestId: `rb-${crypto.randomUUID()}` },
    });
    bloqueio.exec("ROLLBACK");
    bloqueio.close();
    t("operação falhou (não-201)", v.status !== 201, `status=${v.status}`);
    t("saldo intacto após falha", saldoDb(conta) === antes, `db=${saldoDb(conta)} antes=${antes}`);
    t("estoque intacto após falha", itemQtd(itemId) === 5, `qtd=${itemQtd(itemId)}`);
    t("nenhuma transação gravada", txCount(conta) === txAntes, `tx=${txCount(conta)} antes=${txAntes}`);
  }
} finally {
  proc?.kill();
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
