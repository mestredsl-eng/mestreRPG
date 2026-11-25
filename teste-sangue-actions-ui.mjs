#!/usr/bin/env node
// Teste E2E das AÇÕES de Sangue na UI (Issue #186 — correção .9:
// widget integrado à ficha; contrato real R6.3 da PR #230:
// p/ mestre). A ativação sem rolagem é oferecida junto ao Poder já
// selecionado na ficha, sem segundo seletor; o fluxo D10 continua
// cobrando no próprio teste. Cobre também a ativação narrativa, retry
// visual, permissões e ausência de controles para não-donos/espectadores.
// Cobre: recuperação pelo dono, erro/permissões (dono vs mestre vs
// espectador), mobile 390px e ausência de controles indevidos.
// Servidor+SQLite+site 100% descartáveis.
import crypto from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, encerrarServidor, limparDir, req, sessao,
} from "./teste-base.mjs";

const DIR = dirTeste("sangue-actions-ui");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let pass = 0, fail = 0;
const t = (n, c, x = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, x); } };
const sec = (n) => console.log("\n== " + n + " ==");

function db() { return abrirDb(BANCO); }
function setSangue(charId, sangue) {
  const w = db();
  try {
    const row = w.prepare("select data from characters where id=?").get(charId);
    const data = JSON.parse(row.data || "{}");
    if (sangue === undefined) delete data.__sangue; else data.__sangue = sangue;
    w.prepare("update characters set data=? where id=?").run(JSON.stringify(data), charId);
  } finally { w.close(); }
}
function setSangueConfig(campId, sangue) {
  const w = db();
  try {
    const rs = w.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campId);
    const cfg = JSON.parse(rs.config || "{}");
    if (sangue === null) delete cfg.sangue; else cfg.sangue = sangue;
    w.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
  } finally { w.close(); }
}

function setVisibilidadeCampo(versionId, campoId, visibilidade) {
  const w = db();
  try {
    const row = w.prepare("select structure from sheet_versions where id=?").get(versionId);
    if (!row) throw new Error("Versão de ficha não encontrada: " + versionId);
    const estrutura = typeof row.structure === "string" ? JSON.parse(row.structure) : row.structure;
    const campo = estrutura.secoes.flatMap((s) => s.campos).find((c) => c.id === campoId);
    if (!campo) throw new Error("Campo não encontrado: " + campoId);
    campo.visibilidade = visibilidade;
    w.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(estrutura), versionId);
  } finally { w.close(); }
}
function setOverrideCampo(charId, campoId, override) {
  const w = db();
  try {
    const row = w.prepare("select overrides from characters where id=?").get(charId);
    if (!row) throw new Error("Personagem não encontrado: " + charId);
    const overrides = typeof row.overrides === "string"
      ? JSON.parse(row.overrides || "{}")
      : { ...(row.overrides ?? {}) };
    if (override === null) delete overrides[campoId];
    else overrides[campoId] = override;
    w.prepare("update characters set overrides=? where id=?").run(JSON.stringify(overrides), charId);
  } finally { w.close(); }
}
function setPoderesLimite(campId, limite) {
  const w = db();
  try {
    const rs = w.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campId);
    const cfg = JSON.parse(rs.config || "{}");
    cfg.poderes = { ...(cfg.poderes || {}), limitePoderes: limite };
    w.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
  } finally { w.close(); }
}
function saldoDe(charId) {
  const w = db();
  try {
    const row = w.prepare("select data from characters where id=?").get(charId);
    return JSON.parse(row.data || "{}").__sangue?.saldo ?? null;
  } finally { w.close(); }
}
function definicaoPoder(campId, key) {
  const w = db();
  try {
    const rs = w.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
    const row = w.prepare("select definition from rule_definitions where rule_set_id=? and kind='poder' and key=?").get(rs.id, key);
    return JSON.parse(row?.definition || "{}");
  } finally { w.close(); }
}
function nomeDe(charId) {
  const w = db();
  try {
    return w.prepare("select name from characters where id=?").get(charId)?.name ?? null;
  } finally { w.close(); }
}

const CFG = {
  habilitado: true,
  campoCapacidadeId: "cap",
  campoNaturezaId: "nat",
  capacidade: { modo: "valor" },
  naturezas: {
    Humano: { recuperacao: "descansar" },
    Vampiro: { recuperacao: "alimentar" },
  },
  recuperacaoSangue: {
    habilitado: true,
    acoes: {
      descansar: { habilitada: true, quantidade: 2 },
      alimentar: { habilitada: true, quantidade: 3 },
    },
  },
  poderes: {
    poder_fogo: { custo: 2 },
    poder_d10: { custo: 2 },
    poder_frac: { custo: 1 },
    poder_zero: { custo: 1 },
    poder_neg: { custo: 1 },
    poder_sem: { custo: 1 },
    poder_szero: { custo: 1 },
    poder_sneg: { custo: 1 },
    poder_stxt: { custo: 1 },
    poder_saus: { custo: 1 },
  },
};

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Sangue Ações UI",
    jogadores: { j1: "jog_acao1", j2: "jog_acao2" },
  });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.j1.cookie;
  const J2 = c.jogadores.j2.cookie;

  let ESP;
  {
    const w = db();
    const uid = crypto.randomUUID(), mid = crypto.randomUUID(), agora = Date.now();
    w.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, "esp_acao", "Espectador", "$2a$10$fakehashfakehashfakehashfakehashfakehashfakehashfakeha", agora, agora);
    w.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
      .run(mid, CID, uid, agora, agora, agora);
    w.close();
    ESP = sessao(BANCO, uid);
  }

  sec("Fixture — poder, template, config e personagens");
  await req(BASE, "POST", `/campaigns/${CID}/regras/elementos`, {
    cookie: M, body: { kind: "poder", key: "poder_fogo", name: "Poder de Fogo", definition: { disponivel: true } },
  });
  // Poderes para a prova de nível fracionário: todos existem na
  // biblioteca — só o filtro de nível (finito > 0) separa os válidos.
  let idPoderD10 = null;
  for (const [key, name] of [
    ["poder_frac", "Poder Fracionado"],
    ["poder_zero", "Poder Zero"],
    ["poder_neg", "Poder Negativo"],
    ["poder_sem", "Poder Sem Nivel"],
    // Chaves distintas p/ o caminho ESCALAR (campo.regra.key) — assim
    // cada assert de ausência atribui o fracasso ao caminho certo.
    ["poder_szero", "Poder Escalar Zero"],
    ["poder_sneg", "Poder Escalar Negativo"],
    ["poder_stxt", "Poder Escalar Texto"],
    ["poder_saus", "Poder Escalar Ausente"],
    ["poder_d10", "Poder de Teste"],
  ]) {
    const criado = await req(BASE, "POST", `/campaigns/${CID}/regras/elementos`, {
      cookie: M, body: { kind: "poder", key, name, definition: { disponivel: true, ...(key === "poder_d10" ? { exigeTeste: true } : {}) } },
    });
    if (key === "poder_d10") idPoderD10 = criado.json?.id;
  }
  await req(BASE, "PATCH", `/campaigns/${CID}/regras/elementos/${idPoderD10}`, {
    cookie: M, body: { definition: { exigeTeste: false } },
  });
  t("regra D10: PATCH persiste false ao desmarcar", definicaoPoder(CID, "poder_d10").exigeTeste === false);
  await req(BASE, "PATCH", `/campaigns/${CID}/regras/elementos/${idPoderD10}`, {
    cookie: M, body: { definition: { exigeTeste: true } },
  });
  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Ações" } });
  const tid = mod.json.modelo.id, vid = mod.json.modelo.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Sangue", ordem: 0, campos: [
        { id: "cap", label: "Capacidade", tipo: "inteiro", semantico: "atributo", minimo: 1, maximo: 30 },
        { id: "qual", label: "Qualidade bônus", tipo: "inteiro", semantico: "atributo", minimo: 0, maximo: 10 },
        { id: "nat", label: "Natureza", tipo: "selecao_unica", semantico: "livre", opcoes: ["Humano", "Vampiro"] },
        // Um único campo guarda os dois Poderes; o requisito de D10 é por elemento.
        { id: "poderes", label: "Poderes", tipo: "selecao_nivel", semantico: "poder", regraKind: "poder", usadoEmTestes: true },
        // Campos escalares vinculados a Poder via campo.regra — o
        // caminho canônico p/ nível fracionário (0.5 é posse válida).
        { id: "pdec_ok", label: "Poder Dec Ok", tipo: "decimal", regra: { kind: "poder", key: "poder_frac" } },
        { id: "pdec_szero", label: "Poder Dec Szero", tipo: "decimal", regra: { kind: "poder", key: "poder_szero" } },
        { id: "pdec_sneg", label: "Poder Dec Sneg", tipo: "decimal", regra: { kind: "poder", key: "poder_sneg" } },
        { id: "pdec_stxt", label: "Poder Dec Stxt", tipo: "decimal", regra: { kind: "poder", key: "poder_stxt" } },
        { id: "pdec_saus", label: "Poder Dec Saus", tipo: "decimal", regra: { kind: "poder", key: "poder_saus" } },
      ],
    }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });
  setSangueConfig(CID, CFG);
  // A ficha "Frações" carrega 2 poderes válidos (selecao_nivel + escalar)
  // — o limite default da campanha é 1.
  setPoderesLimite(CID, 10);

  const pj = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J1, body: { name: "Herói Ações", templateVersionId: vid, data: { cap: 10, qual: 2, nat: "Humano", poderes: [{ key: "poder_fogo", nivel: 2 }, { key: "poder_d10", nivel: 1 }] } },
  });
  const CHAR = pj.json?.personagem?.id ?? pj.json?.id;
  setSangue(CHAR, { saldo: 5, capacidade: 10, usos: {}, historico: [] });
  const pj2 = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J2, body: { name: "Outro Ações", templateVersionId: vid, data: { cap: 8, nat: "Vampiro", poderes: [] } },
  });
  const CHAR2 = pj2.json?.personagem?.id ?? pj2.json?.id;
  setSangue(CHAR2, { saldo: 4, capacidade: 8, usos: {}, historico: [] });
  // Personagem do PRÓPRIO mestre — dono real para a corrida de posse
  const pjM = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: M, body: { name: "Ficha do Mestre", templateVersionId: vid, data: { cap: 10, nat: "Humano", poderes: [{ key: "poder_fogo", nivel: 1 }] } },
  });
  const CHARM = pjM.json?.personagem?.id ?? pjM.json?.id;
  setSangue(CHARM, { saldo: 3, capacidade: 10, usos: {}, historico: [] });
  t("fixture: personagens", !!(CHAR && CHAR2 && CHARM),
    JSON.stringify({ pj: pj.json, pj2: pj2.json, pjM: pjM.json }));

  // ---------- helpers UI ----------
  const browser = await chromium.launch();
  const novaPagina = async (cookieStr, viewport) => {
    const ctx = await browser.newContext(viewport ? { viewport } : {});
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieStr.split("=").pop(), url: BASE }]);
    return { ctx, page: await ctx.newPage() };
  };
  const abrirFicha = async (page, nome) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Sangue Ações UI" }).click();
    await page.getByRole("button", { name: "Personagens", exact: true }).click();
    await page.locator("tr.clicavel", { hasText: nome }).first().click();
    await page.waitForSelector(".painel-sangue-leitura", { timeout: 15000 });
    await page.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      return p && !p.innerText.includes("Carregando");
    }, { timeout: 15000 });
  };
  const saldoNaTela = async (page) => {
    const txt = await page.locator(".painel-sangue-leitura").innerText();
    const m = txt.match(/Saldo de Sangue\s*\n?\s*(\d+)/);
    return m ? Number(m[1]) : null;
  };

  const emitirAckSangue = async (page, evento, payload) => page.evaluate(
    ({ evento, payload }) => new Promise((resolve) => {
      const socket = window.__mesaSocket;
      if (!socket?.connected) return resolve({ ok: false, codigo: "socket_indisponivel" });
      socket.emit(evento, payload, (ack) => resolve(ack ?? { ok: false, codigo: "ack_ausente" }));
    }),
    { evento, payload },
  );

  // ---------- 1. Dono: recuperar + ativar ----------
  sec("UI. dono — recuperar");
  {
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Herói Ações");
    const painel = page.locator(".painel-sangue-leitura");
    t("UI. saldo inicial 5", (await saldoNaTela(page)) === 5);
    t("UI. botão Descansar visível", await painel.getByRole("button", { name: /Descansar \(\+2\)/ }).count() === 1);
    // .9: SEM segundo seletor de Poderes nem botão de ativação — o
    // consumo acontece no fluxo normal do Poder (D10), uma única vez.
    t("UI. sem seletor 'Poder a ativar'", await painel.locator("select[aria-label='Poder a ativar']").count() === 0);
    t("UI. sem botão 'Ativar poder'", await painel.getByRole("button", { name: /Ativar/ }).count() === 0);
    // recuperar: 5 → 7
    await painel.getByRole("button", { name: /Descansar \(\+2\)/ }).click();
    await page.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      return p && /7/.test(p.innerText) && /realizada/i.test(p.innerText);
    }, { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(500);
    t("UI. após Descansar saldo=7", (await saldoNaTela(page)) === 7, `saldoTela=${await saldoNaTela(page)} db=${saldoDe(CHAR)}`);
    t("UI. confirmação 'Recuperação realizada'", /realizada/i.test(await painel.innerText()));
    await ctx.close();
  }

  // ---------- 1b. Socket.IO não contorna campos privados ----------
  sec("Socket.IO — privacidade da projeção de Sangue");
  {
    setSangue(CHAR, { saldo: 5, capacidade: 10, usos: {}, historico: [] });
    setVisibilidadeCampo(vid, "cap", "todos");
    setOverrideCampo(CHAR, "cap", { visibilidade: "mestre" });
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Herói Ações");

    const ackAtivar = await emitirAckSangue(page, "sangue:ativar", {
      characterId: CHAR, poderKey: "poder_fogo", requestId: crypto.randomUUID(),
    });
    t(
      "Socket.IO. ativar respeita override privado sem devolver saldo",
      ackAtivar?.ok === false && ackAtivar?.codigo === "capacidade_indisponivel"
        && !("estado" in ackAtivar) && !("saldo" in ackAtivar) && saldoDe(CHAR) === 5,
      JSON.stringify({ ack: ackAtivar, saldo: saldoDe(CHAR) }),
    );

    const ackRecuperarCap = await emitirAckSangue(page, "sangue:recuperar", {
      characterId: CHAR, requestId: crypto.randomUUID(),
    });
    t(
      "Socket.IO. recuperar respeita override de capacidade sem mutar ledger",
      ackRecuperarCap?.ok === false && ackRecuperarCap?.codigo === "capacidade_indisponivel"
        && !("estado" in ackRecuperarCap) && !("saldo" in ackRecuperarCap) && saldoDe(CHAR) === 5,
      JSON.stringify({ ack: ackRecuperarCap, saldo: saldoDe(CHAR) }),
    );

    setOverrideCampo(CHAR, "cap", null);

    // Mesmo com o campo-base visível, um bônus de Qualidade privado
    // também compõe a capacidade e bloqueia ACKs que conteriam saldo.
    setVisibilidadeCampo(vid, "cap", "todos");
    setVisibilidadeCampo(vid, "qual", "mestre");
    setSangueConfig(CID, {
      ...CFG,
      capacidade: {
        ...CFG.capacidade,
        bonusQualidade: { campoId: "qual", coeficiente: 1, modo: "valor" },
      },
    });
    const ackAtivarBonus = await emitirAckSangue(page, "sangue:ativar", {
      characterId: CHAR, poderKey: "poder_fogo", requestId: crypto.randomUUID(),
    });
    t(
      "Socket.IO. ativar recusa bônus de Qualidade privado sem saldo",
      ackAtivarBonus?.ok === false && ackAtivarBonus?.codigo === "capacidade_indisponivel"
        && !("estado" in ackAtivarBonus) && !("saldo" in ackAtivarBonus) && saldoDe(CHAR) === 5,
      JSON.stringify({ ack: ackAtivarBonus, saldo: saldoDe(CHAR) }),
    );
    const ackRecuperarBonus = await emitirAckSangue(page, "sangue:recuperar", {
      characterId: CHAR, requestId: crypto.randomUUID(),
    });
    t(
      "Socket.IO. recuperar recusa bônus de Qualidade privado sem mutar ledger",
      ackRecuperarBonus?.ok === false && ackRecuperarBonus?.codigo === "capacidade_indisponivel"
        && !("estado" in ackRecuperarBonus) && !("saldo" in ackRecuperarBonus) && saldoDe(CHAR) === 5,
      JSON.stringify({ ack: ackRecuperarBonus, saldo: saldoDe(CHAR) }),
    );
    setSangueConfig(CID, CFG);
    setVisibilidadeCampo(vid, "qual", "todos");

    setOverrideCampo(CHAR, "nat", { visibilidade: "selecionados", destinatarios: [] });
    const ackRecuperarNat = await emitirAckSangue(page, "sangue:recuperar", {
      characterId: CHAR, requestId: crypto.randomUUID(),
    });
    t(
      "Socket.IO. recuperar recusa natureza para não destinatário selecionado",
      ackRecuperarNat?.ok === false && ackRecuperarNat?.codigo === "natureza_indisponivel"
        && !("estado" in ackRecuperarNat) && !("saldo" in ackRecuperarNat) && saldoDe(CHAR) === 5,
      JSON.stringify({ ack: ackRecuperarNat, saldo: saldoDe(CHAR) }),
    );
    setOverrideCampo(CHAR, "nat", null);
    const saldoAntesD10 = saldoDe(CHAR);
    const ackD10Narrativo = await emitirAckSangue(page, "sangue:ativar", {
      characterId: CHAR, poderKey: "poder_d10", requestId: crypto.randomUUID(),
    });
    t(
      "Socket.IO: Poder que exige D10 não aceita ativação narrativa direta",
      ackD10Narrativo?.ok === false && ackD10Narrativo?.codigo === "poder_exige_teste"
        && saldoDe(CHAR) === saldoAntesD10,
      JSON.stringify({ ack: ackD10Narrativo, saldoAntes: saldoAntesD10, saldoDepois: saldoDe(CHAR) }),
    );
    await ctx.close();
  }

  // ---------- 2. Ativação narrativa no campo de Poder existente ----------
  sec("UI. ativar Poder pela própria ficha");
  {
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Herói Ações");
    const painel = page.locator(".painel-sangue-leitura");
    t("UI. painel não cria segundo seletor",
      await painel.locator("select").count() === 0
      && await painel.getByRole("button", { name: /Ativar|ativar/ }).count() === 0);
    const usar = page.getByRole("button", { name: "Usar Poder de Fogo sem rolagem" });
    t("UI. ação aparece junto ao Poder narrativo já escolhido", await usar.count() === 1);
    t("UI. lista elegível a D10 mantém ação narrativa do Poder não marcado",
      await page.getByRole("button", { name: "Usar Poder de Fogo sem rolagem" }).count() === 1);
    t("UI. somente o Poder marcado 'Exige teste D10' não recebe ação narrativa",
      await page.getByRole("button", { name: "Usar Poder de Teste sem rolagem" }).count() === 0);

    // Força a rota de fallback usada por browsers em HTTP via IP:
    // randomUUID indisponível, getRandomValues continua funcional.
    await page.evaluate(() => {
      Object.defineProperty(window.crypto, "randomUUID", { configurable: true, value: undefined });
      const s = window.__mesaSocket;
      const original = s.emit.bind(s);
      s.__narrativeAttempts = [];
      s.__dropNextNarrativeAck = 1;
      s.emit = (ev, payload, cb) => {
        if (ev === "sangue:ativar" && payload && typeof payload === "object") {
          s.__narrativeAttempts.push(payload.requestId);
          if (s.__dropNextNarrativeAck > 0) {
            s.__dropNextNarrativeAck--;
            localStorage.setItem("__testeNarrativaRequestId", payload.requestId);
            // Encaminha ao servidor e engole apenas o ACK: simula commit
            // confirmado no DB com resposta perdida na rede.
            return original(ev, payload, () => undefined);
          }
        }
        return original(ev, payload, cb);
      };
    });

    // 1ª tentativa: o servidor debita (5→3), mas o cliente não recebe ACK.
    await usar.click();
    for (let i = 0; i < 80 && saldoDe(CHAR) !== 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const primeiroId = await page.evaluate(() => localStorage.getItem("__testeNarrativaRequestId"));
    t("UI. HTTP fallback: gera UUID v4 sem randomUUID", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(primeiroId ?? ""));
    t("UI. ACK perdido após commit não impede o débito único", saldoDe(CHAR) === 3, `db=${saldoDe(CHAR)}`);

    // Desmonta a ficha e reabre. O localStorage deve recuperar a mesma
    // intenção, não criar um novo uso ao montar o botão novamente.
    await page.goto("about:blank");
    await abrirFicha(page, "Herói Ações");
    await page.evaluate(() => {
      const s = window.__mesaSocket;
      const original = s.emit.bind(s);
      s.__narrativeRetryIds = [];
      s.emit = (ev, payload, cb) => {
        if (ev === "sangue:ativar" && payload && typeof payload === "object") {
          s.__narrativeRetryIds.push(payload.requestId);
        }
        return original(ev, payload, cb);
      };
    });
    const usarNovamente = page.getByRole("button", { name: "Usar Poder de Fogo sem rolagem" });
    t("UI. ação narrativa reaparece após reabrir ficha", await usarNovamente.count() === 1);
    t("UI. botão mostra custo de Sangue configurado", /2 Sangue/.test(await usarNovamente.innerText()),
      await usarNovamente.innerText());
    await usarNovamente.click();
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll(".ficha-poder-acao"))
        .some((el) => /Poder de Fogo ativado/.test(el.textContent || "")),
    { timeout: 15000 });
    const segundoId = await page.evaluate(() => window.__mesaSocket.__narrativeRetryIds?.[0] ?? null);
    t("UI. reabrir/repetir reutiliza o MESMO requestId", !!primeiroId && segundoId === primeiroId, `primeiro=${primeiroId} segundo=${segundoId}`);
    t("UI. replay após ACK perdido não cobra pela segunda vez", saldoDe(CHAR) === 3, `db=${saldoDe(CHAR)}`);
    t("UI. confirmação mostra saldo restante", /3 Pontos de Sangue restantes/.test(await page.locator(".ficha-poder-acoes").innerText()));
    t("UI. painel atualiza saldo em tempo real", (await saldoNaTela(page)) === 3, `saldoTela=${await saldoNaTela(page)} db=${saldoDe(CHAR)}`);

    // A confirmação também sincroniza updatedAt no detalhe: o jogador
    // pode editar/salvar em seguida sem 409 nem descarte do formulário.
    await page.getByRole("button", { name: "Editar ficha" }).click();
    t("UI. ação de uso fica oculta durante edição", await page.getByRole("button", { name: "Usar Poder de Fogo sem rolagem" }).count() === 0);
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Ficha salva."), { timeout: 15000 });
    t("UI. salvar após ativação usa versão atual da ficha", /Ficha salva\./.test(await page.locator("body").innerText()));
    await ctx.close();
  }

  // ---------- 2a. Prévia de custo: saldo insuficiente desabilita ----------
  sec("UI. prévia de custo e saldo insuficiente");
  {
    // CHAR está com saldo 3 após a seção anterior; custo do
    // poder_fogo é 2. Derrubo para 1 → a UI deve desabilitar a ação
    // com mensagem clara ANTES de qualquer tentativa de emitir.
    setSangue(CHAR, { saldo: 1, capacidade: 10, usos: {}, historico: [] });
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Herói Ações");
    const btn = page.getByRole("button", { name: "Usar Poder de Fogo sem rolagem" });
    // A leitura do saldo é assíncrona — espera a prévia resolver.
    await page.waitForSelector(".ficha-poder-acao .ficha-aviso", { timeout: 15000 }).catch(() => null);
    t("UI. custo continua visível com saldo baixo", /2 Sangue/.test(await btn.innerText()),
      await btn.innerText());
    t("UI. saldo insuficiente desabilita a ação", await btn.isDisabled());
    t("UI. mensagem de insuficiência visível", /Saldo insuficiente \(1\/2/.test(await page.locator(".ficha-poder-acao").innerText()),
      await page.locator(".ficha-poder-acao").innerText());
    t("UI. saldo no banco intacto (nada emitido)", saldoDe(CHAR) === 1, `db=${saldoDe(CHAR)}`);
    // Restaura o saldo 3 que a seção de permissões espera (ajuste +3 → 6).
    setSangue(CHAR, { saldo: 3, capacidade: 10, usos: {}, historico: [] });
    await ctx.close();
  }

  // ---------- 2b. ACK tardio após trocar de ficha não troca o alvo do editor ----------
  sec("UI. ativação pendente — não sobrescrever personagem aberto depois");
  {
    setSangue(CHARM, { saldo: 5, capacidade: 10, usos: {}, historico: [] });
    const { ctx, page } = await novaPagina(M);
    await abrirFicha(page, "Ficha do Mestre");
    const usarMestre = page.getByRole("button", { name: "Usar Poder de Fogo sem rolagem" });
    t("UI. corrida de ficha: mestre tem Poder narrativo próprio", await usarMestre.count() === 1);
    await page.evaluate(() => {
      const s = window.__mesaSocket;
      const original = s.emit.bind(s);
      s.emit = (ev, payload, cb) => {
        if (ev === "sangue:ativar" && payload && typeof payload === "object" && typeof cb === "function") {
          // O servidor confirma o débito imediatamente; apenas atrasamos
          // a resposta do ACK para o navegador.
          return original(ev, payload, (ack) => setTimeout(() => cb(ack), 3500));
        }
        return original(ev, payload, cb);
      };
    });
    await usarMestre.click();
    for (let i = 0; i < 40 && saldoDe(CHARM) !== 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    t("UI. corrida de ficha: primeiro débito gravado no personagem de origem", saldoDe(CHARM) === 3);
    // Dois "Voltar" coexistem na tela (cabeçalho da campanha + detalhe
    // do personagem) — mirar o do detalhe da ficha aberta. Na janela do
    // ACK tardio a ficha pode remontar e duplicar o cabeçalho por um
    // instante; aguardar exatamente um "Voltar" do detalhe antes de
    // clicar (falha continua ruidosa se a ambiguidade persistir).
    const voltarDetalhe = page.locator("section.cartao", { has: page.locator("h2", { hasText: "Ficha do Mestre" }) })
      .getByRole("button", { name: "Voltar", exact: true });
    for (let i = 0; i < 50 && (await voltarDetalhe.count()) !== 1; i++) {
      await page.waitForTimeout(100);
    }
    await voltarDetalhe.click();
    const outraFicha = page.locator("tr.clicavel", { hasText: "Herói Ações" }).first();
    await outraFicha.waitFor({ state: "visible", timeout: 15000 });
    await outraFicha.click();
    await page.getByRole("button", { name: "Editar ficha" }).click();
    const nomeInput = page.locator("label").filter({ hasText: "Nome do personagem" }).locator("input");
    t("UI. corrida de ficha: outro personagem segue em edição", await nomeInput.count() === 1);
    await nomeInput.fill("Herói Renomeado");
    await page.waitForTimeout(2100); // deixa o ACK tardio da ficha anterior resolver
    t("UI. corrida de ficha: ACK antigo não troca nem reutiliza o editor",
      await page.locator("h2").filter({ hasText: "Herói Ações" }).count() === 1
      && await page.locator("label").filter({ hasText: "Nome do personagem" }).locator("input").count() === 1);
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await page.waitForFunction(() => document.body.innerText.includes("Ficha salva."), { timeout: 15000 });
    t("UI. corrida de ficha: salvar altera só o personagem atualmente aberto",
      nomeDe(CHAR) === "Herói Renomeado" && nomeDe(CHARM) === "Ficha do Mestre",
      `CHAR=${nomeDe(CHAR)} CHARM=${nomeDe(CHARM)}`);
    // Restaura o nome original — as seções seguintes localizam a ficha
    // pelo nome "Herói Ações" na lista de personagens.
    const w = db();
    try { w.prepare("update characters set name=? where id=?").run("Herói Ações", CHAR); } finally { w.close(); }
    await ctx.close();
  }

  // ---------- 3. Permissões: mestre ajusta; dono não vê ações do mestre ----------
  sec("UI. permissões");
  {
    // dono J1: NÃO vê "Ações do mestre"
    const { ctx: c1, page: p1 } = await novaPagina(J1);
    await abrirFicha(p1, "Herói Ações");
    t("UI. dono NÃO vê ações do mestre", await p1.locator(".painel-sangue-mestre").count() === 0);
    t("UI. dono vê ações próprias", await p1.locator(".painel-sangue-leitura").getByRole("button", { name: /Descansar/ }).count() === 1);
    await c1.close();
    // mestre: vê ações do mestre, NÃO vê botões do dono na ficha alheia
    const { ctx: c2, page: p2 } = await novaPagina(M);
    await abrirFicha(p2, "Herói Ações");
    const painelM = p2.locator(".painel-sangue-leitura");
    t("UI. mestre vê seção 'Ações do mestre'", await painelM.locator(".painel-sangue-mestre").count() === 1);
    t("UI. mestre NÃO vê botão Descansar (não é dono)", await painelM.getByRole("button", { name: /Descansar/ }).count() === 0);
    // ajustar +3 com motivo → saldo 3→6 (o saldo 5 foi consumido pela
    // ativação narrativa do Poder de Fogo na seção anterior: 5−2=3)
    await painelM.locator(".painel-sangue-mestre").locator("summary").click();
    await painelM.locator("input[aria-label='Delta de Sangue (positivo ou negativo)']").fill("3");
    await painelM.locator("input[aria-label='Motivo do ajuste de Sangue']").fill("bônus de teste");
    await painelM.getByRole("button", { name: "Ajustar saldo" }).click();
    await p2.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      return p && /ajustado/i.test(p.innerText);
    }, { timeout: 15000 }).catch(() => null);
    await p2.waitForTimeout(500);
    t("UI. mestre ajustou saldo para 6", saldoDe(CHAR) === 6, `db=${saldoDe(CHAR)}`);
    // reconciliar com motivo — reabre o <details> se o reload fechou
    await painelM.locator(".painel-sangue-mestre").evaluate((d) => { if (!d.open) d.querySelector("summary").click(); });
    await painelM.locator("input[aria-label='Motivo da reconciliação de capacidade']").fill("reconciliação teste");
    await painelM.getByRole("button", { name: "Reconciliar capacidade" }).click();
    await p2.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      return p && /reconciliada/i.test(p.innerText);
    }, { timeout: 15000 }).catch(() => null);
    t("UI. reconciliação confirmada", /reconciliada/i.test(await painelM.innerText()));
    await c2.close();
  }

  // ---------- 4. Espectador não recebe painel ----------
  sec("UI. espectador");
  {
    const { ctx, page } = await novaPagina(ESP);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    const card = page.locator(".cartao-campanha", { hasText: "Campanha Sangue Ações UI" });
    if (await card.count()) {
      await card.click();
      await page.waitForTimeout(1000);
      t("UI. espectador sem painel de Sangue em lugar nenhum", await page.locator(".painel-sangue-leitura").count() === 0);
    } else {
      t("UI. espectador sem acesso à campanha", true);
    }
    await ctx.close();
  }

  // ---------- 4b. Corrida de posse: lista de A atrasada × B ----------
  sec("UI. corrida de posse — lista de A resolve depois da troca");
  {
    const s = await req(BASE, "POST", `/campaigns/${CID}/sessoes`, { cookie: M, body: { name: "Sessão Posse" } });
    const { ctx, page } = await novaPagina(M);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Sangue Ações UI" }).click();
    await page.getByRole("button", { name: "Mesa", exact: true }).click();
    await page.waitForTimeout(800);
    const sessaoRow = page.locator("table.tabela tbody tr.clicavel", { hasText: "Sessão Posse" }).first();
    t("UI. corrida: sessão encontrada", (await sessaoRow.count()) === 1);
    if (await sessaoRow.count()) {
      await sessaoRow.click();
      await page.waitForTimeout(1200);
      // Atrasa SÓ a PRIMEIRA chamada da lista após isto (a de A=CHARM,
      // do mestre). A de B=CHAR (J1) responde normal.
      let atrasarProxima = true;
      await page.route(/\/api\/campaigns\/[^/]+\/characters(\?.*)?$/, async (route) => {
        if (atrasarProxima) { atrasarProxima = false; await new Promise((r) => setTimeout(r, 2500)); }
        await route.continue();
      });
      const sel = page.locator(".formulario select").first();
      // A (do mestre, dono real) primeiro — sua lista fica pendente;
      // troca para B (do J1 — mestre NÃO é dono) antes dela resolver.
      await sel.selectOption(CHARM);
      await page.waitForTimeout(800); // garante que a lista de A já disparou
      await sel.selectOption(CHAR);
      await page.waitForSelector(".painel-sangue-leitura", { timeout: 15000 });
      // espera a lista atrasada de A resolver E a carga de B assentar
      await page.waitForTimeout(3500);
      const painel = page.locator(".painel-sangue-leitura");
      const txt = await painel.innerText();
      t("UI. corrida: painel de B carregado (saldo 6)", /6 \/ 10/.test(txt), txt.slice(0, 160));
      t("UI. corrida: posse de A NÃO vazou para B (sem Descansar/Ativar)",
        await painel.getByRole("button", { name: /Descansar|Ativar/ }).count() === 0);
      t("UI. corrida: mestre segue vendo 'Ações do mestre' em B",
        await painel.locator(".painel-sangue-mestre").count() === 1);
    }
    await ctx.close();
  }

  // ---------- 4c. Lista da campanha falha → fail-closed ----------
  sec("UI. lista falha — dono sem controles, leitura preservada");
  {
    const { ctx, page } = await novaPagina(M);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Sangue Ações UI" }).click();
    await page.getByRole("button", { name: "Mesa", exact: true }).click();
    await page.waitForTimeout(800);
    const sessaoRow = page.locator("table.tabela tbody tr.clicavel", { hasText: "Sessão Posse" }).first();
    t("UI. fail-closed: sessão encontrada", (await sessaoRow.count()) === 1);
    if (await sessaoRow.count()) {
      await sessaoRow.click();
      await page.waitForTimeout(1200);
      const sel = page.locator(".formulario select").first();
      const painel = page.locator(".painel-sangue-leitura");
      // 1) CHARM é do próprio mestre → com a lista OK, Descansar aparece
      await sel.selectOption(CHARM);
      await page.waitForSelector(".painel-sangue-leitura", { timeout: 15000 });
      await page.waitForFunction(() => {
        const p = document.querySelector(".painel-sangue-leitura");
        return p && !p.innerText.includes("Carregando");
      }, { timeout: 15000 });
      t("UI. fail-closed: dono vê Descansar com lista OK", await painel.getByRole("button", { name: /Descansar/ }).count() === 1);
      // 2) troca p/ CHAR, depois aborta a lista e volta p/ CHARM
      await sel.selectOption(CHAR);
      await page.waitForTimeout(800);
      await page.route(/\/api\/campaigns\/[^/]+\/characters(\?.*)?$/, (route) => route.abort());
      await sel.selectOption(CHARM);
      await page.waitForFunction(() => {
        const p = document.querySelector(".painel-sangue-leitura");
        return p && !p.innerText.includes("Carregando");
      }, { timeout: 15000 });
      const txt = await painel.innerText();
      t("UI. fail-closed: saldo do mestre segue visível", /3/.test(txt), txt.slice(0, 160));
      t("UI. fail-closed: lista abortada → NENHUM controle de dono",
        await painel.getByRole("button", { name: /Descansar|Ativar/ }).count() === 0
        && await painel.locator("select[aria-label='Poder a ativar']").count() === 0);
    }
    await ctx.close();
  }

  // ---------- 4d. requestId estável por intenção (contrato #230) ----------
  sec("UI. requestId — retry idêntico reutiliza UUID, payload novo gera UUID novo");
  {
    const { ctx, page } = await novaPagina(M);
    await abrirFicha(page, "Outro Ações");
    const painel = page.locator(".painel-sangue-leitura");
    t("UI. rid: saldo inicial de CHAR2 = 4", saldoDe(CHAR2) === 4, `db=${saldoDe(CHAR2)}`);
    await painel.locator(".painel-sangue-mestre").locator("summary").click();

    // Envelope o emit do socket do app: registra requestId/delta/motivo
    // de cada sangue:ajustar e, quando __dropNextAj>0, NÃO encaminha ao
    // servidor e devolve ACK ambíguo de timeout — simula resposta
    // perdida sem commit (a prova de replay pós-commit é do servidor
    // #230; aqui validamos o contrato do cliente).
    await page.evaluate(() => {
      const s = window.__mesaSocket;
      if (!s || s.__capAj) return;
      s.__capAj = [];
      s.__dropNextAj = 0;
      const orig = s.emit.bind(s);
      s.emit = (ev, p, cb) => {
        if (ev === "sangue:ajustar" && p && typeof p === "object") {
          s.__capAj.push({ requestId: p.requestId, delta: p.delta, motivo: p.motivo });
          if (s.__dropNextAj > 0) {
            s.__dropNextAj--;
            if (typeof cb === "function") setTimeout(() => cb({ ok: false, codigo: "timeout", erro: "Sem resposta do servidor" }), 60);
            return s;
          }
        }
        return orig(ev, p, cb);
      };
    });
    const capAj = () => page.evaluate(() => window.__mesaSocket.__capAj);
    const uuidOk = (u) => typeof u === "string" && /^[0-9a-f-]{36}$/i.test(u);
    // O <details> das ações do mestre pode fechar no re-render pós-ACK
    // (carregar() refaz a leitura) — reabre antes de cada interação.
    const abrirAcoes = () => painel.locator(".painel-sangue-mestre").evaluate((d) => { if (!d.open) d.querySelector("summary").click(); });

    const deltaIn = painel.locator("input[aria-label='Delta de Sangue (positivo ou negativo)']");
    const motIn = painel.locator("input[aria-label='Motivo do ajuste de Sangue']");
    const btnAj = painel.getByRole("button", { name: "Ajustar saldo" });

    // 1) ACK ambíguo: emissão descartada → timeout; saldo NÃO muda
    //    (cliente nunca atualiza otimisticamente — espera o servidor).
    await deltaIn.fill("-1");
    await motIn.fill("perda de ack");
    await page.evaluate(() => { window.__mesaSocket.__dropNextAj = 1; });
    await btnAj.click();
    await page.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      const b = [...document.querySelectorAll(".painel-sangue-leitura button")].find((x) => /Ajustar/.test(x.textContent));
      return p && /timeout|Sem resposta/i.test(p.innerText) && b && !/Ajustando/.test(b.textContent);
    }, { timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(300);
    const cap1 = await capAj();
    t("UI. rid: 1ª emissão leva requestId UUID", uuidOk(cap1[0]?.requestId), JSON.stringify(cap1[0]));
    t("UI. rid: erro ambíguo não altera saldo (sem otimista)", saldoDe(CHAR2) === 4 && (await saldoNaTela(page)) === 4,
      `db=${saldoDe(CHAR2)} tela=${await saldoNaTela(page)}`);

    // 2) Retry IDÊNTICO → mesmo UUID reenviado; servidor aplica 1×.
    await btnAj.click();
    await page.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      return p && /ajustado/i.test(p.innerText);
    }, { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(400);
    const cap2 = await capAj();
    t("UI. rid: retry idêntico reutiliza o MESMO requestId",
      cap2.length === 2 && cap2[1].requestId === cap1[0].requestId,
      JSON.stringify(cap2.map((c) => c.requestId)));
    t("UI. rid: delta aplicado uma única vez (4→3)", saldoDe(CHAR2) === 3, `db=${saldoDe(CHAR2)}`);

    // 3) Mudança de payload após erro/sucesso → UUID novo.
    await abrirAcoes();
    await deltaIn.fill("-2");
    await btnAj.click();
    await page.waitForFunction((n) => {
      const s = window.__mesaSocket;
      const b = [...document.querySelectorAll(".painel-sangue-leitura button")].find((x) => /Ajustar/.test(x.textContent));
      return s?.__capAj?.length >= n && b && !/Ajustando/.test(b.textContent);
    }, 3, { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(400);
    const cap3 = await capAj();
    t("UI. rid: payload novo gera requestId NOVO",
      cap3.length === 3 && uuidOk(cap3[2].requestId) && cap3[2].requestId !== cap1[0].requestId,
      JSON.stringify(cap3.map((c) => c.requestId)));
    t("UI. rid: ajuste -2 aplicado (3→1)", saldoDe(CHAR2) === 1, `db=${saldoDe(CHAR2)}`);

    // 4) ACK ok limpa a intenção: repetir o payload original gera UUID novo.
    await abrirAcoes();
    await deltaIn.fill("-1");
    await motIn.fill("perda de ack");
    await btnAj.click();
    await page.waitForFunction((n) => {
      const s = window.__mesaSocket;
      const b = [...document.querySelectorAll(".painel-sangue-leitura button")].find((x) => /Ajustar/.test(x.textContent));
      return s?.__capAj?.length >= n && b && !/Ajustando/.test(b.textContent);
    }, 4, { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(400);
    const cap4 = await capAj();
    t("UI. rid: após ACK ok, mesma payload é nova intenção (UUID novo)",
      cap4.length === 4 && uuidOk(cap4[3].requestId) && cap4[3].requestId !== cap1[0].requestId,
      JSON.stringify(cap4.map((c) => c.requestId)));
    t("UI. rid: ajuste final aplicado (1→0)", saldoDe(CHAR2) === 0, `db=${saldoDe(CHAR2)}`);
    await ctx.close();
  }

  // ---------- 5. Mobile 390px ----------
  sec("UI. mobile 390px");
  {
    const { ctx, page } = await novaPagina(J1, { width: 390, height: 844 });
    await abrirFicha(page, "Herói Ações");
    const painel = page.locator(".painel-sangue-leitura");
    t("UI. painel + ações renderizam no mobile", await painel.getByRole("button", { name: /Descansar/ }).count() === 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    t("UI. sem overflow horizontal", !overflow);
    await ctx.close();
  }

  // O Poder D10 só pode ser marcado indisponível NO FIM do teste:
  // validarRegras rejeita elemento desativado já selecionado na ficha
  // ("está desativado nesta campanha") — marcá-lo antes quebrava tanto o
  // POST /characters da fixture (CHAR undefined → setSangue) quanto o
  // "Salvar" da ficha na seção de ativação narrativa.
  await req(BASE, "PATCH", `/campaigns/${CID}/regras/elementos/${idPoderD10}`, {
    cookie: M, body: { definition: { disponivel: false } },
  });
  const vinculaveis = await req(BASE, "GET", `/campaigns/${CID}/regras/vinculaveis`, { cookie: J1 });
  const metaD10 = vinculaveis.json?.metadadosPoderes?.find((p) => p.key === "poder_d10");
  t("vinculáveis: Poder D10 inativo não é opção de aquisição", !(vinculaveis.json?.elementos?.poder ?? []).some((p) => p.key === "poder_d10"));
  t("vinculáveis: metadado D10 do Poder inativo permanece", metaD10?.exigeTeste === true);

  await browser.close();
} catch (e) {
  console.error("ERRO FATAL:", e);
  fail++;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
  console.log(`\n${pass} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
}
