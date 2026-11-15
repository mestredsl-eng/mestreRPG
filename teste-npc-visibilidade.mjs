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

  // ---------- Piso narrativo: manual 3 + conversão → 4 ----------
  // O nível real sobe para 4 por conversão (máx. real), mas o jogador
  // não pode perder o piso manual 3 — só o incremento automático é
  // clampado. Limiares novos: só pct ≤ 60% (do máximo REAL) exige 4.
  sec("Privacidade — piso manual preservado sob conversão");
  r = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, {
    cookie: ids.cookieMestre,
    body: { conversaoFerimento: { habilitada: true, limiares: [{ ate: 60, nivel: 4 }] } },
  });
  t("mestre ajusta limiar p/ nível 4", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.erro ?? "")}`);
  // atual 125 − 40 = 85 → pct real 56,7% ≤ 60 → sobe p/ nível 4.
  // Público: HP exibido 85/100 → pct 85% → nenhum limiar → teto 0.
  r = await req(BASE, "POST", `/characters/${idNpc}/hp`, { cookie: ids.cookieMestre, body: { acao: "dano", quantidade: 40, motivo: "Surra completa" } });
  t("conversão eleva vitalidade real p/ nível 4", r.status === 200 && r.json?.ferimento?.para === 4, `status=${r.status} ${JSON.stringify(r.json?.ferimento ?? r.json?.erro ?? "")}`);

  const fM4 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.cookieMestre });
  const fJ4 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("mestre vê nível real 4", fM4.json?.ficha?.vida?.vitalidade?.nivel === 4, JSON.stringify(fM4.json?.ficha?.vida?.vitalidade));
  t("jogador vê piso manual 3 (incremento automático oculto)", fJ4.json?.ficha?.vida?.vitalidade?.nivel === 3, JSON.stringify(fJ4.json?.ficha?.vida?.vitalidade));

  // Nova decisão manual posterior redefine tudo — jogador vê o real.
  r = await req(BASE, "POST", `/characters/${idNpc}/vitalidade`, { cookie: ids.cookieMestre, body: { nivel: 1, motivo: "Recuperou parcialmente" } });
  t("mestre redefine vitalidade p/ nível 1", r.status === 200, `status=${r.status}`);
  const fJ5 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("jogador vê nova decisão manual (nível 1)", fJ5.json?.ficha?.vida?.vitalidade?.nivel === 1, JSON.stringify(fJ5.json?.ficha?.vida?.vitalidade));

  // Personagem normal do jogador não é afetado pela regra de NPC.
  const fPj = await req(BASE, "GET", `/characters/${idPj}`, { cookie: ids.j1.cookie });
  t("personagem normal do jogador inalterado", fPj.status === 200 && fPj.json?.ficha != null);

  // ---------- Snapshot de limiares: regra atual não é prova ----------
  // A leitura pública deve avaliar o evento automático pela regra que o
  // PRODUZIU (snapshot no histórico), não pela config atual mutável.
  sec("Privacidade — snapshot de limiares da conversão");
  // HP real para 125 (recuperar não dispara conversão); depois dano 5 →
  // atual 120 → pct real 80% ≤ 90 → conversão eleva p/ nível 4.
  // Jogador vê HP grampeado 100/100 → pct público 100% > 90 → oculto.
  r = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, {
    cookie: ids.cookieMestre,
    body: { conversaoFerimento: { habilitada: true, limiares: [{ ate: 90, nivel: 4 }] } },
  });
  t("mestre define limiar ate:90→4", r.status === 200, `status=${r.status}`);
  await req(BASE, "POST", `/characters/${idNpc}/hp`, { cookie: ids.cookieMestre, body: { acao: "recuperar", quantidade: 40, motivo: "Descanso longo" } });
  r = await req(BASE, "POST", `/characters/${idNpc}/hp`, { cookie: ids.cookieMestre, body: { acao: "dano", quantidade: 5, motivo: "Arranhão" } });
  t("conversão eleva p/ nível 4 com HP público 100%", r.status === 200 && r.json?.ferimento?.para === 4, `status=${r.status} ${JSON.stringify(r.json?.ferimento ?? r.json?.erro ?? "")}`);
  let fJ6 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("jogador vê só o piso manual (nível 1), não o 4 automático",
    fJ6.json?.ficha?.vida?.vitalidade?.nivel === 1, JSON.stringify(fJ6.json?.ficha?.vida?.vitalidade));

  // DESATIVA a conversão: o clamp continua — a prova é o snapshot do
  // evento, não a config atual (antes da correção isto vazava o 4).
  r = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, {
    cookie: ids.cookieMestre,
    body: { conversaoFerimento: { habilitada: false, limiares: [] } },
  });
  t("mestre desabilita conversão", r.status === 200, `status=${r.status}`);
  fJ6 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("com conversão DESABILITADA jogador segue sem o nível automático",
    fJ6.json?.ficha?.vida?.vitalidade?.nivel === 1, JSON.stringify(fJ6.json?.ficha?.vida?.vitalidade));
  const fM6 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.cookieMestre });
  t("mestre segue vendo vitalidade real 4", fM6.json?.ficha?.vida?.vitalidade?.nivel === 4);

  // ALTERA os limiares p/ algo que justificaria 4 no HP público:
  // o cálculo usa o snapshot do evento, não a config nova.
  r = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, {
    cookie: ids.cookieMestre,
    body: { conversaoFerimento: { habilitada: true, limiares: [{ ate: 100, nivel: 4 }] } },
  });
  t("mestre altera limiares p/ ate:100→4", r.status === 200, `status=${r.status}`);
  fJ6 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("limiares novos NÃO reabilitam o nível automático ao jogador",
    fJ6.json?.ficha?.vida?.vitalidade?.nivel === 1, JSON.stringify(fJ6.json?.ficha?.vida?.vitalidade));

  // Decisão manual posterior substitui o piso.
  r = await req(BASE, "POST", `/characters/${idNpc}/vitalidade`, { cookie: ids.cookieMestre, body: { nivel: 2, motivo: "Avaliação do mestre" } });
  t("mestre redefine piso p/ nível 2", r.status === 200, `status=${r.status}`);
  fJ6 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("jogador vê novo piso manual (nível 2)", fJ6.json?.ficha?.vida?.vitalidade?.nivel === 2);

  // O piso manual é persistido como estado próprio — não depende do
  // histórico que sofre slice(-100).
  const nivelManualDb = comDb(BANCO, (db) => {
    const row = db.prepare("select data from characters where id=?").get(idNpc);
    return JSON.parse(row.data)?.__vitalidade?.nivelManual;
  });
  t("piso manual persistido em __vitalidade.nivelManual", nivelManualDb === 2, `nivelManual=${nivelManualDb}`);

  // Evento automático ANTIGO sem snapshot → fallback conservador:
  // remove `limiares` do evento de conversão direto no banco.
  {
    const w = abrirDb(BANCO);
    try {
      const row = w.prepare("select data from characters where id=?").get(idNpc);
      const dados = JSON.parse(row.data);
      const hist = dados.__vitalidade?.historico ?? [];
      const ultimoAuto = [...hist].reverse().find((e) => e.origem === "conversao-ferimento");
      if (ultimoAuto) delete ultimoAuto.limiares;
      w.prepare("update characters set data=? where id=?").run(JSON.stringify(dados), idNpc);
    } finally { w.close(); }
  }
  // novo dano cruza o limiar atual (ate:100→4) → nova conversão → 4,
  // mas o evento ANTIGO sem snapshot não prova nada; o evento NOVO tem
  // snapshot — para testar o fallback, removo o snapshot do NOVO evento.
  r = await req(BASE, "POST", `/characters/${idNpc}/hp`, { cookie: ids.cookieMestre, body: { acao: "dano", quantidade: 30, motivo: "Pancada" } });
  t("nova conversão eleva p/ nível 4", r.status === 200 && r.json?.ferimento?.para === 4, `status=${r.status} ${JSON.stringify(r.json?.ferimento ?? r.json?.erro ?? "")}`);
  {
    const w = abrirDb(BANCO);
    try {
      const row = w.prepare("select data from characters where id=?").get(idNpc);
      const dados = JSON.parse(row.data);
      const hist = dados.__vitalidade?.historico ?? [];
      const ultimo = hist[hist.length - 1];
      if (ultimo?.origem === "conversao-ferimento") delete ultimo.limiares;
      w.prepare("update characters set data=? where id=?").run(JSON.stringify(dados), idNpc);
    } finally { w.close(); }
  }
  fJ6 = await req(BASE, "GET", `/characters/${idNpc}`, { cookie: ids.j1.cookie });
  t("evento automático sem snapshot → fallback conservador (só piso 2)",
    fJ6.json?.ficha?.vida?.vitalidade?.nivel === 2, JSON.stringify(fJ6.json?.ficha?.vida?.vitalidade));

  // ---------- Regressão: nivelManual sobrevive à conversão automática ----------
  // Auditoria PR #105: lerVitalidade() não devolvia nivelManual, então a
  // conversão ({...vitAnt}) apagava o piso narrativo persistido.
  sec("Regressão — nivelManual persistido sob conversão automática");
  const npcVit = await req(BASE, "POST", `/campaigns/${ids.camp}/characters`, {
    cookie: ids.cookieMestre,
    body: { name: "Escala Vitalidade", templateVersionId: verId, isNpc: true },
  });
  const idVit = npcVit.json?.personagem?.id;
  t("NPC de vitalidade criado", npcVit.status === 201 && !!idVit, `status=${npcVit.status}`);
  await req(BASE, "POST", `/characters/${idVit}/npc-visibilidade`, { cookie: ids.cookieMestre, body: { visivel: true } });
  // FOR=5 → HP máximo real 150, público 100 (for é privado p/ jogador).
  r = await req(BASE, "PATCH", `/characters/${idVit}`, { cookie: ids.cookieMestre, body: { data: { for: 5 } } });
  t("mestre define FOR=5", r.status === 200, `status=${r.status}`);
  const fVitHp = await req(BASE, "GET", `/characters/${idVit}`, { cookie: ids.cookieMestre });
  t("HP máximo real = 150 com FOR=5", fVitHp.json?.ficha?.vida?.hp?.maximo === 150, JSON.stringify(fVitHp.json?.ficha?.vida?.hp));
  // Piso manual 5 — dentro da escala de 7 níveis vigente.
  r = await req(BASE, "POST", `/characters/${idVit}/vitalidade`, { cookie: ids.cookieMestre, body: { nivel: 5, motivo: "Ferimentos graves" } });
  t("mestre define piso manual 5", r.status === 200, `status=${r.status}`);
  const vitDb1 = comDb(BANCO, (db) => JSON.parse(db.prepare("select data from characters where id=?").get(idVit).data)?.__vitalidade);
  t("nivelManual=5 gravado no banco", vitDb1?.nivelManual === 5, JSON.stringify(vitDb1?.nivelManual));
  // Conversão: __hp.atual=100 (persistido antes do FOR=5); dano 40 →
  // HP 60/150 = 40% ≤ 50 → exige nível 6 (> piso 5).
  // Público: 60/100 = 60% > 50 → incremento automático NÃO é justificável.
  r = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, {
    cookie: ids.cookieMestre,
    body: { conversaoFerimento: { habilitada: true, limiares: [{ ate: 50, nivel: 6 }] } },
  });
  t("limiar ate:50→6 configurado", r.status === 200, `status=${r.status}`);
  r = await req(BASE, "POST", `/characters/${idVit}/hp`, { cookie: ids.cookieMestre, body: { acao: "dano", quantidade: 40, motivo: "Dose letal" } });
  t("conversão automática eleva p/ nível 6", r.status === 200 && r.json?.ferimento?.para === 6, `status=${r.status} ${JSON.stringify(r.json?.ferimento ?? r.json?.erro ?? "")}`);
  const vitDb2 = comDb(BANCO, (db) => JSON.parse(db.prepare("select data from characters where id=?").get(idVit).data)?.__vitalidade);
  t("nivelManual=5 SOBREVIVE à conversão automática", vitDb2?.nivelManual === 5, `nivel=${vitDb2?.nivel} nivelManual=${vitDb2?.nivelManual}`);
  // Remove os eventos manuais do histórico: o piso só pode vir do campo
  // persistido — antes da correção o jogador veria nível 0.
  {
    const w = abrirDb(BANCO);
    try {
      const row = w.prepare("select data from characters where id=?").get(idVit);
      const dados = JSON.parse(row.data);
      dados.__vitalidade.historico = (dados.__vitalidade.historico ?? []).filter((e) => e.origem === "conversao-ferimento");
      w.prepare("update characters set data=? where id=?").run(JSON.stringify(dados), idVit);
    } finally { w.close(); }
  }
  const fVitJ = await req(BASE, "GET", `/characters/${idVit}`, { cookie: ids.j1.cookie });
  t("jogador segue vendo piso manual 5 sem evento manual no histórico",
    fVitJ.status === 200 && fVitJ.json?.ficha?.vida?.vitalidade?.nivel === 5,
    `status=${fVitJ.status} ${JSON.stringify(fVitJ.json?.ficha?.vida?.vitalidade ?? fVitJ.json?.erro ?? "")}`);
  const fVitM = await req(BASE, "GET", `/characters/${idVit}`, { cookie: ids.cookieMestre });
  t("mestre segue vendo nível real 6", fVitM.json?.ficha?.vida?.vitalidade?.nivel === 6, JSON.stringify(fVitM.json?.ficha?.vida?.vitalidade));

  // ---------- Regressão: piso manual além da escala atual ----------
  // Auditoria PR #105: escala reduzida de 7 → 5 níveis com nivelManual=5
  // persistido → nivelExibido=5 indexava niveis[5] === undefined → 500.
  sec("Regressão — piso manual acima da escala reduzida");
  r = await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, {
    cookie: ids.cookieMestre,
    body: {
      conversaoFerimento: { habilitada: false, limiares: [] },
      vitalidade: {
        edicaoPor: "mestre",
        niveis: [
          { nome: "Escoriado", penalidadeDados: 0, bloqueiaAcoes: false },
          { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
          { nome: "Ferido", penalidadeDados: 1, bloqueiaAcoes: false },
          { nome: "Grave", penalidadeDados: 2, bloqueiaAcoes: false },
          { nome: "Crítico", penalidadeDados: 5, bloqueiaAcoes: true },
        ],
      },
    },
  });
  t("escala reduzida p/ 5 níveis", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.erro ?? "")}`);
  const fVitJ2 = await req(BASE, "GET", `/characters/${idVit}`, { cookie: ids.j1.cookie });
  const vitJ2 = fVitJ2.json?.ficha?.vida?.vitalidade;
  t("ficha do jogador responde 200 com escala reduzida", fVitJ2.status === 200, `status=${fVitJ2.status}`);
  t("nível exibido dentro da escala vigente (0–4)",
    vitJ2 != null && Number.isInteger(vitJ2.nivel) && vitJ2.nivel >= 0 && vitJ2.nivel <= 4 && typeof vitJ2.nome === "string",
    JSON.stringify(vitJ2));
  const fVitM2 = await req(BASE, "GET", `/characters/${idVit}`, { cookie: ids.cookieMestre });
  t("ficha do mestre também íntegra", fVitM2.status === 200 && fVitM2.json?.ficha?.vida?.vitalidade != null, `status=${fVitM2.status}`);

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
