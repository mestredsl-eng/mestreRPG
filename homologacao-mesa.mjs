// Homologação — mesa multiplayer (FASE 2, Issue #33).
// Mestre + 2 jogadores 100% sintéticos (teste-base.mjs) com clientes
// socket.io reais: entrada/saída/reconexão, chat público/privado,
// rolagens compartilhadas, turno e ampulheta do mestre, permissões e
// persistência após reinício do servidor.
import crypto from "node:crypto";
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("mesa");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc, ids, cm, cj1, cj2, sid, sockM, sockJ1, sockJ2;

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  return ioClient(BASE, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
}
const pronto = (s) => new Promise((res, rej) => {
  s.on("connect", res);
  s.on("connect_error", rej);
});
function esperar(socket, evento, timeout = 8000, pred) {
  return new Promise((resolve, reject) => {
    const h = (d) => {
      if (pred && !pred(d)) return;
      clearTimeout(t); socket.off(evento, h); resolve(d);
    };
    const t = setTimeout(() => { socket.off(evento, h); reject(new Error(`timeout ${evento}`)); }, timeout);
    socket.on(evento, h);
  });
}
const msgContent = (d) => d?.content ?? "";
const emitirCb = (socket, evento, payload) => new Promise((resolve) => socket.emit(evento, payload, resolve));

async function entrar(socket, sessionId) {
  await pronto(socket);
  return emitirCb(socket, "mesa:entrar", { sessionId });
}

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "mesa_j1", jogador2: "mesa_j2" },
    config: {
      hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "ambos" },
    },
  });
  ids = {
    admin: cenario.adminId, j1: cenario.jogadores.jogador1.id, j2: cenario.jogadores.jogador2.id,
    camp: cenario.campId,
    charJ1: cenario.novoPersonagem(cenario.jogadores.jogador1.membershipId, "PJ Mesa 1"),
    charJ2: cenario.novoPersonagem(cenario.jogadores.jogador2.membershipId, "PJ Mesa 2"),
  };
  // membership ids p/ ordem de turnos
  const memb = (uid) => comDb(BANCO, (db) => db.prepare("select id from memberships where campaign_id=? and user_id=?").get(ids.camp, uid).id);
  ids.membJ1 = memb(ids.j1); ids.membJ2 = memb(ids.j2); ids.membM = cenario.membMestre;
  cm = cenario.cookieMestre; cj1 = cenario.jogadores.jogador1.cookie; cj2 = cenario.jogadores.jogador2.cookie;

  // Sessão criada pela API (mestre)
  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: cm, body: { name: "Sessão E2E" } });
  t("sessão criada pelo mestre", sess.status === 201 || sess.status === 200, `status=${sess.status}`);
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessionId obtido", !!sid);

  // ===== Entrada e presença =====
  sec("Entrada, presença e reconexão");
  sockM = conectar(cm); sockJ1 = conectar(cj1); sockJ2 = conectar(cj2);
  // listeners de presença ANTES de qualquer entrada — mesa:presenca é
  // emitida durante mesa:entrar e não pode passar despercebido.
  const presencas = [];
  const hPres = (d) => { if (d?.sessionId === sid) presencas.push(d); };
  sockM.on("mesa:presenca", hPres);
  const [rM, rJ1, rJ2] = await Promise.all([entrar(sockM, sid), entrar(sockJ1, sid), entrar(sockJ2, sid)]);
  t("mestre entra como mestre", rM.ok === true && rM.papel === "mestre", JSON.stringify(rM).slice(0, 120));
  t("jogador1 entra como jogador", rJ1.ok === true && rJ1.papel === "jogador", JSON.stringify(rJ1).slice(0, 120));
  t("jogador2 entra", rJ2.ok === true, JSON.stringify(rJ2).slice(0, 120));

  // espera ativa: a presença completa (3 participantes) tem que chegar;
  // MRPG_PRESENCA_FALSO=1 é o controle de resistência — ids impossíveis → deve FALHAR
  const idsEsp = process.env.MRPG_PRESENCA_FALSO === "1"
    ? ["fake-mestre", "fake-j1", "fake-j2"]
    : [ids.admin, ids.j1, ids.j2];
  let completa = null;
  const limitePres = Date.now() + 8000;
  while (Date.now() < limitePres) {
    completa = [...presencas].reverse().find((d) =>
      d?.sessionId === sid && idsEsp.every((id) => (d.online ?? []).includes(id)));
    if (completa) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const ultimo = [...presencas].reverse().find((d) => d?.sessionId === sid);
  t("evento mesa:presenca emitido para a sala", presencas.length > 0 && Array.isArray(ultimo?.online),
    `eventos=${presencas.length}`);
  t("presença contém os 3 participantes esperados",
    !!completa && completa.online.length === idsEsp.length,
    JSON.stringify(completa ?? ultimo).slice(0, 200));
  sockM.off("mesa:presenca", hPres);

  // ===== Chat =====
  sec("Chat público e privado");
  {
    const ouvinteJ2 = esperar(sockJ2, "mesa:mensagem", 8000, (d) => /Olá mesa/.test(msgContent(d)));
    const r = await emitirCb(sockJ1, "mesa:mensagem", { sessionId: sid, content: "Olá mesa!", clientId: "msg-1" });
    t("mensagem pública aceita", r.ok === true, JSON.stringify(r));
    const msg = await ouvinteJ2;
    t("jogador2 recebeu a mensagem pública", /Olá mesa/.test(msgContent(msg)), JSON.stringify(msg).slice(0, 140));

    // privada J1 → mestre: J2 não deve ver
    let viuPrivada = false;
    const hJ2 = (d) => { if (/segredo/i.test(msgContent(d))) viuPrivada = true; };
    sockJ2.on("mesa:mensagem", hJ2);
    const ouvinteM = esperar(sockM, "mesa:mensagem", 8000, (d) => /segredo/.test(msgContent(d)));
    await emitirCb(sockJ1, "mesa:mensagem", { sessionId: sid, content: "segredo do j1", visibilidade: "privada", destinatarioUserId: ids.admin });
    const mp = await ouvinteM;
    t("mestre recebeu mensagem privada", /segredo/.test(msgContent(mp)), JSON.stringify(mp).slice(0, 140));
    await new Promise((r) => setTimeout(r, 400));
    t("jogador2 NÃO recebeu privada", !viuPrivada);
    sockJ2.off("mesa:mensagem", hJ2);

    // secreta só mestre
    const rSec = await emitirCb(sockJ1, "mesa:mensagem", { sessionId: sid, content: "x", visibilidade: "secreta" });
    t("jogador não envia secreta → erro", rSec.ok === false, JSON.stringify(rSec));
    const rSecM = await emitirCb(sockM, "mesa:mensagem", { sessionId: sid, content: "plano secreto", visibilidade: "secreta" });
    t("mestre envia secreta → ok", rSecM.ok === true, JSON.stringify(rSecM));
  }

  // ===== Rolagens compartilhadas =====
  sec("Rolagens na mesa");
  {
    const ouvinte = esperar(sockJ2, "mesa:rolagem");
    const r = await emitirCb(sockJ1, "mesa:rolar", {
      sessionId: sid, dados: [{ sides: 20, count: 2 }], motivo: "ataque", visibilidade: "publica",
    });
    t("rolagem livre aceita", r.ok === true, JSON.stringify(r).slice(0, 140));
    const roll = await ouvinte;
    t("jogador2 recebeu mesa:rolagem", Array.isArray(roll?.dados) || Array.isArray(roll?.resultados) || !!roll?.total, JSON.stringify(roll).slice(0, 160));

    // rolagem de teste do mestre no personagem do j1
    const pedir = await emitirCb(sockM, "mesa:teste:pedir", {
      sessionId: sid, characterId: ids.charJ1, campoId: "for", dadosLados: 10, visibilidade: "publica",
    });
    t("mestre pede teste D10", pedir.ok === true && !!(pedir.testId ?? pedir.id), JSON.stringify(pedir).slice(0, 160));
    const testId = pedir.testId ?? pedir.id;
    const rolar = await emitirCb(sockJ1, "mesa:teste:rolar", { testId });
    t("dono rola o próprio teste → 200", rolar.ok === true, JSON.stringify(rolar).slice(0, 140));
    const rolar2 = await emitirCb(sockJ1, "mesa:teste:rolar", { testId });
    t("re-rolar teste já rolado → idempotente", rolar2.ok === true && (rolar2.jaRolado === true || rolar2.status === "rolado"), JSON.stringify(rolar2).slice(0, 120));
  }

  // ===== Turnos e ampulheta (só mestre) =====
  sec("Turnos e temporizador — controle do mestre");
  {
    const rNegado = await emitirCb(sockJ1, "mesa:turno", { sessionId: sid, acao: "iniciar" });
    t("jogador NÃO controla turno", rNegado.ok === false, JSON.stringify(rNegado));
    const rTimerNegado = await emitirCb(sockJ1, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 60 });
    t("jogador NÃO controla timer", rTimerNegado.ok === false, JSON.stringify(rTimerNegado));

    const ordem = [ids.membJ1, ids.membJ2, ids.membM];
    const ini = await emitirCb(sockM, "mesa:turno", { sessionId: sid, acao: "iniciar", ordem });
    t("mestre inicia turnos", ini.ok === true && ini.turnos?.ativo === true, JSON.stringify(ini).slice(0, 160));
    const av = await emitirCb(sockM, "mesa:turno", { sessionId: sid, acao: "avancar" });
    t("avançar turno → atual=1", av.ok === true && av.turnos?.atual === 1, JSON.stringify(av.turnos).slice(0, 120));

    const iniciativaEvt = esperar(sockJ1, "mesa:turnos", 8000,
      (evento) => Array.isArray(evento?.turnos?.iniciativa));
    const iniciativa = await emitirCb(sockM, "mesa:turno", { sessionId: sid, acao: "iniciativa", dados: 2 });
    const estadoIniciativa = await iniciativaEvt;
    const resultados = estadoIniciativa.turnos.iniciativa;
    t("mestre rola e transmite iniciativa dos jogadores", iniciativa.ok === true
      && estadoIniciativa.turnos.ativo === true
      && resultados.length === 2
      && estadoIniciativa.turnos.ordem.length === resultados.length
      && resultados.every((r) => r.dados.length === 2 && r.total === r.dados.reduce((soma, d) => soma + d, 0)));
    const iniciativaNegada = await emitirCb(sockJ1, "mesa:turno", { sessionId: sid, acao: "iniciativa", dados: 1 });
    t("jogador NÃO controla iniciativa", iniciativaNegada.ok === false, JSON.stringify(iniciativaNegada));

    const ordemRestaurada = await emitirCb(sockM, "mesa:turno", { sessionId: sid, acao: "iniciar", ordem });
    const avancarNovamente = await emitirCb(sockM, "mesa:turno", { sessionId: sid, acao: "avancar" });
    t("ordem manual segue disponível após iniciativa", ordemRestaurada.ok === true && avancarNovamente.turnos?.atual === 1);

    // ampulheta: listeners instalados ANTES de iniciar — evento final não pode passar despercebido
    const eventosTimer = [];
    const hTimerM = (d) => { if (d?.sessionId === sid) eventosTimer.push(d); };
    const hTimerJ = (d) => { if (d?.sessionId === sid) eventosTimer.push(d); };
    sockM.on("mesa:timer", hTimerM); sockJ1.on("mesa:timer", hTimerJ);
    try {
      const timer = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 60 });
      t("mestre inicia ampulheta", timer.ok === true && timer.timer?.status === "rodando" && timer.timer?.totalMs === 60000, JSON.stringify(timer.timer).slice(0, 140));
      const tickJ = await esperar(sockJ1, "mesa:timer", 8000,
        (d) => d?.sessionId === sid && d.status === "rodando" && d.remainingMs > 0 && d.remainingMs < 60000).catch(() => null);
      t("tick do timer chega ao jogador", !!tickJ && tickJ.remainingMs > 0, JSON.stringify(tickJ).slice(0, 140));

      // pausa: status pausado, sem evento de parada durante a pausa
      const pausado = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "pausar" });
      t("pausar → status pausado", pausado.ok === true && pausado.timer?.status === "pausado" && pausado.timer?.remainingMs > 0, JSON.stringify(pausado.timer).slice(0, 140));
      const dbPausa = comDb(BANCO, (db) => db.prepare("select timer_state from sessions where id=?").get(sid)?.timer_state);
      t("pausa persistida no banco", dbPausa && JSON.parse(dbPausa).status === "pausado", dbPausa);
      await new Promise((r) => setTimeout(r, 1500));
      t("nenhum 'parado' emitido durante a pausa", !eventosTimer.some((d) => d.status === "parado"));

      // retomada: volta a rodando com tempo restante
      const retomado = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "retomar" });
      t("retomar → rodando com restante", retomado.ok === true && retomado.timer?.status === "rodando" && retomado.timer?.remainingMs > 0, JSON.stringify(retomado.timer).slice(0, 140));

      // encerramento manual: evento + persistência imediatos
      const encerrado = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "encerrar" });
      t("encerrar manual → parado", encerrado.ok === true && encerrado.timer?.status === "parado" && encerrado.timer?.remainingMs === 0, JSON.stringify(encerrado.timer).slice(0, 140));
      const dbEnc = comDb(BANCO, (db) => db.prepare("select timer_state from sessions where id=?").get(sid)?.timer_state);
      t("encerramento manual persistido", dbEnc && JSON.parse(dbEnc).status === "parado" && JSON.parse(dbEnc).remainingMs === 0, dbEnc);

      // expiração natural: duração mínima é 60s, então o estado quase expirado é
      // injetado direto no banco — o ticker do servidor deve encerrar e emitir o evento final
      eventosTimer.length = 0;
      const expiraEm = Date.now() + 1500;
      const dbW = abrirDb(BANCO);
      dbW.prepare("update sessions set timer_state=? where id=?")
        .run(JSON.stringify({ status: "rodando", endsAt: expiraEm, remainingMs: 1500, totalMs: 60000 }), sid);
      dbW.close();
      const tsInjetado = comDb(BANCO, (db) => db.prepare("select timer_state from sessions where id=?").get(sid)?.timer_state);
      const tsInj = tsInjetado ? JSON.parse(tsInjetado) : null;
      t("ampulheta reaberta (expiração injetada persistida no servidor)",
        tsInj?.status === "rodando" && tsInj?.endsAt === expiraEm && tsInj?.remainingMs === 1500, tsInjetado);
      // MRPG_TIMER_FALSO=1 é o controle de resistência: exige status impossível → deve FALHAR
      const statusFinal = process.env.MRPG_TIMER_FALSO === "1" ? "status-inexistente" : "parado";
      const fim = await esperar(sockM, "mesa:timer", 15000,
        (d) => d?.sessionId === sid && d.status === statusFinal && d.remainingMs === 0).catch(() => null);
      t("expiração emite evento final explícito ('parado', remainingMs=0)",
        !!fim && fim.status === "parado" && fim.remainingMs === 0, JSON.stringify(fim).slice(0, 140));
      const tsDb = comDb(BANCO, (db) => db.prepare("select timer_state from sessions where id=?").get(sid)?.timer_state);
      const tsFim = tsDb ? JSON.parse(tsDb) : null;
      t("expiração persistida como 'parado' no banco", tsFim?.status === "parado" && tsFim?.remainingMs === 0, tsDb);
    } finally {
      sockM.off("mesa:timer", hTimerM); sockJ1.off("mesa:timer", hTimerJ);
    }
  }

  // ===== Turnos — ordem vazia, estado legado e retomada =====
  sec("Turnos — ordem vazia e estado legado");
  {
    // sessão dedicada: não interfere no estado de `sid` (persistência)
    const sessT = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: cm, body: { name: "Sessão Turnos Vazio" } });
    const sidT = sessT.json?.sessao?.id ?? sessT.json?.id;
    t("sessão de turnos criada", !!sidT, `status=${sessT.status}`);
    const entT = await emitirCb(sockM, "mesa:entrar", { sessionId: sidT });
    t("mestre entra na sessão de turnos", entT?.ok === true, JSON.stringify(entT).slice(0, 120));

    // 1. iniciar sem ordem válida → recusado, nada persiste como ativo
    const iniVazio = await emitirCb(sockM, "mesa:turno", { sessionId: sidT, acao: "iniciar" });
    t("iniciar sem ordem → rejeitado", iniVazio.ok === false, JSON.stringify(iniVazio).slice(0, 140));
    const iniVazioOrd = await emitirCb(sockM, "mesa:turno", { sessionId: sidT, acao: "iniciar", ordem: [] });
    t("iniciar com ordem:[] → rejeitado", iniVazioOrd.ok === false, JSON.stringify(iniVazioOrd).slice(0, 140));
    const dbT1 = comDb(BANCO, (db) => db.prepare("select state from turns where session_id=?").get(sidT)?.state);
    const st1 = dbT1 ? JSON.parse(dbT1) : null;
    t("estado persistido continua inativo/vazio", !st1 || (st1.ativo !== true && (st1.ordem ?? []).length === 0), dbT1);

    // 2. definirOrdem povoa; iniciar SEM ordem reutiliza a ordem existente
    const def = await emitirCb(sockM, "mesa:turno", { sessionId: sidT, acao: "definirOrdem", ordem: [ids.membJ1, ids.membJ2] });
    t("definirOrdem grava ordem", def.ok === true && def.turnos?.ordem?.length === 2, JSON.stringify(def.turnos).slice(0, 140));
    const iniReuso = await emitirCb(sockM, "mesa:turno", { sessionId: sidT, acao: "iniciar" });
    t("iniciar reutiliza ordem existente", iniReuso.ok === true && iniReuso.turnos?.ativo === true && iniReuso.turnos?.atual === 0, JSON.stringify(iniReuso.turnos).slice(0, 140));

    // 3. definirOrdem [] com sequência ativa → desativa (sem estado inválido)
    const defVazio = await emitirCb(sockM, "mesa:turno", { sessionId: sidT, acao: "definirOrdem", ordem: [] });
    t("definirOrdem [] desativa a sequência", defVazio.ok === true && defVazio.turnos?.ativo === false && (defVazio.turnos?.ordem ?? []).length === 0, JSON.stringify(defVazio.turnos).slice(0, 140));
    const avVazio = await emitirCb(sockM, "mesa:turno", { sessionId: sidT, acao: "avancar" });
    t("avancar sem ordem é no-op", avVazio.ok === true && avVazio.turnos?.ativo === false, JSON.stringify(avVazio.turnos).slice(0, 120));

    // 4. estado legado inválido injetado direto no banco → entrada o entrega,
    //    e a iniciativa o repara com participantes reais
    const dbL = abrirDb(BANCO);
    const updLegado = dbL.prepare("update turns set state=?, updated_at=? where session_id=?")
      .run(JSON.stringify({ ordem: [], atual: 0, ativo: true }), Date.now(), sidT);
    if (updLegado.changes === 0) {
      dbL.prepare("insert into turns (id, session_id, state, updated_by, updated_at) values (?,?,?,?,?)")
        .run(crypto.randomUUID(), sidT, JSON.stringify({ ordem: [], atual: 0, ativo: true }), ids.admin, Date.now());
    }
    dbL.close();
    const entLegado = await emitirCb(sockM, "mesa:entrar", { sessionId: sidT });
    t("estado legado {ativo:true,ordem:[],atual:0} é entregue na entrada",
      entLegado?.ok === true && entLegado?.turnos?.ativo === true && (entLegado?.turnos?.ordem ?? []).length === 0,
      JSON.stringify(entLegado?.turnos).slice(0, 160));
    const iniLegado = await emitirCb(sockM, "mesa:turno", { sessionId: sidT, acao: "iniciativa", dados: 1 });
    t("iniciativa repara estado legado com ordem real",
      iniLegado.ok === true && iniLegado.turnos?.ativo === true && (iniLegado.turnos?.ordem ?? []).length >= 2 && iniLegado.turnos?.atual === 0,
      JSON.stringify(iniLegado.turnos).slice(0, 160));
    const avPos = await emitirCb(sockM, "mesa:turno", { sessionId: sidT, acao: "avancar" });
    t("controles de turno seguem funcionando após reparo", avPos.ok === true && avPos.turnos?.atual === 1, JSON.stringify(avPos.turnos).slice(0, 140));
  }

  // ===== Persistência após reinício =====
  sec("Persistência após reinício do servidor");
  {
    await encerrarServidor(proc);
    proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    await esperarSaudavel(BASE, proc);

    // reconexão: novo socket do mestre entra e recebe estado
    const sockM2 = conectar(cm);
    const r2 = await entrar(sockM2, sid);
    t("reconexão recebe sessão", r2.ok === true, JSON.stringify(r2).slice(0, 120));
    t("turnos persistem após restart", r2.turnos?.ativo === true && r2.turnos?.atual === 1, JSON.stringify(r2.turnos).slice(0, 140));

    // histórico de chat persistido: pedir mensagens via API? verificar no banco
    const nMsgs = comDb(BANCO, (db) => db.prepare("select count(*) c from chat_messages where session_id=?").get(sid).c);
    t("chat persistido no banco (≥5)", nMsgs >= 5, `n=${nMsgs}`);
    const nRols = comDb(BANCO, (db) => db.prepare("select count(*) c from rolls where session_id=?").get(sid).c);
    t("rolagens persistidas no banco (≥2)", nRols >= 2, `n=${nRols}`);
    sockM2.disconnect();
  }
} finally {
  try { sockM?.disconnect(); } catch { }
  try { sockJ1?.disconnect(); } catch { }
  try { sockJ2?.disconnect(); } catch { }
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
