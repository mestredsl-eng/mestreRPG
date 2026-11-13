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
