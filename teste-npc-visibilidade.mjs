// NPCs ocultos no VTT + ficha do NPC com visibilidade decidida pelo mestre.
// Cobre: token de NPC nasce oculto (default do servidor), filtro server-side
// para jogador/espectador mesmo com névoa desligada, toggle Ocultar/Exibir,
// jogador não move/altera token de NPC, ficha do NPC 403→200 após revelar,
// mutações do NPC seguem exclusivas do mestre e endpoint é auditado.
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = dirTeste("npc-visibilidade");
const BANCO = `${DIR}/teste.db`;
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc, ids, sid;
const sockets = [];

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p) => new Promise((r) => { const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000); s.emit(ev, p, (x) => { clearTimeout(to); r(x); }); });
const tokensDe = (vtt) => {
  if (!vtt) return [];
  if (typeof vtt === "string") { try { return JSON.parse(vtt).tokens ?? []; } catch { return []; } }
  return Array.isArray(vtt.tokens) ? vtt.tokens : [];
};

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "npc_j1" },
    config: { hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "ambos" } },
  });
  ids = { admin: c.adminId, camp: c.campId, cookieMestre: c.cookieMestre, j1: c.jogadores.jogador1 };

  // ---------- ficha do NPC: visibilidade por decisão do mestre ----------
  sec("Ficha do NPC — endpoint npc-visibilidade");
  const verId = comDb(BANCO, (db) => db.prepare("select id from sheet_versions limit 1").get()?.id);
  const npc = await req(BASE, "POST", `/campaigns/${ids.camp}/characters`, {
    cookie: ids.cookieMestre,
    body: { name: "Bruto da Floresta", templateVersionId: verId, isNpc: true },
  });
  t("mestre cria NPC", npc.status === 201 && npc.json?.personagem?.isNpc === true, `status=${npc.status} ${JSON.stringify(npc.json).slice(0, 200)}`);
  const idNpc = npc.json?.personagem?.id;

  const pj = await req(BASE, "POST", `/campaigns/${ids.camp}/characters`, {
    cookie: ids.j1.cookie, body: { name: "Herói", templateVersionId: verId },
  });
  const idPj = pj.json?.personagem?.id;

  // Jogador não acessa NPC oculto
  let r = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("jogador recebe 403 na ficha do NPC oculto", r.status === 403, `status=${r.status}`);
  // Nem na listagem
  r = await req(BASE, "GET", `/campaigns/${ids.camp}/characters`, { cookie: ids.j1.cookie });
  t("NPC oculto fora da lista do jogador", !(r.json?.personagens ?? []).some((p) => p.id === idNpc));

  // Jogador não pode chamar o endpoint
  r = await req(BASE, "POST", `/characters/${idNpc}/npc-visibilidade`, { cookie: ids.j1.cookie, body: { visivel: true } });
  t("jogador não alterna visibilidade do NPC", r.status === 403, `status=${r.status}`);
  // Nem em personagem que não é NPC
  r = await req(BASE, "POST", `/characters/${idPj}/npc-visibilidade`, { cookie: ids.cookieMestre, body: { visivel: true } });
  t("endpoint rejeita personagem não-NPC", r.status === 400, `status=${r.status}`);

  // Mestre revela a ficha
  r = await req(BASE, "POST", `/characters/${idNpc}/npc-visibilidade`, { cookie: ids.cookieMestre, body: { visivel: true } });
  t("mestre revela ficha do NPC", r.status === 200 && r.json?.visivel === true, `status=${r.status}`);
  r = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("jogador lê ficha do NPC revelado", r.status === 200 && r.json?.personagem?.isNpc === true && r.json?.personagem?.npcRevelado === true,
    `status=${r.status}`);
  r = await req(BASE, "GET", `/campaigns/${ids.camp}/characters`, { cookie: ids.j1.cookie });
  t("NPC revelado entra na lista do jogador", (r.json?.personagens ?? []).some((p) => p.id === idNpc && p.isNpc === true));

  // Mutações do NPC seguem exclusivas do mestre
  r = await req(BASE, "PATCH", `/characters/${idNpc}`, { cookie: ids.j1.cookie, body: { data: { for: 99 } } });
  t("jogador não edita NPC revelado", r.status === 403, `status=${r.status}`);
  r = await req(BASE, "POST", `/characters/${idNpc}/hp`, { cookie: ids.j1.cookie, body: { acao: "dano", quantidade: 5 } });
  t("jogador não aplica dano no NPC", r.status === 403, `status=${r.status}`);
  r = await req(BASE, "POST", `/characters/${idNpc}/hp`, { cookie: ids.cookieMestre, body: { acao: "dano", quantidade: 5, motivo: "Ataque" } });
  t("mestre aplica dano no NPC", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.erro ?? "")}`);
  // Injeção de __npcVisivel via PATCH é descartada
  r = await req(BASE, "PATCH", `/characters/${idNpc}`, { cookie: ids.cookieMestre, body: { data: { __npcVisivel: { visivel: false } } } });
  const npcDepois = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("PATCH não forja __npcVisivel", npcDepois.status === 200 && npcDepois.json?.personagem?.npcRevelado === true);
  // Mestre volta a ocultar
  r = await req(BASE, "POST", `/characters/${idNpc}/npc-visibilidade`, { cookie: ids.cookieMestre, body: { visivel: false } });
  r = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("NPC volta a 403 após ocultar", r.status === 403, `status=${r.status}`);

  // ---------- Privacidade: HP não pode vazar atributo privado ----------
  // O HP máximo = base + atributo×porNivel. Se o atributo for "mestre",
  // o jogador não pode deduzi-lo pelo máximo, pelo atual nem pelo
  // histórico — tudo é calculado sobre a visão filtrada da ficha.
  sec("Privacidade — HP não vaza atributo privado");
  {
    const w = abrirDb(BANCO);
    try {
      const row = w.prepare("select structure from sheet_versions limit 1").get();
      const est = JSON.parse(row.structure);
      est.secoes[0].campos[0].visibilidade = "mestre"; // "for" vira privado
      w.prepare("update sheet_versions set structure=?").run(JSON.stringify(est));
    } finally { w.close(); }
  }
  r = await req(BASE, "POST", `/characters/${idNpc}/npc-visibilidade`, { cookie: ids.cookieMestre, body: { visivel: true } });
  r = await req(BASE, "PATCH", `/characters/${idNpc}`, { cookie: ids.cookieMestre, body: { data: { for: 5 } } });
  t("mestre define FOR=5 no NPC", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.erro ?? "")}`);
  // HP real: máximo 150; atual persistido 145 (95 pós-dano + 50 de cura,
  // limitado ao máximo) — prova que resumoHp grampeia o "atual" visível.
  r = await req(BASE, "POST", `/characters/${idNpc}/hp`, { cookie: ids.cookieMestre, body: { acao: "recuperar", quantidade: 50, motivo: "Descanso" } });
  t("mestre cura NPC p/ HP persistido 145", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.erro ?? r.json ?? "")}`);

  const fM = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.cookieMestre });
  const fJ = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("mestre e jogador leem o NPC revelado", fM.status === 200 && fJ.status === 200);
  const hpM = fM.json?.ficha?.vida?.hp;
  const hpJ = fJ.json?.ficha?.vida?.hp;
  t("mestre vê HP máximo com FOR (100+5×10=150)", hpM?.maximo === 150, JSON.stringify(hpM));
  t("mestre vê HP atual real persistido (145)", hpM?.atual === 145, JSON.stringify(hpM));
  t("jogador vê HP máximo SEM o atributo privado (base 100)", hpJ?.maximo === 100, JSON.stringify(hpJ));
  t("jogador nunca vê 'atual' acima do máximo visível (≤100)", typeof hpJ?.atual === "number" && hpJ.atual <= 100, JSON.stringify(hpJ));
  t("histórico de HP do mestre preservado", (hpM?.historico ?? []).length > 0, JSON.stringify(hpM?.historico));
  t("histórico de HP oculto do jogador (sem vazamento indireto)", Array.isArray(hpJ?.historico) && hpJ.historico.length === 0, JSON.stringify(hpJ?.historico));
  t("campo privado ausente dos campos do jogador", !("for" in (fJ.json?.ficha?.campos ?? {})));
  t("jogador não pode editar HP do NPC", (await req(BASE, "POST", `/characters/${idNpc}/hp`, { cookie: ids.j1.cookie, body: { acao: "dano", quantidade: 10 } })).status === 403);

  // ---------- Vazamento por Vitalidade (conversão de ferimentos) ----------
  // A conversão calcula % sobre o HP MÁXIMO REAL (150). Se o limiar
  // dispara com 150 mas não dispararia com os 100 públicos, o nível de
  // vitalidade exibido ao jogador denuncia o atributo privado.
  sec("Privacidade — Vitalidade não vaza atributo privado");
  r = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, {
    cookie: ids.cookieMestre,
    body: { conversaoFerimento: { habilitada: true, limiares: [{ ate: 90, nivel: 1 }] } },
  });
  t("mestre habilita conversão de ferimentos", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.erro ?? "")}`);
  // atual 145 − 20 = 125 → pct real 83,3% ≤ 90 → vitalidade sobe p/ nível 1.
  // Para o jogador: HP exibido grampeia em 100/100 → pct público 100% →
  // o nível 1 seria inexplicável sem conhecer o máximo real.
  r = await req(BASE, "POST", `/characters/${idNpc}/hp`, { cookie: ids.cookieMestre, body: { acao: "dano", quantidade: 20, motivo: "Golpe pesado" } });
  t("mestre aplica dano que cruza o limiar real", r.status === 200 && r.json?.ferimento?.para === 1, `status=${r.status} ${JSON.stringify(r.json?.ferimento ?? r.json?.erro ?? "")}`);

  const fM2 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.cookieMestre });
  const fJ2 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  const vitM = fM2.json?.ficha?.vida?.vitalidade;
  const vitJ = fJ2.json?.ficha?.vida?.vitalidade;
  t("mestre vê vitalidade real convertida (nível 1)", vitM?.nivel === 1, JSON.stringify(vitM));
  t("jogador NÃO vê nível de vitalidade inexplicável pelo HP público",
    vitJ == null || vitJ.nivel === 0, JSON.stringify(vitJ));
  // Vitalidade definida MANUALMENTE pelo mestre é escolha narrativa —
  // não deriva do HP oculto e deve continuar visível ao leitor.
  r = await req(BASE, "POST", `/characters/${idNpc}/vitalidade`, { cookie: ids.cookieMestre, body: { nivel: 3, motivo: "Costela trincada" } });
  t("mestre define vitalidade manual", r.status === 200, `status=${r.status}`);
  const fJ3 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("jogador vê vitalidade manual do mestre (nível 3)", fJ3.json?.ficha?.vida?.vitalidade?.nivel === 3, JSON.stringify(fJ3.json?.ficha?.vida?.vitalidade));

  // ---------- VTT: token de NPC oculto ----------
  sec("VTT — token de NPC oculto por padrão");
  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Mesa NPC" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid, JSON.stringify(sess.json).slice(0, 160));

  const sMestre = conectar(ids.cookieMestre);
  const sJ1 = conectar(ids.j1.cookie);
  await Promise.all([pronto(sMestre), pronto(sJ1)]);
  const [rM, rJ] = await Promise.all([
    emitirCb(sMestre, "mesa:entrar", { sessionId: sid }),
    emitirCb(sJ1, "mesa:entrar", { sessionId: sid }),
  ]);
  t("mestre e jogador entram", rM?.ok === true && rJ?.ok === true);

  // Mestre cria token vinculado ao NPC — nasce oculto (default do servidor)
  const rCriaNpc = await emitirCb(sMestre, "mesa:vtt:token", {
    sessionId: sid, acao: "criar",
    token: { nome: "Bruto", cor: "#7a1f1f", x: 0.5, y: 0.5, personagemId: idNpc },
  });
  const tokNpc = rCriaNpc?.vtt?.tokens?.find?.((x) => x.personagemId === idNpc);
  t("token de NPC criado oculto", rCriaNpc?.ok === true && tokNpc?.oculto === true, JSON.stringify(tokNpc));

  // O ACK do criar é do mestre; a visão do jogador é verificada via re-entrada
  const rReJ = await emitirCb(sJ1, "mesa:entrar", { sessionId: sid });
  const tokensJ = tokensDe(rReJ?.sessao?.vttState);
  t("jogador não recebe token oculto (névoa off)", !tokensJ.some((x) => x.personagemId === idNpc), JSON.stringify(tokensJ.map((x) => x.nome)));
  const rReM = await emitirCb(sMestre, "mesa:entrar", { sessionId: sid });
  const tokensM = tokensDe(rReM?.sessao?.vttState);
  t("mestre recebe token oculto", tokensM.some((x) => x.personagemId === idNpc && x.oculto === true));

  // Jogador não move/altera token de NPC
  const rMvNpc = await emitirCb(sJ1, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: tokNpc?.id, x: 0.9, y: 0.9 } });
  t("jogador não move token de NPC", rMvNpc?.ok === false, JSON.stringify(rMvNpc).slice(0, 120));
  const rOcultarJ = await emitirCb(sJ1, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: tokNpc?.id, oculto: false } });
  t("jogador não remove ocultação", rOcultarJ?.ok === false);

  // Mestre exibe o token → jogador passa a ver
  const rExibir = await emitirCb(sMestre, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: tokNpc?.id, oculto: false } });
  t("mestre exibe token do NPC", rExibir?.ok === true);
  const rReJ2 = await emitirCb(sJ1, "mesa:entrar", { sessionId: sid });
  const tokensJ2 = tokensDe(rReJ2?.sessao?.vttState);
  t("jogador vê token após exibição", tokensJ2.some((x) => x.personagemId === idNpc && x.oculto !== true));

  // Mestre oculta de novo → some para o jogador
  await emitirCb(sMestre, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: tokNpc?.id, oculto: true } });
  const rReJ3 = await emitirCb(sJ1, "mesa:entrar", { sessionId: sid });
  t("jogador perde o token ao re-ocultar", !tokensDe(rReJ3?.sessao?.vttState).some((x) => x.personagemId === idNpc));

  // Token comum pode ser ocultado também; criar com oculto explícito funciona
  const rCriaComum = await emitirCb(sMestre, "mesa:vtt:token", {
    sessionId: sid, acao: "criar",
    token: { nome: "Emboscada", cor: "#333", x: 0.2, y: 0.2, oculto: true },
  });
  const tokComum = rCriaComum?.vtt?.tokens?.find?.((x) => x.nome === "Emboscada");
  t("token comum aceita oculto explícito", rCriaComum?.ok === true && tokComum?.oculto === true);

  // Revincular token comum a NPC volta a ocultar por padrão
  const rReVinc = await emitirCb(sMestre, "mesa:vtt:token", {
    sessionId: sid, acao: "atualizar",
    token: { id: tokComum?.id, personagemId: idNpc },
  });
  const tokRev = rReVinc?.vtt?.tokens?.find?.((x) => x.id === tokComum?.id);
  t("revincular a NPC re-oculta por padrão", tokRev?.oculto === true && tokRev?.personagemId === idNpc);

  for (const s of sockets) s.disconnect();
  await encerrarServidor(proc);
} finally {
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
