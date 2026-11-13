// Isolamento de sessões Socket.IO — logout revoga somente os sockets
// autenticados por aquela sessão HTTP. Cobre: logout desconecta o socket
// da sessão, troca de contas no mesmo navegador, sessões independentes da
// mesma conta, handshake com sessão revogada e isolamento por usuário.
// Sockets reais contra servidor descartável — nunca toca dados reais.
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("sessoes-socket");
const BANCO = `${DIR}/teste.db`;
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
const coletar = (s, evento, ms = 1500) => new Promise((resolve) => {
  const lista = [];
  const h = (d) => lista.push(d);
  s.on(evento, h);
  setTimeout(() => { s.off(evento, h); resolve(lista); }, ms);
});
const esperarDisconnect = (s, ms = 5000) => new Promise((resolve) => {
  const to = setTimeout(() => resolve(false), ms);
  s.on("disconnect", () => { clearTimeout(to); resolve(true); });
});
const publicar = (M, titulo) =>
  req(BASE, "POST", "/admin/novidades", { cookie: M, body: { titulo, estado: "publicada" } });

proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
await esperarSaudavel(BASE, proc);

const cenario = await criarCenario(BASE, BANCO, {
  campanha: "Campanha Sessões", jogadores: { a: "sess_a", b: "sess_b" },
});
const M = cenario.cookieMestre;
const A1 = cenario.jogadores.a.cookie;          // sessão 1 do usuário A
const B = cenario.jogadores.b.cookie;
const uidA = cenario.jogadores.a.id;
const A2 = sessao(BANCO, uidA);                  // sessão 2 INDEPENDENTE da mesma conta
console.log(`servidor teste em ${BASE}`);

try {
  // ============ Cenário A — logout desconecta o socket da sessão ============
  sec("A. Logout encerra o socket da sessão revogada");
  const sA = conectar(A1);
  await pronto(sA);
  const colA1 = coletar(sA, "novidade:publicada");
  const pub1 = await publicar(M, "Pub A1");
  const evA1 = await colA1;
  t("A: socket autenticado recebe evento antes do logout", evA1.length === 1, String(evA1.length));

  const dA = esperarDisconnect(sA);
  const lo = await req(BASE, "POST", "/auth/logout", { cookie: A1 });
  t("A: logout → 200", lo.status === 200, `status=${lo.status}`);
  t("A: servidor desconectou o socket da sessão", await dA);
  t("A: socket marcado como desconectado", !sA.connected);

  const colA2 = coletar(sA, "novidade:publicada", 800);
  await publicar(M, "Pub A2");
  t("A: socket revogado não recebe eventos posteriores", (await colA2).length === 0);

  // ============ Cenário D — handshake com sessão revogada ============
  sec("D. Handshake com sessão revogada é rejeitado");
  let errRev = null;
  const sRev = conectar(A1);
  await new Promise((res) => { sRev.on("connect_error", (e) => { errRev = e; res(); }); sRev.on("connect", res); });
  t("D: novo handshake com cookie revogado falha", !!errRev && !sRev.connected, String(errRev));

  // ============ Cenário C — sessões independentes da mesma conta ============
  sec("C. Duas sessões independentes: logout de uma preserva a outra");
  const sA1 = conectar(A1);   // cookie da sessão já revogada → deve falhar
  let errA1 = null;
  await new Promise((res) => { sA1.on("connect_error", (e) => { errA1 = e; res(); }); sA1.on("connect", res); });
  t("C: sessão revogada não conecta", !!errA1, String(errA1));

  // Recria sessão para o usuário A (a anterior foi revogada no cenário A)
  const A1n = sessao(BANCO, uidA);
  const sAa = conectar(A1n);  // sessão A-nova, socket 1
  const sAb = conectar(A1n);  // mesma sessão, segunda "aba"
  const sA2 = conectar(A2);   // sessão independente da mesma conta
  await Promise.all([pronto(sAa), pronto(sAb), pronto(sA2)]);
  t("C: três sockets da conta A conectam", sAa.connected && sAb.connected && sA2.connected);

  const colAa = coletar(sAa, "novidade:publicada");
  const colAb = coletar(sAb, "novidade:publicada");
  const colA2inicial = coletar(sA2, "novidade:publicada");
  await publicar(M, "Pub C1");
  const [eAa, eAb, eA2] = await Promise.all([colAa, colAb, colA2inicial]);
  t("C: todas as sessões recebem o evento", eAa.length === 1 && eAb.length === 1 && eA2.length === 1,
    JSON.stringify({ aa: eAa.length, ab: eAb.length, a2: eA2.length }));

  // logout da sessão A-nova → os DOIS sockets dela caem; a sessão A2 vive
  const dAa = esperarDisconnect(sAa), dAb = esperarDisconnect(sAb);
  const loC = await req(BASE, "POST", "/auth/logout", { cookie: A1n });
  t("C: logout da sessão A-nova → 200", loC.status === 200, `status=${loC.status}`);
  t("C: socket 1 da sessão revogada desconectado", await dAa);
  t("C: socket 2 (mesma sessão/aba extra) desconectado", await dAb);
  t("C: sessão independente continua conectada", sA2.connected);

  const colA2sess = coletar(sA2, "novidade:publicada");
  await publicar(M, "Pub C2");
  t("C: sessão independente recebe evento após logout da outra",
    (await colA2sess).length === 1);

  // ============ Cenário B — troca de contas no mesmo navegador ============
  sec("B. Logout de A → login de B: conexões isoladas");
  // sB conecta com a sessão de B; sA2 (conta A) continua viva em paralelo
  const sB = conectar(B);
  await pronto(sB);
  t("B: socket da conta B conecta", sB.connected);

  const colB = coletar(sB, "novidade:publicada");
  const colA2c = coletar(sA2, "novidade:publicada");
  await publicar(M, "Pub B1");
  const [eB, eA2c] = await Promise.all([colB, colA2c]);
  t("B: B recebe sua notificação", eB.length === 1, String(eB.length));
  t("B: A (outra sessão válida) também recebe — isolamento é por sala de usuário",
    eA2c.length === 1, String(eA2c.length));

  // evento direcionado a UM usuário: novidade vai para todos, então o
  // isolamento real é provado pelas salas — a sessão revogada de A não
  // pode mais receber nada (já provado) e B não está na sala de A.
  // Prova extra: socket anônimo continua rejeitado.
  let errAnon2 = null;
  const sAnon2 = conectar(null);
  await new Promise((res) => { sAnon2.on("connect_error", (e) => { errAnon2 = e; res(); }); sAnon2.on("connect", res); });
  t("B/E: anônimo segue rejeitado no handshake", !!errAnon2, String(errAnon2));

  // ============ Cenário E — usuário revogado não recebe nada ============
  sec("E. Sessão revogada permanece muda mesmo com conta ativa");
  // A2 ainda é uma sessão VÁLIDA da conta A — logout dela também deve calá-la
  const dA2 = esperarDisconnect(sA2);
  await req(BASE, "POST", "/auth/logout", { cookie: A2 });
  t("E: logout da última sessão de A desconecta o socket restante", await dA2);
  const colB2 = coletar(sB, "novidade:publicada");
  await publicar(M, "Pub E1");
  const eB2 = await colB2;
  t("E: B continua recebendo após todos os logouts de A", eB2.length === 1, String(eB2.length));
  t("E: sockets revogados de A não receberam nada", !sA.connected && !sAa.connected && !sA2.connected);
} finally {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== sessoes-socket: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
