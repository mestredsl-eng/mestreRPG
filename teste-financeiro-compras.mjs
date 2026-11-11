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
