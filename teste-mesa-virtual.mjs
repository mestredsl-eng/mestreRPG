// Mesa virtual Etapa 1 — mapa + tokens multiplayer (Socket.IO + banco temporário).
// Cobre: upload do mapa (conteúdo real, permissão, isolamento), CRUD de tokens,
// permissões por papel, tempo real (dois jogadores veem a mesma movimentação),
// rejeição sem emissão, idempotência e reconexão com estado persistido.
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("mesa-vtt");
const BANCO = `${DIR}/teste.db`;
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc, ids, sid, sid2, camp2;
const sockets = [];
const eventosVtt = new Map(); // socket -> contagem de mesa:vtt recebidos

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  eventosVtt.set(s, 0);
  s.on("mesa:vtt", () => eventosVtt.set(s, (eventosVtt.get(s) ?? 0) + 1));
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const emitirUmaVez = (s, ev, p) => new Promise((r) => { const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000); s.emit(ev, p, (x) => { clearTimeout(to); r(x); }); });
// O rate limit Socket.IO (#68) rejeita rajadas legítimas do teste com
// RATE_LIMITED + retryAfterMs; aguarda a janela e tenta de novo, como um
// cliente real deve fazer. Rejeições de negócio (ok:false sem codigo) não
// são repetidas.
const emitirCb = async (s, ev, p) => {
  for (let i = 0; i < 4; i++) {
    const r = await emitirUmaVez(s, ev, p);
    if (r?.codigo !== "RATE_LIMITED") return r;
    await dormir(Math.min(r.retryAfterMs ?? 500, 2500) + 50);
  }
  return emitirUmaVez(s, ev, p);
};
async function esperarVtt(socket, timeout = 8000) {
  const ini = eventosVtt.get(socket) ?? 0;
  const fim = Date.now() + timeout;
  while (Date.now() < fim) {
    if ((eventosVtt.get(socket) ?? 0) > ini) return;
    await dormir(50);
  }
  throw new Error("timeout mesa:vtt");
}

function novoUsuario(banco, { username, role = null, permissions = {} }) {
  const db = abrirDb(banco);
  try {
    const uid = crypto.randomUUID(), agora = Date.now();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, username, username, "x", agora, agora);
    let mid = null;
    if (role) {
      mid = crypto.randomUUID();
      db.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run(mid, ids.camp, uid, role, "ativo", JSON.stringify(permissions), agora, agora, agora);
    }
    return { id: uid, membershipId: mid, cookie: sessao(banco, uid) };
  } finally { db.close(); }
}

// PNG 1x1 válido (assinatura real)
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

async function uploadMapa(cookie, nome, conteudo, mime = "image/png") {
  const res = await fetch(`${BASE}/api/campaigns/${ids.camp}/arquivos/upload`, {
    method: "POST",
    headers: {
      cookie, "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(nome), "X-File-Mime": mime,
      "X-Visibility": "publica", "X-Category": "mapa",
    },
    body: conteudo,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "vtt_j1", jogador2: "vtt_j2" } });
  ids = { admin: c.adminId, j1: c.jogadores.jogador1.id, j2: c.jogadores.jogador2.id, camp: c.campId, cookieMestre: c.cookieMestre };
  const esp = novoUsuario(BANCO, { username: "vtt_esp", role: "espectador" });
  const ext = novoUsuario(BANCO, { username: "vtt_ext", role: null });

  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Mesa VTT" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid, JSON.stringify(sess.json).slice(0, 160));

  // campanha 2 para teste de isolamento
  const c2 = await req(BASE, "POST", "/campaigns", { cookie: ids.cookieMestre, body: { name: "Outra Campanha" } });
  camp2 = c2.json?.id ?? c2.json?.campanha?.id;
  const sess2 = camp2 ? await req(BASE, "POST", `/campaigns/${camp2}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Outra Mesa" } }) : null;
  sid2 = sess2?.json?.sessao?.id ?? sess2?.json?.id;

  // ---------- sockets ----------
  const sMestre = conectar(ids.cookieMestre);
  const sJ1 = conectar(c.jogadores.jogador1.cookie);
  const sJ2 = conectar(c.jogadores.jogador2.cookie);
  const sEsp = conectar(esp.cookie);
  const sExt = conectar(ext.cookie);
  await Promise.all([pronto(sMestre), pronto(sJ1), pronto(sJ2), pronto(sEsp)]);

  const entM = emitirCb(sMestre, "mesa:entrar", { sessionId: sid });
  const entJ1 = emitirCb(sJ1, "mesa:entrar", { sessionId: sid });
  const entJ2 = emitirCb(sJ2, "mesa:entrar", { sessionId: sid });
  const entE = emitirCb(sEsp, "mesa:entrar", { sessionId: sid });
  const entX = emitirCb(sExt, "mesa:entrar", { sessionId: sid });
  const [rM, rJ1, rJ2, rE, rX] = await Promise.all([entM, entJ1, entJ2, entE, entX]);
  t("mestre entra na mesa", rM?.ok === true && rM?.papel === "mestre");
  t("jogador1 entra", rJ1?.ok === true && rJ1?.papel === "jogador");
  t("espectador entra", rE?.ok === true && rE?.papel === "espectador");
  t("externo sem vínculo é recusado", rX?.ok === false, JSON.stringify(rX).slice(0, 120));

  // ---------- FASE mapa: upload ----------
  sec("Mapa — upload e validação de arquivo");
  const upOk = await uploadMapa(ids.cookieMestre, "mapa.png", PNG_1PX);
  t("mestre envia PNG válido", upOk.status === 201 && !!upOk.json?.id, JSON.stringify(upOk.json).slice(0, 120));
  const fileId = upOk.json?.id;

  const fakePng = Buffer.from("isto nao e uma imagem, so texto disfarcado de png........");
  const upFake = await uploadMapa(ids.cookieMestre, "fake.png", fakePng);
  t("conteúdo inválido com extensão .png é rejeitado", upFake.status === 415, `status=${upFake.status}`);

  const upExe = await uploadMapa(ids.cookieMestre, "virus.png", Buffer.from("MZ" + "x".repeat(100)), "image/png");
  t("arquivo disfarçado rejeitado por conteúdo", upExe.status === 415, `status=${upExe.status}`);

  // ---------- FASE mapa: socket ----------
  sec("Mapa — definir/substituir/remover via socket");
  const pJMapa = esperarVtt(sJ1); const pEMapa = esperarVtt(sEsp);
  const rDef = await emitirCb(sMestre, "mesa:vtt:mapa", { sessionId: sid, acao: "definir", mapa: { fileId, nome: "Mapa teste" } });
  await Promise.all([pJMapa, pEMapa]);
  t("mestre define mapa", rDef?.ok === true && rDef?.vtt?.mapa?.fileId === fileId);
  t("jogador e espectador recebem mesa:vtt", true);

  // jogador tenta definir → rejeitado e sem evento
  const iniJ2 = eventosVtt.get(sJ2) ?? 0;
  const rJogMapa = await emitirCb(sJ1, "mesa:vtt:mapa", { sessionId: sid, acao: "definir", mapa: { fileId, nome: "hack" } });
  await dormir(300);
  t("jogador não pode definir mapa", rJogMapa?.ok === false);
  t("rejeição não emite evento", (eventosVtt.get(sJ2) ?? 0) === iniJ2);

  // fileId de campanha inexistente / arquivo de texto
  const upTxt = await fetch(`${BASE}/api/campaigns/${ids.camp}/arquivos/upload`, {
    method: "POST",
    headers: {
      cookie: ids.cookieMestre, "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent("nota.txt"), "X-File-Mime": "text/plain",
    },
    body: "texto puro",
  });
  const fileTxt = (await upTxt.json().catch(() => ({})))?.id;
  const rMapaTxt = await emitirCb(sMestre, "mesa:vtt:mapa", { sessionId: sid, acao: "definir", mapa: { fileId: fileTxt, nome: "x" } });
  t("mapa não-imagem é rejeitado", rMapaTxt?.ok === false, JSON.stringify(rMapaTxt).slice(0, 120));
  const rMapaFalso = await emitirCb(sMestre, "mesa:vtt:mapa", { sessionId: sid, acao: "definir", mapa: { fileId: "arquivo-inexistente", nome: "x" } });
  t("fileId inexistente rejeitado", rMapaFalso?.ok === false);

  // substituição
  const upOk2 = await uploadMapa(ids.cookieMestre, "mapa2.png", PNG_1PX);
  const rSub = await emitirCb(sMestre, "mesa:vtt:mapa", { sessionId: sid, acao: "definir", mapa: { fileId: upOk2.json.id, nome: "Mapa 2" } });
  t("mestre substitui mapa", rSub?.ok === true && rSub?.vtt?.mapa?.fileId === upOk2.json.id);

  // isolamento: sessão de outra campanha não recebe o estado
  if (sid2) {
    const sM2 = conectar(ids.cookieMestre);
    await pronto(sM2);
    const rEnt2 = await emitirCb(sM2, "mesa:entrar", { sessionId: sid2 });
    t("outra sessão entra sem vtt herdado", rEnt2?.ok === true);
    const iniM2 = eventosVtt.get(sM2) ?? 0;
    await emitirCb(sMestre, "mesa:vtt:mapa", { sessionId: sid, acao: "remover" });
    await dormir(300);
    t("mudança na sessão A não vaza para sessão B", (eventosVtt.get(sM2) ?? 0) === iniM2);
    emitirCb(sM2, "mesa:sair", { sessionId: sid2 });
  }
  t("mestre remove mapa", (await emitirCb(sMestre, "mesa:vtt:mapa", { sessionId: sid, acao: "remover" }))?.ok === true);

  // ---------- FASE tokens ----------
  sec("Tokens — CRUD e validação");
  // precisa de mapa? tokens independem do mapa no backend; testa mesmo sem mapa
  const pTk1 = esperarVtt(sJ1); const pTk2 = esperarVtt(sJ2);
  const rCria = await emitirCb(sMestre, "mesa:vtt:token", {
    sessionId: sid, acao: "criar",
    token: { id: "tok-jogador-1", nome: "Ana", cor: "#ff0000", x: 0.3, y: 0.4, userId: ids.j1 },
  });
  await Promise.all([pTk1, pTk2]);
  t("mestre cria token do jogador1", rCria?.ok === true && rCria?.vtt?.tokens?.length === 1);
  const tokId = rCria?.vtt?.tokens?.[0]?.id;
  t("dois jogadores recebem o mesmo estado", rCria?.vtt?.tokens?.[0]?.x === 0.3);

  const rCria2 = await emitirCb(sMestre, "mesa:vtt:token", {
    sessionId: sid, acao: "criar",
    token: { id: "tok-jogador-1", nome: "Ana", cor: "#ff0000", x: 0.3, y: 0.4, userId: ids.j1 },
  });
  t("repetição com mesmo id não duplica token", rCria2?.ok === true && rCria2?.vtt?.tokens?.length === 1 && rCria2?.idempotente === true);

  // posições inválidas
  const rPosX = await emitirCb(sMestre, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: "x", x: 1.5, y: 0.5 } });
  const rPosY = await emitirCb(sMestre, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: "x", x: 0.5, y: -0.1 } });
  const rPosNaN = await emitirCb(sMestre, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: "x", x: "abc", y: 0.5 } });
  t("posições fora de [0,1] rejeitadas", rPosX?.ok === false && rPosY?.ok === false && rPosNaN?.ok === false);

  // jogador cria token → negado
  const rJogCria = await emitirCb(sJ1, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: "inv", x: 0.5, y: 0.5 } });
  t("jogador não cria token", rJogCria?.ok === false);

  // jogador move o próprio token
  const iniE = eventosVtt.get(sEsp) ?? 0;
  const pMv = esperarVtt(sEsp);
  const rMv = await emitirCb(sJ1, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: tokId, x: 0.7, y: 0.8 } });
  await pMv;
  t("jogador move o próprio token", rMv?.ok === true && rMv?.vtt?.tokens?.[0]?.x === 0.7);
  t("espectador recebeu a movimentação", true);

  // jogador2 tenta mover token do jogador1 → negado
  const rMvAlheio = await emitirCb(sJ2, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: tokId, x: 0.1, y: 0.1 } });
  t("jogador não move token alheio", rMvAlheio?.ok === false);

  // jogador tenta mover E editar nome no mesmo payload → servidor ignora edição
  const rMvEdit = await emitirCb(sJ1, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: tokId, x: 0.2, y: 0.2, nome: "hacked", cor: "#00ff00" } });
  const tokDepois = rMvEdit?.vtt?.tokens?.find?.((x) => x.id === tokId);
  t("jogador não altera nome/cor (só posição)", rMvEdit?.ok === true && tokDepois?.nome === "Ana" && tokDepois?.cor === "#ff0000");

  // espectador tenta mover → negado
  const rEspMv = await emitirCb(sEsp, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: tokId, x: 0.9, y: 0.9 } });
  t("espectador não move nada", rEspMv?.ok === false);

  // mestre edita e move qualquer token
  const rMestreEdit = await emitirCb(sMestre, "mesa:vtt:token", {
    sessionId: sid, acao: "atualizar",
    token: { id: tokId, nome: "Ana Beta", cor: "#123456", x: 0.5, y: 0.5 },
  });
  const tkM = rMestreEdit?.vtt?.tokens?.find?.((x) => x.id === tokId);
  t("mestre edita nome/cor/posição", tkM?.nome === "Ana Beta" && tkM?.cor === "#123456" && tkM?.x === 0.5);

  // token vinculado a personagem da campanha
  const pid = c.novoPersonagem(c.jogadores.jogador2.membershipId, "PJ Dois");
  const rCriaPj = await emitirCb(sMestre, "mesa:vtt:token", {
    sessionId: sid, acao: "criar",
    token: { nome: "PJ", cor: "#00ff00", x: 0.5, y: 0.5, personagemId: pid },
  });
  const tokPj = rCriaPj?.vtt?.tokens?.find?.((x) => x.personagemId === pid);
  t("token vinculado a personagem", rCriaPj?.ok === true && !!tokPj);
  const rPjInvalido = await emitirCb(sMestre, "mesa:vtt:token", {
    sessionId: sid, acao: "criar",
    token: { nome: "PJ?", x: 0.5, y: 0.5, personagemId: "personagem-de-outra-campanha" },
  });
  t("personagem de outra campanha rejeitado", rPjInvalido?.ok === false);

  // jogador2 move token do próprio personagem (via personagemId→membership)
  const rMvPj = await emitirCb(sJ2, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: tokPj?.id, x: 0.6, y: 0.6 } });
  t("jogador move token do próprio personagem", rMvPj?.ok === true);

  // remoção de membro perde acesso imediatamente (revalidação por operação)
  const dbRem = abrirDb(BANCO);
  dbRem.prepare("update memberships set status='removido', updated_at=? where id=?").run(Date.now(), c.jogadores.jogador1.membershipId);
  dbRem.close();
  const rRemovido = await emitirCb(sJ1, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: tokId, x: 0.4, y: 0.4 } });
  t("membro removido perde acesso na hora", rRemovido?.ok === false, JSON.stringify(rRemovido).slice(0, 120));

  // espectador/jogador não removem token
  const iniAntes = eventosVtt.get(sEsp) ?? 0;
  const rEspRem = await emitirCb(sEsp, "mesa:vtt:token", { sessionId: sid, acao: "remover", token: { id: tokId } });
  const rJRem = await emitirCb(sJ2, "mesa:vtt:token", { sessionId: sid, acao: "remover", token: { id: tokId } });
  t("somente mestre remove token", rEspRem?.ok === false && rJRem?.ok === false);

  // mestre remove
  const rRem = await emitirCb(sMestre, "mesa:vtt:token", { sessionId: sid, acao: "remover", token: { id: tokId } });
  t("mestre remove token", rRem?.ok === true && !rRem?.vtt?.tokens?.some((x) => x.id === tokId));

  // ---------- reconexão / persistência ----------
  sec("Reconexão e persistência");
  const sJ1b = conectar(c.jogadores.jogador2.cookie); // jogador1 foi removido da campanha antes
  await pronto(sJ1b);
  const rRe = await emitirCb(sJ1b, "mesa:entrar", { sessionId: sid });
  const vttRe = rRe?.sessao?.vttState;
  t("reconexão recupera estado persistido", rRe?.ok === true && rRe?.papel === "jogador" && Array.isArray(vttRe?.tokens) && vttRe.tokens.some((x) => x.personagemId === pid), JSON.stringify(vttRe).slice(0, 160));
  emitirCb(sJ1b, "mesa:sair", { sessionId: sid });

  // estado sobrevive a "restart" do servidor: novo processo, mesmo banco
  await encerrarServidor(proc);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const sMestre2 = conectar(ids.cookieMestre);
  await pronto(sMestre2);
  const rRe2 = await emitirCb(sMestre2, "mesa:entrar", { sessionId: sid });
  const vttRe2 = rRe2?.sessao?.vttState;
  t("após restart do servidor o estado persiste", rRe2?.ok === true && vttRe2?.tokens?.some((x) => x.personagemId === pid), JSON.stringify(vttRe2).slice(0, 160));

  // socket novo do jogador2 (os anteriores morreram no restart de persistência)
  const sJ2b = conectar(c.jogadores.jogador2.cookie);
  await pronto(sJ2b);
  await emitirCb(sJ2b, 'mesa:entrar', { sessionId: sid });

  // ---------- P1: espectador é somente leitura (token atribuído a ele) ----------
  sec("P1 — espectador somente leitura");
  const rTokEsp = await emitirCb(sMestre2, "mesa:vtt:token", {
    sessionId: sid, acao: "criar",
    token: { id: "tok-esp-01", nome: "Esp", cor: "#abcdef", x: 0.5, y: 0.5, userId: esp.id },
  });
  t("mestre cria token vinculado ao espectador", rTokEsp?.ok === true);
  const iniEsp = eventosVtt.get(sEsp) ?? 0;
  const rEspMoveT = await emitirCb(sEsp, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: "tok-esp-01", x: 0.9, y: 0.9 } });
  const rEspCriaT = await emitirCb(sEsp, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: "x", x: 0.1, y: 0.1 } });
  const rEspRemT = await emitirCb(sEsp, "mesa:vtt:token", { sessionId: sid, acao: "remover", token: { id: "tok-esp-01" } });
  const rEspMapaT = await emitirCb(sEsp, "mesa:vtt:mapa", { sessionId: sid, acao: "remover" });
  const rEspAlheioT = await emitirCb(sEsp, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: tokPj?.id, x: 0.1, y: 0.1 } });
  t("espectador: mover/criar/remover/mapa/alheio todos rejeitados",
    [rEspMoveT, rEspCriaT, rEspRemT, rEspMapaT, rEspAlheioT].every((r) => r?.ok === false),
    JSON.stringify([rEspMoveT, rEspCriaT, rEspRemT, rEspMapaT, rEspAlheioT]).slice(0, 200));
  await dormir(300);
  t("rejeições do espectador não emitem mesa:vtt", (eventosVtt.get(sEsp) ?? 0) === iniEsp);
  const vttAposEsp = (await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: "tok-esp-01", nome: "Esp" } }))?.vtt;
  t("estado do espectador intacto após rejeições", vttAposEsp?.tokens?.find?.((x) => x.id === "tok-esp-01")?.x === 0.5);

  // ---------- P3: mapa precisa ser visível a todos ----------
  sec("P3 — visibilidade do mapa");
  const upMestreVis = await fetch(`${BASE}/api/campaigns/${ids.camp}/arquivos/upload`, {
    method: "POST",
    headers: {
      cookie: ids.cookieMestre, "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent("mapa-mestre.png"), "X-File-Mime": "image/png",
      "X-Visibility": "mestre", "X-Category": "mapa",
    },
    body: PNG_1PX,
  });
  const fileMestreVis = (await upMestreVis.json().catch(() => ({})))?.id;
  const rMapaMestre = await emitirCb(sMestre2, "mesa:vtt:mapa", { sessionId: sid, acao: "definir", mapa: { fileId: fileMestreVis, nome: "secreto" } });
  t("mapa com visibilidade mestre é rejeitado", rMapaMestre?.ok === false, JSON.stringify(rMapaMestre).slice(0, 140));
  const upPub = await uploadMapa(ids.cookieMestre, "mapa-pub.png", PNG_1PX);
  const rMapaPub = await emitirCb(sMestre2, "mesa:vtt:mapa", { sessionId: sid, acao: "definir", mapa: { fileId: upPub.json.id, nome: "Mapa público" } });
  t("mapa público é aceito", rMapaPub?.ok === true);
  const dlJ2 = await fetch(`${BASE}/api/campaigns/${ids.camp}/arquivos/${upPub.json.id}`, { headers: { cookie: c.jogadores.jogador2.cookie } });
  t("jogador consegue baixar o mapa definido", dlJ2.status === 200, `status=${dlJ2.status}`);
  const patchVis = await req(BASE, "PATCH", `/campaigns/${ids.camp}/arquivos/${upPub.json.id}`, { cookie: ids.cookieMestre, body: { visibility: "mestre" } });
  t("visibilidade de mapa em uso não pode virar mestre", patchVis.status === 409, `status=${patchVis.status} ${JSON.stringify(patchVis.json).slice(0, 120)}`);
  const dlJ2b = await fetch(`${BASE}/api/campaigns/${ids.camp}/arquivos/${upPub.json.id}`, { headers: { cookie: c.jogadores.jogador2.cookie } });
  t("mapa continua baixável após tentativa de troca", dlJ2b.status === 200);
  await emitirCb(sMestre2, "mesa:vtt:mapa", { sessionId: sid, acao: "remover" });

  // ---------- P4: propriedade inequívoca ----------
  sec("P4 — vínculos userId × personagemId");
  const pidJ1 = c.novoPersonagem(esp.membershipId, "PJ Esp");
  const rConflito = await emitirCb(sMestre2, "mesa:vtt:token", {
    sessionId: sid, acao: "criar",
    token: { nome: "Conflito", x: 0.5, y: 0.5, userId: ids.j2, personagemId: pidJ1 },
  });
  t("userId=j2 + personagem de espectador é rejeitado", rConflito?.ok === false, JSON.stringify(rConflito).slice(0, 140));
  const rMesmoDono = await emitirCb(sMestre2, "mesa:vtt:token", {
    sessionId: sid, acao: "criar",
    token: { id: "tok-j2-ambos", nome: "J2", cor: "#123123", x: 0.4, y: 0.4, userId: ids.j2, personagemId: pid },
  });
  t("userId=j2 + personagem de j2 é aceito", rMesmoDono?.ok === true, JSON.stringify(rMesmoDono).slice(0, 140));
  const rReAtrib = await emitirCb(sMestre2, "mesa:vtt:token", {
    sessionId: sid, acao: "atualizar",
    token: { id: "tok-j2-ambos", userId: ids.j2, personagemId: pidJ1 },
  });
  t("reatribuição conflitante é rejeitada", rReAtrib?.ok === false);
  const rReValida = await emitirCb(sMestre2, "mesa:vtt:token", {
    sessionId: sid, acao: "atualizar",
    token: { id: "tok-j2-ambos", userId: null },
  });
  const tkRe = rReValida?.vtt?.tokens?.find?.((x) => x.id === "tok-j2-ambos");
  t("reatribuição válida mantém personagem de j2", rReValida?.ok === true && tkRe?.personagemId === pid && tkRe?.userId === null, JSON.stringify(tkRe).slice(0, 140));
  const rMvRe = await emitirCb(sJ2b, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: "tok-j2-ambos", x: 0.3, y: 0.3 } });
  t("j2 move token após reatribuição válida", rMvRe?.ok === true, JSON.stringify(rMvRe).slice(0, 140));

  // ---------- P5 + P7: limites e validação textual ----------
  sec("P5/P7 — limites e nomes");
  const rNomeObj = await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: { a: 1 }, x: 0.5, y: 0.5 } });
  const rNomeArr = await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: ["x"], x: 0.5, y: 0.5 } });
  const rNomeVazio = await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: "   ", x: 0.5, y: 0.5 } });
  const rNomeLongo = await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: "x".repeat(61), x: 0.5, y: 0.5 } });
  t("nomes objeto/array/vazio/longo rejeitados", [rNomeObj, rNomeArr, rNomeVazio, rNomeLongo].every((r) => r?.ok === false));
  const rNomeAcento = await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "tok-acao", nome: "  Ação Épica Ñandú  ", x: 0.5, y: 0.5 } });
  const tkAcao = rNomeAcento?.vtt?.tokens?.find?.((x) => x.id === "tok-acao");
  t("nome acentuado válido é aceito e trimado", tkAcao?.nome === "Ação Épica Ñandú", JSON.stringify(tkAcao?.nome));
  const vttAntes = (await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: "tok-acao", x: 0.5, y: 0.5 } }))?.vtt;
  const qtdAtual = vttAntes?.tokens?.length ?? 0;
  let ultimo = null;
  for (let i = qtdAtual; i < 100; i++) {
    ultimo = await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: `T${i}`, x: 0.5, y: 0.5 } });
    if (ultimo?.ok !== true) break;
  }
  const rEstouro = await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: "extra", x: 0.5, y: 0.5 } });
  const totalFinal = rEstouro?.vtt?.tokens?.length ?? (ultimo?.vtt?.tokens?.length ?? 0);
  t("limite de 100 tokens é enforced", rEstouro?.ok === false && totalFinal <= 100, `total=${totalFinal} resp=${JSON.stringify(rEstouro).slice(0, 120)}`);

  // ---------- concorrência: mutações simultâneas ----------
  sec("Concorrência — mutações simultâneas");
  for (const tk of (ultimo?.vtt?.tokens ?? [])) {
    if (!["tok-acao", "tok-j2-ambos"].includes(tk.id)) {
      await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "remover", token: { id: tk.id } });
    }
  }
  const criados = [];
  for (let i = 0; i < 8; i++) {
    const rr = await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: `conc-tk${i}`, nome: `C${i}`, x: 0.1, y: 0.1 } });
    criados.push(rr?.vtt?.tokens?.find?.((x) => x.id === `conc-tk${i}`));
  }
  const upConc = await uploadMapa(ids.cookieMestre, "mapa-conc.png", PNG_1PX);
  const paralelos = await Promise.all([
    emitirCb(sJ2b, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: "tok-j2-ambos", x: 0.11, y: 0.11 } }),
    emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: "tok-j2-ambos", x: 0.22, y: 0.22 } }),
    ...criados.filter(Boolean).map((tk, i) => emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: tk.id, x: 0.3 + i * 0.01, y: 0.4 } })),
    upConc?.json?.id ? emitirCb(sMestre2, "mesa:vtt:mapa", { sessionId: sid, acao: "definir", mapa: { fileId: upConc.json.id, nome: "conc" } }) : Promise.resolve(null),
  ]);
  const aceitos = paralelos.filter((r) => r?.ok === true).length;
  const vttConc = [...paralelos].reverse().find((r) => r?.vtt)?.vtt;
  // O vtt da resposta pode ser um snapshot anterior às mutações paralelas;
  // faz uma leitura autoritativa para conferir o estado final.
  const vttFinal = (await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: "tok-acao", x: 0.5, y: 0.5 } }))?.vtt ?? vttConc;
  const tokensConc = vttFinal?.tokens ?? [];
  const todosMovidos = criados.filter(Boolean).every((tk) => {
    const fin = tokensConc.find((x) => x.id === tk.id);
    return fin && fin.x !== 0.1;
  });
  t("mutações paralelas: estado final íntegro", aceitos >= 8 && todosMovidos && Array.isArray(tokensConc), `aceitos=${aceitos} tokens=${tokensConc.length}`);
  t("mapa concorrente persistido", !!vttConc?.mapa?.fileId);

  // ---------- P2: vtt_state corrompido não derruba a sessão ----------
  sec("P2 — estado corrompido");
  const dbCorr = abrirDb(BANCO);
  dbCorr.prepare("update sessions set vtt_state=? where id=?").run("{json-quebrado", sid);
  dbCorr.close();
  const sMestre3 = conectar(ids.cookieMestre);
  await pronto(sMestre3);
  const rCorr = await emitirCb(sMestre3, "mesa:entrar", { sessionId: sid });
  t("entrar com vtt_state corrompido responde ok", rCorr?.ok === true, JSON.stringify(rCorr).slice(0, 160));
  t("vtt corrompido vira estado vazio controlado", rCorr?.sessao?.vttState?.tokens?.length === 0 || rCorr?.sessao?.vttState == null, JSON.stringify(rCorr?.sessao?.vttState).slice(0, 120));
  const rChat = await emitirCb(sMestre3, "mesa:mensagem", { sessionId: sid, content: "chat com vtt corrompido" });
  t("chat funciona com vtt_state corrompido", rChat?.ok !== false, JSON.stringify(rChat).slice(0, 160));
  const rTurno = await emitirCb(sMestre3, "mesa:turno", { sessionId: sid, acao: "iniciar" });
  t("turnos funcionam com vtt_state corrompido", rTurno?.ok !== false, JSON.stringify(rTurno).slice(0, 160));
  const rTimer = await emitirCb(sMestre3, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 60 });
  t("timer funciona com vtt_state corrompido", rTimer?.ok === true, JSON.stringify(rTimer).slice(0, 160));
  const rRecupera = await emitirCb(sMestre3, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: "pos-corrompido", x: 0.5, y: 0.5 } });
  t("mutação VTT após corrupção recria estado", rRecupera?.ok === true && rRecupera?.vtt?.tokens?.some?.((x) => x.nome === "pos-corrompido"));
  const listaSess = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre });
  t("GET sessões responde com vtt corrompido", listaSess.status === 200, `status=${listaSess.status}`);

  // sessão encerrada bloqueia mutações
  await req(BASE, "PATCH", `/campaigns/${ids.camp}/sessoes/${sid}`, { cookie: ids.cookieMestre, body: { status: "encerrada" } });
  const rEnc = await emitirCb(sMestre2, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { nome: "fim", x: 0.1, y: 0.1 } });
  t("sessão encerrada rejeita mutação", rEnc?.ok === false, JSON.stringify(rEnc).slice(0, 120));

  for (const s of sockets) { try { s.disconnect(); } catch {} }
  await encerrarServidor(proc);
} catch (e) {
  fail++;
  console.log("FALHOU exceção:", e?.message ?? e);
  try { for (const s of sockets) s.disconnect(); } catch {}
  try { await encerrarServidor(proc); } catch {}
} finally {
  limparDir(DIR);
}
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
