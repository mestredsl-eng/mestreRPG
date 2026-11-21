#!/usr/bin/env node
// Teste E2E das AÇÕES de Sangue na UI (Issue #186, C8-C2 — contrato
// real R6.3 da PR #230: sangue:ativar/recuperar p/ dono,
// sangue:ajustar/reconciliar-capacidade p/ mestre).
// Cobre: recuperação pelo dono, ativação de Poder com custo, erro de
// saldo insuficiente, ações do mestre, permissões (dono vs mestre vs
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
function saldoDe(charId) {
  const w = db();
  try {
    const row = w.prepare("select data from characters where id=?").get(charId);
    return JSON.parse(row.data || "{}").__sangue?.saldo ?? null;
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
    poder_frac: { custo: 1 },
    poder_zero: { custo: 1 },
    poder_neg: { custo: 1 },
    poder_sem: { custo: 1 },
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
  for (const [key, name] of [
    ["poder_frac", "Poder Fracionado"],
    ["poder_zero", "Poder Zero"],
    ["poder_neg", "Poder Negativo"],
    ["poder_sem", "Poder Sem Nivel"],
  ]) {
    await req(BASE, "POST", `/campaigns/${CID}/regras/elementos`, {
      cookie: M, body: { kind: "poder", key, name, definition: { disponivel: true } },
    });
  }
  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Ações" } });
  const tid = mod.json.modelo.id, vid = mod.json.modelo.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Sangue", ordem: 0, campos: [
        { id: "cap", label: "Capacidade", tipo: "inteiro", semantico: "atributo", minimo: 1, maximo: 30 },
        { id: "nat", label: "Natureza", tipo: "selecao_unica", semantico: "livre", opcoes: ["Humano", "Vampiro"] },
        { id: "poderes", label: "Poderes", tipo: "selecao_nivel", semantico: "poder", regraKind: "poder" },
      ],
    }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });
  setSangueConfig(CID, CFG);

  const pj = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J1, body: { name: "Herói Ações", templateVersionId: vid, data: { cap: 10, nat: "Humano", poderes: [{ key: "poder_fogo", nivel: 2 }] } },
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
    cookie: M, body: { name: "Ficha do Mestre", templateVersionId: vid, data: { cap: 10, nat: "Humano", poderes: [] } },
  });
  const CHARM = pjM.json?.personagem?.id ?? pjM.json?.id;
  setSangue(CHARM, { saldo: 3, capacidade: 10, usos: {}, historico: [] });
  // Ficha com níveis de Poder na fronteira: 0.5 (adquirido), 0, -2 e
  // sem nivel (não adquiridos — mesmo existindo na biblioteca).
  const pjF = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J1, body: {
      name: "Frações", templateVersionId: vid,
      // nivel 1 na escrita: a validação selecao_nivel desta linhagem
      // exige inteiro 1..5; o 0.5 do contrato D10/#237 chega via
      // propagação — injetado no banco abaixo (leitura não revalida).
      data: { cap: 10, nat: "Humano", poderes: [{ key: "poder_frac", nivel: 1 }] },
    },
  });
  const CHARF = pjF.json?.personagem?.id ?? pjF.json?.id;
  // Níveis inválidos injetados direto no banco: a validação de escrita
  // já os rejeitaria, mas o filtro da UI é defesa em profundidade —
  // dado envenenado não pode oferecer Poder não adquirido.
  {
    const w = db();
    try {
      const row = w.prepare("select data from characters where id=?").get(CHARF);
      const data = JSON.parse(row.data || "{}");
      data.poderes = [
        { key: "poder_frac", nivel: 0.5 },
        { key: "poder_zero", nivel: 0 },
        { key: "poder_neg", nivel: -2 },
        { key: "poder_sem", nivel: null },
        { key: "poder_texto", nivel: "NaN" },
      ];
      w.prepare("update characters set data=? where id=?").run(JSON.stringify(data), CHARF);
    } finally { w.close(); }
  }
  setSangue(CHARF, { saldo: 5, capacidade: 10, usos: {}, historico: [] });
  t("fixture: personagens", !!(CHAR && CHAR2 && CHARM && CHARF));

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

  // ---------- 1. Dono: recuperar + ativar ----------
  sec("UI. dono — recuperar e ativar");
  {
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Herói Ações");
    const painel = page.locator(".painel-sangue-leitura");
    t("UI. saldo inicial 5", (await saldoNaTela(page)) === 5);
    t("UI. botão Descansar visível", await painel.getByRole("button", { name: /Descansar \(\+2\)/ }).count() === 1);
    t("UI. seletor de poder com 'Poder de Fogo'", await painel.locator("select[aria-label='Poder a ativar'] option", { hasText: "Poder de Fogo" }).count() === 1);
    // recuperar: 5 → 7
    await painel.getByRole("button", { name: /Descansar \(\+2\)/ }).click();
    await page.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      return p && /7/.test(p.innerText) && /realizada/i.test(p.innerText);
    }, { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(500);
    t("UI. após Descansar saldo=7", (await saldoNaTela(page)) === 7, `saldoTela=${await saldoNaTela(page)} db=${saldoDe(CHAR)}`);
    t("UI. confirmação 'Recuperação realizada'", /realizada/i.test(await painel.innerText()));
    // ativar: custo 2 → 7-2=5
    await painel.getByRole("button", { name: "Ativar poder" }).click();
    await page.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      return p && /5/.test(p.innerText) && /ativado/i.test(p.innerText);
    }, { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(500);
    t("UI. após Ativar saldo=5 (custo 2)", (await saldoNaTela(page)) === 5, `saldoTela=${await saldoNaTela(page)} db=${saldoDe(CHAR)}`);
    t("UI. 'Poder ativado' exibido", /ativado/i.test(await painel.innerText()));
    await ctx.close();
  }

  // ---------- 2. Saldo insuficiente → erro do servidor ----------
  sec("UI. saldo insuficiente");
  {
    setSangueConfig(CID, { ...CFG, poderes: { poder_fogo: { custo: 50 } } });
    setSangue(CHAR, { saldo: 5, capacidade: 10, usos: {}, historico: [] });
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Herói Ações");
    const painel = page.locator(".painel-sangue-leitura");
    await painel.getByRole("button", { name: "Ativar poder" }).click();
    // Espera o ACK de erro — "Saldo de Sangue" contém "saldo", então
    // o wait precisa mirar "insuficiente" e o botão sair de "Ativando…".
    await page.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      const b = [...document.querySelectorAll(".painel-sangue-leitura button")].find((x) => /Ativar/.test(x.textContent));
      return p && /insuficiente/i.test(p.innerText) && b && !/Ativando/.test(b.textContent);
    }, { timeout: 20000 }).catch(() => null);
    const txt = await painel.innerText();
    t("UI. erro de saldo insuficiente exibido", /insuficiente/i.test(txt), txt.slice(0, 300));
    t("UI. saldo inalterado após erro", (await saldoNaTela(page)) === 5 && saldoDe(CHAR) === 5);
    setSangueConfig(CID, CFG);
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
    // ajustar +3 com motivo → saldo 5→8
    await painelM.locator(".painel-sangue-mestre").locator("summary").click();
    await painelM.locator("input[aria-label='Delta de Sangue (positivo ou negativo)']").fill("3");
    await painelM.locator("input[aria-label='Motivo do ajuste de Sangue']").fill("bônus de teste");
    await painelM.getByRole("button", { name: "Ajustar saldo" }).click();
    await p2.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      return p && /ajustado/i.test(p.innerText);
    }, { timeout: 15000 }).catch(() => null);
    await p2.waitForTimeout(500);
    t("UI. mestre ajustou saldo para 8", saldoDe(CHAR) === 8, `db=${saldoDe(CHAR)}`);
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
      t("UI. corrida: painel de B carregado (saldo 8)", /8/.test(txt), txt.slice(0, 160));
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

  // ---------- 4e. Poder com nível fracionário 0.5 é adquirido ----------
  sec("UI. poder nível 0.5 aparece e ativa; níveis inválidos não aparecem");
  {
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Frações");
    const painel = page.locator(".painel-sangue-leitura");
    const selPoder = painel.locator("select[aria-label='Poder a ativar']");
    await page.waitForTimeout(800); // lista de poderes assíncrona
    t("UI. frac: opção 'Poder Fracionado' (nível 0.5) presente",
      await selPoder.locator("option", { hasText: "Poder Fracionado" }).count() === 1);
    t("UI. frac: 'Poder Zero' (nível 0) ausente",
      await selPoder.locator("option", { hasText: "Poder Zero" }).count() === 0);
    t("UI. frac: 'Poder Negativo' (nível -2) ausente",
      await selPoder.locator("option", { hasText: "Poder Negativo" }).count() === 0);
    t("UI. frac: 'Poder Sem Nivel' (sem nivel) ausente",
      await selPoder.locator("option", { hasText: "Poder Sem Nivel" }).count() === 0);
    // captura o emit de sangue:ativar: a UI deve ENVIAR a key do poder
    // fracionado. Nesta linhagem o servidor ainda exige level >= 1
    // (contrato > 0 chega via #230) — o ACK de rejeição é esperado e
    // documentado; o que provamos aqui é o lado cliente.
    await page.evaluate(() => {
      const s = window.__mesaSocket;
      if (!s || s.__capAtivar) return;
      s.__capAtivar = [];
      const orig = s.emit.bind(s);
      s.emit = (ev, p, cb) => {
        if (ev === "sangue:ativar" && p && typeof p === "object") {
          s.__capAtivar.push({ poderKey: p.poderKey, requestId: p.requestId });
        }
        return orig(ev, p, cb);
      };
    });
    await selPoder.selectOption({ label: "Poder Fracionado" });
    await painel.getByRole("button", { name: "Ativar poder" }).click();
    await page.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      const b = [...document.querySelectorAll(".painel-sangue-leitura button")].find((x) => /Ativar/.test(x.textContent));
      return p && /não possui|ativado|Falha/i.test(p.innerText) && b && !/Ativando/.test(b.textContent);
    }, { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(400);
    const capAtivar = await page.evaluate(() => window.__mesaSocket.__capAtivar);
    t("UI. frac: UI emite sangue:ativar com poderKey=poder_frac + requestId UUID",
      capAtivar.length === 1 && capAtivar[0].poderKey === "poder_frac"
      && /^[0-9a-f-]{36}$/i.test(capAtivar[0].requestId ?? ""),
      JSON.stringify(capAtivar));
    // servidor DESTA linhagem rejeita (level>=1 legado) — comportamento
    // esperado até a propagação de #230; saldo permanece intacto.
    t("UI. frac: ACK do servidor não credita (linhagem sem level>0)",
      saldoDe(CHARF) === 5, `db=${saldoDe(CHARF)}`);
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
