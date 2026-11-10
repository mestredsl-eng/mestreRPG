// Testes — atomicidade do saldo financeiro (lost update).
// Roda contra CÓPIA isolada do banco em porta livre — nunca toca o definitivo.
// Concorrência: disparadas N requisições HTTP em paralelo (Promise.all); o
// better-sqlite3 é síncrono/ single-connection, então a corrida real ocorre
// nas leituras assíncronas ANTES da transação — exatamente o bug corrigido.
// O teste verifica os valores PERSISTIDOS no banco, não só as respostas HTTP.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-financeiro-atomico";
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
const dbLeitura = () => new Database(BANCO, { readonly: true });
const saldoDb = (contaId) => dbLeitura().prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents;
const txCount = (contaId) => dbLeitura().prepare("select count(*) c from money_transactions where account_id=?").get(contaId).c;
const itemQtd = (itemId) => { const r = dbLeitura().prepare("select quantity from inventory_entries where id=?").get(itemId); return r?.quantity ?? null; };

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

  // ---------- cenário: campanha 'teste' + personagem + contas ----------
  // Personagem inserido direto no banco isolado: as rotas de patrimônio só
  // exigem a linha em `characters` + membership ativa do usuário.
  const cid = dbLeitura().prepare("select id from campaigns where name='teste'").get().id;
  const memb = dbLeitura().prepare(
    "select m.id from memberships m join users u on u.id=m.user_id where m.campaign_id=? and u.username='administrador' and m.status='ativo'"
  ).get(cid);
  const charId = crypto.randomUUID();
  {
    const w = new Database(BANCO);
    const agora = Date.now();
    w.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(charId, cid, memb.id, "PJ Atomico", "{}", "{}", "aprovada", 0, agora, agora);
    w.close();
  }
  t("personagem criado no banco isolado", !!memb);

  const mkConta = async (name, saldo, extra = {}) => {
    const r = await req(BASE, "POST", `/characters/${charId}/financeiro/contas`, {
      cookie, body: { type: "especie", name, balanceReais: saldo, ...extra },
    });
    return r.json?.id;
  };
  const contaA = await mkConta("Caixa A", 100);
  const contaB = await mkConta("Caixa B", 0);
  const contaC = await mkConta("Caixa C", 200);
  const cartao = await req(BASE, "POST", `/characters/${charId}/financeiro/contas`, {
    cookie, body: { type: "cartao_credito", name: "Cartão", creditLimitReais: 50 },
  });
  const contaCartao = cartao.json?.id;
  t("contas criadas", !!(contaA && contaB && contaC && contaCartao));

  // ===== 1. Entradas concorrentes na mesma conta =====
  sec("Entradas concorrentes");
  {
    const rs = await Promise.all(Array.from({ length: 5 }, () =>
      req(BASE, "POST", `/characters/${charId}/financeiro/movimentar`, {
        cookie, body: { accountId: contaA, tipo: "entrada", valor: 10 },
      })));
    const oks = rs.filter((r) => r.status === 201).length;
    t("5 entradas → 5 respostas 201", oks === 5, rs.map((r) => r.status).join(","));
    t("saldo final = 150.00 (100+5×10)", saldoDb(contaA) === 15000, `db=${saldoDb(contaA)}`);
    t("5 transações persistidas", txCount(contaA) === 6, `tx=${txCount(contaA)}`); // 5 + saldo_inicial
  }

  // ===== 2. Saídas concorrentes que não podem estourar o saldo =====
  sec("Saídas concorrentes limitadas pelo saldo");
  {
    // contaA tem 150.00; 10 saídas de 20 → no máximo 7 devem passar (140), resto 400
    const rs = await Promise.all(Array.from({ length: 10 }, () =>
      req(BASE, "POST", `/characters/${charId}/financeiro/movimentar`, {
        cookie, body: { accountId: contaA, tipo: "saida", valor: 20 },
      })));
    const oks = rs.filter((r) => r.status === 201).length;
    const saldo = saldoDb(contaA);
    t("saídas aceitas = floor(150/20)=7", oks === 7, `oks=${oks} statuses=${rs.map((r) => r.status).join(",")}`);
    t("saldo final = 10.00, nunca negativo", saldo === 1000, `db=${saldo}`);
  }

  // ===== 3. Transferências concorrentes entre contas =====
  sec("Transferências concorrentes");
  {
    const rs = await Promise.all(Array.from({ length: 4 }, () =>
      req(BASE, "POST", `/characters/${charId}/financeiro/transferir`, {
        cookie, body: { origemAccountId: contaC, destinoAccountId: contaB, valor: 50 },
      })));
    const oks = rs.filter((r) => r.status === 201).length;
    t("4 transferências → 4 respostas 201", oks === 4, rs.map((r) => r.status).join(","));
    t("origem = 0.00 (200-4×50)", saldoDb(contaC) === 0, `db=${saldoDb(contaC)}`);
    t("destino = 200.00 (0+4×50)", saldoDb(contaB) === 20000, `db=${saldoDb(contaB)}`);
    // conservação: soma das duas contas = 200.00
    t("soma conservada = 200.00", (saldoDb(contaC) + saldoDb(contaB)) === 20000);
  }

  // ===== 4. Idempotência: requestId duplicado =====
  sec("Idempotência por requestId");
  {
    const rid = `dup-${crypto.randomUUID()}`;
    const corpo = { accountId: contaA, tipo: "entrada", valor: 5, requestId: rid };
    const [r1, r2] = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/financeiro/movimentar`, { cookie, body: corpo }),
      req(BASE, "POST", `/characters/${charId}/financeiro/movimentar`, { cookie, body: corpo }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    t("1×201 + 1×409", statuses[0] === 201 && statuses[1] === 409, statuses.join(","));
    const antes = saldoDb(contaA);
    t("saldo creditado uma única vez (+5.00 → 15.00)", antes === 1500, `db=${antes}`);
    const txs = dbLeitura().prepare("select count(*) c from money_transactions where request_id=?").get(rid).c;
    t("1 transação com o requestId", txs === 1, `tx=${txs}`);
  }

  // ===== 5. Compra e venda consistentes =====
  sec("Compra/venda atômica");
  {
    // contaA está com 15.00; compra de 10 → saldo 5.00
    const compra = await req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
      cookie, body: { tipo: "compra", accountId: contaA, valor: 10, item: { name: "Poção", quantity: 4 }, requestId: `cmp-${crypto.randomUUID()}` },
    });
    t("compra 201", compra.status === 201, JSON.stringify(compra.json).slice(0, 120));
    t("saldo após compra = 5.00 (15-10)", saldoDb(contaA) === 500, `db=${saldoDb(contaA)}`);
    const item = dbLeitura().prepare("select id,quantity from inventory_entries where character_id=? and name='Poção'").get(charId);
    t("item Poção criado com qtd 4", item?.quantity === 4, JSON.stringify(item));

    // venda parcial
    if (item) {
      const venda = await req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
        cookie, body: { tipo: "venda", accountId: contaA, valor: 10, itemId: item.id, quantidade: 1, requestId: `vnd-${crypto.randomUUID()}` },
      });
      t("venda parcial 201", venda.status === 201, JSON.stringify(venda.json).slice(0, 120));
      t("estoque 4→3", itemQtd(item.id) === 3, `qtd=${itemQtd(item.id)}`);
      // venda acima do estoque → 400 e saldo/estoque intactos
      const antes = saldoDb(contaA);
      const over = await req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, {
        cookie, body: { tipo: "venda", accountId: contaA, valor: 10, itemId: item.id, quantidade: 99, requestId: `ovr-${crypto.randomUUID()}` },
      });
      t("venda > estoque → 400", over.status === 400, `status=${over.status}`);
      t("estoque intacto após venda inválida", itemQtd(item.id) === 3, `qtd=${itemQtd(item.id)}`);
      t("saldo intacto após venda inválida", saldoDb(contaA) === antes, `db=${saldoDb(contaA)} antes=${antes}`);
    }
  }

  // ===== 6. Limite de cartão de crédito =====
  sec("Limite de cartão de crédito");
  {
    const ok40 = await req(BASE, "POST", `/characters/${charId}/financeiro/movimentar`, {
      cookie, body: { accountId: contaCartao, tipo: "saida", valor: 40 },
    });
    t("saída 40 no limite 50 → 201", ok40.status === 201, `status=${ok40.status} ${JSON.stringify(ok40.json).slice(0, 120)}`);
    t("saldo cartão = -40.00", saldoDb(contaCartao) === -4000, `db=${saldoDb(contaCartao)}`);
    const over = await req(BASE, "POST", `/characters/${charId}/financeiro/movimentar`, {
      cookie, body: { accountId: contaCartao, tipo: "saida", valor: 20 },
    });
    t("saída que estoura limite → 400", over.status === 400, `status=${over.status}`);
    t("saldo cartão permanece -40.00", saldoDb(contaCartao) === -4000, `db=${saldoDb(contaCartao)}`);
  }

  // ===== 7. Concorrência mista: entradas+saídas+transferências na mesma conta =====
  sec("Carga mista concorrente");
  {
    // contaB tem 200; dispara entradas, saídas e transferências concorrentes
    const ops = [
      ...Array.from({ length: 4 }, () => req(BASE, "POST", `/characters/${charId}/financeiro/movimentar`, {
        cookie, body: { accountId: contaB, tipo: "entrada", valor: 25 },
      })),
      ...Array.from({ length: 6 }, () => req(BASE, "POST", `/characters/${charId}/financeiro/movimentar`, {
        cookie, body: { accountId: contaB, tipo: "saida", valor: 30 },
      })),
      ...Array.from({ length: 2 }, () => req(BASE, "POST", `/characters/${charId}/financeiro/transferir`, {
        cookie, body: { origemAccountId: contaB, destinoAccountId: contaC, valor: 40 },
      })),
    ];
    const rs = await Promise.all(ops);
    const entradas = rs.slice(0, 4).filter((r) => r.status === 201).length;
    const saidas = rs.slice(4, 10).filter((r) => r.status === 201).length;
    const transfs = rs.slice(10).filter((r) => r.status === 201).length;
    // saldo final = 200 + 4×25 - saidasOk×30 - transfsOk×40
    const saldoB = saldoDb(contaB);
    const esperado = 20000 + entradas * 2500 - saidas * 3000 - transfs * 4000;
    t("entradas concorrentes todas ok", entradas === 4, `=${entradas}`);
    t("saldo final bate com soma das operações aceitas", saldoB === esperado, `db=${saldoB} esperado=${esperado}`);
    t("saldo nunca negativo", saldoB >= 0, `db=${saldoB}`);
    // conservação global: soma de todas as contas = soma dos saldos iniciais + entradas externas
    // (simplificação: contas A/B/C/cartão — cartão pode ficar negativo por limite)
    const soma = [contaA, contaB, contaC, contaCartao].reduce((s, id) => s + (saldoDb(id) ?? 0), 0);
    t("nenhuma conta com saldo corrompido (null/inválido)", [contaA, contaB, contaC, contaCartao].every((id) => Number.isInteger(saldoDb(id))), `soma=${soma}`);
  }
} finally {
  proc?.kill();
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
