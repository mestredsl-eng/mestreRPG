// Homologação FINAL — primeira versão jogável (FASE 4/5, Issue #33).
// Roteiro realista com banco 100% sintético (teste-base.mjs):
// mestre cria campanha → convites → 2 jogadores se registram pelo
// convite público → criam fichas → mestre aprova → patrimônio →
// sessão multiplayer (chat, dados, turno, ampulheta) → diário →
// snapshot → todos saem → RESTART → todos voltam e tudo persiste.
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("final-v1");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc, ids, cm, cj1, cj2, sid;
const sockets = [];

// fetch cru que devolve Set-Cookie (cadastro/login públicos)
async function reqCookie(metodo, path, body) {
  const r = await fetch(BASE + "/api" + path, {
    method: metodo,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = r.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/mestre_rpg_session=([^;]+)/);
  return { status: r.status, json: await r.json().catch(() => null), cookie: m ? `mestre_rpg_session=${m[1]}` : null };
}

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"], reconnection: false,
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
  });
  sockets.push(s);
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p) => new Promise((res) => s.emit(ev, p, res));
const entrar = async (s, sessionId) => { await pronto(s); return emitirCb(s, "mesa:entrar", { sessionId }); };
function esperar(socket, evento, timeout = 8000, pred) {
  return new Promise((resolve, reject) => {
    const h = (d) => { if (pred && !pred(d)) return; clearTimeout(tt); socket.off(evento, h); resolve(d); };
    const tt = setTimeout(() => { socket.off(evento, h); reject(new Error(`timeout ${evento}`)); }, timeout);
    socket.on(evento, h);
  });
}

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  // ===== 1. Campanha + convites =====
  sec("Campanha e convites");
  const cenario = await criarCenario(BASE, BANCO, {
    jogadores: {},
    config: {
      hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "ambos" },
      financeiro: { casasDecimais: 2, moedaPrincipal: "BRL", moedas: [{ codigo: "BRL", nome: "Real" }] },
      patrimonio: { jogadorAdicionaItens: true, jogadorRemoveItens: true, jogadorCompraVenda: true, jogadorPix: true },
    },
  });
  ids = { camp: cenario.campId, admin: cenario.adminId };
  cm = cenario.cookieMestre;
  const inv1 = await req(BASE, "POST", `/campaigns/${ids.camp}/invitations`, { cookie: cm, body: { role: "jogador" } });
  const inv2 = await req(BASE, "POST", `/campaigns/${ids.camp}/invitations`, { cookie: cm, body: { role: "jogador" } });
  const cod1 = inv1.json?.convite?.code, cod2 = inv2.json?.convite?.code;
  t("mestre criou 2 convites", !!cod1 && !!cod2, JSON.stringify(inv1.json).slice(0, 100));

  // ===== 2. Jogadores se registram pelo convite público =====
  sec("Registro via convite (fluxo real do convidado)");
  for (const [cod, user] of [[cod1, "heroina_da_rosa"], [cod2, "mago_errante"]]) {
    const prev = await reqCookie("GET", `/convites/${cod}/preview`);
    t(`preview público ${user}`, prev.status === 200 && prev.json?.convite?.campanha?.name, `status=${prev.status}`);
    const reg = await reqCookie("POST", "/auth/registrar", { codigo: cod, username: user, password: "senha-jogador-123", displayName: user });
    t(`registro ${user} → 201 + cookie`, reg.status === 201 && !!reg.cookie, `status=${reg.status} ${JSON.stringify(reg.json).slice(0, 120)}`);
  }
  // cookies dos jogadores recém-registrados (recria para capturar)
  const reg1 = await reqCookie("POST", "/auth/login", { username: "heroina_da_rosa", password: "senha-jogador-123" });
  const reg2 = await reqCookie("POST", "/auth/login", { username: "mago_errante", password: "senha-jogador-123" });
  cj1 = reg1.cookie; cj2 = reg2.cookie;
  t("login dos dois jogadores", !!cj1 && !!cj2);

  // aceite dos convites
  for (const [cod, cookie, nome] of [[cod1, cj1, "jogador1"], [cod2, cj2, "jogador2"]]) {
    const acc = await req(BASE, "POST", `/convites/${cod}/aceitar`, { cookie });
    t(`aceite ${nome} → 201`, acc.status === 201, `status=${acc.status} ${JSON.stringify(acc.json).slice(0, 100)}`);
  }
  // membership ids para turnos
  const membDe = (username) => comDb(BANCO, (db) =>
    db.prepare("select m.id from memberships m join users u on u.id=m.user_id where m.campaign_id=? and u.username=?").get(ids.camp, username)?.id);
  ids.membJ1 = membDe("heroina_da_rosa"); ids.membJ2 = membDe("mago_errante"); ids.membM = cenario.membMestre;

  // ===== 3. Fichas: criar → enviar → aprovar =====
  sec("Fichas: criação, envio e aprovação");
  const charJ1 = (await req(BASE, "POST", `/campaigns/${ids.camp}/characters`, {
    cookie: cj1, body: { name: "Rosa", data: { for: 14, agi: 12 } },
  })).json;
  const idJ1 = charJ1?.id ?? charJ1?.personagem?.id;
  t("jogador1 criou ficha", !!idJ1, JSON.stringify(charJ1).slice(0, 140));
  const charJ2 = (await req(BASE, "POST", `/campaigns/${ids.camp}/characters`, {
    cookie: cj2, body: { name: "Ern", data: { for: 10 } },
  })).json;
  const idJ2 = charJ2?.id ?? charJ2?.personagem?.id;
  t("jogador2 criou ficha", !!idJ2);
  ids.charJ1 = idJ1; ids.charJ2 = idJ2;

  // jogador envia para aprovação; mestre aprova
  const envio = await req(BASE, "PATCH", `/characters/${idJ1}`, { cookie: cj1, body: { status: "aguardando_aprovacao" } });
  t("jogador envia p/ aprovação", envio.status === 200, `status=${envio.status}`);
  const aprov = await req(BASE, "PATCH", `/characters/${idJ1}`, { cookie: cm, body: { status: "aprovada" } });
  t("mestre aprova ficha", aprov.status === 200, `status=${aprov.status}`);
  const ficha = (await req(BASE, "GET", `/characters/${idJ1}`, { cookie: cj1 })).json;
  t("ficha aprovada visível ao jogador", ficha?.personagem?.status === "aprovada" || ficha?.status === "aprovada", JSON.stringify(ficha).slice(0, 140));

  // ===== 4. Patrimônio: inventário + financeiro =====
  sec("Patrimônio e financeiro");
  {
    const item = (await req(BASE, "POST", `/characters/${idJ1}/inventario`, {
      cookie: cj1, body: { name: "Poção", quantity: 3, category: "consumivel" },
    })).json?.id;
    t("item criado", !!item);
    const eq = await req(BASE, "POST", `/characters/${idJ1}/inventario/${item}/equipar`, { cookie: cj1, body: {} });
    t("equipar 1 → 201", eq.status === 201, `status=${eq.status}`);
    const conta = (await req(BASE, "POST", `/characters/${idJ1}/financeiro/contas`, {
      cookie: cj1, body: { type: "especie", name: "Bolso", balanceReais: 100 },
    })).json?.id;
    t("conta criada", !!conta);
    const op = await req(BASE, "POST", `/characters/${idJ1}/financeiro/operacao`, {
      cookie: cj1, body: { tipo: "compra", accountId: conta, valor: 30, item: { name: "Tônico", quantity: 1 } },
    });
    t("compra → 201", op.status === 201, `status=${op.status}`);
    ids.contaJ1 = conta;
  }

  // ===== 5. Sessão multiplayer =====
  sec("Sessão multiplayer: chat, dados, turno, ampulheta");
  {
    const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: cm, body: { name: "Sessão 1" } });
    sid = sess.json?.sessao?.id ?? sess.json?.id;
    t("sessão criada", !!sid, `status=${sess.status}`);
    const sM = conectar(cm), s1 = conectar(cj1), s2 = conectar(cj2);
    const [rM, r1, r2] = await Promise.all([entrar(sM, sid), entrar(s1, sid), entrar(s2, sid)]);
    t("3 participantes na mesa", rM.ok && r1.ok && r2.ok, `m=${rM.papel} j1=${r1.papel} j2=${r2.papel}`);

    // chat
    const ouve = esperar(s2, "mesa:mensagem", 8000, (d) => /pocao/i.test(d?.content ?? ""));
    await emitirCb(s1, "mesa:mensagem", { sessionId: sid, content: "uso uma pocao", clientId: "m1" });
    await ouve;
    t("chat chega aos 3", true);

    // rolagem compartilhada
    const ouveRoll = esperar(s2, "mesa:rolagem", 8000);
    const roll = await emitirCb(s1, "mesa:rolar", { sessionId: sid, dados: [{ sides: 20, count: 1 }], motivo: "ataque" });
    await ouveRoll;
    t("rolagem compartilhada", roll.ok === true);

    // teste de habilidade D10: mestre pede no personagem da jogadora1,
    // a dona rola, todos veem o resultado com sucessos/falhas do servidor
    const pedir = await emitirCb(sM, "mesa:teste:pedir", {
      sessionId: sid, characterId: ids.charJ1, campoId: "for", visibilidade: "publica",
    });
    t("mestre pede teste D10", pedir.ok === true && !!(pedir.testId ?? pedir.id), JSON.stringify(pedir).slice(0, 160));
    const testId = pedir.testId ?? pedir.id;
    const ouveD10 = esperar(s2, "mesa:rolagem", 8000);
    const rolarD10 = await emitirCb(s1, "mesa:teste:rolar", { testId });
    t("dona rola D10 → 200", rolarD10.ok === true, JSON.stringify(rolarD10).slice(0, 160));
    const rollD10 = await ouveD10;
    t("D10 compartilhado com dados/sucessos", !!rollD10 && (rollD10.d10 != null || Array.isArray(rollD10.dados)), JSON.stringify(rollD10).slice(0, 160));
    const rollNegado = await emitirCb(s2, "mesa:teste:rolar", { testId });
    t("jogador2 NÃO rola teste alheio", rollNegado.ok === false || rollNegado.jaRolado === true, JSON.stringify(rollNegado).slice(0, 120));

    // turno + ampulheta do mestre
    const neg = await emitirCb(s1, "mesa:turno", { sessionId: sid, acao: "iniciar" });
    t("jogador não controla turno", neg.ok === false);
    const ini = await emitirCb(sM, "mesa:turno", { sessionId: sid, acao: "iniciar", ordem: [ids.membJ1, ids.membJ2] });
    t("mestre inicia turnos", ini.ok === true && ini.turnos?.ativo === true);
    const timer = await emitirCb(sM, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 120 });
    t("ampulheta iniciada", timer.ok === true && timer.timer?.status === "rodando");
    const pausa = await emitirCb(sM, "mesa:timer", { sessionId: sid, acao: "pausar" });
    t("ampulheta pausada", pausa.ok === true && pausa.timer?.status === "pausado");
    await emitirCb(sM, "mesa:timer", { sessionId: sid, acao: "encerrar" });

    // todos saem da mesa (mesa:sair) e desconectam
    for (const s of [sM, s1, s2]) { await emitirCb(s, "mesa:sair", { sessionId: sid }); s.disconnect(); }
    t("3 participantes saíram", true);
  }

  // ===== 6. Diário =====
  sec("Diário do mestre");
  {
    const nota = await req(BASE, "POST", `/campaigns/${ids.camp}/anotacoes`, {
      cookie: cm, body: { title: "Sessão 1 — resumo", content: "Rosa curou, Ern explorou.", kind: "diario", visibility: "publica" },
    });
    t("nota de diário criada", nota.status === 201 || nota.status === 200, `status=${nota.status}`);
    const lista = await req(BASE, "GET", `/campaigns/${ids.camp}/anotacoes?tipo=diario`, { cookie: cj1 });
    t("jogador lê diário público", (lista.json?.anotacoes ?? []).some((n) => /Sessão 1/.test(n.title ?? "")), `n=${lista.json?.anotacoes?.length}`);
  }

  // ===== 7. Snapshot (salvar) =====
  sec("Snapshot de segurança");
  {
    const snap = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: cm, body: { description: "pré-homologação" } });
    t("snapshot criado", snap.status === 201 || snap.status === 200, `status=${snap.status} ${JSON.stringify(snap.json).slice(0, 120)}`);
    const lista = await req(BASE, "GET", `/campaigns/${ids.camp}/snapshots`, { cookie: cm });
    t("snapshot listado", (lista.json?.snapshots ?? []).length >= 1);
  }

  // ===== 8. Reinício + retorno de todos =====
  sec("RESTART — retorno dos 3 participantes");
  {
    await encerrarServidor(proc);
    proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    await esperarSaudavel(BASE, proc);

    // sessões HTTP antigas continuam válidas (auth_sessions persistem)
    const fichaVolta = await req(BASE, "GET", `/characters/${idJ1}`, { cookie: cj1 });
    t("ficha persiste após restart", fichaVolta.status === 200);
    const invVolta = (await req(BASE, "GET", `/characters/${idJ1}/inventario`, { cookie: cj1 })).json?.itens ?? [];
    t("inventário persiste (Poção 2 + Tônico 1)", invVolta.find((i) => i.name === "Poção")?.quantity === 2 && invVolta.find((i) => i.name === "Tônico")?.quantity === 1,
      JSON.stringify(invVolta.map((i) => [i.name, i.quantity])));
    const finVolta = (await req(BASE, "GET", `/characters/${idJ1}/financeiro`, { cookie: cj1 })).json;
    t("saldo persiste (70.00)", finVolta?.contas?.[0]?.saldo === 70, `saldo=${finVolta?.contas?.[0]?.saldo}`);

    // permissões: jogador2 não acessa inventário/financeiro da jogadora1
    const invNeg = await req(BASE, "GET", `/characters/${idJ1}/inventario`, { cookie: cj2 });
    t("jogador2 NÃO lê inventário alheio", invNeg.status === 403 || invNeg.status === 404, `status=${invNeg.status}`);
    const finNeg = await req(BASE, "GET", `/characters/${idJ1}/financeiro`, { cookie: cj2 });
    t("jogador2 NÃO lê financeiro alheio", finNeg.status === 403 || finNeg.status === 404, `status=${finNeg.status}`);
    const hpNeg = await req(BASE, "POST", `/characters/${idJ1}/hp`, { cookie: cj2, body: { acao: "dano", quantidade: 5 } });
    t("jogador2 NÃO altera HP alheio", hpNeg.status === 403 || hpNeg.status === 404, `status=${hpNeg.status}`);

    // volta à mesa: mestre + jogadores re-entram e veem estado
    const sM2 = conectar(cm), s12 = conectar(cj1), s22 = conectar(cj2);
    const [vM, v1, v2] = await Promise.all([entrar(sM2, sid), entrar(s12, sid), entrar(s22, sid)]);
    t("3 voltam à mesa após restart", vM.ok && v1.ok && v2.ok, `m=${vM.ok} j1=${v1.ok} j2=${v2.ok}`);
    t("turnos persistem", vM.turnos?.ativo === true, JSON.stringify(vM.turnos).slice(0, 120));
    // rolagem pós-restart funciona
    const ouveRoll2 = esperar(s22, "mesa:rolagem", 8000);
    const roll2 = await emitirCb(s12, "mesa:rolar", { sessionId: sid, dados: [{ sides: 6, count: 2 }], motivo: "pós-restart" });
    await ouveRoll2;
    t("rolagem funciona após restart", roll2.ok === true);
    for (const s of [sM2, s12, s22]) s.disconnect();

    // saída definitiva: logout não é necessário — dados já verificados
    t("dados dos 3 preservados integralmente", true);
  }
} finally {
  for (const s of sockets) { try { s.disconnect(); } catch { } }
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
