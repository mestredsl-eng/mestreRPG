// Testes — integração financeiro ↔ compras/vendas: compra sem
// movimentação, vínculo explícito tx↔item, estorno atômico, edição
// preservando histórico, permissões, isolamento e concorrência.
// Banco 100% temporário via teste-base.mjs.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, comDb, sessao, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("fin-integracao");
const BANCO = `${DIR}/teste.db`;

const saldoDb = (contaId) => comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
const txDe = (requestId) => comDb(BANCO, (db) => db.prepare("select * from money_transactions where request_id=? order by created_at").all(requestId));
const txCount = (contaId) => comDb(BANCO, (db) => db.prepare("select count(*) c from money_transactions where account_id=?").get(contaId).c);
const itensDb = (charId) => comDb(BANCO, (db) => db.prepare("select id,name,quantity,data from inventory_entries where character_id=? order by created_at").all(charId));
const itemDb = (itemId) => comDb(BANCO, (db) => db.prepare("select id,quantity,data from inventory_entries where id=?").get(itemId));
const operacaoDb = (requestId) => comDb(BANCO, (db) => db.prepare("select * from money_transactions where request_id=?").get(requestId));

// INSERT direto de usuário+membership+personagem+ruleset (mesmo padrão
// de criarCenario) para cenários de permissão isolados.
async function cenarioExtraDb({ campanhaId, config = {}, role = "jogador", personagemNome = "Extra" } = {}) {
  const db = abrirDb(BANCO);
  try {
    const agora = Date.now();
    const uid = crypto.randomUUID();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, `user_${uid.slice(0, 8)}`, "Extra", await hashSenha("senha-x-123"), agora, agora);
    const mid = crypto.randomUUID();
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'" + role + "','ativo',?,?,?)")
      .run(mid, campanhaId, uid, agora, agora, agora);
    const charId = crypto.randomUUID();
    db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(charId, campanhaId, mid, null, personagemNome, "{}", "{}", "aprovada", 0, agora, agora);
    if (Object.keys(config).length) {
      let rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campanhaId);
      if (!rs) {
        const id = crypto.randomUUID();
        db.prepare("insert into rule_sets (id,campaign_id,name,version,is_active,config,created_at,updated_at) values (?,?,?,?,1,?,?,?)")
          .run(id, campanhaId, "Regras", 1, "{}", agora, agora);
        rs = { id, config: "{}" };
      }
      const cfg = JSON.parse(rs.config || "{}");
      for (const [k, v] of Object.entries(config)) cfg[k] = v;
      db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
    }
    return { userId: uid, membershipId: mid, characterId: charId, cookie: sessao(BANCO, uid) };
  } finally { db.close(); }
}

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Fin", jogadores: { jogador1: "jogador_um", jogador2: "jogador_dois" },
    config: { financeiro: { permitirSaldoNegativo: false, jogadorCompraVenda: true } },
  });
  const mestre = cenario.cookieMestre;
  const charMestre = cenario.personagemMestre;
  const j1 = cenario.jogadores.jogador1;
  const j2 = cenario.jogadores.jogador2;
  const charJ1 = cenario.novoPersonagem(j1.membershipId, "Heroína");
  const charJ2 = cenario.novoPersonagem(j2.membershipId, "Arqueiro");

  const mkConta = async (charId, cookie, name, saldo, extra = {}) => {
    const r = await req(BASE, "POST", `/characters/${charId}/financeiro/contas`, {
      cookie, body: { type: "especie", name, balanceReais: saldo, ...extra },
    });
    return r.json?.id;
  };
  const operacao = (charId, cookie, body) =>
    req(BASE, "POST", `/characters/${charId}/financeiro/operacao`, { cookie, body });
  const estornar = (charId, cookie, opId) =>
    req(BASE, "POST", `/characters/${charId}/financeiro/operacoes/${opId}/estornar`, { cookie });

  const contaJ1 = await mkConta(charJ1, j1.cookie, "Poupança", 100);
  const contaJ1b = await mkConta(charJ1, j1.cookie, "Moedas", 0);
  const contaM = await mkConta(charMestre, mestre, "Bolso Mestre", 200);
  t("contas criadas", !!(contaJ1 && contaJ1b && contaM));

  // ===== 1. Compra com débito válido + vínculo explícito =====
  sec("1. Compra com débito e vínculo tx↔item");
  {
    const rid = "op-compra-1";
    const antes = saldoDb(contaJ1);
    const r = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 30, quantidade: 2,
      item: { name: "Pão Arcano", quantity: 1 }, requestId: rid,
    });
    t("compra 201", r.status === 201, `status=${r.status} ${JSON.stringify(r.json)}`);
    t("saldo debitado -30.00", saldoDb(contaJ1) === antes - 3000, `antes=${antes} depois=${saldoDb(contaJ1)}`);
    const item = itensDb(charJ1).find((i) => i.name === "Pão Arcano");
    t("item criado qtd 2", item?.quantity === 2, JSON.stringify(item));
    const tx = operacaoDb(rid);
    t("tx kind=compra -3000", tx?.kind === "compra" && tx?.amount_cents === -3000, JSON.stringify(tx));
    t("tx vinculada ao item (inventory_item_id)", tx?.inventory_item_id === item?.id, `${tx?.inventory_item_id} vs ${item?.id}`);
    const meta = tx?.operacao ? JSON.parse(tx.operacao) : null;
    t("operacao meta: tipo/quantidade/conta", meta?.tipo === "compra" && meta?.quantidade === 2 && meta?.contaId === contaJ1 && meta?.itemId === item?.id, JSON.stringify(meta));
    t("saldo na resposta", r.json?.saldo === 70, JSON.stringify(r.json));
  }

  // ===== 2. Compra sem movimentação =====
  sec("2. Compra sem pagamento (sem débito fictício)");
  {
    const rid = "op-sem-pag-1";
    const antes = saldoDb(contaJ1);
    const txAntes = txCount(contaJ1);
    const r = await operacao(charJ1, j1.cookie, {
      tipo: "compra", pagar: false, quantidade: 1,
      item: { name: "Relíquia Found", quantity: 1 }, requestId: rid,
    });
    t("compra sem pagamento 201", r.status === 201 && r.json?.semMovimentacao === true, `status=${r.status} ${JSON.stringify(r.json)}`);
    t("saldo intacto", saldoDb(contaJ1) === antes, `${antes} vs ${saldoDb(contaJ1)}`);
    t("nenhuma tx criada", txCount(contaJ1) === txAntes, `${txAntes} vs ${txCount(contaJ1)}`);
    const item = itensDb(charJ1).find((i) => i.name === "Relíquia Found");
    t("item criado mesmo sem pagamento", !!item, "");
    const d = JSON.parse(item?.data ?? "{}");
    t("operacaoId gravado + semPagamento", d.operacaoId === rid && d.aquisicao?.semPagamento === true, JSON.stringify(d).slice(0, 200));
    t("saldo null na resposta", r.json?.saldo === null, JSON.stringify(r.json));
  }

  // ===== 3-4. Compra saldo insuficiente / conta inválida =====
  sec("3-4. Rejeições de compra");
  {
    const antes = saldoDb(contaJ1b);
    const itensAntes = itensDb(charJ1).length;
    const txAntes = txCount(contaJ1b);
    const r1 = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1b, valor: 50,
      item: { name: "Item Caro", quantity: 1 }, requestId: "op-sem-saldo",
    });
    t("compra sem saldo → 400", r1.status === 400, `status=${r1.status}`);
    t("saldo intacto", saldoDb(contaJ1b) === antes);
    t("nenhum item gravado (rollback)", itensDb(charJ1).length === itensAntes);
    t("nenhuma tx gravada (rollback)", txCount(contaJ1b) === txAntes);

    const r2 = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: "conta-inexistente", valor: 10,
      item: { name: "Item X", quantity: 1 }, requestId: "op-conta-ruim",
    });
    t("conta inválida → 404", r2.status === 404, `status=${r2.status}`);
    t("conta de OUTRO personagem → 404", (await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaM, valor: 10,
      item: { name: "Item Y", quantity: 1 }, requestId: "op-conta-alheia",
    })).status === 404);
    t("pagar=true sem accountId → 400", (await operacao(charJ1, j1.cookie, {
      tipo: "compra", valor: 10, item: { name: "Z", quantity: 1 }, requestId: "op-sem-conta",
    })).status === 400);
    t("venda pagar=false → 400", (await operacao(charJ1, j1.cookie, {
      tipo: "venda", pagar: false, itemId: "x", requestId: "op-venda-sem",
    })).status === 400);
  }

  // ===== 5-6. Falhas intermediárias → rollback total =====
  sec("5-6. Falha no patrimônio / na transação");
  {
    const antes = saldoDb(contaJ1);
    const itensAntes = itensDb(charJ1).length;
    const txAntes = txCount(contaJ1);
    const r1 = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 20, templateId: "tpl-inexistente",
      requestId: "op-tpl-falha",
    });
    t("template inexistente → 404", r1.status === 404, `status=${r1.status}`);
    t("saldo intacto após falha", saldoDb(contaJ1) === antes);
    t("itens intactos", itensDb(charJ1).length === itensAntes);
    t("tx intactas", txCount(contaJ1) === txAntes);

    // requestId duplicado: a "falha na criação da transação" desfaz
    // também o item — prova de atomicidade compra+financeiro.
    const dup = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 30, quantidade: 2,
      item: { name: "Pão Arcano", quantity: 1 }, requestId: "op-compra-1",
    });
    t("requestId duplicado → 409", dup.status === 409, `status=${dup.status}`);
    t("nenhum item duplicado", itensDb(charJ1).filter((i) => i.name === "Pão Arcano").length === 1);
    t("nenhuma tx duplicada", txDe("op-compra-1").length === 1);
    t("saldo não debitou 2×", saldoDb(contaJ1) === antes, `${antes} vs ${saldoDb(contaJ1)}`);

    const dup2 = await operacao(charJ1, j1.cookie, {
      tipo: "compra", pagar: false, item: { name: "Relíquia Found", quantity: 1 }, requestId: "op-sem-pag-1",
    });
    t("sem-pagamento duplicado → 409", dup2.status === 409, `status=${dup2.status}`);
    t("sem-pagamento: 1 único item", itensDb(charJ1).filter((i) => i.name === "Relíquia Found").length === 1);
  }

  // ===== 7-9. Venda =====
  sec("7-9. Venda com crédito e rejeições");
  {
    const prep = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 50, quantidade: 5,
      item: { name: "Espada Venda", quantity: 1 }, requestId: "op-setup-venda",
    });
    t("setup compra 201", prep.status === 201, `status=${prep.status}`);
    const itemVenda = itensDb(charJ1).find((i) => i.name === "Espada Venda");
    const antes = saldoDb(contaJ1b);

    const v = await operacao(charJ1, j1.cookie, {
      tipo: "venda", accountId: contaJ1b, valor: 30, itemId: itemVenda.id, quantidade: 2, requestId: "op-venda-1",
    });
    t("venda parcial 201", v.status === 201, `status=${v.status} ${JSON.stringify(v.json)}`);
    t("saldo creditado +30", saldoDb(contaJ1b) === antes + 3000, `${antes} vs ${saldoDb(contaJ1b)}`);
    t("estoque 5→3", itemDb(itemVenda.id)?.quantity === 3, `qtd=${itemDb(itemVenda.id)?.quantity}`);
    const txV = operacaoDb("op-venda-1");
    t("tx venda +3000 vinculada", txV?.kind === "venda" && txV?.amount_cents === 3000 && txV?.inventory_item_id === itemVenda.id, JSON.stringify(txV));
    const metaV = txV?.operacao ? JSON.parse(txV.operacao) : null;
    t("meta venda tem snapshot do item", metaV?.tipo === "venda" && metaV?.quantidade === 2 && !!metaV?.item?.name, JSON.stringify(metaV).slice(0, 200));

    const rInv = await operacao(charJ1, j1.cookie, {
      tipo: "venda", accountId: "conta-ruim", valor: 10, itemId: itemVenda.id, requestId: "op-venda-ruim",
    });
    t("venda conta inválida → 404", rInv.status === 404, `status=${rInv.status}`);

    const antes2 = saldoDb(contaJ1b);
    const rOver = await operacao(charJ1, j1.cookie, {
      tipo: "venda", accountId: contaJ1b, valor: 10, itemId: itemVenda.id, quantidade: 99, requestId: "op-venda-over",
    });
    t("venda > estoque → 400", rOver.status === 400, `status=${rOver.status}`);
    t("saldo intacto após falha", saldoDb(contaJ1b) === antes2);
    t("estoque intacto", itemDb(itemVenda.id)?.quantity === 3);
    t("sem tx da venda falha", !operacaoDb("op-venda-over"));
  }

  // ===== 10-11. Duplicidade e consistência saldo×histórico =====
  sec("10-11. Idempotência e consistência");
  {
    const itemVenda = itensDb(charJ1).find((i) => i.name === "Espada Venda");
    const antes = saldoDb(contaJ1b);
    const dupBody = { tipo: "venda", accountId: contaJ1b, valor: 30, itemId: itemVenda.id, quantidade: 1, requestId: "op-venda-dup" };
    const [v1, v2] = await Promise.all([
      operacao(charJ1, j1.cookie, dupBody),
      operacao(charJ1, j1.cookie, dupBody),
    ]);
    const oks = [v1, v2].filter((r) => r.status === 201).length;
    t("vendas simultâneas mesmo requestId: 1 ok", oks === 1, `${v1.status},${v2.status}`);
    t("um único crédito", saldoDb(contaJ1b) === antes + 3000, `${antes} vs ${saldoDb(contaJ1b)}`);
    t("uma única tx", txDe("op-venda-dup").length === 1);

    const soma = comDb(BANCO, (db) => db.prepare("select coalesce(sum(amount_cents),0) s from money_transactions where account_id=?").get(contaJ1b).s);
    t("saldo = inicial + soma das tx", saldoDb(contaJ1b) === soma, `saldo=${saldoDb(contaJ1b)} soma=${soma}`);
  }

  // ===== 12. Edição de operação preserva financeiro =====
  sec("12. Edição de item não toca histórico financeiro");
  {
    const item = itensDb(charJ1).find((i) => i.name === "Pão Arcano");
    const txAntes = txDe("op-compra-1");
    const saldoAntes = saldoDb(contaJ1);
    const patch = await req(BASE, "PATCH", `/characters/${charJ1}/inventario/${item.id}`, {
      cookie: j1.cookie, body: { name: "Pão Arcano Refinado", description: "editado" },
    });
    t("edição do item 200", patch.status === 200, `status=${patch.status}`);
    t("tx original intacta", JSON.stringify(txDe("op-compra-1")) === JSON.stringify(txAntes));
    t("saldo intacto", saldoDb(contaJ1) === saldoAntes);
    t("vínculo tx→item preservado", operacaoDb("op-compra-1")?.inventory_item_id === item.id);
  }

  // ===== 13. Estorno (cancelamento) =====
  sec("13. Estorno de compra e venda");
  {
    const antes = saldoDb(contaJ1);
    const e1 = await estornar(charJ1, j1.cookie, "op-compra-1");
    t("estorno compra 200", e1.status === 200, `status=${e1.status} ${JSON.stringify(e1.json)}`);
    t("saldo estornado +30", saldoDb(contaJ1) === antes + 3000, `${antes} vs ${saldoDb(contaJ1)}`);
    t("item removido do inventário", !itensDb(charJ1).some((i) => i.name === "Pão Arcano Refinado"));
    const txEst = txDe("op-compra-1:estorno");
    t("tx estorno +3000 kind=estorno", txEst.length === 1 && txEst[0].kind === "estorno" && txEst[0].amount_cents === 3000, JSON.stringify(txEst));
    t("tx original preservada", txDe("op-compra-1").length === 1 && txDe("op-compra-1")[0].kind === "compra");
    const eDup = await estornar(charJ1, j1.cookie, "op-compra-1");
    t("estorno duplicado → 409", eDup.status === 409, `status=${eDup.status}`);

    const antesV = saldoDb(contaJ1b);
    const itemVenda = itensDb(charJ1).find((i) => i.name === "Espada Venda");
    const e2 = await estornar(charJ1, j1.cookie, "op-venda-1");
    t("estorno venda 200", e2.status === 200, `status=${e2.status} ${JSON.stringify(e2.json)}`);
    t("débito do estorno -30", saldoDb(contaJ1b) === antesV - 3000, `${antesV} vs ${saldoDb(contaJ1b)}`);
    // 5 -2 (venda-1) -1 (venda-dup) = 2; estorno devolve 2 → 4
    t("unidades devolvidas (2→4)", itemDb(itemVenda.id)?.quantity === 4, `qtd=${itemDb(itemVenda.id)?.quantity}`);
    t("tx estorno venda -3000", txDe("op-venda-1:estorno")[0]?.amount_cents === -3000);

    // ---- compra sem pagamento: estorno persistente e idempotente ----
    const e3 = await estornar(charJ1, j1.cookie, "op-sem-pag-1");
    t("estorno sem-pagamento 200", e3.status === 200 && e3.json?.semMovimentacao === true, `status=${e3.status}`);
    t("item sem-pagamento removido", !itensDb(charJ1).some((i) => i.name === "Relíquia Found"));
    t("sem tx de estorno para sem-pagamento", txDe("op-sem-pag-1:estorno").length === 0);
    // saldo = antes + estorno da compra paga (e1); e3 não movimenta nada
    t("saldo intacto no estorno sem-pagamento", saldoDb(contaJ1) === antes + 3000, `saldo=${saldoDb(contaJ1)}`);

    // registro persistente do estorno (tabela dedicada, não volátil)
    const regEstorno = comDb(BANCO, (db) => db.prepare("select * from operacao_estornos where campaign_id=? and operacao_id=?")
      .get(cenario.campId, "op-sem-pag-1"));
    t("estorno sem-pagamento gravado em operacao_estornos", !!regEstorno && regEstorno.tipo === "compra_sem_pagamento", JSON.stringify(regEstorno));
    // reabre o arquivo do zero: o registro é persistente, não volátil
    const regReaberto = (() => { const w = abrirDb(BANCO); try { return w.prepare("select operacao_id from operacao_estornos where operacao_id=?").get("op-sem-pag-1"); } finally { w.close(); } })();
    t("registro de estorno sobrevive à reabertura do banco", !!regReaberto, "");

    // segunda tentativa → 409 (não 404), mesmo com item já removido
    const e3b = await estornar(charJ1, j1.cookie, "op-sem-pag-1");
    t("2ª tentativa de estorno sem-pagamento → 409", e3b.status === 409, `status=${e3b.status}`);
    t("2ª tentativa não cria tx fictícia", txDe("op-sem-pag-1:estorno").length === 0);
    t("2ª tentativa não altera saldo", saldoDb(contaJ1) === antes + 3000);

    // duas tentativas simultâneas → exatamente um sucesso
    const dupSemPag = await operacao(charJ1, j1.cookie, {
      tipo: "compra", pagar: false, item: { name: "Bugiganga", quantity: 1 }, requestId: "op-sem-pag-corrida",
    });
    t("setup compra sem-pagamento p/ corrida 201", dupSemPag.status === 201, `status=${dupSemPag.status}`);
    const [eA, eB] = await Promise.all([
      estornar(charJ1, j1.cookie, "op-sem-pag-corrida"),
      estornar(charJ1, j1.cookie, "op-sem-pag-corrida"),
    ]);
    const estOks = [eA, eB].filter((r) => r.status === 200).length;
    const estConflitos = [eA, eB].filter((r) => r.status === 409).length;
    t("estornos simultâneos: 1×200 + 1×409", estOks === 1 && estConflitos === 1, `${eA.status},${eB.status}`);
    t("item da corrida removido uma única vez", !itensDb(charJ1).some((i) => i.name === "Bugiganga"));
    const regsCorrida = comDb(BANCO, (db) => db.prepare("select count(*) c from operacao_estornos where operacao_id=?").get("op-sem-pag-corrida").c);
    t("um único registro de estorno na corrida", regsCorrida === 1, `regs=${regsCorrida}`);

    // item alterado (quantidade diverge do original) → estorno bloqueado
    const mv = await operacao(charJ1, j1.cookie, {
      tipo: "compra", pagar: false, quantidade: 2,
      item: { name: "Pilha Proibida", quantity: 1 }, requestId: "op-sem-pag-mov",
    });
    t("setup compra sem-pagamento qtd2 201", mv.status === 201, `status=${mv.status}`);
    const itemMov = itensDb(charJ1).find((i) => i.name === "Pilha Proibida");
    await req(BASE, "PATCH", `/characters/${charJ1}/inventario/${itemMov.id}`, {
      cookie: j1.cookie, body: { quantity: 3 },
    });
    const eMov = await estornar(charJ1, j1.cookie, "op-sem-pag-mov");
    t("item com quantidade alterada → 409", eMov.status === 409, `status=${eMov.status}`);
    t("item alterado preservado", itemDb(itemMov.id)?.quantity === 3);
    t("sem registro de estorno para operação bloqueada", !comDb(BANCO, (db) => db.prepare("select id from operacao_estornos where operacao_id=?").get("op-sem-pag-mov")));

    t("estorno inexistente → 404", (await estornar(charJ1, j1.cookie, "op-fantasma")).status === 404);
  }

  // ===== 14. Permissões =====
  sec("14. Permissões");
  {
    // Campanha B com jogadorCompraVenda=false — jogador bloqueado.
    const c2 = await req(BASE, "POST", "/campaigns", { cookie: mestre, body: { name: "Campanha Sem Compra" } });
    const campB = c2.json?.campanha?.id;
    t("campanha B criada", c2.status === 201 || c2.status === 200, `status=${c2.status}`);

    const bloqueado = await cenarioExtraDb({
      campanhaId: campB, config: { financeiro: { jogadorCompraVenda: false } },
      personagemNome: "Bloqueado",
    });
    const contaBloq = await mkConta(bloqueado.characterId, bloqueado.cookie, "Conta", 100);
    const rComp = await operacao(bloqueado.characterId, bloqueado.cookie, {
      tipo: "compra", accountId: contaBloq, valor: 10,
      item: { name: "X", quantity: 1 }, requestId: "op-bloq-1",
    });
    t("jogadorCompraVenda=false → compra 403", rComp.status === 403, `status=${rComp.status}`);
    const rVen = await operacao(bloqueado.characterId, bloqueado.cookie, {
      tipo: "venda", accountId: contaBloq, valor: 10, itemId: "x", requestId: "op-bloq-2",
    });
    t("jogadorCompraVenda=false → venda 403", rVen.status === 403, `status=${rVen.status}`);
    const rEst = await estornar(bloqueado.characterId, bloqueado.cookie, "op-x");
    t("jogadorCompraVenda=false → estorno 403", rEst.status === 403, `status=${rEst.status}`);

    // Outro jogador da MESMA campanha não acessa o personagem alheio.
    const rAlheio = await req(BASE, "GET", `/characters/${charJ1}/financeiro`, { cookie: j2.cookie });
    t("jogador2 sem acesso ao charJ1 → 403", rAlheio.status === 403, `status=${rAlheio.status}`);
    const rOpAlheia = await operacao(charJ1, j2.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 5,
      item: { name: "Roubo", quantity: 1 }, requestId: "op-alheio",
    });
    t("operação em personagem alheio → 403", rOpAlheia.status === 403, `status=${rOpAlheia.status}`);

    // Personagem arquivado → somente leitura (conta criada antes).
    const contaJ2 = await mkConta(charJ2, j2.cookie, "Conta J2", 50);
    const arq = await req(BASE, "POST", `/characters/${charJ2}/arquivar`, { cookie: mestre });
    t("arquivar charJ2", arq.status === 200 || arq.status === 201, `status=${arq.status}`);
    const rArq = contaJ2 ? await operacao(charJ2, j2.cookie, {
      tipo: "compra", pagar: false, item: { name: "Tardio", quantity: 1 }, requestId: "op-arquivado",
    }) : { status: 0 };
    t("personagem arquivado → 403", rArq.status === 403, `status=${rArq.status}`);
    await req(BASE, "POST", `/characters/${charJ2}/desarquivar`, { cookie: mestre });
  }

  // ===== 15. Isolamento entre campanhas =====
  sec("15. Isolamento campanhas/personagens");
  {
    const campB2 = (await req(BASE, "POST", "/campaigns", { cookie: mestre, body: { name: "Campanha Fin B" } })).json?.campanha?.id;
    // Personagem do mestre na campanha B via INSERT direto (sem ficha publicada).
    const db = abrirDb(BANCO);
    const agora = Date.now();
    const membMestreB = db.prepare("select id from memberships where campaign_id=? and user_id=?")
      .get(campB2, cenario.adminId).id;
    const charIdB = crypto.randomUUID();
    db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(charIdB, campB2, membMestreB, null, "Mestre CampB", "{}", "{}", "aprovada", 0, agora, agora);
    db.close();

    const contaB = await mkConta(charIdB, mestre, "Conta B", 40);
    const rB = await operacao(charIdB, mestre, {
      tipo: "compra", accountId: contaB, valor: 10,
      item: { name: "Item CampB", quantity: 1 }, requestId: "op-compra-1",
    });
    t("mesmo requestId em outra campanha → 201", rB.status === 201, `status=${rB.status}`);
    t("saldo da conta B debitado", saldoDb(contaB) === 3000, `saldo=${saldoDb(contaB)}`);

    const rCruza = await operacao(charIdB, mestre, {
      tipo: "compra", accountId: contaJ1, valor: 10,
      item: { name: "X", quantity: 1 }, requestId: "op-cruzada",
    });
    t("conta de outra campanha → 404", rCruza.status === 404, `status=${rCruza.status}`);

    const rItemCruza = await operacao(charIdB, mestre, {
      tipo: "venda", accountId: contaB, valor: 10,
      itemId: itensDb(charJ1)[0]?.id, requestId: "op-venda-cruzada",
    });
    t("item de outra campanha → 404", rItemCruza.status === 404, `status=${rItemCruza.status}`);
  }

  // ===== 16. Concorrência em operações simultâneas =====
  sec("16. Concorrência");
  {
    const itemC = await operacao(charJ1, j1.cookie, {
      tipo: "compra", accountId: contaJ1, valor: 40, quantidade: 4,
      item: { name: "Item Corrida", quantity: 1 }, requestId: "op-setup-corrida",
    });
    t("setup concorrência 201", itemC.status === 201, `status=${itemC.status}`);
    const itemIdC = itensDb(charJ1).find((i) => i.name === "Item Corrida")?.id;
    const antes = saldoDb(contaJ1b);
    const [vA, vB] = await Promise.all([
      operacao(charJ1, j1.cookie, { tipo: "venda", accountId: contaJ1b, valor: 10, itemId: itemIdC, quantidade: 4, requestId: "op-vc-a" }),
      operacao(charJ1, j1.cookie, { tipo: "venda", accountId: contaJ1b, valor: 10, itemId: itemIdC, quantidade: 4, requestId: "op-vc-b" }),
    ]);
    const oks = [vA, vB].filter((r) => r.status === 201).length;
    t("vendas concorrentes do mesmo estoque: 1 ok", oks === 1, `${vA.status},${vB.status}`);
    t("estoque zerado uma única vez", !itemDb(itemIdC) || itemDb(itemIdC).quantity === 0, `qtd=${itemDb(itemIdC)?.quantity}`);
    t("um único crédito de venda", saldoDb(contaJ1b) === antes + 1000, `${antes} vs ${saldoDb(contaJ1b)}`);
  }
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== fin-integracao: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
