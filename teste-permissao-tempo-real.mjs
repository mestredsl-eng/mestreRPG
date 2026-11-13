// Mesa virtual — atualização de papel/status/permissões em tempo real.
// Prova que a notificação privada `mesa:permissao:atualizada` chega aos
// sockets do usuário afetado SEM reconexão, que a visão VTT é ressincronizada
// com o papel novo e que a revogação remove o socket das salas da sessão.
// Banco 100% descartável.
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import fs from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = dirTeste("mesa-perm-tempo-real");
const BANCO = `${DIR}/teste.db`;
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc, ids, sid, C;
const sockets = [];
const ultVtt = new Map();
const cntVtt = new Map();
const perms = new Map();   // socket -> eventos mesa:permissao:atualizada recebidos

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  ultVtt.set(s, null); cntVtt.set(s, 0); perms.set(s, []);
  s.on("mesa:vtt", (p) => { ultVtt.set(s, p?.vtt ?? null); cntVtt.set(s, (cntVtt.get(s) ?? 0) + 1); });
  s.on("mesa:permissao:atualizada", (p) => perms.get(s)?.push(p));
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p) => new Promise((r) => { const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000); s.emit(ev, p, (x) => { clearTimeout(to); r(x); }); });
const sincronizar = (s) => emitirCb(s, "mesa:vtt:nevoa:sincronizar", { sessionId: sid });
const tokensDe = (v) => (v?.tokens ?? []).map((x) => x.id).sort();
const ultimoPerm = (s) => perms.get(s)?.at(-1) ?? null;
const marcarPerm = (s) => perms.get(s)?.length ?? 0;
const esperarPerm = async (s, ini, n = 1, timeout = 5000) => {
  const fim = Date.now() + timeout;
  while (Date.now() < fim) {
    if ((perms.get(s)?.length ?? 0) >= ini + n) return perms.get(s).slice(ini);
    await dormir(40);
  }
  return null;
};
const esperarVtt = async (s, timeout = 8000) => {
  const ini = cntVtt.get(s) ?? 0;
  const fim = Date.now() + timeout;
  while (Date.now() < fim) {
    if ((cntVtt.get(s) ?? 0) > ini) return ultVtt.get(s);
    await dormir(40);
  }
  return null;
};

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

const patchMembro = (mid, body) =>
  req(BASE, "PATCH", `/campaigns/${ids.camp}/members/${mid}`, { cookie: ids.cookieMestre, body });

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks`, env: { MESTRE_RESTORE_DELAY_MS: "1200", MESTRE_PAUSA_FLAG: `${DIR}/pausa.flag`, MESTRE_PAUSA_MATCH: "PISR", MESTRE_FALHA_FLAG: `${DIR}/falha.flag` } });
  proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  proc.stdout?.on("data", (d) => process.stderr.write("[srv] " + d));
  await esperarSaudavel(BASE, proc);

  C = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "pt_j1", jogador2: "pt_j2" } });
  ids = { admin: C.adminId, j1: C.jogadores.jogador1.id, j1mid: C.jogadores.jogador1.membershipId, j2: C.jogadores.jogador2.id, j2mid: C.jogadores.jogador2.membershipId, camp: C.campId, cookieMestre: C.cookieMestre };
  const m2 = novoUsuario(BANCO, { username: "pt_m2", role: "mestre" });
  const esp = novoUsuario(BANCO, { username: "pt_esp", role: "espectador" });

  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Mesa Perm" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid);

  const sM = conectar(ids.cookieMestre);      // mestre titular
  const sM2 = conectar(m2.cookie);             // segundo mestre
  const sJ = conectar(C.jogadores.jogador1.cookie);
  const sJ2a = conectar(C.jogadores.jogador1.cookie); // segunda aba do MESMO usuário
  const sJ2 = conectar(C.jogadores.jogador2.cookie);
  const sE = conectar(esp.cookie);
  await Promise.all([pronto(sM), pronto(sM2), pronto(sJ), pronto(sJ2a), pronto(sJ2), pronto(sE)]);
  const idSockJ = sJ.id;
  const entradas = await Promise.all([
    emitirCb(sM, "mesa:entrar", { sessionId: sid }),
    emitirCb(sM2, "mesa:entrar", { sessionId: sid }),
    emitirCb(sJ, "mesa:entrar", { sessionId: sid }),
    emitirCb(sJ2a, "mesa:entrar", { sessionId: sid }),
    emitirCb(sJ2, "mesa:entrar", { sessionId: sid }),
    emitirCb(sE, "mesa:entrar", { sessionId: sid }),
  ]);
  t("seis sockets entram (mesma conexão será reutilizada)", entradas.every((r) => r?.ok === true));

  // tokens para provar filtragem posterior: A dono j1, B dono j2
  await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkA", nome: "TokA", cor: "#f00", x: 0.3, y: 0.3, userId: ids.j1 } });
  await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkB", nome: "TokB", cor: "#0f0", x: 0.7, y: 0.7, userId: ids.j2 } });
  await Promise.all([esperarVtt(sM), esperarVtt(sJ), esperarVtt(sJ2), esperarVtt(sE)]);

  // ---------- A. Jogador → Mestre, conectado ----------
  sec("A. Jogador → mestre em tempo real");
  const iniJ = marcarPerm(sJ), iniJ2 = marcarPerm(sJ2a), permsAntesM = marcarPerm(sM);
  const rPatchA = await patchMembro(ids.j1mid, { role: "mestre" });
  t("PATCH papel jogador→mestre", rPatchA.status === 200);
  const evA_J = await esperarPerm(sJ, iniJ);
  t("jogador recebeu mesa:permissao:atualizada (papel=mestre, status=ativo)",
    evA_J?.[0]?.papel === "mestre" && evA_J?.[0]?.status === "ativo" && evA_J?.[0]?.campaignId === ids.camp,
    JSON.stringify(evA_J?.[0]));
  const evA_J2 = await esperarPerm(sJ2a, iniJ2);
  t("SEGUNDA ABA do mesmo usuário recebeu a mesma notificação", evA_J2?.[0]?.papel === "mestre");
  t("mestre titular NÃO recebeu notificação do membro (canal privado)",
    marcarPerm(sM) === permsAntesM);
  const syncM = await sincronizar(sM);
  const syncA = await sincronizar(sJ);
  t("sync ordenada devolve papel=mestre e visão completa (idêntica à do mestre)",
    syncA?.ok === true && syncA?.papel === "mestre" &&
    JSON.stringify(tokensDe(syncA.vtt)) === JSON.stringify(tokensDe(syncM.vtt)),
    JSON.stringify({ papel: syncA?.papel, n: tokensDe(syncA?.vtt).length, nm: tokensDe(syncM?.vtt).length }));
  const rOpA = await emitirCb(sJ, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkJ", nome: "TokJ", cor: "#00f", x: 0.5, y: 0.5, userId: ids.j1 } });
  t("operação de mestre aceita após promoção (mesma conexão)", rOpA?.ok === true && sJ.id === idSockJ);

  // ---------- B. Mestre → Jogador, conectado ----------
  sec("B. Mestre → jogador em tempo real");
  const iniM2 = marcarPerm(sM2);
  const rPatchB = await patchMembro(m2.membershipId, { role: "jogador" });
  t("PATCH papel mestre→jogador", rPatchB.status === 200);
  const evB = await esperarPerm(sM2, iniM2);
  t("mestre rebaixado recebeu notificação (papel=jogador)", evB?.[0]?.papel === "jogador" && evB?.[0]?.status === "ativo");
  const syncB = await sincronizar(sM2);
  t("sync devolve papel=jogador", syncB?.ok === true && syncB?.papel === "jogador");
  const rOpB = await emitirCb(sM2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkX", nome: "X", cor: "#000", x: 0.1, y: 0.1, userId: m2.id } });
  t("operação de mestre RECUSADA após rebaixamento", rOpB?.ok !== true, JSON.stringify(rOpB));

  // ---------- C. Jogador → Espectador, conectado ----------
  sec("C. Jogador → espectador em tempo real");
  const iniJ2b = marcarPerm(sJ2);
  const rPatchC = await patchMembro(ids.j2mid, { role: "espectador" });
  t("PATCH papel jogador→espectador", rPatchC.status === 200);
  const evC = await esperarPerm(sJ2, iniJ2b);
  t("jogador recebeu notificação (papel=espectador)", evC?.[0]?.papel === "espectador");
  const syncC = await sincronizar(sJ2);
  t("sync devolve papel=espectador", syncC?.ok === true && syncC?.papel === "espectador");
  const rMsgC = await emitirCb(sJ2, "mesa:mensagem", { sessionId: sid, content: "oi", clientId: crypto.randomUUID() });
  t("chat recusado para espectador sem enviarMensagens", rMsgC?.ok !== true, JSON.stringify(rMsgC));
  const rOpC = await emitirCb(sJ2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkY", nome: "Y", cor: "#000", x: 0.2, y: 0.2, userId: ids.j2 } });
  t("operação de mestre recusada para espectador", rOpC?.ok !== true);

  // ---------- D. Remoção de membership — revogação em tempo real ----------
  sec("D. Membership removida — revogação sem reconexão");
  const iniDel = marcarPerm(sJ2);
  const rDel = await req(BASE, "DELETE", `/campaigns/${ids.camp}/members/${ids.j2mid}`, { cookie: ids.cookieMestre });
  t("DELETE membro", rDel.status === 200);
  const evD = await esperarPerm(sJ2, iniDel);
  t("notificação de revogação (status=removido) pelo canal privado",
    evD?.at(-1)?.status === "removido", JSON.stringify(evD?.at(-1)));
  const idSockApos = sJ2.id;
  // ação direta deve falhar: membership não está ativa
  const rMsgD = await emitirCb(sJ2, "mesa:mensagem", { sessionId: sid, content: "ainda aí?", clientId: crypto.randomUUID() });
  t("chat recusado após remoção", rMsgD?.ok !== true, JSON.stringify(rMsgD));
  const rEntrarD = await emitirCb(sJ2, "mesa:entrar", { sessionId: sid });
  t("re-entrada recusada após remoção", rEntrarD?.ok !== true, JSON.stringify(rEntrarD));
  // prova de que o socket SAIU da sala: broadcast VTT seguinte não chega
  const cntAntes = cntVtt.get(sJ2) ?? 0;
  await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkPos", nome: "Pos", cor: "#123", x: 0.9, y: 0.1, userId: ids.j1 } });
  await Promise.all([esperarVtt(sM), esperarVtt(sJ), esperarVtt(sE)]);
  await dormir(300);
  t("socket removido NÃO recebeu mesa:vtt da sala após revogação",
    (cntVtt.get(sJ2) ?? 0) === cntAntes, `cnt=${cntVtt.get(sJ2)}`);
  t("conexão Socket.IO preservada durante toda a revogação", sJ2.id === idSockApos && sJ2.connected);
  // ação de timer/turma também deve falhar (autorização por evento)
  const rTimerD = await emitirCb(sJ2, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 60 });
  t("timer recusado após remoção", rTimerD?.ok !== true, JSON.stringify(rTimerD));

  // ---------- E. Permissão individual enviarMensagens ----------
  sec("E. Permissão enviarMensagens em tempo real");
  const rMsgE0 = await emitirCb(sE, "mesa:mensagem", { sessionId: sid, content: "posso?", clientId: crypto.randomUUID() });
  t("espectador sem permissão: chat recusado", rMsgE0?.ok !== true);
  const iniE1 = marcarPerm(sE);
  const rPermE = await patchMembro(esp.membershipId, { permissions: { enviarMensagens: true } });
  t("PATCH permissões", rPermE.status === 200);
  const evE = await esperarPerm(sE, iniE1);
  t("notificação traz permissoes.enviarMensagens=true",
    evE?.at(-1)?.permissoes?.enviarMensagens === true && evE?.at(-1)?.papel === "espectador",
    JSON.stringify(evE?.at(-1)));
  const rMsgE1 = await emitirCb(sE, "mesa:mensagem", { sessionId: sid, content: "agora sim", clientId: crypto.randomUUID() });
  t("chat ACEITO após enviarMensagens=true (mesma conexão)", rMsgE1?.ok === true, JSON.stringify(rMsgE1));
  const iniE2 = marcarPerm(sE);
  await patchMembro(esp.membershipId, { permissions: { enviarMensagens: false } });
  await esperarPerm(sE, iniE2);
  const rMsgE2 = await emitirCb(sE, "mesa:mensagem", { sessionId: sid, content: "de novo não", clientId: crypto.randomUUID() });
  t("chat RECUSADO após enviarMensagens=false", rMsgE2?.ok !== true);

  // ---------- F. Mudanças rápidas + consistência final ----------
  sec("F. Duas mudanças rápidas + estado final");
  // j1 é mestre agora; rebaixa e promove em sequência rápida
  const iniF = marcarPerm(sJ);
  await patchMembro(ids.j1mid, { role: "jogador" });
  await patchMembro(ids.j1mid, { role: "mestre" });
  const evsF = await esperarPerm(sJ, iniF, 2);
  t("duas notificações recebidas em ordem", evsF?.length === 2 && evsF[0]?.papel === "jogador" && evsF[1]?.papel === "mestre",
    JSON.stringify(evsF?.map((e) => e?.papel)));
  const syncF = await sincronizar(sJ);
  const papelDb = abrirDb(BANCO).prepare("select role from memberships where id=?").get(ids.j1mid)?.role;
  t("sync final e banco concordam no papel", syncF?.papel === papelDb && papelDb === "mestre",
    `sync=${syncF?.papel} db=${papelDb}`);
  // sync emitida ANTES da mudança não pode ser usada para "voltar" papel:
  // toda resposta carrega o papel vigente no processamento do servidor
  const syncParalela = sincronizar(sM2);
  await patchMembro(ids.j1mid, { role: "espectador" });
  const syncParalelaR = await syncParalela;
  const syncFinal = await sincronizar(sJ);
  t("estado final = espectador (banco e sync)",
    syncFinal?.papel === "espectador" &&
    abrirDb(BANCO).prepare("select role from memberships where id=?").get(ids.j1mid)?.role === "espectador");
  t("sync paralela consistente (papel ∈ {anterior, novo}, nunca inventado)",
    ["jogador", "espectador", "mestre"].includes(syncParalelaR?.papel) || syncParalelaR?.ok === false);

  // ---------- G. Snapshot: membro ausente é revogado ----------
  sec("G. Restauração de snapshot revoga usuário ausente");
  // snapshot do estado ATUAL (ainda sem g1)
  const snap = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: ids.cookieMestre, body: { description: "pré-g1" } });
  const snapId = snap.json?.id;
  t("snapshot criado", snap.status === 201 && !!snapId, JSON.stringify(snap.json));
  // g1 entra DEPOIS do snapshot — não constará nele
  const g1 = novoUsuario(BANCO, { username: "pt_g1", role: "jogador" });
  const sG = conectar(g1.cookie);
  await pronto(sG);
  const rGEntrar = await emitirCb(sG, "mesa:entrar", { sessionId: sid });
  t("g1 entra na mesa", rGEntrar?.ok === true);
  const iniG = marcarPerm(sG);
  const rRest = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapId}/restaurar`, { cookie: ids.cookieMestre, body: { confirmacao: "RESTAURAR" } });
  t("snapshot restaurado", rRest.status === 200, JSON.stringify(rRest.json).slice(0, 120));
  const evG = await esperarPerm(sG, iniG);
  t("g1 ausente do snapshot: notificação de revogação (status=removido)",
    evG?.[0]?.status === "removido" && evG?.[0]?.campaignId === ids.camp, JSON.stringify(evG?.[0]));
  // prova de expulsão das salas: broadcast VTT seguinte não chega a g1
  const cntG = cntVtt.get(sG) ?? 0;
  await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkG", nome: "G", cor: "#999", x: 0.4, y: 0.4, userId: ids.j1 } });
  await Promise.all([esperarVtt(sM), esperarVtt(sJ)]);
  await dormir(300);
  t("g1 revogado NÃO recebeu mesa:vtt da sala", (cntVtt.get(sG) ?? 0) === cntG);
  const rMsgG = await emitirCb(sG, "mesa:mensagem", { sessionId: sid, content: "?", clientId: crypto.randomUUID() });
  t("g1 revogado: chat recusado", rMsgG?.ok !== true);
  const rEntrarG = await emitirCb(sG, "mesa:entrar", { sessionId: sid });
  t("g1 revogado: re-entrada recusada", rEntrarG?.ok !== true);
  // usuário mantido continua funcionando
  const syncJpos = await sincronizar(sJ);
  t("usuário mantido segue operando após restore", syncJpos?.ok === true);

  // ---------- G2. Snapshot: status restaurado é preservado na notificação ----------
  sec("G2. Restauração notifica status efetivo (pendente/bloqueado/removido)");
  // três usuários ATIVOS conectados e dentro da sala antes do snapshot:
  // uP→pendente, uB→bloqueado, uA→ausente do snapshot restaurado
  const uP = novoUsuario(BANCO, { username: "pt_pend", role: "jogador" });
  const uB = novoUsuario(BANCO, { username: "pt_bloq", role: "jogador" });
  const uA = novoUsuario(BANCO, { username: "pt_aus", role: "jogador" });
  const sP2 = conectar(uP.cookie), sB2 = conectar(uB.cookie), sA2 = conectar(uA.cookie);
  await Promise.all([pronto(sP2), pronto(sB2), pronto(sA2)]);
  const entG2 = await Promise.all([
    emitirCb(sP2, "mesa:entrar", { sessionId: sid }),
    emitirCb(sB2, "mesa:entrar", { sessionId: sid }),
    emitirCb(sA2, "mesa:entrar", { sessionId: sid }),
  ]);
  t("três usuários ativos entram na mesa", entG2.every((r) => r?.ok === true));
  const snapG2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: ids.cookieMestre, body: { description: "status-mistos" } });
  const snapG2Id = snapG2.json?.id;
  t("snapshot G2 criado", snapG2.status === 201 && !!snapG2Id, JSON.stringify(snapG2.json));
  // edita o pacote: uP pendente, uB bloqueado, uA removido das memberships
  const dbG2 = abrirDb(BANCO);
  const linhaG2 = dbG2.prepare("select data from snapshots where id=?").get(snapG2Id);
  const dadosG2 = JSON.parse(linhaG2.data);
  for (const m of dadosG2.memberships ?? []) {
    if (m.userId === uP.id) m.status = "pendente";
    if (m.userId === uB.id) m.status = "bloqueado";
    if (m.userId === uA.id) m.status = "removido"; // existe mas não-ativo
  }
  dadosG2.memberships = (dadosG2.memberships ?? []).filter((m) => m.userId !== uA.id); // ausente de vez
  dbG2.prepare("update snapshots set data=? where id=?").run(JSON.stringify(dadosG2), snapG2Id);
  dbG2.close();
  const iniP = marcarPerm(sP2), iniB = marcarPerm(sB2), iniA = marcarPerm(sA2);
  const rRestG2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapG2Id}/restaurar`, { cookie: ids.cookieMestre, body: { confirmacao: "RESTAURAR" } });
  t("restore G2 executado", rRestG2.status === 200, JSON.stringify(rRestG2.json).slice(0, 140));
  const evP = await esperarPerm(sP2, iniP), evBl = await esperarPerm(sB2, iniB), evA = await esperarPerm(sA2, iniA);
  t("pendente: notificação carrega status=pendente (não 'removido')",
    evP?.at(-1)?.status === "pendente", JSON.stringify(evP?.at(-1)));
  t("bloqueado: notificação carrega status=bloqueado (não 'removido')",
    evBl?.at(-1)?.status === "bloqueado", JSON.stringify(evBl?.at(-1)));
  t("ausente: notificação continua status=removido",
    evA?.at(-1)?.status === "removido", JSON.stringify(evA?.at(-1)));
  // expulsão das salas: broadcast VTT não chega a nenhum dos três
  const cntG2 = [sP2, sB2, sA2].map((s) => cntVtt.get(s) ?? 0);
  await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkG2", nome: "G2", cor: "#555", x: 0.5, y: 0.5, userId: ids.j1 } });
  await Promise.all([esperarVtt(sM), esperarVtt(sJ)]);
  await dormir(300);
  t("pendente/bloqueado/ausente: nenhum recebeu mesa:vtt pós-restore",
    [sP2, sB2, sA2].every((s, i) => (cntVtt.get(s) ?? 0) === cntG2[i]),
    JSON.stringify([sP2, sB2, sA2].map((s) => cntVtt.get(s))));
  // conexão Socket.IO preservada (só as salas foram expulsas)
  t("conexão Socket.IO preservada nos três sockets",
    sP2.connected === true && sB2.connected === true && sA2.connected === true);
  // status ≠ ativo não autoriza operação nem reentrada
  const rMsgP = await emitirCb(sP2, "mesa:mensagem", { sessionId: sid, content: "?", clientId: crypto.randomUUID() });
  const rEntP = await emitirCb(sP2, "mesa:entrar", { sessionId: sid });
  const rEntB = await emitirCb(sB2, "mesa:entrar", { sessionId: sid });
  t("pendente: chat e re-entrada recusados", rMsgP?.ok !== true && rEntP?.ok !== true, JSON.stringify([rMsgP, rEntP]));
  t("bloqueado: re-entrada recusada", rEntB?.ok !== true, JSON.stringify(rEntB));
  const rEntA = await emitirCb(sA2, "mesa:entrar", { sessionId: sid });
  t("ausente: re-entrada recusada", rEntA?.ok !== true, JSON.stringify(rEntA));

  // ---------- H. Importação modo substituir ----------
  sec("H. Importação substituir revoga ausentes e notifica alterados");
  // H1: pacote sem esp → revogação
  const exp1 = await req(BASE, "GET", `/campaigns/${ids.camp}/exportar`, { cookie: ids.cookieMestre });
  const pacote1 = exp1.json;
  const iniEspH = marcarPerm(sE);
  pacote1.estado.memberships = (pacote1.estado.memberships ?? []).filter((m) => m.userId !== esp.id);
  const rImp1 = await req(BASE, "POST", "/campaigns/importar", {
    cookie: ids.cookieMestre,
    body: { pacote: pacote1, modo: "substituir", campaignId: ids.camp, confirmacao: "SUBSTITUIR" },
  });
  t("import substituir (sem espectador) aceito", rImp1.status === 200, JSON.stringify(rImp1.json).slice(0, 140));
  const evEspH = await esperarPerm(sE, iniEspH);
  t("espectador removido pelo pacote: revogação privada",
    evEspH?.[0]?.status === "removido", JSON.stringify(evEspH?.[0]));
  const cntEspH = cntVtt.get(sE) ?? 0;
  await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkH", nome: "H", cor: "#777", x: 0.6, y: 0.4, userId: ids.j1 } });
  await Promise.all([esperarVtt(sM)]);
  await dormir(300);
  t("espectador removido: sem eventos de sala após substituição", (cntVtt.get(sE) ?? 0) === cntEspH);

  // H2: pacote muda papel de m2 (jogador→espectador) → notificação real
  const exp2 = await req(BASE, "GET", `/campaigns/${ids.camp}/exportar`, { cookie: ids.cookieMestre });
  const pacote2 = exp2.json;
  const iniM2H = marcarPerm(sM2);
  for (const m of pacote2.estado.memberships ?? []) {
    if (m.userId === m2.id) { m.role = "espectador"; m.permissions = { enviarMensagens: true }; }
  }
  const rImp2 = await req(BASE, "POST", "/campaigns/importar", {
    cookie: ids.cookieMestre,
    body: { pacote: pacote2, modo: "substituir", campaignId: ids.camp, confirmacao: "SUBSTITUIR" },
  });
  t("import substituir (papel alterado) aceito", rImp2.status === 200, JSON.stringify(rImp2.json).slice(0, 140));
  const evM2H = await esperarPerm(sM2, iniM2H);
  const evM2h = evM2H?.at(-1);
  t("m2: evento reflete papel/permissões PERSISTIDOS do pacote",
    evM2h?.papel === "espectador" && evM2h?.permissoes?.enviarMensagens === true,
    JSON.stringify(evM2h));
  const syncM2H = await sincronizar(sM2);
  t("m2 sync confirma papel=espectador pós-import", syncM2H?.papel === "espectador");
  const rMsgM2H = await emitirCb(sM2, "mesa:mensagem", { sessionId: sid, content: "oi", clientId: crypto.randomUUID() });
  t("m2 espectador COM enviarMensagens=true: chat aceito", rMsgM2H?.ok === true, JSON.stringify(rMsgM2H));

  // ---------- I. Convite reativa permissões preservadas ----------
  sec("I. Aceite de convite informa permissões persistidas");
  // esp foi removido no H1 — recria membership removida com permissão
  // true (o aceite de convite deve preservá-la, não zerar)
  const dbEspI = abrirDb(BANCO);
  dbEspI.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), ids.camp, esp.id, "espectador", "removido",
      JSON.stringify({ enviarMensagens: true }), Date.now(), Date.now(), Date.now());
  dbEspI.close();
  const conv = await req(BASE, "POST", `/campaigns/${ids.camp}/invitations`, { cookie: ids.cookieMestre, body: { role: "espectador", requiresApproval: false } });
  const codigo = conv.json?.convite?.code;
  t("convite criado", conv.status === 201 && !!codigo);
  const iniEspI = marcarPerm(sE);
  const ace = await req(BASE, "POST", `/convites/${codigo}/aceitar`, { cookie: esp.cookie, body: {} });
  t("convite aceito (reativação)", ace.status === 201 || ace.status === 200, JSON.stringify(ace.json).slice(0, 120));
  const evEspI = await esperarPerm(sE, iniEspI);
  t("evento traz permissões REALMENTE persistidas (enviarMensagens=true)",
    evEspI?.at(-1)?.permissoes?.enviarMensagens === true && evEspI?.at(-1)?.status === "ativo",
    JSON.stringify(evEspI?.at(-1)));
  // socket re-entra para receber a sala de novo e enviar chat
  await emitirCb(sE, "mesa:entrar", { sessionId: sid });
  const rMsgEspI = await emitirCb(sE, "mesa:mensagem", { sessionId: sid, content: "voltei", clientId: crypto.randomUUID() });
  t("espectador reativado COM permissão: chat aceito", rMsgEspI?.ok === true, JSON.stringify(rMsgEspI));

  // ---------- J. Salas de sessão antigas limpas após substituição ----------
  sec("J. Snapshot substitui estado — salas antigas saem de TODOS os sockets");
  const sess2 = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Sala J" } });
  const sid2 = sess2.json?.sessao?.id ?? sess2.json?.id;
  t("sessão sid2 criada", !!sid2, JSON.stringify(sess2.json).slice(0, 120));
  // segunda aba do MESMO usuário esp + ambos entram na sessão sid2
  const sE2 = conectar(esp.cookie);
  await pronto(sE2);
  await emitirCb(sM, "mesa:entrar", { sessionId: sid2 });
  const rEntE = await emitirCb(sE, "mesa:entrar", { sessionId: sid2 });
  const rEntE2 = await emitirCb(sE2, "mesa:entrar", { sessionId: sid2 });
  t("mestre e 2 abas do esp entram em sid2", rEntE?.ok === true && rEntE2?.ok === true, `${JSON.stringify(rEntE)} ${JSON.stringify(rEntE2)}`);
  // entram também na sala de CAMPANHA — sem isso o assert de
  // campanha:restaurada não prova nada (socket fora da sala não recebe)
  for (const s of [sM, sE, sE2]) s.emit("entrar-campanha", ids.camp, () => undefined);
  await dormir(150);
  // contadores de eventos de sala/campanha nos sockets do esp —
  // filtrados pelo conteúdo marcador para ignorar o "entrou na mesa"
  // emitido de forma assíncrona logo após cada mesa:entrar
  let restE = 0, restE2 = 0, restM = 0, msgE = 0, msgE2 = 0, msgM = 0, timerE = 0, timerE2 = 0;
  sE.on("campanha:restaurada", () => restE++);
  sE2.on("campanha:restaurada", () => restE2++);
  sM.on("campanha:restaurada", () => restM++);
  sE.on("mesa:mensagem", (m) => { if (m?.content === "pos-restore") msgE++; });
  sE2.on("mesa:mensagem", (m) => { if (m?.content === "pos-restore") msgE2++; });
  sM.on("mesa:mensagem", (m) => { if (m?.content === "pos-restore") msgM++; });
  sE.on("mesa:timer", () => timerE++);
  sE2.on("mesa:timer", () => timerE2++);
  // snapshot do estado atual (inclui sid2 e a membership do esp)…
  const snapJ = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: ids.cookieMestre, body: { description: "sem-esp" } });
  const snapJId = snapJ.json?.id;
  t("snapshot p/ J criado", snapJ.status === 201 && !!snapJId);
  // …editado para NÃO conter o esp — a sessão sid2 PERMANECE no pacote,
  // então a sala sessao:sid2 continua existindo após a restauração:
  // se o socket do esp não sair dela, ele recebe os eventos abaixo.
  const dbJ = abrirDb(BANCO);
  const linhaJ = dbJ.prepare("select data from snapshots where id=?").get(snapJId);
  const dadosJ = JSON.parse(linhaJ.data);
  dadosJ.memberships = (dadosJ.memberships ?? []).filter((m) => m.userId !== esp.id);
  dbJ.prepare("update snapshots set data=? where id=?").run(JSON.stringify(dadosJ), snapJId);
  dbJ.close();
  const iniEJ = marcarPerm(sE), iniE2J = marcarPerm(sE2);
  const rRestJ = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapJId}/restaurar`, { cookie: ids.cookieMestre, body: { confirmacao: "RESTAURAR" } });
  t("restore J executado", rRestJ.status === 200, JSON.stringify(rRestJ.json).slice(0, 140));
  const evEJ = await esperarPerm(sE, iniEJ);
  const evE2J = await esperarPerm(sE2, iniE2J);
  t("esp (2 abas) notificado status=removido", evEJ?.at(-1)?.status === "removido" && evE2J?.at(-1)?.status === "removido",
    JSON.stringify([evEJ?.at(-1), evE2J?.at(-1)]));
  await dormir(300);
  // fora da sala campanha:* — não recebe o broadcast da própria restauração
  t("esp NÃO recebe campanha:restaurada (fora de campanha:*)", restE === 0 && restE2 === 0, `restE=${restE} restE2=${restE2}`);
  t("mestre recebe campanha:restaurada (controle)", restM >= 1, `restM=${restM}`);
  // fora de sessao:sid2 (sessão preservada no snapshot = sala ainda válida)
  const rMsgJ = await emitirCb(sM, "mesa:mensagem", { sessionId: sid2, content: "pos-restore", clientId: crypto.randomUUID() });
  t("mestre envia msg em sid2", rMsgJ?.ok === true);
  await emitirCb(sM, "mesa:timer", { sessionId: sid2, acao: "iniciar", duracaoSegundos: 30 });
  await dormir(300);
  t("esp NÃO recebe mesa:mensagem de sid2", msgE === 0 && msgE2 === 0, `msgE=${msgE} msgE2=${msgE2}`);
  t("esp NÃO recebe mesa:timer de sid2", timerE === 0 && timerE2 === 0, `timerE=${timerE} timerE2=${timerE2}`);
  t("mestre recebe a mensagem (controle)", msgM >= 1, `msgM=${msgM}`);
  t("sockets do esp seguem conectados (só saíram das salas)", sE.connected === true && sE2.connected === true);
  const rEntrarJ = await emitirCb(sE, "mesa:entrar", { sessionId: sid2 });
  t("re-entrada em sid2 rejeitada (membership removida)", rEntrarJ?.ok !== true, JSON.stringify(rEntrarJ));

  // ---------- K. Importação substituir limpa salas antigas ----------
  sec("K. Import substitui sessões — mesmo mecanismo de limpeza");
  // recria o esp como membro para o pacote exportado atual não falhar;
  // depois importa pacote SEM ele → revogação + saída das salas
  const dbK = abrirDb(BANCO);
  dbK.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), ids.camp, esp.id, "espectador", "ativo",
      JSON.stringify({ enviarMensagens: true }), Date.now(), Date.now(), Date.now());
  dbK.close();
  const sE3 = conectar(esp.cookie);
  await pronto(sE3);
  await emitirCb(sE3, "mesa:entrar", { sessionId: sid2 });
  sE3.emit("entrar-campanha", ids.camp, () => undefined);
  await dormir(150);
  let restE3 = 0, msgE3 = 0;
  sE3.on("campanha:restaurada", () => restE3++);
  sE3.on("mesa:mensagem", (m) => { if (m?.content === "pos-import") msgE3++; });
  // pacote = export atual, editado sem o esp
  const expK = await req(BASE, "GET", `/campaigns/${ids.camp}/exportar`, { cookie: ids.cookieMestre });
  t("export p/ K obtido", expK.status === 200, JSON.stringify(expK.json).slice(0, 100));
  const pacoteK = expK.json;
  pacoteK.estado.memberships = (pacoteK.estado.memberships ?? []).filter((m) => m.userId !== esp.id);
  const iniE3 = marcarPerm(sE3);
  const rImpK = await req(BASE, "POST", "/campaigns/importar", {
    cookie: ids.cookieMestre,
    body: { pacote: pacoteK, modo: "substituir", campaignId: ids.camp, confirmacao: "SUBSTITUIR" },
  });
  t("import K executado", rImpK.status === 200, JSON.stringify(rImpK.json).slice(0, 140));
  const evE3K = await esperarPerm(sE3, iniE3);
  t("esp notificado removido pela importação", evE3K?.at(-1)?.status === "removido", JSON.stringify(evE3K?.at(-1)));
  await dormir(300);
  t("esp fora de campanha:* após import (sem campanha:restaurada)", restE3 === 0, `restE3=${restE3}`);
  let msgM3 = 0;
  sM.on("mesa:mensagem", (m) => { if (m?.content === "pos-import") msgM3++; });
  await emitirCb(sM, "mesa:mensagem", { sessionId: sid2, content: "pos-import", clientId: crypto.randomUUID() });
  await dormir(300);
  t("esp não recebe eventos de sid2 após import", msgE3 === 0, `msgE3=${msgE3} controleM=${msgM3}`);

  // ---------- L. Barreira de restauração — janela sem eventos ----------
  sec("L. Barreira: nenhuma operação/entrega durante a substituição");
  // garante sM e sJ dentro das salas (campanha + sessão sid)
  for (const s of [sM, sJ]) {
    s.emit("entrar-campanha", ids.camp, () => undefined);
    await emitirCb(s, "mesa:entrar", { sessionId: sid });
  }
  await dormir(200);
  // contadores de QUALQUER evento de sala nos sockets do j1 (futuro revogado)
  let jMsg = 0, jVtt = 0, jTimer = 0, jTeste = 0;
  sJ.on("mesa:mensagem", () => jMsg++);
  sJ.on("mesa:vtt", () => jVtt++);
  sJ.on("mesa:timer", () => jTimer++);
  sJ.on("mesa:teste", () => jTeste++);
  const jMsg0 = jMsg, jVtt0 = jVtt, jTimer0 = jTimer, jTeste0 = jTeste;
  // snapshot SEM j1 — restore fica 1.2s na barreira (env de teste)
  const snapL = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: ids.cookieMestre, body: { description: "sem-j1-L" } });
  const snapLId = snapL.json?.id;
  t("snapshot p/ L criado", snapL.status === 201 && !!snapLId);
  const dbL = abrirDb(BANCO);
  const linhaL = dbL.prepare("select data from snapshots where id=?").get(snapLId);
  const dadosL = JSON.parse(linhaL.data);
  dadosL.memberships = (dadosL.memberships ?? []).filter((m) => m.userId !== ids.j1);
  dbL.prepare("update snapshots set data=? where id=?").run(JSON.stringify(dadosL), snapLId);
  dbL.close();
  // dispara restore SEM aguardar — a barreira segura 1.2s
  const pRestL = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapLId}/restaurar`, { cookie: ids.cookieMestre, body: { confirmacao: "RESTAURAR" } });
  await dormir(400); // dentro da janela da barreira
  // operações durante a janela: todas devem falhar/ser descartadas
  const rMsgL = await emitirCb(sJ, "mesa:mensagem", { sessionId: sid, content: "na janela", clientId: crypto.randomUUID() });
  t("janela: mensagem do revogado RECUSADA", rMsgL?.ok !== true, JSON.stringify(rMsgL));
  const rTimerL = await emitirCb(sM, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 30 });
  t("janela: timer RECUSADO", rTimerL?.ok !== true, JSON.stringify(rTimerL));
  const rVttL = await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkL", nome: "L", cor: "#111", x: 0.5, y: 0.5, userId: ids.j1 } });
  t("janela: mutação VTT RECUSADA", rVttL?.ok !== true, JSON.stringify(rVttL));
  const rEntrarL = await emitirCb(sJ, "mesa:entrar", { sessionId: sid });
  t("janela: mesa:entrar RECUSADO", rEntrarL?.ok !== true, JSON.stringify(rEntrarL));
  const rCampL = await new Promise((r) => sJ.emit("entrar-campanha", ids.camp, (ok) => r(ok)));
  t("janela: entrar-campanha RECUSADO", rCampL !== true, `ok=${rCampL}`);
  // operação assíncrona que já passou pela autorização antes da barreira:
  // emitida agora pode ter resolvido ctx antes — o guard de emissão deve
  // impedir a entrega durante a janela
  sM.emit("mesa:mensagem", { sessionId: sid, content: "in-flight", clientId: crypto.randomUUID() }, () => {});
  await dormir(400);
  const rRestL = await pRestL;
  t("restore L concluído", rRestL.status === 200, JSON.stringify(rRestL.json).slice(0, 140));
  // durante TODA a janela o revogado não recebeu nada de sala
  t("janela: zero eventos de sala entregues ao revogado",
    jMsg === jMsg0 && jVtt === jVtt0 && jTimer === jTimer0 && jTeste === jTeste0,
    `msg=${jMsg - jMsg0} vtt=${jVtt - jVtt0} timer=${jTimer - jTimer0} teste=${jTeste - jTeste0}`);
  // perm de revogação chega pelo canal privado (usuario:* preservada)
  // — pode já ter chegado durante a janela; captura o último estado
  await dormir(500); // dá tempo de eventos em voo chegarem
  t("revogado recebeu notificação privada (status=removido)",
    (perms.get(sJ) ?? []).at(-1)?.status === "removido", JSON.stringify((perms.get(sJ) ?? []).at(-1)));
  // pós-restore: membro mantido funciona; revogado não recebe nada
  const rMsgPosL = await emitirCb(sM, "mesa:mensagem", { sessionId: sid, content: "pos-barreira", clientId: crypto.randomUUID() });
  t("pós-barreira: mestre envia mensagem", rMsgPosL?.ok === true, JSON.stringify(rMsgPosL));
  await dormir(300);
  t("pós-barreira: revogado continua sem eventos", jMsg === jMsg0, `msg=${jMsg - jMsg0}`);
  const rEntrarPosL = await emitirCb(sJ, "mesa:entrar", { sessionId: sid });
  t("pós-barreira: re-entrada do revogado recusada", rEntrarPosL?.ok !== true);

  // ---------- M. Exclusividade: duas restaurações simultâneas ----------
  sec("M. Exclusividade de restauração — segunda recebe 409");
  // m3: mestre criado AGORA para não ser revogado por snapshots antigos
  // (m2 virou espectador na seção H; o titular já consumiu sua cota de
  // restaurações do rate limit — cota é por usuário)
  const m3 = novoUsuario(BANCO, { username: "pt_m3", role: "mestre" });
  const snapM1 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: ids.cookieMestre, body: { description: "M1" } });
  const idM1 = snapM1.json?.id;
  const snapM2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: ids.cookieMestre, body: { description: "M2" } });
  const idM2 = snapM2.json?.id;
  t("dois snapshots p/ M", snapM1.status === 201 && snapM2.status === 201 && !!idM1 && !!idM2);
  // dispara a PRIMEIRA sem aguardar — a barreira fica 1.2s (env de teste)
  const pM1 = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${idM1}/restaurar`, { cookie: m3.cookie, body: { confirmacao: "RESTAURAR" } });
  await dormir(300); // primeira já adquiriu a exclusividade
  const rM2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${idM2}/restaurar`, { cookie: m3.cookie, body: { confirmacao: "RESTAURAR" } });
  t("segunda restauração simultânea → HTTP 409", rM2.status === 409, `status=${rM2.status} ${JSON.stringify(rM2.json).slice(0, 140)}`);
  // a barreira da PRIMEIRA continua ativa e bloqueando ingressos
  const rCampM = await emitirCb(sM, "entrar-campanha", ids.camp);
  t("barreira da 1ª restauração segue bloqueando entrar-campanha", rCampM !== true, `ok=${JSON.stringify(rCampM)}`);
  const rM1 = await pM1;
  t("primeira restauração conclui 200", rM1.status === 200, JSON.stringify(rM1.json).slice(0, 140));
  // controle: mecanismo liberado — uma nova restauração funciona
  const snapM3 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: ids.cookieMestre, body: { description: "M3" } });
  const rM3 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapM3.json?.id}/restaurar`, { cookie: m3.cookie, body: { confirmacao: "RESTAURAR" } });
  t("controle: restauração posterior funciona (sem barreira órfã)", rM3.status === 200, `status=${rM3.status}`);
  const rCampPosM = await emitirCb(sM, "entrar-campanha", ids.camp);
  t("pós-M: entrar-campanha volta a funcionar", rCampPosM === true, `ok=${JSON.stringify(rCampPosM)}`);

  // ---------- N. Operação em voo pausada após autorização ----------
  sec("N. Operação em voo: pausa determinística → restore → cancelamento");
  const flagPausa = `${DIR}/pausa.flag`;
  const pausadoArq = `${flagPausa}.pausado`;
  const esperarPausa = async () => {
    const fim = Date.now() + 8000;
    while (Date.now() < fim) { if (fs.existsSync(pausadoArq)) return true; await dormir(40); }
    return false;
  };
  const esperarBarreira = async () => {
    // sM é membro ativo garantido: fora da barreira entrar-campanha
    // retorna true; durante a restauração retorna false
    const fim = Date.now() + 8000;
    while (Date.now() < fim) {
      const ok = await emitirCb(sM, "entrar-campanha", ids.camp);
      if (ok !== true) return true;
      await dormir(50);
    }
    return false;
  };
  let pMsgEv = 0, pRollEv = 0;
  for (const s of [sM, sM2, sJ2]) {
    s.on("mesa:mensagem", (m) => { if (String(m?.content ?? "").includes("PISR")) pMsgEv++; });
    s.on("mesa:rolagem", (r) => { if (String(r?.motivo ?? "").includes("PISR")) pRollEv++; });
  }

  // N1 — mensagem secreta: passa pela autorização, pausa ANTES da
  // mutação (dentro do lease de operação); restore drena o lease
  fs.writeFileSync(flagPausa, "1");
  fs.rmSync(pausadoArq, { force: true });
  const cbMsgN = emitirCb(sM, "mesa:mensagem", { sessionId: sid, content: "PISR-msg-secreta", visibilidade: "secreta", clientId: crypto.randomUUID() });
  t("N1: handler pausou após autorização, antes da mutação", await esperarPausa());
  // snapshot que remove j2 — revogação durante a janela
  const snapN = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: ids.cookieMestre, body: { description: "sem-j2-N" } });
  const idN = snapN.json?.id;
  const dbN0 = abrirDb(BANCO);
  const linhaN = dbN0.prepare("select data from snapshots where id=?").get(idN);
  const dadosN = JSON.parse(linhaN.data);
  dadosN.memberships = (dadosN.memberships ?? []).filter((m) => m.userId !== ids.j2);
  dbN0.prepare("update snapshots set data=? where id=?").run(JSON.stringify(dadosN), idN);
  dbN0.close();
  const pRestN = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${idN}/restaurar`, { cookie: m3.cookie, body: { confirmacao: "RESTAURAR" } });
  t("N1: restauração adquiriu a barreira (ingressos bloqueados)", await esperarBarreira());
  fs.rmSync(flagPausa, { force: true }); // retoma a operação pausada
  await cbMsgN;
  const rRestN = await pRestN;
  t("N1: restore concluído 200", rRestN.status === 200, JSON.stringify(rRestN.json).slice(0, 140));
  const dbN1 = abrirDb(BANCO);
  const temMsgPISR = dbN1.prepare("select count(*) c from chat_messages where content like '%PISR%'").get().c;
  dbN1.close();
  t("N1: mensagem em voo NÃO persistiu após o restore", temMsgPISR === 0, `rows=${temMsgPISR}`);
  await dormir(300);
  t("N1: nenhum evento PISR entregue aos sockets", pMsgEv === 0, `msg=${pMsgEv}`);
  const permN = (perms.get(sJ2) ?? []).at(-1);
  t("N1: j2 revogado pelo restore (notificação privada)", permN?.status === "removido", JSON.stringify(permN));

  // N2 — rolagem privada: pausa antes do insert(rolls); SEM lease —
  // a barreira o cancela pela revalidação imediatamente antes da mutação
  fs.writeFileSync(flagPausa, "1");
  fs.rmSync(pausadoArq, { force: true });
  const cbRollN = emitirCb(sM, "mesa:rolar", { sessionId: sid, dados: [{ sides: 20, count: 1 }], motivo: "PISR-roll", visibilidade: "privada" });
  t("N2: rolagem pausou após autorização", await esperarPausa());
  const snapN2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: ids.cookieMestre, body: { description: "N2" } });
  const pRestN2 = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapN2.json?.id}/restaurar`, { cookie: m3.cookie, body: { confirmacao: "RESTAURAR" } });
  t("N2: restauração adquiriu a barreira", await esperarBarreira());
  fs.rmSync(flagPausa, { force: true });
  await cbRollN;
  const rRestN2 = await pRestN2;
  t("N2: restore concluído 200", rRestN2.status === 200, JSON.stringify(rRestN2.json).slice(0, 140));
  const dbN2 = abrirDb(BANCO);
  const temRollPISR = dbN2.prepare("select count(*) c from rolls where reason like '%PISR%'").get().c;
  dbN2.close();
  t("N2: rolagem em voo NÃO persistiu após o restore", temRollPISR === 0, `rows=${temRollPISR}`);
  await dormir(300);
  t("N2: nenhum evento de rolagem PISR entregue", pRollEv === 0, `roll=${pRollEv}`);
  // limpa o gancho para não afetar execuções seguintes
  fs.rmSync(flagPausa, { force: true });
  fs.rmSync(pausadoArq, { force: true });

  // mestres extras: m3 esgotou a cota de restaurações (5/10min) —
  // rate limit é por usuário; novos mestres têm cota própria
  const m4 = novoUsuario(BANCO, { username: "pt_m4", role: "mestre" });
  const m5 = novoUsuario(BANCO, { username: "pt_m5", role: "mestre" });

  // ---------- O. Timeout de drenagem: restore aborta sem commit ----------
  sec("O. Drenagem >15s → HTTP 503, sem substituição, sem barreira órfã");
  fs.writeFileSync(flagPausa, "PISR-T");
  fs.rmSync(pausadoArq, { force: true });
  // operação com lease pausada DENTRO do handler (após autorização)
  const cbTO = emitirCb(sM, "mesa:mensagem", { sessionId: sid, content: "PISR-timeout", visibilidade: "publica", clientId: crypto.randomUUID() });
  t("O: operação pausou com lease ativo", await esperarPausa());
  const snapO = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m4.cookie, body: { description: "O" } });
  const pRestO = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapO.json?.id}/restaurar`, { cookie: m4.cookie, body: { confirmacao: "RESTAURAR" } });
  const rRestO = await pRestO; // aguarda ~15s de drenagem
  t("O: restore → HTTP 503 (timeout de drenagem)", rRestO.status === 503, `status=${rRestO.status} ${JSON.stringify(rRestO.json).slice(0, 140)}`);
  // a barreira própria foi liberada com segurança: operações voltam
  const rCampO = await emitirCb(sM, "entrar-campanha", ids.camp);
  t("O: após timeout, entrar-campanha volta a funcionar", rCampO === true, `ok=${JSON.stringify(rCampO)}`);
  // nenhuma substituição ocorreu: a operação pausada conclui normal
  fs.rmSync(flagPausa, { force: true });
  await cbTO;
  // cbTO estourou o timeout do emitirCb (8s) antes do resume — aguarda a
  // persistência real consultando o banco com polling curto
  let msgO = 0;
  for (let i = 0; i < 40 && msgO === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const dbO = abrirDb(BANCO);
    msgO = dbO.prepare("select count(*) c from chat_messages where content='PISR-timeout'").get().c;
    dbO.close();
  }
  t("O: operação em voo concluiu (estado não foi substituído)", msgO === 1, `rows=${msgO}`);
  // controle: nova restauração funciona depois da recuperação
  const snapO2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m4.cookie, body: { description: "O2" } });
  const rO2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapO2.json?.id}/restaurar`, { cookie: m4.cookie, body: { confirmacao: "RESTAURAR" } });
  t("O: restauração posterior funciona (sem barreira órfã)", rO2.status === 200, `status=${rO2.status}`);

  // ---------- P. Mutações com lease: VTT, timer e turno canceladas ----------
  sec("P. Lease em VTT/token, timer e turno — cancelamento pós-autorização");
  const snapP = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m5.cookie, body: { description: "P2" } });
  const idP = snapP.json?.id;

  // P1 — token VTT pausado antes do update(sessions.vttState)
  fs.writeFileSync(flagPausa, "PISR");
  fs.rmSync(pausadoArq, { force: true });
  const cbVttP = emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkP1", nome: "PISR-vtt", cor: "#123", x: 0.5, y: 0.5, userId: m4.id } });
  t("P1: VTT pausou após autorização", await esperarPausa());
  const pRestP1 = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${idP}/restaurar`, { cookie: m5.cookie, body: { confirmacao: "RESTAURAR" } });
  t("P1: barreira adquirida", await esperarBarreira());
  fs.rmSync(flagPausa, { force: true });
  const rVttP = await cbVttP;
  const rRestP1 = await pRestP1;
  t("P1: restore concluído 200", rRestP1.status === 200, `status=${rRestP1.status}`);
  const dbP1 = abrirDb(BANCO);
  const vttP = dbP1.prepare("select vtt_state from sessions where id=?").get(sid);
  dbP1.close();
  // id "tkP1" é rejeitado pelo regex do servidor (≥8 chars) → UUID;
  // o marcador persistido é o NOME "PISR-vtt"
  t("P1: token NÃO persistiu no estado final (sem PISR-vtt)", !(vttP?.vtt_state ?? "").includes("PISR-vtt"));
  // operação AUTORIZADA com lease completa o ciclo inteiro — o restore
  // espera por ela na drenagem e o snapshot prévio a contém
  t("P1: operação completou ciclo integral (ok:true)", rVttP?.ok === true, JSON.stringify(rVttP).slice(0, 120));
  const preIdP1 = rRestP1.json?.preSnapshotId;
  const dbP1b = abrirDb(BANCO);
  const preP1 = dbP1b.prepare("select data from snapshots where id=?").get(preIdP1);
  dbP1b.close();
  t("P1: snapshot prévio contém a escrita drenada (PISR-vtt)", (preP1?.data ?? "").includes("PISR-vtt"), `preId=${preIdP1} len=${(preP1?.data ?? "").length}`);

  // P2 — timer pausado antes do update(sessions.timerState)
  const snapP2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m5.cookie, body: { description: "P2" } });
  fs.writeFileSync(flagPausa, "PISR");
  fs.rmSync(pausadoArq, { force: true });
  const cbTimerP = emitirCb(sM, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 777, depuracao: "PISR" });
  t("P2: timer pausou após autorização", await esperarPausa());
  const pRestP2 = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapP2.json?.id}/restaurar`, { cookie: m5.cookie, body: { confirmacao: "RESTAURAR" } });
  t("P2: barreira adquirida", await esperarBarreira());
  fs.rmSync(flagPausa, { force: true });
  await cbTimerP;
  const rRestP2 = await pRestP2;
  t("P2: restore concluído 200", rRestP2.status === 200, `status=${rRestP2.status}`);
  const dbP2 = abrirDb(BANCO);
  const tsP = dbP2.prepare("select timer_state from sessions where id=?").get(sid);
  dbP2.close();
  t("P2: timer NÃO persistiu 777s", !(tsP?.timer_state ?? "").includes("777"), String(tsP?.timer_state).slice(0, 80));

  // P3 — turno pausado antes do update(turns.state)
  const snapP3 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: ids.cookieMestre, body: { description: "P3" } });
  fs.writeFileSync(flagPausa, "PISR");
  fs.rmSync(pausadoArq, { force: true });
  const cbTurnoP = emitirCb(sM, "mesa:turno", { sessionId: sid, acao: "iniciar", ordem: ["PISR-slot"], depuracao: "PISR" });
  t("P3: turno pausou após autorização", await esperarPausa());
  const pRestP3 = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapP3.json?.id}/restaurar`, { cookie: m5.cookie, body: { confirmacao: "RESTAURAR" } });
  t("P3: barreira adquirida", await esperarBarreira());
  fs.rmSync(flagPausa, { force: true });
  await cbTurnoP;
  const rRestP3 = await pRestP3;
  t("P3: restore concluído 200", rRestP3.status === 200, `status=${rRestP3.status}`);
  const dbP3 = abrirDb(BANCO);
  const trP = dbP3.prepare("select state from turns where session_id=?").get(sid);
  dbP3.close();
  t("P3: turno NÃO persistiu slot PISR", !(trP?.state ?? "").includes("PISR-slot"), String(trP?.state).slice(0, 80));
  fs.rmSync(flagPausa, { force: true });
  fs.rmSync(pausadoArq, { force: true });

  // mestres adicionais: cotas de restauração são por usuário (5/10min)
  const m6 = novoUsuario(BANCO, { username: "pt_m6", role: "mestre" });
  const m7 = novoUsuario(BANCO, { username: "pt_m7", role: "mestre" });
  const m8 = novoUsuario(BANCO, { username: "pt_m8", role: "mestre" });
  const m9 = novoUsuario(BANCO, { username: "pt_m9", role: "mestre" });
  const falhaFlag = `${DIR}/falha.flag`;
  const ultimoPreSnap = () => {
    const d = abrirDb(BANCO);
    const row = d.prepare("select data from snapshots where campaign_id=? and kind='pre_restauracao' order by created_at desc limit 1").get(ids.camp);
    d.close();
    return row?.data ?? "";
  };

  // ---------- Q. Aceite de convite sob lease + aceite durante barreira ----------
  sec("Q. Convite: aceite com lease é drenado; aceite na barreira → 409");
  const uConv = novoUsuario(BANCO, { username: "pt_conv" });
  const convQ = await req(BASE, "POST", `/campaigns/${ids.camp}/invitations`, { cookie: m6.cookie, body: { role: "jogador", requiresApproval: false } });
  const codQ = convQ.json?.convite?.code;
  t("Q: convite criado", !!codQ);
  fs.writeFileSync(flagPausa, "convite-aceitar");
  fs.rmSync(pausadoArq, { force: true });
  const pAceQ = req(BASE, "POST", `/convites/${codQ}/aceitar`, { cookie: uConv.cookie, body: {} });
  t("Q: aceite pausou DENTRO do lease", await esperarPausa());
  const snapQ = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m6.cookie, body: { description: "Q" } });
  const pRestQ = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapQ.json?.id}/restaurar`, { cookie: m6.cookie, body: { confirmacao: "RESTAURAR" } });
  const cedoQ = await Promise.race([pRestQ.then(() => "done"), dormir(2500).then(() => "pendente")]);
  t("Q: restore NÃO completou enquanto o aceite segurava o lease", cedoQ === "pendente", cedoQ);
  fs.rmSync(flagPausa, { force: true });
  const rAceQ = await pAceQ;
  const rRestQ = await pRestQ;
  t("Q: aceite concluiu 201 (ciclo completo sob lease)", rAceQ.status === 201, `status=${rAceQ.status}`);
  t("Q: restore concluiu 200 após a drenagem real", rRestQ.status === 200, `status=${rRestQ.status}`);
  // serialização: snapshot capturado antes do aceite → restore remove
  // a membership criada pelo aceite que já havia commitado
  const dbQ = abrirDb(BANCO);
  const memQ = dbQ.prepare("select count(*) c from memberships where campaign_id=? and user_id=?").get(ids.camp, uConv.id).c;
  dbQ.close();
  t("Q: restore substituiu estado pós-aceite (membership ausente)", memQ === 0, `rows=${memQ}`);

  // aceite durante a barreira → 409 sem escrita
  const uConv2 = novoUsuario(BANCO, { username: "pt_conv2" });
  const convQ2 = await req(BASE, "POST", `/campaigns/${ids.camp}/invitations`, { cookie: m7.cookie, body: { role: "jogador", requiresApproval: false } });
  const codQ2 = convQ2.json?.convite?.code;
  const snapQB = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m7.cookie, body: { description: "QB" } });
  const pRestQB = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapQB.json?.id}/restaurar`, { cookie: m7.cookie, body: { confirmacao: "RESTAURAR" } });
  await dormir(300); // barreira já ativa (delay de 1200ms em teste)
  const rAceB = await req(BASE, "POST", `/convites/${codQ2}/aceitar`, { cookie: uConv2.cookie, body: {} });
  t("Q2: aceite durante barreira → HTTP 409", rAceB.status === 409, `status=${rAceB.status}`);
  const dbQB = abrirDb(BANCO);
  const usesQB = dbQB.prepare("select uses from invitations order by rowid desc limit 1").get()?.uses;
  const memQB = dbQB.prepare("select count(*) c from memberships where campaign_id=? and user_id=?").get(ids.camp, uConv2.id).c;
  dbQB.close();
  t("Q2: aceite rejeitado não gravou membership", memQB === 0, `rows=${memQB}`);
  const rRestQB = await pRestQB;
  t("Q2: restore concluiu normalmente", rRestQB.status === 200, `status=${rRestQB.status}`);

  // ---------- R. Snapshot prévio capturado DEPOIS da drenagem ----------
  sec("R. Operação drenada aparece no snapshot pré-restauração");
  fs.writeFileSync(flagPausa, "PISR");
  fs.rmSync(pausadoArq, { force: true });
  const cbR = emitirCb(sM, "mesa:mensagem", { sessionId: sid, content: "PISR-CONS", visibilidade: "publica", clientId: crypto.randomUUID() });
  t("R: mensagem pausou com lease", await esperarPausa());
  const snapR = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m7.cookie, body: { description: "R" } });
  const pRestR = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapR.json?.id}/restaurar`, { cookie: m7.cookie, body: { confirmacao: "RESTAURAR" } });
  await esperarBarreira();
  await dormir(400); // restore drenando; operação ainda suspensa
  fs.rmSync(flagPausa, { force: true });
  await cbR; // operação completa e libera o lease
  const rRestR = await pRestR;
  t("R: restore 200 após drenagem", rRestR.status === 200, `status=${rRestR.status}`);
  t("R: snapshot prévio contém a operação drenada", ultimoPreSnap().includes("PISR-CONS"));

  // ---------- S. Falhas injetadas na inicialização e na recuperação ----------
  sec("S. Falha injetada — sem barreira órfã, recuperação retomável");
  const cenInit = [
    ["init-sessoes", m9.cookie], ["init-salas", m8.cookie], ["init-evacuar", m6.cookie],
  ];
  for (const [ponto, cookieS] of cenInit) {
    const snapS = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: cookieS, body: { description: `S-${ponto}` } });
    fs.writeFileSync(falhaFlag, ponto);
    const rS = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapS.json?.id}/restaurar`, { cookie: cookieS, body: { confirmacao: "RESTAURAR" } });
    t(`S/${ponto}: inicialização falhou → HTTP 503`, rS.status === 503, `status=${rS.status}`);
    // recuperação em modo falha concluiu: barreira removida, nova
    // restauração funciona — sem barreira órfã
    const snapS2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: cookieS, body: { description: `S2-${ponto}` } });
    const rS2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapS2.json?.id}/restaurar`, { cookie: cookieS, body: { confirmacao: "RESTAURAR" } });
    t(`S/${ponto}: restauração posterior funciona (sem órfã)`, rS2.status === 200, `status=${rS2.status}`);
  }
  const cenRec = [
    ["rejoins-members", m7.cookie], ["rejoins-sessoes", m8.cookie], ["rejoins-join", m9.cookie],
  ];
  for (const [ponto, cookieS] of cenRec) {
    // os DOIS snapshots são criados ANTES da falha: durante a barreira
    // pendente toda mutação HTTP (incl. criar snapshot) recebe 409
    const snapS = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: cookieS, body: { description: `SR-${ponto}` } });
    const snapS2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: cookieS, body: { description: `SR2-${ponto}` } });
    fs.writeFileSync(falhaFlag, ponto);
    const rS = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapS.json?.id}/restaurar`, { cookie: cookieS, body: { confirmacao: "RESTAURAR" } });
    // commit já aplicado; reconstrução falhou → 500 honesto, barreira pendente
    t(`S/${ponto}: falha na reconstrução → HTTP 500 (não finge sucesso)`, rS.status === 500, `status=${rS.status}`);
    const rEntP = await emitirCb(sM, "entrar-campanha", ids.camp);
    t(`S/${ponto}: campanha segue bloqueada (barreira pendente)`, rEntP !== true, JSON.stringify(rEntP).slice(0, 80));
    // nova tentativa retoma a recuperação do MESMO restoreId e segue
    const rS2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapS2.json?.id}/restaurar`, { cookie: cookieS, body: { confirmacao: "RESTAURAR" } });
    t(`S/${ponto}: recuperação retomada conclui 200`, rS2.status === 200, `status=${rS2.status}`);
    const rEntD = await emitirCb(sM, "entrar-campanha", ids.camp);
    t(`S/${ponto}: barreira removida após recuperação`, rEntD === true, JSON.stringify(rEntD).slice(0, 80));
  }
  fs.rmSync(falhaFlag, { force: true });

  // ---------- U. HTTP desconectado durante mutação — lease permanece ----------
  sec("U. Desconexão HTTP não libera o lease antes do fim real do handler");
  const uConvU = novoUsuario(BANCO, { username: "pt_convu" });
  const convU = await req(BASE, "POST", `/campaigns/${ids.camp}/invitations`, { cookie: m8.cookie, body: { role: "jogador", requiresApproval: false } });
  const codU = convU.json?.convite?.code;
  fs.writeFileSync(flagPausa, "convite-aceitar");
  fs.rmSync(pausadoArq, { force: true });
  const ctrlU = new AbortController();
  const pAceU = fetch(`${BASE}/api/convites/${codU}/aceitar`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: uConvU.cookie },
    body: "{}",
    signal: ctrlU.signal,
  }).then((r) => r.status).catch(() => "abort");
  t("U: aceite pausou dentro do lease", await esperarPausa());
  ctrlU.abort(); // cliente HTTP desconecta — handler segue suspenso
  await dormir(300);
  const snapU = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m7.cookie, body: { description: "U" } });
  const pRestU = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapU.json?.id}/restaurar`, { cookie: m7.cookie, body: { confirmacao: "RESTAURAR" } });
  const cedoU = await Promise.race([pRestU.then(() => "done"), dormir(2500).then(() => "pendente")]);
  t("U: restore aguarda o lease mesmo com socket HTTP morto", cedoU === "pendente", cedoU);
  fs.rmSync(flagPausa, { force: true });
  await pAceU;
  const rRestU = await pRestU;
  t("U: restore concluiu só após o término real do handler", rRestU.status === 200, `status=${rRestU.status}`);

  // ---------- W. Lease único: ciclo completo após a primeira gravação ----------
  sec("W. registrarChat reutiliza o lease — rolagem completa após write");
  fs.writeFileSync(flagPausa, "pos-write");
  fs.rmSync(pausadoArq, { force: true });
  // payload SEM "PISR": a 1ª pausa (antes do insert) usa o payload cru —
  // conter PISR dispararia ali; só o marcador "pos-write" (fase sintética)
  // deve casar, garantindo a pausa APÓS a primeira gravação
  const cbW = emitirCb(sM, "mesa:rolar", { sessionId: sid, dados: [{ sides: 20, count: 1 }], visibilidade: "publica", requestId: "rw-pos-1" });
  t("W: rolagem pausou APÓS o primeiro write", await esperarPausa());
  const dbW1 = abrirDb(BANCO);
  const rollW = dbW1.prepare("select id from rolls where request_id=?").get("rw-pos-1");
  dbW1.close();
  t("W: rolls já persistiu antes da pausa", !!rollW);
  const snapW = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m8.cookie, body: { description: "W" } });
  const pRestW = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapW.json?.id}/restaurar`, { cookie: m8.cookie, body: { confirmacao: "RESTAURAR" } });
  await esperarBarreira();
  await dormir(300); // restore drenando o lease do handler
  fs.rmSync(flagPausa, { force: true });
  const rW = await cbW;
  const rRestW = await pRestW;
  t("W: rolagem retornou ok (ciclo íntegro, sem sucesso parcial)", rW?.ok === true, JSON.stringify(rW).slice(0, 120));
  t("W: restore 200 após liberação real do lease", rRestW.status === 200, `status=${rRestW.status}`);
  const preW = ultimoPreSnap();
  t("W: snapshot prévio contém a rolagem drenada", preW.includes("rw-pos-1"));
  fs.rmSync(flagPausa, { force: true });
  fs.rmSync(pausadoArq, { force: true });
  fs.rmSync(falhaFlag, { force: true });

  // ---------- X. Lease em mutações por :characterId (ficha/patrimônio) ----------
  sec("X. Mutações de personagem/patrimônio drenam com a barreira");
  const charIdx = crypto.randomUUID();
  {
    const dbX = abrirDb(BANCO);
    const agoraX = Date.now();
    // membership ATIVA atual (restores anteriores substituíram as antigas)
    const midAtiva = dbX.prepare("select id from memberships where campaign_id=? and status='ativo' limit 1").get(ids.camp)?.id;
    dbX.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(charIdx, ids.camp, midAtiva, "PISR-Ficha", "{}", "{}", "aprovada", 0, agoraX, agoraX);
    dbX.close();
  }
  const patchFicha = () => req(BASE, "PATCH", `/characters/${charIdx}`, { cookie: ids.cookieMestre, body: { name: "PISR-Ficha-2" } });
  const patchInventario = () => req(BASE, "PATCH", `/characters/${charIdx}/inventario/item-inexistente`, { cookie: ids.cookieMestre, body: { name: "x" } });
  const okX = await patchFicha();
  t("X: PATCH ficha fora da barreira não é bloqueado por lease", okX.status !== 409, `status=${okX.status}`);
  const okXI = await patchInventario();
  t("X: PATCH patrimônio fora da barreira não é bloqueado por lease", okXI.status !== 409, `status=${okXI.status}`);
  const m10 = novoUsuario(BANCO, { username: "pt_m10", role: "mestre" });
  const snapX = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m10.cookie, body: { description: "X" } });
  const pRestX = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapX.json?.id}/restaurar`, { cookie: m10.cookie, body: { confirmacao: "RESTAURAR" } });
  await dormir(300); // janela da barreira (MESTRE_RESTORE_DELAY_MS=1200)
  const rFichaBar = await patchFicha();
  const rInvBar = await patchInventario();
  // a mensagem do lease é distinta de outros 409 (ex.: concorrência otimista)
  t("X: PATCH ficha durante a barreira → 409 de restauração (lease do personagem)", rFichaBar.status === 409 && /restaura/i.test(rFichaBar.json?.erro ?? ""), `status=${rFichaBar.status} erro=${rFichaBar.json?.erro}`);
  t("X: PATCH patrimônio durante a barreira → 409 de restauração", rInvBar.status === 409 && /restaura/i.test(rInvBar.json?.erro ?? ""), `status=${rInvBar.status} erro=${rInvBar.json?.erro}`);
  const rRestX = await pRestX;
  t("X: restore concluiu 200 após a janela", rRestX.status === 200, `status=${rRestX.status}`);

  // ---------- Y. Lease HTTP até o settle real da Promise ----------
  sec("Y. Lease HTTP: resposta antecipada e erro assíncrono (rotas de diagnóstico NODE_ENV=test)");
  const m11 = novoUsuario(BANCO, { username: "pt_m11", role: "mestre" });
  const m12 = novoUsuario(BANCO, { username: "pt_m12", role: "mestre" });
  const urlTardio = `${BASE}/api/__teste/campaigns/${ids.camp}/lease-tardio`;
  const postDiag = (path, cookie) => fetch(`${BASE}/api/__teste/campaigns/${ids.camp}/${path}`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}",
  });

  // Y1 — Caso B: res.end ANTES do fim do handler; lease permanece
  fs.writeFileSync(flagPausa, "lease:tardio");
  fs.rmSync(pausadoArq, { force: true });
  const pTardio = postDiag("lease-tardio", m11.cookie);
  t("Y1: handler pausou DEPOIS de enviar a resposta (trabalho assíncrono pendente)", await esperarPausa());
  const stTardio = await pTardio;
  t("Y1: resposta 200 já entregue ao cliente", stTardio.status === 200, `status=${stTardio.status}`);
  const snapY1 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m11.cookie, body: { description: "Y1" } });
  const pRestY1 = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapY1.json?.id}/restaurar`, { cookie: m11.cookie, body: { confirmacao: "RESTAURAR" } });
  await esperarBarreira();
  await dormir(1500); // maior que o delay pós-barreira (1200ms): sem lease a restauração já teria commitado
  const cedoY1 = await Promise.race([pRestY1.then(() => "done"), dormir(400).then(() => "pendente")]);
  t("Y1: restore NÃO avançou — lease vivo após res.end", cedoY1 === "pendente", cedoY1);
  fs.rmSync(flagPausa, { force: true });
  const rRestY1 = await pRestY1;
  t("Y1: restore concluiu 200 só após o settle real do handler", rRestY1.status === 200, `status=${rRestY1.status}`);
  const dbY1 = abrirDb(BANCO);
  const preY1 = dbY1.prepare("select data from snapshots where campaign_id=? and kind='pre_restauracao' order by created_at desc limit 1").get(ids.camp)?.data ?? "";
  dbY1.close();
  t("Y1: snapshot prévio contém a escrita pós-resposta (drenagem esperou o handler)", preY1.includes("PISR-lease-tardio"));

  // Y2 — Caso C: rejeição assíncrona → erro encaminhado, lease liberado 1x
  fs.writeFileSync(flagPausa, "lease:erro");
  fs.rmSync(pausadoArq, { force: true });
  const pErro = postDiag("lease-erro", m11.cookie);
  t("Y2: handler de erro pausou segurando o lease", await esperarPausa());
  fs.rmSync(flagPausa, { force: true }); // libera: o handler rejeita em seguida
  const rErro = await pErro;
  t("Y2: rejeição assíncrona virou HTTP 500 via errorHandler", rErro.status === 500, `status=${rErro.status}`);
  const snapY2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m12.cookie, body: { description: "Y2" } });
  const rRestY2 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapY2.json?.id}/restaurar`, { cookie: m12.cookie, body: { confirmacao: "RESTAURAR" } });
  t("Y2: restore prosseguiu — lease liberado uma única vez no settle", rRestY2.status === 200, `status=${rRestY2.status}`);

  // ---------- Z. Ciclo completo após a PRIMEIRA gravação (todos os handlers) ----------
  sec("Z. Pausa pós-write: restore drena e a operação completa o ciclo íntegro");
  const m13 = novoUsuario(BANCO, { username: "pt_m13", role: "mestre" });
  const m14 = novoUsuario(BANCO, { username: "pt_m14", role: "mestre" });
  const cicloPW = async (rotulo, cookieMestre, emitir, checar) => {
    fs.writeFileSync(flagPausa, "pos-write");
    fs.rmSync(pausadoArq, { force: true });
    const cb = emitir();
    const pausou = await esperarPausa();
    t(`${rotulo}: pausou APÓS a primeira gravação`, pausou);
    const snap = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: cookieMestre, body: { description: rotulo } });
    const pRest = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snap.json?.id}/restaurar`, { cookie: cookieMestre, body: { confirmacao: "RESTAURAR" } });
    await esperarBarreira();
    await dormir(300); // restore drenando o lease do handler pausado
    fs.rmSync(flagPausa, { force: true });
    const r = await cb;
    const rRest = await pRest;
    t(`${rotulo}: handler retornou ok (ciclo íntegro)`, r?.ok === true, JSON.stringify(r).slice(0, 120));
    t(`${rotulo}: restore 200 após liberação real`, rRest.status === 200, `status=${rRest.status}`);
    const pre = ultimoPreSnap();
    t(`${rotulo}: snapshot prévio contém a escrita drenada`, checar(pre), `len=${pre.length}`);
    return r;
  };

  await cicloPW("Z1/chat", m12.cookie,
    () => emitirCb(sM, "mesa:mensagem", { sessionId: sid, content: "PW-chat-1", visibilidade: "publica", clientId: crypto.randomUUID() }),
    (pre) => pre.includes("PW-chat-1"));
  // membro ativo real para o token (j1/j2 foram revogados por restores anteriores)
  const dbAtivo = abrirDb(BANCO);
  const uidAtivo = dbAtivo.prepare("select user_id from memberships where campaign_id=? and status='ativo' limit 1").get(ids.camp)?.user_id;
  dbAtivo.close();
  await cicloPW("Z2/vtt-token", m12.cookie,
    () => emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tkPW12345", nome: "PW-vtt", cor: "#123", x: 0.5, y: 0.5, userId: uidAtivo } }),
    (pre) => pre.includes("PW-vtt"));
  await cicloPW("Z3/vtt-nevoa", m12.cookie,
    () => emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelar", traco: { raioX: 0.1, raioY: 0.1, pontos: [{ x: 0.11, y: 0.11 }, { x: 0.22, y: 0.22 }] } }),
    (pre) => pre.includes('"revelados":[{"id"'));
  await cicloPW("Z4/turno", m13.cookie,
    () => emitirCb(sM, "mesa:turno", { sessionId: sid, acao: "iniciar" }),
    (pre) => pre.includes('"ativo":true'));
  await cicloPW("Z5/timer", m13.cookie,
    () => emitirCb(sM, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 555 }),
    (pre) => pre.includes("555000"));
  // personagem para os testes de pedir/rolar/decidir — jogador NOVO
  // (j1/j2 já foram revogados por restores anteriores)
  const jPW = novoUsuario(BANCO, { username: "pt_pw_j", role: "jogador" });
  const charPW = crypto.randomUUID();
  {
    const dbZ = abrirDb(BANCO);
    const agoraZ = Date.now();
    dbZ.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(charPW, ids.camp, jPW.membershipId, "PW-Personagem", "{}", "{}", "aprovada", 0, agoraZ, agoraZ);
    dbZ.close();
  }
  const rPedir = await cicloPW("Z6/teste-pedir", m13.cookie,
    () => emitirCb(sM, "mesa:teste:pedir", { sessionId: sid, characterId: charPW, rotulo: "PW-teste", dadosCount: 1, visibilidade: "publica", requestId: "pw-pedir-1" }),
    (pre) => pre.includes("pw-pedir-1"));
  const idTestePW = rPedir?.id;
  t("Z6: pedido retornou id de teste", !!idTestePW, JSON.stringify(rPedir).slice(0, 120));
  if (idTestePW) {
    await cicloPW("Z7/teste-rolar", m14.cookie,
      () => emitirCb(sM, "mesa:teste:rolar", { testId: idTestePW, requestId: "pw-roll-1" }),
      (pre) => pre.includes("pw-roll-1"));
    await cicloPW("Z8/teste-decidir", m14.cookie,
      () => emitirCb(sM, "mesa:teste:decidir", { testId: idTestePW, outcome: "sucesso", nota: "PW-dec" }),
      (pre) => pre.includes("PW-dec"));
  }
  fs.rmSync(flagPausa, { force: true });
  fs.rmSync(pausadoArq, { force: true });

  // ---------- AA. Duas retomadas concorrentes da MESMA barreira pendente ----------
  sec("AA. Retomadas concorrentes: uma única recuperação, fail-closed");
  let falhasLog = 0;
  proc.stderr.on("data", (d) => { if (String(d).includes("liberação falhou")) falhasLog++; });
  const m15 = novoUsuario(BANCO, { username: "pt_m15", role: "mestre" });
  const snapsAA = [];
  for (let i = 0; i < 4; i++) {
    const s = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m15.cookie, body: { description: `AA${i}` } });
    snapsAA.push(s.json?.id);
  }
  t("AA: 4 snapshots pré-criados", snapsAA.every(Boolean));
  // 1) restauração com falha injetada na reconstrução → barreira pendente
  fs.writeFileSync(falhaFlag, "rejoins-join");
  const rAA1 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapsAA[0]}/restaurar`, { cookie: m15.cookie, body: { confirmacao: "RESTAURAR" } });
  t("AA: 1ª restauração → 500 (reconstrução falhou, barreira pendente)", rAA1.status === 500, `status=${rAA1.status}`);
  const rEntAA = await emitirCb(sM, "entrar-campanha", ids.camp);
  t("AA: campanha segue bloqueada (barreira pendente fail-closed)", rEntAA !== true);
  // 2) DUAS retomadas simultâneas (snapshots distintos = restoreIds de rota distintos;
  //    a barreira interna é a mesma — o mecanismo deve compartilhar a recuperação)
  fs.writeFileSync(flagPausa, "barreira:recovery");
  fs.rmSync(pausadoArq, { force: true });
  const baseFalhas = falhasLog;
  const pAA2 = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapsAA[1]}/restaurar`, { cookie: m15.cookie, body: { confirmacao: "RESTAURAR" } });
  const pAA3 = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapsAA[2]}/restaurar`, { cookie: m15.cookie, body: { confirmacao: "RESTAURAR" } });
  t("AA: recuperação pausou na barreira compartilhada", await esperarPausa());
  const ambasPend = await Promise.race([Promise.all([pAA2, pAA3]).then(() => "done"), dormir(500).then(() => "pendente")]);
  t("AA: as duas retomadas aguardam a MESMA recuperação (nenhuma assumiu em paralelo)", ambasPend === "pendente", ambasPend);
  // 3) rearma a falha: a recuperação única falha → ambas recebem conflito
  fs.writeFileSync(falhaFlag, "rejoins-join");
  fs.rmSync(flagPausa, { force: true });
  const [rAA2, rAA3] = await Promise.all([pAA2, pAA3]);
  t("AA: retomadas concorrentes → 409 determinístico (conflito)", rAA2.status === 409 && rAA3.status === 409, `status=${rAA2.status}/${rAA3.status}`);
  await dormir(200);
  t("AA: UMA única execução de recuperação falhou (log único)", falhasLog - baseFalhas === 1, `delta=${falhasLog - baseFalhas}`);
  const rEntAA2 = await emitirCb(sM, "entrar-campanha", ids.camp);
  t("AA: barreira permanece fail-closed após falha compartilhada", rEntAA2 !== true);
  // 4) nova tentativa (restoreId da barreira preservado) conclui a recuperação
  const rAA4 = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapsAA[3]}/restaurar`, { cookie: m15.cookie, body: { confirmacao: "RESTAURAR" } });
  t("AA: retomada posterior conclui 200 e remove a barreira", rAA4.status === 200, `status=${rAA4.status}`);
  const rEntAA3 = await emitirCb(sM, "entrar-campanha", ids.camp);
  t("AA: ingressos liberados após recuperação única", rEntAA3 === true);
  fs.rmSync(pausadoArq, { force: true });

  // ---------- AB. Revalidação de autorização DEPOIS da barreira ----------
  sec("AB. Revalidação pós-barreira: revogação → 403 sem snapshot prévio");
  const m16 = novoUsuario(BANCO, { username: "pt_m16", role: "mestre" });
  const snapAB = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: m16.cookie, body: { description: "AB" } });
  t("AB: snapshot de destino criado", snapAB.status === 201 && !!snapAB.json?.id, `status=${snapAB.status}`);
  const dbAB0 = abrirDb(BANCO);
  const preAB0 = dbAB0.prepare("select count(*) c from snapshots where campaign_id=? and kind='pre_restauracao'").get(ids.camp).c;
  dbAB0.close();
  fs.writeFileSync(flagPausa, "restaurar:revalidar");
  fs.rmSync(pausadoArq, { force: true });
  const pRestAB = req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapAB.json?.id}/restaurar`, { cookie: m16.cookie, body: { confirmacao: "RESTAURAR" } });
  t("AB: barreira adquirida e pausa antes da revalidação", await esperarPausa());
  // revoga o papel NO BANCO durante a janela (a rota já passou na auth inicial)
  const dbAB1 = abrirDb(BANCO);
  dbAB1.prepare("update memberships set role='jogador' where campaign_id=? and user_id=?").run(ids.camp, m16.id);
  dbAB1.close();
  fs.rmSync(flagPausa, { force: true });
  const rRestAB = await pRestAB;
  t("AB: autorização revogada pós-barreira → HTTP 403", rRestAB.status === 403, `status=${rRestAB.status} ${JSON.stringify(rRestAB.json).slice(0, 120)}`);
  const dbAB2 = abrirDb(BANCO);
  const preAB1 = dbAB2.prepare("select count(*) c from snapshots where campaign_id=? and kind='pre_restauracao'").get(ids.camp).c;
  const papelAB = dbAB2.prepare("select role from memberships where campaign_id=? and user_id=?").get(ids.camp, m16.id)?.role;
  dbAB2.close();
  t("AB: NENHUM snapshot prévio criado pela tentativa negada", preAB1 === preAB0, `antes=${preAB0} depois=${preAB1}`);
  t("AB: estado não foi substituído (papel segue revogado)", papelAB === "jogador", `role=${papelAB}`);
  const rEntAB = await emitirCb(sM, "entrar-campanha", ids.camp);
  t("AB: barreira liberada em modo falha (ingressos voltam)", rEntAB === true, JSON.stringify(rEntAB).slice(0, 80));
  fs.rmSync(pausadoArq, { force: true });

  // ---------- AC. Dificuldade (target) fora do JSON HTTP para não-mestres ----------
  sec("AC. GET /testes e /historico: target removido para não-mestres");
  const jA = novoUsuario(BANCO, { username: "pt_priv_a", role: "jogador" });
  const jB = novoUsuario(BANCO, { username: "pt_priv_b", role: "jogador" });
  const esp2 = novoUsuario(BANCO, { username: "pt_esp2", role: "espectador" }); // esp original foi revogado na seção J
  const charA = crypto.randomUUID(), charB = crypto.randomUUID();
  {
    const dbAC = abrirDb(BANCO);
    const agoraAC = Date.now();
    for (const [cid, mid, nome] of [[charA, jA.membershipId, "Priv-A"], [charB, jB.membershipId, "Priv-B"]]) {
      dbAC.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(cid, ids.camp, mid, nome, "{}", "{}", "aprovada", 0, agoraAC, agoraAC);
    }
    dbAC.close();
  }
  const tPubA = await emitirCb(sM, "mesa:teste:pedir", { sessionId: sid, characterId: charA, rotulo: "AC-pubA", dadosCount: 1, minimo: 7, visibilidade: "publica", requestId: "ac-pub-a" });
  const tPrivA = await emitirCb(sM, "mesa:teste:pedir", { sessionId: sid, characterId: charA, rotulo: "AC-privA", dadosCount: 1, minimo: 9, visibilidade: "privada", requestId: "ac-priv-a" });
  const tPubB = await emitirCb(sM, "mesa:teste:pedir", { sessionId: sid, characterId: charB, rotulo: "AC-pubB", dadosCount: 1, minimo: 5, visibilidade: "publica", requestId: "ac-pub-b" });
  t("AC: três testes criados (público A, privado A, público B)", tPubA?.ok === true && tPrivA?.ok === true && tPubB?.ok === true,
    JSON.stringify([tPubA, tPrivA, tPubB]).slice(0, 200));
  const idPubA = tPubA?.id, idPrivA = tPrivA?.id, idPubB = tPubB?.id;

  const temTarget = (t) => t != null && Object.prototype.hasOwnProperty.call(t, "target");
  const checarTestes = (json, quem, esperado) => {
    const lista = json?.testes ?? [];
    for (const [rotulo, id, deveVer, deveTerTarget] of esperado) {
      const row = lista.find((x) => x.id === id);
      if (!deveVer) { t(`AC/${quem}: ${rotulo} ausente`, !row); continue; }
      t(`AC/${quem}: ${rotulo} presente`, !!row);
      if (row) t(`AC/${quem}: ${rotulo} target ${deveTerTarget ? "presente" : "AUSENTE do JSON"}`, temTarget(row) === deveTerTarget, `target=${row.target}`);
    }
  };
  const eps = [
    ["/testes", (c) => req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/testes`, { cookie: c })],
    ["/historico", (c) => req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/historico`, { cookie: c })],
  ];
  for (const [nomeEp, get] of eps) {
    const rM = await get(ids.cookieMestre);
    checarTestes(rM.json, `mestre${nomeEp}`, [
      ["pubA", idPubA, true, true], ["privA", idPrivA, true, true], ["pubB", idPubB, true, true],
    ]);
    const rJA = await get(jA.cookie);
    checarTestes(rJA.json, `donoA${nomeEp}`, [
      ["pubA", idPubA, true, false], ["privA", idPrivA, true, false], ["pubB", idPubB, true, false],
    ]);
    const rJB = await get(jB.cookie);
    checarTestes(rJB.json, `donoB${nomeEp}`, [
      ["pubA", idPubA, true, false], ["privA", idPrivA, false, false], ["pubB", idPubB, true, false],
    ]);
    const rE = await get(esp2.cookie);
    if (rE.status === 200) {
      checarTestes(rE.json, `espectador${nomeEp}`, [
        ["pubA", idPubA, true, false], ["privA", idPrivA, false, false], ["pubB", idPubB, true, false],
      ]);
    } else {
      t(`AC/espectador${nomeEp}: sem acesso ao histórico (${rE.status}) — não recebe nada`, true);
    }
  }

  // ---------- AD. Transporte Socket.IO real: alvo só para mestres ----------
  sec("AD. Socket.IO: payloads por audiência — alvo nunca vai a não-mestre");
  const cap = new Map();
  const escutar = (s) => {
    const c = { teste: [], detalhe: [], rolagem: [], decisao: [] };
    cap.set(s, c);
    s.on("mesa:teste", (p) => c.teste.push(p));
    s.on("mesa:teste:detalhe", (p) => c.detalhe.push(p));
    s.on("mesa:rolagem", (p) => c.rolagem.push(p));
    s.on("mesa:decisao", (p) => c.decisao.push(p));
  };
  escutar(sM);
  const sA = conectar(jA.cookie), sB = conectar(jB.cookie), sEsp2 = conectar(esp2.cookie);
  escutar(sA); escutar(sB); escutar(sEsp2);
  await Promise.all([pronto(sA), pronto(sB), pronto(sEsp2)]);
  await Promise.all([
    emitirCb(sA, "mesa:entrar", { sessionId: sid }),
    emitirCb(sB, "mesa:entrar", { sessionId: sid }),
    emitirCb(sEsp2, "mesa:entrar", { sessionId: sid }),
  ]);

  const tAD = await emitirCb(sM, "mesa:teste:pedir", { sessionId: sid, characterId: charA, rotulo: "AD-priv", dadosCount: 1, minimo: 11, visibilidade: "privada", requestId: "ad-priv-1" });
  const tADpub = await emitirCb(sM, "mesa:teste:pedir", { sessionId: sid, characterId: charA, rotulo: "AD-pub", dadosCount: 1, minimo: 13, visibilidade: "publica", requestId: "ad-pub-1" });
  t("AD: testes privado e público criados", tAD?.ok === true && tADpub?.ok === true, JSON.stringify([tAD, tADpub]).slice(0, 160));
  await dormir(400);
  const capDe = (s) => cap.get(s) ?? { teste: [], detalhe: [], rolagem: [], decisao: [] };
  const testesDe = (s, id) => capDe(s).teste.filter((p) => p.id === id);
  const temAlvo = (p) => p != null && Object.prototype.hasOwnProperty.call(p, "alvo") && p.alvo != null;
  // PRIVADO: dono recebe sem alvo; mestre recebe com alvo; demais nada
  t("AD/mestre: mesa:teste privado COM alvo=11", testesDe(sM, tAD?.id).some((p) => p.alvo === 11));
  t("AD/donoA: mesa:teste privado recebido", testesDe(sA, tAD?.id).length > 0);
  t("AD/donoA: NENHUM payload do teste privado tem alvo", testesDe(sA, tAD?.id).every((p) => !temAlvo(p)));
  t("AD/donoB: não recebeu o teste privado", testesDe(sB, tAD?.id).length === 0);
  t("AD/espectador: não recebeu o teste privado", testesDe(sEsp2, tAD?.id).length === 0);
  // PÚBLICO: sala+dono sem alvo; mestre tem versão administrativa com alvo
  t("AD/mestre: mesa:teste público COM alvo=13", testesDe(sM, tADpub?.id).some((p) => p.alvo === 13));
  t("AD/donoA: mesa:teste público recebido", testesDe(sA, tADpub?.id).length > 0);
  t("AD/donoA: público sem alvo em todos os payloads", testesDe(sA, tADpub?.id).every((p) => !temAlvo(p)));
  t("AD/donoB: público recebido e sem alvo", testesDe(sB, tADpub?.id).length > 0 && testesDe(sB, tADpub?.id).every((p) => !temAlvo(p)));
  t("AD/espectador: público recebido e sem alvo", testesDe(sEsp2, tADpub?.id).length > 0 && testesDe(sEsp2, tADpub?.id).every((p) => !temAlvo(p)));
  // detalhe: SÓ mestres — dono/jogador/espectador não recebem o evento
  t("AD/mestre: mesa:teste:detalhe COM alvo=11", capDe(sM).detalhe.some((p) => p.alvo === 11 || p.alvo === 13));
  t("AD/donoA: ZERO mesa:teste:detalhe", capDe(sA).detalhe.length === 0);
  t("AD/donoB: ZERO mesa:teste:detalhe", capDe(sB).detalhe.length === 0);
  t("AD/espectador: ZERO mesa:teste:detalhe", capDe(sEsp2).detalhe.length === 0);

  // rolagem do teste PRIVADO pelo dono
  const rAD = await emitirCb(sA, "mesa:teste:rolar", { testId: tAD?.id, requestId: "ad-roll-1" });
  t("AD: dono rolou o próprio teste privado", rAD?.ok === true, JSON.stringify(rAD).slice(0, 120));
  await dormir(400);
  const rollsDe = (s, testId) => capDe(s).rolagem.filter((p) => p.testId === testId);
  t("AD/mestre: mesa:rolagem privada COM alvo=11", rollsDe(sM, tAD?.id).some((p) => p.alvo === 11));
  t("AD/donoA: mesa:rolagem privada recebida", rollsDe(sA, tAD?.id).length > 0);
  t("AD/donoA: rolagem sem alvo/campo equivalente", rollsDe(sA, tAD?.id).every((p) => !("alvo" in p) && !("target" in p)));
  t("AD/donoB: não recebeu a rolagem privada", rollsDe(sB, tAD?.id).length === 0);
  t("AD/espectador: não recebeu a rolagem privada", rollsDe(sEsp2, tAD?.id).length === 0);
  // rolagem do teste PÚBLICO: sala recebe sanitizada, mestre com alvo
  const rADpub = await emitirCb(sA, "mesa:teste:rolar", { testId: tADpub?.id, requestId: "ad-roll-2" });
  t("AD: dono rolou o teste público", rADpub?.ok === true, JSON.stringify(rADpub).slice(0, 120));
  await dormir(400);
  t("AD/mestre: mesa:rolagem pública COM alvo=13", rollsDe(sM, tADpub?.id).some((p) => p.alvo === 13));
  t("AD/donoA: rolagem pública sem alvo", rollsDe(sA, tADpub?.id).every((p) => !("alvo" in p) && !("target" in p)));
  t("AD/donoB: rolagem pública recebida e sem alvo", rollsDe(sB, tADpub?.id).length > 0 && rollsDe(sB, tADpub?.id).every((p) => !("alvo" in p)));
  t("AD/espectador: rolagem pública recebida e sem alvo", rollsDe(sEsp2, tADpub?.id).length > 0 && rollsDe(sEsp2, tADpub?.id).every((p) => !("alvo" in p)));
  // decisão do mestre no teste privado: dono recebe, demais não; sem alvo
  const dAD = await emitirCb(sM, "mesa:teste:decidir", { testId: tAD?.id, outcome: "sucesso", nota: "AD-dec" });
  t("AD: mestre decidiu o teste privado", dAD?.ok === true, JSON.stringify(dAD).slice(0, 100));
  await dormir(400);
  const decDe = (s) => capDe(s).decisao.filter((p) => p.testId === tAD?.id);
  t("AD/mestre: decisão privada recebida", decDe(sM).length > 0);
  t("AD/donoA: decisão privada legítima recebida", decDe(sA).length > 0);
  t("AD/donoB: não recebeu a decisão privada", decDe(sB).length === 0);
  t("AD/espectador: não recebeu a decisão privada", decDe(sEsp2).length === 0);

  // ---------- AE. Rolagens privadas no histórico HTTP ----------
  sec("AE. /historico: rolagem privada só para dono do personagem e autor livre");
  // roll1: teste privado de charA (rolado por jA) — id "ad-roll-1"
  // roll2: teste privado de charB — cria e rola agora pelo mestre
  const tPrivB = await emitirCb(sM, "mesa:teste:pedir", { sessionId: sid, characterId: charB, rotulo: "AE-privB", dadosCount: 1, minimo: 13, visibilidade: "privada", requestId: "ae-priv-b" });
  const rPrivB = tPrivB?.ok ? await emitirCb(sM, "mesa:teste:rolar", { testId: tPrivB.id, requestId: "ae-roll-b" }) : { ok: false };
  // roll3: rolagem LIVRE privada do jogador A (sem personagem)
  const rLivreA = await emitirCb(sA, "mesa:rolar", { sessionId: sid, dados: [{ sides: 20, count: 1 }], visibilidade: "privada", motivo: "AE-livre-A", requestId: "ae-livre-a" });
  t("AE: roll privada de B e rolagem livre de A criadas", rPrivB?.ok === true && rLivreA?.ok === true, JSON.stringify([rPrivB, rLivreA]).slice(0, 160));
  await dormir(300);
  const idsRolls = { a: "ad-roll-1", b: "ae-roll-b", livre: "ae-livre-a" };
  const checarRolls = (json, quem, esperado) => {
    const lista = json?.rolagens ?? [];
    for (const [rotulo, id, deveVer] of esperado) {
      const row = lista.find((x) => x.id === id);
      t(`AE/${quem}: rolagem ${rotulo} ${deveVer ? "presente" : "AUSENTE"}`, deveVer ? !!row : !row, row ? `vis=${row.visibility} char=${row.characterId}` : "");
    }
  };
  const hist = async (cookie) => (await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/historico`, { cookie })).json;
  checarRolls(await hist(ids.cookieMestre), "mestre", [["A", idsRolls.a, true], ["B", idsRolls.b, true], ["livreA", idsRolls.livre, true]]);
  checarRolls(await hist(jA.cookie), "donoA", [["A", idsRolls.a, true], ["B", idsRolls.b, false], ["livreA", idsRolls.livre, true]]);
  checarRolls(await hist(jB.cookie), "donoB", [["A", idsRolls.a, false], ["B", idsRolls.b, true], ["livreA", idsRolls.livre, false]]);
  const histE = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/historico`, { cookie: esp2.cookie });
  if (histE.status === 200) {
    checarRolls(histE.json, "espectador", [["A", idsRolls.a, false], ["B", idsRolls.b, false], ["livreA", idsRolls.livre, false]]);
  } else {
    t("AE/espectador: histórico negado — não recebe rolagens", true);
  }

  // ---------- AF. Mensagem secreta após rebaixamento do autor ----------
  sec("AF. mensagemVisivel: mestre/secreta só para mestres ATUAIS");
  // mestre NOVO (m2 já foi rebaixado a espectador na seção H)
  const mAF = novoUsuario(BANCO, { username: "pt_maf", role: "mestre" });
  const sAF = conectar(mAF.cookie);
  escutar(sAF);
  await pronto(sAF);
  await emitirCb(sAF, "mesa:entrar", { sessionId: sid });
  // privada endereçada ao mAF ANTES do rebaixamento (contrato de destinatário)
  await emitirCb(sM, "mesa:mensagem", { sessionId: sid, content: "AF-PRIV-MAF", visibilidade: "privada", destinatarioUserId: mAF.id });
  await emitirCb(sAF, "mesa:mensagem", { sessionId: sid, content: "AF-SEC-MAF", visibilidade: "secreta" });
  await dormir(300);
  const msgsDe = async (cookie, ep = "mensagens") => {
    const r = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/${ep}`, { cookie });
    const lista = ep === "mensagens" ? (r.json?.mensagens ?? []) : (r.json?.eventos ?? []);
    return { status: r.status, textos: lista.map((m) => String(m.content ?? "")) };
  };
  const antesAF = await msgsDe(mAF.cookie);
  t("AF: mAF (mestre) vê a secreta e a privada endereçada", antesAF.textos.includes("AF-SEC-MAF") && antesAF.textos.includes("AF-PRIV-MAF"), JSON.stringify(antesAF.textos.slice(-4)));
  const antesMaf = await msgsDe(ids.cookieMestre);
  t("AF: mestre atual vê a secreta", antesMaf.textos.includes("AF-SEC-MAF"));
  // rebaixa mAF pela API real
  const rRebaixa = await patchMembro(mAF.membershipId, { role: "jogador" });
  t("AF: PATCH rebaixou mAF para jogador", rRebaixa.status === 200, `status=${rRebaixa.status} ${JSON.stringify(rRebaixa.json).slice(0, 100)}`);
  await dormir(300);
  const depoisAF = await msgsDe(mAF.cookie);
  t("AF: autor rebaixado NÃO vê mais a secreta que ele mesmo escreveu", !depoisAF.textos.includes("AF-SEC-MAF"), JSON.stringify(depoisAF.textos.slice(-4)));
  t("AF: rebaixado ainda vê a privada na qual é destinatário", depoisAF.textos.includes("AF-PRIV-MAF"));
  const histAF = await msgsDe(mAF.cookie, "historico");
  t("AF: histórico consolidado também omite a secreta", !histAF.textos.includes("AF-SEC-MAF"));
  const depoisM = await msgsDe(ids.cookieMestre);
  t("AF: mestre atual continua vendo a secreta", depoisM.textos.includes("AF-SEC-MAF"));
  // visibilidade DESCONHECIDA com autor == requisitante: fail-closed
  {
    const dbAF = abrirDb(BANCO);
    dbAF.prepare("insert into chat_messages (id,campaign_id,session_id,author_id,kind,content,visibility,recipients,created_at) values (?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), ids.camp, sid, jA.id, "texto", "AF-DESCONH", "desconhecida", null, Date.now());
    dbAF.close();
  }
  const msgsJA = await msgsDe(jA.cookie);
  t("AF: autor não-mestre NÃO vê mensagem de visibilidade desconhecida", !msgsJA.textos.includes("AF-DESCONH"));
  const msgsM2b = await msgsDe(ids.cookieMestre);
  t("AF: mestre vê até a visibilidade desconhecida (acesso administrativo)", msgsM2b.textos.includes("AF-DESCONH"));

  // ---------- AG. Importação: revalidação pós-barreira → 403 ----------
  sec("AG. Importação modo substituir: revogação na janela → 403 sem aplicar");
  const m17 = novoUsuario(BANCO, { username: "pt_m17", role: "mestre" });
  const expAG = await req(BASE, "GET", `/campaigns/${ids.camp}/exportar`, { cookie: m17.cookie });
  t("AG: pacote exportado", expAG.status === 200 && expAG.json?.versao === 1, `status=${expAG.status}`);
  const dbAG0 = abrirDb(BANCO);
  const preAG0 = dbAG0.prepare("select count(*) c from snapshots where campaign_id=? and kind='pre_restauracao'").get(ids.camp).c;
  const nomeAntes = dbAG0.prepare("select name from campaigns where id=?").get(ids.camp)?.name;
  dbAG0.close();
  // marca o pacote para provar que nada foi aplicado
  if (expAG.json?.estado?.campanha) expAG.json.estado.campanha.name = "AG-NAO-APLICAR";
  fs.writeFileSync(flagPausa, "importar:revalidar");
  fs.rmSync(pausadoArq, { force: true });
  const pImp = req(BASE, "POST", "/campaigns/importar", {
    cookie: m17.cookie,
    body: { pacote: expAG.json, modo: "substituir", campaignId: ids.camp, confirmacao: "SUBSTITUIR" },
  });
  t("AG: importação pausou na revalidação pós-barreira", await esperarPausa());
  const dbAG1 = abrirDb(BANCO);
  dbAG1.prepare("update memberships set role='jogador' where campaign_id=? and user_id=?").run(ids.camp, m17.id);
  dbAG1.close();
  fs.rmSync(flagPausa, { force: true });
  const rImp = await pImp;
  t("AG: autorização revogada na janela → HTTP 403", rImp.status === 403, `status=${rImp.status} ${JSON.stringify(rImp.json).slice(0, 140)}`);
  const dbAG2 = abrirDb(BANCO);
  const preAG1 = dbAG2.prepare("select count(*) c from snapshots where campaign_id=? and kind='pre_restauracao'").get(ids.camp).c;
  const nomeDepois = dbAG2.prepare("select name from campaigns where id=?").get(ids.camp)?.name;
  dbAG2.close();
  t("AG: nenhum snapshot prévio criado pela tentativa negada", preAG1 === preAG0, `antes=${preAG0} depois=${preAG1}`);
  t("AG: dados do pacote NÃO aplicados (nome inalterado)", nomeDepois === nomeAntes, `antes=${nomeAntes} depois=${nomeDepois}`);
  const rEntAG = await emitirCb(sM, "entrar-campanha", ids.camp);
  t("AG: barreira liberada em modo falha (campanha não fica presa)", rEntAG === true, JSON.stringify(rEntAG).slice(0, 80));
  fs.rmSync(pausadoArq, { force: true });

  // ---------- AH. HTTP: matriz fail-closed de visibilidade de testes ----------
  sec("AH. /testes e /historico: mestre/secreta/desconhecida só para mestres");
  // insere diretamente no banco (simula dados legados/importados):
  // 6 testes do charA com visibilidades distintas e target conhecido
  const visCasos = [
    ["publica", 21], ["privada", 22], ["mestre", 23], ["secreta", 24], ["desconhecida", 25], ["", 26],
  ];
  const idsAH = {};
  {
    const dbAH = abrirDb(BANCO);
    const agoraAH = Date.now();
    for (const [vis, alvo] of visCasos) {
      const id = crypto.randomUUID();
      idsAH[vis === "" ? "vazia" : vis] = id;
      dbAH.prepare(`insert into tests (id,campaign_id,session_id,character_id,requested_by,skill_ref,modifiers,dice_count,dice_sides,target,status,roll_id,outcome,outcome_note,visibility,request_id,created_at,updated_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, ids.camp, sid, charA, ids.admin, null, "{}", 1, 20, alvo, "pendente", null, null, null, vis, `ah-${vis}-${alvo}`, agoraAH, agoraAH);
    }
    dbAH.close();
  }
  const esperadoAH = [
    ["publica", idsAH.publica, true], ["privada", idsAH.privada, true],
    ["mestre", idsAH.mestre, false], ["secreta", idsAH.secreta, false],
    ["desconhecida", idsAH.desconhecida, false], ["vazia", idsAH.vazia, false],
  ];
  const esperadoAHB = [
    ["publica", idsAH.publica, true], ["privada", idsAH.privada, false],
    ["mestre", idsAH.mestre, false], ["secreta", idsAH.secreta, false],
    ["desconhecida", idsAH.desconhecida, false], ["vazia", idsAH.vazia, false],
  ];
  const esperadoAHE = [["publica", idsAH.publica, true]];
  for (const [nomeEp, get] of [
    ["/testes", (c) => req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/testes`, { cookie: c })],
    ["/historico", (c) => req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/historico`, { cookie: c })],
  ]) {
    const listaM = (await get(ids.cookieMestre)).json?.testes ?? [];
    for (const [rot, id] of esperadoAH) {
      const row = listaM.find((x) => x.id === id);
      t(`AH/mestre${nomeEp}: ${rot} presente COM target`, !!row && temTarget(row), `vis=${rot} target=${row?.target}`);
    }
    const listaA = (await get(jA.cookie)).json?.testes ?? [];
    for (const [rot, id, deve] of esperadoAH) {
      const row = listaA.find((x) => x.id === id);
      t(`AH/donoA${nomeEp}: ${rot} ${deve ? "presente sem target" : "AUSENTE"}`, deve ? (!!row && !temTarget(row)) : !row, `vis=${rot}`);
    }
    const listaB = (await get(jB.cookie)).json?.testes ?? [];
    for (const [rot, id, deve] of esperadoAHB) {
      const row = listaB.find((x) => x.id === id);
      t(`AH/donoB${nomeEp}: ${rot} ${deve ? "presente sem target" : "AUSENTE"}`, deve ? (!!row && !temTarget(row)) : !row, `vis=${rot}`);
    }
    const rE = await get(esp2.cookie);
    const listaE = rE.json?.testes ?? [];
    for (const [rot, id, deve] of esperadoAHE) {
      const row = listaE.find((x) => x.id === id);
      t(`AH/espectador${nomeEp}: ${rot} ${deve ? "presente sem target" : "AUSENTE"}`, deve ? (!!row && !temTarget(row)) : !row, `vis=${rot} status=${rE.status}`);
    }
    // espectador não pode ver NENHUM dos reservados
    for (const [rot, id] of [["privada", idsAH.privada], ["mestre", idsAH.mestre], ["secreta", idsAH.secreta], ["desconhecida", idsAH.desconhecida], ["vazia", idsAH.vazia]]) {
      t(`AH/espectador${nomeEp}: ${rot} ausente`, !listaE.find((x) => x.id === id));
    }
  }

  // §6 — mesa:teste:pedir rejeita visibilidade inválida SEM gravar/emitir
  sec("AH2. mesa:teste:pedir: visibilidade inválida → erro, zero efeitos");
  const dbAntes = abrirDb(BANCO);
  const nTestes0 = dbAntes.prepare("select count(*) c from tests where campaign_id=?").get(ids.camp).c;
  const nChat0 = dbAntes.prepare("select count(*) c from chat_messages where campaign_id=?").get(ids.camp).c;
  dbAntes.close();
  for (const vis of ["mestre", "secreta", "desconhecida", 123, { x: 1 }]) {
    const r = await emitirCb(sM, "mesa:teste:pedir", { sessionId: sid, characterId: charA, dadosCount: 1, visibilidade: vis, requestId: `ah2-${String(vis)}` });
    t(`AH2: pedir visibilidade=${JSON.stringify(vis)} rejeitada`, r?.ok === false, JSON.stringify(r).slice(0, 100));
  }
  const dbDepois = abrirDb(BANCO);
  const nTestes1 = dbDepois.prepare("select count(*) c from tests where campaign_id=?").get(ids.camp).c;
  const nChat1 = dbDepois.prepare("select count(*) c from chat_messages where campaign_id=?").get(ids.camp).c;
  dbDepois.close();
  t("AH2: nenhum teste gravado pelas tentativas inválidas", nTestes1 === nTestes0, `${nTestes0}→${nTestes1}`);
  t("AH2: nenhuma mensagem de chat criada", nChat1 === nChat0, `${nChat0}→${nChat1}`);

  // ---------- AI. Socket.IO: transporte real por visibilidade reservada ----------
  sec("AI. Rolagem/decisão/chat: mestre/secreta/desconhecida nunca saem dos mestres");
  for (const s of [sM, sA, sB, sEsp2]) {
    s.on("mesa:mensagem", (p) => { const c = capDe(s); (c.msg ??= []).push(p); });
  }
  const alvoPorVis = { publica: 21, privada: 22, mestre: 23, secreta: 24, desconhecida: 25, vazia: 26 };
  const ordemAI = ["publica", "privada", "mestre", "secreta", "desconhecida", "vazia"];
  const rolagemPorTeste = (s, testId) => capDe(s).rolagem.filter((p) => p.testId === testId);
  const decisaoPorTeste = (s, testId) => capDe(s).decisao.filter((p) => p.testId === testId);
  const msgPorTexto = (s, trecho) => (capDe(s).msg ?? []).filter((p) => String(p?.content ?? "").includes(trecho));
  for (const vis of ordemAI) {
    const idT = idsAH[vis];
    const marca = `AI-${vis}-FIM`;
    // rolagem pelo mestre (dono não rola teste de visibilidade reservada)
    const rRol = await emitirCb(sM, "mesa:teste:rolar", { testId: idT, requestId: `ai-roll-${vis}` });
    t(`AI/${vis}: rolagem executada`, rRol?.ok === true, JSON.stringify(rRol).slice(0, 100));
    await dormir(250);
    const esperadoRoll = {
      mestre: ["sim"], donoA: vis === "publica" || vis === "privada" ? "sim" : "nao",
      donoB: vis === "publica" ? "sim" : "nao", esp: vis === "publica" ? "sim" : "nao",
    };
    t(`AI/${vis}/mestre: rolagem COM alvo`, rolagemPorTeste(sM, idT).some((p) => p.alvo === alvoPorVis[vis]));
    t(`AI/${vis}/donoA: rolagem ${esperadoRoll.donoA === "sim" ? "recebida sem alvo" : "AUSENTE"}`,
      esperadoRoll.donoA === "sim"
        ? rolagemPorTeste(sA, idT).length > 0 && rolagemPorTeste(sA, idT).every((p) => !("alvo" in p) && !("target" in p))
        : rolagemPorTeste(sA, idT).length === 0);
    t(`AI/${vis}/donoB: rolagem ${esperadoRoll.donoB === "sim" ? "pública sem alvo" : "AUSENTE"}`,
      esperadoRoll.donoB === "sim"
        ? rolagemPorTeste(sB, idT).length > 0 && rolagemPorTeste(sB, idT).every((p) => !("alvo" in p))
        : rolagemPorTeste(sB, idT).length === 0);
    t(`AI/${vis}/espectador: rolagem ${esperadoRoll.esp === "sim" ? "pública sem alvo" : "AUSENTE"}`,
      esperadoRoll.esp === "sim"
        ? rolagemPorTeste(sEsp2, idT).length > 0 && rolagemPorTeste(sEsp2, idT).every((p) => !("alvo" in p))
        : rolagemPorTeste(sEsp2, idT).length === 0);
    // decisão com nota marcadora
    const rDec = await emitirCb(sM, "mesa:teste:decidir", { testId: idT, outcome: "sucesso", nota: `AI-nota-${vis}` });
    t(`AI/${vis}: decisão executada`, rDec?.ok === true, JSON.stringify(rDec).slice(0, 80));
    await dormir(250);
    t(`AI/${vis}/mestre: decisão recebida`, decisaoPorTeste(sM, idT).length > 0);
    const donoDecOk = vis === "publica" || vis === "privada";
    t(`AI/${vis}/donoA: decisão ${donoDecOk ? "recebida" : "AUSENTE"}`,
      donoDecOk ? decisaoPorTeste(sA, idT).length > 0 : decisaoPorTeste(sA, idT).length === 0);
    t(`AI/${vis}/donoB: decisão ${vis === "publica" ? "pública recebida" : "AUSENTE"}`,
      vis === "publica" ? decisaoPorTeste(sB, idT).length > 0 : decisaoPorTeste(sB, idT).length === 0);
    t(`AI/${vis}/espectador: decisão ${vis === "publica" ? "pública recebida" : "AUSENTE"}`,
      vis === "publica" ? decisaoPorTeste(sEsp2, idT).length > 0 : decisaoPorTeste(sEsp2, idT).length === 0);
    // chat: visibilidade persistida do registro de decisão
    const dbAI = abrirDb(BANCO);
    const rowDec = dbAI.prepare("select visibility,recipients,content from chat_messages where session_id=? and kind='decisao' and content like ? order by created_at desc limit 1")
      .get(sid, `%AI-nota-${vis}%`);
    const rowRol = dbAI.prepare("select visibility,recipients,content from chat_messages where session_id=? and kind='rolagem' order by created_at desc limit 1").get(sid);
    dbAI.close();
    const visChatEsp = vis === "publica" ? "publica" : vis === "privada" ? "privada" : "mestre";
    t(`AI/${vis}: chat da decisão persistido como "${visChatEsp}"`, rowDec?.visibility === visChatEsp, `vis=${rowDec?.visibility}`);
    t(`AI/${vis}: chat da decisão contém a nota marcadora`, String(rowDec?.content ?? "").includes(`AI-nota-${vis}`));
    if (vis === "privada") {
      const rec = JSON.parse(rowDec?.recipients ?? "[]");
      t("AI/privada: chat da decisão tem destinatário = dono", rec.includes(jA.id), JSON.stringify(rec));
    }
    t(`AI/${vis}: chat da rolagem persistido como "${visChatEsp}"`, rowRol?.visibility === visChatEsp, `vis=${rowRol?.visibility}`);
    // entrega da mensagem de chat por papel (evento mesa:mensagem)
    await dormir(200);
    const entregaDec = {
      mestre: msgPorTexto(sM, `AI-nota-${vis}`).length > 0,
      donoA: msgPorTexto(sA, `AI-nota-${vis}`).length > 0,
      donoB: msgPorTexto(sB, `AI-nota-${vis}`).length > 0,
      esp: msgPorTexto(sEsp2, `AI-nota-${vis}`).length > 0,
    };
    const espDec = { mestre: true, donoA: vis === "publica" || vis === "privada", donoB: vis === "publica", esp: vis === "publica" };
    t(`AI/${vis}/chat-mestre: mensagem da decisão entregue`, entregaDec.mestre === espDec.mestre);
    t(`AI/${vis}/chat-donoA: ${espDec.donoA ? "entregue" : "NÃO entregue"}`, entregaDec.donoA === espDec.donoA);
    t(`AI/${vis}/chat-donoB: ${espDec.donoB ? "entregue" : "NÃO entregue"}`, entregaDec.donoB === espDec.donoB);
    t(`AI/${vis}/chat-espectador: ${espDec.esp ? "entregue" : "NÃO entregue"}`, entregaDec.esp === espDec.esp);
    void marca;
  }

  // HTTP: a nota narrativa reservada não aparece para não-mestres
  const histAI = async (cookie) => (await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/historico`, { cookie })).json;
  const hM = await histAI(ids.cookieMestre), hA = await histAI(jA.cookie), hB = await histAI(jB.cookie), hE = await histAI(esp2.cookie);
  const textosHist = (h) => JSON.stringify(h?.eventos ?? []);
  for (const vis of ordemAI) {
    const nota = `AI-nota-${vis}`;
    const espVer = { mestre: [true, false, false, false], privada: [true, true, false, false], publica: [true, true, true, true], secreta: [true, false, false, false], desconhecida: [true, false, false, false], vazia: [true, false, false, false] }[vis];
    t(`AI/hist/${vis}: matriz de visibilidade da nota`,
      textosHist(hM).includes(nota) === espVer[0] && textosHist(hA).includes(nota) === espVer[1]
      && textosHist(hB).includes(nota) === espVer[2] && textosHist(hE).includes(nota) === espVer[3],
      `m=${textosHist(hM).includes(nota)} a=${textosHist(hA).includes(nota)} b=${textosHist(hB).includes(nota)} e=${textosHist(hE).includes(nota)}`);
  }

  // ---------- AJ. Dados restaurados/importados continuam fail-closed ----------
  sec("AJ. Importar pacote com visões reservadas: acesso segue restrito");
  const mAJ = novoUsuario(BANCO, { username: "pt_maj", role: "mestre" });
  // teste "secreta" PENDENTE entra no pacote: prova que um registro
  // reservado RESTAURADO continua fail-closed nas emissões
  const idAJ = crypto.randomUUID();
  {
    const dbAJ = abrirDb(BANCO);
    const agoraAJ = Date.now();
    dbAJ.prepare(`insert into tests (id,campaign_id,session_id,character_id,requested_by,skill_ref,modifiers,dice_count,dice_sides,target,status,roll_id,outcome,outcome_note,visibility,request_id,created_at,updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(idAJ, ids.camp, sid, charA, ids.admin, null, "{}", 1, 20, 27, "pendente", null, null, null, "secreta", "aj-secreta-pendente", agoraAJ, agoraAJ);
    dbAJ.close();
  }
  const expAJ = await req(BASE, "GET", `/campaigns/${ids.camp}/exportar`, { cookie: ids.cookieMestre });
  t("AJ: pacote exportado com os testes reservados", expAJ.status === 200, `status=${expAJ.status}`);
  const rImpAJ = await req(BASE, "POST", "/campaigns/importar", {
    cookie: mAJ.cookie,
    body: { pacote: expAJ.json, modo: "substituir", campaignId: ids.camp, confirmacao: "SUBSTITUIR" },
  });
  t("AJ: importação substituir concluída", rImpAJ.status === 200, `status=${rImpAJ.status} ${JSON.stringify(rImpAJ.json).slice(0, 120)}`);
  await dormir(400);
  // após a substituição, os MESMOS testes reservados seguem restritos
  const listaAposM = (await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/testes`, { cookie: ids.cookieMestre })).json?.testes ?? [];
  const listaAposA = (await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/testes`, { cookie: jA.cookie })).json?.testes ?? [];
  for (const [rot, id] of [["publica", idsAH.publica], ["privada", idsAH.privada], ["mestre", idsAH.mestre], ["secreta", idsAH.secreta], ["desconhecida", idsAH.desconhecida], ["vazia", idsAH.vazia]]) {
    t(`AJ/mestre pós-import: ${rot} presente`, !!listaAposM.find((x) => x.id === id));
    const deveA = rot === "publica" || rot === "privada";
    t(`AJ/donoA pós-import: ${rot} ${deveA ? "presente" : "AUSENTE"}`, deveA ? !!listaAposA.find((x) => x.id === id) : !listaAposA.find((x) => x.id === id));
  }
  // rolagem do teste "secreta" PENDENTE restaurado: continua só para mestres
  const rAJroll = await emitirCb(sM, "mesa:teste:rolar", { testId: idAJ, requestId: "aj-roll-secreta" });
  t("AJ: rolagem de teste secreta restaurado executada", rAJroll?.ok === true, JSON.stringify(rAJroll).slice(0, 100));
  await dormir(400);
  t("AJ/mestre: rolagem secreta pós-import recebida com alvo", rolagemPorTeste(sM, idAJ).length > 0);
  t("AJ/donoA: rolagem secreta pós-import AUSENTE", rolagemPorTeste(sA, idAJ).length === 0);
  t("AJ/donoB: rolagem secreta pós-import AUSENTE", rolagemPorTeste(sB, idAJ).length === 0);
  t("AJ/espectador: rolagem secreta pós-import AUSENTE", rolagemPorTeste(sEsp2, idAJ).length === 0);

  // ---------- AK. ACK de rolagem: visibilidade reservada bloqueia até o callback ----------
  sec("AK. mesa:teste:rolar — dono não rola nem recebe ACK de teste reservado");
  const ordemAK = ["publica", "privada", "mestre", "secreta", "desconhecida", "vazia"];
  const idsAK = {};
  {
    const dbAK = abrirDb(BANCO);
    const agoraAK = Date.now();
    const insAK = dbAK.prepare(`insert into tests (id,campaign_id,session_id,character_id,requested_by,skill_ref,modifiers,dice_count,dice_sides,target,status,visibility,request_id,created_at,updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const mapaAK = { publica: 31, privada: 32, mestre: 33, secreta: 34, desconhecida: 35, vazia: 36 };
    for (const vis of ordemAK) {
      const id = crypto.randomUUID();
      idsAK[vis] = id;
      insAK.run(id, ids.camp, sid, charA, ids.admin, JSON.stringify({ rotulo: `AK-${vis}` }), "{}", 1, 20, mapaAK[vis], "pendente", vis, `ak-${vis}`, agoraAK, agoraAK);
    }
    dbAK.close();
  }
  const statusDe = (id) => { const d = abrirDb(BANCO); const r = d.prepare("select status from tests where id=?").get(id); d.close(); return r?.status; };
  const rollsReq = (req) => { const d = abrirDb(BANCO); const r = d.prepare("select count(*) c from rolls where campaign_id=? and request_id=?").get(ids.camp, req); d.close(); return r.c; };
  const chatRolCount = () => { const d = abrirDb(BANCO); const r = d.prepare("select count(*) c from chat_messages where session_id=? and kind='rolagem'").get(sid); d.close(); return r.c; };
  for (const vis of ordemAK) {
    const idT = idsAK[vis];
    const reqId = `ak-roll-${vis}`;
    const chatAntes = chatRolCount();
    const r = await emitirCb(sA, "mesa:teste:rolar", { testId: idT, requestId: reqId });
    const reservado = vis !== "publica" && vis !== "privada";
    if (!reservado) {
      t(`AK/donoA/${vis}: rolagem permitida`, r?.ok === true, JSON.stringify(r).slice(0, 100));
      t(`AK/donoA/${vis}: ACK sem alvo/target`, r && !("alvo" in r) && !("target" in r));
    } else {
      t(`AK/donoA/${vis}: rolagem RECUSADA`, r?.ok === false, JSON.stringify(r).slice(0, 140));
      t(`AK/donoA/${vis}: ACK sem resultado/estado/rollId`, r && !("dados" in r) && !("total" in r) && !("count" in r) && !("rollId" in r) && !("vitalidade" in r) && r.jaRolado !== true);
      t(`AK/donoA/${vis}: teste segue pendente`, statusDe(idT) === "pendente");
      t(`AK/donoA/${vis}: nenhum roll gravado`, rollsReq(reqId) === 0);
      t(`AK/donoA/${vis}: nenhuma msg de rolagem gravada`, chatRolCount() === chatAntes);
      await dormir(150);
      t(`AK/donoA/${vis}: nenhum evento mesa:rolagem p/ A/B/esp`,
        rolagemPorTeste(sA, idT).length === 0 && rolagemPorTeste(sB, idT).length === 0 && rolagemPorTeste(sEsp2, idT).length === 0);
    }
  }
  // mestre rola TODAS as classificações (controle administrativo)
  for (const vis of ordemAK) {
    const r = await emitirCb(sM, "mesa:teste:rolar", { testId: idsAK[vis], requestId: `ak-m-${vis}` });
    t(`AK/mestre/${vis}: rolagem permitida`, r?.ok === true, JSON.stringify(r).slice(0, 100));
  }
  await dormir(300);
  // o mestre recebe o alvo pelo EVENTO mesa:rolagem (o ACK nunca o carrega)
  for (const vis of ordemAK) {
    t(`AK/mestre/${vis}: evento mesa:rolagem COM alvo`,
      rolagemPorTeste(sM, idsAK[vis]).some((p) => p.alvo === { publica: 31, privada: 32, mestre: 33, secreta: 34, desconhecida: 35, vazia: 36 }[vis]),
      JSON.stringify(rolagemPorTeste(sM, idsAK[vis])).slice(0, 120));
  }
  // teste reservado JÁ ROLADO: a recusa do dono antecede a idempotência
  const rRetry = await emitirCb(sA, "mesa:teste:rolar", { testId: idsAK.mestre, requestId: "ak-retry-mestre" });
  t("AK/donoA: teste reservado já rolado segue recusado (sem jaRolado)", rRetry?.ok === false && rRetry?.jaRolado !== true, JSON.stringify(rRetry).slice(0, 140));
  // donoB e espectador tentam rolar testes de A (público, privado e reservado)
  for (const [s, tag, pref] of [[sB, "donoB", "ak-b"], [sEsp2, "espectador", "ak-e"]]) {
    for (const vis of ["publica", "privada", "mestre"]) {
      const r = await emitirCb(s, "mesa:teste:rolar", { testId: idsAK[vis], requestId: `${pref}-${vis}` });
      t(`AK/${tag}/${vis}: rolagem de teste alheio RECUSADA sem resultado`,
        r?.ok === false && !("dados" in (r ?? {})) && !("total" in (r ?? {})) && r?.jaRolado !== true, JSON.stringify(r).slice(0, 120));
    }
  }

  // ---------- AL. mesa:teste:pedir — null explícito rejeitado ----------
  sec("AL. mesa:teste:pedir — só campo ausente assume pública; null/invalidos rejeitados");
  const contaGeral = () => { const d = abrirDb(BANCO);
    const a = d.prepare("select count(*) c from tests where session_id=?").get(sid).c;
    const b = d.prepare("select count(*) c from chat_messages where session_id=?").get(sid).c;
    d.close(); return { tests: a, chat: b }; };
  const antesInv = contaGeral();
  const evTesteAntes = capDe(sA).teste.length, evDetAntes = capDe(sM).detalhe.length;
  const invalidosPedir = [null, "", "mestre", "secreta", "desconhecida", 123, { x: 1 }];
  for (let i = 0; i < invalidosPedir.length; i++) {
    const r = await emitirCb(sM, "mesa:teste:pedir", { sessionId: sid, characterId: charA, rotulo: `AL-inv-${i}`, dadosCount: 1, visibilidade: invalidosPedir[i], requestId: `al-inv-${i}` });
    t(`AL/pedir inválido #${i} (${JSON.stringify(invalidosPedir[i])}): rejeitado`, r?.ok === false, JSON.stringify(r).slice(0, 120));
  }
  const depoisInv = contaGeral();
  t("AL: nenhum teste gravado pelos inválidos", depoisInv.tests === antesInv.tests, `${antesInv.tests}→${depoisInv.tests}`);
  t("AL: nenhuma msg de chat gravada pelos inválidos", depoisInv.chat === antesInv.chat, `${antesInv.chat}→${depoisInv.chat}`);
  t("AL: nenhum evento mesa:teste emitido pelos inválidos", capDe(sA).teste.length === evTesteAntes && capDe(sM).detalhe.length === evDetAntes);
  // campo AUSENTE → aceita como pública (controle do contrato)
  const rOmit = await emitirCb(sM, "mesa:teste:pedir", { sessionId: sid, characterId: charA, rotulo: "AL-publica-omitida", dadosCount: 1, requestId: "al-omit-1" });
  t("AL/pedir sem visibilidade: aceito", rOmit?.ok === true && !!rOmit?.id, JSON.stringify(rOmit).slice(0, 120));
  {
    const d = abrirDb(BANCO);
    const row = d.prepare("select visibility from tests where id=?").get(rOmit?.id);
    d.close();
    t("AL: teste criado com visibility='publica'", row?.visibility === "publica", `vis=${row?.visibility}`);
  }
  await dormir(250);
  t("AL: evento mesa:teste emitido para o omitido", capDe(sA).teste.length > evTesteAntes);

} catch (e) {
  fail++;
  console.error("ERRO FATAL", e);
} finally {
  for (const s of sockets) try { s.close(); } catch {}
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
