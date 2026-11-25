// Testes — comércio 1.1.0 (Issue #286): lojas, ofertas, checkout LOJA-A
// (compra) e LOJA-B (venda à loja), gate de Internet fail-closed, caixa do
// estabelecimento, idempotência requestId/fingerprint, gestão por gestor.
// Banco isolado + fixtures sintéticas (teste-base).
import { io as ioCliente } from "socket.io-client";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("comercio-lojas");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;
try {
  // MESTRE_PAUSA_FLAG/MESTRE_RESTORE_DELAY_MS: janelas determinísticas
  // de teste para a seção de barreira de restauração (L2) — inertes
  // enquanto o arquivo-flag não existir e nenhum restore for disparado.
  proc = subirServidor(porta, {
    banco: BANCO, arquivos: ARQ, backups: BKS,
    env: { MESTRE_PAUSA_FLAG: `${DIR}/pausa.flag`, MESTRE_RESTORE_DELAY_MS: "2000" },
  });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "jogador_um", jogador2: "jogador_dois" } });
  const mestre = cenario.cookieMestre;
  const campId = cenario.campId;
  const j1 = cenario.jogadores.jogador1;
  const j2 = cenario.jogadores.jogador2;

  // ---- Fixture do gate: estrutura da ficha com campo pericia + rule_definitions ----
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
    // estrutura: campo "comp" vinculado à pericia computador (modo nivel)
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    est.secoes[0].campos.push(
      { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
      { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
    );
    db.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), ver.id);
    db.close();
  }

  // Personagens: elegível (pericia+notebook), sem pericia, sem dispositivo
  const charOk = cenario.novoPersonagem(j1.membershipId, "Conectado", { comp: 1 });
  const charOkJ2 = cenario.novoPersonagem(j2.membershipId, "Conectado J2", { comp: 1 });
  const charSemPericia = cenario.novoPersonagem(j2.membershipId, "Sem Pericia", { for: 5 });
  const charSemDevice = cenario.novoPersonagem(j2.membershipId, "Sem Device", { comp: 2 });
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    const inserirNotebook = db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)");
    for (const characterId of [charOk, charOkJ2]) {
      inserirNotebook.run(crypto.randomUUID(), characterId, "Notebook", 1, JSON.stringify({ regra: { kind: "item", key: "notebook" } }), agora, agora);
    }
    db.close();
  }

  sec("gate de Internet");
  // conta + loja mínimas para chegar ao gate (gate roda antes da validação da loja)
  const rGate1 = await req(BASE, "POST", `/characters/${charSemPericia}/comercio/comprar`, {
    cookie: j2.cookie, body: { shopId: "x", accountId: "y", items: [{ offerId: "z", qty: 1 }], requestId: "req-gate-1" },
  });
  t("sem pericia → 403 internet_indisponivel", rGate1.status === 403 && rGate1.json?.erro === "internet_indisponivel", JSON.stringify(rGate1.json));
  const rGate2 = await req(BASE, "POST", `/characters/${charSemDevice}/comercio/comprar`, {
    cookie: j2.cookie, body: { shopId: "x", accountId: "y", items: [{ offerId: "z", qty: 1 }], requestId: "req-gate-2" },
  });
  t("sem dispositivo → 403 internet_indisponivel", rGate2.status === 403 && rGate2.json?.erro === "internet_indisponivel", JSON.stringify(rGate2.json));

  // endpoint de elegibilidade para a UI (mesmo veredito fail-closed)
  const eOk = await req(BASE, "GET", `/characters/${charOk}/comercio/elegibilidade`, { cookie: j1.cookie });
  t("elegibilidade charOk → true", eOk.status === 200 && eOk.json?.elegivel === true, JSON.stringify(eOk.json));
  const eSem = await req(BASE, "GET", `/characters/${charSemPericia}/comercio/elegibilidade`, { cookie: j2.cookie });
  t("elegibilidade sem pericia → false + motivo", eSem.status === 200 && eSem.json?.elegivel === false && eSem.json?.motivos?.includes("pericia_ou_conhecimento_insuficiente"), JSON.stringify(eSem.json));
  const eSemDev = await req(BASE, "GET", `/characters/${charSemDevice}/comercio/elegibilidade`, { cookie: j2.cookie });
  t("elegibilidade sem device → motivo dispositivo", eSemDev.json?.motivos?.includes("dispositivo_ausente"), JSON.stringify(eSemDev.json));

  sec("gestão da loja");
  const loja = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja do Zé", category: "mercadoria", location: "Centro" },
  });
  const shopId = loja.json?.id;
  t("mestre cria loja", loja.status === 201 && !!shopId, JSON.stringify(loja.json));

  // jogador comum não cria oferta (ainda não é gestor)
  const ofertaNegada = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas`, {
    cookie: j1.cookie, body: { name: "Espada", priceCents: 100 },
  });
  t("não-gestor não cria oferta → 403", ofertaNegada.status === 403, String(ofertaNegada.status));

  // mestre vincula j1 como gestor
  const gestor = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/gestores`, {
    cookie: mestre, body: { membershipId: j1.membershipId, role: "gestor" },
  });
  t("mestre vincula gestor", gestor.status === 201, JSON.stringify(gestor.json));

  // A vitrine informa a permissão calculada pelo servidor. Apenas o mestre
  // recebe o cadastro de gestores; outro jogador elegível vê false e nada privado.
  const vitrineMestre = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charOk}`, { cookie: mestre });
  const lojaMestre = vitrineMestre.json?.lojas?.find((l) => l.id === shopId);
  t("mestre recebe podeGerenciar e gestores", lojaMestre?.podeGerenciar === true && lojaMestre?.gestores?.some((g) => g.membershipId === j1.membershipId), JSON.stringify(lojaMestre));
  const vitrineGestor = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charOk}`, { cookie: j1.cookie });
  const lojaGestor = vitrineGestor.json?.lojas?.find((l) => l.id === shopId);
  t("gestor recebe podeGerenciar sem lista de gestores", lojaGestor?.podeGerenciar === true && lojaGestor?.gestores === undefined, JSON.stringify(lojaGestor));
  const vitrinePublica = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charOkJ2}`, { cookie: j2.cookie });
  const lojaPublica = vitrinePublica.json?.lojas?.find((l) => l.id === shopId);
  t("não-gestor não recebe permissão de gestão", lojaPublica?.podeGerenciar === false && lojaPublica?.gestores === undefined, JSON.stringify(lojaPublica));

  // gestor cria conta de caixa da loja (titular = estabelecimento)
  const contaCaixa = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Caixa da Loja", balanceReais: 1000, papel: "caixa" },
  });
  const caixaId = contaCaixa.json?.id;
  t("gestor cria caixa da loja", contaCaixa.status === 201 && !!caixaId, JSON.stringify(contaCaixa.json));
  const caixaDb = comDb(BANCO, (db) => db.prepare("select character_id, shop_id, balance_cents from financial_accounts where id=?").get(caixaId));
  t("caixa tem shop_id e character_id NULL", caixaDb?.shop_id === shopId && caixaDb?.character_id === null, JSON.stringify(caixaDb));

  // gestor cria oferta
  const oferta = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas`, {
    cookie: j1.cookie, body: { name: "Espada Curta", priceCents: 2500, stockQty: 2, description: "1d6" },
  });
  const offerId = oferta.json?.id;
  t("gestor cria oferta", oferta.status === 201 && !!offerId, JSON.stringify(oferta.json));

  sec("LOJA-A — compra");
  // conta do comprador (personagem)
  const contaComprador = await req(BASE, "POST", `/characters/${charOk}/financeiro/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Bolso", balanceReais: 100 },
  });
  const contaId = contaComprador.json?.id;
  t("comprador tem conta", !!contaId, JSON.stringify(contaComprador.json));
  
  sec("isolamento de templates entre campanhas");
  const outraCampanha = await req(BASE, "POST", "/campaigns", {
    cookie: mestre, body: { name: "Campanha Externa Comércio" },
  });
  const outraCampId = comDb(BANCO, (db) => db.prepare(
    "select id from campaigns where name=? order by created_at desc limit 1",
  ).get("Campanha Externa Comércio")?.id);
  t("fixture de campanha externa criada", (outraCampanha.status === 201 || outraCampanha.status === 200) && !!outraCampId, JSON.stringify(outraCampanha.json));
  const tplExternoId = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into item_templates (id,campaign_id,name,category,data,is_active,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
      .run(tplExternoId, outraCampId, "Template Privado Externo", "segredo", JSON.stringify({ dadoPrivado: "NAO_DEVE_VAZAR" }), 1, agora, agora);
    db.close();
  }
  const ofertaIsolada = await req(BASE, "POST", "/campaigns/" + campId + "/comercio/lojas/" + shopId + "/ofertas", {
    cookie: j1.cookie, body: { name: "Oferta Isolada", priceCents: 100, stockQty: 1 },
  });
  const ofertaIsoladaId = ofertaIsolada.json?.id;
  t("oferta de isolamento criada", ofertaIsolada.status === 201 && !!ofertaIsoladaId, JSON.stringify(ofertaIsolada.json));
  const patchTemplateExterno = await req(BASE, "PATCH", "/campaigns/" + campId + "/comercio/lojas/" + shopId + "/ofertas/" + ofertaIsoladaId, {
    cookie: j1.cookie, body: { itemTemplateId: tplExternoId },
  });
  t("PATCH recusa template de outra campanha", patchTemplateExterno.status === 400, JSON.stringify(patchTemplateExterno.json));
  const templatePersistido = comDb(BANCO, (db) => db.prepare("select item_template_id from shop_offers where id=?").get(ofertaIsoladaId)?.item_template_id);
  t("PATCH não persiste referência cruzada", templatePersistido === null, String(templatePersistido));

  // Simula registro legado/inconsistente para provar que o checkout também
  // falha fechado, sem importar dados de template de outra campanha.
  {
    const db = abrirDb(BANCO);
    db.prepare("update shop_offers set item_template_id=? where id=?").run(tplExternoId, ofertaIsoladaId);
    db.close();
  }
  const antesCross = comDb(BANCO, (db) => ({
    saldo: db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents,
    caixa: db.prepare("select balance_cents from financial_accounts where id=?").get(caixaId)?.balance_cents,
    estoque: db.prepare("select stock_qty from shop_offers where id=?").get(ofertaIsoladaId)?.stock_qty,
    itens: db.prepare("select count(*) c from inventory_entries where character_id=? and name='Oferta Isolada'").get(charOk).c,
    ledger: db.prepare("select count(*) c from money_transactions where request_id like 'cross-campaign-template-001:%'").get().c,
    pedidos: db.prepare("select count(*) c from shop_orders where request_id='cross-campaign-template-001'").get().c,
  }));
  const compraTemplateExterno = await req(BASE, "POST", "/characters/" + charOk + "/comercio/comprar", {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId: ofertaIsoladaId, qty: 1 }], requestId: "cross-campaign-template-001" },
  });
  const depoisCross = comDb(BANCO, (db) => ({
    saldo: db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents,
    caixa: db.prepare("select balance_cents from financial_accounts where id=?").get(caixaId)?.balance_cents,
    estoque: db.prepare("select stock_qty from shop_offers where id=?").get(ofertaIsoladaId)?.stock_qty,
    itens: db.prepare("select count(*) c from inventory_entries where character_id=? and name='Oferta Isolada'").get(charOk).c,
    ledger: db.prepare("select count(*) c from money_transactions where request_id like 'cross-campaign-template-001:%'").get().c,
    pedidos: db.prepare("select count(*) c from shop_orders where request_id='cross-campaign-template-001'").get().c,
  }));
  t("checkout bloqueia template externo", compraTemplateExterno.status === 409 && compraTemplateExterno.json?.erro === "template_indisponivel", JSON.stringify(compraTemplateExterno.json));
  t("bloqueio não altera saldo/caixa/estoque/inventário/ledger/recibo", JSON.stringify(antesCross) === JSON.stringify(depoisCross), JSON.stringify({ antesCross, depoisCross }));
  
  // A origem também precisa ser validada: um inventory_entry legado/adulterado
  // não pode criar oferta LOJA-B vinculada ao template de outra campanha.
  const invTemplateExterno = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invTemplateExterno, charOk, "Item com Template Externo", 1,
        JSON.stringify({ templateId: tplExternoId, aquisicao: { unitCents: 500, qtdOriginal: 1 } }), agora, agora);
    db.close();
  }
  const antesVendaCross = comDb(BANCO, (db) => ({
    saldo: db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents,
    caixa: db.prepare("select balance_cents from financial_accounts where id=?").get(caixaId)?.balance_cents,
    item: db.prepare("select quantity from inventory_entries where id=?").get(invTemplateExterno)?.quantity,
    ofertas: db.prepare("select count(*) c from shop_offers where shop_id=? and item_template_id=?").get(shopId, tplExternoId).c,
    ledger: db.prepare("select count(*) c from money_transactions where request_id like 'cross-campaign-item-template-001:%'").get().c,
    pedidos: db.prepare("select count(*) c from shop_orders where request_id='cross-campaign-item-template-001'").get().c,
  }));
  const vendaTemplateExterno = await req(BASE, "POST", "/characters/" + charOk + "/comercio/vender", {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invTemplateExterno, qty: 1, accountId: contaId, expectedUnitCents: 500, requestId: "cross-campaign-item-template-001" },
  });
  const depoisVendaCross = comDb(BANCO, (db) => ({
    saldo: db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents,
    caixa: db.prepare("select balance_cents from financial_accounts where id=?").get(caixaId)?.balance_cents,
    item: db.prepare("select quantity from inventory_entries where id=?").get(invTemplateExterno)?.quantity,
    ofertas: db.prepare("select count(*) c from shop_offers where shop_id=? and item_template_id=?").get(shopId, tplExternoId).c,
    ledger: db.prepare("select count(*) c from money_transactions where request_id like 'cross-campaign-item-template-001:%'").get().c,
    pedidos: db.prepare("select count(*) c from shop_orders where request_id='cross-campaign-item-template-001'").get().c,
  }));
  t("LOJA-B bloqueia item com template de outra campanha", vendaTemplateExterno.status === 409 && vendaTemplateExterno.json?.erro === "template_indisponivel", JSON.stringify(vendaTemplateExterno.json));
  t("LOJA-B não altera saldo/caixa/inventário/estoque/ledger/recibo", JSON.stringify(antesVendaCross) === JSON.stringify(depoisVendaCross), JSON.stringify({ antesVendaCross, depoisVendaCross }));



  const compra = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId, qty: 1, expectedUnitCents: 2500 }], requestId: "compra-001" },
  });
  t("compra 201", compra.status === 201, JSON.stringify(compra.json));
  const orderId = compra.json?.id;

  const saldos = comDb(BANCO, (db) => ({
    comprador: db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents,
    caixa: db.prepare("select balance_cents from financial_accounts where id=?").get(caixaId)?.balance_cents,
    estoque: db.prepare("select stock_qty from shop_offers where id=?").get(offerId)?.stock_qty,
    itens: db.prepare("select count(*) c from inventory_entries where character_id=? and name='Espada Curta'").get(charOk).c,
    txs: db.prepare("select count(*) c from money_transactions where request_id like 'compra-001:%'").get().c,
  }));
  t("débito comprador 10000→7500", saldos.comprador === 7500, String(saldos.comprador));
  t("crédito caixa 100000→102500", saldos.caixa === 102500, String(saldos.caixa));
  t("estoque baixou 2→1", saldos.estoque === 1, String(saldos.estoque));
  t("item entregue no inventário", saldos.itens === 1, String(saldos.itens));
  t("2 money_transactions com shop_id", saldos.txs === 2, String(saldos.txs));

  // replay idempotente
  const replay = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId, qty: 1, expectedUnitCents: 2500 }], requestId: "compra-001" },
  });
  t("replay mesmo requestId → mesmo pedido", replay.status === 200 && replay.json?.id === orderId, JSON.stringify(replay.json));
  const saldoAposReplay = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
  t("replay não duplicou débito", saldoAposReplay === 7500, String(saldoAposReplay));

  // requestId divergente → 409
  const divergente = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId, qty: 2 }], requestId: "compra-001" },
  });
  t("requestId divergente → 409", divergente.status === 409 && divergente.json?.erro === "request_id_divergente", JSON.stringify(divergente.json));

  // preço divergente → 409 preco_divergente
  const preco = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId, qty: 1, expectedUnitCents: 9999 }], requestId: "compra-002" },
  });
  t("preço divergente → 409", preco.status === 409 && preco.json?.erro === "preco_divergente", JSON.stringify(preco.json));

  // estoque insuficiente: compra qty 5 com estoque 1 → 409 e rollback total
  const estq = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId, qty: 5 }], requestId: "compra-003" },
  });
  t("estoque insuficiente → 409", estq.status === 409, JSON.stringify(estq.json));
  const saldoAposEstq = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
  t("rollback: saldo intacto após falha", saldoAposEstq === 7500, String(saldoAposEstq));

  sec("LOJA-B — venda à loja");
  // item no inventário do charOk com valor de aquisição
  const invId = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invId, charOk, "Relíquia Antiga", 1, JSON.stringify({ aquisicao: { unitCents: 4000, qtdOriginal: 1 } }), agora, agora);
    db.close();
  }
  const venda = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invId, qty: 1, accountId: contaId, expectedUnitCents: 4000, requestId: "venda-001" },
  });
  t("venda 201", venda.status === 201, JSON.stringify(venda.json));
  const posVenda = comDb(BANCO, (db) => ({
    comprador: db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents,
    caixa: db.prepare("select balance_cents from financial_accounts where id=?").get(caixaId)?.balance_cents,
    item: db.prepare("select count(*) c from inventory_entries where id=?").get(invId).c,
  }));
  t("vendedor creditado 7500→11500", posVenda.comprador === 11500, String(posVenda.comprador));
  t("caixa debitado 102500→98500", posVenda.caixa === 98500, String(posVenda.caixa));
  t("item removido do inventário", posVenda.item === 0, String(posVenda.item));

  // A recompra sem oferta correspondente vira oferta inativa. O gestor precisa
  // vê-la para revisar preço/ativar; a vitrine pública não deve divulgá-la.
  const vitrineGestaoRevenda = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charOk}`, { cookie: j1.cookie });
  const revendaPendente = vitrineGestaoRevenda.json?.lojas?.find((l) => l.id === shopId)?.ofertas?.find((o) => o.name === "Relíquia Antiga" && o.isActive === false);
  t("gestor vê revenda pendente inativa", !!revendaPendente, JSON.stringify(revendaPendente));
  const vitrinePublicaRevenda = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charOkJ2}`, { cookie: j2.cookie });
  const revendaOculta = vitrinePublicaRevenda.json?.lojas?.find((l) => l.id === shopId)?.ofertas?.some((o) => o.name === "Relíquia Antiga");
  t("vitrine pública oculta revenda inativa", revendaOculta === false, String(revendaOculta));

  const replayVenda = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invId, qty: 1, accountId: contaId, requestId: "venda-001" },
  });
  t("replay venda → mesmo pedido", replayVenda.status === 200 && replayVenda.json?.id === venda.json?.id, JSON.stringify(replayVenda.json));

  sec("permissões e estado");
  // j2 (não gestor, não dono do charOk) não vende pelo charOk
  const negado = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j2.cookie,
    body: { shopId, inventoryEntryId: invId, qty: 1, accountId: "x", requestId: "venda-002" },
  });
  t("não-dono não opera personagem alheio → 403", negado.status === 403, String(negado.status));

  // fechar loja → compra bloqueada
  await req(BASE, "PATCH", `/campaigns/${campId}/comercio/lojas/${shopId}`, { cookie: mestre, body: { isOpen: false } });
  const fechada = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId, qty: 1 }], requestId: "compra-004" },
  });
  t("loja fechada → 409", fechada.status === 409 && fechada.json?.erro === "loja_fechada", JSON.stringify(fechada.json));

  // histórico do personagem
  const pedidos = await req(BASE, "GET", `/characters/${charOk}/comercio/pedidos`, { cookie: j1.cookie });
  t("histórico lista pedidos", pedidos.status === 200 && pedidos.json?.pedidos?.length >= 2, JSON.stringify(pedidos.json?.pedidos?.length));

  // caixa privado: j2 sem vínculo não vê contas da loja
  const contasNegado = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, { cookie: j2.cookie });
  t("não-gestor não vê caixa → 403", contasNegado.status === 403, String(contasNegado.status));
  const contasOk = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, { cookie: j1.cookie });
  t("gestor vê caixa", contasOk.status === 200 && contasOk.json?.contas?.length === 1, JSON.stringify(contasOk.json?.contas?.length));

  sec("correções de borda (revisão #329)");
  // reabre a loja para os testes de borda
  await req(BASE, "PATCH", `/campaigns/${campId}/comercio/lojas/${shopId}`, { cookie: mestre, body: { isOpen: true } });

  // 1. accountId no fingerprint: mesmo requestId + conta diferente → 409
  const conta2 = await req(BASE, "POST", `/characters/${charOk}/financeiro/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Cartão", balanceReais: 50 },
  });
  const conta2Id = conta2.json?.id;
  const divConta = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: conta2Id, items: [{ offerId, qty: 1 }], requestId: "compra-001" },
  });
  t("mesmo requestId + conta diferente → 409", divConta.status === 409 && divConta.json?.erro === "request_id_divergente", JSON.stringify(divConta.json));
  const divContaVenda = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invId, qty: 1, accountId: conta2Id, requestId: "venda-001" },
  });
  t("venda: requestId+conta divergente → 409", divContaVenda.status === 409 && divContaVenda.json?.erro === "request_id_divergente", JSON.stringify(divContaVenda.json));

  // 2. moeda da oferta divergente → 409 sem efeitos
  const ofertaUsd = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas`, {
    cookie: j1.cookie, body: { name: "Item USD", priceCents: 100, currency: "USD" },
  });
  const offerUsd = ofertaUsd.json?.id;
  const moeda = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId: offerUsd, qty: 1 }], requestId: "compra-usd-1" },
  });
  t("oferta em moeda divergente → 409", moeda.status === 409 && moeda.json?.erro === "moeda_divergente", JSON.stringify(moeda.json));

  // 3. direção em /pedidos
  const pedCompra = await req(BASE, "GET", `/characters/${charOk}/comercio/pedidos?direcao=compra`, { cookie: j1.cookie });
  const pedVenda = await req(BASE, "GET", `/characters/${charOk}/comercio/pedidos?direcao=venda_para_loja`, { cookie: j1.cookie });
  const dirs = (pedCompra.json?.pedidos ?? []).map((p) => p.direcao);
  const dirsV = (pedVenda.json?.pedidos ?? []).map((p) => p.direcao);
  t("filtro compra só compras", pedCompra.status === 200 && dirs.length > 0 && dirs.every((d) => d === "compra"), JSON.stringify(dirs));
  t("filtro venda só vendas", pedVenda.status === 200 && dirsV.length === 1 && dirsV[0] === "venda_para_loja", JSON.stringify(dirsV));

  // 4. segunda conta caixa → 409
  const caixa2 = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Caixa 2", papel: "caixa" },
  });
  t("segunda conta caixa → 409", caixa2.status === 409 && caixa2.json?.erro === "caixa_ja_existe", JSON.stringify(caixa2.json));

  // 5. LOJA-B sem aquisicao.unitCents → 422 mesmo com valueCents
  const invSemValor = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invSemValor, charOk, "Bugiganga", 3, JSON.stringify({ valueCents: 500 }), agora, agora);
    db.close();
  }
  const vendaSemValor = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invSemValor, qty: 1, accountId: contaId, requestId: "venda-sem-valor-1" },
  });
  t("item sem unitCents autoritativo → 422", vendaSemValor.status === 422 && vendaSemValor.json?.erro === "item_sem_valor", JSON.stringify(vendaSemValor.json));
  const bugiganga = comDb(BANCO, (db) => db.prepare("select quantity from inventory_entries where id=?").get(invSemValor)?.quantity);
  t("falha não baixou estoque do item", bugiganga === 3, String(bugiganga));

  // 6. papel proprietario tem mesmas permissões de gestor nesta fatia
  const gestorProp = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/gestores`, {
    cookie: mestre, body: { membershipId: j2.membershipId, role: "proprietario" },
  });
  t("proprietario vinculado", gestorProp.status === 201, JSON.stringify(gestorProp.json));
  const propOferta = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas`, {
    cookie: j2.cookie, body: { name: "Oferta do Prop", priceCents: 10 },
  });
  t("proprietario gerencia como gestor", propOferta.status === 201, String(propOferta.status));

  sec("corrida de replay simultâneo");
  // oferta ilimitada para isolar o efeito da corrida
  const ofertaCorrida = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas`, {
    cookie: j1.cookie, body: { name: "Item Corrida", priceCents: 100 },
  });
  const offerCorrida = ofertaCorrida.json?.id;
  const saldoAntesCorrida = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
  const corpoCorrida = { shopId, accountId: contaId, items: [{ offerId: offerCorrida, qty: 1 }], requestId: "corrida-001" };
  const [c1, c2] = await Promise.all([
    req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, { cookie: j1.cookie, body: corpoCorrida }),
    req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, { cookie: j1.cookie, body: corpoCorrida }),
  ]);
  const statuses = [c1.status, c2.status].sort();
  t("corrida: um 201 + um replay 200", statuses[0] === 200 && statuses[1] === 201, JSON.stringify([c1.status, c2.status, c1.json, c2.json]));
  t("corrida: mesmo pedido nas duas respostas", c1.json?.id && c1.json.id === c2.json?.id, `${c1.json?.id} vs ${c2.json?.id}`);
  const saldoAposCorrida = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
  t("corrida: débito aplicado exatamente uma vez", saldoAposCorrida === saldoAntesCorrida - 100, `${saldoAntesCorrida}→${saldoAposCorrida}`);
  const txsCorrida = comDb(BANCO, (db) => db.prepare("select count(*) c from money_transactions where request_id like 'corrida-001:%'").get().c);
  t("corrida: ledger com exatamente 2 pernas", txsCorrida === 2, String(txsCorrida));

  // mesmo requestId + fingerprint divergente concorrente → um commit + 409
  const corpoDiv = { shopId, accountId: contaId, items: [{ offerId: offerCorrida, qty: 5 }], requestId: "corrida-002" };
  const corpoDiv2 = { shopId, accountId: contaId, items: [{ offerId: offerCorrida, qty: 9 }], requestId: "corrida-002" };
  const [d1, d2] = await Promise.all([
    req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, { cookie: j1.cookie, body: corpoDiv }),
    req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, { cookie: j1.cookie, body: corpoDiv2 }),
  ]);
  const stDiv = [d1.status, d2.status].sort();
  t("corrida divergente: um commit + um 409", (stDiv[0] === 201 && stDiv[1] === 409) || (stDiv[0] === 200 && stDiv[1] === 409), JSON.stringify([d1.status, d2.status, d1.json?.erro, d2.json?.erro]));
  const pedidosDiv = comDb(BANCO, (db) => db.prepare("select count(*) c from shop_orders where request_id='corrida-002'").get().c);
  t("corrida divergente: um único recibo", pedidosDiv === 1, String(pedidosDiv));

  sec("gate de leitura — vitrine e histórico (bloqueio 7147784264)");
  // 4 pares válidos: (computador|tecnologia) × (notebook|celular_descartavel)
  // charOk já cobre computador+notebook
  const charCompCel = cenario.novoPersonagem(j1.membershipId, "Comp Celular", { comp: 1 });
  const charTecNote = cenario.novoPersonagem(j1.membershipId, "Tec Notebook", { tec: 1 });
  const charTecCel = cenario.novoPersonagem(j1.membershipId, "Tec Celular", { tec: 1 });
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    const ins = db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)");
    ins.run(crypto.randomUUID(), charCompCel, "Celular", 1, JSON.stringify({ regra: { kind: "item", key: "celular_descartavel" } }), agora, agora);
    ins.run(crypto.randomUUID(), charTecNote, "Notebook", 1, JSON.stringify({ regra: { kind: "item", key: "notebook" } }), agora, agora);
    ins.run(crypto.randomUUID(), charTecCel, "Celular", 1, JSON.stringify({ regra: { kind: "item", key: "celular_descartavel" } }), agora, agora);
    db.close();
  }
  for (const [id, rotulo] of [[charOk, "comp+notebook"], [charCompCel, "comp+celular"], [charTecNote, "tec+notebook"], [charTecCel, "tec+celular"]]) {
    const v = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${id}`, { cookie: j1.cookie });
    t(`vitrine par válido ${rotulo} → 200`, v.status === 200 && Array.isArray(v.json?.lojas), `${v.status} ${JSON.stringify(v.json).slice(0, 120)}`);
    const p = await req(BASE, "GET", `/characters/${id}/comercio/pedidos`, { cookie: j1.cookie });
    t(`pedidos par válido ${rotulo} → 200`, p.status === 200 && Array.isArray(p.json?.pedidos), `${p.status}`);
  }

  // negações — zero dados da Internet retornados
  const vSemParam = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas`, { cookie: j1.cookie });
  t("vitrine sem ?personagem → 400", vSemParam.status === 400 && vSemParam.json?.erro === "personagem_obrigatorio", JSON.stringify(vSemParam.json));
  const vInel = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charSemPericia}`, { cookie: j2.cookie });
  t("vitrine sem pericia → 403 sem dados", vInel.status === 403 && vInel.json?.erro === "internet_indisponivel" && vInel.json?.lojas === undefined, JSON.stringify(vInel.json).slice(0, 160));
  const vSemDev = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charSemDevice}`, { cookie: j2.cookie });
  t("vitrine sem device → 403 sem dados", vSemDev.status === 403 && vSemDev.json?.lojas === undefined, String(vSemDev.status));
  const vNaoDono = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charOk}`, { cookie: j2.cookie });
  t("vitrine characterId alheio → 403", vNaoDono.status === 403, String(vNaoDono.status));
  const vMestreInel = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charSemPericia}`, { cookie: mestre });
  t("vitrine mestre+personagem inelegível → 403", vMestreInel.status === 403 && vMestreInel.json?.lojas === undefined, String(vMestreInel.status));
  const vInexistente = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=personagem-inexistente`, { cookie: j1.cookie });
  t("vitrine personagem inexistente → 404", vInexistente.status === 404, String(vInexistente.status));
  const pInel = await req(BASE, "GET", `/characters/${charSemPericia}/comercio/pedidos`, { cookie: j2.cookie });
  t("pedidos inelegível → 403 sem dados", pInel.status === 403 && pInel.json?.pedidos === undefined, String(pInel.status));
  const pNaoDono = await req(BASE, "GET", `/characters/${charOk}/comercio/pedidos`, { cookie: j2.cookie });
  t("pedidos characterId alheio → 403", pNaoDono.status === 403, String(pNaoDono.status));

  // revalidação: revogar o dispositivo nega a leitura na chamada seguinte
  {
    const db = abrirDb(BANCO);
    db.prepare("delete from inventory_entries where character_id=?").run(charCompCel);
    db.close();
  }
  const vRevogado = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charCompCel}`, { cookie: j1.cookie });
  t("device revogado → vitrine 403 dispositivo_ausente", vRevogado.status === 403 && vRevogado.json?.motivos?.includes("dispositivo_ausente"), JSON.stringify(vRevogado.json));

  sec("bloqueios financeiros do Dono Técnico (7148991024/534/022)");

  // --- 1. abertura de caixa: ledger saldo_inicial + política ---
  // gestor com jogadorCompraVenda ligado (default): saldo positivo ok + ledger
  const contaInicial = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Fundo de Troco", balanceReais: 250, papel: "reserva" },
  });
  const contaInicialId = contaInicial.json?.id;
  t("conta reserva com saldo → 201", contaInicial.status === 201 && !!contaInicialId, JSON.stringify(contaInicial.json));
  const txInicial = comDb(BANCO, (db) => db.prepare(
    "select kind, shop_id, character_id, amount_cents, balance_before_cents, balance_after_cents from money_transactions where account_id=? and kind='saldo_inicial'",
  ).get(contaInicialId));
  t("saldo_inicial no ledger com shop_id e sem personagem",
    txInicial?.shop_id === shopId && txInicial?.character_id === null
    && txInicial?.amount_cents === 25000 && txInicial?.balance_before_cents === 0 && txInicial?.balance_after_cents === 25000,
    JSON.stringify(txInicial));

  // política desligada: gestor-jogador não abre conta com saldo; mestre é isento
  {
    const db = abrirDb(BANCO);
    const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campId);
    const cfg = JSON.parse(rs.config || "{}");
    cfg.financeiro = { ...(cfg.financeiro ?? {}), jogadorCompraVenda: false };
    db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
    db.close();
  }
  const negadoSaldo = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Caixa Proibido", balanceReais: 10, papel: "reserva" },
  });
  t("gestor sem jogadorCompraVenda + saldo>0 → 403", negadoSaldo.status === 403, JSON.stringify(negadoSaldo.json));
  const isentoMestre = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, {
    cookie: mestre, body: { type: "especie", name: "Caixa do Mestre", balanceReais: 10, papel: "reserva" },
  });
  t("mestre isento da política → 201", isentoMestre.status === 201, JSON.stringify(isentoMestre.json));
  {
    const db = abrirDb(BANCO);
    const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campId);
    const cfg = JSON.parse(rs.config || "{}");
    cfg.financeiro = { ...(cfg.financeiro ?? {}), jogadorCompraVenda: true };
    db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
    db.close();
  }

  // saldo negativo rejeitado (permitirSaldoNegativo=false) e moeda inválida
  const negSaldo = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Negativa", balanceReais: -50, papel: "reserva" },
  });
  t("saldo inicial negativo → 400", negSaldo.status === 400, JSON.stringify(negSaldo.json));
  const moedaInvalida = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Moeda X", balanceReais: 0, currency: "XXX", papel: "reserva" },
  });
  t("moeda não configurada → 400", moedaInvalida.status === 400, JSON.stringify(moedaInvalida.json));
  // saldo zero não gera lançamento
  const contaZero = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Vazia", papel: "reserva" },
  });
  const txZero = comDb(BANCO, (db) => db.prepare("select count(*) c from money_transactions where account_id=?").get(contaZero.json?.id)?.c);
  t("saldo zero → conta sem lançamento", contaZero.status === 201 && txZero === 0, `status=${contaZero.status} txs=${txZero}`);

  // --- 2. reserva nunca vira caixa ---
  const lojaRes = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Só Reserva", category: "mercadoria" },
  });
  const shopRes = lojaRes.json?.id;
  await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopRes}/gestores`, {
    cookie: mestre, body: { membershipId: j1.membershipId, role: "gestor" },
  });
  await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopRes}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Só Reserva", papel: "reserva" },
  });
  const ofertaRes = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopRes}/ofertas`, {
    cookie: j1.cookie, body: { name: "Item Reserva", priceCents: 100 },
  });
  const compraRes = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId: shopRes, accountId: contaId, items: [{ offerId: ofertaRes.json?.id, qty: 1 }], requestId: "compra-reserva-1" },
  });
  t("loja só com reserva → 409 loja_sem_caixa", compraRes.status === 409 && compraRes.json?.erro === "loja_sem_caixa", JSON.stringify(compraRes.json));
  const txRes = comDb(BANCO, (db) => db.prepare("select count(*) c from money_transactions where request_id like 'compra-reserva-1:%'").get().c);
  t("reserva: zero movimento no ledger", txRes === 0, String(txRes));

  // --- 3. escopo idempotente: campanha+ator+direção+requestId ---
  // atores diferentes, mesmo requestId → operações independentes
  const contaMestre = await req(BASE, "POST", `/characters/${charOk}/financeiro/contas`, {
    cookie: mestre, body: { type: "especie", name: "Cofre Mestre", balanceReais: 500 },
  });
  const esc1j1 = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId: offerCorrida, qty: 1 }], requestId: "escopo-001" },
  });
  const esc1m = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: mestre,
    body: { shopId, accountId: contaMestre.json?.id, items: [{ offerId: offerCorrida, qty: 1 }], requestId: "escopo-001" },
  });
  t("atores diferentes mesmo requestId → ambos commitam", esc1j1.status === 201 && esc1m.status === 201, JSON.stringify([esc1j1.status, esc1m.status, esc1j1.json?.erro, esc1m.json?.erro]));
  const pedidosEscopo = comDb(BANCO, (db) => db.prepare("select count(*) c from shop_orders where request_id='escopo-001'").get().c);
  t("escopo: dois recibos independentes", pedidosEscopo === 2, String(pedidosEscopo));

  // mesmo ator, direções diferentes, mesmo requestId → escopos independentes
  const invEscopo = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invEscopo, charOk, "Bugiganga Escopo", 1, JSON.stringify({ aquisicao: { unitCents: 100, qtdOriginal: 1 } }), agora, agora);
    db.close();
  }
  const esc2c = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId: offerCorrida, qty: 1 }], requestId: "escopo-002" },
  });
  const esc2v = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invEscopo, qty: 1, accountId: contaId, requestId: "escopo-002" },
  });
  t("mesmo ator requestId compra+venda → independentes", esc2c.status === 201 && esc2v.status === 201, JSON.stringify([esc2c.status, esc2v.status, esc2c.json?.erro, esc2v.json?.erro]));
  const dirsEscopo = comDb(BANCO, (db) => db.prepare("select direction from shop_orders where request_id='escopo-002' order by direction").all().map((r) => r.direction));
  t("escopo: direções distintas persistidas", dirsEscopo.length === 2 && dirsEscopo[0] !== dirsEscopo[1], JSON.stringify(dirsEscopo));

  // mesmo ator+direção+requestId, fingerprint divergente → 409 sem efeitos
  const esc3a = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId: offerCorrida, qty: 1 }], requestId: "escopo-003" },
  });
  const esc3b = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId: offerCorrida, qty: 3 }], requestId: "escopo-003" },
  });
  t("mesmo escopo fingerprint divergente → 201+409", esc3a.status === 201 && esc3b.status === 409 && esc3b.json?.erro === "request_id_divergente", JSON.stringify([esc3a.status, esc3b.status, esc3b.json]));
  const recEscopo3 = comDb(BANCO, (db) => db.prepare("select count(*) c from shop_orders where request_id='escopo-003'").get().c);
  t("escopo divergente: um único recibo", recEscopo3 === 1, String(recEscopo3));

  sec("efeito 4 LOJA-B — entrada no estoque comercial (bloqueio P1)");
  // venda-001 vendeu 'Relíquia Antiga' (sem template, unitCents 4000)
  const estqRelquia = comDb(BANCO, (db) => db.prepare(
    "select stock_qty, is_active, price_cents, item_template_id, data from shop_offers where shop_id=? and name='Relíquia Antiga'",
  ).all(shopId));
  t("venda cria oferta de estoque inativa", estqRelquia.length === 1 && estqRelquia[0].is_active === 0 && estqRelquia[0].stock_qty === 1, JSON.stringify(estqRelquia));
  t("oferta de estoque com custo e proveniência", estqRelquia[0]?.price_cents === 4000 && JSON.parse(estqRelquia[0]?.data ?? "{}").origem === "revenda_loja", JSON.stringify(estqRelquia[0]?.data));

  // segunda venda do mesmo item (sem template → casa por name) acumula
  const invRel2 = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invRel2, charOk, "Relíquia Antiga", 1, JSON.stringify({ aquisicao: { unitCents: 4000, qtdOriginal: 1 } }), agora, agora);
    db.close();
  }
  const vendaRel2 = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invRel2, qty: 1, accountId: contaId, requestId: "venda-rel2" },
  });
  t("segunda venda 201", vendaRel2.status === 201, JSON.stringify(vendaRel2.json));
  const estqRelquia2 = comDb(BANCO, (db) => db.prepare(
    "select count(*) c, sum(stock_qty) s from shop_offers where shop_id=? and name='Relíquia Antiga'",
  ).get(shopId));
  t("estoque acumulou para 2 na mesma oferta", estqRelquia2.c === 1 && estqRelquia2.s === 2, JSON.stringify(estqRelquia2));

  // caminho canônico: item COM templateId casa por item_template_id
  const tplId = crypto.randomUUID();
  const invTpl = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into item_templates (id,campaign_id,name,category,data,is_active,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
      .run(tplId, campId, "Amuleto Antigo", "reliquia", "{}", 1, agora, agora);
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invTpl, charOk, "Amuleto Antigo", 1, JSON.stringify({ templateId: tplId, aquisicao: { unitCents: 7000, qtdOriginal: 1 } }), agora, agora);
    db.close();
  }
  const vendaTpl = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invTpl, qty: 1, accountId: contaId, requestId: "venda-tpl-1" },
  });
  t("venda com template 201", vendaTpl.status === 201, JSON.stringify(vendaTpl.json));
  const estqTpl = comDb(BANCO, (db) => db.prepare(
    "select stock_qty, item_template_id, is_active from shop_offers where shop_id=? and item_template_id=?",
  ).all(shopId, tplId));
  t("estoque vinculado por template canônico", estqTpl.length === 1 && estqTpl[0].stock_qty === 1 && estqTpl[0].is_active === 0, JSON.stringify(estqTpl));

  // falha não cria oferta: caixa zerado → 422 antes do crédito de estoque
  const saldoCaixaAntes = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(caixaId)?.balance_cents);
  {
    const db = abrirDb(BANCO);
    db.prepare("update financial_accounts set balance_cents=0 where id=?").run(caixaId);
    db.close();
  }
  const invFalha = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invFalha, charOk, "Item Que Nao Entra", 1, JSON.stringify({ aquisicao: { unitCents: 999999, qtdOriginal: 1 } }), agora, agora);
    db.close();
  }
  const ofertasAntes = comDb(BANCO, (db) => db.prepare("select count(*) c from shop_offers where shop_id=?").get(shopId).c);
  const vendaFalha = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invFalha, qty: 1, accountId: contaId, requestId: "venda-falha-1" },
  });
  const ofertasDepois = comDb(BANCO, (db) => db.prepare("select count(*) c from shop_offers where shop_id=?").get(shopId).c);
  const itemFalha = comDb(BANCO, (db) => db.prepare("select count(*) c from inventory_entries where id=?").get(invFalha).c);
  t("caixa insuficiente → 422 e zero oferta/estoque", vendaFalha.status === 422 && ofertasDepois === ofertasAntes, JSON.stringify([vendaFalha.status, vendaFalha.json, ofertasAntes, ofertasDepois]));
  t("falha preservou item no inventário", itemFalha === 1, String(itemFalha));
  {
    const db = abrirDb(BANCO);
    db.prepare("update financial_accounts set balance_cents=? where id=?").run(saldoCaixaAntes, caixaId);
    db.close();
  }

  // Falha injetada DEPOIS dos efeitos financeiros e da baixa do inventário.
  // O trigger aborta a criação da oferta na entrada do estoque da loja;
  // a transação inteira deve reverter caixa, vendedor, item, ledger e recibo.
  const invRollbackMidTx = crypto.randomUUID();
  const nomeRollbackMidTx = "Teste rollback transacional LOJA-B";
  const requestRollbackMidTx = "venda-rollback-midtx-1";
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invRollbackMidTx, charOk, nomeRollbackMidTx, 1, JSON.stringify({ aquisicao: { unitCents: 3210, qtdOriginal: 1 } }), agora, agora);
    db.exec(`CREATE TRIGGER teste_loja_b_falha_estoque
      BEFORE INSERT ON shop_offers
      WHEN NEW.name = 'Teste rollback transacional LOJA-B'
      BEGIN SELECT RAISE(ABORT, 'falha_injetada_estoque_loja'); END;`);
    db.close();
  }
  const antesRollbackMidTx = comDb(BANCO, (db) => ({
    vendedor: db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents,
    caixa: db.prepare("select balance_cents from financial_accounts where id=?").get(caixaId)?.balance_cents,
    item: db.prepare("select quantity from inventory_entries where id=?").get(invRollbackMidTx)?.quantity ?? null,
    ledger: db.prepare("select count(*) c from money_transactions where shop_id=? and request_id like ?").get(shopId, requestRollbackMidTx + ":%").c,
    oferta: db.prepare("select count(*) c from shop_offers where shop_id=? and name=?").get(shopId, nomeRollbackMidTx).c,
    recibo: db.prepare("select count(*) c from shop_orders where campaign_id=? and request_id=?").get(campId, requestRollbackMidTx).c,
  }));
  let vendaRollbackMidTx;
  try {
    vendaRollbackMidTx = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
      cookie: j1.cookie,
      body: { shopId, inventoryEntryId: invRollbackMidTx, qty: 1, accountId: contaId, requestId: requestRollbackMidTx },
    });
  } finally {
    const db = abrirDb(BANCO);
    db.exec("DROP TRIGGER IF EXISTS teste_loja_b_falha_estoque");
    db.close();
  }
  const depoisRollbackMidTx = comDb(BANCO, (db) => ({
    vendedor: db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents,
    caixa: db.prepare("select balance_cents from financial_accounts where id=?").get(caixaId)?.balance_cents,
    item: db.prepare("select quantity from inventory_entries where id=?").get(invRollbackMidTx)?.quantity ?? null,
    ledger: db.prepare("select count(*) c from money_transactions where shop_id=? and request_id like ?").get(shopId, requestRollbackMidTx + ":%").c,
    oferta: db.prepare("select count(*) c from shop_offers where shop_id=? and name=?").get(shopId, nomeRollbackMidTx).c,
    recibo: db.prepare("select count(*) c from shop_orders where campaign_id=? and request_id=?").get(campId, requestRollbackMidTx).c,
  }));
  t("falha injetada ao gravar estoque interrompe LOJA-B (5xx)", vendaRollbackMidTx?.status >= 500, JSON.stringify(vendaRollbackMidTx));
  t("rollback LOJA-B: caixa e vendedor permanecem intactos",
    depoisRollbackMidTx.caixa === antesRollbackMidTx.caixa && depoisRollbackMidTx.vendedor === antesRollbackMidTx.vendedor,
    JSON.stringify({ antes: antesRollbackMidTx, depois: depoisRollbackMidTx }));
  t("rollback LOJA-B: inventário do vendedor permanece intacto",
    depoisRollbackMidTx.item === antesRollbackMidTx.item && depoisRollbackMidTx.item === 1,
    JSON.stringify({ antes: antesRollbackMidTx.item, depois: depoisRollbackMidTx.item }));
  t("rollback LOJA-B: nenhuma perna de ledger nem recibo órfão",
    depoisRollbackMidTx.ledger === antesRollbackMidTx.ledger && depoisRollbackMidTx.recibo === antesRollbackMidTx.recibo,
    JSON.stringify({ antes: antesRollbackMidTx, depois: depoisRollbackMidTx }));
  t("rollback LOJA-B: estoque comercial não recebe item após falha",
    depoisRollbackMidTx.oferta === antesRollbackMidTx.oferta && depoisRollbackMidTx.oferta === 0,
    JSON.stringify({ antes: antesRollbackMidTx.oferta, depois: depoisRollbackMidTx.oferta }));

  sec("realtime — canal Internet separado do OOC (bloqueio P1 7152569806)");
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const conectarSocket = (cookie) => new Promise((resolve, reject) => {
    const s = ioCliente(BASE, { extraHeaders: { cookie }, transports: ["websocket", "polling"], reconnection: false });
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
    setTimeout(() => reject(new Error("timeout conexão socket")), 8000);
  });
  const emitirCb = (s, evento, payload) => new Promise((resolve) => s.emit(evento, payload, (ok) => resolve(ok)));

  const sockOk = await conectarSocket(j1.cookie);   // dono do charOk (elegível)
  const sockNeg = await conectarSocket(j2.cookie); // dono dos inelegíveis
  const evComOk = [], evComNeg = [], evPatOk = [], evPatNeg = [];
  sockOk.on("comercio:atualizado", (d) => evComOk.push(d));
  sockNeg.on("comercio:atualizado", (d) => evComNeg.push(d));
  sockOk.on("patrimonio:atualizado", (d) => evPatOk.push(d));
  sockNeg.on("patrimonio:atualizado", (d) => evPatNeg.push(d));
  t("sala OOC: ambos entram na campanha", (await emitirCb(sockOk, "entrar-campanha", campId)) === true
    && (await emitirCb(sockNeg, "entrar-campanha", campId)) === true);

  // inscrição no canal Internet: elegível entra; todos os negativos falham
  t("elegível inscreve-se no canal Internet", (await emitirCb(sockOk, "entrar-internet", { campaignId: campId, characterId: charOk })) === true);
  t("inelegível sem perícia → recusado", (await emitirCb(sockNeg, "entrar-internet", { campaignId: campId, characterId: charSemPericia })) === false);
  t("inelegível sem dispositivo → recusado", (await emitirCb(sockNeg, "entrar-internet", { campaignId: campId, characterId: charSemDevice })) === false);
  t("personagem alheio → recusado (titularidade)", (await emitirCb(sockNeg, "entrar-internet", { campaignId: campId, characterId: charOk })) === false);
  t("j1 não é dono do charSemDevice → recusado", (await emitirCb(sockOk, "entrar-internet", { campaignId: campId, characterId: charSemDevice })) === false);

  // gatilho real: venda gera patrimonio:atualizado (OOC) + comercio:atualizado (IC)
  const invSinal = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invSinal, charOk, "Sinal Realtime", 1, JSON.stringify({ aquisicao: { unitCents: 100, qtdOriginal: 1 } }), agora, agora);
    db.close();
  }
  const vendaSinal = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invSinal, qty: 1, accountId: contaId, requestId: "venda-sinal-rt" },
  });
  t("venda-gatilho 201", vendaSinal.status === 201, JSON.stringify(vendaSinal.json));
  await dormir(600);
  t("elegível recebe comercio:atualizado", evComOk.length >= 1, String(evComOk.length));
  t("inelegível NÃO recebe comercio:atualizado", evComNeg.length === 0, String(evComNeg.length));
  t("OOC intacto: inelegível recebe patrimonio:atualizado", evPatNeg.length >= 1, String(evPatNeg.length));
  t("OOC intacto: elegível recebe patrimonio:atualizado", evPatOk.length >= 1, String(evPatOk.length));

  // transferência de titularidade durante a sessão: o novo dono pode entrar,
  // mas o socket do ex-dono deve ser expulso antes da próxima entrega.
  {
    const db = abrirDb(BANCO);
    db.prepare("update characters set membership_id=? where id=?").run(j2.membershipId, charOk);
    db.close();
  }
  t("novo titular pode inscrever-se após transferência",
    (await emitirCb(sockNeg, "entrar-internet", { campaignId: campId, characterId: charOk })) === true);
  t("ex-titular não consegue reinscrever-se após transferência",
    (await emitirCb(sockOk, "entrar-internet", { campaignId: campId, characterId: charOk })) === false);
  const evExTitularAntes = evComOk.length;
  const evNovoTitularAntes = evComNeg.length;
  const lojaTransferencia = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Transferência RT" },
  });
  t("gatilho pós-transferência 201", lojaTransferencia.status === 201, JSON.stringify(lojaTransferencia.json));
  await dormir(600);
  t("ex-titular perde entrega após transferência", evComOk.length === evExTitularAntes,
    `${evExTitularAntes}→${evComOk.length}`);
  t("novo titular continua recebendo após transferência", evComNeg.length > evNovoTitularAntes,
    `${evNovoTitularAntes}→${evComNeg.length}`);

  // revogação por perda do dispositivo: também corta o novo titular.
  {
    const db = abrirDb(BANCO);
    db.prepare("delete from inventory_entries where character_id=? and json_extract(data,'$.regra.key')='notebook'").run(charOk);
    db.close();
  }
  const evAntesRevogacao = evComNeg.length;
  const lojaSinal = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Sinal RT" },
  });
  t("gatilho pós-revogação 201", lojaSinal.status === 201, JSON.stringify(lojaSinal.json));
  await dormir(600);
  t("revogado não recebe nova entrega", evComNeg.length === evAntesRevogacao,
    `${evAntesRevogacao}→${evComNeg.length}`);
  t("reinscrição negada após revogação",
    (await emitirCb(sockNeg, "entrar-internet", { campaignId: campId, characterId: charOk })) === false);

  sockOk.close(); sockNeg.close();

  sec("realtime — fail-closed durante barreira de restauração (L2)");
  // charOk volta a ser elegível: notebook reposto + nova inscrição
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), charOk, "Notebook", 1, JSON.stringify({ regra: { kind: "item", key: "notebook" } }), agora, agora);
    db.close();
  }
  // charOk foi transferido para j2 na seção de titularidade — o novo
  // dono (j2) é quem se inscreve agora
  const sockL2 = await conectarSocket(j2.cookie);
  const evL2 = [];
  sockL2.on("comercio:atualizado", (d) => evL2.push(d));
  await emitirCb(sockL2, "entrar-campanha", campId);
  t("elegível reinscreve no canal Internet", (await emitirCb(sockL2, "entrar-internet", { campaignId: campId, characterId: charOk })) === true);

  // snapshot do estado atual para o restore
  const snapL2 = await req(BASE, "POST", `/campaigns/${campId}/snapshots`, { cookie: mestre, body: { description: "antes-barreira-l2" } });
  t("snapshot para restore criado", snapL2.status === 201 && !!snapL2.json?.id, JSON.stringify(snapL2.json));

  // emissão fica PAUSADA no gancho de teste (flag com conteúdo=campId
  // casa com o marcador `internet:{campaignId}` do emitter)
  writeFileSync(`${DIR}/pausa.flag`, campId);
  const lojaBar = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Barreira L2" },
  });
  t("gatilho em voo 201", lojaBar.status === 201, JSON.stringify(lojaBar.json));
  // espera a emissão pausar de fato (.pausado escrito pelo gancho)
  const flagPausa = `${DIR}/pausa.flag`;
  let pausou = false;
  for (let i = 0; i < 100 && !pausou; i++) { await dormir(50); pausou = existsSync(`${flagPausa}.pausado`); }
  t("emissão de comércio pausada no gancho", pausou);

  // restore sem aguardar — barreira sobe; MESTRE_RESTORE_DELAY_MS segura 2s
  const pRest = req(BASE, "POST", `/campaigns/${campId}/snapshots/${snapL2.json.id}/restaurar`, {
    cookie: mestre, body: { confirmacao: "RESTAURAR" },
  });
  await dormir(500); // janela: barreira ativa + delay de 2s em curso
  // libera a emissão pausada → ela DEVE abortar pela barreira (fail-closed)
  rmSync(flagPausa, { force: true });
  await dormir(500);
  t("durante barreira: zero comercio:atualizado entregue", evL2.length === 0, String(evL2.length));

  const rest = await pRest;
  t("restore concluído", rest.status === 200, JSON.stringify(rest.json).slice(0, 200));
  // pós-liberação: novo evento entrega normalmente ao elegível
  const lojaPos = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Pos Barreira" },
  });
  t("gatilho pós-barreira 201", lojaPos.status === 201, JSON.stringify(lojaPos.json));
  await dormir(700);
  t("pós-barreira: elegível recebe comercio:atualizado", evL2.length >= 1, String(evL2.length));
  sockL2.close();

  sec("lacunas L1/L3/L4/L5 (#336 → suíte CI-enabled)");
  // charOk pertence a j2 desde a seção de titularidade; contaId é a
  // conta do charOk — o dono atual (j2) é quem opera o personagem.
  const donoAtual = j2.cookie;

  // ---- L1: 404 para inexistente / 409 para consumido em corrida ----
  const invInexistente = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: donoAtual,
    body: { shopId, inventoryEntryId: crypto.randomUUID(), qty: 1, accountId: contaId, requestId: "vend-l1-404" },
  });
  t("L1: item inexistente → 404 item_nao_encontrado",
    invInexistente.status === 404 && invInexistente.json?.erro === "item_nao_encontrado",
    `${invInexistente.status} ${JSON.stringify(invInexistente.json)}`);

  const invCorridaL1 = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invCorridaL1, charOk, "Item Corrida L1", 1, JSON.stringify({ aquisicao: { unitCents: 700, qtdOriginal: 1 } }), agora, agora);
    db.close();
  }
  const saldoL1Antes = comDb(BANCO, (db) => db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b);
  const [cvA, cvB] = await Promise.all([
    req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
      cookie: donoAtual,
      body: { shopId, inventoryEntryId: invCorridaL1, qty: 1, accountId: contaId, requestId: "vend-l1-corrida-a" },
    }),
    req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
      cookie: donoAtual,
      body: { shopId, inventoryEntryId: invCorridaL1, qty: 1, accountId: contaId, requestId: "vend-l1-corrida-b" },
    }),
  ]);
  const stL1 = [cvA.status, cvB.status].sort((a, b) => a - b);
  const perdL1 = [cvA, cvB].find((r) => r.status !== 201);
  t("L1: corrida último item → um 201 + perdedor 409 item_indisponivel",
    stL1[0] === 201 && stL1[1] === 409 && perdL1?.json?.erro === "item_indisponivel",
    `statuses=${cvA.status},${cvB.status} erros=${cvA.json?.erro}|${cvB.json?.erro}`);
  const posL1 = comDb(BANCO, (db) => ({
    inv: db.prepare("select count(*) c from inventory_entries where id=?").get(invCorridaL1).c,
    saldo: db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b,
    orders: db.prepare("select count(*) c from shop_orders where request_id in ('vend-l1-corrida-a','vend-l1-corrida-b')").get().c,
    txs: db.prepare("select count(*) c from money_transactions where request_id like 'vend-l1-corrida-%'").get().c,
    oferta: db.prepare("select count(*) c, sum(stock_qty) s from shop_offers where shop_id=? and name='Item Corrida L1'").get(shopId),
  }));
  t("L1: inventário consumido, débito único (+700), 1 recibo, 2 pernas, 1 oferta estoque qty=1",
    posL1.inv === 0 && posL1.saldo === saldoL1Antes + 700
    && posL1.orders === 1 && posL1.txs === 2
    && posL1.oferta.c === 1 && posL1.oferta.s === 1,
    JSON.stringify(posL1));

  // ---- L3: loja fechada → venda nega 409 loja_fechada com zero efeitos ----
  const patchFechaL3 = await req(BASE, "PATCH", `/campaigns/${campId}/comercio/lojas/${shopId}`, {
    cookie: mestre, body: { isOpen: false },
  });
  t("L3: PATCH loja isOpen=false → 200", patchFechaL3.status === 200, String(patchFechaL3.status));
  const invFechadaL3 = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invFechadaL3, charOk, "Item Loja Fechada L3", 1, JSON.stringify({ aquisicao: { unitCents: 300, qtdOriginal: 1 } }), agora, agora);
    db.close();
  }
  const saldoL3Antes = comDb(BANCO, (db) => db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b);
  const vendFechadaL3 = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: donoAtual,
    body: { shopId, inventoryEntryId: invFechadaL3, qty: 1, accountId: contaId, requestId: "vend-l3-fechada" },
  });
  t("L3: venda em loja fechada → 409 loja_fechada",
    vendFechadaL3.status === 409 && vendFechadaL3.json?.erro === "loja_fechada",
    `${vendFechadaL3.status} ${JSON.stringify(vendFechadaL3.json)}`);
  const posL3 = comDb(BANCO, (db) => ({
    saldo: db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b,
    qtd: db.prepare("select quantity q from inventory_entries where id=?").get(invFechadaL3)?.q,
    orders: db.prepare("select count(*) c from shop_orders where request_id='vend-l3-fechada'").get().c,
    txs: db.prepare("select count(*) c from money_transactions where request_id like 'vend-l3-fechada:%'").get().c,
    oferta: db.prepare("select count(*) c from shop_offers where shop_id=? and name='Item Loja Fechada L3'").get(shopId).c,
  }));
  t("L3: vendedor/item/ledger/recibo/estoque intactos",
    posL3.saldo === saldoL3Antes && posL3.qtd === 1
    && posL3.orders === 0 && posL3.txs === 0 && posL3.oferta === 0,
    JSON.stringify(posL3));
  const patchReabreL3 = await req(BASE, "PATCH", `/campaigns/${campId}/comercio/lojas/${shopId}`, {
    cookie: mestre, body: { isOpen: true },
  });
  t("L3: reabertura da loja → 200", patchReabreL3.status === 200, String(patchReabreL3.status));

  // ---- L4: sair-internet corta a entrega; reinscrição volta ----
  const sockL4 = await conectarSocket(donoAtual);
  const evL4 = [];
  sockL4.on("comercio:atualizado", (d) => evL4.push(d));
  await emitirCb(sockL4, "entrar-campanha", campId);
  t("L4: elegível inscreve no canal Internet",
    (await emitirCb(sockL4, "entrar-internet", { campaignId: campId, characterId: charOk })) === true);
  const gatilhoL4a = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Sinal L4a" },
  });
  t("L4: gatilho inicial → 201", gatilhoL4a.status === 201, String(gatilhoL4a.status));
  await dormir(600);
  const nL4Antes = evL4.length;
  t("L4: inscrito recebe comercio:atualizado", nL4Antes >= 1, String(nL4Antes));
  sockL4.emit("sair-internet", { campaignId: campId, characterId: charOk });
  await dormir(200);
  const gatilhoL4b = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Sinal L4b" },
  });
  t("L4: gatilho pós-sair → 201", gatilhoL4b.status === 201, String(gatilhoL4b.status));
  await dormir(600);
  t("L4: após sair-internet o socket NÃO recebe comercio:atualizado",
    evL4.length === nL4Antes, `${nL4Antes} → ${evL4.length}`);
  t("L4: reinscrição após sair-internet → true",
    (await emitirCb(sockL4, "entrar-internet", { campaignId: campId, characterId: charOk })) === true);
  const gatilhoL4c = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Sinal L4c" },
  });
  t("L4: gatilho pós-reinscrição → 201", gatilhoL4c.status === 201, String(gatilhoL4c.status));
  await dormir(600);
  t("L4: após reinscrição o socket volta a receber",
    evL4.length > nL4Antes, `${nL4Antes} → ${evL4.length}`);
  sockL4.close();

  // ---- L5: entrar-internet com payload malformado → cb(false), sem sala ----
  const sockL5 = await conectarSocket(donoAtual);
  const evL5 = [];
  sockL5.on("comercio:atualizado", (d) => evL5.push(d));
  const malformados = [null, "string", 42, {}, { campaignId: campId }, { characterId: charOk }, { campaignId: 123, characterId: charOk }, { campaignId: campId, characterId: 42 }];
  let malNegados = 0;
  for (const payload of malformados) {
    const ok = await emitirCb(sockL5, "entrar-internet", payload);
    if (ok === false) malNegados++;
  }
  t("L5: entrar-internet malformado → todos cb(false)", malNegados === malformados.length, `${malNegados}/${malformados.length}`);
  const gatilhoL5 = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Sinal L5" },
  });
  t("L5: gatilho pós-payloads malformados → 201", gatilhoL5.status === 201, String(gatilhoL5.status));
  await dormir(600);
  t("L5: socket com payloads malformados NÃO entrou em sala (zero eventos)",
    evL5.length === 0, `eventos=${evL5.length}`);
  sockL5.close();

  sec("resumo");
  console.log(`\n${pass} passaram, ${fail} falharam`);
  if (fail) process.exitCode = 1;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
