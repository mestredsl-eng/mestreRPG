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
let proc, ids, cm, cj1, cj2, sid, testId;
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
      dados: { d10SucessoMinimo: 7 },
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

  // jogador2 percorre o mesmo ciclo completo: criar → enviar → aprovar → consultar
  const envio2 = await req(BASE, "PATCH", `/characters/${idJ2}`, { cookie: cj2, body: { status: "aguardando_aprovacao" } });
  t("jogador2 envia p/ aprovação", envio2.status === 200, `status=${envio2.status}`);
  const aprov2 = await req(BASE, "PATCH", `/characters/${idJ2}`, { cookie: cm, body: { status: "aprovada" } });
  t("mestre aprova ficha de J2", aprov2.status === 200, `status=${aprov2.status}`);
  const ficha2 = (await req(BASE, "GET", `/characters/${idJ2}`, { cookie: cj2 })).json;
  t("ficha de J2 aprovada visível ao dono", ficha2?.personagem?.status === "aprovada" || ficha2?.status === "aprovada", JSON.stringify(ficha2).slice(0, 140));

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
    ids.contaJ1 = conta; ids.itemJ1 = item;
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

    // chat: listener instalado nos TRÊS sockets antes do envio;
    // cada participante precisa receber a mensagem de verdade
    const ouveM = esperar(sM, "mesa:mensagem", 8000, (d) => /pocao/i.test(d?.content ?? ""));
    const ouve1 = esperar(s1, "mesa:mensagem", 8000, (d) => /pocao/i.test(d?.content ?? ""));
    const ouve2 = esperar(s2, "mesa:mensagem", 8000, (d) => /pocao/i.test(d?.content ?? ""));
    const enviou = await emitirCb(s1, "mesa:mensagem", { sessionId: sid, content: "uso uma pocao", clientId: "m1" });
    const [msgM, msg1, msg2] = await Promise.all([ouveM, ouve1, ouve2]);
    t("chat chega aos 3", enviou.ok === true && !!msgM && !!msg1 && !!msg2,
      `envio=${JSON.stringify(enviou)} recebidos=${!!msgM},${!!msg1},${!!msg2}`);

    // rolagem compartilhada
    const ouveRoll = esperar(s2, "mesa:rolagem", 8000);
    const roll = await emitirCb(s1, "mesa:rolar", { sessionId: sid, dados: [{ sides: 20, count: 1 }], motivo: "ataque" });
    await ouveRoll;
    t("rolagem compartilhada", roll.ok === true);

    // cobertura de dados livres: D4, D6, D8, D10 e D20 numa única rolagem
    const ouveDados = esperar(s2, "mesa:rolagem", 8000);
    const livres = await emitirCb(s1, "mesa:rolar", {
      sessionId: sid, motivo: "cobertura D4-D20",
      dados: [
        { sides: 4, count: 2 }, { sides: 6, count: 2 }, { sides: 8, count: 2 },
        { sides: 10, count: 2 }, { sides: 20, count: 2 },
      ],
    });
    const rollDados = await ouveDados;
    t("rolagem D4/D6/D8/D10/D20 → ok", livres.ok === true, JSON.stringify(livres).slice(0, 160));
    const ladosEsperados = [4, 6, 8, 10, 20];
    const gruposRoll = rollDados?.grupos ?? [];
    t("grupos com lados e quantidades corretos",
      gruposRoll.length === 5 && gruposRoll.every((g, i) =>
        g.lados === ladosEsperados[i] && g.resultados.length === 2
        && g.resultados.every((v) => Number.isInteger(v) && v >= 1 && v <= g.lados)),
      JSON.stringify(gruposRoll).slice(0, 220));
    const somaGrupos = gruposRoll.reduce((s, g) => s + g.resultados.reduce((a, b) => a + b, 0), 0);
    t("total = soma dos resultados", rollDados?.total === somaGrupos, `total=${rollDados?.total} soma=${somaGrupos}`);

    // lançador D10 livre: 5 positivos − 2 negativos = 3 dados, mínimo 7
    const ouveD10L = esperar(s2, "mesa:rolagem", 8000);
    const d10L = await emitirCb(s1, "mesa:rolar", {
      sessionId: sid, dados: [{ sides: 10, count: 3 }],
      d10: { positivos: 5, negativos: 2, minimo: 7 }, motivo: "lançador D10",
    });
    t("lançador D10 → ok", d10L.ok === true, JSON.stringify(d10L).slice(0, 160));
    const rollD10L = await ouveD10L;
    const d10Livre = d10L.d10 ?? rollD10L?.d10;
    t("D10 livre: positivo/negativo/mínimo registrados",
      d10Livre?.positivos === 5 && d10Livre?.negativos === 2 && d10Livre?.minimo === 7, JSON.stringify(d10Livre));
    const resD10 = d10L.grupos?.[0]?.resultados ?? [];
    t("D10 livre: 3 dados efetivos dentro de 1–10",
      d10Livre?.lancados === 3 && resD10.length === 3 && resD10.every((v) => v >= 1 && v <= 10), JSON.stringify(resD10));
    const sucD10 = resD10.filter((v) => v >= 7).length;
    t("D10 livre: sucessos/falhas coerentes", d10Livre?.sucessos === sucD10 && d10Livre?.falhas === 3 - sucD10, JSON.stringify(d10Livre));

    // teste de habilidade D10 (campo "for" → 14d10, mínimo da campanha = 7):
    // mestre pede para J1; J2 NÃO pode rolar; J1 rola; servidor calcula.
    const pedir = await emitirCb(sM, "mesa:teste:pedir", {
      sessionId: sid, characterId: ids.charJ1, campoId: "for", visibilidade: "publica",
    });
    testId = pedir.testId ?? pedir.id;
    t("mestre pede teste D10", pedir.ok === true && !!testId, JSON.stringify(pedir).slice(0, 160));

    // J2 tenta rolar ANTES da dona — tem que falhar por autorização
    const negAntes = await emitirCb(s2, "mesa:teste:rolar", { testId });
    t("J2 rolar antes de J1 → negado por autorização",
      negAntes.ok === false && negAntes.erro && !negAntes.jaRolado, JSON.stringify(negAntes).slice(0, 140));
    const stPendente = comDb(BANCO, (db) => db.prepare("select status from tests where id=?").get(testId)?.status);
    t("teste continua pendente após tentativa de J2", stPendente === "pendente", `status=${stPendente}`);

    // dona rola — resultado compartilhado com cálculo D10 do servidor
    const ouveD10 = esperar(s2, "mesa:rolagem", 8000, (d) => d?.testId === testId);
    const rolarD10 = await emitirCb(s1, "mesa:teste:rolar", { testId });
    t("dona rola D10 → ok", rolarD10.ok === true, JSON.stringify(rolarD10).slice(0, 160));
    const rollD10 = await ouveD10;
    const d10Calc = rolarD10.d10 ?? rollD10?.d10;
    t("D10 presente com minimo/lancados/sucessos/falhas",
      !!d10Calc && d10Calc.minimo === 7 && Number.isInteger(d10Calc.lancados)
        && Number.isInteger(d10Calc.sucessos) && Number.isInteger(d10Calc.falhas),
      JSON.stringify(d10Calc));
    const dadosD10 = rolarD10.dados ?? rollD10?.dados ?? [];
    t("lancados = dados efetivamente lançados, todos em 1–10",
      d10Calc?.lancados === dadosD10.length && dadosD10.length === 14
        && dadosD10.every((v) => Number.isInteger(v) && v >= 1 && v <= 10),
      `lancados=${d10Calc?.lancados} dados=${dadosD10.length}`);
    const sucCalc = dadosD10.filter((v) => v >= 7).length;
    t("sucessos/falhas batem com resultados e mínimo da campanha",
      d10Calc?.sucessos === sucCalc && d10Calc?.falhas === dadosD10.length - sucCalc,
      `min=${d10Calc?.minimo} esperado=${sucCalc} obtido=${d10Calc?.sucessos}`);
    const stRolado = comDb(BANCO, (db) => db.prepare("select status from tests where id=?").get(testId)?.status);
    t("teste passa para rolado no banco", stRolado === "rolado", `status=${stRolado}`);
    const negDepois = await emitirCb(s2, "mesa:teste:rolar", { testId });
    t("J2 continua sem autorização mesmo após rolado", negDepois.ok === false, JSON.stringify(negDepois).slice(0, 120));

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

    // todos saem da mesa — callback mesa:sair de cada socket tem que confirmar
    const saidas = await Promise.all([sM, s1, s2].map((s) => emitirCb(s, "mesa:sair", { sessionId: sid })));
    t("3 participantes saíram (callbacks confirmados)", saidas.every((r) => r?.ok === true),
      JSON.stringify(saidas));
    for (const s of [sM, s1, s2]) s.disconnect();
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

  // ===== 7. Snapshot: criar → alterar → restaurar → conferir =====
  sec("Snapshot de segurança e restauração");
  let snapId;
  {
    const snap = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots`, { cookie: cm, body: { description: "pré-homologação" } });
    snapId = snap.json?.snapshot?.id ?? snap.json?.id;
    t("snapshot criado", snap.status === 201 || snap.status === 200, `status=${snap.status} ${JSON.stringify(snap.json).slice(0, 120)}`);
    const lista = await req(BASE, "GET", `/campaigns/${ids.camp}/snapshots`, { cookie: cm });
    t("snapshot listado", (lista.json?.snapshots ?? []).some((s) => s.id === snapId));

    // altera dado persistido via API: quantidade do item Poção 2 → 5
    const patch = await req(BASE, "PATCH", `/characters/${idJ1}/inventario/${ids.itemJ1}`, {
      cookie: cm, body: { quantity: 5 },
    });
    t("alteração persistida via API", patch.status === 200, `status=${patch.status} ${JSON.stringify(patch.json).slice(0, 120)}`);
    const invAlt = (await req(BASE, "GET", `/characters/${idJ1}/inventario`, { cookie: cj1 })).json?.itens ?? [];
    t("quantidade alterada para 5", invAlt.find((i) => i.id === ids.itemJ1)?.quantity === 5, JSON.stringify(invAlt.map((i) => [i.name, i.quantity])));

    // restaura o snapshot pela API real (exige confirmação literal)
    const rest = await req(BASE, "POST", `/campaigns/${ids.camp}/snapshots/${snapId}/restaurar`, {
      cookie: cm, body: { confirmacao: "RESTAURAR" },
    });
    t("restauração executada pela API", rest.status === 200 && rest.json?.ok === true && !!rest.json?.preSnapshotId,
      `status=${rest.status} ${JSON.stringify(rest.json).slice(0, 160)}`);

    const invVolta = (await req(BASE, "GET", `/characters/${idJ1}/inventario`, { cookie: cj1 })).json?.itens ?? [];
    t("dado original restaurado (Poção volta a 2)", invVolta.find((i) => i.id === ids.itemJ1)?.quantity === 2,
      JSON.stringify(invVolta.map((i) => [i.name, i.quantity])));

    // snapshot automático pré-restauração foi criado
    const lista2 = await req(BASE, "GET", `/campaigns/${ids.camp}/snapshots`, { cookie: cm });
    const snaps = lista2.json?.snapshots ?? [];
    const auto = snaps.find((s) => s.id === rest.json?.preSnapshotId);
    t("snapshot automático pré-restauração existe", !!auto && /Automático/i.test(auto.description ?? ""),
      JSON.stringify(snaps.map((s) => [s.id, s.description])).slice(0, 200));
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

    // ===== conferência integral dos dados preservados (nada de assert fixo) =====
    sec("Conferência integral pós-restart");

    // 1) os 3 continuam membros ativos da campanha
    const membros = comDb(BANCO, (db) => db.prepare(
      "select u.username, m.role, m.status from memberships m join users u on u.id=m.user_id where m.campaign_id=? order by u.username",
    ).all(ids.camp));
    t("3 membros ativos (mestre + 2 jogadores)",
      membros.length === 3 && membros.every((m) => m.status === "ativo")
        && membros.some((m) => m.role === "mestre") && membros.filter((m) => m.role === "jogador").length === 2,
      JSON.stringify(membros));

    // 2) os dois personagens continuam acessíveis aos respectivos donos
    const fichaJ1 = await req(BASE, "GET", `/characters/${idJ1}`, { cookie: cj1 });
    const fichaJ2 = await req(BASE, "GET", `/characters/${idJ2}`, { cookie: cj2 });
    t("ficha J1 acessível ao dono", fichaJ1.status === 200);
    t("ficha J2 acessível ao dono e aprovada", fichaJ2.status === 200
      && (fichaJ2.json?.personagem?.status === "aprovada" || fichaJ2.json?.status === "aprovada"));

    // 3) sessão continua disponível + turnos preservados (via endpoint de estado)
    const estado = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/estado`, { cookie: cm });
    t("sessão disponível após restart", estado.status === 200 && !!estado.json?.sessao, `status=${estado.status}`);
    t("turnos preservados", estado.json?.turnos?.ativo === true, JSON.stringify(estado.json?.turnos).slice(0, 140));

    // 4) histórico de mensagens, testes e rolagens preservado (API real)
    const hist = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/historico`, { cookie: cm });
    const hj = hist.json ?? {};
    t("histórico: chat preservado", (hj.eventos ?? []).some((e) => /uso uma pocao/i.test(e.content ?? "")), `eventos=${hj.eventos?.length}`);
    t("histórico: teste D10 rolado preservado",
      (hj.testes ?? []).some((x) => x.id === testId && x.status === "rolado"), `testes=${hj.testes?.length}`);
    t("histórico: rolagens preservadas", (hj.rolagens ?? []).length >= 5, `rolagens=${hj.rolagens?.length}`);

    // 5) inventário e saldo continuam corretos (já conferidos acima — reafirma Tônico)
    const invFinal = (await req(BASE, "GET", `/characters/${idJ1}/inventario`, { cookie: cj1 })).json?.itens ?? [];
    t("inventário final íntegro (Poção 2 + Tônico 1)",
      invFinal.find((i) => i.name === "Poção")?.quantity === 2 && invFinal.find((i) => i.name === "Tônico")?.quantity === 1);

    // 6) permissões continuam funcionando após restart
    const hpNeg2 = await req(BASE, "POST", `/characters/${idJ2}/hp`, { cookie: cj1, body: { acao: "dano", quantidade: 5 } });
    t("J1 não altera HP de J2", hpNeg2.status === 403 || hpNeg2.status === 404, `status=${hpNeg2.status}`);
  }
} finally {
  for (const s of sockets) { try { s.disconnect(); } catch { } }
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
