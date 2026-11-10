// Homologação integrada — equipamentos/inventário (PR #34), Etapa 2.
// Cenário mestre + jogador em banco isolado: pilha de 5, equipar/
// desequipar/excluir, equipamento manual, concorrência equip×transfer,
// consistência da ficha e persistência após reinício do servidor.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-homolog-equip";
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
async function req(base, metodo, path, { cookie, body } = {}) {
  const r = await fetch(base + "/api" + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie: cookie ?? "" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const qtdItem = async (base, cookie, charId, nome) => {
  const inv = (await req(base, "GET", `/characters/${charId}/inventario`, { cookie })).json?.itens ?? [];
  const it = inv.find((i) => i.name === nome);
  return it?.quantity ?? 0;
};
const totalItens = async (base, cookie, charId) => {
  const inv = (await req(base, "GET", `/characters/${charId}/inventario`, { cookie })).json?.itens ?? [];
  return inv.reduce((s, i) => s + (i.quantity ?? 0), 0);
};
const nEquip = async (base, cookie, charId) => {
  const eq = (await req(base, "GET", `/characters/${charId}/equipamentos`, { cookie })).json?.equipamentos ?? [];
  return eq.length;
};

// ---------- seed: mestre + jogador na campanha 'teste' ----------
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
    .run(charM, camp, membM, "Mestre PJ", "{}", "{}", "aprovada", 0, agora, agora);
  db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
    .run(charJ, camp, membJ, "Jogador PJ", "{}", "{}", "aprovada", 0, agora, agora);
  db.close();
  return { admin, jogador, camp, charM, charJ };
})();
console.log("seed:", ids);

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
const cm = sessao(ids.admin), cj = sessao(ids.jogador);
let proc;

async function novoItem(cookie, charId, nome, qtd) {
  const r = await req(BASE, "POST", `/characters/${charId}/inventario`, {
    cookie, body: { name: nome, quantity: qtd, category: "arma" },
  });
  return r.json?.id ?? r.json?.item?.id;
}

try {
  proc = subir(porta);
  await esperarSaudavel(BASE, proc);

  // ===== Jogador: pilha de 5 → equipar 1 =====
  sec("Jogador: pilha 5 → equipar 1");
  const lança = await novoItem(cj, ids.charJ, "Lança", 5);
  t("item criado com 5 unidades", !!lança);
  const eq1 = await req(BASE, "POST", `/characters/${ids.charJ}/inventario/${lança}/equipar`, { cookie: cj, body: { requestId: "eq-homolog-1" } });
  t("jogador equipar → 201", eq1.status === 201, `status=${eq1.status} ${JSON.stringify(eq1.json).slice(0, 140)}`);
  const eqId = eq1.json?.equipamento?.id ?? eq1.json?.id;
  t("inventário ficou com 4", (await qtdItem(BASE, cj, ids.charJ, "Lança")) === 4, `qtd=${await qtdItem(BASE, cj, ids.charJ, "Lança")}`);
  t("1 equipamento registrado", (await nEquip(BASE, cj, ids.charJ)) === 1);

  // ===== Mestre visualiza a ficha do jogador (consistência) =====
  sec("Mestre consulta inventário/equipamento do jogador");
  t("mestre vê 4 no inventário", (await qtdItem(BASE, cm, ids.charJ, "Lança")) === 4);
  t("mestre vê 1 equipamento", (await nEquip(BASE, cm, ids.charJ)) === 1);

  // ===== Jogador: desequipar → volta 1 =====
  sec("Jogador: desequipar");
  const des = await req(BASE, "POST", `/characters/${ids.charJ}/equipamentos/${eqId}/desequipar`, { cookie: cj, body: {} });
  t("desequipar → 200", des.status === 200, `status=${des.status}`);
  t("inventário voltou a 5", (await qtdItem(BASE, cj, ids.charJ, "Lança")) === 5, `qtd=${await qtdItem(BASE, cj, ids.charJ, "Lança")}`);
  t("0 equipamentos", (await nEquip(BASE, cj, ids.charJ)) === 0);

  // ===== Jogador: equipar; mestre: excluir equipamento =====
  sec("Jogador equipa / mestre exclui equipamento");
  const eq2 = await req(BASE, "POST", `/characters/${ids.charJ}/inventario/${lança}/equipar`, { cookie: cj, body: {} });
  const eqId2 = eq2.json?.equipamento?.id ?? eq2.json?.id;
  t("re-equipar → 201 e estoque 4", eq2.status === 201 && (await qtdItem(BASE, cj, ids.charJ, "Lança")) === 4);
  const del = await req(BASE, "DELETE", `/characters/${ids.charJ}/equipamentos/${eqId2}`, { cookie: cj });
  t("jogador DELETE → 403 (jogadorRemoveItens desligado)", del.status === 403, `status=${del.status}`);
  const delM = await req(BASE, "DELETE", `/characters/${ids.charJ}/equipamentos/${eqId2}`, { cookie: cm });
  t("mestre exclui equipamento → 200", delM.status === 200, `status=${delM.status}`);
  t("unidade devolvida (estoque 5)", (await qtdItem(BASE, cj, ids.charJ, "Lança")) === 5, `qtd=${await qtdItem(BASE, cj, ids.charJ, "Lança")}`);

  // ===== Equipamento manual não cria item =====
  sec("Equipamento manual");
  {
    const antes = await totalItens(BASE, cj, ids.charJ);
    const man = await req(BASE, "POST", `/characters/${ids.charJ}/equipamentos`, {
      cookie: cj, body: { name: "Anel", slot: "dedo", equipped: true, data: { origem: "inventario", inventoryEntryId: "fake", itemSnapshot: {}, requestId: "fake" } },
    });
    t("POST manual → 201", man.status === 201, `status=${man.status} ${JSON.stringify(man.json).slice(0, 120)}`);
    t("inventário não ganhou item", (await totalItens(BASE, cj, ids.charJ)) === antes, `total=${await totalItens(BASE, cj, ids.charJ)} antes=${antes}`);
    const eqs = (await req(BASE, "GET", `/characters/${ids.charJ}/equipamentos`, { cookie: cj })).json?.equipamentos ?? [];
    const anel = eqs.find((e) => e.name === "Anel");
    const dados = typeof anel?.data === "string" ? JSON.parse(anel.data) : anel?.data;
    t("procedência forjada removida", dados && !("origem" in dados) && !("inventoryEntryId" in dados) && !("itemSnapshot" in dados) && !("requestId" in dados), JSON.stringify(dados));
    await req(BASE, "DELETE", `/characters/${ids.charJ}/equipamentos/${anel.id}`, { cookie: cj });
    t("excluir equipamento manual NÃO devolve item", (await totalItens(BASE, cj, ids.charJ)) === antes);
  }

  // ===== Concorrência: equip × transfer na mesma pilha =====
  sec("Concorrência equip × transfer");
  {
    const arco = await novoItem(cj, ids.charJ, "Arco", 3);
    const destino = ids.charM; // mestre recebe unidade do jogador? transferir exige acesso ao destino — mestre na mesma campanha
    const eqAntes = await nEquip(BASE, cj, ids.charJ);
    const [eqR, trR] = await Promise.all([
      req(BASE, "POST", `/characters/${ids.charJ}/inventario/${arco}/equipar`, { cookie: cj, body: {} }),
      req(BASE, "POST", `/characters/${ids.charJ}/inventario/${arco}/transferir`, { cookie: cj, body: { destinoCharacterId: destino, quantidade: 1 } }),
    ]);
    const invDepois = await qtdItem(BASE, cj, ids.charJ, "Arco");
    const eqDepois = await nEquip(BASE, cj, ids.charJ);
    t("alguma operação venceu (201)", eqR.status === 201 || trR.status === 201, `eq=${eqR.status} tr=${trR.status}`);
    t("exatamente uma venceu", (eqR.status === 201) !== (trR.status === 201), `eq=${eqR.status} tr=${trR.status}`);
    t("estoque Arco = 2 em ambos os casos", invDepois === 2, `qtd=${invDepois}`);
    t("delta de equipamentos = 1 se equipar venceu, 0 se transfer venceu", eqDepois - eqAntes === (eqR.status === 201 ? 1 : 0), `delta=${eqDepois - eqAntes}`);
  }

  // ===== Persistência após reinício =====
  sec("Persistência após reinício");
  {
    // deixa um equipamento ativo antes de reiniciar
    const eqAtivo = await req(BASE, "POST", `/characters/${ids.charJ}/inventario/${lança}/equipar`, { cookie: cj, body: {} });
    t("equipar p/ restart → 201", eqAtivo.status === 201, `status=${eqAtivo.status}`);
    const estoqueAntes = await qtdItem(BASE, cj, ids.charJ, "Lança");
    const eqAntesRestart = await nEquip(BASE, cj, ids.charJ);
    proc.kill();
    await new Promise((r) => setTimeout(r, 800));
    proc = subir(porta);
    await esperarSaudavel(BASE, proc);
    t("estoque persiste após restart", (await qtdItem(BASE, cj, ids.charJ, "Lança")) === estoqueAntes, `qtd=${await qtdItem(BASE, cj, ids.charJ, "Lança")}`);
    t("equipamentos persistem após restart", (await nEquip(BASE, cj, ids.charJ)) === eqAntesRestart, `eq=${await nEquip(BASE, cj, ids.charJ)} antes=${eqAntesRestart}`);
    const eqs = (await req(BASE, "GET", `/characters/${ids.charJ}/equipamentos`, { cookie: cj })).json?.equipamentos ?? [];
    const lan = eqs.find((e) => {
      const d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      return d?.itemSnapshot?.name === "Lança";
    });
    const snap = lan?.data ? (typeof lan.data === "string" ? JSON.parse(lan.data) : lan.data) : null;
    t("snapshot do item preservado", snap?.origem === "inventario" && snap?.itemSnapshot?.name === "Lança", JSON.stringify(snap?.itemSnapshot?.name));
  }
} finally {
  proc?.kill();
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
