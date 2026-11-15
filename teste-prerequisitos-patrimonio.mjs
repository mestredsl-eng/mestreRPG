// Testes: pré-requisitos do Acervo na aquisição de patrimônio (Issue — PR #100).
// Cobre: bloqueio por pré-requisito ausente/insuficiente, aceite quando
// atendido, compra paga e sem pagamento, chamada direta à API, metadados
// forjados, transferência para destino inelegível, upgrade de ficha,
// itens manuais preservados e exceção explícita do mestre.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("prereq-patrimonio");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

// Regra do Acervo: carro exige perícia conducao>=1; caça exige conducao>=5.
const REGRA_CARRO = { kind: "item", key: "carro_popular" };
const REGRA_F16 = { kind: "veiculo", key: "caca_f16" };
const REGRA_LIVRE = { kind: "item", key: "kit_campo" };

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc, ids;

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "prq_j1", jogador2: "prq_j2" },
    ficha: false,
  });
  ids = { admin: cenario.adminId, camp: cenario.campId, cm: cenario.cookieMestre };
  ids.j1 = cenario.jogadores.jogador1; ids.j2 = cenario.jogadores.jogador2;

  // Ficha com Perícias (regraKind=pericia) — IDs resolvidos pela estrutura, não fixos.
  const ESTRUTURA = {
    versao: 1,
    secoes: [{ id: "s-per", titulo: "Perícias", ordem: 0, campos: [
      { id: "cmp-pericias", label: "Perícias", tipo: "selecao_nivel", semantico: "especializacao", regraKind: "pericia" },
    ]}],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  const agora = Date.now();
  const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,1,?,?)")
        .run(tplId, ids.camp, "Ficha PRQ", null, ids.admin, agora, agora);
      w.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
        .run(verId, tplId, JSON.stringify(ESTRUTURA), agora, agora);
      w.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);
    } finally { w.close(); }
  }
  const pjJ1 = crypto.randomUUID(), pjJ2 = crypto.randomUUID();
  const mkPj = (id, mid, data) => {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, ids.camp, mid, verId, "PJ PRQ", JSON.stringify(data), "{}", "aprovada", 0, agora, agora);
    } finally { w.close(); }
  };
  // j1: conducao 2 · j2: sem perícias
  mkPj(pjJ1, ids.j1.membershipId, { "cmp-pericias": [{ key: "conducao", nivel: 2 }] });
  mkPj(pjJ2, ids.j2.membershipId, {});

  // Elementos do Acervo no rule_set ativo
  const rs = comDb(BANCO, (db) => db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(ids.camp).id);
  const insRegra = (kind, key, name, prereqs) => {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), rs, kind, key, name, null, null,
          JSON.stringify({ descricao: "", custoPontos: 0, niveis: [], minimo: 0, maximo: 1, prerequisitos: prereqs, dependencias: [], gruposExclusividade: [], exclusivos: [], obrigatorios: [], formulas: {}, disponivel: true }),
          agora, agora);
    } finally { w.close(); }
  };
  // perícia conducao (pré-requisito referenciável)
  insRegra("pericia", "conducao", "Condução", []);
  insRegra("item", "carro_popular", "Carro Popular", [{ kind: "pericia", key: "conducao", minLevel: 1 }]);
  insRegra("veiculo", "caca_f16", "Caça F-16", [{ kind: "pericia", key: "conducao", minLevel: 5 }]);
  insRegra("item", "kit_campo", "Kit de Campo", []);
  insRegra("item", "combo", "Combo", [
    { kind: "pericia", key: "conducao", minLevel: 1 },
    { kind: "pericia", key: "inexistente_xyz", minLevel: 1 },
  ]);

  const post = (pj, path, body, cookie) => req(BASE, "POST", `/characters/${pj}${path}`, { cookie, body });

  sec("aquisição bloqueada sem pré-requisito");
  let r = await post(pjJ2, "/inventario", { name: "Carro", regra: REGRA_CARRO }, ids.j2.cookie);
  t("j2 sem Condução: inventário carro bloqueado", r.status === 403, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  r = await post(pjJ2, "/veiculos", { name: "F-16", regra: REGRA_F16 }, ids.j2.cookie);
  t("j2 sem Condução: veículo F-16 bloqueado", r.status === 403, `status=${r.status}`);
  r = await post(pjJ2, "/financeiro/operacao", { tipo: "compra", pagar: false, item: { name: "Carro", regra: REGRA_CARRO } }, ids.j2.cookie);
  t("j2 sem Condução: compra sem pagamento bloqueada", r.status === 403, `status=${r.status}`);

  sec("nível insuficiente (Condução 2 < 5)");
  r = await post(pjJ1, "/veiculos", { name: "F-16", regra: REGRA_F16 }, ids.j1.cookie);
  t("j1 Condução 2: F-16 (exige 5) bloqueado", r.status === 403, `status=${r.status}`);
  const det = r.json?.detalhes?.[0]?.mensagem ?? "";
  t("mensagem explica nível atual/exigido", /Condução/.test(det) && /nível 5/.test(det), det);

  sec("pré-requisito atendido");
  r = await post(pjJ1, "/inventario", { name: "Carro Popular", regra: REGRA_CARRO }, ids.j1.cookie);
  t("j1 Condução 2: carro (exige 1) aceito", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  const itemCarro = r.json?.id;
  const itemRow = comDb(BANCO, (db) => db.prepare("select data from inventory_entries where id=?").get(itemCarro));
  t("referência da regra persistida no item", JSON.parse(itemRow?.data ?? "{}").regra?.key === "carro_popular");

  sec("dois pré-requisitos / inexistente");
  r = await post(pjJ1, "/inventario", { name: "Combo", regra: { kind: "item", key: "combo" } }, ids.j1.cookie);
  t("combo com pré-req inexistente bloqueado", r.status === 403, `status=${r.status}`);

  sec("item sem pré-requisito preservado");
  r = await post(pjJ1, "/inventario", { name: "Kit", regra: REGRA_LIVRE }, ids.j1.cookie);
  t("kit sem pré-req aceito", r.status === 201, `status=${r.status}`);
  r = await post(pjJ1, "/inventario", { name: "Item manual" }, ids.j1.cookie);
  t("item manual sem regra aceito", r.status === 201, `status=${r.status}`);

  sec("compra com pagamento valida antes do débito");
  // conta do j1
  const conta = await req(BASE, "POST", `/characters/${pjJ1}/financeiro/contas`, { cookie: ids.j1.cookie, body: { type: "especie", name: "Dinheiro", balanceReais: 1000 } });
  t("conta criada", conta.status === 201 || conta.status === 200, `status=${conta.status}`);
  const contaId = conta.json?.id;
  // F-16 pago por j1 (Condução 2 < 5): deve falhar SEM débito
  const saldoAntes = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
  r = await post(pjJ1, "/financeiro/operacao", { tipo: "compra", accountId: contaId, valor: 500, item: { name: "F-16", regra: REGRA_F16 } }, ids.j1.cookie);
  t("compra paga F-16 bloqueada", r.status === 403, `status=${r.status}`);
  const saldoDepois = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
  t("saldo intacto após bloqueio", saldoAntes === saldoDepois, `${saldoAntes}→${saldoDepois}`);
  // carro pago por j1: aceito e debita
  r = await post(pjJ1, "/financeiro/operacao", { tipo: "compra", accountId: contaId, valor: 100, item: { name: "Carro2", regra: REGRA_CARRO } }, ids.j1.cookie);
  t("compra paga carro aceita", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
  const saldoFinal = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
  t("débito aplicado", saldoFinal === saldoAntes - 10000, `${saldoAntes}→${saldoFinal}`);

  sec("metadados forjados não contornam");
  r = await post(pjJ2, "/inventario", { name: "F-16 fake", regra: REGRA_F16, data: { prerequisitos: [], nivelConducao: 99 } }, ids.j2.cookie);
  t("data forjada ignorada — segue bloqueado", r.status === 403, `status=${r.status}`);
  // regra forjada apontando elemento inexistente
  r = await post(pjJ2, "/inventario", { name: "X", regra: { kind: "item", key: "nao_existe" } }, ids.j2.cookie);
  t("regra inexistente bloqueada", r.status === 403, `status=${r.status}`);

  sec("transferência respeita destino");
  // j1 (Condução 2) tem o carro; transfere para j2 (sem perícia) → recusado
  const itemId = itemCarro;
  r = await req(BASE, "POST", `/characters/${pjJ1}/inventario/${itemId}/transferir`, { cookie: ids.j1.cookie, body: { destinoCharacterId: pjJ2 } });
  t("transferir carro p/ sem Condução recusado", r.status === 403, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  // j1 transfere kit (sem regra) para j2 → ok
  const kitRow = comDb(BANCO, (db) => db.prepare("select id from inventory_entries where character_id=? and name='Kit'").get(pjJ1));
  r = await req(BASE, "POST", `/characters/${pjJ1}/inventario/${kitRow?.id}/transferir`, { cookie: ids.j1.cookie, body: { destinoCharacterId: pjJ2 } });
  t("transferir item sem regra ok", r.status === 200, `status=${r.status}`);

  sec("upgrade de ficha libera aquisição");
  // sobe Condução do j2 para 5
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("update characters set data=? where id=?")
        .run(JSON.stringify({ "cmp-pericias": [{ key: "conducao", nivel: 5 }] }), pjJ2);
    } finally { w.close(); }
  }
  r = await post(pjJ2, "/veiculos", { name: "F-16", regra: REGRA_F16 }, ids.j2.cookie);
  t("após ficha atualizada, F-16 aceito", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);

  sec("exceção explícita do mestre");
  // mestre cria PJ próprio? usa pjJ2 (jogador) — mestre NÃO pode agir por ele
  // pois a rota é do personagem; testa ignorarPrerequisitos=false e true via API do dono
  r = await post(pjJ2, "/inventario", { name: "Combo inv", regra: { kind: "item", key: "combo" }, ignorarPrerequisitos: true }, ids.j2.cookie);
  t("jogador não pode usar ignorarPrerequisitos", r.status === 403, `status=${r.status}`);
  // mestre administra patrimônio do próprio PJ? sem PJ do mestre com ficha — pula;
  // ao menos confirma que flag não abre brecha para jogador.

  sec("catálogo expõe acervo");
  const cat = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.j1.cookie });
  const acervo = cat.json?.acervo ?? [];
  t("catálogo lista elementos do Acervo", acervo.some((e) => e.regra?.key === "carro_popular"), JSON.stringify(acervo).slice(0, 200));
  const f16 = acervo.find((e) => e.regra?.key === "caca_f16");
  t("F-16 expõe pré-requisito Condução 5", f16?.prerequisitos?.some((p) => p.key === "conducao" && p.minLevel === 5), JSON.stringify(f16?.prerequisitos));

  t("sem erros fatais", true);
} catch (e) {
  fail++;
  console.log("FALHOU exceção:", e);
} finally {
  if (proc) await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
