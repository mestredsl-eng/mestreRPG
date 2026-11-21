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
  poderes: { poder_fogo: { custo: 2 } },
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
  t("fixture: personagens", !!(CHAR && CHAR2));

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
