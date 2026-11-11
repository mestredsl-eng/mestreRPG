// Testes — integração financeiro ↔ patrimônio (compra com débito, venda
// com crédito) no endpoint POST /characters/:id/financeiro/operacao.
// Banco isolado em diretório temporário + fixtures sintéticas (teste-base).
import Database from "better-sqlite3";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, req,
  encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("financeiro-compras");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

const saldoDb = (contaId) => comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
const txCount = (contaId) => comDb(BANCO, (db) => db.prepare("select count(*) c from money_transactions where account_id=?").get(contaId).c);
const itensDb = (charId) => comDb(BANCO, (db) => db.prepare("select id,name,quantity,data from inventory_entries where character_id=? order by created_at").all(charId));
const itemDb = (itemId) => comDb(BANCO, (db) => db.prepare("select quantity,data from inventory_entries where id=?").get(itemId));

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
  const charMestre = cenario.personagemMestre;
  const j1 = cenario.jogadores.jogador1;
  const charJ1 = cenario.novoPersonagem(j1.membershipId, "Heroína");
  const charJ2 = cenario.novoPersonagem(cenario.jogadores.jogador2.membershipId, "Arqueiro");

  const mkConta = async (charId, cookie, name, saldo, extra = {}) => {
    const r = await req(BASE, "POST", `/characters/${charId}/financeiro/contas`, {
      cookie, body: { type: "especie", name, balanceReais: saldo, ...extra },
    });
    return r.json?.id;
  };
  const operacao = (charId, cookie, body) =>
    req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, { cookie, body });

  const contaM = await mkConta(charMestre, mestre, "Bolso do Mestre", 500);
  const contaJ1 = await mkConta(charJ1, j1.cookie, "Poupança", 100);
  const contaJ1b = await mkConta(charJ1, j1.cookie, "Moedas", 0);
  const contaJ2 = await mkConta(charJ2, cenario.jogadores.jogador2.cookie, "Bolso do Arqueiro", 50);
  t("contas criadas", !!(contaM && contaJ1 && contaJ1b && contaJ2));

  // Item do catálogo (criado pelo mestre)
  const tpl = await req(BASE, "POST", `/campaigns/${cenario.campId}/inventario`, {
    cookie: mestre, body: { name: "Poção de Cura", category: "Consumível", description: "Restaura 10 PV", data: { weight: 0.5 } },
  });
  const templateId = tpl.json?.id;
  t("template do catálogo criado", tpl.status === 201 && !!templateId, `status=${tpl.status}`);

  // ===== 1. Compra com débito financeiro =====
  sec("Compra com débito");
  {
    const antes = saldoDb(contaJ1);
    const r = reqId => operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 30, quantidade: 3,
      item: { name: "Pão", quantity: 1 }, requestId: reqId,
    });
    const ok = await r(crypto.randomUUID());
    t("compra 201", ok.status === 201, `status=${ok.status} ${JSON.stringify(ok.json).slice(0, 120)}`);
    t("saldo debitado -30.00", saldoDb(contaJ1) === antes - 3000, `antes=${antes} depois=${saldoDb(contaJ1)}`);
    const itens = itensDb(charJ1);
    const pao = itens.find((i) => i.name === "Pão");
    t("item entrou no inventário (qtd 3)", pao?.quantity === 3, JSON.stringify(itens));
    const opId = JSON.parse(pao?.data ?? "{}").operacaoId;
    t("item vinculado à operação (operacaoId)", !!opId, `data=${pao?.data}`);
    const tx = comDb(BANCO, (db) => db.prepare("select kind,amount_cents,description from money_transactions where request_id=?").get(opId));
    t("tx financeira kind=compra -3000", tx?.kind === "compra" && tx?.amount_cents === -3000, JSON.stringify(tx));
  }

  // ===== 2. Compra via template do catálogo =====
  sec("Compra via catálogo");
  {
    const antes = saldoDb(contaJ1);
    const rid = crypto.randomUUID();
    const r = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 15, quantidade: 2, templateId, requestId: rid,
    });
    t("compra catálogo 201", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    t("saldo debitado -15.00", saldoDb(contaJ1) === antes - 1500, `depois=${saldoDb(contaJ1)}`);
    const pocao = itensDb(charJ1).find((i) => i.name === "Poção de Cura");
    t("item do catálogo criado (qtd 2, categoria)", pocao?.quantity === 2, JSON.stringify(pocao));
    t("templateId e operacaoId gravados", JSON.parse(pocao?.data ?? "{}").templateId === templateId && JSON.parse(pocao?.data ?? "{}").operacaoId === rid);
  }

  // ===== 3. Compra sem movimentação financeira (fluxo antigo) =====
  sec("Compra sem pagamento");
  {
    const antes = saldoDb(contaJ1);
    const r = await req(BASE, "POST", `/characters/${charJ1}/inventario`, {
      cookie: j1.cookie, body: { name: "Corda", quantity: 1 },
    });
    t("cadastro direto 201", r.status === 201, `status=${r.status}`);
    t("saldo intacto", saldoDb(contaJ1) === antes);
  }

  // ===== 4. Saldo insuficiente =====
  sec("Saldo insuficiente");
  {
    const antes = saldoDb(contaJ1b); // 0.00
    const txAntes = txCount(contaJ1b);
    const itensAntes = itensDb(charJ1).length;
    const r = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 10, item: { name: "Item Caro" },
    });
    t("compra sem saldo → 400", r.status === 400, `status=${r.status}`);
    t("saldo intacto", saldoDb(contaJ1b) === antes);
    t("nenhum item gravado", itensDb(charJ1).length === itensAntes);
    t("nenhuma tx gravada", txCount(contaJ1b) === txAntes);
  }

  // ===== 5. Conta de outro personagem =====
  sec("Conta de outro personagem");
  {
    const r = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ2, valor: 5, item: { name: "Roubo" },
    });
    t("conta alheia → 404", r.status === 404, `status=${r.status}`);
    t("saldo do dono intacto", saldoDb(contaJ2) === 5000);
  }

  // ===== 6-9. Venda =====
  sec("Venda com crédito");
  let itemVendaId;
  {
    // compra 5 unidades por 50 → vende 2 por 15
    const c = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 50, quantidade: 5,
      item: { name: "Espada curta" },
    });
    // contaJ1b tem 0 — compra falha; usar contaJ1
    t("setup compra p/ venda", c.status === 400, "esperado 400 (sem saldo)");
    const c2 = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 50, quantidade: 5,
      item: { name: "Espada curta" },
    });
    t("compra da Espada 201", c2.status === 201, `status=${c2.status}`);
    itemVendaId = itensDb(charJ1).find((i) => i.name === "Espada curta")?.id;
    t("item criado", !!itemVendaId);

    const antes = saldoDb(contaJ1b);
    const v = await operacao(charJ1, j1.cookie, {
      tipo: "venda", accountId: contaJ1b, valor: 30, itemId: itemVendaId, quantidade: 2,
    });
    t("venda parcial 201", v.status === 201, `status=${v.status} ${JSON.stringify(v.json).slice(0, 120)}`);
    t("saldo creditado +30.00", saldoDb(contaJ1b) === antes + 3000, `antes=${antes} depois=${saldoDb(contaJ1b)}`);
    t("estoque 5→3", itemDb(itemVendaId)?.quantity === 3, `qtd=${itemDb(itemVendaId)?.quantity}`);

    // venda acima do estoque
    const antes2 = saldoDb(contaJ1b);
    const over = await operacao(charJ1, j1.cookie, {
      tipo: "venda", accountId: contaJ1b, valor: 10, itemId: itemVendaId, quantidade: 10,
    });
    t("venda > estoque → 400", over.status === 400, `status=${over.status}`);
    t("estoque intacto", itemDb(itemVendaId)?.quantity === 3);
    t("saldo intacto", saldoDb(contaJ1b) === antes2);

    // item inexistente
    const ghost = await operacao(charJ1, j1.cookie, {
      tipo: "venda", accountId: contaJ1b, valor: 10, itemId: crypto.randomUUID(),
    });
    t("venda item inexistente → 404", ghost.status === 404, `status=${ghost.status}`);
    t("saldo intacto após 404", saldoDb(contaJ1b) === antes2);
  }

  // ===== 10-13. Rollback / falhas parciais =====
  sec("Falhas não deixam operação pela metade");
  {
    const saldoAntes = saldoDb(contaJ1);
    const txAntes = txCount(contaJ1);
    // débito impossível (saldo insuficiente) com item → nada gravado
    const r1 = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 99999, item: { name: "F also" },
    });
    t("compra impossível → 400", r1.status === 400);
    // template inexistente → 404, sem débito (valor pequeno: saldo da conta é limitado)
    const r2 = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 1, templateId: crypto.randomUUID(),
    });
    t("template inexistente → 404", r2.status === 404, `status=${r2.status}`);
    t("saldo intacto após falhas", saldoDb(contaJ1) === saldoAntes);
    t("tx count intacto", txCount(contaJ1) === txAntes);
    t("nenhum item 'F also'", !itensDb(charJ1).some((i) => i.name === "F also"));
  }

  // ===== 14. Duplo envio (idempotência) =====
  sec("Idempotência");
  {
    const rid = crypto.randomUUID();
    const body = { tipo: "compra", accountId: contaJ1b, valor: 10, item: { name: "Amuleto" }, requestId: rid };
    const [r1, r2] = await Promise.all([
      operacao(charJ1, j1.cookie, body), operacao(charJ1, j1.cookie, body),
    ]);
    const statuses = [r1.status, r2.status].sort();
    t("1×201 + 1×409", statuses[0] === 201 && statuses[1] === 409, statuses.join(","));
    t("um único item Amuleto", itensDb(charJ1).filter((i) => i.name === "Amuleto").length === 1);
    t("uma única tx com requestId", comDb(BANCO, (db) => db.prepare("select count(*) c from money_transactions where request_id=?").get(rid).c) === 1);
  }

  // ===== 15. Duas compras concorrentes (saldo 100 no mestre? usar contaJ1b=30) =====
  sec("Concorrência — compras");
  {
    // credita 100 na contaJ1b para o teste
    await req(BASE, "POST", `/characters/${charJ1}/financeiro/movimentar`, {
      cookie: j1.cookie,
      body: { accountId: contaJ1b, tipo: "entrada", valor: 100, descricao: "fundo teste" },
    });
    const antes = saldoDb(contaJ1b);
    const mk = () => operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 80, item: { name: "Item Corrida" },
    });
    const [r1, r2] = await Promise.all([mk(), mk()]);
    const oks = [r1, r2].filter((r) => r.status === 201).length;
    t("exatamente 1 compra confirmada", oks === 1, `status=${r1.status},${r2.status}`);
    t("saldo = antes - 80 (nunca negativo)", saldoDb(contaJ1b) === antes - 8000, `antes=${antes} depois=${saldoDb(contaJ1b)}`);
    t("um único item Item Corrida", itensDb(charJ1).filter((i) => i.name === "Item Corrida").length === 1);
  }

  // ===== 16. Duas vendas concorrentes =====
  sec("Concorrência — vendas");
  {
    // garante saldo suficiente na contaJ1 para a compra de setup
    await req(BASE, "POST", `/characters/${charJ1}/financeiro/movimentar`, {
      cookie: j1.cookie,
      body: { accountId: contaJ1, tipo: "entrada", valor: 200, descricao: "fundo vendas" },
    });
    // cria item com qtd 3
    const c = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 30, quantidade: 3,
      item: { name: "Poções empilhadas" },
    });
    t("setup compra concorrência", c.status === 201, `status=${c.status}`);
    const itemId = itensDb(charJ1).find((i) => i.name === "Poções empilhadas")?.id;
    const antes = saldoDb(contaJ1b);
    const mk = () => operacao(charJ1, j1.cookie, {
      tipo: "venda", accountId: contaJ1b, valor: 10, itemId, quantidade: 2,
    });
    const [v1, v2] = await Promise.all([mk(), mk()]);
    const oks = [v1, v2].filter((v) => v.status === 201).length;
    t("exatamente 1 venda confirmada", oks === 1, `status=${v1.status},${v2.status}`);
    t("estoque final = 1", itemDb(itemId)?.quantity === 1, `qtd=${itemDb(itemId)?.quantity}`);
    t("saldo creditado uma única vez (+10.00)", saldoDb(contaJ1b) === antes + 1000, `antes=${antes} depois=${saldoDb(contaJ1b)}`);
  }

  // ===== Correção: valor abaixo da menor unidade monetária =====
  sec("Valor que arredonda para zero é rejeitado");
  {
    const saldoAntes = saldoDb(contaJ1b);
    const itensAntes = itensDb(charJ1).length;
    const txAntes = txCount(contaJ1b);
    const casos = [
      ["compra 0.001", { tipo: "compra", accountId: contaJ1b, valor: 0.001, item: { name: "Centavo fracionado" } }],
      ["compra 0.004", { tipo: "compra", accountId: contaJ1b, valor: 0.004, item: { name: "Quase zero" } }],
      ["compra -1", { tipo: "compra", accountId: contaJ1b, valor: -1, item: { name: "Negativo" } }],
      ["compra NaN→null", { tipo: "compra", accountId: contaJ1b, valor: null, item: { name: "NaN" } }],
    ];
    for (const [nome, body] of casos) {
      const r = await operacao(charJ1, j1.cookie, body);
      t(`${nome} → 400`, r.status === 400, `status=${r.status}`);
    }
    // 0.005 arredonda para 1 centavo (meio centavo para cima) → aceito
    const r005 = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 0.005, item: { name: "Meio centavo" },
    });
    t("compra 0.005 → 201 (1 centavo)", r005.status === 201, `status=${r005.status}`);
    const saldoApos005 = saldoDb(contaJ1b);
    t("débito de exatamente 1 centavo", saldoApos005 === saldoAntes - 1, `antes=${saldoAntes} depois=${saldoApos005}`);
    // 0.01 e 1.00 aceitos
    const r001 = await operacao(charJ1, j1.cookie, { tipo: "compra", accountId: contaJ1b, valor: 0.01, item: { name: "Um centavo" } });
    t("compra 0.01 → 201", r001.status === 201, `status=${r001.status}`);
    const r100 = await operacao(charJ1, j1.cookie, { tipo: "compra", accountId: contaJ1b, valor: 1, item: { name: "Um real" } });
    t("compra 1.00 → 201", r100.status === 201, `status=${r100.status}`);
    // nada das rejeitadas vazou (0.01→1 cent + 1.00→100 cent = 101)
    t("saldo consistente após rejeições", saldoDb(contaJ1b) === saldoApos005 - 101, `depois=${saldoDb(contaJ1b)}`);
    t("itens rejeitados não gravados", !itensDb(charJ1).some((i) => ["Centavo fracionado", "Quase zero", "Negativo", "NaN"].includes(i.name)));

    // mesmos valores na VENDA — usa o item "Um real"
    const itemReal = itensDb(charJ1).find((i) => i.name === "Um real");
    const saldoVendAntes = saldoDb(contaJ1b);
    const txVendAntes = txCount(contaJ1b);
    for (const [nome, valor] of [["venda 0.001", 0.001], ["venda 0.004", 0.004], ["venda -1", -1]]) {
      const r = await operacao(charJ1, j1.cookie, { tipo: "venda", accountId: contaJ1b, valor, itemId: itemReal.id });
      t(`${nome} → 400`, r.status === 400, `status=${r.status}`);
    }
    t("estoque intacto após vendas rejeitadas", itemDb(itemReal.id)?.quantity === 1);
    t("saldo intacto após vendas rejeitadas", saldoDb(contaJ1b) === saldoVendAntes);
    t("sem tx de venda rejeitada", txCount(contaJ1b) === txVendAntes);
  }

  // ===== Correção: moeda da conta selecionada =====
  sec("Operação na moeda da conta");
  {
    // configura EUR como moeda secundária da campanha
    const cfgRes = await req(BASE, "PUT", `/campaigns/${cenario.campId}/regras/config`, {
      cookie: mestre, body: { financeiro: { moedas: [{ codigo: "EUR", nome: "Euro", simbolo: "€" }] } },
    });
    t("moeda EUR configurada", cfgRes.status === 200, `status=${cfgRes.status}`);
    const contaEur = await mkConta(charJ1, j1.cookie, "Conta Euro", 50, { currency: "EUR" });
    t("conta EUR criada", !!contaEur);
    const rid = crypto.randomUUID();
    const compra = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaEur, valor: 10, quantidade: 1,
      item: { name: "Mapa EUR" }, requestId: rid,
    });
    t("compra em EUR → 201", compra.status === 201, `status=${compra.status} ${JSON.stringify(compra.json).slice(0, 120)}`);
    const txEur = comDb(BANCO, (db) => db.prepare("select currency,amount_cents,kind from money_transactions where request_id=?").get(rid));
    t("tx registrada em EUR (-10.00)", txEur?.currency === "EUR" && txEur?.amount_cents === -1000, JSON.stringify(txEur));
    const itemEur = itensDb(charJ1).find((i) => i.name === "Mapa EUR");
    const venda = await operacao(charJ1, j1.cookie, {
      tipo: "venda", accountId: contaEur, valor: 12, itemId: itemEur?.id,
    });
    t("venda em EUR → 201", venda.status === 201, `status=${venda.status}`);
    const txVenda = comDb(BANCO, (db) => db.prepare("select currency,amount_cents from money_transactions where kind='venda' and account_id=? order by created_at desc limit 1").get(contaEur));
    t("crédito em EUR (+12.00)", txVenda?.currency === "EUR" && txVenda?.amount_cents === 1200, JSON.stringify(txVenda));
    // saldo EUR: 50 - 10 + 12 = 52
    t("saldo EUR final = 52.00", saldoDb(contaEur) === 5200, `db=${saldoDb(contaEur)}`);
  }

  // ===== Correção: valor unitário de referência após venda parcial =====
  sec("Preço unitário estável após venda parcial");
  {
    // 2 unidades por 20 cada → total 40; depois vende 1 por 20
    const compra = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 40, quantidade: 2,
      item: { name: "Machado de prova" },
    });
    t("compra 2×20 → 201", compra.status === 201, `status=${compra.status}`);
    const item = itensDb(charJ1).find((i) => i.name === "Machado de prova");
    const d1 = JSON.parse(item?.data ?? "{}");
    t("valueCents = unitário (2000), não total", d1.valueCents === 2000, `valueCents=${d1.valueCents}`);
    t("totalValueCents = 4000 preservado", d1.totalValueCents === 4000, `total=${d1.totalValueCents}`);
    const venda = await operacao(charJ1, j1.cookie, {
      tipo: "venda", accountId: contaJ1b, valor: 20, itemId: item.id, quantidade: 1,
    });
    t("venda de 1 unidade → 201", venda.status === 201, `status=${venda.status}`);
    const d2 = JSON.parse(itemDb(item.id)?.data ?? "{}");
    t("unitário permanece 20 após venda parcial (não vira 40)", d2.valueCents === 2000, `valueCents=${d2.valueCents}`);
    t("estoque restante = 1", itemDb(item.id)?.quantity === 1);
    // segunda venda parcial sucessiva
    const v2 = await operacao(charJ1, j1.cookie, {
      tipo: "venda", accountId: contaJ1b, valor: 20, itemId: item.id, quantidade: 1,
    });
    t("segunda venda parcial → 201 (item some)", v2.status === 201, `status=${v2.status}`);
    t("item removido após venda total", !itensDb(charJ1).some((i) => i.id === item.id));
  }

  // ===== Correção: formato explícito de aquisição + itens legados =====
  sec("Compatibilidade com itens antigos");
  {
    // Simula itens persistidos ANTES da correção de semântica:
    // valueCents = TOTAL da compra (não unitário), sem marcador aquisicao.
    // via API (banco travado pelo servidor): valueCents=TOTAL da compra,
    // sem marcador aquisicao — formato anterior à correção de semântica.
    const legado = [
      { name: "Legado qtd1", quantity: 1, valueCents: 2000, data: { origem: "compra", operacaoId: "leg-1" } },
      { name: "Legado qtd2 parcial", quantity: 1, valueCents: 4000, data: { origem: "compra", operacaoId: "leg-2" } }, // era 2, restou 1
      { name: "Legado sem metadados", quantity: 3, valueCents: 900, data: {} },
      { name: "Manual com valor", quantity: 2, valueCents: 500, data: {} },
    ];
    for (const l of legado) {
      const r = await req(BASE, "POST", `/characters/${charJ1}/inventario`, { cookie: j1.cookie, body: l });
      t(`legado "${l.name}" criado → ${r.status}`, r.status === 201, `status=${r.status}`);
    }
    const inv = await req(BASE, "GET", `/characters/${charJ1}/inventario`, { cookie: j1.cookie });
    t("itens legados carregam sem erro", inv.status === 200);
    const nomes = (inv.json?.itens ?? []).map((i) => i.name);
    t("todos os legados presentes", legado.every((l) => nomes.includes(l.name)), nomes.join(","));
    // integridade: dados legados não foram reescritos pelo servidor
    const dLegado = (inv.json?.itens ?? []).find((i) => i.name === "Legado qtd2 parcial")?.data;
    t("valor total legado preservado (4000, não reinterpretado)", dLegado?.valueCents === 4000 && !dLegado?.aquisicao, JSON.stringify(dLegado));
  }

  // ===== Correção: item novo grava formato explícito =====
  sec("Formato explícito de aquisição (item novo)");
  {
    const c = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 40, quantidade: 2,
      item: { name: "Item formato v1" },
    });
    t("compra formato → 201", c.status === 201, `status=${c.status}`);
    const item = itensDb(charJ1).find((i) => i.name === "Item formato v1");
    const d = JSON.parse(item?.data ?? "{}");
    t("aquisicao.formato = unitario-v1", d.aquisicao?.formato === "unitario-v1", JSON.stringify(d.aquisicao));
    t("aquisicao.unitCents = 2000", d.aquisicao?.unitCents === 2000);
    t("aquisicao.totalCents = 4000", d.aquisicao?.totalCents === 4000);
    t("aquisicao.qtdOriginal = 2", d.aquisicao?.qtdOriginal === 2);
    t("valueCents unitário = 2000", d.valueCents === 2000);
    // venda parcial não altera o histórico de aquisição
    await operacao(charJ1, j1.cookie, { tipo: "venda", accountId: contaJ1b, valor: 20, itemId: item.id, quantidade: 1 });
    const d2 = JSON.parse(itemDb(item.id)?.data ?? "{}");
    t("aquisicao preservada após venda parcial", d2.aquisicao?.unitCents === 2000 && d2.aquisicao?.qtdOriginal === 2 && d2.totalValueCents === 4000, JSON.stringify(d2.aquisicao));
  }

  // ===== Correção: preservação dos dados do catálogo =====
  sec("Dados do template preservados na compra");
  {
    // garante saldo na conta de teste (seções anteriores já movimentaram)
    await req(BASE, "POST", `/characters/${charJ1}/financeiro/movimentar`, {
      cookie: j1.cookie,
      body: { accountId: contaJ1b, tipo: "entrada", valor: 500, descricao: "fundo template" },
    });
    const tpl2 = await req(BASE, "POST", `/campaigns/${cenario.campId}/inventario`, {
      cookie: mestre,
      body: { name: "Relíquia Antiga", category: "Artefato", data: { raridade: "lendaria", poder: 10, cargas: 3 } },
    });
    const tpl2Id = tpl2.json?.id;
    t("template com atributos criado", tpl2.status === 201 && !!tpl2Id, `status=${tpl2.status}`);

    // Caso A: item sem data → atributos do template preservados
    const ridA = crypto.randomUUID();
    const compraA = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 30, templateId: tpl2Id,
      item: { name: "Relíquia Antiga" }, requestId: ridA,
    });
    t("compra A (sem personalização) → 201", compraA.status === 201, `status=${compraA.status}`);
    const itemA = itensDb(charJ1).find((i) => i.name === "Relíquia Antiga" && JSON.parse(i.data ?? "{}").operacaoId === ridA);
    const dA = JSON.parse(itemA?.data ?? "{}");
    t("A: raridade/poder/cargas do template preservados", dA.raridade === "lendaria" && dA.poder === 10 && dA.cargas === 3, JSON.stringify(dA));
    t("A: templateId gravado", dA.templateId === tpl2Id);

    // Caso B: personalização sobrepõe só o campo alterado
    const ridB = crypto.randomUUID();
    const compraB = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 30, templateId: tpl2Id,
      item: { name: "Relíquia Antiga", data: { poder: 99 } }, requestId: ridB,
    });
    t("compra B (personalizada) → 201", compraB.status === 201, `status=${compraB.status}`);
    const itemB = itensDb(charJ1).filter((i) => i.name === "Relíquia Antiga").map((i) => JSON.parse(i.data ?? "{}")).find((d) => d.operacaoId === ridB);
    t("B: poder personalizado prevalece (99)", itemB?.poder === 99, JSON.stringify(itemB));
    t("B: demais atributos preservados", itemB?.raridade === "lendaria" && itemB?.cargas === 3);

    // Caso C: tentativa de sobrescrever campos internos protegidos
    const ridC = crypto.randomUUID();
    const compraC = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 30, templateId: tpl2Id,
      item: { name: "Relíquia Antiga", data: {
        poder: 1, operacaoId: "hack", valueCents: 1, totalValueCents: 1,
        aquisicao: { formato: "fake" }, origem: "manual", templateId: "outro",
      } }, requestId: ridC,
    });
    t("compra C → 201", compraC.status === 201, `status=${compraC.status}`);
    const dC = itensDb(charJ1).map((i) => JSON.parse(i.data ?? "{}")).find((d) => d.operacaoId === ridC);
    t("C: operacaoId do servidor prevalece", dC?.operacaoId === ridC, JSON.stringify(dC?.operacaoId));
    t("C: origem = compra (não manual)", dC?.origem === "compra");
    t("C: aquisicao.formato = unitario-v1", dC?.aquisicao?.formato === "unitario-v1");
    t("C: templateId do servidor prevalece", dC?.templateId === tpl2Id);
    t("C: poder personalizado preservado", dC?.poder === 1);
    t("C: raridade do template preservada", dC?.raridade === "lendaria");
    // vínculo financeiro ↔ item ↔ auditoria
    const txC = comDb(BANCO, (db) => db.prepare("select kind,request_id from money_transactions where request_id=?").get(ridC));
    t("C: tx financeira vinculada por requestId", txC?.kind === "compra" && txC?.request_id === ridC);
  }

  // ===== Correção: unitário não representável não vira sugestão =====
  sec("Preço unitário de baixo valor");
  {
    const cenarios = [
      ["2un por 1 cent", 2, 0.01],
      ["3un por 1 cent", 3, 0.01],
      ["2un por 3 cents", 2, 0.03],
      ["3un por 10 cents", 3, 0.10],
    ];
    for (const [nome, qtd, valor] of cenarios) {
      const saldoAntes = saldoDb(contaJ1b);
      const r = await operacao(charJ1, j1.cookie, {
        tipo: "compra", accountId: contaJ1b, valor, quantidade: qtd,
        item: { name: `Baixo valor ${nome}` },
      });
      t(`${nome} → 201 (operação válida)`, r.status === 201, `status=${r.status}`);
      const esperado = Math.round(valor * 100);
      t(`${nome}: débito exato de ${esperado} centavo(s)`, saldoDb(contaJ1b) === saldoAntes - esperado, `antes=${saldoAntes} depois=${saldoDb(contaJ1b)}`);
      const item = itensDb(charJ1).find((i) => i.name === `Baixo valor ${nome}`);
      const d = JSON.parse(item?.data ?? "{}");
      t(`${nome}: unitCents = null (não inventa preço)`, d.aquisicao?.unitCents === null, JSON.stringify(d.aquisicao));
      t(`${nome}: totalCents preservado`, d.aquisicao?.totalCents === esperado && d.totalValueCents === esperado);
      t(`${nome}: qtdOriginal gravada`, d.aquisicao?.qtdOriginal === qtd);
      t(`${nome}: valueCents ausente (sem sugestão)`, d.valueCents === undefined, `valueCents=${d.valueCents}`);
      // venda parcial não deve criar unitário retroativo
      if (qtd >= 2) {
        await operacao(charJ1, j1.cookie, { tipo: "venda", accountId: contaJ1b, valor: 0.01, itemId: item.id, quantidade: 1 });
        const d2 = JSON.parse(itemDb(item.id)?.data ?? "{}");
        t(`${nome}: unitCents continua null após venda parcial`, d2.aquisicao?.unitCents === null);
        t(`${nome}: totalCents histórico intacto`, d2.aquisicao?.totalCents === esperado);
      }
    }
    // caso representável: 2un por 2 cents → unitário 1 centavo exato
    const rOk = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 0.02, quantidade: 2,
      item: { name: "Unitario exato" },
    });
    t("2un por 2 cents → 201", rOk.status === 201, `status=${rOk.status}`);
    const dOk = JSON.parse(itensDb(charJ1).find((i) => i.name === "Unitario exato")?.data ?? "{}");
    t("unitCents = 1 (representável)", dOk.aquisicao?.unitCents === 1 && dOk.valueCents === 1, JSON.stringify(dOk.aquisicao));
  }

  // ===== 17. Históricos coerentes =====
  sec("Histórico financeiro ↔ patrimônio");
  {
    const hist = await req(BASE, "GET", `/characters/${charJ1}/financeiro`, { cookie: j1.cookie });
    const compras = hist.json?.historico?.filter((x) => x.kind === "compra") ?? [];
    const vendas = hist.json?.historico?.filter((x) => x.kind === "venda") ?? [];
    t("histórico lista compras e vendas", compras.length >= 3 && vendas.length >= 2, `compras=${compras.length} vendas=${vendas.length}`);
    t("descrição da venda traz o nome do item", vendas.some((x) => (x.description ?? "").includes("Espada curta") || (x.counterparty ?? "") === "Espada curta" || (x.description ?? "").includes("Poções")), JSON.stringify(vendas.map((x) => x.description)));
    const amuleto = itensDb(charJ1).find((i) => i.name === "Amuleto");
    const opId = JSON.parse(amuleto?.data ?? "{}").operacaoId;
    const txOp = comDb(BANCO, (db) => db.prepare("select kind,request_id from money_transactions where request_id=?").get(opId));
    t("vínculo item↔tx via operacaoId", txOp?.kind === "compra", `opId=${opId} tx=${JSON.stringify(txOp)}`);
  }

  // ===== 18. Permissões =====
  sec("Permissões");
  {
    // jogador1 opera a própria ficha (já provado). Mestre opera ficha do jogador?
    // acesso: mestre pode operar qualquer personagem da campanha
    const r = await operacao(charJ1, mestre, {
      tipo: "compra", accountId: contaJ1, valor: 5, item: { name: "Presente do Mestre" },
    });
    t("mestre opera ficha do jogador → 201", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
    // jogador2 tenta operar ficha do jogador1 → 403/404
    const j2 = cenario.jogadores.jogador2;
    const r2 = await operacao(charJ1, j2.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 5, item: { name: "Invasão" },
    });
    t("jogador alheio → 403/404", [403, 404].includes(r2.status), `status=${r2.status}`);
    // desliga jogadorCompraVenda via API de configuração e tenta novamente
    const cfgRes = await req(BASE, "PUT", `/campaigns/${cenario.campId}/regras/config`, {
      cookie: mestre, body: { financeiro: { jogadorCompraVenda: false } },
    });
    t("config atualizada", cfgRes.status === 200, `status=${cfgRes.status} ${JSON.stringify(cfgRes.json).slice(0, 120)}`);
    const r3 = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 5, item: { name: "Proibido" },
    });
    t("jogadorCompraVenda=false → 403", r3.status === 403, `status=${r3.status}`);
    const r4 = await operacao(charJ1, mestre, {
      tipo: "compra", accountId: contaJ1, valor: 5, item: { name: "Mestre livre" },
    });
    t("mestre não é bloqueado pela política", r4.status === 201, `status=${r4.status}`);
    // restaura a política para as seções seguintes
    await req(BASE, "PUT", `/campaigns/${cenario.campId}/regras/config`, {
      cookie: mestre, body: { financeiro: { jogadorCompraVenda: true } },
    });
  }

  // ===== 19. Persistência após restart =====
  sec("Persistência após reinício");
  {
    const saldoAntes = saldoDb(contaJ1);
    const qtdAntes = itensDb(charJ1).length;
    await encerrarServidor(proc);
    proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    await esperarSaudavel(BASE, proc);
    t("saldo persiste após restart", saldoDb(contaJ1) === saldoAntes, `antes=${saldoAntes} depois=${saldoDb(contaJ1)}`);
    t("inventário persiste após restart", itensDb(charJ1).length === qtdAntes);
    const hist = await req(BASE, "GET", `/characters/${charJ1}/financeiro`, { cookie: j1.cookie });
    t("histórico persiste após restart", (hist.json?.historico?.length ?? 0) > 0);
  }

  // ===== 20. Regressão: fluxos antigos =====
  sec("Regressão de fluxões antigos");
  {
    // movimentação simples continua funcionando
    const antes = saldoDb(contaJ1b);
    const m = await req(BASE, "POST", `/characters/${charJ1}/financeiro/movimentar`, {
      cookie: j1.cookie,
      body: { accountId: contaJ1b, tipo: "entrada", valor: 7, descricao: "regressão" },
    });
    t("movimentação simples 201", m.status === 201, `status=${m.status}`);
    t("saldo +7.00", saldoDb(contaJ1b) === antes + 700, `antes=${antes} depois=${saldoDb(contaJ1b)}`);
    // cadastro de item sem pagamento continua
    const i = await req(BASE, "POST", `/characters/${charJ1}/inventario`, {
      cookie: j1.cookie, body: { name: "Grátis", quantity: 2 },
    });
    t("cadastro sem pagamento 201", i.status === 201, `status=${i.status}`);
  }
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
