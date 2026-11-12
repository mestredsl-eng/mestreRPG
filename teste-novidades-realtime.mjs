// Novidades em tempo real — Socket.IO (Issue: notificações pós-v1).
// Cobre: sala privada usuario:{id}, evento novidade:publicada apenas em
// publicações/alterações efetivas, payload só com metadados, anônimo sem
// acesso, idempotência (sem eventos duplicados) e reconciliação do contador.
// Banco temporário + conexões Socket.IO reais. Nunca toca dados reais.
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("nov-real");
const BANCO = `${DIR}/teste.db`;
mkdirSync(DIR, { recursive: true });
await prepararBanco(BANCO);

const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
const sockets = [];

function conectar(cookie) {
  const opts = { path: "/socket.io", transports: ["websocket", "polling"], reconnection: false };
  if (cookie) {
    const token = decodeURIComponent(cookie.split("=")[1]);
    opts.extraHeaders = { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
  }
  const s = ioClient(BASE, opts);
  sockets.push(s);
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
function coletar(s, evento, ms = 1200) {
  // coleta eventos por `ms` ms (janela para provar ausência de duplicatas)
  return new Promise((resolve) => {
    const lista = [];
    const h = (d) => lista.push(d);
    s.on(evento, h);
    setTimeout(() => { s.off(evento, h); resolve(lista); }, ms);
  });
}
const esperarEvento = (s, evento, ms = 5000) =>
  new Promise((resolve, reject) => {
    const to = setTimeout(() => { s.off(evento, h); reject(new Error(`timeout ${evento}`)); }, ms);
    const h = (d) => { clearTimeout(to); s.off(evento, h); resolve(d); };
    s.on(evento, h);
  });

proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
await esperarSaudavel(BASE, proc);

const cenario = await criarCenario(BASE, BANCO, { campanha: "Campanha RT", jogadores: { a: "rt_a", b: "rt_b" } });
const M = cenario.cookieMestre, A = cenario.jogadores.a.cookie, B = cenario.jogadores.b.cookie;
const uidA = cenario.jogadores.a.id;
console.log(`servidor teste em ${BASE}`);

let adminId = null;
try {
  // id do admin (mestre_teste) para o socket do próprio admin
  adminId = comDb(BANCO, (db) => db.prepare("select id from users where username='mestre_teste'").get().id);

  sec("1-2. Conexões autenticadas e anônima");
  const sA = conectar(A), sB = conectar(B), sM = conectar(M);
  await Promise.all([pronto(sA), pronto(sB), pronto(sM)]);
  t("dois usuários + admin conectam", sA.connected && sB.connected && sM.connected);

  let anonErr = null;
  const sAnon = conectar(null);
  await new Promise((res) => { sAnon.on("connect_error", (e) => { anonErr = e; res(); }); sAnon.on("connect", res); });
  t("cliente anônimo não autentica no handshake", !!anonErr, String(anonErr));

  sec("3-4. Criação publicada e publicação de rascunho");
  const colA1 = coletar(sA, "novidade:publicada"), colB1 = coletar(sB, "novidade:publicada"), colM1 = coletar(sM, "novidade:publicada");
  const criada = await req(BASE, "POST", "/admin/novidades", {
    cookie: M, body: { titulo: "Lançamento v2", conteudo: "texto", estado: "publicada", categoria: "novidade" },
  });
  t("criar já publicada -> 201", criada.status === 201);
  const [evA, evB, evM] = await Promise.all([colA1, colB1, colM1]);
  t("A recebe exatamente 1 evento", evA.length === 1, String(evA.length));
  t("B recebe exatamente 1 evento", evB.length === 1, String(evB.length));
  t("admin também recebe (usuário ativo)", evM.length === 1, String(evM.length));
  const pubId = criada.json?.novidade?.id;
  const ev = evA[0];
  t("payload só com metadados", ev && ev.id === pubId && ev.titulo === "Lançamento v2" && ev.categoria === "novidade"
    && ev.revisao && ev.publicadoEm != null && !("conteudo" in ev) && !("resumo" in ev), JSON.stringify(ev));

  const rasc = await req(BASE, "POST", "/admin/novidades", { cookie: M, body: { titulo: "Rascunho X" } });
  const colA2 = coletar(sA, "novidade:publicada"), colB2 = coletar(sB, "novidade:publicada");
  await req(BASE, "POST", `/admin/novidades/${rasc.json.novidade.id}/publicar`, { cookie: M });
  const [evA2, evB2] = await Promise.all([colA2, colB2]);
  t("publicar rascunho emite 1 evento por usuário", evA2.length === 1 && evB2.length === 1 && evA2[0].id === rasc.json.novidade.id);

  sec("5-9. Edições, despublicar, excluir, republicar");
  // 5: editar publicada -> nova revisão
  const colA3 = coletar(sA, "novidade:publicada");
  const ed = await req(BASE, "PATCH", `/admin/novidades/${pubId}`, { cookie: M, body: { conteudo: "texto v2" } });
  const evA3 = await colA3;
  t("editar publicada emite nova revisão", evA3.length === 1 && evA3[0].revisao !== ev.revisao, JSON.stringify(evA3[0]));

  // 6: editar rascunho -> nada
  const rasc2 = (await req(BASE, "POST", "/admin/novidades", { cookie: M, body: { titulo: "Rascunho Y", conteudo: "v1" } })).json.novidade;
  const colA4 = coletar(sA, "novidade:publicada");
  await req(BASE, "PATCH", `/admin/novidades/${rasc2.id}`, { cookie: M, body: { conteudo: "v2" } });
  t("editar rascunho não emite", (await colA4).length === 0);

  // 7: despublicar -> nada
  const colA5 = coletar(sA, "novidade:publicada");
  await req(BASE, "POST", `/admin/novidades/${rasc.json.novidade.id}/despublicar`, { cookie: M });
  t("despublicar não emite", (await colA5).length === 0);

  // 8: excluir -> nada
  const colA6 = coletar(sA, "novidade:publicada");
  await req(BASE, "DELETE", `/admin/novidades/${rasc.json.novidade.id}`, { cookie: M });
  t("excluir não emite", (await colA6).length === 0);

  // 9: republicar sem mudança (publicar já publicada) + PATCH estado=publicada -> nada
  const colA7 = coletar(sA, "novidade:publicada");
  await req(BASE, "POST", `/admin/novidades/${pubId}/publicar`, { cookie: M }); // já publicada -> no-op
  await req(BASE, "PATCH", `/admin/novidades/${pubId}`, { cookie: M, body: { estado: "publicada", titulo: "Lançamento v2" } });
  t("republicar/PATCH sem mudança não emite", (await colA7).length === 0);

  sec("10. Falhas não emitem");
  const colA8 = coletar(sA, "novidade:publicada");
  const totalAntes = comDb(BANCO, (db) => db.prepare("select count(*) c from novidades").get().c);
  const estadoAntes = comDb(BANCO, (db) => db.prepare("select estado from novidades where id=?").get(pubId)?.estado);
  const bad = await req(BASE, "POST", "/admin/novidades", { cookie: M, body: { titulo: "" } }); // 400
  const nf = await req(BASE, "POST", `/admin/novidades/${crypto.randomUUID()}/publicar`, { cookie: M }); // 404
  const negado = await req(BASE, "POST", "/admin/novidades", { cookie: A, body: { titulo: "x", estado: "publicada" } }); // 403
  const eventosNegados = await colA8;
  t("400/404/403 não emitem evento", bad.status === 400 && nf.status === 404 && negado.status === 403
    && eventosNegados.length === 0,
    JSON.stringify({ status400: bad.status, status404: nf.status, status403: negado.status, eventosRecebidos: eventosNegados }));
  t("requisições rejeitadas não alteram publicações",
    comDb(BANCO, (db) => db.prepare("select count(*) c from novidades").get().c) === totalAntes
    && comDb(BANCO, (db) => db.prepare("select estado from novidades where id=?").get(pubId)?.estado) === estadoAntes);
  // janela independente confirma que o 404 em publicar também não emite:
  const colA8b = coletar(sA, "novidade:publicada");
  await req(BASE, "POST", `/admin/novidades/${crypto.randomUUID()}/publicar`, { cookie: M });
  t("404 em publicar não emite", (await colA8b).length === 0);

  sec("11-12. Duas abas do mesmo usuário + reconexão");
  const sA2 = conectar(A); // segunda aba do usuário A
  await pronto(sA2);
  const colA9 = coletar(sA, "novidade:publicada"), colA92 = coletar(sA2, "novidade:publicada");
  const p11 = (await req(BASE, "POST", "/admin/novidades", { cookie: M, body: { titulo: "Duas abas", estado: "publicada" } })).json.novidade;
  const [e1, e2] = await Promise.all([colA9, colA92]);
  t("duas abas do mesmo usuário recebem o evento", e1.length === 1 && e2.length === 1 && e1[0].id === p11.id);

  // leitura de A em uma aba; contador é por usuário (uma linha)
  const revP11 = (await req(BASE, "GET", `/novidades/${p11.id}`, { cookie: A })).json.novidade.revisao;
  await req(BASE, "POST", `/novidades/${p11.id}/lida`, { cookie: A, body: { revisao: revP11 } });
  const regs = comDb(BANCO, (db) => db.prepare("select count(*) c from novidade_leituras where novidade_id=? and user_id=?").get(p11.id, uidA).c);
  t("leitura individual: 1 registro por usuário", regs === 1, String(regs));

  // reconexão: novo socket consulta o contador via API (reconciliação server-side)
  const sA3 = conectar(A);
  await pronto(sA3);
  const nl = await req(BASE, "GET", "/novidades/nao-lidas", { cookie: A });
  const esperadas = comDb(BANCO, (db) => db.prepare("select count(*) c from novidades where estado='publicada'").get().c)
    - comDb(BANCO, (db) => db.prepare("select count(*) c from novidade_leituras l join novidades n on n.id=l.novidade_id where l.user_id=? and n.estado='publicada'").get(uidA).c);
  t("contador reconciliado com o banco após reconexão", nl.json?.naoLidas === esperadas, `${nl.json?.naoLidas} vs ${esperadas}`);

  sec("13. Payload nunca contém conteúdo de rascunho");
  const colA10 = coletar(sA, "novidade:publicada");
  await req(BASE, "PATCH", `/admin/novidades/${p11.id}`, { cookie: M, body: { conteudo: "segredo v3" } });
  const evs = await colA10;
  t("evento de edição não vaza conteúdo", evs.length === 1 && !("conteudo" in evs[0]) && !("resumo" in evs[0]), JSON.stringify(evs[0]));

  sec("14. Evento não é entregue a sala de outro usuário");
  // sB já coletou eventos anteriores; nova coleta prova isolamento por sala:
  const colB9 = coletar(sB, "novidade:publicada");
  const p14 = (await req(BASE, "POST", "/admin/novidades", { cookie: M, body: { titulo: "Só para checar", estado: "publicada" } })).json.novidade;
  const evB9 = await colB9;
  t("B recebe sua própria notificação", evB9.length === 1 && evB9[0].id === p14.id);
} finally {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== novidades-realtime: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
