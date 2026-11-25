// Internet + comércio 1.1.0 — E2E browser dedicado (gate de aceite #327).
// Três contextos Playwright reais sobre o stack completo (backend #328/#329
// + UI #327): prova as jornadas que a suíte API não cobre — entrada/gate,
// vitrine, gestão mestre/gestor, oferta inativa→ativação, compra LOJA-A,
// venda LOJA-B, recibos/histórico, módulo físico e navegação mobile.
// Requer o backend de comércio (rotas /comercio/*) — executar contra a
// stack integrada; em main sem o backend a suíte não se aplica.
import crypto from "node:crypto";
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("internet-e2e");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

let browser, proc;
const errosConsole = [];
function vigiar(page, tag) {
  page.on("pageerror", (e) => errosConsole.push(`${tag}:pageerror:${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/401|Failed to load resource/.test(txt)) return;
    errosConsole.push(`${tag}:console:${txt.slice(0, 160)}`);
  });
}
async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irPersonagens(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("Campanha Teste", { exact: true }).first().click();
  await page.locator(".abas button", { hasText: "Personagens" }).first().click();
}
async function abrirPersonagem(page, nome) {
  const linha = page.locator("tr.clicavel", { hasText: nome });
  await linha.first().waitFor({ timeout: 15000 });
  await linha.first().click();
  await page.getByRole("button", { name: "Voltar" }).first().waitFor({ timeout: 15000 });
}
async function abrirModulo(page, nome) {
  await page.getByRole("group", { name: "Módulos do personagem" })
    .getByRole("button", { name: nome, exact: true }).click();
}
async function abaInternet(page, nome) {
  await page.locator("section[aria-label='Internet'] .abas button", { hasText: nome }).click();
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "jogador_um", jogador2: "jogador_dois" } });
  const mestre = c.cookieMestre, campId = c.campId;
  const j1 = c.jogadores.jogador1, j2 = c.jogadores.jogador2;

  // ---- Fixture do gate (mesmo padrão de teste-comercio-lojas.mjs) ----
  {
    const db = abrirDb(BANCO);
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
    const agora = Date.now();
    const ins = db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?, '{}',?,?)");
    for (const [kind, key, name] of [
      ["pericia", "computador", "Computador"],
      ["conhecimento", "tecnologia", "Tecnologia"],
      ["item", "notebook", "Notebook"],
      ["item", "celular_descartavel", "Celular descartável"],
    ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    est.secoes[0].campos.push(
      { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
      { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
    );
    db.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), ver.id);
    db.close();
  }

  // Personagens: j1 elegível (perícia+notebook+item vendável); mestre
  // elegível para a gestão master; j2 com os dois motivos de negação
  // isolados para provar a mensagem da UI.
  const charOk = c.novoPersonagem(j1.membershipId, "Conectado E2E", { comp: 1 });
  const charMestre = c.novoPersonagem(c.membMestre, "Mestre Conectado", { comp: 1 });
  const charSemPericia = c.novoPersonagem(j2.membershipId, "Sem Pericia E2E", { for: 5 });
  const charSemDevice = c.novoPersonagem(j2.membershipId, "Sem Device E2E", { comp: 2 });
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    const insItem = db.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const characterId of [charOk, charMestre, charSemPericia]) {
      insItem.run(crypto.randomUUID(), characterId, "Notebook", 1, null, "equipamento", "mochila", "novo", 1.5,
        JSON.stringify({ regra: { kind: "item", key: "notebook" } }), agora, agora);
    }
    // Item vendável LOJA-B: aquisicao.unitCents é o preço autoritativo.
    insItem.run(crypto.randomUUID(), charOk, "Espada de Treino", 2, null, "arma", "mochila", "usado", 1.2,
      JSON.stringify({ aquisicao: { unitCents: 800, qtdOriginal: 2, origem: "fixture" } }), agora, agora);
    db.close();
  }

  // ---- Fixture comercial via API (o que a UI não cria sozinha) ----
  const lojaApi = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja E2E", category: "mercadoria", location: "Centro" },
  });
  const shopId = lojaApi.json?.id;
  t("loja fixture criada via API", lojaApi.status === 201 && !!shopId, JSON.stringify(lojaApi.json).slice(0, 200));

  const gestor = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/gestores`, {
    cookie: mestre, body: { membershipId: j1.membershipId, role: "gestor" },
  });
  t("j1 vinculado gestor via API", gestor.status === 201, String(gestor.status));

  const caixa = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Caixa da Loja", balanceReais: 500, papel: "caixa" },
  });
  t("caixa da loja criado", caixa.status === 201 && !!caixa.json?.id, JSON.stringify(caixa.json).slice(0, 200));

  const ofertaAtiva = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas`, {
    cookie: j1.cookie, body: { name: "Poção de Cura", priceCents: 1500, stockQty: 5, description: "Cura 1d6" },
  });
  const offerAtivaId = ofertaAtiva.json?.id;
  t("oferta ativa criada", ofertaAtiva.status === 201 && !!offerAtivaId, JSON.stringify(ofertaAtiva.json).slice(0, 200));

  const ofertaInativa = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas`, {
    cookie: j1.cookie, body: { name: "Relíquia Antiga", priceCents: 900, stockQty: 1 },
  });
  const offerInativaId = ofertaInativa.json?.id;
  const desativar = await req(BASE, "PATCH", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas/${offerInativaId}`, {
    cookie: j1.cookie, body: { isActive: false },
  });
  t("oferta inativa fixture pronta", ofertaInativa.status === 201 && desativar.status === 200, JSON.stringify(desativar.json).slice(0, 160));

  const contaJ1 = await req(BASE, "POST", `/characters/${charOk}/financeiro/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Bolso", balanceReais: 200 },
  });
  const contaJ1Id = contaJ1.json?.id;
  t("conta do comprador criada", !!contaJ1Id, JSON.stringify(contaJ1.json).slice(0, 160));

  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ctxJ1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ctxJ2 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ctxMovel = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgM = await ctxM.newPage(), pgJ1 = await ctxJ1.newPage(), pgJ2 = await ctxJ2.newPage(), pgMov = await ctxMovel.newPage();
  for (const [p, tag] of [[pgM, "mestre"], [pgJ1, "j1"], [pgJ2, "j2"], [pgMov, "movel"]]) vigiar(p, tag);

  sec("Gate de entrada — negação com motivo real");
  await login(pgJ2, "jogador_dois", "senha-jogador-123");
  await irPersonagens(pgJ2);
  await abrirPersonagem(pgJ2, "Sem Pericia E2E");
  await abrirModulo(pgJ2, "Internet");
  await page_await(pgJ2, "Acesso à Internet não liberado");
  t("gate negado visível (sem perícia)", await pgJ2.getByText("Conhecimento insuficiente").count() > 0);
  // Voltar ao listado: escopo na seção do detalhe (h2 do personagem) —
  // a página tem outros botões "Voltar" em módulos/checkout.
  await pgJ2.locator("section.cartao", { has: pgJ2.getByRole("heading", { name: "Sem Pericia E2E" }) })
    .getByRole("button", { name: "Voltar" }).click();
  await abrirPersonagem(pgJ2, "Sem Device E2E");
  await abrirModulo(pgJ2, "Internet");
  await page_await(pgJ2, "Acesso à Internet não liberado");
  t("gate negado visível (sem dispositivo)", await pgJ2.getByText("Nenhum dispositivo compatível").count() > 0);

  sec("Gestão mestre — criação de loja pela UI");
  await login(pgM, "mestre_teste", "senha-forte-123");
  await irPersonagens(pgM);
  await abrirPersonagem(pgM, "Mestre Conectado");
  await abrirModulo(pgM, "Internet");
  await page_await(pgM, "Loja E2E");
  t("mestre elegível vê Administração do comércio", await pgM.getByText("Administração do comércio").count() > 0);
  t("mestre vê Gerenciar loja na loja existente", await pgM.getByRole("button", { name: "Gerenciar loja" }).count() > 0);
  // Cria uma segunda loja inteiramente pela UI (prova do formulário mestre).
  await pgM.getByRole("button", { name: "Criar loja" }).click();
  await pgM.getByLabel("Nome da loja").fill("Loja do Zé");
  await pgM.getByLabel("Localização").fill("Bairro Norte");
  await pgM.getByRole("button", { name: "Criar loja" }).last().click();
  await page_await(pgM, "Loja do Zé");
  t("loja criada pela UI aparece na lista", await pgM.getByText("Loja do Zé").count() > 0);

  sec("Gestor — vitrine sem oferta inativa + gestão com revenda pendente");
  await login(pgJ1, "jogador_um", "senha-jogador-123");
  await irPersonagens(pgJ1);
  await abrirPersonagem(pgJ1, "Conectado E2E");
  await abrirModulo(pgJ1, "Internet");
  await page_await(pgJ1, "Loja E2E");
  t("j1 vê a loja na lista", await pgJ1.getByText("Loja E2E").count() > 0);
  t("j1 (gestor) vê botão Gerenciar loja", await pgJ1.getByRole("button", { name: "Gerenciar loja" }).count() > 0);

  // vitrine do comprador: só oferta ativa (escopo no card "Loja E2E" —
  // o mestre criou "Loja do Zé" antes, logo há 2 "Ver vitrine").
  const cardLojaE2E = pgJ1.locator(".cartao.cartao-campanha", { hasText: "Loja E2E" });
  await cardLojaE2E.getByRole("button", { name: "Ver vitrine" }).click();
  await page_await(pgJ1, "Poção de Cura");
  t("vitrine mostra oferta ativa", await pgJ1.getByText("Poção de Cura").count() > 0);
  t("vitrine NÃO mostra oferta inativa", await pgJ1.getByText("Relíquia Antiga").count() === 0);

  // gestão: revenda pendente → preço + publicar.
  // O card da oferta inativa é identificado pelo selo "Revenda pendente
  // de revisão" (o nome fica em input value, não em texto visível).
  await pgJ1.getByRole("button", { name: "Voltar às lojas" }).click();
  await pgJ1.getByRole("button", { name: "Gerenciar loja" }).click();
  await page_await(pgJ1, "Gerenciar: Loja E2E");
  const cartaoRevenda = pgJ1.locator(".cartao.cartao-campanha", { hasText: "Revenda pendente de revisão" }).last();
  await cartaoRevenda.waitFor({ timeout: 10000 });
  t("gestão mostra revenda pendente de revisão", true);
  await cartaoRevenda.getByLabel("Publicada").check();
  await cartaoRevenda.getByLabel(/Preço/).fill("12.50");
  await cartaoRevenda.getByRole("button", { name: "Salvar oferta" }).click();
  // Após salvar, a revenda vira "Oferta publicada" — Poção já era, então
  // o total de cards publicados passa de 1 para 2 (locator some do card
  // revenda quando o selo muda; conta absoluta é o sinal estável).
  await pgJ1.waitForFunction(
    () => [...document.querySelectorAll(".cartao.cartao-campanha")]
      .filter((el) => el.textContent?.includes("Oferta publicada")).length >= 2,
    null, { timeout: 15000 },
  );
  t("oferta ativada com novo preço na gestão", true);
  await pgJ1.getByRole("button", { name: "Voltar às lojas" }).click();

  sec("LOJA-A — compra pela UI");
  await cardLojaE2E.getByRole("button", { name: "Ver vitrine" }).click();
  await page_await(pgJ1, "Relíquia Antiga");
  t("oferta recém-ativada aparece na vitrine", await pgJ1.getByText("Relíquia Antiga").count() > 0);
  await pgJ1.locator(".cartao", { hasText: "Poção de Cura" }).getByRole("button", { name: "Comprar" }).first().click();
  await page_await(pgJ1, "Comprar: Poção de Cura");
  await pgJ1.getByLabel("Conta de pagamento").selectOption(contaJ1Id);
  await pgJ1.getByRole("button", { name: /Finalizar — R\$ 15,00/ }).click();
  await pgJ1.locator("[role='dialog'][aria-label='Recibo da operação']").waitFor({ timeout: 15000 });
  t("recibo de compra exibido", await pgJ1.getByText("Recibo — Compra").count() > 0);
  await pgJ1.getByRole("button", { name: "Fechar recibo" }).click();
  await abaInternet(pgJ1, "Histórico");
  await page_await(pgJ1, "Poção de Cura");
  t("histórico mostra compra", await pgJ1.locator(".badge", { hasText: "Compra" }).count() > 0);

  sec("LOJA-B — venda pela UI (aba Vender)");
  await abaInternet(pgJ1, "Vender");
  await page_await(pgJ1, "Espada de Treino");
  // Escopo na seção do módulo Internet (tem o tablist) — o personagem
  // renderiza outros módulos com linhas do mesmo item.
  const secaoInternet = pgJ1.locator("section.cartao", { has: pgJ1.getByRole("tab", { name: "Vender" }) });
  const linhaEspada = secaoInternet.locator("tr", { hasText: "Espada de Treino" });
  await linhaEspada.getByRole("button", { name: "Vender", exact: true }).click();
  await pgJ1.locator("section[aria-label='Venda para loja']").waitFor({ timeout: 10000 });
  t("confirmação LOJA-B com valor autoritativo", await pgJ1.getByText(/A loja oferece/).count() > 0);
  await pgJ1.getByRole("button", { name: /Confirmar venda — R\$ 8,00/ }).click();
  await pgJ1.locator("[role='dialog'][aria-label='Recibo da operação']").waitFor({ timeout: 15000 });
  t("recibo de venda exibido", await pgJ1.getByText("Recibo — Venda para loja").count() > 0);
  await pgJ1.getByRole("button", { name: "Fechar recibo" }).click();
  await abaInternet(pgJ1, "Histórico");
  await page_await(pgJ1, "Venda p/ loja");
  t("histórico distingue venda de compra", await pgJ1.locator(".badge", { hasText: "Venda p/ loja" }).count() > 0);

  sec("Equipamento/Armazém — consulta física + atalho de venda");
  await abrirModulo(pgJ1, "Equipamento/Armazém");
  await pgJ1.locator("section[aria-label='Equipamento e Armazém'] table").waitFor({ timeout: 15000 });
  t("inventário lista Notebook", await pgJ1.locator("td", { hasText: "Notebook" }).count() > 0);
  const secaoArmazem = pgJ1.locator("section[aria-label='Equipamento e Armazém']");
  const linhaNB = secaoArmazem.locator("tr", { hasText: "Notebook" });
  t("item sem valor tem Vender desabilitado", await linhaNB.getByRole("button", { name: "Vender na Internet" }).isDisabled());
  const linhaEspadaArmazem = secaoArmazem.locator("tr", { hasText: "Espada de Treino" });
  t("item vendável tem atalho habilitado", await linhaEspadaArmazem.getByRole("button", { name: "Vender na Internet" }).isEnabled());
  await linhaEspadaArmazem.getByRole("button", { name: "Vender na Internet" }).click();
  await pgJ1.locator("section[aria-label='Venda para loja']").waitFor({ timeout: 10000 });
  t("atalho abre Internet aba Vender com item pré-selecionado",
    await pgJ1.locator("h4", { hasText: "Vender para loja: Espada de Treino" }).count() > 0);

  sec("Navegação mobile (390px)");
  await login(pgMov, "jogador_um", "senha-jogador-123");
  await irPersonagens(pgMov);
  await abrirPersonagem(pgMov, "Conectado E2E");
  const btnInternet = pgMov.getByRole("group", { name: "Módulos do personagem" }).getByRole("button", { name: "Internet", exact: true });
  await btnInternet.waitFor({ timeout: 10000 });
  t("botão Internet visível em viewport mobile", await btnInternet.isVisible());
  await btnInternet.click();
  await pgMov.locator("section[aria-label='Internet']").waitFor({ timeout: 10000 });
  t("módulo Internet renderiza em mobile", await pgMov.locator("section[aria-label='Internet']").count() > 0);

  sec("Saúde do console");
  const errosReais = errosConsole.filter((e) => !/favicon|net::|WebSocket/.test(e));
  t("sem erros de página/console relevantes", errosReais.length === 0, errosReais.slice(0, 5).join(" | "));
} catch (e) {
  fail++;
  console.log("FALHOU exceção fatal:", e?.message ?? e);
} finally {
  console.log(`\n${pass} ok, ${fail} falhas`);
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}
process.exit(fail ? 1 : 0);

// helper local para waitFor de texto (evita repetir locator)
async function page_await(page, texto, timeout = 15000) {
  await page.getByText(texto, { exact: false }).first().waitFor({ timeout });
}
