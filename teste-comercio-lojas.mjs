// Testes — comércio 1.1.0 (Issue #286): lojas, ofertas, checkout LOJA-A
// (compra) e LOJA-B (venda à loja), gate de Internet fail-closed, caixa do
// estabelecimento, idempotência requestId/fingerprint, gestão por gestor.
// Banco isolado + fixtures sintéticas (teste-base).
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
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
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
  const charSemPericia = cenario.novoPersonagem(j2.membershipId, "Sem Pericia", { for: 5 });
  const charSemDevice = cenario.novoPersonagem(j2.membershipId, "Sem Device", { comp: 2 });
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), charOk, "Notebook", 1, JSON.stringify({ regra: { kind: "item", key: "notebook" } }), agora, agora);
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
    txs: db.prepare("select count(*) c from money_transactions where request_id in ('compra-001:out','compra-001:in')").get().c,
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

  sec("resumo");
  console.log(`\n${pass} passaram, ${fail} falharam`);
  if (fail) process.exitCode = 1;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
