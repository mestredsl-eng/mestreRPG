#!/usr/bin/env node
// Teste E2E do painel SOMENTE LEITURA de Sangue na ficha/Mesa
// (Issue #186, C8-C1 — contrato real GET /characters/:id/sangue da #227).
// Cobre: saldo/capacidade, natureza conhecida/desconhecida, ação de
// recuperação efetiva, estados desabilitado/capacidade_indisponivel/
// ledger_invalido, permissões (dono/mestre veem; J2/espectador 403),
// realtime via socket, troca de personagem, presença na Mesa e
// mobile 390px. (C8-C2 acrescentou controles reais de mutação —
// cobertos em teste-sangue-actions-ui.mjs; aqui validam-se os
// contextos em que NENHUM controle deve aparecer.)
// Servidor+SQLite+site 100% descartáveis.
import crypto from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, encerrarServidor, limparDir, req, sessao,
} from "./teste-base.mjs";

const DIR = dirTeste("sangue-read-ui");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let pass = 0, fail = 0;
const t = (n, c, x = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, x); } };
const sec = (n) => console.log("\n== " + n + " ==");

const getSangue = (id, cookie) => req(BASE, "GET", `/characters/${id}/sangue`, { cookie });

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

const CFG_BASE = {
  habilitado: true,
  campoCapacidadeId: "f-cap",
  campoNaturezaId: "f-nat",
  naturezas: {
    humano: { recuperacao: "descansar" },
    vampiro: { recuperacao: "alimentar", metaHumanoComPoder: true },
  },
  recuperacaoSangue: {
    habilitado: true,
    acoes: {
      descansar: { habilitada: true, quantidade: 2 },
      alimentar: { habilitada: true, quantidade: 3 },
    },
  },
};

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Sangue Read UI",
    jogadores: { j1: "jog_rd_ui", j2: "jog_outro_ui" },
  });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.j1.cookie;
  const J2 = c.jogadores.j2.cookie;

  // Espectador (membership role=espectador + sessão própria)
  let ESP;
  {
    const w = db();
    const uid = crypto.randomUUID(), mid = crypto.randomUUID(), agora = Date.now();
    w.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, "esp_rd_ui", "Espectador", "$2a$10$fakehashfakehashfakehashfakehashfakehashfakehashfakeha", agora, agora);
    w.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
      .run(mid, CID, uid, agora, agora, agora);
    w.close();
    ESP = sessao(BANCO, uid);
  }

  sec("Fixture — template, config e personagens");
  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Sangue Read" } });
  const tid = mod.json.modelo.id, vid = mod.json.modelo.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Sangue", ordem: 0, campos: [
        { id: "f-cap", label: "Capacidade", tipo: "inteiro" },
        { id: "f-nat", label: "Natureza", tipo: "selecao_unica" },
      ],
    }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${tid}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${tid}/publish`, { cookie: M, body: { versionId: vid } });
  setSangueConfig(CID, CFG_BASE);

  const pj = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J1, body: { name: "Lobisomem UI", templateVersionId: vid, data: { "f-cap": 8, "f-nat": "humano" } },
  });
  const CHAR = pj.json?.personagem?.id ?? pj.json?.id;
  setSangue(CHAR, { saldo: 5, capacidade: 8, usos: {}, historico: [] });
  const pj2 = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J1, body: { name: "Vampira UI", templateVersionId: vid, data: { "f-cap": 6, "f-nat": "vampiro" } },
  });
  const CHAR2 = pj2.json?.personagem?.id ?? pj2.json?.id;
  setSangue(CHAR2, { saldo: 9, capacidade: 6, usos: {}, historico: [] });
  const pj3 = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: J2, body: { name: "Sem Sangue", templateVersionId: vid, data: { "f-cap": 4 } },
  });
  const CHAR3 = pj3.json?.personagem?.id ?? pj3.json?.id;
  t("fixture: 3 personagens", !!(CHAR && CHAR2 && CHAR3));

  // ---------- API: contrato e permissões ----------
  sec("API. contrato GET /sangue");
  {
    const r = await getSangue(CHAR, J1);
    t("dono: estado ok", r.json?.estado === "ok", JSON.stringify(r.json).slice(0, 200));
    t("dono: saldo 5 / capacidade 8", r.json?.saldo === 5 && r.json?.capacidadeMax === 8);
    t("dono: natureza humano conhecida", r.json?.natureza?.rotulo === "humano" && r.json?.natureza?.conhecida === true);
    t("dono: ação descansar +2", r.json?.acaoRecuperacao?.acao === "descansar" && r.json?.acaoRecuperacao?.quantidade === 2);
    const r2 = await getSangue(CHAR, J2);
    t("não-dono J2: 403", r2.status === 403, `status=${r2.status}`);
    const r3 = await getSangue(CHAR, ESP);
    t("espectador: 403", r3.status === 403, `status=${r3.status}`);
    const rm = await getSangue(CHAR, M);
    t("mestre: estado ok", rm.json?.estado === "ok" && rm.json?.saldo === 5);
  }

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
    await page.locator(".cartao-campanha", { hasText: "Campanha Sangue Read UI" }).click();
    await page.getByRole("button", { name: "Personagens", exact: true }).click();
  };
  const abrirFicha = async (page, nome) => {
    await abrirPersonagens(page);
    await page.locator("tr.clicavel", { hasText: nome }).first().click();
    await page.waitForSelector(".painel-sangue-leitura", { timeout: 15000 });
    // espera o GET resolver — "Carregando…" some quando o estado chega
    await page.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      return p && !p.innerText.includes("Carregando");
    }, { timeout: 15000 });
  };

  // ---------- 1. Dono vê saldo/capacidade/natureza/ação ----------
  sec("UI. dono na ficha");
  {
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Lobisomem UI");
    const painel = page.locator(".painel-sangue-leitura");
    const txt = await painel.innerText();
    t("UI. painel visível", await painel.count() === 1);
    t("UI. saldo 5 / capacidade 8", /5/.test(txt) && /8/.test(txt), txt.slice(0, 200));
    t("UI. natureza humano", /humano/i.test(txt));
    t("UI. ação Descansar +2", /Descansar/i.test(txt) && /\+2/.test(txt));
    // C8-C2: o dono passa a ter o controle real de recuperação
    // (sangue:recuperar). O contrato read-only C8-C1 não mudou — o que
    // segue proibido é mutação por não-dono/mestre, coberta na suíte
    // teste-sangue-actions-ui.mjs.
    t("UI. dono vê controle de recuperação", await painel.getByRole("button", { name: /Descansar/ }).count() === 1);
    // troca de personagem → dados da outra ficha (re-navega: o app
    // recarrega a lista e o painel busca o novo characterId)
    await abrirFicha(page, "Vampira UI");
    const txt2 = await page.locator(".painel-sangue-leitura").innerText();
    t("UI. troca de personagem → saldo 9 / cap 6", /9/.test(txt2) && /6/.test(txt2), txt2.slice(0, 200));
    t("UI. vampiro → Alimentar-se +3", /Alimentar/i.test(txt2) && /\+3/.test(txt2));
    await ctx.close();
  }

  // ---------- 2. Realtime: mutação do personagem atualiza o painel ----------
  sec("UI. realtime via socket");
  {
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Lobisomem UI");
    const painel = page.locator(".painel-sangue-leitura");
    // muda o saldo no banco e dispara mutação real via PATCH (emite
    // personagens:atualizados — mesmo caminho de qualquer edição)
    setSangue(CHAR, { saldo: 12, capacidade: 8, usos: {}, historico: [] });
    await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: J1, body: { name: "Lobisomem UI" } });
    await page.waitForFunction(() => {
      const p = document.querySelector(".painel-sangue-leitura");
      return p && /12/.test(p.innerText);
    }, { timeout: 15000 }).catch(() => null);
    const txt = await painel.innerText();
    t("UI. saldo 12 refletido sem reload", /12/.test(txt), txt.slice(0, 200));
    await ctx.close();
  }

  // ---------- 3. Estados de erro/indisponível ----------
  sec("UI. estados degradados");
  {
    const { ctx, page } = await novaPagina(J1);
    // Sangue desabilitado
    setSangueConfig(CID, null);
    await abrirFicha(page, "Lobisomem UI");
    const txtOff = await page.locator(".painel-sangue-leitura").innerText();
    t("UI. desabilitado → mensagem segura", /desabilitad/i.test(txtOff), txtOff.slice(0, 160));
    t("UI. desabilitado → sem saldo", !/\b5\b|\b12\b/.test(txtOff));
    // ledger inválido
    setSangueConfig(CID, CFG_BASE);
    setSangue(CHAR, "lixo-invalido");
    await abrirFicha(page, "Lobisomem UI");
    const txtBad = await page.locator(".painel-sangue-leitura").innerText();
    t("UI. ledger inválido → fail-closed", /inválido|inválid/i.test(txtBad), txtBad.slice(0, 200));
    // P2 revisão: config isolada pode devolver acaoRecuperacao mesmo
    // com estado fail-closed — o painel NÃO pode anunciá-la
    t("UI. ledger inválido → ação de recuperação OCULTA", !/Ação de recuperação disponível/i.test(txtBad), txtBad.slice(0, 240));
    // capacidade indisponível (campo inexistente)
    setSangue(CHAR, { saldo: 5, capacidade: 8, usos: {}, historico: [] });
    setSangueConfig(CID, { ...CFG_BASE, campoCapacidadeId: "f-inexistente" });
    await abrirFicha(page, "Lobisomem UI");
    const txtCap = await page.locator(".painel-sangue-leitura").innerText();
    t("UI. capacidade indisponível → estado seguro", /indispon|capacidade/i.test(txtCap), txtCap.slice(0, 200));
    t("UI. capacidade indisponível → ação OCULTA", !/Ação de recuperação disponível/i.test(txtCap), txtCap.slice(0, 240));
    setSangueConfig(CID, CFG_BASE);
    await ctx.close();
  }

  // ---------- 4. Natureza desconhecida + ação ausente ----------
  sec("UI. natureza desconhecida / sem ação");
  {
    // personagem J1 extra com natureza fora do mapa e recuperação global off
    const pj4 = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie: J1, body: { name: "Andróide UI", templateVersionId: vid, data: { "f-cap": 5, "f-nat": "eterno" } },
    });
    const CHAR4 = pj4.json?.personagem?.id ?? pj4.json?.id;
    setSangue(CHAR4, { saldo: 3, capacidade: 5, usos: {}, historico: [] });
    setSangueConfig(CID, { ...CFG_BASE, recuperacaoSangue: { habilitado: false, acoes: {} } });
    const { ctx, page } = await novaPagina(J1);
    await abrirFicha(page, "Andróide UI");
    const txt = await page.locator(".painel-sangue-leitura").innerText();
    t("UI. natureza 'eterno' → não reconhecida", /não reconhecida|nao reconhecida/i.test(txt), txt.slice(0, 240));
    t("UI. sem ação de recuperação exibida", !/Ação de recuperação disponível/i.test(txt));
    await ctx.close();
    setSangueConfig(CID, CFG_BASE);
  }

  // ---------- 5. Mestre vê painel na ficha do jogador ----------
  sec("UI. mestre");
  {
    const { ctx, page } = await novaPagina(M);
    await abrirFicha(page, "Lobisomem UI");
    const painel = page.locator(".painel-sangue-leitura");
    const txt = await painel.innerText();
    // saldo atual é 5 (seção de estados degradados restaurou o ledger)
    t("UI. mestre vê saldo/natureza", /5/.test(txt) && /humano/i.test(txt), txt.slice(0, 200));
    // C8-C2: mestre tem "Ações do mestre" (details fechado — fora da
    // árvore de acessibilidade), mas NUNCA os controles do jogador.
    t("UI. mestre: sem controles de jogador", await painel.getByRole("button", { name: /Descansar|Ativar|Ajustar|Reconciliar/ }).count() === 0);
    await ctx.close();
  }

  // ---------- 6. Mesa: painel aparece ao escolher personagem no desafio ----------
  sec("UI. Mesa — Desafio D10");
  {
    const s = await req(BASE, "POST", `/campaigns/${CID}/sessoes`, { cookie: M, body: { name: "Sessão Sangue UI" } });
    const SID = s.json?.sessao?.id;
    t("API. sessão de mesa criada", !!SID, JSON.stringify(s.json).slice(0, 120));
    const { ctx, page } = await novaPagina(M);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Sangue Read UI" }).click();
    await page.getByRole("button", { name: "Mesa", exact: true }).click();
    await page.waitForTimeout(800);
    const sessaoRow = page.locator("table.tabela tbody tr.clicavel", { hasText: "Sessão Sangue UI" }).first();
    if (await sessaoRow.count()) {
      await sessaoRow.click();
      await page.waitForTimeout(1200);
      // o DesafioD10 já abre expandido por padrão (aberto=true) — o
      // formulário está visível assim que a sessão carrega
      const selPersonagem = page.locator(".formulario select").first();
      await selPersonagem.selectOption(CHAR);
      await page.waitForSelector(".painel-sangue-leitura", { timeout: 15000 }).catch(() => null);
      const temPainel = await page.locator(".painel-sangue-leitura").count();
      t("UI. Mesa: painel de Sangue aparece ao escolher personagem", temPainel === 1, `count=${temPainel}`);
      if (temPainel) {
        // C8-C2: a carga do painel inclui a lista da campanha (posse
        // real) — espera sair de "Carregando…" antes de ler.
        await page.waitForFunction(() => {
          const p = document.querySelector(".painel-sangue-leitura");
          return p && !p.innerText.includes("Carregando");
        }, { timeout: 15000 }).catch(() => null);
        const txt = await page.locator(".painel-sangue-leitura").innerText();
        t("UI. Mesa: saldo correto no painel", /5/.test(txt), txt.slice(0, 160));
      }
    } else {
      t("UI. Mesa: sessão encontrada", false, "linha da sessão não apareceu");
    }
    await ctx.close();
  }

  // ---------- 6b. Resposta obsoleta não sobrescreve troca de personagem ----------
  sec("UI. corrida — resposta A atrasada × B rápida");
  {
    const s = await req(BASE, "POST", `/campaigns/${CID}/sessoes`, { cookie: M, body: { name: "Sessão Corrida" } });
    const SID2 = s.json?.sessao?.id;
    const { ctx, page } = await novaPagina(M);
    // atrasa SÓ o GET do CHAR (A); CHAR2 (B) responde normal
    await page.route(`**/api/characters/${CHAR}/sangue`, async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Sangue Read UI" }).click();
    await page.getByRole("button", { name: "Mesa", exact: true }).click();
    await page.waitForTimeout(800);
    const sessaoRow = page.locator("table.tabela tbody tr.clicavel", { hasText: "Sessão Corrida" }).first();
    if (await sessaoRow.count()) {
      await sessaoRow.click();
      await page.waitForTimeout(1200);
      const sel = page.locator(".formulario select").first();
      // A primeiro (GET fica pendente 2.5s), depois troca para B
      await sel.selectOption(CHAR);
      await page.waitForTimeout(300);
      await sel.selectOption(CHAR2);
      // B resolve rápido; quando a resposta atrasada de A chegar,
      // a guarda de geração deve descartá-la
      await page.waitForSelector(".painel-sangue-leitura", { timeout: 15000 });
      await page.waitForTimeout(3500); // garante que a resposta de A já chegou
      const txt = await page.locator(".painel-sangue-leitura").innerText();
      t("UI. corrida: painel mostra SOMENTE dados de B (vampiro 9/6)", /9/.test(txt) && /6/.test(txt) && /Alimentar/i.test(txt), txt.slice(0, 240));
      t("UI. corrida: dados de A (Descansar) NÃO apareceram", !/Descansar/i.test(txt));
    } else {
      t("UI. corrida: sessão encontrada", false);
    }
    await ctx.close();
  }

  // ---------- 7. Mobile 390px ----------
  sec("UI. mobile 390px");
  {
    const { ctx, page } = await novaPagina(J1, { width: 390, height: 844 });
    await abrirFicha(page, "Lobisomem UI");
    const painel = page.locator(".painel-sangue-leitura");
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
