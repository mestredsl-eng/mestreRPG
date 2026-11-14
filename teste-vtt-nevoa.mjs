// Mesa virtual Etapa 2 — névoa de guerra (backend): persistência, permissões,
// geometria, filtragem server-side por destinatário e ausência de vazamento
// em Socket.IO e HTTP. Banco 100% descartável.
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("mesa-nevoa");
const BANCO = `${DIR}/teste.db`;
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc, proc2, ids, sid, C;
const sockets = [];
const ultVtt = new Map();   // socket -> último payload mesa:vtt
const cntVtt = new Map();   // socket -> contador mesa:vtt
const msgsVtt = new Map();  // socket -> mensagens mesa:mensagem recebidas

function conectar(cookie, base = BASE) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(base, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  ultVtt.set(s, null); cntVtt.set(s, 0); msgsVtt.set(s, []);
  s.on("mesa:vtt", (p) => { ultVtt.set(s, p?.vtt ?? null); cntVtt.set(s, (cntVtt.get(s) ?? 0) + 1); });
  s.on("mesa:mensagem", (p) => msgsVtt.get(s)?.push(p));
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirUmaVez = (s, ev, p) => new Promise((r) => { const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000); s.emit(ev, p, (x) => { clearTimeout(to); r(x); }); });
// Rate limit Socket.IO (#68): aguarda retryAfterMs e repete. Rejeições de
// negócio (ok:false sem codigo) não são repetidas.
const emitirCb = async (s, ev, p) => {
  for (let i = 0; i < 5; i++) {
    const r = await emitirUmaVez(s, ev, p);
    if (r?.codigo !== "RATE_LIMITED") return r;
    await dormir(Math.min(r.retryAfterMs ?? 500, 2500) + 50);
  }
  return emitirUmaVez(s, ev, p);
};
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
const idsDe = (vtt) => (vtt?.tokens ?? []).map((x) => x.id).sort();
const temToken = (vtt, id) => (vtt?.tokens ?? []).some((x) => x.id === id);

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
const getHttp = (path, cookie) => req(BASE, "GET", path, { cookie }).then((r) => r.json ?? {}).catch(() => ({}));

// traco revelado cobrindo (0.5,0.5) raio 0.2 — contém (0.5,0.5) e (0.6,0.5), não (0.9,0.9)
const TRACO_A = { raioX: 0.2, raioY: 0.2, pontos: [{ x: 0.5, y: 0.5 }] };

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", d => process.stderr.write("[srv] "+d)); proc.stdout?.on("data", d => process.stderr.write("[srv] "+d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "nv_j1", jogador2: "nv_j2" } });
  C = c;
  ids = { admin: c.adminId, j1: c.jogadores.jogador1.id, j2: c.jogadores.jogador2.id, camp: c.campId, cookieMestre: c.cookieMestre };
  const esp = novoUsuario(BANCO, { username: "nv_esp", role: "espectador" });

  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Mesa Névoa" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid);

  const sM = conectar(ids.cookieMestre);
  const sA = conectar(c.jogadores.jogador1.cookie);   // Ana
  const sB = conectar(c.jogadores.jogador2.cookie);   // Bruno
  const sE = conectar(esp.cookie);
  await Promise.all([pronto(sM), pronto(sA), pronto(sB), pronto(sE)]);
  const [rM, rA, rB, rE] = await Promise.all([
    emitirCb(sM, "mesa:entrar", { sessionId: sid }),
    emitirCb(sA, "mesa:entrar", { sessionId: sid }),
    emitirCb(sB, "mesa:entrar", { sessionId: sid }),
    emitirCb(sE, "mesa:entrar", { sessionId: sid }),
  ]);
  t("quatro participantes entram", rM?.ok && rA?.ok && rB?.ok && rE?.ok);

  // ---------- A. sanitização / retrocompatibilidade ----------
  sec("A. Sanitização e retrocompatibilidade");
  t("sessão antiga sem nevoa → névoa desativada (mapa visível)",
    rA?.sessao?.vttState?.nevoa?.ativa === false && Array.isArray(rA?.sessao?.vttState?.nevoa?.revelados),
    JSON.stringify(rA?.sessao?.vttState?.nevoa));

  // tokens: A em (0.5,0.5) dono j1; B em (0.9,0.9) dono j2 — ambos fora de qualquer traço inicial
  const pCriar = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  const rTA = await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkocultoA1", nome: "TokA", cor: "#ff0000", x: 0.5, y: 0.5, userId: ids.j1 } });
  const rTB = await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkocultoB1", nome: "TokB", cor: "#00ff00", x: 0.9, y: 0.9, userId: ids.j2 } });
  t("mestre cria tokens A e B", rTA?.ok === true && rTB?.ok === true);
  await pCriar;
  t("névoa desativada: todos veem ambos os tokens",
    temToken(ultVtt.get(sA), "tkocultoA1") && temToken(ultVtt.get(sA), "tkocultoB1")
    && temToken(ultVtt.get(sE), "tkocultoA1") && temToken(ultVtt.get(sE), "tkocultoB1"));

  // ---------- B. permissões ----------
  sec("B. Permissões de mutação da névoa");
  const rNA = await emitirCb(sA, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: TRACO_A });
  const rNE = await emitirCb(sE, "mesa:vtt:nevoa", { sessionId: sid, acao: "ocultarTudo" });
  t("jogador não altera névoa", rNA?.ok === false && /mestre/i.test(rNA?.erro ?? ""), JSON.stringify(rNA));
  t("espectador não altera névoa", rNE?.ok === false && /mestre/i.test(rNE?.erro ?? ""), JSON.stringify(rNE));

  const pR1 = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  const rM1 = await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: TRACO_A });
  t("mestre revela traço", rM1?.ok === true && rM1?.vtt?.nevoa?.revelados?.length === 1
    && typeof rM1?.vtt?.nevoa?.revelados?.[0]?.id === "string", JSON.stringify(rM1).slice(0, 200));
  await pR1;

  const pR2 = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  const rM2 = await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "desfazer" });
  t("mestre desfaz último traço", rM2?.ok === true && rM2?.vtt?.nevoa?.revelados?.length === 0);
  await pR2;

  // re-revela para os testes de geometria/privacidade
  const pR3 = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: TRACO_A });
  await pR3;

  // validações de payload do traço
  const rInv1 = await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: { raioX: 0.2, raioY: 0.2, pontos: [{ x: -0.5, y: 0.5 }] } });
  const rInv2 = await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: { raioX: NaN, raioY: 0.2, pontos: [{ x: 0.5, y: 0.5 }] } });
  const rInv3 = await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: { raioX: 0.2, raioY: 0.2, pontos: [] } });
  const rInv4 = await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: { raioX: 0.2, raioY: 0.2, pontos: [{ x: 0.5, y: 0.5 }].concat(Array.from({ length: 200 }, (_, i) => ({ x: 0.1 + i * 0.001, y: 0.1 }))) } });
  t("coordenada negativa rejeitada", rInv1?.ok === false);
  t("raio NaN rejeitado", rInv2?.ok === false);
  t("traço vazio rejeitado", rInv3?.ok === false);
  t("pontos em excesso rejeitados", rInv4?.ok === false);
  const rAcao = await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "inventada" });
  t("ação inválida rejeitada", rAcao?.ok === false);

  // ---------- C/D. geometria + privacidade por destinatário ----------
  sec("C/D. Geometria e privacidade (payload real do socket)");
  // estado: nevoa ativa, 1 traço cobrindo (0.5,0.5). A visível; B oculta.
  const vM = ultVtt.get(sM), vA = ultVtt.get(sA), vB = ultVtt.get(sB), vE = ultVtt.get(sE);
  t("mestre recebe ambos os tokens", temToken(vM, "tkocultoA1") && temToken(vM, "tkocultoB1"));
  t("Ana recebe o próprio token oculto? não — A está revelada", temToken(vA, "tkocultoA1"));
  t("Ana NÃO recebe token B oculto", !temToken(vA, "tkocultoB1"), idsDe(vA).join(","));
  t("Bruno recebe próprio token B mesmo oculto (exceção)", temToken(vB, "tkocultoB1"));
  t("Bruno NÃO recebe A? A está revelada → recebe", temToken(vB, "tkocultoA1"));
  t("espectador recebe A revelado, não B", temToken(vE, "tkocultoA1") && !temToken(vE, "tkocultoB1"), idsDe(vE).join(","));
  t("payload de Ana não contém id nem posição de B",
    !JSON.stringify(vA).includes("tkocultoB1") && !JSON.stringify(vA.tokens).includes('"x":0.9'));

  // move B para dentro da área revelada → passa a ser visível a todos
  const pMvB = Promise.all([esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: "tkocultoB1", x: 0.55, y: 0.55 } });
  await pMvB;
  t("B revelado por movimento → Ana e espectador passam a ver",
    temToken(ultVtt.get(sA), "tkocultoB1") && temToken(ultVtt.get(sE), "tkocultoB1"));

  // move B de volta para área oculta → some para não-donos
  const pMvB2 = Promise.all([esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: "tkocultoB1", x: 0.9, y: 0.9 } });
  await pMvB2;
  t("B sai da área revelada → Ana e espectador deixam de ver; Bruno mantém",
    !temToken(ultVtt.get(sA), "tkocultoB1") && temToken(ultVtt.get(sB), "tkocultoB1") && !temToken(ultVtt.get(sE), "tkocultoB1"));

  // segundo traço = união de regiões: cobre (0.9,0.9)
  const pT2 = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: { raioX: 0.15, raioY: 0.15, pontos: [{ x: 0.9, y: 0.9 }] } });
  await pT2;
  t("união de traços: B agora visível a todos",
    temToken(ultVtt.get(sA), "tkocultoB1") && temToken(ultVtt.get(sE), "tkocultoB1"));

  // ocultarTudo → só tokens próprios permanecem para jogadores
  const pOc = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "ocultarTudo" });
  await pOc;
  t("ocultarTudo: mestre vê tudo; Ana só o seu; Bruno só o seu; espectador nenhum",
    temToken(ultVtt.get(sM), "tkocultoA1") && temToken(ultVtt.get(sM), "tkocultoB1")
    && idsDe(ultVtt.get(sA)).join() === "tkocultoA1"
    && idsDe(ultVtt.get(sB)).join() === "tkocultoB1"
    && idsDe(ultVtt.get(sE)).length === 0,
    `A=${idsDe(ultVtt.get(sA))} B=${idsDe(ultVtt.get(sB))} E=${idsDe(ultVtt.get(sE))}`);

  // revelarTudo → desativa névoa, todos veem tudo novamente
  const pRt = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelarTudo" });
  await pRt;
  t("revelarTudo desativa névoa: todos veem todos os tokens",
    ultVtt.get(sA)?.nevoa?.ativa === false && temToken(ultVtt.get(sE), "tkocultoA1") && temToken(ultVtt.get(sE), "tkocultoB1"));

  // ---------- E. vazamento em todos os caminhos ----------
  sec("E. Vazamento — ACKs e HTTP");
  // reativa névoa vazia para o estado mais restritivo
  const pOcE = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "ocultarTudo" });
  await pOcE;

  // ACK do mesa:vtt:token do jogador (move próprio token) não pode conter o token do outro
  const rMoveA = await emitirCb(sA, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: "tkocultoA1", x: 0.5, y: 0.5 } });
  t("ACK de mover (jogador) não contém token alheio oculto",
    rMoveA?.ok === true && !JSON.stringify(rMoveA?.vtt).includes("tkocultoB1"), JSON.stringify(rMoveA?.vtt?.tokens?.map((x) => x.id)));

  // ACK do mesa:entrar de um novo socket do espectador
  const sE2 = conectar(esp.cookie);
  await pronto(sE2);
  const rE2 = await emitirCb(sE2, "mesa:entrar", { sessionId: sid });
  const vttAckE = rE2?.sessao?.vttState;
  t("ACK mesa:entrar (espectador) sem tokens ocultos",
    rE2?.ok === true && !JSON.stringify(vttAckE).includes("tkocultoA1") && !JSON.stringify(vttAckE).includes("tkocultoB1"),
    JSON.stringify(vttAckE?.tokens));
  const rA2 = await emitirCb(sA, "mesa:entrar", { sessionId: sid }); // re-entrar p/ ACK fresco
  t("ACK mesa:entrar (jogador) contém só o próprio token oculto",
    JSON.stringify(rA2?.sessao?.vttState?.tokens?.map((x) => x.id)) === JSON.stringify(["tkocultoA1"]),
    JSON.stringify(rA2?.sessao?.vttState?.tokens?.map((x) => x.id)));

  // HTTP: listagem, detalhe, estado, histórico — para cada papel
  const httpChecks = [
    ["GET /sessoes", `/campaigns/${ids.camp}/sessoes`, [esp.cookie, c.jogadores.jogador1.cookie, c.jogadores.jogador2.cookie, ids.cookieMestre]],
    ["GET /sessoes/:id", `/campaigns/${ids.camp}/sessoes/${sid}`, [esp.cookie, c.jogadores.jogador1.cookie, c.jogadores.jogador2.cookie, ids.cookieMestre]],
    ["GET /sessoes/:id/estado", `/campaigns/${ids.camp}/sessoes/${sid}/estado`, [esp.cookie, c.jogadores.jogador1.cookie, c.jogadores.jogador2.cookie, ids.cookieMestre]],
    ["GET /sessoes/:id/historico", `/campaigns/${ids.camp}/sessoes/${sid}/historico`, [esp.cookie, c.jogadores.jogador1.cookie, c.jogadores.jogador2.cookie, ids.cookieMestre]],
  ];
  for (const [nome, path, cookies] of httpChecks) {
    const [jE, jA, jB, jM] = await Promise.all(cookies.map((ck) => getHttp(path, ck)));
    const txtE = JSON.stringify(jE ?? {}), txtA = JSON.stringify(jA ?? {}), txtB = JSON.stringify(jB ?? {}), txtM = JSON.stringify(jM ?? {});
    t(`${nome}: espectador sem tokens ocultos`, !txtE.includes("tkocultoA1") && !txtE.includes("tkocultoB1"), nome);
    t(`${nome}: Ana sem token de Bruno`, !txtA.includes("tkocultoB1"));
    t(`${nome}: Bruno sem token de Ana`, !txtB.includes("tkocultoA1"));
    t(`${nome}: mestre recebe estado completo`, txtM.includes("tkocultoA1") && txtM.includes("tkocultoB1"));
  }

  // ---------- F. revalidação de autorização ----------
  sec("F. Revalidação de membership/papel");
  // remove Ana da campanha → próximo broadcast não envia nada a ela
  const dbx = abrirDb(BANCO);
  dbx.prepare("update memberships set status='removido' where user_id=?").run(ids.j1);
  dbx.close();
  const cntAntes = cntVtt.get(sA) ?? 0;
  const pRem = Promise.all([esperarVtt(sM), esperarVtt(sB), esperarVtt(sE)]);
  await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: { raioX: 0.1, raioY: 0.1, pontos: [{ x: 0.2, y: 0.2 }] } });
  await pRem;
  await dormir(300);
  t("usuário removido não recebe mais broadcasts VTT", (cntVtt.get(sA) ?? 0) === cntAntes, `antes=${cntAntes} depois=${cntVtt.get(sA)}`);
  // restaura como jogador comum de outra campanha? recria membership ativa p/ próximos testes
  const dbx2 = abrirDb(BANCO);
  dbx2.prepare("update memberships set status='ativo', role='jogador' where user_id=? and campaign_id=?").run(ids.j1, ids.camp);
  dbx2.close();

  // alteração de papel: Bruno vira espectador → perde exceção de token próprio
  const dbx3 = abrirDb(BANCO);
  dbx3.prepare("update memberships set role='espectador' where user_id=? and campaign_id=?").run(ids.j2, ids.camp);
  dbx3.close();
  const pPapel = Promise.all([esperarVtt(sM), esperarVtt(sE)]);
  await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "ocultarTudo" });
  await pPapel;
  await dormir(300);
  const vB3 = ultVtt.get(sB);
  t("papel alterado p/ espectador: Bruno não recebe mais o próprio token oculto",
    !temToken(vB3, "tkocultoB1"), idsDe(vB3).join(","));
  // reverte papel
  const dbx4 = abrirDb(BANCO);
  dbx4.prepare("update memberships set role='jogador' where user_id=? and campaign_id=?").run(ids.j2, ids.camp);
  dbx4.close();

  // ---------- G. concorrência e persistência ----------
  sec("G. Concorrência e persistência");
  // operações concorrentes: névoa + movimento de token + mapa não se perdem
  const rConc = await Promise.all([
    emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: { raioX: 0.3, raioY: 0.3, pontos: [{ x: 0.7, y: 0.7 }] } }),
    emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: "tkocultoA1", x: 0.62, y: 0.62 } }),
    emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkconcorr1", nome: "Conc", cor: "#0000ff", x: 0.3, y: 0.3 } }),
  ]);
  t("três mutações concorrentes aceitas", rConc.every((r) => r?.ok === true), JSON.stringify(rConc.map((r) => r?.erro)));
  // estado persistido final (HTTP detalhe do mestre = visão completa)
  const detM = await getHttp(`/campaigns/${ids.camp}/sessoes/${sid}`, ids.cookieMestre);
  const vttFinal = typeof detM?.sessao?.vttState === "string" ? JSON.parse(detM.sessao.vttState) : detM?.sessao?.vttState;
  t("estado final preserva névoa + movimento + novo token",
    (vttFinal?.nevoa?.revelados?.length ?? 0) >= 1
    && vttFinal?.tokens?.some((x) => x.id === "tkocultoA1" && Math.abs(x.x - 0.62) < 1e-6)
    && vttFinal?.tokens?.some((x) => x.id === "tkconcorr1"),
    JSON.stringify(vttFinal).slice(0, 300));

  // reconexão: novo socket recebe estado filtrado correto
  const sA3 = conectar(c.jogadores.jogador1.cookie);
  await pronto(sA3);
  const rA3 = await emitirCb(sA3, "mesa:entrar", { sessionId: sid });
  const vttA3 = rA3?.sessao?.vttState;
  t("reconexão: estado filtrado por papel",
    rA3?.ok === true && Array.isArray(vttA3?.nevoa?.revelados) && vttA3.nevoa.ativa === true
    && vttA3.tokens.some((x) => x.id === "tkocultoA1"),
    JSON.stringify(vttA3?.tokens?.map((x) => x.id)));

  // restart do servidor: névoa e tokens persistem
  await encerrarServidor(proc);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", d => process.stderr.write("[srv] "+d)); proc.stdout?.on("data", d => process.stderr.write("[srv] "+d));
  await esperarSaudavel(BASE, proc);
  const sM2 = conectar(ids.cookieMestre);
  await pronto(sM2);
  const rM2r = await emitirCb(sM2, "mesa:entrar", { sessionId: sid });
  const vttR = rM2r?.sessao?.vttState;
  t("após restart: mestre vê névoa e tokens persistidos",
    rM2r?.ok === true && vttR?.nevoa?.ativa === true && (vttR?.nevoa?.revelados?.length ?? 0) >= 1
    && vttR?.tokens?.some((x) => x.id === "tkocultoA1") && vttR?.tokens?.some((x) => x.id === "tkconcorr1"),
    JSON.stringify(vttR).slice(0, 300));

  // ---------- H. auditoria: propriedade divergente e casos de borda ----------
  sec("H. Auditoria — dono efetivo divergente");
  // injeta tokens diretamente no vtt_state (validarVinculo bloquearia na API)
  const pidA = C.novoPersonagem(C.jogadores.jogador1.membershipId, "PJ Ana");
  const pidB = C.novoPersonagem(C.jogadores.jogador2.membershipId, "PJ Bruno");
  const dbH = abrirDb(BANCO);
  try {
    const row = dbH.prepare("select vtt_state from sessions where id=?").get(sid);
    const v = JSON.parse(row.vtt_state);
    v.tokens.push(
      { id: "tkdiverg1", nome: "Div", cor: "#111111", x: 0.02, y: 0.02, userId: ids.j1, personagemId: pidB, ativo: true }, // userId=A, pers=B → divergente
      { id: "tkcoerente", nome: "Coer", cor: "#222222", x: 0.02, y: 0.03, userId: ids.j1, personagemId: pidA, ativo: true },  // mesmo dono
      { id: "tkpersB", nome: "PersB", cor: "#333333", x: 0.02, y: 0.04, personagemId: pidB, ativo: true },                  // só personagem
      { id: "tksemDon", nome: "Sem", cor: "#444444", x: 0.02, y: 0.05, ativo: true },                                       // sem dono
    );
    dbH.prepare("update sessions set vtt_state=? where id=?").run(JSON.stringify(v), sid);
  } finally { dbH.close(); }
  // visões frescas via HTTP (mesmo helper do socket)
  const [hA, hB, hE, hM] = await Promise.all([
    getHttp(`/campaigns/${ids.camp}/sessoes/${sid}`, c.jogadores.jogador1.cookie),
    getHttp(`/campaigns/${ids.camp}/sessoes/${sid}`, c.jogadores.jogador2.cookie),
    getHttp(`/campaigns/${ids.camp}/sessoes/${sid}`, esp.cookie),
    getHttp(`/campaigns/${ids.camp}/sessoes/${sid}`, ids.cookieMestre),
  ]);
  const vt = (r) => { const s = typeof r?.sessao?.vttState === "string" ? JSON.parse(r.sessao.vttState) : r?.sessao?.vttState; return (s?.tokens ?? []).map((x) => x.id); };
  const idsA = vt(hA), idsB = vt(hB), idsE2 = vt(hE), idsM2 = vt(hM);
  t("divergente userId×personagem: Ana NÃO recebe exceção", !idsA.includes("tkdiverg1"), idsA.join(","));
  t("divergente userId×personagem: Bruno NÃO recebe exceção", !idsB.includes("tkdiverg1"), idsB.join(","));
  t("coerente userId+personagem do mesmo dono: Ana recebe", idsA.includes("tkcoerente"));
  t("só personagemId: Bruno recebe o seu", idsB.includes("tkpersB"));
  t("token sem dono verificável: ninguém recebe (exceto mestre)", !idsA.includes("tksemDon") && !idsB.includes("tksemDon") && !idsE2.includes("tksemDon"));
  t("mestre recebe todos os tokens injetados", ["tkdiverg1", "tkcoerente", "tkpersB", "tksemDon"].every((x) => idsM2.includes(x)), idsM2.join(","));

  // ---------- I. corrida de autorização em mesa:entrar ----------
  sec("I. mesa:entrar — revalidação final de autorização");
  // O servidor tem trava de instância única por banco: a corrida usa um
  // SEGUNDO banco + processo com barreira determinística de 400ms em
  // mesa:entrar (MESTRE_VTT_BARRIER_MS). A mutação de membership é
  // garantida dentro da janela entre a validação inicial e a final.
  const BANCO2 = `${DIR}/corrida.db`;
  const PORTA2 = await portaLivre();
  const BASE2 = `http://localhost:${PORTA2}`;
  await prepararBanco(BANCO2);
  proc2 = subirServidor(PORTA2, { banco: BANCO2, arquivos: `${DIR}/arq2`, backups: `${DIR}/bks2`, env: { MESTRE_VTT_BARRIER_MS: "400", MESTRE_VTT_NEVOA_BARRIER_MS: "600" } });
  proc2.stderr.on("data", d => process.stderr.write("[srv2] " + d)); proc2.stdout?.on("data", d => process.stderr.write("[srv2] " + d));
  await esperarSaudavel(BASE2, proc2);

  const c2 = await criarCenario(BASE2, BANCO2, { jogadores: { j1: "rc_j1", j2: "rc_j2" } });
  const camp2 = c2.campId;
  const esp2 = novoUsuario(BANCO2, { username: "rc_esp", role: "espectador", campId: camp2 });
  const cookieM2 = c2.cookieMestre;
  const j1c = c2.jogadores.j1, j2c = c2.jogadores.j2;
  const j1id = j1c.id, j2id = j2c.id;

  // sessão com névoa ativa e SEM traços: nada revelado.
  // tkrA (dono j1) e tkrB (dono j2) ficam ocultos para terceiros.
  const sess2 = await req(BASE2, "POST", `/campaigns/${camp2}/sessoes`, { cookie: cookieM2, body: { name: "Mesa Corrida" } });
  const sid2 = sess2.json?.sessao?.id ?? sess2.json?.id;
  t("sessão da corrida criada", !!sid2);
  const dbI = abrirDb(BANCO2);
  try {
    dbI.prepare("update sessions set vtt_state=? where id=?").run(JSON.stringify({
      mapa: null,
      tokens: [
        { id: "tkrA", nome: "RA", cor: "#ff0000", x: 0.5, y: 0.5, userId: j1id, ativo: true },
        { id: "tkrB", nome: "RB", cor: "#00ff00", x: 0.6, y: 0.6, userId: j2id, ativo: true },
      ],
      nevoa: { ativa: true, revelados: [] },
    }), sid2);
  } finally { dbI.close(); }

  const setVinculo = (userId, role, status = "ativo") => {
    const db = abrirDb(BANCO2);
    try { db.prepare("update memberships set role=?, status=? where campaign_id=? and user_id=?").run(role, status, camp2, userId); }
    finally { db.close(); }
  };
  const entrarComCorrida = async (cookie, mutar) => {
    const s = conectar(cookie, BASE2);
    await pronto(s);
    const pAck = emitirCb(s, "mesa:entrar", { sessionId: sid2 });
    await dormir(120); // dentro da barreira de 400ms
    if (mutar) await mutar();
    const ack = await pAck;
    let vtt = null;
    if (ack?.ok) { await esperarVtt(s, 5000).catch(() => {}); vtt = ultVtt.get(s); }
    else await dormir(300);
    return { s, ack, vtt };
  };
  const idsTok = (v) => (v?.tokens ?? []).map((x) => x.id).sort();

  // 1-3. entradas normais (sem mutação): papel e visão corretos
  const nM = await entrarComCorrida(cookieM2, null);
  t("corrida: mestre entra com estado completo",
    nM.ack?.ok === true && nM.ack?.papel === "mestre"
    && idsTok(nM.ack?.sessao?.vttState).join() === "tkrA,tkrB"
    && idsTok(nM.vtt).join() === "tkrA,tkrB",
    JSON.stringify({ papel: nM.ack?.papel, ack: nM.ack?.sessao?.vttState?.tokens?.length, emit: nM.vtt?.tokens?.length }));
  const nJ = await entrarComCorrida(j1c.cookie, null);
  t("corrida: jogador recebe só o próprio token oculto",
    nJ.ack?.ok === true && nJ.ack?.papel === "jogador"
    && idsTok(nJ.ack?.sessao?.vttState).join() === "tkrA"
    && idsTok(nJ.vtt).join() === "tkrA",
    JSON.stringify({ papel: nJ.ack?.papel, ack: nJ.ack?.sessao?.vttState?.tokens, emit: nJ.vtt?.tokens }));
  const nE = await entrarComCorrida(esp2.cookie, null);
  t("corrida: espectador não recebe tokens",
    nE.ack?.ok === true && nE.ack?.papel === "espectador"
    && idsTok(nE.ack?.sessao?.vttState).length === 0
    && idsTok(nE.vtt).length === 0,
    JSON.stringify({ papel: nE.ack?.papel }));
  t("corrida: ACK coerente com o emit mesa:vtt",
    JSON.stringify(idsTok(nJ.ack?.sessao?.vttState)) === JSON.stringify(idsTok(nJ.vtt)));

  // 4. mestre → jogador durante a entrada: visão final filtrada como jogador
  const rm1 = novoUsuario(BANCO2, { username: "race_m1", role: "mestre", campId: camp2 });
  const dJ = await entrarComCorrida(rm1.cookie, () => setVinculo(rm1.id, "jogador"));
  t("corrida: mestre→jogador recebe visão de jogador (sem tokens alheios)",
    dJ.ack?.ok === true && dJ.ack?.papel === "jogador"
    && idsTok(dJ.ack?.sessao?.vttState).length === 0
    && idsTok(dJ.vtt).length === 0,
    JSON.stringify({ papel: dJ.ack?.papel, ack: dJ.ack?.sessao?.vttState?.tokens, emit: dJ.vtt?.tokens }));

  // 5. mestre → espectador durante a entrada
  const rm2 = novoUsuario(BANCO2, { username: "race_m2", role: "mestre", campId: camp2 });
  const dE = await entrarComCorrida(rm2.cookie, () => setVinculo(rm2.id, "espectador"));
  t("corrida: mestre→espectador recebe visão de espectador",
    dE.ack?.ok === true && dE.ack?.papel === "espectador"
    && idsTok(dE.ack?.sessao?.vttState).length === 0
    && idsTok(dE.vtt).length === 0,
    JSON.stringify({ papel: dE.ack?.papel }));

  // 6. membership removida durante a entrada: rejeição sem VTT e fora da sala
  const rj = novoUsuario(BANCO2, { username: "race_j", role: "jogador", campId: camp2 });
  const rem = await entrarComCorrida(rj.cookie, () => setVinculo(rj.id, "jogador", "removido"));
  t("corrida: membership removida → ACK rejeitado",
    rem.ack?.ok === false && typeof rem.ack?.erro === "string" && rem.ack.erro.length > 0,
    JSON.stringify(rem.ack));
  t("corrida: removido não recebeu mesa:vtt",
    (cntVtt.get(rem.s) ?? 0) === 0 && ultVtt.get(rem.s) === null);
  // presença de uma entrada posterior não pode listar o removido
  const posRem = await entrarComCorrida(j2c.cookie, null);
  t("corrida: removido não permanece na sala (presença)",
    posRem.ack?.ok === true && !(posRem.ack?.presenca ?? []).includes(rj.id),
    JSON.stringify(posRem.ack?.presenca));

  // 6b/6c. isolamento da sala: quem não concluiu a autorização final NÃO
  // pode receber NENHUM evento da sala — nem mensagem pública, nem VTT.
  // Um mestre já autorizado emite eventos durante a janela de entrada.
  const sM2c = conectar(cookieM2, BASE2);
  await pronto(sM2c);
  await emitirCb(sM2c, "mesa:entrar", { sessionId: sid2 });

  // 6b. membership removida durante a barreira + mensagem pública na janela
  const rj3 = novoUsuario(BANCO2, { username: "race_j3", role: "jogador", campId: camp2 });
  const sRJ = conectar(rj3.cookie, BASE2);
  await pronto(sRJ);
  const pAckRJ = emitirCb(sRJ, "mesa:entrar", { sessionId: sid2 });
  await dormir(120);
  await setVinculo(rj3.id, "jogador", "removido");
  // mensagem pública de membro autorizado, emitida ANTES do ingresso do sRJ
  sM2c.emit("mesa:mensagem", { sessionId: sid2, content: "ping-isolamento", visibilidade: "publica" });
  const ackRJ = await pAckRJ;
  await dormir(400);
  t("isolamento: removido na janela → ACK rejeitado",
    ackRJ?.ok === false, JSON.stringify(ackRJ));
  t("isolamento: removido na janela → zero mesa:vtt",
    (cntVtt.get(sRJ) ?? 0) === 0 && ultVtt.get(sRJ) === null);
  t("isolamento: removido na janela → zero mesa:mensagem (nem pública)",
    (msgsVtt.get(sRJ) ?? []).length === 0, JSON.stringify(msgsVtt.get(sRJ)));
  const posRJ = await entrarComCorrida(j2c.cookie, null);
  t("isolamento: removido não consta na presença",
    posRJ.ack?.ok === true && !(posRJ.ack?.presenca ?? []).includes(rj3.id),
    JSON.stringify(posRJ.ack?.presenca));

  // 6c. mestre rebaixado a jogador durante a janela: mensagem e mutação
  // VTT na janela não entregam dados de mestre; a entrada conclui filtrada
  const rm3 = novoUsuario(BANCO2, { username: "race_m3", role: "mestre", campId: camp2 });
  const sD3 = conectar(rm3.cookie, BASE2);
  await pronto(sD3);
  const pAckD3 = emitirCb(sD3, "mesa:entrar", { sessionId: sid2 });
  await dormir(120);
  await setVinculo(rm3.id, "jogador"); // rebaixa durante a barreira
  sM2c.emit("mesa:mensagem", { sessionId: sid2, content: "durante-janela", visibilidade: "publica" });
  const pVttM = esperarVtt(sM2c);
  const rVttM = await emitirCb(sM2c, "mesa:vtt:nevoa", { sessionId: sid2, acao: "revelar", traco: { raioX: 0.1, raioY: 0.1, pontos: [{ x: 0.15, y: 0.15 }] } });
  await pVttM;
  const ackD3 = await pAckD3;
  await dormir(300);
  t("isolamento: rebaixado conclui entrada como jogador",
    ackD3?.ok === true && ackD3?.papel === "jogador",
    JSON.stringify({ papel: ackD3?.papel, ok: ackD3?.ok }));
  t("isolamento: mensagem da janela não entregue ao rebaixado",
    !(msgsVtt.get(sD3) ?? []).some((m) => m?.content === "durante-janela"),
    JSON.stringify(msgsVtt.get(sD3)));
  t("isolamento: mesa:vtt do rebaixado é filtrado (sem tokens alheios)",
    idsTok(ackD3?.sessao?.vttState).length === 0 && idsTok(ultVtt.get(sD3)).length === 0,
    JSON.stringify({ ack: idsTok(ackD3?.sessao?.vttState), emit: idsTok(ultVtt.get(sD3)) }));
  t("isolamento: mutação do mestre na janela persistiu normalmente",
    rVttM?.ok === true, JSON.stringify(rVttM?.erro));

  // 6d. ordenação VTT: operação entra na fila imediatamente; a
  // sincronização posterior só responde depois que ela terminar e
  // reflete o estado pós-operação (barreira segura o lock 600ms)
  {
    const pOp = emitirCb(sM2c, "mesa:vtt:nevoa", { sessionId: sid2, acao: "revelar", traco: { raioX: 0.2, raioY: 0.2, pontos: [{ x: 0.3, y: 0.3 }] } })
      .then((r) => ({ r, t: Date.now() }));
    await dormir(150); // operação já está dentro da seção crítica (barreira)
    const pSync = emitirCb(sM2c, "mesa:vtt:nevoa:sincronizar", { sessionId: sid2 })
      .then((r) => ({ r, t: Date.now() }));
    const [op, sync] = await Promise.all([pOp, pSync]);
    const nOp = op.r?.vtt?.nevoa?.revelados?.length ?? -1;
    const nSync = sync.r?.vtt?.nevoa?.revelados?.length ?? -1;
    t("ordem: operação de névoa aplicada", op.r?.ok === true, JSON.stringify(op.r?.erro));
    t("ordem: sincronização autorizada com papel atual",
      sync.r?.ok === true && sync.r?.papel === "mestre", JSON.stringify(sync.r));
    t("ordem: sync respondeu depois da operação e com estado pós-op",
      sync.t >= op.t && nSync === nOp && nSync >= 1,
      JSON.stringify({ tOp: op.t, tSync: sync.t, nOp, nSync }));
  }

  // 7. sessão encerrada durante a entrada → rejeição (último: encerra sid2)
  const rj2 = novoUsuario(BANCO2, { username: "race_j2", role: "jogador", campId: camp2 });
  const enc = await entrarComCorrida(rj2.cookie, () => {
    const dbx = abrirDb(BANCO2);
    try { dbx.prepare("update sessions set status='encerrada' where id=?").run(sid2); }
    finally { dbx.close(); }
  });
  t("corrida: sessão encerrada durante entrada → ACK rejeitado",
    enc.ack?.ok === false && /encerrada/i.test(enc.ack?.erro ?? ""), JSON.stringify(enc.ack));

  await encerrarServidor(proc2); proc2 = null;

  // sessão encerrada rejeita mutação de névoa
  await req(BASE, "PATCH", `/campaigns/${ids.camp}/sessoes/${sid}`, { cookie: ids.cookieMestre, body: { status: "encerrada" } });
  const rFim = await emitirCb(sM2, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: TRACO_A });
  t("sessão encerrada rejeita mutação de névoa", rFim?.ok === false, JSON.stringify(rFim));
} catch (e) {
  fail++;
  console.error("FALHA INESPERADA:", e);
} finally {
  for (const s of sockets) { try { s.close(); } catch {} }
  try { await encerrarServidor(proc2); } catch {}
  try { await encerrarServidor(proc); } catch {}
  try { limparDir(DIR); } catch {}
}
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
