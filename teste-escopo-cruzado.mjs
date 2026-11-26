// Testes — Issue #65 Fatia 0: negação cruzada de escopo.
// ADMIN global e GM de guilda SEM membership de campanha não acessam
// dados nem executam ações de campanha/mesa — o privilégio de um escopo
// nunca vaza para outro. Complementa (não duplica):
//   teste-guildas-admin.mjs      → IDOR entre guildas, multi-ADMIN
//   teste-permissao-tempo-real   → papéis DENTRO da campanha
//   teste-convite-cadastro.mjs   → isAdmin forjado no cadastro
//   teste-sessoes-conta.mjs      → hardening do ADMIN principal
// Banco temporário + migrations reais + servidor spawnado (teardown seguro).
import { connect, createServer } from "node:net";
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req, sessao, criarCenario, comDb, abrirDb,
} from "./teste-base.mjs";

const DIR = dirTeste("escopo-cruzado");
const BANCO = `${DIR}/mestre-rpg-teste.db`;

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Sonda TCP precisa: só ECONNREFUSED prova porta liberada. Timeout ou
// qualquer outro erro é ambíguo → retorna false (NÃO prova ausência).
function portaLiberada(portaAlvo, timeoutMs = 2000) {
  return new Promise((res) => {
    const s = connect({ host: "127.0.0.1", port: portaAlvo });
    const fim = (livre) => { try { s.destroy(); } catch { } res(livre); };
    s.setTimeout(timeoutMs, () => fim(false));
    s.once("connect", () => fim(false));
    s.once("error", (e) => fim(e?.code === "ECONNREFUSED"));
  });
}

// Pipes do servidor consumidos continuamente com buffers limitados:
// sem drenar stdout/stderr o filho pode bloquear com o pipe cheio;
// a retenção é só a cauda para diagnóstico de falhas.
const LOG_LIMITE = 200;
const logsServidor = { out: [], err: [] };
function consumirStream(stream, destino) {
  if (!stream) return;
  let resto = "";
  stream.on("data", (chunk) => {
    resto += String(chunk);
    const linhas = resto.split("\n");
    resto = linhas.pop() ?? "";
    for (const l of linhas) {
      if (l.trim()) { destino.push(l); if (destino.length > LOG_LIMITE) destino.shift(); }
    }
  });
}
function despejarLogs() {
  const cauda = (arr) => arr.slice(-15).join("\n");
  if (logsServidor.err.length) console.log("--- stderr do servidor (cauda) ---\n" + cauda(logsServidor.err));
  if (logsServidor.out.length) console.log("--- stdout do servidor (cauda) ---\n" + cauda(logsServidor.out));
}

const sockets = [];
function conectar(base, cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(base, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p) => new Promise((r) => {
  const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000);
  s.emit(ev, p, (x) => { clearTimeout(to); r(x); });
});

// Handles nullable: qualquer etapa de setup pode falhar antes de
// produzir porta/processo — o finally cobre todos os casos.
let porta = null;
let base = null;
let proc = null;

try {
  // Todo o setup (banco, porta, processo) acontece DENTRO do try:
  // uma falha em qualquer ponto ainda passa pelo finally — fixture,
  // porta e processo nunca ficam órfãos.
  await prepararBanco(BANCO);
  porta = await portaLivre();
  base = `http://127.0.0.1:${porta}`;
  proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  consumirStream(proc.stdout, logsServidor.out);
  consumirStream(proc.stderr, logsServidor.err);

  // Boot protegido: falha aqui ainda passa pelo finally.
  await esperarSaudavel(base, proc);
  sec("Cenário — campanha, sessão, ADMIN secundário e GM de guilda");
  const C = await criarCenario(base, BANCO, { jogadores: { jogador1: "esc_j1" } });
  const { campId, cookieMestre, adminId, jogadores, personagemMestre } = C;
  const j1mid = jogadores.jogador1.membershipId;
  const j1id = jogadores.jogador1.id;

  // sessão de jogo real (o mestre titular cria)
  const sess = await req(base, "POST", `/campaigns/${campId}/sessoes`, { cookie: cookieMestre, body: { nome: "Sessão Escopo" } });
  const sid = sess.json?.sessao?.id;
  t("sessão criada pelo mestre", sess.status === 201 && !!sid, JSON.stringify(sess.json).slice(0, 200));

  // ADMIN secundário: conta comum promovida pelo principal — SEM membership
  const mkAdmin = await req(base, "POST", "/admin/users", { cookie: cookieMestre, body: { username: "esc_admin2", password: "senha-forte-123", displayName: "Admin Dois" } });
  const admin2Id = mkAdmin.json?.usuario?.id;
  t("admin secundário criado", mkAdmin.status === 201 && !!admin2Id, JSON.stringify(mkAdmin.json).slice(0, 200));
  const promo = await req(base, "PATCH", `/admin/users/${admin2Id}`, { cookie: cookieMestre, body: { isAdmin: true } });
  t("principal promove a ADMIN", promo.status === 200, JSON.stringify(promo.json).slice(0, 200));
  const cookieAdmin2 = sessao(BANCO, admin2Id);

  // GM de guilda: usuário comum que funda a própria guilda — SEM membership
  const mkGm = await req(base, "POST", "/admin/users", { cookie: cookieMestre, body: { username: "esc_gm", password: "senha-forte-123", displayName: "GM Solto" } });
  const gmId = mkGm.json?.usuario?.id;
  const cookieGm = sessao(BANCO, gmId);
  const guilda = await req(base, "POST", "/guildas", { cookie: cookieGm, body: { name: "Guilda do GM Solto" } });
  const guildId = guilda.json?.guilda?.id;
  t("usuário comum funda guilda e vira GM", guilda.status === 201 && !!guildId && guilda.json?.guilda?.souGM === true, JSON.stringify(guilda.json).slice(0, 200));

  // controle: nenhum dos dois tem membership na campanha
  const db = abrirDb(BANCO);
  const membAdmin2 = db.prepare("select count(*) c from memberships where campaign_id=? and user_id=?").get(campId, admin2Id).c;
  const membGm = db.prepare("select count(*) c from memberships where campaign_id=? and user_id=?").get(campId, gmId).c;
  db.close();
  t("admin2 sem membership na campanha", membAdmin2 === 0);
  t("GM sem membership na campanha", membGm === 0);

  // O GM possui um membership legítimo em OUTRA campanha; isso prova que
  // autorização em um escopo de campanha não atravessa para a campanha-alvo.
  const outra = await req(base, "POST", "/campaigns", {
    cookie: cookieGm,
    body: { name: "Campanha do GM — outra" },
  });
  const outraCampId = outra.json?.campanha?.id ?? outra.json?.campaign?.id;
  t("GM cria outra campanha e recebe membership mestre",
    outra.status === 201 && !!outraCampId,
    JSON.stringify(outra.json).slice(0, 200));
  if (outraCampId) {
    const membOutra = comDb(BANCO, (db) => db.prepare(
      "select role, status from memberships where campaign_id=? and user_id=?"
    ).get(outraCampId, gmId));
    t("membership do GM existe somente na outra campanha",
      membOutra?.role === "mestre" && membOutra?.status === "ativo",
      JSON.stringify(membOutra));
  }

  // baseline de integridade: convites e memberships da campanha antes
  // das negações — os asserts do fim comparam com estes valores.
  const baseIntegridade = comDb(BANCO, (db) => ({
    convites: db.prepare("select count(*) c from invitations where campaign_id=?").get(campId).c,
    membros: db.prepare("select count(*) c from memberships where campaign_id=?").get(campId).c,
  }));

  sec("HTTP — ADMIN global sem membership é negado na campanha");
  t("GET /campaigns/:id → 403", (await req(base, "GET", `/campaigns/${campId}`, { cookie: cookieAdmin2 })).status === 403);
  t("GET /campaigns/:id/members → 403", (await req(base, "GET", `/campaigns/${campId}/members`, { cookie: cookieAdmin2 })).status === 403);
  t("GET /campaigns/:id/sessoes → 403", (await req(base, "GET", `/campaigns/${campId}/sessoes`, { cookie: cookieAdmin2 })).status === 403);
  t("GET sessoes/:sid/testes → 403", (await req(base, "GET", `/campaigns/${campId}/sessoes/${sid}/testes`, { cookie: cookieAdmin2 })).status === 403);
  t("GET sessoes/:sid/historico → 403", (await req(base, "GET", `/campaigns/${campId}/sessoes/${sid}/historico`, { cookie: cookieAdmin2 })).status === 403);
  t("PATCH membro da campanha → 403 (admin não concede papel de mesa)",
    (await req(base, "PATCH", `/campaigns/${campId}/members/${j1mid}`, { cookie: cookieAdmin2, body: { role: "mestre" } })).status === 403);
  t("POST invitations → 403", (await req(base, "POST", `/campaigns/${campId}/invitations`, { cookie: cookieAdmin2, body: { role: "jogador" } })).status === 403);
  t("GET personagem alheio → 403", personagemMestre
    ? (await req(base, "GET", `/characters/${personagemMestre}`, { cookie: cookieAdmin2 })).status === 403
    : true);
  // contraste positivo: o escopo ADMIN funciona onde deve
  t("GET /guildas?todas=1 → 200 (escopo ADMIN íntegro)", (await req(base, "GET", "/guildas?todas=1", { cookie: cookieAdmin2 })).status === 200);

  sec("HTTP — GM de guilda sem membership é negado na campanha");
  t("GET /campaigns/:id → 403", (await req(base, "GET", `/campaigns/${campId}`, { cookie: cookieGm })).status === 403);
  t("GET /campaigns/:id/members → 403", (await req(base, "GET", `/campaigns/${campId}/members`, { cookie: cookieGm })).status === 403);
  t("GET /campaigns/:id/sessoes → 403", (await req(base, "GET", `/campaigns/${campId}/sessoes`, { cookie: cookieGm })).status === 403);
  t("PATCH membro da campanha → 403 (GM não designa mestre)",
    (await req(base, "PATCH", `/campaigns/${campId}/members/${j1mid}`, { cookie: cookieGm, body: { role: "mestre" } })).status === 403);
  t("POST invitations → 403", (await req(base, "POST", `/campaigns/${campId}/invitations`, { cookie: cookieGm, body: { role: "jogador" } })).status === 403);
  t("PATCH /admin/users (forjar isAdmin) → 403",
    (await req(base, "PATCH", `/admin/users/${j1id}`, { cookie: cookieGm, body: { isAdmin: true } })).status === 403);
  // contraste positivo: o escopo GM funciona onde deve
  t("GET /guildas/:id → 200 (escopo GM íntegro)", (await req(base, "GET", `/guildas/${guildId}`, { cookie: cookieGm })).status === 200);

  sec("Socket — mesa exige membership de campanha, não privilégio de escopo");
  const sAdmin2 = conectar(base, cookieAdmin2);
  const sGm = conectar(base, cookieGm);
  const sMestre = conectar(base, cookieMestre);
  await Promise.all([pronto(sAdmin2), pronto(sGm), pronto(sMestre)]);
  t("sockets autenticam (escopo não é auth)", sAdmin2.connected && sGm.connected && sMestre.connected);

  const rEntrarM = await emitirCb(sMestre, "mesa:entrar", { sessionId: sid });
  t("controle: mestre entra na sessão", rEntrarM?.ok === true, JSON.stringify(rEntrarM));
  const rEntrarA = await emitirCb(sAdmin2, "mesa:entrar", { sessionId: sid });
  t("ADMIN sem membership NÃO entra na sessão", rEntrarA?.ok === false, JSON.stringify(rEntrarA));
  const rEntrarG = await emitirCb(sGm, "mesa:entrar", { sessionId: sid });
  t("GM sem membership NÃO entra na sessão", rEntrarG?.ok === false, JSON.stringify(rEntrarG));

  const pedirAdmin2 = await emitirCb(sAdmin2, "mesa:teste:pedir", {
    sessionId: sid, characterId: personagemMestre ?? "x", rotulo: "Teste", dadosLados: 20, dadosCount: 1,
  });
  t("ADMIN sem membership NÃO pede teste de mesa", pedirAdmin2?.ok === false, JSON.stringify(pedirAdmin2));
  const pedirGm = await emitirCb(sGm, "mesa:teste:pedir", {
    sessionId: sid, characterId: personagemMestre ?? "x", rotulo: "Teste", dadosLados: 20, dadosCount: 1,
  });
  t("GM sem membership NÃO pede teste de mesa", pedirGm?.ok === false, JSON.stringify(pedirGm));
  const msgAdmin2 = await emitirCb(sAdmin2, "mesa:mensagem", { sessionId: sid, content: "invasão" });
  t("ADMIN sem membership NÃO envia mensagem de mesa", msgAdmin2?.ok === false, JSON.stringify(msgAdmin2));
  const msgGm = await emitirCb(sGm, "mesa:mensagem", { sessionId: sid, content: "invasão" });
  t("GM sem membership NÃO envia mensagem de mesa", msgGm?.ok === false, JSON.stringify(msgGm));

  // integridade: as negações não gravaram nada
  const contTestes = comDb(BANCO, (db) => db.prepare("select count(*) c from tests where session_id=?").get(sid).c);
  t("nenhum teste gravado pelas tentativas negadas", contTestes === 0, `tests=${contTestes}`);
  const integridade = comDb(BANCO, (db) => ({
    convites: db.prepare("select count(*) c from invitations where campaign_id=?").get(campId).c,
    membros: db.prepare("select count(*) c from memberships where campaign_id=?").get(campId).c,
  }));
  t("convites inalterados após negações de invitations",
    integridade.convites === baseIntegridade.convites,
    `antes=${baseIntegridade.convites} depois=${integridade.convites}`);
  t("memberships inalterados após PATCH de papel negado",
    integridade.membros === baseIntegridade.membros,
    `antes=${baseIntegridade.membros} depois=${integridade.membros}`);

  sec("Fault injection — falha de setup/boot não deixa recurso órfão");
  {
    const DIR2 = dirTeste("escopo-cruzado-fail");
    const BANCO2 = `${DIR2}/mestre-rpg-teste.db`;
    let porta2 = null, proc2 = null, bloqueador = null;
    try {
      await prepararBanco(BANCO2);
      porta2 = await portaLivre();
      // Porta ocupada por um servidor oco ANTES do spawn: o app falha
      // no bind de forma determinística — injeção real de falha de boot.
      bloqueador = createServer();
      await new Promise((res, rej) => {
        bloqueador.once("error", rej);
        bloqueador.listen(porta2, "0.0.0.0", res);
      });
      proc2 = subirServidor(porta2, { banco: BANCO2, arquivos: `${DIR2}/arq`, backups: `${DIR2}/bks` });
      const morreu = await Promise.race([
        new Promise((r) => proc2.once("exit", () => r(true))),
        dormir(10000).then(() => false),
      ]);
      t("falha injetada: app morre ao não conseguir bind", morreu === true);
    } catch (e) {
      fail++;
      console.log("FALHOU fault injection (exceção):", String(e?.message ?? e).slice(0, 160));
    } finally {
      // Mesmo padrão do finally principal: teardown independente por
      // etapa — bloqueador, processo e fixture são limpos mesmo com
      // o setup ter falhado no meio.
      try { if (bloqueador) await new Promise((r) => bloqueador.close(() => r())); } catch { }
      try { await encerrarServidor(proc2); } catch { }
      if (porta2 !== null) {
        const livre = await portaLiberada(porta2);
        t("fault injection: porta liberada (ECONNREFUSED, sem órfão)", livre === true);
      }
      try {
        const limpo = limparDir(DIR2);
        t("fault injection: fixture removida mesmo após falha", limpo === true);
      } catch {
        fail++;
        console.log("FALHOU fault injection: limpeza lançou exceção");
      }
    }
  }
} catch (e) {
  // Exceção no corpo do teste vira falha registrada — o resumo final
  // continua sendo impresso e o erro original não é perdido.
  fail++;
  console.log("FALHOU exceção não tratada:", e?.stack ?? e);
} finally {
  // Teardown independente: falha em uma etapa não impede a outra e
  // nenhuma falha de limpeza mascara o resultado dos testes.
  let teardownFalhou = false;
  try {
    for (const s of sockets) s.disconnect();
  } catch (e) {
    teardownFalhou = true;
    console.error("[teardown] sockets:", e?.message ?? e);
  }
  try {
    await encerrarServidor(proc);
  } catch (e) {
    teardownFalhou = true;
    console.error("[teardown] servidor:", e?.message ?? e);
  }
  // Prova de ausência de recurso órfão: o processo precisa ter exit
  // real e a porta precisa recusar conexão (ECONNREFUSED) — timeout
  // ou erro ambíguo NÃO conta como prova.
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    teardownFalhou = true;
    console.error("[teardown] processo do servidor sem exit após encerrarServidor");
  }
  if (porta !== null) {
    const livre = await portaLiberada(porta);
    if (!livre) {
      teardownFalhou = true;
      console.error(`[teardown] porta ${porta} não comprovadamente liberada (sem ECONNREFUSED)`);
    }
  }
  try {
    if (!limparDir(DIR)) teardownFalhou = true;
  } catch (e) {
    teardownFalhou = true;
    console.error("[teardown] limpeza:", e?.message ?? e);
  }
  if (fail > 0) despejarLogs();
  if (teardownFalhou) fail++;
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
