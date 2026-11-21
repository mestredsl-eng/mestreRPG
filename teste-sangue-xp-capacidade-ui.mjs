#!/usr/bin/env node
// Teste E2E da UI de evolução por XP da capacidade de Sangue
// (Issue #186 adendo — contrato do PAI na PR #226).
// Cobre: selo "Capacidade de Sangue" só no elemento elegível, compra
// 0→1 com aviso "não adiciona Sangue ao saldo", outras características
// bloqueadas, XP insuficiente, realtime via socket, permissões
// (dono/mestre veem; não-dono não acessa a ficha), mobile 390px.
// Servidor+SQLite+site 100% descartáveis.
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, encerrarServidor, limparDir, req,
} from "./teste-base.mjs";

const DIR = dirTeste("sangue-xp-ui");
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
function selarFicha(charId, dados = {}) {
  const w = db();
  try {
    const row = w.prepare("select data from characters where id=?").get(charId);
    const data = JSON.parse(row.data || "{}");
    Object.assign(data, dados);
    const atual = data.__pontos && typeof data.__pontos === "object" ? data.__pontos : {};
    data.__pontos = { ...atual, selo: { em: new Date().toISOString(), autorId: "t", autorNome: "T" } };
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

const progressaoDe = (id, cookie) => req(BASE, "GET", `/characters/${id}/progressao`, { cookie });
const comprar = (id, cookie, body) => req(BASE, "POST", `/characters/${id}/comprar-ponto`, { cookie, body });
const darXp = (id, cookie, body) => req(BASE, "POST", `/characters/${id}/xp`, { cookie, body });

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha XP Sangue UI",
    jogadores: { j1: "jog_sx_ui", j2: "jog_outro_ui" },
    config: { pontos: { habilitado: true, pontosIniciais: 5, pools: [], custos: {} } },
  });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.j1.cookie;
  const J2 = c.jogadores.j2.cookie;

  sec("Fixture — biblioteca, ficha e config de Sangue");
  await req(BASE, "POST", `/campaigns/${CID}/regras/elementos`, {
    cookie: M, body: { kind: "caracteristica", key: "sangue_cap", name: "Capacidade de Sangue", definition: { custoPontos: 3, disponivel: true } },
  });
  await req(BASE, "POST", `/campaigns/${CID}/regras/elementos`, {
    cookie: M, body: { kind: "caracteristica", key: "carisma", name: "Carisma", definition: { custoPontos: 3, disponivel: true } },
  });
  await req(BASE, "POST", `/campaigns/${CID}/regras/elementos`, {
    cookie: M, body: { kind: "vantagem", key: "sorte", name: "Sorte", definition: { custoPontos: 1, disponivel: true } },
  });
  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Sangue XP" } });
  const tid = mod.json.modelo.id, vid = mod.json.modelo.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Personagem", ordem: 0, campos: [
        { id: "f-sangue", label: "Capacidade de Sangue", tipo: "inteiro", semantico: "atributo", regra: { kind: "caracteristica", key: "sangue_cap" }, custoPontos: 3 },
        { id: "f-car", label: "Carisma", tipo: "inteiro", regra: { kind: "caracteristica", key: "carisma" }, custoPontos: 3 },
        { id: "f-vant", label: "Sorte", tipo: "inteiro", regra: { kind: "vantagem", key: "sorte" }, custoPontos: 1 },
      ],
    }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });
  setSangueConfig(CID, { habilitado: true, campoCapacidadeId: "f-sangue" });

  const pj = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J1, body: { name: "Dono Sangue XP", templateVersionId: vid, data: {} },
  });
  const CHAR = pj.json?.personagem?.id ?? pj.json?.id;
  selarFicha(CHAR, { __sangue: { saldo: 7, usos: {}, historico: [] } });
  const pj2 = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J2, body: { name: "Outro Jogador", templateVersionId: vid, data: {} },
  });
  const CHAR2 = pj2.json?.personagem?.id ?? pj2.json?.id;
  selarFicha(CHAR2);
  await darXp(CHAR, M, { acao: "conceder", quantidade: 20, motivo: "seed xp" });
  t("fixture: personagem do jogador criado", !!CHAR);

  // ---------- helpers de UI ----------
  const browser = await chromium.launch();
  const novaPagina = async (cookieStr, viewport) => {
    const ctx = await browser.newContext(viewport ? { viewport } : {});
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieStr.split("=").pop(), url: BASE }]);
    return { ctx, page: await ctx.newPage() };
  };
  const abrirPersonagens = async (page) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha XP Sangue UI" }).click();
    await page.getByRole("button", { name: "Personagens", exact: true }).click();
  };
  const abrirFicha = async (page, nome) => {
    await abrirPersonagens(page);
    await page.locator("tr.clicavel", { hasText: nome }).first().click();
    await page.waitForSelector(".progressao-xp", { timeout: 15000 });
  };

  // ---------- 1. Dono vê selo + aviso + compra 0→1 ----------
  sec("UI. dono compra nível da capacidade");
  {
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Dono Sangue XP");
    const painel = page.locator(".progressao-xp");
    t("UI. painel de progressão visível ao dono", await painel.count() === 1);
    const linhaCap = painel.locator("tr", { hasText: "Capacidade de Sangue" }).first();
    t("UI. selo 'Capacidade de Sangue' no elemento", await linhaCap.locator(".selo").count() === 1);
    const linhaCar = painel.locator("tr", { hasText: "Carisma" }).first();
    t("UI. outra característica SEM selo", await linhaCar.locator(".selo").count() === 0);
    t("UI. carisma bloqueado (sem botão Comprar)", await linhaCar.getByRole("button", { name: "Comprar" }).count() === 0);
    t("UI. carisma mostra motivo de bloqueio", /nao pode evoluir/i.test(await linhaCar.innerText()));
    // compra 0→1
    await linhaCap.getByRole("button", { name: "Comprar" }).click();
    const aviso = painel.locator("text=Aumenta apenas a capacidade máxima de Sangue");
    t("UI. aviso 'não adiciona Sangue ao saldo' na confirmação", await aviso.count() === 1);
    await painel.getByRole("button", { name: /Confirmar −3 XP/ }).click();
    await page.waitForSelector("text=Capacidade de Sangue", { timeout: 10000 });
    await page.waitForTimeout(800);
    const txtDepois = await painel.innerText();
    t("UI. nível subiu para 1", /Capacidade de Sangue[\s\S]*?\b1\b/.test(txtDepois) || txtDepois.includes("nv.0→1"), txtDepois.slice(0, 300));
    t("UI. saldo XP debitado (20→17)", /17 XP/.test(txtDepois), txtDepois.match(/\d+ XP/)?.[0]);
    await ctx.close();
  }

  // ---------- 2. Realtime: compra via API reflete na UI ----------
  sec("UI. realtime via socket");
  {
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Dono Sangue XP");
    const painel = page.locator(".progressao-xp");
    // compra nível 2 direto pela API (como outro dispositivo faria)
    const r = await comprar(CHAR, J1, { kind: "caracteristica", key: "sangue_cap", nivelAlvo: 2 });
    t("API. compra 1→2 aceita", r.status === 200, `status=${r.status}`);
    // a UI deve atualizar sozinha via personagens:atualizados
    await page.waitForFunction(() => {
      const painel = document.querySelector(".progressao-xp");
      return painel && /Capacidade de Sangue[\s\S]{0,200}\b2\b/.test(painel.innerText);
    }, { timeout: 15000 }).catch(() => null);
    const txt = await painel.innerText();
    t("UI. nível 2 refletido sem reload", /\b2\b/.test(txt), txt.slice(0, 300));
    await ctx.close();
  }

  // ---------- 3. XP insuficiente → motivo, sem Comprar ----------
  sec("UI. XP insuficiente");
  {
    // zera o saldo do dono via API (remoção auditada) — lê o saldo
    // atual antes, pois a remoção não pode deixar o saldo negativo
    const progAntes = await progressaoDe(CHAR, M);
    const saldoAtual = progAntes.json?.xp?.saldo ?? 0;
    const rem = await darXp(CHAR, M, { acao: "remover", quantidade: saldoAtual, motivo: "zera xp p/ teste ui" });
    t("API. remoção de XP para zerar saldo", rem.status === 200, `status=${rem.status}`);
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Dono Sangue XP");
    const painel = page.locator(".progressao-xp");
    const linhaCap = painel.locator("tr", { hasText: "Capacidade de Sangue" }).first();
    t("UI. selo continua visível com XP zerado", await linhaCap.locator(".selo").count() === 1);
    t("UI. 'XP insuficiente' exibido", /XP insuficiente/i.test(await linhaCap.innerText()));
    t("UI. sem botão Comprar quando insuficiente", await linhaCap.getByRole("button", { name: "Comprar" }).count() === 0);
    await ctx.close();
  }

  // ---------- 3b. Selo = marcador autoritativo #231 (nunca por motivo) ----------
  sec("UI. selo só com capacidadeSangue===true — provas negativas");
  {
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Dono Sangue XP");
    const painel = page.locator(".progressao-xp");
    const linhas = () => ({
      cap: painel.locator("tr", { hasText: "Capacidade de Sangue" }).first(),
      car: painel.locator("tr", { hasText: "Carisma" }).first(),
    });
    const recarregar = async () => {
      // a ficha é estado de componente (sem rota) — re-navega
      await abrirFicha(page, "Dono Sangue XP");
    };
    // (a) XP zerado: motivo "XP insuficiente" no designado — selo fica
    // (flag independe de motivo); Carisma nunca recebe selo.
    let l = linhas();
    t("UI. marcador: selo no designado mesmo sem comprar", await l.cap.locator(".selo").count() === 1);
    t("UI. marcador: Carisma SEM selo (XP insuficiente)", await l.car.locator(".selo").count() === 0);
    // (b) nível máximo forçado — motivo/preço mudam; selo permanece
    // no designado e continua ausente no Carisma.
    selarFicha(CHAR, { "f-sangue": 99 });
    await recarregar();
    l = linhas();
    t("UI. marcador: selo permanece no designado em nível máximo", await l.cap.locator(".selo").count() === 1);
    t("UI. marcador: Carisma SEM selo (nível máximo)", await l.car.locator(".selo").count() === 0);
    // (c) Sangue desabilitado → exceção null → marcador some → SEM selo
    // em nenhuma característica, mesmo no designado.
    setSangueConfig(CID, { habilitado: false, campoCapacidadeId: "f-sangue" });
    await recarregar();
    l = linhas();
    t("UI. marcador: SEM selo no designado com Sangue off", await l.cap.locator(".selo").count() === 0);
    t("UI. marcador: SEM selo no Carisma com Sangue off", await l.car.locator(".selo").count() === 0);
    // (d) campoCapacidadeId ausente/inválido → idem.
    setSangueConfig(CID, { habilitado: true, campoCapacidadeId: "f-inexistente" });
    await recarregar();
    l = linhas();
    t("UI. marcador: SEM selo no designado com campo ausente", await l.cap.locator(".selo").count() === 0);
    t("UI. marcador: SEM selo no Carisma com campo ausente", await l.car.locator(".selo").count() === 0);
    // restaura estado para as seções seguintes
    setSangueConfig(CID, { habilitado: true, campoCapacidadeId: "f-sangue" });
    selarFicha(CHAR, { "f-sangue": 2 });
    await ctx.close();
  }

  // ---------- 4. Mestre também vê o painel na ficha do jogador ----------
  sec("UI. mestre na ficha do jogador");
  {
    await darXp(CHAR, M, { acao: "conceder", quantidade: 30, motivo: "repõe xp" });
    const { ctx, page } = await novaPagina(M);
    await abrirFicha(page, "Dono Sangue XP");
    const painel = page.locator(".progressao-xp");
    t("UI. mestre vê painel de progressão", await painel.count() === 1);
    const linhaCap = painel.locator("tr", { hasText: "Capacidade de Sangue" }).first();
    t("UI. mestre vê selo + Comprar", (await linhaCap.locator(".selo").count()) === 1
      && (await linhaCap.getByRole("button", { name: "Comprar" }).count()) === 1);
    await ctx.close();
  }

  // ---------- 5. Jogador não-dono não vê a ficha alheia ----------
  sec("UI. isolamento entre jogadores");
  {
    const { ctx, page } = await novaPagina(J2);
    await abrirPersonagens(page);
    await page.waitForTimeout(1000);
    const linhas = await page.locator("tr.clicavel").allInnerTexts();
    t("UI. J2 não lista ficha de J1", !linhas.some((l) => l.includes("Dono Sangue XP")), JSON.stringify(linhas));
    await ctx.close();
  }

  // ---------- 6. Mobile 390px ----------
  sec("UI. mobile 390px");
  {
    const { ctx, page } = await novaPagina(J1, { width: 390, height: 844 });
    await abrirFicha(page, "Dono Sangue XP");
    const painel = page.locator(".progressao-xp");
    t("UI. painel renderiza no mobile", await painel.count() === 1);
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
