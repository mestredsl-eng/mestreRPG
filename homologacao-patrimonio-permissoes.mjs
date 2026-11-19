#!/usr/bin/env node
// Homologação real da Issue #165 — permissões granulares do Patrimônio.
// Cobre a matriz das 7 flags na interface (não só no backend):
//   patrimônio: adicionaItens, removeItens, editaEquipamentos,
//               editaVeiculos, criaContas
//   financeiro: compraVenda, pix
// Inclui painel de Regras (salvar/persistir/recarregar), fail-closed durante
// o carregamento das regras, backend continuando a rejeitar (403) e
// responsividade desktop/mobile.
import { chromium } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("patrimonio-permissoes-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "patrimonio-permissoes");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CAMPANHA = "Campanha Permissões";

// Flags internas do teste → chaves reais do backend (mesmo mapa de
// teste-patrimonio-permissoes.mjs).
const TODAS = { adicionaItens: true, removeItens: true, editaEquipamentos: true, editaVeiculos: true, criaContas: true, compraVenda: true, pix: true };
const NENHUMA = Object.fromEntries(Object.keys(TODAS).map((k) => [k, false]));
const backendCfg = (p) => ({
  patrimonio: {
    jogadorAdicionaItens: p.adicionaItens,
    jogadorRemoveItens: p.removeItens,
    jogadorEditaEquipamentos: p.editaEquipamentos,
    jogadorEditaVeiculos: p.editaVeiculos,
    jogadorCriaContas: p.criaContas,
  },
  financeiro: { jogadorCompraVenda: p.compraVenda, jogadorPix: p.pix },
});

let proc, browser, ids;
const definirCfg = (p) => {
  const b = backendCfg(p);
  const db = abrirDb(BANCO);
  try {
    const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(ids.campId);
    const cfg = JSON.parse(rs.config || "{}");
    cfg.patrimonio = b.patrimonio;
    cfg.financeiro = b.financeiro;
    db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
  } finally { db.close(); }
};
const lerCfg = async () => {
  const r = await req(BASE, "GET", `/campaigns/${ids.campId}/regras`, { cookie: ids.cookieMestre });
  return r.json?.config ?? {};
};

async function shot(page, nome) { try { await page.screenshot({ path: join(SHOTS, `${nome}.png`), fullPage: false }); } catch { } }
async function login(page, user, senha = "senha-jogador-123") {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(CAMPANHA, { exact: true }).first().click();
}
async function abrirPersonagem(page, nome) {
  await page.locator(".abas button", { hasText: "Personagens" }).first().click();
  await page.locator("tr.clicavel", { hasText: nome }).first().click();
  // O detalhe carrega a ficha e o Patrimônio de forma assíncrona.
  await page.getByRole("button", { name: "Inventário", exact: true }).waitFor({ timeout: 15000 });
}
async function abaPatrimonio(page, nome) {
  await page.getByRole("button", { name: nome, exact: true }).first().click();
  await page.waitForTimeout(600);
}
// Conta quantos botões/elementos correspondem — usado para asserts de
// presença (count>0) e ausência (count===0) das ações granulares.
const contar = (page, nome) => page.getByRole("button", { name: nome, exact: true }).count();

// Reutiliza a sessão (storageState) entre contextos: o rate limit do
// servidor estourava com um login por cenário. O primeiro acesso de cada
// papel ainda passa pelo formulário real.
let stateJ1 = null, stateMestre = null;
async function sessao(role, viewport) {
  const state = role === "mestre" ? stateMestre : stateJ1;
  const ctx = await browser.newContext({ viewport, ...(state ? { storageState: state } : {}) });
  const page = await ctx.newPage();
  if (!state) {
    await login(page, role === "mestre" ? "mestre_teste" : "perm_j1", role === "mestre" ? "senha-forte-123" : "senha-jogador-123");
    const st = await ctx.storageState();
    if (role === "mestre") stateMestre = st; else stateJ1 = st;
  } else {
    await page.goto(BASE);
    await page.getByText("Servidor online").waitFor({ timeout: 15000 });
  }
  return { ctx, page };
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  ids = await criarCenario(BASE, BANCO, {
    campanha: CAMPANHA,
    jogadores: { j1: "perm_j1", j2: "perm_j2" },
  });
  const PJ1 = ids.novoPersonagem(ids.jogadores.j1.membershipId, "PJ Um");
  const PJ1B = ids.novoPersonagem(ids.jogadores.j1.membershipId, "PJ Um B");
  const PJ2 = ids.novoPersonagem(ids.jogadores.j2.membershipId, "PJ Dois");
  const J1 = ids.jogadores.j1.cookie;

  // Recursos de apoio criados pelo MESTRE (bypass): item, equipamento,
  // veículo, conta e uma compra (para o botão Estornar existir).
  const itemId = (await req(BASE, "POST", `/characters/${PJ1}/inventario`, { cookie: ids.cookieMestre, body: { name: "Espada Curta", quantity: 3 } })).json.id;
  // Dois equipamentos: um equipado (Desequipar) e um guardado (Equipar).
  await req(BASE, "POST", `/characters/${PJ1}/equipamentos`, { cookie: ids.cookieMestre, body: { name: "Elmo", equipped: true } });
  await req(BASE, "POST", `/characters/${PJ1}/equipamentos`, { cookie: ids.cookieMestre, body: { name: "Escudo" } });
  await req(BASE, "POST", `/characters/${PJ1}/veiculos`, { cookie: ids.cookieMestre, body: { name: "Moto", kind: "motocicleta" } });
  const contaId = (await req(BASE, "POST", `/characters/${PJ1}/financeiro/contas`, { cookie: ids.cookieMestre, body: { type: "especie", name: "Carteira", balanceReais: 500 } })).json.id;
  // Conta no OUTRO personagem do mesmo jogador: o GET /characters do
  // jogador só enxerga os próprios personagens, então é este o destino
  // que aparece no PIX fictício quando só a flag pix está ligada.
  await req(BASE, "POST", `/characters/${PJ1B}/financeiro/contas`, { cookie: ids.cookieMestre, body: { type: "especie", name: "Poupança", balanceReais: 100 } });
  // Compra paga: gera transação financeira estornável no histórico.
  await req(BASE, "POST", `/characters/${PJ1}/financeiro/operacao`, {
    cookie: ids.cookieMestre,
    body: { tipo: "compra", accountId: contaId, valor: 5, descricao: "Compra paga", item: { name: "Café", quantity: 1 }, requestId: crypto.randomUUID() },
  });
  // Compra sem pagamento (pagar=false): gera item com marca de estorno local.
  await req(BASE, "POST", `/characters/${PJ1}/financeiro/operacao`, {
    cookie: ids.cookieMestre,
    body: { tipo: "compra", pagar: false, valor: 10, descricao: "Compra base", item: { name: "Pão", quantity: 1 }, requestId: crypto.randomUUID() },
  });
  t("fixtures: recursos de apoio criados", !!(itemId && contaId));

  browser = await chromium.launch();

  // ================================================================
  // FASE 1 — Painel de permissões em Regras (mestre, desktop)
  // ================================================================
  sec("1. Painel de Regras — categorias, estado, salvar e persistência");
  {
    definirCfg(TODAS);
    const { ctx, page } = await sessao("mestre", { width: 1366, height: 900 });
    const errosConsole = [];
    page.on("pageerror", (e) => errosConsole.push(String(e)));
    await irCampanha(page);
    await page.locator(".abas button", { hasText: "Regras" }).first().click();
    await page.locator(".abas button", { hasText: "Pontuação" }).first().click();
    await page.waitForTimeout(800);

    const nH5 = await page.locator("h5").count();
    t("h5 Patrimônio presente", await page.locator("h5", { hasText: "Patrimônio" }).count() === 1, `h5 total=${nH5}`);
    t("h5 Financeiro presente", await page.locator("h5", { hasText: "Financeiro" }).count() === 1, `h5 total=${nH5}`);
    const ROTULOS = [
      "Jogador adiciona itens ao inventário", "Jogador remove itens do inventário",
      "Jogador edita equipamentos", "Jogador edita veículos", "Jogador cria contas financeiras",
      "Jogador registra compra e venda", "Jogador faz PIX fictício entre personagens",
    ];
    for (const r of ROTULOS) {
      t(`checkbox "${r}" presente`, await page.locator("label.checkbox", { hasText: r }).count() === 1);
    }
    const chk = (rotulo) => page.locator("label.checkbox", { hasText: rotulo }).locator("input[type=checkbox]");
    t("removeItens reflete config (on)", await chk("Jogador remove itens do inventário").isChecked() === true);

    // Desliga removeItens e salva — PUT /config real.
    await chk("Jogador remove itens do inventário").uncheck();
    await chk("Jogador adiciona itens ao inventário").uncheck();
    await page.getByRole("button", { name: "Salvar configuração" }).click();
    await page.waitForTimeout(1200);
    const cfg = await lerCfg();
    t("PUT persistiu removeItens=false", cfg.patrimonio?.jogadorRemoveItens === false, JSON.stringify(cfg.patrimonio));
    t("PUT persistiu adicionaItens=false", cfg.patrimonio?.jogadorAdicionaItens === false);
    t("PUT preservou demais chaves patrimônio", cfg.patrimonio?.jogadorEditaVeiculos === true && cfg.patrimonio?.jogadorCriaContas === true);
    t("PUT preservou financeiro", cfg.financeiro?.jogadorCompraVenda === true && cfg.financeiro?.jogadorPix === true);
    t("PUT preservou pontos", !!cfg.pontos);

    // Recarrega: o estado persistido volta marcado corretamente.
    await page.reload();
    await page.getByText("Servidor online").waitFor({ timeout: 15000 });
    await irCampanha(page);
    await page.locator(".abas button", { hasText: "Regras" }).first().click();
    await page.locator(".abas button", { hasText: "Pontuação" }).first().click();
    await page.waitForTimeout(800);
    t("após reload: removeItens continua desmarcado", await chk("Jogador remove itens do inventário").isChecked() === false);
    t("após reload: adicionaItens continua desmarcado", await chk("Jogador adiciona itens ao inventário").isChecked() === false);
    t("após reload: editaVeiculos segue marcado", await chk("Jogador edita veículos").isChecked() === true);

    // Restaura tudo ligado para as próximas fases.
    await chk("Jogador remove itens do inventário").check();
    await chk("Jogador adiciona itens ao inventário").check();
    await page.getByRole("button", { name: "Salvar configuração" }).click();
    await page.waitForTimeout(1000);
    const cfg2 = await lerCfg();
    t("restauração persistida", cfg2.patrimonio?.jogadorRemoveItens === true && cfg2.patrimonio?.jogadorAdicionaItens === true);
    await shot(page, "regras-painel-permissoes");
    t("sem erros de console no painel", errosConsole.length === 0, errosConsole.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ================================================================
  // FASE 2 — Matriz de permissões na UI do jogador (desktop)
  // ================================================================
  sec("2. UI do jogador — tudo desligado esconde todas as ações");
  {
    definirCfg(NENHUMA);
    const { ctx, page } = await sessao("jogador", { width: 1366, height: 900 });
    await irCampanha(page);
    await abrirPersonagem(page, "PJ Um");

    await abaPatrimonio(page, "Inventário");
    t("tudo-off: Adicionar desabilitado", await page.getByRole("button", { name: "Adicionar", exact: true }).isDisabled());
    t("tudo-off: Comprar… ausente", (await contar(page, "Comprar…")) === 0);
    t("tudo-off: Vender ausente", (await contar(page, "Vender")) === 0);
    t("tudo-off: Estornar compra ausente", (await contar(page, "Estornar compra")) === 0);
    t("tudo-off: Transferir item ausente", (await contar(page, "Transferir")) === 0);
    t("tudo-off: remover item (×) ausente", (await page.locator("button.perigo", { hasText: "×" }).count()) === 0);
    t("tudo-off: Equipar ausente", (await contar(page, "Equipar")) === 0);

    await abaPatrimonio(page, "Equipamentos");
    t("tudo-off: form equipamento ausente", (await page.locator("input[placeholder='Nome do equipamento']").count()) === 0);
    t("tudo-off: Equipar/Desequipar ausente", (await contar(page, "Equipar")) === 0 && (await contar(page, "Desequipar")) === 0);

    await abaPatrimonio(page, "Veículos");
    t("tudo-off: form veículo ausente", (await page.locator("form", { hasText: "Adicionar veículo" }).count()) === 0);
    t("tudo-off: remover veículo ausente", (await page.locator("button.perigo").count()) === 0);

    await abaPatrimonio(page, "Dinheiro");
    t("tudo-off: Nova conta ausente", (await contar(page, "Nova conta")) === 0);
    t("tudo-off: Registrar movimentação ausente", (await page.locator("button", { hasText: "Registrar" }).count()) === 0);
    t("tudo-off: Transferir (PIX) ausente", (await contar(page, "Transferir (PIX fictício)")) === 0);
    t("tudo-off: Estornar operação ausente", (await contar(page, "Estornar")) === 0 && (await contar(page, "Estornar operação")) === 0);
    await shot(page, "jogador-tudo-off");
    await ctx.close();
  }

  // Flags individuais — cada ação aparece somente com a permissão certa.
  const cenarioFlags = async (flags, checks) => {
    definirCfg(flags);
    const { ctx, page } = await sessao("jogador", { width: 1366, height: 900 });
    await irCampanha(page);
    await abrirPersonagem(page, "PJ Um");
    for (const [aba, fn] of checks) { await abaPatrimonio(page, aba); await fn(page); }
    await ctx.close();
  };

  sec("3. adicionaItens=on, demais off — só adicionar/liberar quantidade");
  await cenarioFlags({ ...NENHUMA, adicionaItens: true }, [
    ["Inventário", async (page) => {
      t("add-only: Adicionar habilitado", !(await page.getByRole("button", { name: "Adicionar", exact: true }).isDisabled()));
      t("add-only: Vender ausente", (await contar(page, "Vender")) === 0);
      t("add-only: × remover ausente", (await page.locator("button.perigo", { hasText: "×" }).count()) === 0);
      t("add-only: Transferir ausente", (await contar(page, "Transferir")) === 0);
    }],
  ]);

  sec("4. removeItens=on, adicionaItens=off — remover/transferir sim, adicionar não");
  await cenarioFlags({ ...NENHUMA, removeItens: true }, [
    ["Inventário", async (page) => {
      t("rem-only: Adicionar desabilitado", await page.getByRole("button", { name: "Adicionar", exact: true }).isDisabled());
      t("rem-only: × remover presente", (await page.locator("button.perigo", { hasText: "×" }).count()) > 0);
      t("rem-only: Vender ausente", (await contar(page, "Vender")) === 0);
      // Transferir existe (removeItens), mas só destinos do próprio usuário
      // (PJ Um B, ehEu) — PJ Dois é de outro jogador e exige adicionaItens.
      t("rem-only: Transferir presente", (await contar(page, "Transferir")) > 0);
      await page.getByRole("button", { name: "Transferir", exact: true }).first().click();
      await page.waitForTimeout(400);
      const opcoes = await page.locator(".modal select option").allTextContents();
      t("rem-only: destino próprio listado", opcoes.some((o) => o.includes("PJ Um B")), opcoes.join("|"));
      t("rem-only: destino de outro jogador oculto", !opcoes.some((o) => o.includes("PJ Dois")), opcoes.join("|"));
      await page.keyboard.press("Escape");
      await page.locator(".modal-fundo").click({ position: { x: 5, y: 5 } }).catch(() => {});
    }],
    ["Veículos", async (page) => {
      t("rem-only: remover veículo presente", (await page.locator("button.perigo").count()) > 0);
      t("rem-only: form veículo ausente", (await page.locator("form", { hasText: "Adicionar veículo" }).count()) === 0);
    }],
  ]);

  sec("5. editaEquipamentos=on — form e ações de equipamento");
  await cenarioFlags({ ...NENHUMA, editaEquipamentos: true }, [
    ["Equipamentos", async (page) => {
      t("eq-on: form equipamento presente", (await page.locator("input[placeholder='Nome do equipamento']").count()) === 1);
      t("eq-on: Desequipar presente", (await contar(page, "Desequipar")) > 0);
    }],
    ["Inventário", async (page) => {
      t("eq-on: Equipar item presente", (await contar(page, "Equipar")) > 0);
      t("eq-on: Adicionar desabilitado", await page.getByRole("button", { name: "Adicionar", exact: true }).isDisabled());
    }],
  ]);

  sec("6. editaVeiculos=on — form de veículo, sem remoção");
  await cenarioFlags({ ...NENHUMA, editaVeiculos: true }, [
    ["Veículos", async (page) => {
      t("veic-on: form veículo presente", (await page.locator("form", { hasText: "Adicionar veículo" }).count()) === 1);
      t("veic-on: remover veículo ausente", (await page.locator("button.perigo").count()) === 0);
    }],
  ]);

  sec("7. criaContas=on sem compraVenda — conta sem saldo/limite");
  await cenarioFlags({ ...NENHUMA, criaContas: true }, [
    ["Dinheiro", async (page) => {
      t("conta-on: Nova conta presente", (await contar(page, "Nova conta")) === 1);
      await page.getByRole("button", { name: "Nova conta" }).click();
      await page.waitForTimeout(400);
      t("conta-on: Saldo inicial oculto sem compraVenda", (await page.getByPlaceholder("Saldo inicial").count()) === 0);
      t("conta-on: Movimentar ausente", (await page.locator("button", { hasText: "Registrar" }).count()) === 0);
      t("conta-on: PIX ausente", (await contar(page, "Transferir (PIX fictício)")) === 0);
      await shot(page, "jogador-cria-conta-sem-compra");
    }],
  ]);

  sec("8. compraVenda=on sem pix — operar sim, PIX não");
  await cenarioFlags({ ...NENHUMA, compraVenda: true }, [
    ["Inventário", async (page) => {
      t("cv-on: Comprar… presente", (await contar(page, "Comprar…")) === 1);
      t("cv-on: Vender presente", (await contar(page, "Vender")) > 0);
      t("cv-on: Estornar compra presente", (await contar(page, "Estornar compra")) > 0);
    }],
    ["Dinheiro", async (page) => {
      t("cv-on: Registrar presente", (await page.locator("button", { hasText: "Registrar" }).count()) === 1);
      t("cv-on: Transferir presente", (await contar(page, "Transferir (PIX fictício)")) === 1);
      await page.getByRole("button", { name: "Transferir (PIX fictício)" }).click();
      await page.waitForTimeout(400);
      t("cv-on: optgroup Minhas contas presente", (await page.locator("optgroup[label='Minhas contas']").count()) === 1);
      t("cv-on: optgroup Outros personagens ausente", (await page.locator("optgroup[label='Outros personagens']").count()) === 0);
      t("cv-on: Estornar presente", (await contar(page, "Estornar") + await contar(page, "Estornar operação")) > 0);
    }],
  ]);

  sec("9. pix=on sem compraVenda — PIX sim, operar não");
  await cenarioFlags({ ...NENHUMA, pix: true }, [
    ["Dinheiro", async (page) => {
      t("pix-on: Transferir presente", (await contar(page, "Transferir (PIX fictício)")) === 1);
      await page.getByRole("button", { name: "Transferir (PIX fictício)" }).click();
      await page.waitForTimeout(400);
      t("pix-on: optgroup Outros personagens presente", (await page.locator("optgroup[label='Outros personagens']").count()) === 1);
      t("pix-on: optgroup Minhas contas ausente", (await page.locator("optgroup[label='Minhas contas']").count()) === 0);
      t("pix-on: Registrar ausente", (await page.locator("button", { hasText: "Registrar" }).count()) === 0);
      t("pix-on: Estornar ausente", (await contar(page, "Estornar") + await contar(page, "Estornar operação")) === 0);
    }],
    ["Inventário", async (page) => {
      t("pix-on: Comprar… ausente", (await contar(page, "Comprar…")) === 0);
      t("pix-on: Vender ausente", (await contar(page, "Vender")) === 0);
    }],
  ]);

  sec("10. Fail-closed: ações não aparecem antes das regras carregarem");
  {
    definirCfg(TODAS);
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, storageState: stateJ1 });
    const page = await ctx.newPage();
    // Atrasa a resposta de GET /regras: durante a janela, o jogador não
    // pode ver nenhuma ação granular (permissoes === null).
    let liberar;
    const trava = new Promise((r) => { liberar = r; });
    await page.route("**/api/campaigns/*/regras", async (route) => {
      await trava;
      await route.continue();
    });
    await page.goto(BASE);
    await page.getByText("Servidor online").waitFor({ timeout: 15000 });
    await irCampanha(page);
    await abrirPersonagem(page, "PJ Um");
    await abaPatrimonio(page, "Inventário");
    // Enquanto /regras está pendente: nenhuma ação granular visível.
    t("loading: Comprar… ausente", (await contar(page, "Comprar…")) === 0);
    t("loading: Vender ausente", (await contar(page, "Vender")) === 0);
    t("loading: × remover ausente", (await page.locator("button.perigo", { hasText: "×" }).count()) === 0);
    t("loading: Transferir ausente", (await contar(page, "Transferir")) === 0);
    liberar();
    await page.waitForTimeout(1200);
    t("após regras: ações aparecem (todas on)", (await contar(page, "Vender")) > 0 && (await contar(page, "Comprar…")) === 1);
    await ctx.close();
  }

  sec("11. Backend continua fonte de verdade — 403 mesmo se a UI falhar");
  {
    definirCfg(NENHUMA);
    const r1 = await req(BASE, "POST", `/characters/${PJ1}/inventario`, { cookie: J1, body: { name: "Item bloqueado", quantity: 1 } });
    t("backend: addItem tudo-off → 403", r1.status === 403, r1.status);
    const r2 = await req(BASE, "DELETE", `/characters/${PJ1}/inventario/${itemId}`, { cookie: J1 });
    t("backend: delItem tudo-off → 403", r2.status === 403, r2.status);
    const r3 = await req(BASE, "POST", `/characters/${PJ1}/financeiro/operacao`, { cookie: J1, body: { tipo: "compra", accountId: contaId, valor: 5, descricao: "x", item: { name: "x", quantity: 1 }, requestId: crypto.randomUUID() } });
    t("backend: compra tudo-off → 403", r3.status === 403, r3.status);
    definirCfg(TODAS);
    const r4 = await req(BASE, "POST", `/characters/${PJ1}/inventario`, { cookie: J1, body: { name: "Item permitido", quantity: 1 } });
    t("backend: addItem tudo-on → 201", r4.status === 201, r4.status);
  }

  // ================================================================
  // FASE 12 — Mobile (390px): mesmas regras visuais
  // ================================================================
  sec("12. Mobile — matriz resumida");
  {
    definirCfg(NENHUMA);
    let { ctx, page } = await sessao("jogador", { width: 390, height: 844 });
    await irCampanha(page);
    await abrirPersonagem(page, "PJ Um");
    await abaPatrimonio(page, "Inventário");
    t("mobile tudo-off: Vender ausente", (await contar(page, "Vender")) === 0);
    t("mobile tudo-off: × ausente", (await page.locator("button.perigo", { hasText: "×" }).count()) === 0);
    await abaPatrimonio(page, "Dinheiro");
    t("mobile tudo-off: Nova conta ausente", (await contar(page, "Nova conta")) === 0);
    await shot(page, "mobile-tudo-off");
    await ctx.close();

    definirCfg(TODAS);
    ({ ctx, page } = await sessao("jogador", { width: 390, height: 844 }));
    await irCampanha(page);
    await abrirPersonagem(page, "PJ Um");
    await abaPatrimonio(page, "Inventário");
    t("mobile tudo-on: Vender presente", (await contar(page, "Vender")) > 0);
    t("mobile tudo-on: × presente", (await page.locator("button.perigo", { hasText: "×" }).count()) > 0);
    await abaPatrimonio(page, "Dinheiro");
    t("mobile tudo-on: Nova conta presente", (await contar(page, "Nova conta")) === 1);
    t("mobile tudo-on: Transferir PIX presente", (await contar(page, "Transferir (PIX fictício)")) === 1);
    await shot(page, "mobile-tudo-on");
    await ctx.close();
  }

  // Mestre mantém acesso administrativo com tudo desligado.
  sec("13. Mestre com tudo desligado — ações administrativas preservadas");
  {
    definirCfg(NENHUMA);
    const { ctx, page } = await sessao("mestre", { width: 1366, height: 900 });
    await irCampanha(page);
    await abrirPersonagem(page, "PJ Um");
    await abaPatrimonio(page, "Inventário");
    t("mestre tudo-off: Adicionar habilitado", !(await page.getByRole("button", { name: "Adicionar", exact: true }).isDisabled()));
    t("mestre tudo-off: Vender presente", (await contar(page, "Vender")) > 0);
    await abaPatrimonio(page, "Dinheiro");
    t("mestre tudo-off: Nova conta presente", (await contar(page, "Nova conta")) === 1);
    t("mestre tudo-off: Registrar presente", (await page.locator("button", { hasText: "Registrar" }).count()) === 1);
    await ctx.close();
  }

  // ================================================================
  // FASE 14 — Atualização ao vivo: regras:atualizadas sem reload (P2)
  // O jogador permanece com o Patrimônio aberto enquanto o mestre
  // altera permissões pelo painel de Regras. Revogação E concessão
  // devem refletir na UI sem recarregar a página.
  // ================================================================
  sec("14. Atualização ao vivo — revogação e concessão sem reload");
  {
    definirCfg(TODAS);
    const { ctx, page } = await sessao("jogador", { width: 1366, height: 900 });
    await irCampanha(page);
    await abrirPersonagem(page, "PJ Um");
    await abaPatrimonio(page, "Inventário");
    t("ao-vivo: Vender presente (tudo on)", (await contar(page, "Vender")) > 0);

    const m = await sessao("mestre", { width: 1366, height: 900 });
    await irCampanha(m.page);
    await m.page.locator(".abas button", { hasText: "Regras" }).first().click();
    await m.page.locator(".abas button", { hasText: "Pontuação" }).first().click();
    await m.page.waitForTimeout(800);
    const chk = (rotulo) => m.page.locator("label.checkbox", { hasText: rotulo }).locator("input[type=checkbox]");

    // REVOGAÇÃO: desliga compraVenda pelo painel real do mestre
    await chk("Jogador registra compra e venda").uncheck();
    await m.page.getByRole("button", { name: "Salvar configuração" }).click();
    await page.waitForFunction(() =>
      ![...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Vender"),
      null, { timeout: 12000 }).catch(() => {});
    t("ao-vivo: revogação — Vender some sem reload", (await contar(page, "Vender")) === 0);
    t("ao-vivo: revogação — Comprar… some sem reload", (await contar(page, "Comprar…")) === 0);
    t("ao-vivo: revogação — Estornar some sem reload", (await contar(page, "Estornar compra")) === 0);

    // CONCESSÃO: religa pelo mesmo painel
    await chk("Jogador registra compra e venda").check();
    await m.page.getByRole("button", { name: "Salvar configuração" }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Vender"),
      null, { timeout: 12000 }).catch(() => {});
    t("ao-vivo: concessão — Vender volta sem reload", (await contar(page, "Vender")) > 0);
    t("ao-vivo: concessão — Comprar… volta sem reload", (await contar(page, "Comprar…")) === 1);
    await shot(page, "ao-vivo-apos-concessao");

    // Troca de aba e volta: permissões continuam corretas (estado novo)
    await abaPatrimonio(page, "Dinheiro");
    t("ao-vivo: concessão — Registrar presente no Dinheiro", (await page.locator("button", { hasText: "Registrar" }).count()) === 1);
    await ctx.close();
    await m.ctx.close();
  }

  definirCfg(TODAS);
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e?.stack ?? e).slice(0, 800));
} finally {
  await browser?.close().catch(() => {});
  await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n==== patrimonio-permissoes-ui: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
