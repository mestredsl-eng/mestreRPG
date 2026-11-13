// Mesa virtual — atualização de papel/status/permissões em tempo real.
// Prova que a notificação privada `mesa:permissao:atualizada` chega aos
// sockets do usuário afetado SEM reconexão, que a visão VTT é ressincronizada
// com o papel novo e que a revogação remove o socket das salas da sessão.
// Banco 100% descartável.
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
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
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
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
