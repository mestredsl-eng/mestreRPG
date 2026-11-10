// Homologação E2E — Etapa 2 completa (Issue #33).
// Mestre + 2 jogadores em banco isolado: fichas, inventário/
// equipamento/transferência, HP e histórico, Vitalidade com motivo,
// compra/venda/PIX, reinício do servidor e persistência.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-etapa2-e2e";
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
const saldo = async (base, cookie, charId) => {
  const fin = (await req(base, "GET", `/characters/${charId}/financeiro`, { cookie })).json;
  return fin?.contas?.[0]?.saldo;
};

// ---------- seed: regras completas + ficha + 3 personagens ----------
const ids = (() => {
  const db = new Database(BANCO);
  const admin = db.prepare("select id from users where username='administrador'").get().id;
  const j1 = db.prepare("select id from users where username='fernandoqc_@hotmail.com'").get().id;
  // segundo jogador: cria usuário direto no banco isolado
  let j2 = db.prepare("select id from users where username='jogador2'").get()?.id;
  if (!j2) {
    j2 = crypto.randomUUID();
    const agora = Date.now();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,created_at,updated_at) values (?,?,?,?,0,?,?)")
      .run(j2, "jogador2", "Jogador Dois", "x", agora, agora);
  }
  const camp = db.prepare("select id from campaigns where name='teste'").get().id;
  const agora = Date.now();
  const memb = (uid, role) => {
    const ex = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(camp, uid)?.id;
    if (ex) return ex;
    const id = crypto.randomUUID();
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(id, camp, uid, role, "ativo", agora, agora);
    return id;
  };
  const mM = memb(admin, "mestre"), mJ1 = memb(j1, "jogador"), mJ2 = memb(j2, "jogador");

  // Regras da campanha: HP + Vitalidade + financeiro + patrimônio
  const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(camp);
  const cfg = JSON.parse(rs.config);
  cfg.hp = { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "ambos" };
  cfg.vitalidade = { edicaoPor: "ambos", niveis: [
    { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
    { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
    { nome: "Incapacitado", penalidadeDados: 0, bloqueiaAcoes: true },
  ] };
  cfg.financeiro = { ...cfg.financeiro, casasDecimais: 2, moedaPrincipal: "BRL", moedas: [{ codigo: "EUR", nome: "Euro" }] };
  cfg.patrimonio = { ...cfg.patrimonio, jogadorCriaContas: true, jogadorCompraVenda: true, jogadorPix: true };
  db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);

  // Ficha publicada com FOR (alimenta o HP)
  const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
  const estrutura = { versao: 1, secoes: [{ id: "s1", titulo: "Atributos", ordem: 0, campos: [{ id: "for", label: "FOR", tipo: "inteiro", semantico: "atributo" }] }], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } };
  db.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
    .run(tplId, camp, "Ficha E2E", null, admin, agora, agora);
  db.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
    .run(verId, tplId, JSON.stringify(estrutura), agora, agora);
  db.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);

  const novoChar = (membId, nome, extra = {}) => {
    const id = crypto.randomUUID();
    db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, camp, membId, verId, nome, JSON.stringify({ for: 5, ...extra }), "{}", "aprovada", 0, agora, agora);
    return id;
  };
  const charM = novoChar(mM, "Mestre Herói");
  const charJ1 = novoChar(mJ1, "Jogador Um");
  const charJ2 = novoChar(mJ2, "Jogador Dois");
  db.close();
  return { admin, j1, j2, camp, charM, charJ1, charJ2 };
})();
console.log("seed:", ids);

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
const cm = sessao(ids.admin), cj1 = sessao(ids.j1), cj2 = sessao(ids.j2);
let proc;

try {
  proc = subir(porta);
  await esperarSaudavel(BASE, proc);

  // ===== 1. Fichas: mestre vê os 3, jogadores veem a própria =====
  sec("Fichas e permissões de leitura");
  for (const [nome, cookie, cid, esperado] of [["mestre", cm, ids.charJ1, 200], ["jogador1", cj1, ids.charJ1, 200], ["jogador2", cj2, ids.charJ1, 403]]) {
    const r = await req(BASE, "GET", `/characters/${cid}`, { cookie });
    t(`${nome} lê ficha → ${esperado}`, r.status === esperado, `status=${r.status}`);
  }
  {
    const r = await req(BASE, "GET", `/characters/${ids.charJ1}`, { cookie: cj1 });
    t("jogador1 vê vida.hp na própria ficha", !!r.json?.ficha?.vida?.hp);
  }
  const invJ2 = await req(BASE, "GET", `/characters/${ids.charJ1}/inventario`, { cookie: cj2 });
  t("jogador2 NÃO acessa inventário do jogador1", invJ2.status === 403 || invJ2.status === 404, `status=${invJ2.status}`);

  // ===== 2. Inventário + equipamento + transferência =====
  sec("Inventário, equipamento e transferência");
  {
    const item = (await req(BASE, "POST", `/characters/${ids.charJ1}/inventario`, {
      cookie: cj1, body: { name: "Espada", quantity: 5, category: "arma" },
    })).json?.id;
    t("jogador1 cria item qtd5", !!item);
    const eq = await req(BASE, "POST", `/characters/${ids.charJ1}/inventario/${item}/equipar`, { cookie: cj1, body: {} });
    t("jogador1 equipa 1 → 201", eq.status === 201, `status=${eq.status}`);
    const inv = (await req(BASE, "GET", `/characters/${ids.charJ1}/inventario`, { cookie: cj1 })).json?.itens ?? [];
    t("estoque = 4", inv.find((i) => i.name === "Espada")?.quantity === 4);
    const tr = await req(BASE, "POST", `/characters/${ids.charJ1}/inventario/${item}/transferir`, {
      cookie: cj1, body: { destinoCharacterId: ids.charJ2, quantidade: 1 },
    });
    t("transferir pilha vinculada → 409", tr.status === 409, `status=${tr.status}`);
    const eqId = eq.json?.equipamento?.id ?? eq.json?.id;
    await req(BASE, "POST", `/characters/${ids.charJ1}/equipamentos/${eqId}/desequipar`, { cookie: cj1, body: {} });
    const tr2 = await req(BASE, "POST", `/characters/${ids.charJ1}/inventario/${item}/transferir`, {
      cookie: cj1, body: { destinoCharacterId: ids.charJ2, quantidade: 2 },
    });
    t("após desequipar, transferir 2 → 200", tr2.status === 200, `status=${tr2.status} ${JSON.stringify(tr2.json).slice(0, 100)}`);
    const inv2 = (await req(BASE, "GET", `/characters/${ids.charJ2}/inventario`, { cookie: cj2 })).json?.itens ?? [];
    t("jogador2 recebeu 2 Espadas", inv2.find((i) => i.name === "Espada")?.quantity === 2, JSON.stringify(inv2.map((i) => [i.name, i.quantity])));
    t("jogador1 ficou com 3", (await req(BASE, "GET", `/characters/${ids.charJ1}/inventario`, { cookie: cj1 })).json?.itens?.find((i) => i.name === "Espada")?.quantity === 3);
  }

  // ===== 3. HP: dano + recuperação + histórico =====
  sec("HP e histórico");
  {
    const dano = await req(BASE, "POST", `/characters/${ids.charJ1}/hp`, {
      cookie: cj1, body: { acao: "dano", quantidade: 30, motivo: "Golpe do goblin" },
    });
    t("jogador1 causa dano → 200", dano.status === 200, `status=${dano.status}`);
    t("HP 150→120", dano.json?.hp?.atual === 120, `atual=${dano.json?.hp?.atual}`);
    const rec = await req(BASE, "POST", `/characters/${ids.charJ1}/hp`, {
      cookie: cj1, body: { acao: "recuperar", quantidade: 10, motivo: "Descanso" },
    });
    t("recuperação → HP 130", rec.json?.hp?.atual === 130, `atual=${rec.json?.hp?.atual}`);
    const hist = rec.json?.hp?.historico ?? [];
    t("histórico HP ≥ 2 eventos reais", hist.length >= 2, `n=${hist.length}`);
    t("evento de dano tem motivo e autor", hist.some((e) => e.motivo === "Golpe do goblin" && e.autorId === ids.j1));
    // jogador2 não altera HP do jogador1
    const negado = await req(BASE, "POST", `/characters/${ids.charJ1}/hp`, {
      cookie: cj2, body: { acao: "dano", quantidade: 5 },
    });
    t("jogador2 não altera HP alheio", negado.status === 403 || negado.status === 404, `status=${negado.status}`);
  }

  // ===== 4. Vitalidade com motivo =====
  sec("Vitalidade e motivo");
  {
    const v = await req(BASE, "POST", `/characters/${ids.charM}/vitalidade`, {
      cookie: cm, body: { nivel: 1, motivo: "Ferimento em treino" },
    });
    t("mestre define vitalidade → 200", v.status === 200, `status=${v.status}`);
    t("nível 1 = Machucado", v.json?.vitalidade?.nome === "Machucado", v.json?.vitalidade?.nome);
    const ficha = (await req(BASE, "GET", `/characters/${ids.charM}`, { cookie: cm })).json?.ficha?.vida?.vitalidade;
    t("histórico de vitalidade gravado", ficha?.historico?.length === 1 && ficha.historico[0].motivo === "Ferimento em treino", JSON.stringify(ficha?.historico).slice(0, 150));
    t("evento tem nível anterior/novo", ficha?.historico?.[0]?.nivelAnterior === 0 && ficha?.historico?.[0]?.nivelNovo === 1);
    const v2 = await req(BASE, "POST", `/characters/${ids.charM}/vitalidade`, {
      cookie: cm, body: { nivel: 2 },
    });
    t("2ª mudança → histórico cresce", v2.json?.vitalidade?.historico?.length === 2, `n=${v2.json?.vitalidade?.historico?.length}`);
  }

  // ===== 5. Financeiro: compra, venda, PIX =====
  sec("Financeiro: compra/venda/PIX");
  {
    const contaJ1 = (await req(BASE, "POST", `/characters/${ids.charJ1}/financeiro/contas`, {
      cookie: cj1, body: { type: "especie", name: "Bolso", balanceReais: 100 },
    })).json?.id;
    const contaJ2 = (await req(BASE, "POST", `/characters/${ids.charJ2}/financeiro/contas`, {
      cookie: cj2, body: { type: "especie", name: "Poupança", balanceReais: 50 },
    })).json?.id;
    t("contas criadas", !!contaJ1 && !!contaJ2);

    const compra = await req(BASE, "POST", `/characters/${ids.charJ1}/financeiro/operacao`, {
      cookie: cj1, body: { tipo: "compra", accountId: contaJ1, valor: 30, item: { name: "Poção", quantity: 2 }, requestId: "e2e-compra-1" },
    });
    t("compra → 201", compra.status === 201, `status=${compra.status}`);
    t("saldo J1 = 70.00", (await saldo(BASE, cj1, ids.charJ1)) === 70, `saldo=${await saldo(BASE, cj1, ids.charJ1)}`);

    const itemPo = (await req(BASE, "GET", `/characters/${ids.charJ1}/inventario`, { cookie: cj1 })).json?.itens?.find((i) => i.name === "Poção");
    t("Poção entrou no inventário (qtd2)", itemPo?.quantity === 2, JSON.stringify(itemPo?.quantity));

    const venda = await req(BASE, "POST", `/characters/${ids.charJ1}/financeiro/operacao`, {
      cookie: cj1, body: { tipo: "venda", accountId: contaJ1, valor: 10, itemId: itemPo.id, quantidade: 1, requestId: "e2e-venda-1" },
    });
    t("venda parcial → 201", venda.status === 201, `status=${venda.status}`);
    t("saldo J1 = 80.00", (await saldo(BASE, cj1, ids.charJ1)) === 80, `saldo=${await saldo(BASE, cj1, ids.charJ1)}`);

    // PIX fictício J1 → J2 (jogador pode, config.jogadorPix)
    const pix = await req(BASE, "POST", `/characters/${ids.charJ1}/financeiro/transferir`, {
      cookie: cj1, body: { origemAccountId: contaJ1, destinoAccountId: contaJ2, valor: 25, descricao: "Divide do loot" },
    });
    t("PIX J1→J2 → 201", pix.status === 201, `status=${pix.status} ${JSON.stringify(pix.json).slice(0, 120)}`);
    t("saldo J1 = 55.00", (await saldo(BASE, cj1, ids.charJ1)) === 55, `saldo=${await saldo(BASE, cj1, ids.charJ1)}`);
    t("saldo J2 = 75.00", (await saldo(BASE, cj2, ids.charJ2)) === 75, `saldo=${await saldo(BASE, cj2, ids.charJ2)}`);

    // Venda acima do estoque → 400
    const over = await req(BASE, "POST", `/characters/${ids.charJ1}/financeiro/operacao`, {
      cookie: cj1, body: { tipo: "venda", accountId: contaJ1, valor: 10, itemId: itemPo.id, quantidade: 99 },
    });
    t("venda > estoque → 400", over.status === 400, `status=${over.status}`);
  }

  // ===== 6. Reinício e persistência =====
  sec("Reinício do servidor — persistência");
  {
    proc.kill();
    await new Promise((r) => setTimeout(r, 800));
    proc = subir(porta);
    await esperarSaudavel(BASE, proc);
    const ficha = (await req(BASE, "GET", `/characters/${ids.charJ1}`, { cookie: cj1 })).json?.ficha;
    t("HP persiste (130)", ficha?.vida?.hp?.atual === 130, `atual=${ficha?.vida?.hp?.atual}`);
    t("histórico HP persiste", (ficha?.vida?.hp?.historico?.length ?? 0) >= 2);
    const inv = (await req(BASE, "GET", `/characters/${ids.charJ1}/inventario`, { cookie: cj1 })).json?.itens ?? [];
    t("inventário persiste (Espada=3, Poção=1)", inv.find((i) => i.name === "Espada")?.quantity === 3 && inv.find((i) => i.name === "Poção")?.quantity === 1, JSON.stringify(inv.map((i) => [i.name, i.quantity])));
    const vit = (await req(BASE, "GET", `/characters/${ids.charM}`, { cookie: cm })).json?.ficha?.vida?.vitalidade;
    t("vitalidade persiste (nível 2, 2 eventos)", vit?.nivel === 2 && vit?.historico?.length === 2, `nivel=${vit?.nivel} hist=${vit?.historico?.length}`);
    t("saldos persistem", (await saldo(BASE, cj1, ids.charJ1)) === 55 && (await saldo(BASE, cj2, ids.charJ2)) === 75);
  }
} finally {
  proc?.kill();
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
