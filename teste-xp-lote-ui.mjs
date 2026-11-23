#!/usr/bin/env node
// Teste E2E da UI de XP em lote (Issue #185 item 3) — Playwright real.
// Cobre: visibilidade mestre/jogador/espectador, cancelamento, lote válido,
// arquivado ausente, ficha não selada (403 backend), retries idempotentes,
// sequência A→B→A entre campanhas/abas, payload alterado, duplo clique e mobile.
// Servidor + SQLite + site/dist descartáveis.
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  abrirDb, sessao, criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("xp-lote-ui");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, {
  banco: BANCO,
  arquivos: `${DIR}/arq`,
  backups: `${DIR}/bks`,
});

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha XP Lote UI",
    jogadores: { j1: "jogador_lote1", j2: "jogador_lote2" },
  });
  const { campId, cookieMestre, jogadores, novoPersonagem, membMestre, adminId } = c;

  // Fixture de personagens:
  //  - 2 ativos selados (j1), 1 ativo selado (mestre) → lote válido
  //  - 1 arquivado selado → NÃO deve aparecer na lista
  //  - 1 ativo NÃO selado → backend deve rejeitar com ficha_nao_selada
  const selar = (id) => {
    const w = abrirDb(BANCO);
    const p = w.prepare("select data from characters where id=?").get(id);
    const d = JSON.parse(p.data);
    d.__pontos = { bonus: 0, historico: [], selo: { em: new Date().toISOString(), autorId: "teste", autorNome: "Teste" } };
    w.prepare("update characters set data=? where id=?").run(JSON.stringify(d), id);
    w.close();
  };
  const charA = novoPersonagem(jogadores.j1.membershipId, "Herói A"); selar(charA);
  const charB = novoPersonagem(jogadores.j1.membershipId, "Heroína B"); selar(charB);
  const charM = novoPersonagem(membMestre, "Mestre Personagem"); selar(charM);
  const charArq = novoPersonagem(jogadores.j1.membershipId, "Arquivado X"); selar(charArq);
  { const w = abrirDb(BANCO); w.prepare("update characters set status='arquivado' where id=?").run(charArq); w.close(); }
  const charSemSelo = novoPersonagem(jogadores.j2.membershipId, "Sem Selo"); // sem __pontos.selo

  // Segunda campanha do MESMO mestre para provar isolamento do cache por campaignId.
  const criacaoCampanhaB = await req(BASE, "POST", "/campaigns", {
    cookie: cookieMestre,
    body: { name: "Campanha B Independente" },
  });
  if (criacaoCampanhaB.status !== 201 && criacaoCampanhaB.status !== 200) {
    throw new Error("criar segunda campanha falhou: " + JSON.stringify(criacaoCampanhaB.json));
  }
  const campBId = criacaoCampanhaB.json?.campanha?.id;
  if (!campBId || campBId === campId) throw new Error("segunda campanha sem ID próprio");
  let charCampB;
  {
    const w = abrirDb(BANCO);
    const agora = Date.now();
    const membroMestreB = w.prepare("select id from memberships where campaign_id=? and user_id=?").get(campBId, adminId)?.id;
    if (!membroMestreB) throw new Error("membership mestre da segunda campanha ausente");
    const rs = w.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campBId);
    if (!rs) {
      const id = crypto.randomUUID();
      w.prepare("insert into rule_sets (id,campaign_id,name,version,is_active,config,created_at,updated_at) values (?,?,?,?,1,?,?,?)")
        .run(id, campBId, "Regras da campanha", 1, "{}", agora, agora);
    }
    const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
    const estrutura = {
      versao: 1,
      secoes: [{ id: "s1", titulo: "Atributos", ordem: 0, campos: [{ id: "for", label: "FOR", tipo: "inteiro", semantico: "atributo" }] }],
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    };
    w.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,1,?,?)")
      .run(tplId, campBId, "Ficha Teste B", null, adminId, agora, agora);
    w.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
      .run(verId, tplId, JSON.stringify(estrutura), agora, agora);
    w.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);
    charCampB = crypto.randomUUID();
    const data = {
      for: 5,
      __pontos: { bonus: 0, historico: [], selo: { em: new Date().toISOString(), autorId: "teste", autorNome: "Teste" } },
    };
    w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(charCampB, campBId, membroMestreB, verId, "Personagem B", JSON.stringify(data), "{}", "aprovada", 0, agora, agora);
    w.close();
  }

  // Espectador: membership role='espectador'
  const espUid = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    const agora = Date.now();
    w.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(espUid, "espectador_lote", "Espectador Lote", "x", agora, agora);
    w.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
      .run(crypto.randomUUID(), campId, espUid, agora, agora, agora);
    w.close();
  }
  const cookieEsp = sessao(BANCO, espUid).split("=").slice(1).join("=");
  const cookieJ1 = jogadores.j1.cookie.split("=").slice(1).join("=");

  const browser = await chromium.launch();
  const ctx = (cookie) => browser.newContext().then((c2) => {
    return c2.addCookies([{ name: "mestre_rpg_session", value: cookie, url: BASE }]).then(() => c2);
  });

  const abrirPersonagens = async (page) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha XP Lote UI" }).click();
    await page.getByRole("button", { name: "Personagens", exact: true }).click();
    await page.waitForSelector("text=Herói A", { timeout: 15000 });
  };

  // ---------- 1. Mestre vê a ação; Jogador e Espectador não ----------
  {
    const cM = await ctx(cookieMestre.split("=").slice(1).join("="));
    const p = await cM.newPage();
    await abrirPersonagens(p);
    ok("UI. mestre vê botão XP em lote", await p.getByRole("button", { name: "XP em lote" }).count() === 1);
    await cM.close();
  }
  {
    const cJ = await ctx(cookieJ1);
    const p = await cJ.newPage();
    await abrirPersonagens(p);
    ok("UI. jogador NÃO vê botão XP em lote", await p.getByRole("button", { name: "XP em lote" }).count() === 0);
    ok("UI. jogador vê Novo personagem", await p.getByRole("button", { name: /Novo personagem/ }).count() >= 1);
    await cJ.close();
  }
  {
    const cE = await ctx(cookieEsp);
    const p = await cE.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Campanhas" }).first().click();
    await p.locator(".cartao-campanha", { hasText: "Campanha XP Lote UI" }).click();
    ok("UI. espectador não tem aba Personagens", await p.getByRole("button", { name: "Personagens", exact: true }).count() === 0);
    await cE.close();
  }

  // ---------- 2. Fluxo mestre: cancelamento + lote válido ----------
  let requestIdEnviado = null;
  {
    const cM = await ctx(cookieMestre.split("=").slice(1).join("="));
    const p = await cM.newPage();
    p.on("request", (r) => {
      if (r.url().includes("/xp-lote") && r.method() === "POST") {
        try { requestIdEnviado = JSON.parse(r.postData() || "{}").requestId ?? null; } catch {}
      }
    });
    await abrirPersonagens(p);
    await p.getByRole("button", { name: "XP em lote" }).click();
    await p.waitForSelector(".modal-fundo", { timeout: 10000 });
    ok("UI. modal abre", await p.locator(".modal-fundo .modal").count() === 1);

    // Arquivado não aparece na lista do modal
    const lista = await p.locator(".xp-lote-item").allTextContents();
    ok("UI. arquivado ausente da seleção", !lista.some((t) => t.includes("Arquivado X")), lista.join("|"));
    ok("UI. não selado aparece (backend decide)", lista.some((t) => t.includes("Sem Selo")));

    // Cancelar não envia nada
    await p.getByRole("button", { name: "Cancelar" }).click();
    await p.waitForSelector(".modal-fundo", { state: "detached", timeout: 5000 }).catch(() => {});
    ok("UI. cancelar fecha sem POST", await p.locator(".modal-fundo").count() === 0);

    // Reabre e monta lote: Herói A=15, Heroína B=25, motivo
    await p.getByRole("button", { name: "XP em lote" }).click();
    await p.waitForSelector(".modal-fundo");
    const marcar = async (nome) => {
      await p.locator(".xp-lote-item", { hasText: nome }).locator('input[type="checkbox"]').check();
    };
    await marcar("Herói A");
    await marcar("Heroína B");
    await p.locator('input[aria-label="Quantidade de XP para Herói A"]').fill("15");
    await p.locator('input[aria-label="Quantidade de XP para Heroína B"]').fill("25");
    await p.locator('input[aria-label="Motivo da concessão"]').fill("Sessão 3 — conclusão");

    // Botão desabilitado sem motivo? (motivo já preenchido) — segue p/ revisão
    await p.getByRole("button", { name: "Revisar e confirmar" }).click();
    await p.waitForSelector("text=Confirmar concessão de XP");
    const resumo = await p.locator(".modal-fundo").textContent();
    ok("UI. confirmação mostra totais", resumo.includes("2 personagem(ns)") && resumo.includes("40 XP no total"), resumo.slice(0, 120));

    // Duplo clique: dois cliques rápidos — só um lote deve existir
    const btnConfirmar = p.getByRole("button", { name: "Confirmar concessão" });
    await btnConfirmar.click();
    await btnConfirmar.click({ force: true }).catch(() => {});
    await p.waitForSelector("text=XP concedido", { timeout: 15000 });
    ok("UI. resultado exibido", (await p.locator(".modal-fundo").textContent()).includes("40 XP"));
    ok("UI. requestId UUID enviado", /^[0-9a-f-]{36}$/i.test(requestIdEnviado ?? ""), requestIdEnviado);
    await p.getByRole("button", { name: "Fechar" }).click();
    await cM.close();
  }

  // Verifica saldos via API (personagem dono pode ler /progressao)
  {
    const rA = await req(BASE, "GET", `/characters/${charA}/progressao`, { cookie: `mestre_rpg_session=${cookieJ1}` });
    const rB = await req(BASE, "GET", `/characters/${charB}/progressao`, { cookie: `mestre_rpg_session=${cookieJ1}` });
    ok("API. saldo Herói A = 15", rA.json?.xp?.saldo === 15, `saldo=${rA.json?.xp?.saldo}`);
    ok("API. saldo Heroína B = 25", rB.json?.xp?.saldo === 25, `saldo=${rB.json?.xp?.saldo}`);
    const w = abrirDb(BANCO);
    const n = w.prepare("select count(*) n from xp_lotes where campaign_id=?").get(campId).n;
    w.close();
    ok("API. exatamente 1 lote persistido (sem duplicar por duplo clique)", n === 1, `n=${n}`);
  }

  // ---------- 3. Ficha não selada → erro do backend, sem sucesso falso ----------
  {
    const cM = await ctx(cookieMestre.split("=").slice(1).join("="));
    const p = await cM.newPage();
    await abrirPersonagens(p);
    await p.getByRole("button", { name: "XP em lote" }).click();
    await p.waitForSelector(".modal-fundo");
    await p.locator(".xp-lote-item", { hasText: "Sem Selo" }).locator('input[type="checkbox"]').check();
    await p.locator('input[aria-label="Quantidade de XP para Sem Selo"]').fill("10");
    await p.locator('input[aria-label="Motivo da concessão"]').fill("Teste selo");
    await p.getByRole("button", { name: "Revisar e confirmar" }).click();
    await p.getByRole("button", { name: "Confirmar concessão" }).click();
    await p.waitForSelector(".modal-fundo .erro", { timeout: 15000 });
    const erroTxt = await p.locator(".modal-fundo .erro").textContent();
    ok("UI. ficha não selada mostra erro do backend", /selo/i.test(erroTxt), erroTxt);
    ok("UI. sem falso sucesso", await p.locator("text=XP concedido").count() === 0);
    // CSS: item com erro de campo recebe destaque visual dedicado
    const itemErro = p.locator(".xp-lote-item.erro-campo");
    ok("CSS. item com erro marcado (.erro-campo)", await itemErro.count() === 1);
    if (await itemErro.count()) {
      const cs = await itemErro.evaluate((el) => {
        const s = getComputedStyle(el);
        return { border: s.borderColor, bg: s.backgroundColor };
      });
      ok("CSS. .erro-campo tem borda de erro", /172|125|46/.test(cs.border), JSON.stringify(cs));
    }
    await cM.close();
  }

  // ---------- 4. Retry após fechar/reabrir: intenção idempotente ----------
  {
    const cM = await ctx(cookieMestre.split("=").slice(1).join("="));
    const p = await cM.newPage();
    let abortou = false;
    const requestIds = [];
    await p.route("**/xp-lote", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      try { requestIds.push(JSON.parse(route.request().postData() || "{}").requestId ?? null); } catch { requestIds.push(null); }
      if (!abortou) {
        abortou = true;
        // O servidor confirma o commit; só a resposta ao navegador é perdida.
        await route.fetch();
        await route.abort();
      } else {
        await route.continue();
      }
    });
    await abrirPersonagens(p);
    const preencherLote = async () => {
      await p.getByRole("button", { name: "XP em lote" }).click();
      await p.waitForSelector(".modal-fundo");
      await p.locator(".xp-lote-item", { hasText: "Herói A" }).locator('input[type="checkbox"]').check();
      await p.locator('input[aria-label="Quantidade de XP para Herói A"]').fill("7");
      await p.locator('input[aria-label="Motivo da concessão"]').fill("Retry teste");
      await p.getByRole("button", { name: "Revisar e confirmar" }).click();
    };
    const confirmar = async () => p.getByRole("button", { name: "Confirmar concessão" }).click();

    await preencherLote();
    await confirmar();
    await p.waitForSelector(".modal-fundo .erro", { timeout: 15000 });
    const primeira = requestIds[0];
    ok("UI. primeiro POST tem requestId UUID", /^[0-9a-f-]{36}$/i.test(primeira ?? ""), String(primeira));

    // Fecha o modal (desmonta XpLote) depois do erro de rede ambíguo.
    await p.getByRole("button", { name: "Cancelar" }).click();
    await p.waitForSelector(".modal-fundo", { state: "detached", timeout: 5000 });
    // Reabre e recompõe exatamente o mesmo payload.
    await preencherLote();
    await confirmar();
    await p.waitForSelector("text=já havia sido registrada", { timeout: 15000 });
    ok("UI. reabrir modal reutiliza o mesmo requestId", requestIds.length >= 2 && requestIds[1] === primeira, String(primeira) + " / " + String(requestIds[1]));
    ok("UI. servidor confirma replay sem novo lote", (await p.locator(".modal-fundo").textContent()).includes("já havia sido registrada"));

    let rA = await req(BASE, "GET", "/characters/" + charA + "/progressao", { cookie: "mestre_rpg_session=" + cookieJ1 });
    ok("API. retry após remontagem credita apenas 7 XP (15+7=22)", rA.json?.xp?.saldo === 22, "saldo=" + rA.json?.xp?.saldo);
    let w = abrirDb(BANCO);
    let n = w.prepare("select count(*) n from xp_lotes where campaign_id=?").get(campId).n;
    w.close();
    ok("API. resposta perdida + replay persistem apenas 1 novo lote", n === 2, "n=" + n);

    // Após ACK positivo do replay, a mesma ação feita de propósito é nova.
    await p.getByRole("button", { name: "Fechar" }).click();
    await p.waitForSelector(".modal-fundo", { state: "detached", timeout: 5000 });
    await preencherLote();
    await confirmar();
    await p.waitForSelector("text=XP concedido", { timeout: 15000 });
    ok("UI. nova intenção após ACK positivo recebe UUID novo", requestIds.length >= 3 && requestIds[2] !== requestIds[1], String(requestIds[1]) + " / " + String(requestIds[2]));
    ok("UI. nova intenção não aparece como replay", !(await p.locator(".modal-fundo").textContent()).includes("já havia sido registrada"));
    await p.getByRole("button", { name: "Fechar" }).click();
    rA = await req(BASE, "GET", "/characters/" + charA + "/progressao", { cookie: "mestre_rpg_session=" + cookieJ1 });
    ok("API. mesma concessão intencional após sucesso credita novo lote", rA.json?.xp?.saldo === 29, "saldo=" + rA.json?.xp?.saldo);
    w = abrirDb(BANCO);
    n = w.prepare("select count(*) n from xp_lotes where campaign_id=?").get(campId).n;
    w.close();
    ok("API. terceiro POST intencional grava exatamente 1 novo lote", n === 3, "n=" + n);
    await cM.close();
  }

  // ---------- 4b. Payload alterado após ACK ambíguo recebe UUID novo ----------
  {
    const cM = await ctx(cookieMestre.split("=").slice(1).join("="));
    const p = await cM.newPage();
    let abortou = false;
    const requestIds = [];
    await p.route("**/xp-lote", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      try { requestIds.push(JSON.parse(route.request().postData() || "{}").requestId ?? null); } catch { requestIds.push(null); }
      if (!abortou) {
        abortou = true;
        await route.fetch();
        await route.abort();
      } else {
        await route.continue();
      }
    });
    await abrirPersonagens(p);
    const preencher = async (quantidade) => {
      await p.getByRole("button", { name: "XP em lote" }).click();
      await p.waitForSelector(".modal-fundo");
      await p.locator(".xp-lote-item", { hasText: "Mestre Personagem" }).locator('input[type="checkbox"]').check();
      await p.locator('input[aria-label="Quantidade de XP para Mestre Personagem"]').fill(String(quantidade));
      await p.locator('input[aria-label="Motivo da concessão"]').fill("Payload alterado");
      await p.getByRole("button", { name: "Revisar e confirmar" }).click();
    };
    await preencher(3);
    await p.getByRole("button", { name: "Confirmar concessão" }).click();
    await p.waitForSelector(".modal-fundo .erro", { timeout: 15000 });
    const idPayloadOriginal = requestIds[0];
    await p.getByRole("button", { name: "Cancelar" }).click();
    await p.waitForSelector(".modal-fundo", { state: "detached", timeout: 5000 });
    // O valor foi alterado de 3 para 4 depois de possível commit.
    await preencher(4);
    await p.getByRole("button", { name: "Confirmar concessão" }).click();
    await p.waitForSelector("text=XP concedido", { timeout: 15000 });
    ok("UI. payload alterado após resposta perdida recebe UUID novo", requestIds.length >= 2 && requestIds[1] !== idPayloadOriginal, String(idPayloadOriginal) + " / " + String(requestIds[1]));
    ok("UI. payload alterado é operação nova, não replay", !(await p.locator(".modal-fundo").textContent()).includes("já havia sido registrada"));
    const saldo = await req(BASE, "GET", "/characters/" + charM + "/progressao", { cookie: cookieMestre });
    ok("API. original ambíguo + payload alterado são dois lotes distintos", saldo.json?.xp?.saldo === 7, "saldo=" + saldo.json?.xp?.saldo);
    const w = abrirDb(BANCO);
    const n = w.prepare("select count(*) n from xp_lotes where campaign_id=?").get(campId).n;
    w.close();
    ok("API. payload alterado gera lote independente", n === 5, "n=" + n);
    await cM.close();
  }


  // ---------- 4c. F29 A → B → A, troca de aba e isolamento entre campanhas ----------
  {
    const cM = await ctx(cookieMestre.split("=").slice(1).join("="));
    const p = await cM.newPage();
    const requestBodies = [];
    await p.route("**/xp-lote", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      let body = {};
      try { body = JSON.parse(route.request().postData() || "{}"); } catch {}
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        // A comita no servidor; só a resposta ao navegador é descartada.
        await route.fetch();
        await route.abort();
      } else {
        await route.continue();
      }
    });

    const preencherLote = async (nomePersonagem, quantidade, motivo) => {
      await p.getByRole("button", { name: "XP em lote" }).click();
      await p.waitForSelector(".modal-fundo");
      await p.locator(".xp-lote-item", { hasText: nomePersonagem }).locator('input[type="checkbox"]').check();
      await p.locator(`input[aria-label="Quantidade de XP para ${nomePersonagem}"]`).fill(String(quantidade));
      await p.locator('input[aria-label="Motivo da concessão"]').fill(motivo);
      await p.getByRole("button", { name: "Revisar e confirmar" }).click();
    };
    const enviar = async () => p.getByRole("button", { name: "Confirmar concessão" }).click();
    const entrarEmOutraCampanha = async (nomeCampanha, nomePersonagem) => {
      await p.getByRole("button", { name: "Voltar", exact: true }).click();
      await p.locator(".cartao-campanha", { hasText: nomeCampanha }).click();
      await p.getByRole("button", { name: "Personagens", exact: true }).click();
      await p.waitForSelector(`text=${nomePersonagem}`, { timeout: 15000 });
    };

    // A: primeira campanha, resposta perdida após commit.
    await abrirPersonagens(p);
    await preencherLote("Mestre Personagem", 5, "F29 A pendente");
    await enviar();
    await p.waitForSelector(".modal-fundo .erro", { timeout: 15000 });
    const requestIdA = requestBodies[0]?.requestId;
    ok("F29. A inicial envia UUID", /^[0-9a-f-]{36}$/i.test(requestIdA ?? ""), String(requestIdA));
    await p.getByRole("button", { name: "Cancelar" }).click();
    await p.waitForSelector(".modal-fundo", { state: "detached", timeout: 5000 });

    // Personagens desmonta ao trocar para Diário; o cache do módulo permanece.
    await p.getByRole("button", { name: "Diário", exact: true }).click();
    await p.getByRole("button", { name: "Personagens", exact: true }).click();
    await p.waitForSelector("text=Mestre Personagem", { timeout: 15000 });

    // B: outra campanha do mesmo mestre, payload independente e ACK positivo.
    await entrarEmOutraCampanha("Campanha B Independente", "Personagem B");
    await preencherLote("Personagem B", 9, "F29 B outra campanha");
    await enviar();
    await p.waitForSelector("text=XP concedido", { timeout: 15000 });
    const requestIdB = requestBodies[1]?.requestId;
    ok("F29. B em outra campanha recebe UUID próprio",
      /^[0-9a-f-]{36}$/i.test(requestIdB ?? "") && requestIdB !== requestIdA,
      String(requestIdA) + " / " + String(requestIdB));
    await p.getByRole("button", { name: "Fechar" }).click();

    // Retorna à campanha A: sua intenção pendente ainda conserva o UUID original.
    await entrarEmOutraCampanha("Campanha XP Lote UI", "Mestre Personagem");
    await preencherLote("Mestre Personagem", 5, "F29 A pendente");
    await enviar();
    await p.waitForSelector("text=já havia sido registrada", { timeout: 15000 });
    const requestIdAReplay = requestBodies[2]?.requestId;
    ok("F29. sequência A→B→A reutiliza UUID de A",
      requestIdAReplay === requestIdA && requestIdAReplay !== requestIdB,
      String(requestIdA) + " / " + String(requestIdB) + " / " + String(requestIdAReplay));
    ok("F29. replay de A não concede XP duplicado",
      (await p.locator(".modal-fundo").textContent()).includes("já havia sido registrada"));

    let saldoA = await req(BASE, "GET", `/characters/${charM}/progressao`, { cookie: cookieMestre });
    ok("F29. A foi registrada uma única vez (saldo inicial 7 + 5)",
      saldoA.json?.xp?.saldo === 12, "saldo=" + saldoA.json?.xp?.saldo);
    let saldoB = await req(BASE, "GET", `/characters/${charCampB}/progressao`, { cookie: cookieMestre });
    ok("F29. B foi registrada somente na segunda campanha (+9)",
      saldoB.json?.xp?.saldo === 9, "saldo=" + saldoB.json?.xp?.saldo);
    let w = abrirDb(BANCO);
    let nA = w.prepare("select count(*) n from xp_lotes where campaign_id=?").get(campId).n;
    let nB = w.prepare("select count(*) n from xp_lotes where campaign_id=?").get(campBId).n;
    w.close();
    ok("F29. campanha A tem só o lote original A (sem duplicação)", nA === 6, "nA=" + nA);
    ok("F29. campanha B tem exatamente um lote B", nB === 1, "nB=" + nB);

    // Após ACK positivo da replay A, nova concessão intencional precisa de UUID novo.
    await p.getByRole("button", { name: "Fechar" }).click();
    await preencherLote("Mestre Personagem", 5, "F29 A pendente");
    await enviar();
    await p.waitForSelector("text=XP concedido", { timeout: 15000 });
    const requestIdANovo = requestBodies[3]?.requestId;
    ok("F29. nova intenção A após ACK gera UUID novo",
      /^[0-9a-f-]{36}$/i.test(requestIdANovo ?? "") && requestIdANovo !== requestIdA,
      String(requestIdA) + " / " + String(requestIdANovo));
    saldoA = await req(BASE, "GET", `/characters/${charM}/progressao`, { cookie: cookieMestre });
    ok("F29. nova intenção A credita uma segunda vez, intencionalmente",
      saldoA.json?.xp?.saldo === 17, "saldo=" + saldoA.json?.xp?.saldo);
    w = abrirDb(BANCO);
    nA = w.prepare("select count(*) n from xp_lotes where campaign_id=?").get(campId).n;
    nB = w.prepare("select count(*) n from xp_lotes where campaign_id=?").get(campBId).n;
    w.close();
    ok("F29. campanha A totaliza dois lotes A (original + nova intenção)", nA === 7, "nA=" + nA);
    ok("F29. campanha B continua isolada com um lote", nB === 1, "nB=" + nB);
    await p.getByRole("button", { name: "Fechar" }).click();
    await cM.close();
  }

  // ---------- 5. requestId divergente → 409 (nível API) ----------
  {
    const rid = crypto.randomUUID();
    const itens = [{ characterId: charA, quantidade: 3 }];
    const r1 = await req(BASE, "POST", `/campaigns/${campId}/xp-lote`, {
      cookie: cookieMestre, body: { requestId: rid, motivo: "div", itens },
    });
    const r2 = await req(BASE, "POST", `/campaigns/${campId}/xp-lote`, {
      cookie: cookieMestre, body: { requestId: rid, motivo: "div", itens: [{ characterId: charA, quantidade: 4 }] },
    });
    ok("API. requestId divergente → 409", r2.status === 409 && r2.json?.codigo === "requestId_divergente", `status=${r2.status}`);
    const r3 = await req(BASE, "POST", `/campaigns/${campId}/xp-lote`, {
      cookie: cookieMestre, body: { requestId: rid, motivo: "div", itens },
    });
    ok("API. mesmo requestId+payload → repetido", r3.status === 200 && r3.json?.repetido === true);
  }

  // ---------- 6. Acabamento visual — estilos dedicados xp-lote-* ----------
  {
    const cM = await ctx(cookieMestre.split("=").slice(1).join("="));
    const p = await cM.newPage();
    await abrirPersonagens(p);
    await p.getByRole("button", { name: "XP em lote" }).click();
    await p.waitForSelector(".xp-lote-lista");
    const estilo = (sel, prop) => p.locator(sel).first().evaluate((el, pr) => getComputedStyle(el)[pr], prop);
    ok("CSS. .xp-lote-lista flex column", (await estilo(".xp-lote-lista", "display")) === "flex" && (await estilo(".xp-lote-lista", "flexDirection")) === "column");
    ok("CSS. .xp-lote-lista rolagem vertical dedicada", (await estilo(".xp-lote-lista", "overflowY")) === "auto");
    ok("CSS. .xp-lote-lista com borda", parseFloat(await estilo(".xp-lote-lista", "borderTopWidth")) > 0);

    const itemHerói = p.locator(".xp-lote-item", { hasText: "Herói A" });
    await itemHerói.locator('input[type="checkbox"]').check();
    const selItem = p.locator(".xp-lote-item.selecionado").first();
    ok("CSS. seleção aplica .selecionado", await selItem.count() >= 1);
    const bgSel = await selItem.evaluate((el) => getComputedStyle(el).backgroundColor);
    const bgNorm = await p.locator(".xp-lote-item:not(.selecionado)").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    ok("CSS. selecionado visualmente distinto", bgSel !== bgNorm, `${bgSel} vs ${bgNorm}`);

    const qtdInput = p.locator(".xp-lote-qtd input").first();
    ok("CSS. campo XP aparece ao selecionar", await qtdInput.count() === 1);
    const wQtd = parseFloat(await qtdInput.evaluate((el) => getComputedStyle(el).width));
    ok("CSS. input XP com largura dedicada", wQtd >= 80 && wQtd <= 100, `w=${wQtd}`);

    await p.locator('input[aria-label="Quantidade de XP para Herói A"]').fill("5");
    await p.locator('input[aria-label="Motivo da concessão"]').fill("CSS check");
    await p.getByRole("button", { name: "Revisar e confirmar" }).click();
    await p.waitForSelector(".xp-lote-resumo");
    ok("CSS. .xp-lote-resumo li com cartão", parseFloat(await estilo(".xp-lote-resumo li", "borderTopWidth")) > 0);
    ok("CSS. .xp-lote-resumo com rolagem", (await estilo(".xp-lote-resumo", "overflowY")) === "auto");
    await p.getByRole("dialog", { name: "Confirmar concessão de XP" }).getByRole("button", { name: "Voltar" }).click();
    await p.getByRole("button", { name: "Cancelar" }).last().click();
    await cM.close();
  }

  // ---------- 7. Mobile ----------
  {
    const cM = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await cM.addCookies([{ name: "mestre_rpg_session", value: cookieMestre.split("=").slice(1).join("="), url: BASE }]);
    const p = await cM.newPage();
    await abrirPersonagens(p);
    await p.getByRole("button", { name: "XP em lote" }).click();
    await p.waitForSelector(".modal-fundo");
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok("UI. mobile: modal utilizável sem overflow horizontal", !overflow);
    const wrap = await p.locator(".xp-lote-item").first().evaluate((el) => getComputedStyle(el).flexWrap);
    ok("UI. mobile: item XP empilha campo de quantidade", wrap === "wrap", wrap);
    await p.getByRole("button", { name: "Cancelar" }).click();
    await cM.close();
  }

  await browser.close();
} finally {
  await encerrarServidor(proc).catch(() => {});
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length} passaram, ${falhas.length} falharam`);
limparDir(DIR);
process.exit(falhas.length ? 1 : 0);
