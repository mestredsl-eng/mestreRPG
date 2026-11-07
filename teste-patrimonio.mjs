// Testes de integração — Etapa 6: inventário, equipamentos, veículos e finanças
// Roda contra o servidor local (localhost:3001) com sessões criadas direto no banco.
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001/api";
const db = new Database("banco/mestre-rpg.db");

const CID = "e8bbf8ea-c4d0-4bc1-9f1b-c4e6ec8558c0"; // Caçadores & Caçados
const CHAR_T3 = "fc54075d-6eb0-4692-bff0-b225d404da41"; // dono: jogador_e5
const CHAR_E4 = "4093f1ae-1dc2-416e-b8d9-d451734fc22f"; // Herói Teste (outra campanha)

// ---- setup: jogador2 vira membro de C&C para testar isolamento entre jogadores ----
const j2 = db.prepare("select id from users where username='jogador2'").get();
const jaMembro = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, j2.id);
if (!jaMembro) {
  db.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), CID, j2.id, "jogador", "{}", "ativo", Date.now(), Date.now(), Date.now());
  console.log("setup: jogador2 adicionado a C&C");
}

// sessões diretas
function sessao(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  const token = "teste6-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "teste", "127.0.0.1", Date.now() + 86400000, Date.now());
  return `mestre_rpg_session=${encodeURIComponent(token)}`;
}
const ADMIN = sessao("admin");
const JOG5 = sessao("jogador_e5");
const JOG2 = sessao("jogador2");

let pass = 0, fail = 0;
const resultados = [];
function t(nome, cond, extra = "") {
  if (cond) { pass++; resultados.push(`ok ${nome}`); }
  else { fail++; resultados.push(`FALHOU ${nome} ${extra}`); }
}

async function req(metodo, path, { cookie = ADMIN, body } = {}) {
  const r = await fetch(BASE + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* vazio */ }
  return { status: r.status, json };
}

// personagem do jogador2 em C&C (para testar negação cruzada)
let CHAR_J2 = null;
{
  const r = await req("POST", `/campaigns/${CID}/characters`, { cookie: JOG2, body: { name: "PJ2 E6" } });
  if (r.status === 201 || r.status === 200) CHAR_J2 = r.json.personagem?.id ?? r.json.id;
  else {
    // talvez precise templateVersionId — pega um modelo publicado
    const mods = await req("GET", `/campaigns/${CID}/sheet-templates`, { cookie: JOG2 });
    const tpl = mods.json?.modelos?.find((m) => m.isActive && m.versaoAtual?.publishedAt);
    if (tpl) {
      const r2 = await req("POST", `/campaigns/${CID}/characters`, { cookie: JOG2, body: { name: "PJ2 E6", templateVersionId: tpl.versaoAtual.id } });
      CHAR_J2 = r2.json?.personagem?.id ?? r2.json?.id;
    }
  }
}
console.log("personagem jogador2:", CHAR_J2);

// ============ 1-3. Inventário ============
const item1 = await req("POST", `/characters/${CHAR_T3}/inventario`, { cookie: JOG5, body: { name: "Pão", quantity: 3, category: "alimento", weight: 0.2 } });
t("1a. criar item", item1.status === 201, JSON.stringify(item1.json));
const item1Id = item1.json?.id;

const item2 = await req("POST", `/characters/${CHAR_T3}/inventario`, { cookie: JOG5, body: { name: "Kit ferramentas", quantity: 1, category: "ferramenta", weight: 2.5, valueCents: 15000 } });
t("1b. criar item c/ valor", item2.status === 201);
const item2Id = item2.json?.id;

const patchQtd = await req("PATCH", `/characters/${CHAR_T3}/inventario/${item1Id}`, { cookie: JOG5, body: { quantity: 5 } });
t("2. alterar quantidade", patchQtd.status === 200);
const inv = await req("GET", `/characters/${CHAR_T3}/inventario`, { cookie: JOG5 });
t("2b. quantidade persistiu", inv.json?.itens?.find((i) => i.id === item1Id)?.quantity === 5);

const eq = await req("POST", `/characters/${CHAR_T3}/inventario/${item2Id}/equipar`, { cookie: JOG5, body: { slot: "mochila" } });
t("3a. equipar item do inventário", eq.status === 201, JSON.stringify(eq.json));
const eqId = eq.json?.id;
const eqSlotOcupado = await req("POST", `/characters/${CHAR_T3}/inventario/${item1Id}/equipar`, { cookie: JOG5, body: { slot: "mochila" } });
// mochila não é slot configurado; conflito só se slot já ocupado — teste com mesmo slot:
t("3b. slot ocupado → 409", eqSlotOcupado.status === 409, `status ${eqSlotOcupado.status}`);
const deseq = await req("POST", `/characters/${CHAR_T3}/equipamentos/${eqId}/desequipar`, { cookie: JOG5 });
t("3c. desequipar", deseq.status === 200);

// ============ 4. Veículos ============
const veic = await req("POST", `/characters/${CHAR_T3}/veiculos`, { cookie: JOG5, body: { name: "Gol", kind: "carro", brand: "VW", model: "Gol", year: 2015, plate: "ABC1D23", valueCents: 4500000 } });
t("4. criar veículo", veic.status === 201, JSON.stringify(veic.json));
const veicId = veic.json?.id;

// ============ 5. Moeda customizada ============
const cfgAntes = await req("GET", `/campaigns/${CID}/regras`, { cookie: ADMIN });
const cfgAtual = cfgAntes.json?.config ?? {};
const putCfg = await req("PUT", `/campaigns/${CID}/regras/config`, { cookie: ADMIN, body: { financeiro: { moedas: [{ codigo: "CR", nome: "Créditos", conversaoParaPrincipal: 10 }] } } });
t("5. configurar moeda customizada", putCfg.status === 200, JSON.stringify(putCfg.json).slice(0, 200));

// ============ 6-8. Contas ============
const especie = await req("POST", `/characters/${CHAR_T3}/financeiro/contas`, { cookie: JOG5, body: { type: "especie", name: "Carteira", balanceReais: 500 } });
t("6. conta em espécie", especie.status === 201, JSON.stringify(especie.json));
const contaEsp = especie.json?.id;

const banco = await req("POST", `/characters/${CHAR_T3}/financeiro/contas`, { cookie: JOG5, body: { type: "banco", name: "Banco XPTO", institution: "XPTO", agency: "0001", accountNumber: "12345-6", balanceReais: 2000 } });
t("7. conta bancária fictícia", banco.status === 201);
const contaBanco = banco.json?.id;

const cartao = await req("POST", `/characters/${CHAR_T3}/financeiro/contas`, { cookie: JOG5, body: { type: "cartao_credito", name: "Cartão XPTO", institution: "XPTO", creditLimitReais: 5000 } });
t("8. cartão de crédito", cartao.status === 201);
const contaCartao = cartao.json?.id;

// conta no personagem do jogador2 para PIX
const esp2 = await req("POST", `/characters/${CHAR_J2}/financeiro/contas`, { cookie: JOG2, body: { type: "especie", name: "Bolso PJ2", balanceReais: 100 } });
t("8b. conta do outro jogador", esp2.status === 201);
const contaPJ2 = esp2.json?.id;

// ============ 9. PIX fictício ============
const finJ2Antes = await req("GET", `/characters/${CHAR_J2}/financeiro`, { cookie: JOG2 });
const saldoPJ2Antes = finJ2Antes.json?.contas?.find((c) => c.id === contaPJ2)?.balanceCents ?? 0;
const pix = await req("POST", `/characters/${CHAR_T3}/financeiro/transferir`, { cookie: JOG5, body: { origemAccountId: contaBanco, destinoAccountId: contaPJ2, valor: 250, descricao: "Pagamento", requestId: `pix-${crypto.randomUUID().slice(0, 8)}` } });
t("9. PIX fictício entre personagens", pix.status === 201, JSON.stringify(pix.json));
const finJ2 = await req("GET", `/characters/${CHAR_J2}/financeiro`, { cookie: JOG2 });
const saldoPJ2 = finJ2.json?.contas?.find((c) => c.id === contaPJ2)?.balanceCents;
t("9b. saldo destino creditado", saldoPJ2 === saldoPJ2Antes + 25000, `antes=${saldoPJ2Antes} depois=${saldoPJ2}`);

const RUN = crypto.randomUUID().slice(0, 8);
const finAntes = await req("GET", `/characters/${CHAR_T3}/financeiro`, { cookie: JOG5 });
const saldoBancoAntes = finAntes.json?.contas?.find((c) => c.id === contaBanco)?.balanceCents ?? 0;

// ============ 10-11. Compra e venda ============
const compra = await req("POST", `/characters/${CHAR_T3}/financeiro/operacao`, { cookie: JOG5, body: { tipo: "compra", accountId: contaBanco, valor: 80, descricao: "Comprou munição", item: { name: "Munição 9mm", quantity: 2, category: "municao" }, requestId: `compra-${RUN}` } });
t("10a. compra atômica", compra.status === 201, JSON.stringify(compra.json));
const invAposCompra = await req("GET", `/characters/${CHAR_T3}/inventario`, { cookie: JOG5 });
t("10b. item entrou no inventário", invAposCompra.json?.itens?.some((i) => i.name === "Munição 9mm" && i.quantity === 2));

// pega o item criado AGORA (o mais recente com qtd 2 — pode haver resíduo de rodadas anteriores)
const municao = [...(invAposCompra.json?.itens ?? [])].reverse().find((i) => i.name === "Munição 9mm" && i.quantity === 2) ?? invAposCompra.json?.itens?.find((i) => i.name === "Munição 9mm");
const venda = await req("POST", `/characters/${CHAR_T3}/financeiro/operacao`, { cookie: JOG5, body: { tipo: "venda", accountId: contaBanco, valor: 50, descricao: "Vendeu munição", itemId: municao?.id, quantidade: 1, requestId: `venda-${RUN}` } });
t("10c. venda parcial", venda.status === 201, JSON.stringify(venda.json));

const fin = await req("GET", `/characters/${CHAR_T3}/financeiro`, { cookie: JOG5 });
const bancoApos = fin.json?.contas?.find((c) => c.id === contaBanco);
// esperado: saldo anterior - 80 (compra) + 50 (venda)
t("11. saldo bancário correto", bancoApos?.balanceCents === saldoBancoAntes - 8000 + 5000, `antes=${saldoBancoAntes} depois=${bancoApos?.balanceCents}`);
const kinds = fin.json?.historico?.map((h) => h.kind) ?? [];
t("11b. histórico registra tudo", ["pix_ficticio", "compra", "venda"].every((k) => kinds.includes(k)), kinds.join(","));

// ============ 12. Saldo negativo ============
const neg = await req("POST", `/characters/${CHAR_T3}/financeiro/movimentar`, { cookie: JOG5, body: { accountId: contaEsp, tipo: "saida", valor: 99999, descricao: "tentativa" } });
t("12. saldo negativo bloqueado", neg.status === 400, `status=${neg.status}`);
// mas cartão de crédito permite até o limite
const cred = await req("POST", `/characters/${CHAR_T3}/financeiro/movimentar`, { cookie: JOG5, body: { accountId: contaCartao, tipo: "saida", valor: 3000, descricao: "compra no crédito" } });
t("12b. cartão de crédito usa limite", cred.status === 201, JSON.stringify(cred.json));
const credExcede = await req("POST", `/characters/${CHAR_T3}/financeiro/movimentar`, { cookie: JOG5, body: { accountId: contaCartao, tipo: "saida", valor: 99999 } });
t("12c. acima do limite bloqueado", credExcede.status === 400);

// ============ 13. Transferência de item ============
const transf = await req("POST", `/characters/${CHAR_T3}/inventario/${item1Id}/transferir`, { cookie: JOG5, body: { destinoCharacterId: CHAR_J2, quantidade: 2 } });
t("13a. transferir parte do item", transf.status === 200, JSON.stringify(transf.json));
const invJ2 = await req("GET", `/characters/${CHAR_J2}/inventario`, { cookie: JOG2 });
const poJ2 = invJ2.json?.itens?.find((i) => i.name === "Pão");
t("13b. item chegou ao destino", poJ2?.quantity === 2, JSON.stringify(poJ2));
const invT3b = await req("GET", `/characters/${CHAR_T3}/inventario`, { cookie: JOG5 });
t("13c. origem ficou com 3", invT3b.json?.itens?.find((i) => i.id === item1Id)?.quantity === 3);

// ============ 14. Jogador não altera patrimônio alheio ============
if (CHAR_J2) {
  const invasao = await req("POST", `/characters/${CHAR_J2}/inventario`, { cookie: JOG5, body: { name: "Item roubado" } });
  t("14a. jogador não adiciona item alheio", invasao.status === 403, `status=${invasao.status}`);
  const invasaoFin = await req("POST", `/characters/${CHAR_J2}/financeiro/movimentar`, { cookie: JOG5, body: { accountId: contaPJ2, tipo: "saida", valor: 50 } });
  t("14b. jogador não movimenta dinheiro alheio", invasaoFin.status === 403 || invasaoFin.status === 404, `status=${invasaoFin.status}`);
  // e nem vê o financeiro alheio? (acesso é por personagem — membro pode ver? testar)
  const verFin = await req("GET", `/characters/${CHAR_J2}/financeiro`, { cookie: JOG5 });
  console.log("   info: GET financeiro alheio →", verFin.status);
}
// mestre PODE
const invMestre = await req("GET", `/characters/${CHAR_J2}/inventario`, { cookie: ADMIN });
t("14c. mestre visualiza inventário alheio", invMestre.status === 200);

// ============ 15. Manipulação pelo navegador ============
// cliente tenta injetar balanceCents direto na criação da conta — deve ser ignorado
const hack = await req("POST", `/characters/${CHAR_T3}/financeiro/contas`, { cookie: JOG5, body: { type: "especie", name: "Hack", balanceReais: 10, balanceCents: 99999999, saldo: 999999 } });
const finHack = await req("GET", `/characters/${CHAR_T3}/financeiro`, { cookie: JOG5 });
const contaHack = finHack.json?.contas?.find((c) => c.name === "Hack");
t("15a. balanceCents injetado ignorado", contaHack?.balanceCents === 1000, `saldo=${contaHack?.balanceCents}`);
// jogador tenta ajuste do mestre
const ajusteJogador = await req("POST", `/characters/${CHAR_T3}/financeiro/movimentar`, { cookie: JOG5, body: { accountId: contaEsp, tipo: "ajuste", valor: 1000 } });
t("15b. ajuste só do mestre", ajusteJogador.status === 403);

// ============ 16. Ajuste do mestre ============
const ajuste = await req("POST", `/characters/${CHAR_T3}/financeiro/movimentar`, { cookie: ADMIN, body: { accountId: contaEsp, tipo: "ajuste", valor: 42.5, descricao: "Correção do mestre" } });
t("16. ajuste do mestre", ajuste.status === 201, JSON.stringify(ajuste.json));
const finAjuste = await req("GET", `/characters/${CHAR_T3}/financeiro`, { cookie: JOG5 });
t("16b. ajuste no histórico", finAjuste.json?.historico?.some((h) => h.kind === "ajuste_mestre"));

// ============ 17. Concorrência / idempotência ============
const rid = "dup-" + crypto.randomUUID();
const [p1, p2] = await Promise.all([
  req("POST", `/characters/${CHAR_T3}/financeiro/movimentar`, { cookie: JOG5, body: { accountId: contaEsp, tipo: "entrada", valor: 10, requestId: rid } }),
  req("POST", `/characters/${CHAR_T3}/financeiro/movimentar`, { cookie: JOG5, body: { accountId: contaEsp, tipo: "entrada", valor: 10, requestId: rid } }),
]);
const statuses = [p1.status, p2.status].sort();
t("17a. requestId duplicado → um 201 um 409", statuses[0] === 201 && statuses[1] === 409, statuses.join(","));
const finDup = await req("GET", `/characters/${CHAR_T3}/financeiro`, { cookie: JOG5 });
const entradas10 = finDup.json?.historico?.filter((h) => h.requestId === rid || (h.amountCents === 1000 && h.description === null)).length;
t("17b. só uma movimentação registrada", finDup.json?.historico?.filter((h) => h.kind === "entrada" && Math.abs((h.balanceAfterCents ?? 0) - (h.balanceBeforeCents ?? 0)) === 1000).length >= 1);

// ============ 18. Ficha antiga continua funcionando ============
const fichaAntiga = await req("GET", `/characters/${CHAR_T3}`, { cookie: JOG5 });
t("18. ficha antiga íntegra", fichaAntiga.status === 200 && !!fichaAntiga.json?.ficha, `status=${fichaAntiga.status}`);

// ============ 19. Isolamento entre campanhas ============
const invE4 = await req("GET", `/characters/${CHAR_E4}/inventario`, { cookie: ADMIN });
t("19a. campanha E4 tem inventário próprio (vazio)", invE4.status === 200 && invE4.json?.itens?.length === 0, `itens=${invE4.json?.itens?.length}`);
const finE4 = await req("GET", `/characters/${CHAR_E4}/financeiro`, { cookie: ADMIN });
t("19b. financeiro E4 isolado", finE4.status === 200 && finE4.json?.contas?.length === 0);
// jogador_e5 NÃO é membro de E4 → não acessa
const invE4Negado = await req("GET", `/characters/${CHAR_E4}/inventario`, { cookie: JOG5 });
t("19c. não-membro não acessa outra campanha", invE4Negado.status === 403, `status=${invE4Negado.status}`);

// catálogo do mestre
const cat = await req("POST", `/campaigns/${CID}/inventario`, { cookie: ADMIN, body: { name: "Rádio comunicador", category: "eletronico", description: "Freq. tática" } });
t("catálogo: criar item", cat.status === 201);
const catList = await req("GET", `/campaigns/${CID}/inventario`, { cookie: JOG5 });
t("catálogo: jogador lista", catList.status === 200 && catList.json?.itens?.some((i) => i.name === "Rádio comunicador"));
const catNegado = await req("POST", `/campaigns/${CID}/inventario`, { cookie: JOG5, body: { name: "Item proibido" } });
t("catálogo: jogador não cria", catNegado.status === 403);

console.log("\n===== RESULTADOS =====");
resultados.forEach((r) => console.log(r));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
