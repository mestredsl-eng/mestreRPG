// Issue #127 — vida (HP/vitalidade) nos tokens da Mesa Virtual via Socket.IO.
// Cobre: mestre/jogador/espectador, vidaCompartilhada off/on, névoa,
// tokens ocultos, NPC, personagem sem vínculo, não-vazamento de atributo
// privado pelo HP máximo/vitalidade, vtt_state sem vida persistida e
// sincronização autoritativa (mesa:vtt:sincronizar) após personagens:atualizados
// e regras:atualizadas. Banco 100% descartável.
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir, abrirDb, sessao,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("vtt-vida");
const BANCO = `${DIR}/teste.db`;
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc, ids, sid;
const sockets = [];
const ultVtt = new Map();
const cntVtt = new Map();

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  ultVtt.set(s, null); cntVtt.set(s, 0);
  s.on("mesa:vtt", (p) => { ultVtt.set(s, p?.vtt ?? null); cntVtt.set(s, (cntVtt.get(s) ?? 0) + 1); });
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p) => new Promise((r) => { const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000); s.emit(ev, p, (x) => { clearTimeout(to); r(x); }); });
const sincronizar = (s) => emitirCb(s, "mesa:vtt:sincronizar", { sessionId: sid });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarVtt(socket, timeout = 8000) {
  const ini = cntVtt.get(socket) ?? 0;
  const fim = Date.now() + timeout;
  while (Date.now() < fim) {
    if ((cntVtt.get(socket) ?? 0) > ini) return;
    await dormir(50);
  }
  throw new Error("timeout mesa:vtt");
}
const tok = (vtt, id) => (vtt?.tokens ?? []).find((x) => x.id === id);

function novoUsuario(banco, { username, role = null, permissions = {}, campId = null }) {
  const db = abrirDb(banco);
  try {
    const uid = crypto.randomUUID(), agora = Date.now();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, username, username, "x", agora, agora);
    let mid = null;
    if (role) {
      mid = crypto.randomUUID();
      db.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run(mid, campId ?? ids.camp, uid, role, "ativo", JSON.stringify(permissions), agora, agora, agora);
    }
    return { id: uid, membershipId: mid, cookie: sessao(banco, uid) };
  } finally { db.close(); }
}

const CFG = {
  hp: { habilitado: true, base: 100, porNivel: 10, semantico: "atributo", edicaoPor: "mestre" },
  vitalidade: {
    edicaoPor: "mestre",
    niveis: [
      { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
      { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
      { nome: "Debilitado", penalidadeDados: 2, bloqueiaAcoes: true },
    ],
  },
};

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "vd_j1", jogador2: "vd_j2" },
    config: CFG,
  });
  ids = { admin: c.adminId, j1: c.jogadores.jogador1.id, j2: c.jogadores.jogador2.id, camp: c.campId, cookieMestre: c.cookieMestre };
  const esp = novoUsuario(BANCO, { username: "vd_esp", role: "espectador", campId: ids.camp });

  // Personagens: PJ1 (j1), PJ2 (j2), NPC (membro do mestre, is_npc=1)
  // com campo "for" privado (override visibilidade=mestre) para provar
  // que o HP máximo não vaza atributo oculto. Vida semeada em data.__hp.
  const PJ1 = c.novoPersonagem(c.jogadores.jogador1.membershipId, "PJ Um", { __hp: { atual: 120, historico: [] }, __vitalidade: { nivel: 1, nivelManual: 1 } });
  const PJ2 = c.novoPersonagem(c.jogadores.jogador2.membershipId, "PJ Dois", { __hp: { atual: 80, historico: [] } });
  const PJNpc = c.novoPersonagem(c.membMestre, "NPC Goblin", { for: 8, __hp: { atual: 60, historico: [] }, __vitalidade: { nivel: 2, nivelManual: 2 } });
  {
    const db = abrirDb(BANCO);
    db.prepare("update characters set is_npc=1, overrides=? where id=?")
      .run(JSON.stringify({ for: { visibilidade: "mestre" } }), PJNpc);
    db.close();
  }

  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Mesa Vida" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid);

  const sM = conectar(ids.cookieMestre);
  const sA = conectar(c.jogadores.jogador1.cookie);
  const sB = conectar(c.jogadores.jogador2.cookie);
  const sE = conectar(esp.cookie);
  await Promise.all([pronto(sM), pronto(sA), pronto(sB), pronto(sE)]);
  const [rM, rA, rB, rE] = await Promise.all([
    emitirCb(sM, "mesa:entrar", { sessionId: sid }),
    emitirCb(sA, "mesa:entrar", { sessionId: sid }),
    emitirCb(sB, "mesa:entrar", { sessionId: sid }),
    emitirCb(sE, "mesa:entrar", { sessionId: sid }),
  ]);
  t("quatro participantes entram", rM?.ok && rA?.ok && rB?.ok && rE?.ok);

  // Tokens: PJ1, PJ2, NPC (visível), NPC oculto, token sem vínculo,
  // token só-userId (sem ficha).
  const pVtt = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  const criar = (id, extra) => emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id, nome: id, cor: "#123456", x: 0.5, y: 0.5, ...extra } });
  t("token PJ1 criado", (await criar("tkpj1-aa11", { personagemId: PJ1 })).ok === true);
  t("token PJ2 criado", (await criar("tkpj2-bb22", { personagemId: PJ2 })).ok === true);
  t("token NPC criado", (await criar("tknpc-cc33", { personagemId: PJNpc, oculto: false })).ok === true);
  t("token NPC oculto criado", (await criar("tknpco-dd44", { personagemId: PJNpc, oculto: true })).ok === true);
  t("token sem vínculo criado", (await criar("tksem-ee55", {})).ok === true);
  t("token só userId criado", (await criar("tkuser-ff66", { userId: ids.j2 })).ok === true);
  await pVtt;

  // ---------- A. vidaCompartilhada OFF (padrão) ----------
  sec("A. vidaCompartilhada desligada — vida só do próprio personagem");
  {
    const vM = ultVtt.get(sM), vA = ultVtt.get(sA), vB = ultVtt.get(sB), vE = ultVtt.get(sE);
    // mestre vê vida em todos os tokens com ficha (inclusive oculto? não —
    // oculto é filtrado só para não-mestres; mestre recebe tudo)
    t("mestre: vida no token PJ1", tok(vM, "tkpj1-aa11")?.vida?.hp?.maximo === 150 && tok(vM, "tkpj1-aa11")?.vida?.hp?.atual === 120, JSON.stringify(tok(vM, "tkpj1-aa11")?.vida));
    t("mestre: vida no token PJ2", tok(vM, "tkpj2-bb22")?.vida?.hp?.maximo === 150, JSON.stringify(tok(vM, "tkpj2-bb22")?.vida));
    t("mestre: vida no token NPC (for privado = 8 → 100+80=180)", tok(vM, "tknpc-cc33")?.vida?.hp?.maximo === 180, JSON.stringify(tok(vM, "tknpc-cc33")?.vida));
    t("mestre: vitalidade no token PJ1", tok(vM, "tkpj1-aa11")?.vida?.vitalidade?.nivel === 1);
    t("mestre: sem vida no token sem vínculo", tok(vM, "tksem-ee55")?.vida == null);
    t("mestre: sem vida no token só-userId", tok(vM, "tkuser-ff66")?.vida == null);

    // j1: vida só no próprio token
    t("j1: vida no próprio token", tok(vA, "tkpj1-aa11")?.vida?.hp?.atual === 120 && tok(vA, "tkpj1-aa11")?.vida?.hp?.maximo === 150);
    t("j1: SEM vida no token do j2", tok(vA, "tkpj2-bb22")?.vida == null, JSON.stringify(tok(vA, "tkpj2-bb22")?.vida));
    t("j1: token oculto do NPC nem é entregue", tok(vA, "tknpco-dd44") === undefined);
    t("j1: token NPC entregue", tok(vA, "tknpc-cc33") !== undefined);
    t("j1: NPC visível SEM vida (flag off)", tok(vA, "tknpc-cc33")?.vida == null, JSON.stringify(tok(vA, "tknpc-cc33")?.vida));
    t("j1: token sem vínculo presente mas sem vida", tok(vA, "tksem-ee55") !== undefined && tok(vA, "tksem-ee55")?.vida == null);

    // j2 idem (espelho)
    t("j2: vida no próprio token", tok(vB, "tkpj2-bb22")?.vida?.hp?.atual === 80);
    t("j2: SEM vida no token do j1", tok(vB, "tkpj1-aa11")?.vida == null);

    // espectador: nenhum token tem vida com flag off
    t("espectador: token visível mas SEM vida", tok(vE, "tkpj1-aa11") !== undefined && tok(vE, "tkpj1-aa11")?.vida == null);
    t("espectador: SEM vida no token do j1", tok(vE, "tkpj1-aa11")?.vida == null);
  }

  // ---------- B. vidaCompartilhada ON ----------
  sec("B. vidaCompartilhada ligada — vida em tokens visíveis, filtrada");
  {
    const rCfg = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: true } } });
    t("PUT config vtt.vidaCompartilhada=on", rCfg.status === 200, `status=${rCfg.status} ${JSON.stringify(rCfg.json).slice(0, 200)}`);
    // sincronização autoritativa reflete a nova config sem novo mesa:vtt
    const rSync = await sincronizar(sA);
    t("sincronizar j1 ok", rSync?.ok === true);
    const vA = rSync?.vtt;
    t("j1: vida no token do j2 (filtrada, campos todos visíveis)", tok(vA, "tkpj2-bb22")?.vida?.hp?.maximo === 150, JSON.stringify(tok(vA, "tkpj2-bb22")?.vida));
    // NPC: campo "for" é mestre-only → para j1 o HP máximo usa apenas os
    // campos visíveis: for ausente → nível 0 → 100 + 0 = 100 (não 180).
    t("j1: vida no NPC calculada sobre visão filtrada (max=100, não 180)",
      tok(vA, "tknpc-cc33")?.vida?.hp?.maximo === 100, JSON.stringify(tok(vA, "tknpc-cc33")?.vida));
    t("j1: vitalidade do NPC vem do estado público (nivelManual=2)", tok(vA, "tknpc-cc33")?.vida?.vitalidade?.nivel === 2, JSON.stringify(tok(vA, "tknpc-cc33")?.vida?.vitalidade));
    t("j1: token oculto continua não entregue", tok(vA, "tknpco-dd44") === undefined);
    const rSyncE = await sincronizar(sE);
    t("espectador: vida no token do j1 com flag on (filtrada, não é dono)", tok(rSyncE?.vtt, "tkpj1-aa11")?.vida?.hp?.maximo === 150 && tok(rSyncE?.vtt, "tkpj1-aa11")?.vida?.hp?.atual === 120, JSON.stringify(tok(rSyncE?.vtt, "tkpj1-aa11")?.vida));
    t("espectador: vida no NPC com flag on (filtrada)", tok(rSyncE?.vtt, "tknpc-cc33")?.vida?.hp?.maximo === 100, JSON.stringify(tok(rSyncE?.vtt, "tknpc-cc33")?.vida));
    t("espectador: SEM vida no token sem vínculo", tok(rSyncE?.vtt, "tksem-ee55")?.vida == null);
  }

  // ---------- C. atualização após personagens:atualizados ----------
  sec("C. HP alterado → mesa:vtt:sincronizar reflete sem mesa:vtt");
  {
    // mestre aplica dano de 10 no PJ1 via endpoint real (emite personagens:atualizados)
    const rHp = await req(BASE, "POST", `/characters/${PJ1}/hp`, { cookie: ids.cookieMestre, body: { acao: "dano", quantidade: 10, motivo: "teste vida vtt" } });
    t("POST /hp dano 10", rHp.status === 200, `status=${rHp.status} ${JSON.stringify(rHp.json).slice(0, 160)}`);
    await dormir(400); // socket entrega personagens:atualizados; cliente sincroniza sob demanda
    const rSync = await sincronizar(sA);
    t("j1: vida.atual atualizada (120→110)", tok(rSync?.vtt, "tkpj1-aa11")?.vida?.hp?.atual === 110, JSON.stringify(tok(rSync?.vtt, "tkpj1-aa11")?.vida));
    const rSyncB = await sincronizar(sB);
    t("j2 (flag on): vida do PJ1 atualizada também", tok(rSyncB?.vtt, "tkpj1-aa11")?.vida?.hp?.atual === 110);
  }

  // ---------- D. vtt_state nunca persiste vida ----------
  sec("D. Persistência — vida não vai para vtt_state");
  {
    const db = abrirDb(BANCO);
    const row = db.prepare("select vtt_state from sessions where id=?").get(sid);
    db.close();
    const estado = JSON.parse(typeof row?.vtt_state === "string" ? row.vtt_state : JSON.stringify(row?.vtt_state ?? {}));
    const tokens = estado?.tokens ?? [];
    t("nenhum token persistido tem campo vida", tokens.every((tk) => !("vida" in tk)), JSON.stringify(tokens[0]));
    t("tokens persistidos mantêm vínculos", tokens.some((tk) => tk.id === "tkpj1-aa11" && tk.personagemId === PJ1));
  }

  // ---------- E. flag off de novo — vida some no próximo sync ----------
  sec("E. Desligar compartilhada remove vida alheia no sync");
  {
    await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: false } } });
    const rSync = await sincronizar(sA);
    t("j1: vida no próprio token permanece", tok(rSync?.vtt, "tkpj1-aa11")?.vida?.hp?.atual === 110);
    t("j1: vida no token do j2 removida", tok(rSync?.vtt, "tkpj2-bb22")?.vida == null);
    t("j1: vida no NPC removida", tok(rSync?.vtt, "tknpc-cc33")?.vida == null);
    const rSyncM = await sincronizar(sM);
    t("mestre: vida permanece em todos", tok(rSyncM?.vtt, "tkpj2-bb22")?.vida?.hp?.maximo === 150 && tok(rSyncM?.vtt, "tknpc-cc33")?.vida?.hp?.maximo === 180);
  }

  // ---------- F. névoa: token fora da área revelada não entrega vida ----------
  sec("F. Névoa de guerra — token oculto pela névoa não vaza vida");
  {
    // Reveala só metade esquerda; PJ2 está em (0.9,0.9) — fora da névoa.
    const pNv = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
    const rNv = await emitirCb(sM, "mesa:vtt:nevoa", {
      sessionId: sid, acao: "revelar",
      traco: { raioX: 0.2, raioY: 0.2, pontos: [{ x: 0.3, y: 0.3 }] },
    });
    t("mestre revela traco", rNv?.ok === true, JSON.stringify(rNv).slice(0, 120));
    await pNv;
    // Com flag off, j1 não teria vida no PJ2 de qualquer forma — religa a
    // flag para isolar o efeito da névoa.
    await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: true } } });
    const rSync = await sincronizar(sA);
    const vA = rSync?.vtt;
    t("névoa: token PJ2 fora da área não é entregue a j1", tok(vA, "tkpj2-bb22") === undefined, `tokens=${(vA?.tokens ?? []).map((x) => x.id).join(",")}`);
    t("névoa: token PJ1 dentro da área mantém vida", tok(vA, "tkpj1-aa11")?.vida?.hp?.atual === 110);
    const rSyncM2 = await sincronizar(sM);
    t("mestre ignora névoa: vida no PJ2 continua", tok(rSyncM2?.vtt, "tkpj2-bb22")?.vida != null);
    // Desfaz a névoa para não afetar outras verificações.
    await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelarTudo" });
  }
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e?.stack ?? e).slice(0, 800));
} finally {
  for (const s of sockets) { try { s.close(); } catch { } }
  await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n==== vtt-vida: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
