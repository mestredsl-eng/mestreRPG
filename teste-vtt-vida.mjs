// Issue #127 — vida (HP/vitalidade) nos tokens da Mesa Virtual via Socket.IO.
// Cobre: mestre/jogador/espectador, vidaCompartilhada off/on, névoa,
// tokens ocultos, NPC, personagem sem vínculo, não-vazamento de atributo
// privado pelo HP máximo/vitalidade, vtt_state sem vida persistida e
// sincronização autoritativa (mesa:vtt:sincronizar) após personagens:atualizados
// e regras:atualizadas. Banco 100% descartável.
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir, abrirDb, sessao,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("vtt-vida");
const BANCO = `${DIR}/teste.db`;
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc, ids, sid;
const sockets = [];
const ultVtt = new Map();
const cntVtt = new Map();

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  ultVtt.set(s, null); cntVtt.set(s, 0);
  s.on("mesa:vtt", (p) => { ultVtt.set(s, p?.vtt ?? null); cntVtt.set(s, (cntVtt.get(s) ?? 0) + 1); });
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p) => new Promise((r) => { const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000); s.emit(ev, p, (x) => { clearTimeout(to); r(x); }); });
const sincronizar = (s) => emitirCb(s, "mesa:vtt:sincronizar", { sessionId: sid });
const sincronizarNevoa = (s) => emitirCb(s, "mesa:vtt:nevoa:sincronizar", { sessionId: sid });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarVtt(socket, timeout = 8000) {
  const ini = cntVtt.get(socket) ?? 0;
  const fim = Date.now() + timeout;
  while (Date.now() < fim) {
    if ((cntVtt.get(socket) ?? 0) > ini) return;
    await dormir(50);
  }
  throw new Error("timeout mesa:vtt");
}
const tok = (vtt, id) => (vtt?.tokens ?? []).find((x) => x.id === id);

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

const CFG = {
  hp: { habilitado: true, base: 100, porNivel: 10, semantico: "atributo", edicaoPor: "mestre" },
  vitalidade: {
    edicaoPor: "mestre",
    niveis: [
      { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
      { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
      { nome: "Debilitado", penalidadeDados: 2, bloqueiaAcoes: true },
    ],
  },
};

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "vd_j1", jogador2: "vd_j2" },
    config: CFG,
  });
  ids = { admin: c.adminId, j1: c.jogadores.jogador1.id, j2: c.jogadores.jogador2.id, camp: c.campId, cookieMestre: c.cookieMestre };
  const esp = novoUsuario(BANCO, { username: "vd_esp", role: "espectador", campId: ids.camp });

  // Personagens: PJ1 (j1), PJ2 (j2), NPC (membro do mestre, is_npc=1)
  // com campo "for" privado (override visibilidade=mestre) para provar
  // que o HP máximo não vaza atributo oculto. Vida semeada em data.__hp.
  const PJ1 = c.novoPersonagem(c.jogadores.jogador1.membershipId, "PJ Um", { __hp: { atual: 120, historico: [] }, __vitalidade: { nivel: 1, nivelManual: 1 } });
  const PJ2 = c.novoPersonagem(c.jogadores.jogador2.membershipId, "PJ Dois", { __hp: { atual: 80, historico: [] } });
  const PJNpc = c.novoPersonagem(c.membMestre, "NPC Goblin", { for: 8, __hp: { atual: 60, historico: [] }, __vitalidade: { nivel: 2, nivelManual: 2 } });
  {
    const db = abrirDb(BANCO);
    db.prepare("update characters set is_npc=1, overrides=? where id=?")
      .run(JSON.stringify({ for: { visibilidade: "mestre" } }), PJNpc);
    db.close();
  }

  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Mesa Vida" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid);

  const sM = conectar(ids.cookieMestre);
  const sA = conectar(c.jogadores.jogador1.cookie);
  const sB = conectar(c.jogadores.jogador2.cookie);
  const sE = conectar(esp.cookie);
  await Promise.all([pronto(sM), pronto(sA), pronto(sB), pronto(sE)]);
  const [rM, rA, rB, rE] = await Promise.all([
    emitirCb(sM, "mesa:entrar", { sessionId: sid }),
    emitirCb(sA, "mesa:entrar", { sessionId: sid }),
    emitirCb(sB, "mesa:entrar", { sessionId: sid }),
    emitirCb(sE, "mesa:entrar", { sessionId: sid }),
  ]);
  t("quatro participantes entram", rM?.ok && rA?.ok && rB?.ok && rE?.ok);

  // Tokens: PJ1, PJ2, NPC (visível), NPC oculto, token sem vínculo,
  // token só-userId (sem ficha).
  const pVtt = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
  const criar = (id, extra) => emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id, nome: id, cor: "#123456", x: 0.5, y: 0.5, ...extra } });
  t("token PJ1 criado", (await criar("tkpj1-aa11", { personagemId: PJ1 })).ok === true);
  t("token PJ2 criado", (await criar("tkpj2-bb22", { personagemId: PJ2 })).ok === true);
  t("token NPC criado", (await criar("tknpc-cc33", { personagemId: PJNpc, oculto: false })).ok === true);
  t("token NPC oculto criado", (await criar("tknpco-dd44", { personagemId: PJNpc, oculto: true })).ok === true);
  t("token sem vínculo criado", (await criar("tksem-ee55", {})).ok === true);
  t("token só userId criado", (await criar("tkuser-ff66", { userId: ids.j2 })).ok === true);
  await pVtt;

  // ---------- A. vidaCompartilhada OFF (padrão) ----------
  sec("A. vidaCompartilhada desligada — vida só do próprio personagem");
  {
    const vM = ultVtt.get(sM), vA = ultVtt.get(sA), vB = ultVtt.get(sB), vE = ultVtt.get(sE);
    // mestre vê vida em todos os tokens com ficha (inclusive oculto? não —
    // oculto é filtrado só para não-mestres; mestre recebe tudo)
    t("mestre: vida no token PJ1", tok(vM, "tkpj1-aa11")?.vida?.hp?.maximo === 150 && tok(vM, "tkpj1-aa11")?.vida?.hp?.atual === 120, JSON.stringify(tok(vM, "tkpj1-aa11")?.vida));
    t("mestre: vida no token PJ2", tok(vM, "tkpj2-bb22")?.vida?.hp?.maximo === 150, JSON.stringify(tok(vM, "tkpj2-bb22")?.vida));
    t("mestre: vida no token NPC (for privado = 8 → 100+80=180)", tok(vM, "tknpc-cc33")?.vida?.hp?.maximo === 180, JSON.stringify(tok(vM, "tknpc-cc33")?.vida));
    t("mestre: vitalidade no token PJ1", tok(vM, "tkpj1-aa11")?.vida?.vitalidade?.nivel === 1);
    t("mestre: sem vida no token sem vínculo", tok(vM, "tksem-ee55")?.vida == null);
    t("mestre: sem vida no token só-userId", tok(vM, "tkuser-ff66")?.vida == null);

    // j1: vida só no próprio token
    t("j1: vida no próprio token", tok(vA, "tkpj1-aa11")?.vida?.hp?.atual === 120 && tok(vA, "tkpj1-aa11")?.vida?.hp?.maximo === 150);
    t("j1: SEM vida no token do j2", tok(vA, "tkpj2-bb22")?.vida == null, JSON.stringify(tok(vA, "tkpj2-bb22")?.vida));
    t("j1: token oculto do NPC nem é entregue", tok(vA, "tknpco-dd44") === undefined);
    t("j1: token NPC entregue", tok(vA, "tknpc-cc33") !== undefined);
    t("j1: NPC visível SEM vida (flag off)", tok(vA, "tknpc-cc33")?.vida == null, JSON.stringify(tok(vA, "tknpc-cc33")?.vida));
    t("j1: token sem vínculo presente mas sem vida", tok(vA, "tksem-ee55") !== undefined && tok(vA, "tksem-ee55")?.vida == null);

    // j2 idem (espelho)
    t("j2: vida no próprio token", tok(vB, "tkpj2-bb22")?.vida?.hp?.atual === 80);
    t("j2: SEM vida no token do j1", tok(vB, "tkpj1-aa11")?.vida == null);

    // espectador: nenhum token tem vida com flag off
    t("espectador: token visível mas SEM vida", tok(vE, "tkpj1-aa11") !== undefined && tok(vE, "tkpj1-aa11")?.vida == null);
    t("espectador: SEM vida no token do j1", tok(vE, "tkpj1-aa11")?.vida == null);
  }

  // ---------- B. vidaCompartilhada ON ----------
  sec("B. vidaCompartilhada ligada — vida em tokens visíveis, filtrada");
  {
    const rCfg = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: true } } });
    t("PUT config vtt.vidaCompartilhada=on", rCfg.status === 200, `status=${rCfg.status} ${JSON.stringify(rCfg.json).slice(0, 200)}`);
    // sincronização autoritativa reflete a nova config sem novo mesa:vtt
    const rSync = await sincronizar(sA);
    t("sincronizar j1 ok", rSync?.ok === true);
    const vA = rSync?.vtt;
    t("j1: vida no token do j2 (filtrada, campos todos visíveis)", tok(vA, "tkpj2-bb22")?.vida?.hp?.maximo === 150, JSON.stringify(tok(vA, "tkpj2-bb22")?.vida));
    // NPC: o atributo que define o máximo é mestre-only. Como __hp.atual
    // foi produzido sob o máximo real, não publicar HP recalculado/clampado
    // sobre a visão filtrada (isso permitiria inferir o atributo secreto).
    t("j1: HP do NPC com atributo mestre-only não é compartilhado",
      tok(vA, "tknpc-cc33")?.vida?.hp == null, JSON.stringify(tok(vA, "tknpc-cc33")?.vida));
    t("j1: vitalidade manual do NPC permanece como piso narrativo (nivelManual=2)", tok(vA, "tknpc-cc33")?.vida?.vitalidade?.nivel === 2, JSON.stringify(tok(vA, "tknpc-cc33")?.vida?.vitalidade));
    t("j1: token oculto continua não entregue", tok(vA, "tknpco-dd44") === undefined);
    const rSyncE = await sincronizar(sE);
    t("espectador: vida no token do j1 com flag on (filtrada, não é dono)", tok(rSyncE?.vtt, "tkpj1-aa11")?.vida?.hp?.maximo === 150 && tok(rSyncE?.vtt, "tkpj1-aa11")?.vida?.hp?.atual === 120, JSON.stringify(tok(rSyncE?.vtt, "tkpj1-aa11")?.vida));
    t("espectador: HP do NPC com atributo mestre-only não é compartilhado",
      tok(rSyncE?.vtt, "tknpc-cc33")?.vida?.hp == null, JSON.stringify(tok(rSyncE?.vtt, "tknpc-cc33")?.vida));
    t("espectador: vitalidade manual do NPC permanece como piso narrativo",
      tok(rSyncE?.vtt, "tknpc-cc33")?.vida?.vitalidade?.nivel === 2, JSON.stringify(tok(rSyncE?.vtt, "tknpc-cc33")?.vida?.vitalidade));
    t("espectador: SEM vida no token sem vínculo", tok(rSyncE?.vtt, "tksem-ee55")?.vida == null);
  }

  // ---------- C. atualização após personagens:atualizados ----------
  sec("C. HP alterado → mesa:vtt:sincronizar reflete sem mesa:vtt");
  {
    // mestre aplica dano de 10 no PJ1 via endpoint real (emite personagens:atualizados)
    const rHp = await req(BASE, "POST", `/characters/${PJ1}/hp`, { cookie: ids.cookieMestre, body: { acao: "dano", quantidade: 10, motivo: "teste vida vtt" } });
    t("POST /hp dano 10", rHp.status === 200, `status=${rHp.status} ${JSON.stringify(rHp.json).slice(0, 160)}`);
    await dormir(400); // socket entrega personagens:atualizados; cliente sincroniza sob demanda
    const rSync = await sincronizar(sA);
    t("j1: vida.atual atualizada (120→110)", tok(rSync?.vtt, "tkpj1-aa11")?.vida?.hp?.atual === 110, JSON.stringify(tok(rSync?.vtt, "tkpj1-aa11")?.vida));
    const rSyncB = await sincronizar(sB);
    t("j2 (flag on): vida do PJ1 atualizada também", tok(rSyncB?.vtt, "tkpj1-aa11")?.vida?.hp?.atual === 110);
  }

  // ---------- D. vtt_state nunca persiste vida ----------
  sec("D. Persistência — vida não vai para vtt_state");
  {
    const db = abrirDb(BANCO);
    const row = db.prepare("select vtt_state from sessions where id=?").get(sid);
    db.close();
    const estado = JSON.parse(typeof row?.vtt_state === "string" ? row.vtt_state : JSON.stringify(row?.vtt_state ?? {}));
    const tokens = estado?.tokens ?? [];
    t("nenhum token persistido tem campo vida", tokens.every((tk) => !("vida" in tk)), JSON.stringify(tokens[0]));
    t("tokens persistidos mantêm vínculos", tokens.some((tk) => tk.id === "tkpj1-aa11" && tk.personagemId === PJ1));
  }

  // ---------- E. flag off de novo — vida some no próximo sync ----------
  sec("E. Desligar compartilhada remove vida alheia no sync");
  {
    await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: false } } });
    const rSync = await sincronizar(sA);
    t("j1: vida no próprio token permanece", tok(rSync?.vtt, "tkpj1-aa11")?.vida?.hp?.atual === 110);
    t("j1: vida no token do j2 removida", tok(rSync?.vtt, "tkpj2-bb22")?.vida == null);
    t("j1: vida no NPC removida", tok(rSync?.vtt, "tknpc-cc33")?.vida == null);
    const rSyncM = await sincronizar(sM);
    t("mestre: vida permanece em todos", tok(rSyncM?.vtt, "tkpj2-bb22")?.vida?.hp?.maximo === 150 && tok(rSyncM?.vtt, "tknpc-cc33")?.vida?.hp?.maximo === 180);
  }

  // ---------- F. névoa: token fora da área revelada não entrega vida ----------
  sec("F. Névoa de guerra — token oculto pela névoa não vaza vida");
  {
    // Reveala só metade esquerda; PJ2 está em (0.9,0.9) — fora da névoa.
    const pNv = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sB), esperarVtt(sE)]);
    const rNv = await emitirCb(sM, "mesa:vtt:nevoa", {
      sessionId: sid, acao: "revelar",
      traco: { raioX: 0.2, raioY: 0.2, pontos: [{ x: 0.3, y: 0.3 }] },
    });
    t("mestre revela traco", rNv?.ok === true, JSON.stringify(rNv).slice(0, 120));
    await pNv;
    // Com flag off, j1 não teria vida no PJ2 de qualquer forma — religa a
    // flag para isolar o efeito da névoa.
    await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: true } } });
    const rSync = await sincronizar(sA);
    const vA = rSync?.vtt;
    t("névoa: token PJ2 fora da área não é entregue a j1", tok(vA, "tkpj2-bb22") === undefined, `tokens=${(vA?.tokens ?? []).map((x) => x.id).join(",")}`);
    t("névoa: token PJ1 dentro da área mantém vida", tok(vA, "tkpj1-aa11")?.vida?.hp?.atual === 110);
    const rSyncM2 = await sincronizar(sM);
    t("mestre ignora névoa: vida no PJ2 continua", tok(rSyncM2?.vtt, "tkpj2-bb22")?.vida != null);
    // Desfaz a névoa para não afetar outras verificações.
    await emitirCb(sM, "mesa:vtt:nevoa", { sessionId: sid, acao: "revelarTudo" });
  }

  // ---------- G. rate limit vttSync — cota por usuário, não por socket ----------
  let sA2;
  sec("G. Rate limit mesa:vtt:sincronizar — compartilhado entre sockets do mesmo usuário");
  {
    sA2 = conectar(c.jogadores.jogador1.cookie);
    await pronto(sA2);
    const rEntra = await emitirCb(sA2, "mesa:entrar", { sessionId: sid });
    t("segundo socket do j1 entra", rEntra?.ok === true);
    // drena a cota do usuário j1 em lotes até a primeira rejeição —
    // sincronizações aceitas são pesadas (comLockVtt + consultas) e a
    // reposição de 16/s não acompanha uma rajada; a rejeição prova o
    // bucket vazio NO MOMENTO, sem depender de sleeps frágeis.
    let primeiroLimitado = null;
    for (let lote = 0; lote < 12 && !primeiroLimitado; lote++) {
      const rs = await Promise.all(Array.from({ length: 10 }, () => sincronizar(sA)));
      primeiroLimitado = rs.find((r) => r?.codigo === "RATE_LIMITED") ?? null;
    }
    t("rajada acima do burst gera RATE_LIMITED com retryAfterMs > 0",
      !!primeiroLimitado && typeof primeiroLimitado.retryAfterMs === "number" && primeiroLimitado.retryAfterMs > 0,
      primeiroLimitado ? `retryAfterMs=${primeiroLimitado.retryAfterMs}` : "sem rejeição");
    // o segundo socket do MESMO usuário divide a mesma cota — com o
    // bucket acabado de esvaziar, a próxima sync dele é rejeitada
    const rA2 = await sincronizar(sA2);
    t("segundo socket do mesmo usuário também recebe RATE_LIMITED",
      rA2?.codigo === "RATE_LIMITED" && typeof rA2?.retryAfterMs === "number" && rA2.retryAfterMs > 0,
      JSON.stringify(rA2).slice(0, 140));
    // sync de névoa divide o MESMO balde vttSync: com o bucket acabado
    // de esvaziar pela rajada acima, ela também é rejeitada — em
    // qualquer socket do mesmo usuário
    const rNevA = await sincronizarNevoa(sA);
    t("sync de névoa compartilha o balde vttSync (RATE_LIMITED)",
      rNevA?.codigo === "RATE_LIMITED" && typeof rNevA?.retryAfterMs === "number" && rNevA.retryAfterMs > 0,
      JSON.stringify(rNevA).slice(0, 140));
    const rNevA2 = await sincronizarNevoa(sA2);
    t("sync de névoa no 2º socket do mesmo usuário também RATE_LIMITED",
      rNevA2?.codigo === "RATE_LIMITED" && typeof rNevA2?.retryAfterMs === "number" && rNevA2.retryAfterMs > 0,
      JSON.stringify(rNevA2).slice(0, 140));
    // cota reposta → sincronizações legítimas voltam e HP segue correto
    await dormir(1600);
    const rOk = await sincronizar(sA);
    t("sync legítimo após reposição da cota → ok", rOk?.ok === true, JSON.stringify(rOk).slice(0, 140));
    const rOkNev = await sincronizarNevoa(sA);
    t("sync de névoa legítimo após reposição → ok", rOkNev?.ok === true, JSON.stringify(rOkNev).slice(0, 140));
    t("HP atualizado continua chegando no sync", tok(rOk?.vtt, "tkpj1-aa11")?.vida?.hp?.atual === 110,
      JSON.stringify(tok(rOk?.vtt, "tkpj1-aa11")?.vida));
  }

  // ---------- H. K=4 — duas sessões × duas abas do mesmo usuário ----------
  sec("H. Uso legítimo contínuo K=4 por 30s — zero RATE_LIMITED");
  {
    // sessão B real; j1 entra com 2 sockets em cada sessão (K=4 total)
    const sess2 = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Mesa Vida B" } });
    const sid2 = sess2.json?.sessao?.id ?? sess2.json?.id;
    t("segunda sessão criada", !!sid2);
    const sB1 = conectar(c.jogadores.jogador1.cookie);
    const sB2 = conectar(c.jogadores.jogador1.cookie);
    await Promise.all([pronto(sB1), pronto(sB2)]);
    const [e1, e2, e3, e4] = await Promise.all([
      emitirCb(sA, "mesa:entrar", { sessionId: sid }),
      emitirCb(sA2, "mesa:entrar", { sessionId: sid }),
      emitirCb(sB1, "mesa:entrar", { sessionId: sid2 }),
      emitirCb(sB2, "mesa:entrar", { sessionId: sid2 }),
    ]);
    t("quatro sockets do mesmo usuário entram (2 sessões)", e1?.ok && e2?.ok && e3?.ok && e4?.ok);

    // cada socket sincroniza a cada ~255ms por 30s → ~15,7 sync/s
    // agregados (≈ debounce de 250ms × 4 abas) — dentro da taxa
    // sustentada de 16/s; o burst de 48 absorve o jitter inicial.
    let limitados = 0, oks = 0, outros = 0;
    const t0 = Date.now();
    const alvoDe = (s) => (s === sB1 || s === sB2 ? sid2 : sid);
    const loops = [sA, sA2, sB1, sB2].map((s) => (async () => {
      const sidAlvo = alvoDe(s);
      while (Date.now() - t0 < 30000) {
        const r = await emitirCb(s, "mesa:vtt:sincronizar", { sessionId: sidAlvo });
        if (r?.codigo === "RATE_LIMITED") limitados++;
        else if (r?.ok) oks++;
        else outros++;
        await dormir(255);
      }
    })());
    await Promise.all(loops);
    t("30s K=4 sem RATE_LIMITED", limitados === 0, `limitados=${limitados} oks=${oks} outros=${outros}`);
  }

  // ---------- I. HP manual em token SEM ficha (F14/#127) ----------
  sec("I. HP manual — token sem personagemId");
  {
    // A seção F liga a flag para isolar névoa; força OFF novamente para
    // que os vetores F14 comecem de forma determinística.
    const cfgInicioManual = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`,
      { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: false } } });
    t("vidaCompartilhada OFF antes dos vetores HP manual", cfgInicioManual.status === 200);
    const criarManual = (extra) => emitirCb(sM, "mesa:vtt:token", {
      sessionId: sid, acao: "criar",
      token: { id: extra.id, nome: extra.id, cor: "#445566", x: 0.3, y: 0.3, ...extra },
    });
    const syncM = () => sincronizar(sM);

    // criação com HP manual válido (fração inclusa)
    const rCriar = await criarManual({ id: "tkman-001", hpManual: { atual: 30, maximo: 50.5 } });
    t("mestre cria token manual com HP", rCriar?.ok === true, JSON.stringify(rCriar).slice(0, 160));
    let vM = await syncM();
    const tm = tok(rCriar?.vtt ?? vM?.vtt, "tkman-001");
    t("mestre recebe vida.hp manual 30/50.5", tm?.vida?.hp?.atual === 30 && tm?.vida?.hp?.maximo === 50.5, JSON.stringify(tm?.vida));
    t("hpManual NUNCA sai bruto no payload", tm && !("hpManual" in tm), JSON.stringify(Object.keys(tm ?? {})));

    // HP manual respeita a mesma política explícita de compartilhamento
    // da vida derivada de ficha: OFF (padrão) = só mestre; ON = tokens visíveis.
    const [rSAoff, rSBoff, rSEoff] = await Promise.all([sincronizar(sA), sincronizar(sB), sincronizar(sE)]);
    t("vidaCompartilhada OFF: jogador vê token, mas não HP manual",
      tok(rSAoff?.vtt, "tkman-001") !== undefined && tok(rSAoff?.vtt, "tkman-001")?.vida == null);
    t("vidaCompartilhada OFF: outro jogador não recebe HP manual",
      tok(rSBoff?.vtt, "tkman-001")?.vida == null);
    t("vidaCompartilhada OFF: espectador não recebe HP manual",
      tok(rSEoff?.vtt, "tkman-001")?.vida == null);
    const httpOff = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}`,
      { cookie: c.jogadores.jogador1.cookie });
    const httpOffState = httpOff.json?.sessao?.vttState;
    const httpOffVtt = typeof httpOffState === "string" ? JSON.parse(httpOffState) : httpOffState;
    t("HTTP com vidaCompartilhada OFF não entrega HP manual",
      tok(httpOffVtt, "tkman-001")?.vida == null && !("hpManual" in (tok(httpOffVtt, "tkman-001") ?? {})));

    const cfgManualOn = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`,
      { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: true } } });
    t("ativa vidaCompartilhada para HP manual", cfgManualOn.status === 200, `status=${cfgManualOn.status}`);
    const [rSAon, rSBon, rSEon] = await Promise.all([sincronizar(sA), sincronizar(sB), sincronizar(sE)]);
    t("vidaCompartilhada ON: jogador recebe HP manual do token visível",
      tok(rSAon?.vtt, "tkman-001")?.vida?.hp?.maximo === 50.5);
    t("vidaCompartilhada ON: outro jogador recebe HP manual",
      tok(rSBon?.vtt, "tkman-001")?.vida?.hp?.atual === 30);
    t("vidaCompartilhada ON: espectador recebe HP manual visível",
      tok(rSEon?.vtt, "tkman-001")?.vida?.hp?.maximo === 50.5);
    const httpOn = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}`,
      { cookie: c.jogadores.jogador1.cookie });
    const httpOnState = httpOn.json?.sessao?.vttState;
    const httpOnVtt = typeof httpOnState === "string" ? JSON.parse(httpOnState) : httpOnState;
    t("HTTP com vidaCompartilhada ON entrega vida.hp, nunca hpManual",
      tok(httpOnVtt, "tkman-001")?.vida?.hp?.maximo === 50.5
        && !("hpManual" in (tok(httpOnVtt, "tkman-001") ?? {})));

    const cfgManualOff = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`,
      { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: false } } });
    t("desliga novamente vidaCompartilhada após a prova ON", cfgManualOff.status === 200);
    const [rSA, rSB, rSE] = await Promise.all([sincronizar(sA), sincronizar(sB), sincronizar(sE)]);
    t("vidaCompartilhada OFF: HP manual some após novo sync",
      [rSA, rSB, rSE].every((r) => tok(r?.vtt, "tkman-001")?.vida == null));
    t("nenhum destinatário recebe hpManual bruto",
      [rSA, rSB, rSE, rCriar].every((r) => { const tk = tok(r?.vtt, "tkman-001"); return tk && !("hpManual" in tk); }));

    // edição e limpeza pelo mestre
    const rUpd = await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: "tkman-001", hpManual: { atual: 12.5, maximo: 40 } } });
    t("mestre edita HP manual", rUpd?.ok === true);
    t("vida.hp reflete edição 12.5/40", tok(rUpd?.vtt, "tkman-001")?.vida?.hp?.atual === 12.5 && tok(rUpd?.vtt, "tkman-001")?.vida?.hp?.maximo === 40);
    const rClear = await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: "tkman-001", hpManual: null } });
    t("mestre limpa HP manual", rClear?.ok === true && tok(rClear?.vtt, "tkman-001")?.vida == null, JSON.stringify(tok(rClear?.vtt, "tkman-001")?.vida));

    // token do jogador sem ficha: mestre define HP; jogador NÃO consegue
    const rTkUser = await criarManual({ id: "tkman-002", userId: ids.j1 });
    t("token manual do j1 criado", rTkUser?.ok === true);
    const rHpM2 = await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: "tkman-002", hpManual: { atual: 10, maximo: 20 } } });
    t("mestre define HP manual no token do jogador", rHpM2?.ok === true);
    const rHpJ1 = await emitirCb(sA, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: "tkman-002", hpManual: { atual: 99, maximo: 99 } } });
    const vDepoisJ1 = await sincronizar(sA);
    const vDepoisMestre = await syncM();
    t("vidaCompartilhada OFF: dono do token sem ficha também não recebe HP",
      tok(vDepoisJ1?.vtt, "tkman-002")?.vida == null);
    t("mestre mantém autoridade e vê HP manual 10/20",
      tok(vDepoisMestre?.vtt, "tkman-002")?.vida?.hp?.atual === 10
        && tok(vDepoisMestre?.vtt, "tkman-002")?.vida?.hp?.maximo === 20);
    void rHpJ1;

    // espectador read-only
    const rHpE = await emitirCb(sE, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: "tkman-001", hpManual: { atual: 1, maximo: 2 } } });
    t("espectador não altera HP manual", rHpE?.ok === false, JSON.stringify(rHpE).slice(0, 120));

    // HP inválido — fail-closed, sem persistência
    for (const [nome, hp] of [
      ["máximo zero", { atual: 0, maximo: 0 }],
      ["atual > máximo", { atual: 60, maximo: 50 }],
      ["atual negativo", { atual: -1, maximo: 50 }],
      ["NaN", { atual: NaN, maximo: 50 }],
      ["texto", { atual: "30", maximo: 50 }],
    ]) {
      const r = await criarManual({ id: `tkbad-${nome.length}`, hpManual: hp });
      t(`HP inválido rejeitado: ${nome}`, r?.ok === false, JSON.stringify(r).slice(0, 100));
    }

    // vincular ficha limpa hpManual na mesma mutação
    await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: "tkman-001", hpManual: { atual: 20, maximo: 30 } } });
    const rVinc = await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "atualizar", token: { id: "tkman-001", personagemId: PJ1 } });
    t("vincular ficha aceito", rVinc?.ok === true, JSON.stringify(rVinc).slice(0, 140));
    // PJ1 tem vida de ficha (110/150 com cfg — seção C já debitou 10) — não o manual 20/30
    const vAposVinc = tok(rVinc?.vtt, "tkman-001")?.vida;
    t("vida passa a vir da ficha (não do manual)", vAposVinc?.hp?.atual === 110, JSON.stringify(vAposVinc));

    // criar já vinculado + hpManual → rejeitado
    const rAmbos = await criarManual({ id: "tkamb-01", personagemId: PJ2, hpManual: { atual: 1, maximo: 2 } });
    t("token com ficha + hpManual rejeitado", rAmbos?.ok === false, JSON.stringify(rAmbos).slice(0, 120));

    // persistência: hpManual fica em vtt_state; vida NUNCA é persistida
    {
      const db = abrirDb(BANCO);
      const row = db.prepare("select vtt_state from sessions where id=?").get(sid);
      db.close();
      const bruto = JSON.parse(row.vtt_state);
      const tks = bruto.tokens ?? [];
      const tk002 = tks.find((x) => x.id === "tkman-002");
      t("vtt_state persiste hpManual do token sem ficha", tk002?.hpManual?.atual === 10 && tk002?.hpManual?.maximo === 20, JSON.stringify(tk002?.hpManual));
      const tk001 = tks.find((x) => x.id === "tkman-001");
      t("hpManual removido do token que ganhou ficha", !("hpManual" in (tk001 ?? {})));
      t("nenhum token persistido tem campo vida", tks.every((x) => !("vida" in x)));
    }

    // reconexão: novo socket recebe vida manual/hp correto
    const sM2 = conectar(ids.cookieMestre);
    await pronto(sM2);
    const rEntrar2 = await emitirCb(sM2, "mesa:entrar", { sessionId: sid });
    t("reconexão do mestre ok", rEntrar2?.ok === true);
    const vRecon = rEntrar2?.sessao?.vttState ? JSON.parse(typeof rEntrar2.sessao.vttState === "string" ? rEntrar2.sessao.vttState : JSON.stringify(rEntrar2.sessao.vttState)) : null;
    t("reconexão entrega vida da ficha no token revinculado", tok(vRecon, "tkman-001")?.vida?.hp?.atual === 110, JSON.stringify(tok(vRecon, "tkman-001")?.vida));

    // HTTP: GET sessão entrega vttState filtrado com vida, sem hpManual
    const det = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}`, { cookie: c.jogadores.jogador1.cookie });
    const vttHttp = det.json?.sessao?.vttState;
    const parsed = typeof vttHttp === "string" ? JSON.parse(vttHttp) : vttHttp;
    const tkHttp = tok(parsed, "tkman-001");
    t("HTTP entrega vida filtrada sem hpManual", !!tkHttp && !("hpManual" in tkHttp) && tkHttp.vida?.hp?.atual === 110, JSON.stringify(tkHttp?.vida));

    // segunda sessão sem o token: nada vaza
    const sess3 = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Mesa Sem Token" } });
    const sid3 = sess3.json?.sessao?.id ?? sess3.json?.id;
    const sA3 = conectar(c.jogadores.jogador1.cookie);
    await pronto(sA3);
    await emitirCb(sA3, "mesa:entrar", { sessionId: sid3 });
    const rSync3 = await emitirCb(sA3, "mesa:vtt:sincronizar", { sessionId: sid3 });
    t("sessão sem o token não recebe vida alguma dele", !tok(rSync3?.vtt, "tkman-001"), JSON.stringify((rSync3?.vtt?.tokens ?? []).length));

    // Exercita o ramo em que a sessão contém APENAS token manual, sem
    // qualquer personagemId. prepararVidaVtt ainda precisa carregar regras.
    const sM3 = conectar(ids.cookieMestre);
    await pronto(sM3);
    const rEntrarM3 = await emitirCb(sM3, "mesa:entrar", { sessionId: sid3 });
    t("mestre entra na sessão manual-only", rEntrarM3?.ok === true);
    const rManualOnly = await emitirCb(sM3, "mesa:vtt:token", {
      sessionId: sid3, acao: "criar",
      token: { id: "tk-manual-only", nome: "Manual Only", cor: "#445566", x: 0.4, y: 0.4,
        userId: ids.j1, hpManual: { atual: 9, maximo: 12 } },
    });
    t("cria token manual-only sem ficha", rManualOnly?.ok === true);
    const rManualOnlyOff = await emitirCb(sA3, "mesa:vtt:sincronizar", { sessionId: sid3 });
    const tkManualOnlyOff = tok(rManualOnlyOff?.vtt, "tk-manual-only");
    t("manual-only OFF: jogador vê token, mas não seu HP",
      !!tkManualOnlyOff && tkManualOnlyOff.vida == null && !("hpManual" in tkManualOnlyOff));
    const cfgOnlyOn = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`,
      { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: true } } });
    t("ativa compartilhamento para sessão manual-only", cfgOnlyOn.status === 200);
    const rManualOnlyOn = await emitirCb(sA3, "mesa:vtt:sincronizar", { sessionId: sid3 });
    const tkManualOnlyOn = tok(rManualOnlyOn?.vtt, "tk-manual-only");
    t("manual-only ON: jogador recebe HP projetado, sem dado bruto",
      tkManualOnlyOn?.vida?.hp?.atual === 9 && tkManualOnlyOn?.vida?.hp?.maximo === 12
        && !("hpManual" in tkManualOnlyOn));
    const rMasterOnlyOff = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`,
      { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: false } } });
    t("restaura compartilhamento OFF ao final", rMasterOnlyOff.status === 200);
  }
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e?.stack ?? e).slice(0, 800));
} finally {
  for (const s of sockets) { try { s.close(); } catch { } }
  await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n==== vtt-vida: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
