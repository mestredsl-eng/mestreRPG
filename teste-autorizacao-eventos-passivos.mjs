// Testes — Issue #65 PR-B: eventos passivos e isolamento por papel (G3+G4).
// G3: rebaixamento mestre→espectador com socket dentro da sessão — prova
//     que eventos mestre-only (mesa:teste:detalhe, versão admin de
//     mesa:teste com `alvo`) deixam de chegar e que ações de mestre
//     passam a ser negadas, sem derrubar a participação legítima.
// G4: room `campanha:{id}` — mapeia os emissores reais (emitirCampanha
//     em routes/* e o atalho de mesa:mensagem sem sessão) e prova que
//     o espectador recebe somente invalidações públicas, nunca payload
//     restrito (sem alvo/target/conteúdo privado).
// Complementa (não duplica):
//   teste-autorizacao-negativa.mjs → G1/G2/G5/G6/G7 (negação+revogação)
//   teste-mesa-seguranca.mjs      → papéis dentro da sessão de mesa
//   teste-permissao-tempo-real    → propagação de permissão
// Banco temporário + migrations reais + servidor spawnado (teardown seguro).
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req, sessao, criarCenario, comDb, abrirDb,
} from "./teste-base.mjs";

const DIR = dirTeste("autorizacao-eventos-passivos");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
await prepararBanco(BANCO);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

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
/** Registra listener ANTES da ação; resolve com o payload ou null no timeout. */
function esperarEvento(s, nome, ms = 5000) {
  return new Promise((res) => {
    const to = setTimeout(() => { s.off(nome, h); res(null); }, ms);
    const h = (d) => { clearTimeout(to); s.off(nome, h); res(d); };
    s.on(nome, h);
  });
}

const porta = await portaLivre();
const base = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
consumirStream(proc.stdout, logsServidor.out);
consumirStream(proc.stderr, logsServidor.err);

try {
  await esperarSaudavel(base, proc);
  sec("Cenário — mestre titular + segundo mestre + espectador");
  const C = await criarCenario(base, BANCO, { jogadores: { jogador1: "esp_j1", jogador2: "mestre_j2" } });
  const { adminId, campId, cookieMestre, jogadores, personagemMestre, membMestre } = C;
  const j1 = jogadores.jogador1, j2 = jogadores.jogador2;

  // j2 promovido a mestre (dois mestres ativos → rebaixamento do titular é legal)
  const promo = await req(base, "PATCH", `/campaigns/${campId}/members/${j2.membershipId}`, { cookie: cookieMestre, body: { role: "mestre" } });
  t("jogador2 promovido a mestre", promo.status === 200, `status=${promo.status}`);

  // j1 rebaixado a espectador (mesmo vínculo ativo, papel menor)
  const rebaixa = await req(base, "PATCH", `/campaigns/${campId}/members/${j1.membershipId}`, { cookie: cookieMestre, body: { role: "espectador" } });
  t("jogador1 rebaixado a espectador", rebaixa.status === 200, `status=${rebaixa.status}`);

  const sess = await req(base, "POST", `/campaigns/${campId}/sessoes`, { cookie: cookieMestre, body: { nome: "Sessão Papéis" } });
  const sid = sess.json?.sessao?.id;
  t("sessão criada", !!sid);

  const sM1 = conectar(base, cookieMestre);   // mestre titular (será rebaixado)
  const sM2 = conectar(base, j2.cookie);      // segundo mestre
  const sEsp = conectar(base, j1.cookie);     // espectador
  await Promise.all([pronto(sM1), pronto(sM2), pronto(sEsp)]);

  const [rM1, rM2, rEsp] = await Promise.all([
    emitirCb(sM1, "mesa:entrar", { sessionId: sid }),
    emitirCb(sM2, "mesa:entrar", { sessionId: sid }),
    emitirCb(sEsp, "mesa:entrar", { sessionId: sid }),
  ]);
  t("três papéis entram na sessão", rM1?.ok === true && rM2?.ok === true && rEsp?.ok === true,
    JSON.stringify({ m1: rM1, m2: rM2, esp: rEsp }));

  // ---------- G3 — rebaixamento durante sessão ativa ----------
  sec("G3 — mestre rebaixado a espectador com socket dentro da sessão");

  // listeners registrados ANTES de qualquer emissão
  const detM1 = []; const testeM1 = [];
  sM1.on("mesa:teste:detalhe", (d) => detM1.push(d));
  sM1.on("mesa:teste", (d) => testeM1.push(d));

  // controle 1: enquanto M1 é mestre, o evento mestre-only chega
  const evDet1 = esperarEvento(sM1, "mesa:teste:detalhe", 5000);
  const pedir1 = await emitirCb(sM2, "mesa:teste:pedir", {
    sessionId: sid, characterId: personagemMestre, rotulo: "controle-mestre",
    dadosLados: 20, dadosCount: 1, minimo: 15,
  });
  const detRecebido = await evDet1;
  t("controle: mesa:teste:detalhe chega ao mestre ANTES do rebaixamento",
    pedir1?.ok === true && detRecebido !== null && detRecebido.alvo === 15,
    `pedir=${JSON.stringify(pedir1)} detalhe=${JSON.stringify(detRecebido)}`);

  // rebaixa M1 para espectador (J2, agora mestre, executa o PATCH)
  const down = await req(base, "PATCH", `/campaigns/${campId}/members/${membMestre}`, { cookie: j2.cookie, body: { role: "espectador" } });
  t("mestre titular rebaixado a espectador", down.status === 200, `status=${down.status}`);
  const papelDepois = comDb(BANCO, (db) => db.prepare("select role r from memberships where id=?").get(membMestre).r);
  t("readback: papel efetivo = espectador", papelDepois === "espectador", papelDepois);

  // nova solicitação de teste pelo mestre restante
  const antesDetalhe = detM1.length, antesTeste = testeM1.length;
  const pedir2 = await emitirCb(sM2, "mesa:teste:pedir", {
    sessionId: sid, characterId: personagemMestre, rotulo: "pos-rebaixamento",
    dadosLados: 20, dadosCount: 1, minimo: 18,
  });
  await dormir(700); // janela de entrega dos eventos passivos
  t("pedido de teste do mestre funciona", pedir2?.ok === true, JSON.stringify(pedir2));
  t("ex-mestre NÃO recebe mesa:teste:detalhe após rebaixamento",
    detM1.length === antesDetalhe, `antes=${antesDetalhe} depois=${detM1.length}`);
  {
    const novos = testeM1.slice(antesTeste);
    const comAlvo = novos.filter((d) => d && typeof d === "object" && "alvo" in d);
    t("ex-mestre recebe no máximo a versão pública de mesa:teste (sem `alvo`)",
      comAlvo.length === 0, `recebidos=${novos.length} comAlvo=${comAlvo.length}`);
  }

  // ações de mestre negadas ao ex-mestre (socket ainda conectado)
  const pedirEsp = await emitirCb(sM1, "mesa:teste:pedir", {
    sessionId: sid, characterId: personagemMestre, rotulo: "tentativa",
    dadosLados: 20, dadosCount: 1,
  });
  t("ex-mestre NÃO pede teste (papel revalidado)", pedirEsp?.ok === false, JSON.stringify(pedirEsp));
  const msgPriv = await emitirCb(sM1, "mesa:mensagem", {
    sessionId: sid, content: "privada", visibilidade: "privada", destinatarioUserId: j2.id,
  });
  t("ex-mestre (espectador) NÃO envia mensagem privada", msgPriv?.ok === false, JSON.stringify(msgPriv));

  // participação legítima preservada: mensagem pública do mestre chega
  const evPub = esperarEvento(sM1, "mesa:mensagem", 5000);
  await emitirCb(sM2, "mesa:mensagem", { sessionId: sid, content: "pub-pos-rebaixamento", visibilidade: "publica" });
  const pubRecebida = await evPub;
  t("ex-mestre ainda recebe mensagem pública da sessão (é membro ativo)",
    pubRecebida !== null && /pub-pos-rebaixamento/.test(pubRecebida?.content ?? ""),
    JSON.stringify(pubRecebida)?.slice(0, 160));

  // ---------- G4 — room campanha:{id} ----------
  sec("G4 — room campanha:* carrega só invalidações públicas");
  // entrar-campanha valida membership ativa — os três papéis entram
  // entrar-campanha recebe o campaignId como argumento posicional
  const entrarCampanha = (s) => new Promise((res) => {
    const to = setTimeout(() => res(false), 8000);
    s.emit("entrar-campanha", campId, (ok) => { clearTimeout(to); res(ok === true); });
  });
  const [cEsp, cM2] = await Promise.all([entrarCampanha(sEsp), entrarCampanha(sM2)]);
  t("espectador e mestre entram na room campanha:*", cEsp === true && cM2 === true, JSON.stringify({ cEsp, cM2 }));

  // listeners do espectador em TODOS os eventos conhecidos da room
  const recebidos = [];
  const eventosCampanha = [
    "campanha:atualizada", "campanha:restaurada", "membros:atualizados",
    "convites:atualizados", "sessao:atualizada", "anotacoes:atualizadas",
    "arquivos:atualizados", "inventario:atualizado", "fichas:atualizadas",
    "personagens:atualizados", "regras:atualizadas", "snapshots:atualizados",
    "patrimonio:atualizado", "mesa:mensagem",
  ];
  for (const ev of eventosCampanha) sEsp.on(ev, (d) => recebidos.push({ ev, d }));

  // dispara emissores reais mapeados em routes/* (emitirCampanha)
  // M1 foi rebaixado no G3 — os gatilhos usam J2 (mestre vigente)
  const gatilhos = [
    await req(base, "PATCH", `/campaigns/${campId}`, { cookie: j2.cookie, body: { description: "desc g4" } }), // campanha:atualizada
    await req(base, "POST", `/campaigns/${campId}/sessoes`, { cookie: j2.cookie, body: { nome: "Sessão G4" } }), // sessao:atualizada
    await req(base, "PATCH", `/campaigns/${campId}/members/${j1.membershipId}`, { cookie: j2.cookie, body: { permissions: { verHistorico: true } } }), // membros:atualizados
  ];
  await req(base, "POST", `/campaigns/${campId}/anotacoes`, { cookie: j2.cookie, body: { titulo: "nota g4", conteudo: "x" } }).catch(() => null); // anotacoes:atualizadas (se rota existir)
  await dormir(700);

  const porEvento = {};
  for (const r of recebidos) (porEvento[r.ev] ??= []).push(r.d);
  t("espectador recebe invalidações da campanha (room funciona)",
    Object.keys(porEvento).length >= 2, JSON.stringify(Object.keys(porEvento)));

  // invariante G4: nenhum payload da room pode carregar dados restritos
  const CHAVES_PUBLICAS = new Set([
    "id", "name", "description", "system", "coverImage", "status",
    "ownerId", "guildId", "guildNome", "settings", "summary",
    "createdAt", "updatedAt", "campaignId", "sessionId", "membershipId",
    "templateId", "elementId", "characterId", "snapshotId", "bookId",
    "origem", "convite", "tipo",
  ]);
  const vazamentos = [];
  for (const r of recebidos) {
    const d = r.d;
    if (d === null || d === undefined) continue;
    if (typeof d !== "object") { vazamentos.push(`${r.ev}: payload não-objeto`); continue; }
    for (const k of Object.keys(d)) {
      if (!CHAVES_PUBLICAS.has(k)) vazamentos.push(`${r.ev}.${k}`);
    }
    // marcadores de conteúdo restrito em qualquer nível do payload
    const s = JSON.stringify(d);
    if (/"alvo"|"target"|"dados"|"pool"|"recipients"/.test(s)) vazamentos.push(`${r.ev}: marcador restrito`);
  }
  t("nenhum payload de campanha:* contém campo restrito", vazamentos.length === 0, vazamentos.slice(0, 5).join(" | "));
  t("nenhum evento mestre-only (mesa:teste*) chega à room campanha:*",
    recebidos.every((r) => !r.ev.startsWith("mesa:teste")),
    JSON.stringify(recebidos.map((r) => r.ev)));
} catch (e) {
  fail++;
  console.log("FALHOU exceção não tratada:", e?.stack ?? e);
} finally {
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
