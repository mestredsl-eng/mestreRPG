// Testes — integridade inventário ↔ equipamentos (Etapa 2, Issue #33).
// Regra: equipar separa EXATAMENTE 1 unidade; desequipar/excluir devolve
// 1 unidade ao inventário; nada duplica, some ou fica órfão.
// Roda contra CÓPIA isolada do banco em porta livre — nunca toca o definitivo.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-equipamentos";
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
function comDb(fn) {
  const db = new Database(BANCO, { readonly: true });
  try { return fn(db); } finally { db.close(); }
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

  // ---------- cenário ----------
  const cid = comDb((db) => db.prepare("select id from campaigns where name='teste'").get().id);
  const memb = comDb((db) => db.prepare(
    "select m.id from memberships m join users u on u.id=m.user_id where m.campaign_id=? and u.username='administrador' and m.status='ativo'"
  ).get(cid));
  const charId = crypto.randomUUID();
  {
    const w = new Database(BANCO);
    const agora = Date.now();
    w.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(charId, cid, memb.id, "PJ Equip", "{}", "{}", "aprovada", 0, agora, agora);
    w.close();
  }
  t("personagem criado", !!memb);

  const novoItem = async (name, quantity, extra = {}) => {
    const r = await req(BASE, "POST", `/characters/${charId}/inventario`, {
      cookie, body: { name, quantity, category: "teste", description: `desc ${name}`, weight: 1.5, valueCents: 999, ...extra },
    });
    return r.json?.id;
  };
  const inv = async () => (await req(BASE, "GET", `/characters/${charId}/inventario`, { cookie })).json?.itens ?? [];
  const eqs = async () => (await req(BASE, "GET", `/characters/${charId}/equipamentos`, { cookie })).json?.equipamentos ?? [];
  const qtdInv = async (itemId) => (await inv()).find((i) => i.id === itemId)?.quantity ?? null;
  const qtdItemPorNome = async (name) => (await inv()).filter((i) => i.name === name).reduce((s, i) => s + i.quantity, 0);

  // ===== 1. Equipar 1 de 5 =====
  sec("Equipar separa exatamente 1 unidade");
  const item5 = await novoItem("Espada", 5);
  t("item criado com qtd 5", (await qtdInv(item5)) === 5);
  const eq1 = await req(BASE, "POST", `/characters/${charId}/inventario/${item5}/equipar`, { cookie, body: {} });
  t("equipar → 201", eq1.status === 201, `status=${eq1.status} ${JSON.stringify(eq1.json).slice(0, 140)}`);
  t("inventário ficou com 4", (await qtdInv(item5)) === 4, `qtd=${await qtdInv(item5)}`);
  const listaEq = await eqs();
  t("1 equipamento criado equipado", listaEq.length === 1 && listaEq[0].equipped === true, JSON.stringify(listaEq.map((e) => e.name)));
  const eqId = eq1.json?.id;

  // ===== 2. Snapshot preserva dados =====
  sec("Snapshot do equipamento");
  {
    const eq = listaEq[0];
    t("nome/descrição preservados", eq.name === "Espada" && eq.description === "desc Espada", JSON.stringify({ n: eq.name, d: eq.description }));
    const snap = eq.data?.itemSnapshot;
    t("snapshot tem categoria/peso/valor", snap?.category === "teste" && snap?.weight === 1.5 && snap?.data?.valueCents === 999, JSON.stringify(snap).slice(0, 200));
  }

  // ===== 3. Desequipar devolve exatamente 1 =====
  sec("Desequipar devolve 1 unidade");
  {
    const r = await req(BASE, "POST", `/characters/${charId}/equipamentos/${eqId}/desequipar`, { cookie, body: {} });
    t("desequipar → 200", r.status === 200, `status=${r.status}`);
    t("inventário voltou a 5 (4+1, fundido na pilha)", (await qtdInv(item5)) === 5, `qtd=${await qtdInv(item5)}`);
    t("registro de equipamento removido", (await eqs()).length === 0, `eqs=${(await eqs()).length}`);
    t("sem duplicata: total de 'Espada' no inventário = 5", (await qtdItemPorNome("Espada")) === 5);
  }

  // ===== 4. Re-equipar sem duplicação =====
  sec("Re-equipar");
  {
    const r = await req(BASE, "POST", `/characters/${charId}/inventario/${item5}/equipar`, { cookie, body: {} });
    t("re-equipar → 201", r.status === 201);
    t("inventário 5→4 novamente", (await qtdInv(item5)) === 4);
    t("exatamente 1 equipamento", (await eqs()).length === 1);
  }

  // ===== 5. Dois cliques / requestId duplicado =====
  sec("Idempotência do equipar");
  {
    const rid = `eq-${crypto.randomUUID()}`;
    const itemSolo = await novoItem("Anel", 1);
    const [r1, r2] = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/inventario/${itemSolo}/equipar`, { cookie, body: { requestId: rid } }),
      req(BASE, "POST", `/characters/${charId}/inventario/${itemSolo}/equipar`, { cookie, body: { requestId: rid } }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    t("mesmo requestId → 201 + 200(dedup)", (statuses[0] === 200 || statuses[0] === 201) && statuses[1] <= 201, statuses.join(","));
    t("inventário do Anel zerado (item removido)", (await qtdItemPorNome("Anel")) === 0, `total=${await qtdItemPorNome("Anel")}`);
    const eqsAnel = (await eqs()).filter((e) => e.name === "Anel");
    t("exatamente 1 equipamento 'Anel'", eqsAnel.length === 1, `n=${eqsAnel.length}`);

    // sem requestId: duas chamadas simultâneas na última unidade → só 1 vence
    const itemUnico = await novoItem("Poção única", 1);
    const [s1, s2] = await Promise.all([
      req(BASE, "POST", `/characters/${charId}/inventario/${itemUnico}/equipar`, { cookie, body: {} }),
      req(BASE, "POST", `/characters/${charId}/inventario/${itemUnico}/equipar`, { cookie, body: {} }),
    ]);
    const oks = [s1.status, s2.status].filter((s) => s === 201).length;
    t("duas equipagens simultâneas na última unidade → só 1 sucesso", oks === 1, [s1.status, s2.status].join(","));
    t("nenhuma unidade criada do nada", (await qtdItemPorNome("Poção única")) === 0);
  }

  // ===== 6. Transferir / excluir item com equipamento vinculado =====
  sec("Proteções de item vinculado");
  {
    // item5 tem 4 no inventário e 1 equipado (vinculado à pilha)
    const destino = crypto.randomUUID();
    {
      const w = new Database(BANCO);
      const agora = Date.now();
      const cid2 = cid;
      w.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(destino, cid2, memb.id, "PJ Destino", "{}", "{}", "aprovada", 0, agora, agora);
      w.close();
    }
    const tr = await req(BASE, "POST", `/characters/${charId}/inventario/${item5}/transferir`, {
      cookie, body: { destinoCharacterId: destino, quantidade: 1 },
    });
    t("transferir pilha c/ equipamento vinculado → 409", tr.status === 409, `status=${tr.status} ${JSON.stringify(tr.json).slice(0, 120)}`);
    const del = await req(BASE, "DELETE", `/characters/${charId}/inventario/${item5}`, { cookie });
    t("excluir pilha c/ equipamento vinculado → 409", del.status === 409, `status=${del.status}`);
    t("pilha intacta (4 unidades)", (await qtdInv(item5)) === 4);
  }

  // ===== 7. Excluir equipamento devolve unidade =====
  sec("Excluir equipamento devolve ao inventário");
  {
    const eqAtual = (await eqs()).find((e) => e.name === "Espada");
    const r = await req(BASE, "DELETE", `/characters/${charId}/equipamentos/${eqAtual.id}`, { cookie });
    t("excluir equipamento → 200", r.status === 200, `status=${r.status}`);
    t("unidade voltou: 'Espada' total = 5", (await qtdItemPorNome("Espada")) === 5, `total=${await qtdItemPorNome("Espada")}`);
    t("nenhum equipamento restante", (await eqs()).filter((e) => e.name === "Espada").length === 0);
  }

  // ===== 8. Slot ocupado via PATCH =====
  sec("Slot ocupado");
  {
    // cria 2 equipamentos manuais e tenta colocar ambos no mesmo slot equipado
    await req(BASE, "POST", `/characters/${charId}/equipamentos`, { cookie, body: { name: "Capacete", slot: "cabeca", equipped: true } });
    const r2 = await req(BASE, "POST", `/characters/${charId}/equipamentos`, { cookie, body: { name: "Elmo", slot: "cabeca", equipped: true } });
    t("2º equipamento no mesmo slot → 409", r2.status === 409, `status=${r2.status}`);
    // PATCH movendo o 1º para slot ocupado por outro → 409
    const eqs2 = await eqs();
    const capacete = eqs2.find((e) => e.name === "Capacete");
    const patch = await req(BASE, "PATCH", `/characters/${charId}/equipamentos/${capacete.id}`, { cookie, body: { slot: "cabeca" } });
    t("PATCH no mesmo slot ocupado pelo próprio → ok", patch.status === 200, `status=${patch.status}`);
  }

  // ===== 9. Equipamento manual: excluir não devolve nada ao inventário =====
  sec("Equipamento manual");
  {
    const antes = (await qtdItemPorNome("Capacete"));
    const eqs3 = await eqs();
    const cap = eqs3.find((e) => e.name === "Capacete");
    await req(BASE, "DELETE", `/characters/${charId}/equipamentos/${cap.id}`, { cookie });
    t("excluir equipamento manual não cria item", (await qtdItemPorNome("Capacete")) === antes && antes === 0);
  }
} finally {
  proc?.kill();
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
