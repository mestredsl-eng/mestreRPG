// Testes: ponte econômica Acervo → Patrimônio (Issue #103).
// Cobre os 13 critérios de aceite: cópia de weight/valueCents/economia/
// fuel/capacity/veiculo para template.data, imutabilidade do Acervo,
// sugestão ≠ pagamento, ausência de débito automático, não conversão
// de moeda, override local, compatibilidade legada e anti-forja.
// Roda contra servidor com banco SQLite temporário (teste-base.mjs).
import { readFileSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("ponte-econ");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

const ECON = (preco, min, max) => ({
  moeda: "BRL",
  precoReferenciaBRL: preco,
  faixaPrecoBRL: min === null ? null : { min, max },
  unidadeCompra: "unidade",
  mercadoReferencia: "Brasil",
  dataReferencia: "2026-11",
  base: "referência de teste",
  observacao: "estimativa de mercado",
});

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc, ids;

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "econ_j1" },
    config: { financeiro: { moedas: [{ codigo: "USD", nome: "Dólar Americano" }] } },
  });
  ids = { camp: cenario.campId, cm: cenario.cookieMestre };
  ids.j1 = cenario.jogadores.jogador1;
  const pjMestre = cenario.personagemMestre;
  const pjJ1 = cenario.novoPersonagem(ids.j1.membershipId, "PJ Econ J1");

  // ---- Elementos do Acervo com dados econômicos (rule_definitions) ----
  const rs = comDb(BANCO, (db) => db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(ids.camp).id);
  const agora = Date.now();
  const defsAntes = {};
  const insRegra = (kind, key, name, defExtra) => {
    const w = abrirDb(BANCO);
    try {
      const definition = { descricao: "", prerequisitos: [], ...defExtra };
      w.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), rs, kind, key, name, null, null, JSON.stringify(definition), agora, agora);
      defsAntes[`${kind}:${key}`] = JSON.stringify(definition);
    } finally { w.close(); }
  };
  insRegra("item", "pistola_teste", "Pistola de Teste", {
    weight: 0.9, valueCents: 25000, economia: ECON(250, 200, 300),
  });
  insRegra("item", "item_sem_referencia", "Item sem referência", {});
  insRegra("item", "item_econ_nula", "Item economia nula", {
    weight: 1.2, economia: { ...ECON(null, null, null), precoReferenciaBRL: null, faixaPrecoBRL: null },
  });
  insRegra("veiculo", "buggy_teste", "Buggy de Teste", {
    weight: 800, valueCents: 5000000, economia: ECON(50000, 40000, 60000),
    fuel: "gasolina", capacity: "4 ocupantes",
    veiculo: { consumoOuAutonomia: "aprox. 10 km/L", baseDoPeso: "ordem de marcha" },
  });
  // ---- Tolerância granular do schema econômico (auditoria PR #108) ----
  // Metadados econômicos inválidos/parciais NÃO podem derrubar o elemento.
  insRegra("item", "econ_parcial", "Item economia parcial", {
    economia: { moeda: "BRL", observacao: "só observação válida" },
  });
  insRegra("item", "econ_sujo", "Item economia suja", {
    weight: "0,5", valueCents: 12.5,
    economia: {
      moeda: 123,
      unidadeCompra: "caixa",
      precoReferenciaBRL: "abc",
      base: "x".repeat(700),
      observacao: "ok",
      extra: "descartado",
    },
  });
  insRegra("item", "econ_invalida", "Item economia inválida", {
    weight: 2, valueCents: 1000,
    economia: "não-é-objeto",
  });
  insRegra("veiculo", "van_suja", "Van suja", {
    fuel: 42, capacity: "2 ocupantes",
    veiculo: { consumoOuAutonomia: 9, baseDoPeso: "peso bruto" },
  });

  // Contas: BRL (espécie) e USD (banco) do personagem do mestre.
  const contaBRL = await req(BASE, "POST", `/characters/${pjMestre}/financeiro/contas`, { cookie: ids.cm, body: { type: "especie", name: "Carteira", balanceReais: 10000 } });
  t("setup: conta BRL", contaBRL.status === 201, JSON.stringify(contaBRL.json));
  const contaUSD = await req(BASE, "POST", `/characters/${pjMestre}/financeiro/contas`, { cookie: ids.cm, body: { type: "banco", name: "Conta USD", currency: "USD", balanceReais: 500 } });
  t("setup: conta USD", contaUSD.status === 201, JSON.stringify(contaUSD.json));

  // ================= 1-2. Vínculo copia economia; Acervo imutável =================
  sec("1-2. Vínculo template → Acervo");
  const tpl = await req(BASE, "POST", `/campaigns/${ids.camp}/inventario`, {
    cookie: ids.cm,
    body: { name: "Template Pistola", regra: { kind: "item", key: "pistola_teste" } },
  });
  t("1a. template com vínculo criado", tpl.status === 201, JSON.stringify(tpl.json));
  const tplId = tpl.json?.id;
  const cat = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tplRow = (cat.json?.itens ?? []).find((i) => i.id === tplId);
  const dTpl = tplRow?.data ?? {};
  t("1b. template.data.weight copiado", dTpl.weight === 0.9, JSON.stringify(dTpl.weight));
  t("1c. template.data.valueCents copiado", dTpl.valueCents === 25000, JSON.stringify(dTpl.valueCents));
  t("1d. template.data.economia copiada", dTpl.economia?.precoReferenciaBRL === 250 && dTpl.economia?.moeda === "BRL", JSON.stringify(dTpl.economia));
  const acervoCat = (cat.json?.acervo ?? []).find((e) => e.regra.kind === "item" && e.regra.key === "pistola_teste");
  t("1e. GET catálogo expõe referência", acervoCat?.weight === 0.9 && acervoCat?.valueCents === 25000 && acervoCat?.economia?.precoReferenciaBRL === 250, JSON.stringify(acervoCat));

  const defsDepois = {};
  {
    const w = abrirDb(BANCO);
    try {
      for (const r of w.prepare("select kind || ':' || key as chave, definition from rule_definitions where rule_set_id=?").all(rs)) {
        defsDepois[r.chave] = r.definition;
      }
    } finally { w.close(); }
  }
  t("2. rule_definitions inalterado após vínculo", Object.keys(defsAntes).every((k) => defsDepois[k] === defsAntes[k]), JSON.stringify(defsDepois).slice(0, 300));

  // ================= 3-6. Compra / financeiro =================
  sec("3-6. Compra — referência é sugestão, nunca débito");
  const saldoAntes = await req(BASE, "GET", `/characters/${pjMestre}/financeiro`, { cookie: ids.cm });
  const saldoBRLAntes = saldoAntes.json?.contas?.find((c) => c.id === contaBRL.json.id)?.balanceCents;

  // 4a. Sem valor explícito não há débito — referência sozinha não cobra.
  const semValor = await req(BASE, "POST", `/characters/${pjMestre}/financeiro/operacao`, {
    cookie: ids.cm, body: { tipo: "compra", templateId: tplId, pagar: true, requestId: `semvalor-${crypto.randomUUID().slice(0, 8)}` },
  });
  t("4a. compra sem valor → 400", semValor.status === 400, `status ${semValor.status}`);

  // 3. Compra em conta BRL: grava o valor CONFIRMADO (300), não a referência (250).
  const opCompra = `compra-${crypto.randomUUID().slice(0, 8)}`;
  const compra = await req(BASE, "POST", `/characters/${pjMestre}/financeiro/operacao`, {
    cookie: ids.cm,
    body: { tipo: "compra", accountId: contaBRL.json.id, valor: 300, templateId: tplId, quantidade: 1, requestId: opCompra },
  });
  t("3a. compra paga criada", compra.status === 201, JSON.stringify(compra.json));
  const invApos = await req(BASE, "GET", `/characters/${pjMestre}/inventario`, { cookie: ids.cm });
  const itemCompra = (invApos.json?.itens ?? []).find((i) => i.data?.operacaoId === opCompra);
  t("3b. item criado com peso do template", itemCompra?.weight === 0.9, JSON.stringify(itemCompra?.weight));
  t("3c. valueCents gravado = valor confirmado", itemCompra?.data?.valueCents === 30000, JSON.stringify(itemCompra?.data?.valueCents));
  t("3d. economia BRL preservada como referência", itemCompra?.data?.economia?.precoReferenciaBRL === 250, JSON.stringify(itemCompra?.data?.economia));
  const finApos = await req(BASE, "GET", `/characters/${pjMestre}/financeiro`, { cookie: ids.cm });
  t("3e. débito = valor confirmado", finApos.json?.contas?.find((c) => c.id === contaBRL.json.id)?.balanceCents === saldoBRLAntes - 30000,
    `antes=${saldoBRLAntes} depois=${finApos.json?.contas?.find((c) => c.id === contaBRL.json.id)?.balanceCents}`);

  // 4b. pagar=false: referência no template não movimenta nada.
  const saldoAntesSP = finApos.json?.contas?.find((c) => c.id === contaBRL.json.id)?.balanceCents;
  const opSP = `sem-pag-${crypto.randomUUID().slice(0, 8)}`;
  const compraSP = await req(BASE, "POST", `/characters/${pjMestre}/financeiro/operacao`, {
    cookie: ids.cm, body: { tipo: "compra", templateId: tplId, pagar: false, quantidade: 1, requestId: opSP },
  });
  t("4b. compra sem pagamento aceita referência", compraSP.status === 201 && compraSP.json?.semMovimentacao === true, JSON.stringify(compraSP.json));
  const finSP = await req(BASE, "GET", `/characters/${pjMestre}/financeiro`, { cookie: ids.cm });
  t("4c. nenhum débito sem pagamento", finSP.json?.contas?.find((c) => c.id === contaBRL.json.id)?.balanceCents === saldoAntesSP);
  t("4d. sem transação financeira", !(finSP.json?.historico ?? []).some((h) => h.requestId === opSP));

  // 5. Conta USD: valor BRL de referência NÃO é convertido nem debitado.
  const saldoUSDAntes = finSP.json?.contas?.find((c) => c.id === contaUSD.json.id)?.balanceCents;
  const opUSD = `usd-${crypto.randomUUID().slice(0, 8)}`;
  const compraUSD = await req(BASE, "POST", `/characters/${pjMestre}/financeiro/operacao`, {
    cookie: ids.cm,
    body: { tipo: "compra", accountId: contaUSD.json.id, valor: 100, templateId: tplId, quantidade: 1, requestId: opUSD },
  });
  t("5a. compra em conta USD", compraUSD.status === 201, JSON.stringify(compraUSD.json));
  const finUSD = await req(BASE, "GET", `/characters/${pjMestre}/financeiro`, { cookie: ids.cm });
  const txUSD = (finUSD.json?.historico ?? []).find((h) => h.requestId === opUSD);
  t("5b. débito exatamente o valor informado em USD", txUSD?.currency === "USD" && txUSD?.amountCents === -10000, JSON.stringify(txUSD));
  t("5c. saldo USD sem conversão BRL", finUSD.json?.contas?.find((c) => c.id === contaUSD.json.id)?.balanceCents === saldoUSDAntes - 10000);
  const invUSD = await req(BASE, "GET", `/characters/${pjMestre}/inventario`, { cookie: ids.cm });
  const itemUSD = (invUSD.json?.itens ?? []).find((i) => i.data?.operacaoId === opUSD);
  t("5d. referência BRL permanece informativa", itemUSD?.data?.economia?.precoReferenciaBRL === 250 && itemUSD?.data?.economia?.moeda === "BRL");

  // 6. Item sem referência: comportamento manual inalterado.
  const tplManual = await req(BASE, "POST", `/campaigns/${ids.camp}/inventario`, {
    cookie: ids.cm, body: { name: "Template Manual", data: { marca: "X" } },
  });
  t("6a. template manual criado", tplManual.status === 201);
  const semRef = await req(BASE, "POST", `/characters/${pjMestre}/financeiro/operacao`, {
    cookie: ids.cm, body: { tipo: "compra", accountId: contaBRL.json.id, templateId: tplManual.json.id, pagar: true, requestId: `manual-${crypto.randomUUID().slice(0, 8)}` },
  });
  t("6b. sem referência exige valor", semRef.status === 400, `status ${semRef.status}`);
  const comRef = await req(BASE, "POST", `/characters/${pjMestre}/financeiro/operacao`, {
    cookie: ids.cm, body: { tipo: "compra", accountId: contaBRL.json.id, valor: 10, templateId: tplManual.json.id, requestId: `manual2-${crypto.randomUUID().slice(0, 8)}` },
  });
  t("6c. com valor manual funciona", comRef.status === 201, JSON.stringify(comRef.json));

  // ================= 7. Inventário: weight do vínculo =================
  sec("7. Inventário direto via template");
  const addInv = await req(BASE, "POST", `/characters/${pjJ1}/inventario`, {
    cookie: ids.j1.cookie, body: { name: "x", templateId: tplId, quantity: 1 },
  });
  t("7a. item via template criado", addInv.status === 201, JSON.stringify(addInv.json));
  const invJ1 = await req(BASE, "GET", `/characters/${pjJ1}/inventario`, { cookie: ids.j1.cookie });
  const itemJ1 = (invJ1.json?.itens ?? []).find((i) => i.id === addInv.json?.id);
  t("7b. weight veio do template", itemJ1?.weight === 0.9, JSON.stringify(itemJ1?.weight));
  t("7c. data.weight/economia preservados", itemJ1?.data?.weight === 0.9 && itemJ1?.data?.economia?.precoReferenciaBRL === 250, JSON.stringify(itemJ1?.data));

  // ================= 8. Veículos =================
  sec("8. Veículo kind:veiculo");
  const veic = await req(BASE, "POST", `/characters/${pjJ1}/veiculos`, {
    cookie: ids.j1.cookie,
    body: { name: "Buggy", regra: { kind: "veiculo", key: "buggy_teste" }, data: { fuel: "diesel", economia: { fake: true } } },
  });
  t("8a. veículo criado", veic.status === 201, JSON.stringify(veic.json));
  const veicId = veic.json?.id;
  const listaV = await req(BASE, "GET", `/characters/${pjJ1}/veiculos`, { cookie: ids.j1.cookie });
  const vRow = (listaV.json?.veiculos ?? []).find((v) => v.id === veicId);
  t("8b. data.fuel/capacity/veiculo propagados", vRow?.data?.fuel === "gasolina" && vRow?.data?.capacity === "4 ocupantes" && vRow?.data?.veiculo?.consumoOuAutonomia === "aprox. 10 km/L", JSON.stringify(vRow?.data));
  t("8c. colunas fuel/capacity do elemento", vRow?.fuel === "gasolina" && vRow?.capacity === "4 ocupantes", JSON.stringify({ fuel: vRow?.fuel, capacity: vRow?.capacity }));
  t("8d. economia forjada ignorada", vRow?.data?.economia?.precoReferenciaBRL === 50000, JSON.stringify(vRow?.data?.economia));

  // ================= 12. Anti-forja (antes do override do critério 9) =================
  sec("12. Cliente não injeta campos econômicos com vínculo");
  const forja = await req(BASE, "POST", `/characters/${pjJ1}/inventario`, {
    cookie: ids.j1.cookie,
    body: {
      name: "x", templateId: tplId, quantity: 1, weight: 99, valueCents: 1,
      data: { weight: 50, valueCents: 1, economia: { moeda: "XXX", precoReferenciaBRL: 1 } },
    },
  });
  t("12a. POST inventario forjado aceito mas sanitizado", forja.status === 201, JSON.stringify(forja.json));
  const invForja = await req(BASE, "GET", `/characters/${pjJ1}/inventario`, { cookie: ids.j1.cookie });
  const itemForja = (invForja.json?.itens ?? []).find((i) => i.id === forja.json?.id);
  t("12b. weight do template, não do cliente", itemForja?.weight === 0.9, JSON.stringify(itemForja?.weight));
  t("12c. valueCents/economia do template", itemForja?.data?.valueCents === 25000 && itemForja?.data?.economia?.precoReferenciaBRL === 250 && itemForja?.data?.economia?.moeda === "BRL", JSON.stringify(itemForja?.data));
  t("12d. data.weight não adulterado", itemForja?.data?.weight === 0.9, JSON.stringify(itemForja?.data?.weight));

  const opForja = `forja-${crypto.randomUUID().slice(0, 8)}`;
  const compraForja = await req(BASE, "POST", `/characters/${pjMestre}/financeiro/operacao`, {
    cookie: ids.cm,
    body: {
      tipo: "compra", accountId: contaBRL.json.id, valor: 260, templateId: tplId, requestId: opForja,
      item: { name: "Fake", quantity: 1, weight: 77, valueCents: 1, data: { weight: 55, valueCents: 1, economia: { fake: 1 } } },
    },
  });
  t("12e. compra forjada criada", compraForja.status === 201, JSON.stringify(compraForja.json));
  const invF2 = await req(BASE, "GET", `/characters/${pjMestre}/inventario`, { cookie: ids.cm });
  const itemF2 = (invF2.json?.itens ?? []).find((i) => i.data?.operacaoId === opForja);
  t("12f. compra ignora peso/valor do cliente", itemF2?.weight === 0.9 && itemF2?.data?.valueCents === 26000, JSON.stringify({ w: itemF2?.weight, vc: itemF2?.data?.valueCents }));
  t("12g. economia autoritativa na compra", itemF2?.data?.economia?.precoReferenciaBRL === 250 && itemF2?.data?.weight === 0.9, JSON.stringify(itemF2?.data));

  // ================= 9. Override local do mestre no template =================
  sec("9. Override no template");
  const patchTpl = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplId}`, {
    cookie: ids.cm, body: { data: { weight: 1.5, valueCents: 99900 } },
  });
  t("9a. PATCH override aceito", patchTpl.status === 200, JSON.stringify(patchTpl.json));
  const addPosOverride = await req(BASE, "POST", `/characters/${pjJ1}/inventario`, {
    cookie: ids.j1.cookie, body: { name: "x", templateId: tplId, quantity: 1 },
  });
  const invPos = await req(BASE, "GET", `/characters/${pjJ1}/inventario`, { cookie: ids.j1.cookie });
  const itemPos = (invPos.json?.itens ?? []).find((i) => i.id === addPosOverride.json?.id);
  t("9b. aquisição usa override de peso", itemPos?.weight === 1.5, JSON.stringify(itemPos?.weight));
  t("9c. aquisição usa override de valor", itemPos?.data?.valueCents === 99900, JSON.stringify(itemPos?.data?.valueCents));
  t("9d. economia do Acervo preservada", itemPos?.data?.economia?.precoReferenciaBRL === 250, JSON.stringify(itemPos?.data?.economia));

  // ================= 10. PATCH não remove regra nem economia =================
  sec("10. PATCH preserva vínculo e campos econômicos");
  const patchNome = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplId}`, {
    cookie: ids.cm, body: { name: "Pistola Renomeada" },
  });
  t("10a. PATCH só nome", patchNome.status === 200);
  const patchData = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplId}`, {
    cookie: ids.cm, body: { data: { custom: "campo-livre" } },
  });
  t("10b. PATCH data parcial", patchData.status === 200);
  const cat2 = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tpl2 = (cat2.json?.itens ?? []).find((i) => i.id === tplId);
  t("10c. regra preservada", tpl2?.data?.regra?.kind === "item" && tpl2?.data?.regra?.key === "pistola_teste", JSON.stringify(tpl2?.data?.regra));
  t("10d. economia/peso/valor preservados", tpl2?.data?.weight === 1.5 && tpl2?.data?.valueCents === 99900 && tpl2?.data?.economia?.precoReferenciaBRL === 250 && tpl2?.data?.custom === "campo-livre",
    JSON.stringify(tpl2?.data));

  // ================= 11. Legados sem campos econômicos =================
  sec("11. Compatibilidade legada");
  const addLegado = await req(BASE, "POST", `/characters/${pjJ1}/inventario`, {
    cookie: ids.j1.cookie, body: { name: "Pão integral", quantity: 2, weight: 0.5 },
  });
  t("11a. item manual criado", addLegado.status === 201, JSON.stringify(addLegado.json));
  const invLeg = await req(BASE, "GET", `/characters/${pjJ1}/inventario`, { cookie: ids.j1.cookie });
  const itemLeg = (invLeg.json?.itens ?? []).find((i) => i.id === addLegado.json?.id);
  t("11b. peso manual respeitado sem vínculo", itemLeg?.weight === 0.5);
  t("11c. sem economia inventada", itemLeg?.data?.economia === undefined && itemLeg?.data?.valueCents === undefined, JSON.stringify(itemLeg?.data));

  // ================= 13. economia com nulls =================
  sec("13. economia.precoReferenciaBRL/faixaPrecoBRL null");
  const tplNula = await req(BASE, "POST", `/campaigns/${ids.camp}/inventario`, {
    cookie: ids.cm, body: { name: "Template Nulo", regra: { kind: "item", key: "item_econ_nula" } },
  });
  t("13a. template com economia nula", tplNula.status === 201, JSON.stringify(tplNula.json));
  const cat3 = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tplNulaRow = (cat3.json?.itens ?? []).find((i) => i.id === tplNula.json?.id);
  const econNula = tplNulaRow?.data?.economia;
  t("13b. nulls preservados", econNula?.precoReferenciaBRL === null && econNula?.faixaPrecoBRL === null && econNula?.moeda === "BRL", JSON.stringify(econNula));
  t("13c. weight preservado", tplNulaRow?.data?.weight === 1.2, JSON.stringify(tplNulaRow?.data?.weight));
  // Item sem referência nenhuma: nada é inventado.
  const tplSem = await req(BASE, "POST", `/campaigns/${ids.camp}/inventario`, {
    cookie: ids.cm, body: { name: "Template Sem Ref", regra: { kind: "item", key: "item_sem_referencia" } },
  });
  const cat4 = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tplSemRow = (cat4.json?.itens ?? []).find((i) => i.id === tplSem.json?.id);
  t("13d. ausência permanece ausência", tplSemRow?.data?.weight === undefined && tplSemRow?.data?.valueCents === undefined && tplSemRow?.data?.economia === undefined, JSON.stringify(tplSemRow?.data));

  // ---- 14. Tolerância granular do schema econômico (auditoria PR #108) ----
  // Metadados econômicos inválidos/parciais NÃO podem derrubar o elemento;
  // cada campo inválido é descartado individualmente e os válidos sobrevivem.
  sec("14. schema econômico tolerante e granular");
  const catToler = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const acervoTol = catToler.json?.acervo ?? [];
  const achAcervo = (kind, key) => acervoTol.find((e) => e.regra.kind === kind && e.regra.key === key);
  const eParcial = achAcervo("item", "econ_parcial");
  const eSujo = achAcervo("item", "econ_sujo");
  const eInv = achAcervo("item", "econ_invalida");
  const eVan = achAcervo("veiculo", "van_suja");
  t("14a. elemento com economia parcial carrega", !!eParcial, "ausente do acervo");
  t("14b. economia parcial preserva só campos válidos",
    eParcial?.economia?.moeda === "BRL" && eParcial?.economia?.observacao === "só observação válida"
      && eParcial?.economia?.unidadeCompra === undefined && eParcial?.economia?.precoReferenciaBRL === undefined,
    JSON.stringify(eParcial?.economia));
  t("14c. elemento com economia suja carrega", !!eSujo, "ausente do acervo");
  t("14d. campos econômicos válidos sobrevivem à sanitização",
    eSujo?.economia?.unidadeCompra === "caixa" && eSujo?.economia?.observacao === "ok"
      && eSujo?.economia?.moeda === undefined && eSujo?.economia?.precoReferenciaBRL === undefined
      && eSujo?.economia?.base === undefined && eSujo?.economia?.extra === undefined,
    JSON.stringify(eSujo?.economia));
  t("14e. weight/valueCents válidos preservados, inválidos descartados",
    eSujo?.weight === 0.5 && eSujo?.valueCents === undefined,
    `weight=${eSujo?.weight} valueCents=${eSujo?.valueCents}`);
  t("14f. economia completamente inválida não derruba o elemento", !!eInv, "ausente do acervo");
  t("14g. economia inválida vira ausência; campos econômicos válidos ficam",
    eInv?.economia === undefined && eInv?.weight === 2 && eInv?.valueCents === 1000,
    JSON.stringify({ economia: eInv?.economia, weight: eInv?.weight, valueCents: eInv?.valueCents }));
  t("14h. veiculo com campos sujos carrega e sanitiza",
    !!eVan && eVan?.fuel === undefined && eVan?.capacity === "2 ocupantes"
      && eVan?.veiculo?.baseDoPeso === "peso bruto" && eVan?.veiculo?.consumoOuAutonomia === undefined,
    JSON.stringify({ fuel: eVan?.fuel, capacity: eVan?.capacity, veiculo: eVan?.veiculo }));
  // Definição real do Acervo continua parseando pelo schema (POST /regras/elementos).
  const livroReal = JSON.parse(readFileSync(new URL("./acervo/pacote-completo-cacadores-cacados.v1.json", import.meta.url), "utf8"));
  const itemReal = livroReal.livros.flatMap((l) => l.itens ?? []).find((i) => i.kind === "item" && i.definition?.economia);
  t("14i. definição real do Acervo encontrada", !!itemReal);
  const elReal = await req(BASE, "POST", `/campaigns/${ids.camp}/regras/elementos`, {
    cookie: ids.cm,
    body: { kind: "item", key: "check_real_acervo", name: "Check Real", definition: itemReal.definition },
  });
  t("14j. definição real do Acervo parseia sem erro", elReal.status === 201, `status=${elReal.status} ${JSON.stringify(elReal.json).slice(0, 200)}`);
  const elRealRow = await req(BASE, "GET", `/campaigns/${ids.camp}/regras/elementos`, { cookie: ids.cm });
  const elRealDef = (elRealRow.json?.elementos ?? []).find((e) => e.key === "check_real_acervo")?.definition;
  t("14k. campos econômicos reais preservados no round-trip",
    elRealDef?.weight === itemReal.definition.weight && elRealDef?.valueCents === itemReal.definition.valueCents
      && elRealDef?.economia?.precoReferenciaBRL === itemReal.definition.economia.precoReferenciaBRL,
    JSON.stringify({ w: elRealDef?.weight, v: elRealDef?.valueCents, econ: elRealDef?.economia?.precoReferenciaBRL }));
  // Validação estrutural das regras NÃO foi enfraquecida.
  const elEstrutural = await req(BASE, "POST", `/campaigns/${ids.camp}/regras/elementos`, {
    cookie: ids.cm,
    body: { kind: "item", key: "check_ruim", name: "Check Ruim", definition: { custoPontos: "abc" } },
  });
  t("14l. campo estrutural inválido continua rejeitado", elEstrutural.status === 400, `status=${elEstrutural.status}`);

  // ---- 15. valueCents de veículo = valor local declarado ----
  // O valor superior do POST /veiculos é declarado por quem está
  // autorizado a editar o veículo (aqui, o jogador com
  // jogadorEditaVeiculos): é local, não altera o Acervo, não significa
  // valor pago e não movimenta dinheiro.
  sec("15. veículo: valueCents declarado é local, sem débito");
  const finAntes = await req(BASE, "GET", `/characters/${pjJ1}/financeiro`, { cookie: ids.j1.cookie });
  const nFinAntes = (finAntes.json?.historico ?? []).length;
  const veicDecl = await req(BASE, "POST", `/characters/${pjJ1}/veiculos`, {
    cookie: ids.j1.cookie,
    body: { name: "Van Declarada", regra: { kind: "veiculo", key: "van_suja" }, valueCents: 777000 },
  });
  t("15a. veículo com valor declarado criado", veicDecl.status === 201, JSON.stringify(veicDecl.json));
  const veicDeclId = veicDecl.json?.id;
  const veicRow = await req(BASE, "GET", `/characters/${pjJ1}/veiculos`, { cookie: ids.j1.cookie });
  const vDecl = (veicRow.json?.veiculos ?? []).find((v) => v.id === veicDeclId);
  const veicData = vDecl?.data;
  t("15b. valueCents declarado fica local no veículo",
    veicData?.valueCents === 777000 && veicData?.capacity === "2 ocupantes" && veicData?.veiculo?.baseDoPeso === "peso bruto",
    JSON.stringify(veicData));
  t("15c. fuel inválido do Acervo permanece ausente (não inventado)",
    veicData?.fuel === undefined && vDecl?.fuel === null, JSON.stringify({ data: veicData?.fuel, col: vDecl?.fuel }));
  t("15d. regra vinculada permanece no snapshot local", veicData?.regra?.key === "van_suja", JSON.stringify(veicData?.regra));
  const finDepois = await req(BASE, "GET", `/characters/${pjJ1}/financeiro`, { cookie: ids.j1.cookie });
  const nFinDepois = (finDepois.json?.historico ?? []).length;
  t("15e. nenhum débito/movimento financeiro criado", nFinDepois === nFinAntes, `${nFinAntes}→${nFinDepois}`);

  // ---- 16. Desvinculação de template preserva dados econômicos locais ----
  sec("16. PATCH regra:null preserva snapshot econômico local");
  const desv = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplNula.json?.id}`, {
    cookie: ids.cm, body: { regra: null },
  });
  t("16a. desvinculação aceita", desv.status === 200 || desv.status === 204, `status=${desv.status}`);
  const catDesv = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tplDesv = (catDesv.json?.itens ?? []).find((i) => i.id === tplNula.json?.id);
  t("16b. vínculo removido", !tplDesv?.data?.regra && tplDesv?.regra === undefined, JSON.stringify(tplDesv?.data?.regra));
  t("16c. weight/valueCents/economia/fuel/capacity/veiculo preservados",
    tplDesv?.data?.weight === 1.2 && tplDesv?.data?.valueCents === undefined
      && tplDesv?.data?.economia?.precoReferenciaBRL === null && tplDesv?.data?.economia?.faixaPrecoBRL === null
      && tplDesv?.data?.economia?.moeda === "BRL",
    JSON.stringify(tplDesv?.data));
  // Desvinculação de template veicular preserva os seis campos econômicos.
  const tplBuggy = await req(BASE, "POST", `/campaigns/${ids.camp}/inventario`, {
    cookie: ids.cm, body: { name: "Template Buggy", regra: { kind: "veiculo", key: "buggy_teste" } },
  });
  t("16d. template veicular vinculado", tplBuggy.status === 201, JSON.stringify(tplBuggy.json));
  const desvBuggy = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplBuggy.json?.id}`, {
    cookie: ids.cm, body: { regra: null },
  });
  t("16e. desvinculação veicular aceita", desvBuggy.status === 200, `status=${desvBuggy.status}`);
  const catDesv2 = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tplBuggyRow = (catDesv2.json?.itens ?? []).find((i) => i.id === tplBuggy.json?.id);
  t("16f. seis campos econômicos preservados após desvincular",
    !tplBuggyRow?.data?.regra
      && tplBuggyRow?.data?.weight === 800 && tplBuggyRow?.data?.valueCents === 5000000
      && tplBuggyRow?.data?.fuel === "gasolina" && tplBuggyRow?.data?.capacity === "4 ocupantes"
      && tplBuggyRow?.data?.veiculo?.consumoOuAutonomia === "aprox. 10 km/L"
      && tplBuggyRow?.data?.economia?.precoReferenciaBRL === 50000,
    JSON.stringify(tplBuggyRow?.data));

  // ---- 17. PATCH /veiculos: fuel/capacity do Acervo são autoridade ----
  // Veículo vinculado: colunas fuel/capacity não podem ser substituídas
  // quando o valor é originário do Acervo (snapshot local ou elemento).
  sec("17. PATCH veículo vinculado protege fuel/capacity do Acervo");
  const veicProt = await req(BASE, "POST", `/characters/${pjJ1}/veiculos`, {
    cookie: ids.j1.cookie,
    body: { name: "Buggy Protegido", regra: { kind: "veiculo", key: "buggy_teste" } },
  });
  t("17a. veículo vinculado criado", veicProt.status === 201, JSON.stringify(veicProt.json));
  const veicProtId = veicProt.json?.id;
  const patchProt = await req(BASE, "PATCH", `/characters/${pjJ1}/veiculos/${veicProtId}`, {
    cookie: ids.j1.cookie,
    body: {
      name: "Buggy Protegido 2", brand: "Oficina X",
      fuel: "etanol", capacity: "12 lugares",
      data: { fuel: "fake", capacity: "fake", obs: "anotação local" },
    },
  });
  t("17b. PATCH misto aceito", patchProt.status === 200, `status=${patchProt.status}`);
  const listaProt = await req(BASE, "GET", `/characters/${pjJ1}/veiculos`, { cookie: ids.j1.cookie });
  const vProt = (listaProt.json?.veiculos ?? []).find((v) => v.id === veicProtId);
  t("17c. campos locais editáveis funcionam",
    vProt?.name === "Buggy Protegido 2" && vProt?.brand === "Oficina X", JSON.stringify({ name: vProt?.name, brand: vProt?.brand }));
  t("17d. colunas fuel/capacity do Acervo preservadas",
    vProt?.fuel === "gasolina" && vProt?.capacity === "4 ocupantes",
    JSON.stringify({ fuel: vProt?.fuel, capacity: vProt?.capacity }));
  t("17e. data.fuel/capacity do snapshot preservados, data.obs editável",
    vProt?.data?.fuel === "gasolina" && vProt?.data?.capacity === "4 ocupantes"
      && vProt?.data?.obs === "anotação local",
    JSON.stringify(vProt?.data));
  t("17f. vínculo e snapshot econômico intactos",
    vProt?.data?.regra?.key === "buggy_teste" && vProt?.data?.valueCents === 5000000
      && vProt?.data?.economia?.precoReferenciaBRL === 50000
      && vProt?.data?.veiculo?.consumoOuAutonomia === "aprox. 10 km/L",
    JSON.stringify(vProt?.data));
  // Acervo não fornece fuel para van_suja → campo local continua editável;
  // capacity veio do Acervo ("2 ocupantes") → protegido.
  const patchVan = await req(BASE, "PATCH", `/characters/${pjJ1}/veiculos/${veicDeclId}`, {
    cookie: ids.j1.cookie,
    body: { fuel: "solar", capacity: "99 lugares" },
  });
  t("17g. PATCH na van aceita", patchVan.status === 200, `status=${patchVan.status}`);
  const listaVan = await req(BASE, "GET", `/characters/${pjJ1}/veiculos`, { cookie: ids.j1.cookie });
  const vVan = (listaVan.json?.veiculos ?? []).find((v) => v.id === veicDeclId);
  t("17h. fuel local editável quando Acervo não fornece",
    vVan?.fuel === "solar" && vVan?.data?.valueCents === 777000, JSON.stringify({ fuel: vVan?.fuel, data: vVan?.data }));
  t("17i. capacity do Acervo protegido mesmo sem fuel",
    vVan?.capacity === "2 ocupantes" && vVan?.data?.capacity === "2 ocupantes",
    JSON.stringify({ capacity: vVan?.capacity, dataCap: vVan?.data?.capacity }));
  // valueCents declarado não pode ser negativo (patrimônio, não saldo).
  const neg = await req(BASE, "POST", `/characters/${pjJ1}/veiculos`, {
    cookie: ids.j1.cookie,
    body: { name: "Van Negativa", valueCents: -100 },
  });
  t("17j. valueCents negativo rejeitado", neg.status === 400, `status=${neg.status}`);
  const negPatch = await req(BASE, "PATCH", `/characters/${pjJ1}/veiculos/${veicProtId}`, {
    cookie: ids.j1.cookie, body: { valueCents: -1 },
  });
  t("17k. PATCH valueCents negativo rejeitado", negPatch.status === 400, `status=${negPatch.status}`);

  // ================= 18. PATCH inventário vinculado: colunas e valueCents =================
  sec("18. PATCH inventário — peso/valor de primeiro nível não são forjáveis");
  // A. Item vinculado COM referência (override do mestre: peso 1.5, valor 99900).
  const patchInvForja = await req(BASE, "PATCH", `/characters/${pjJ1}/inventario/${addPosOverride.json?.id}`, {
    cookie: ids.j1.cookie,
    body: {
      weight: 99, valueCents: 1,
      data: { weight: 50, valueCents: 1, economia: { moeda: "XXX", precoReferenciaBRL: 1 }, obs: "nota" },
    },
  });
  t("18a. PATCH forjado aceito", patchInvForja.status === 200, `status=${patchInvForja.status}`);
  const invA = await req(BASE, "GET", `/characters/${pjJ1}/inventario`, { cookie: ids.j1.cookie });
  const itemA = (invA.json?.itens ?? []).find((i) => i.id === addPosOverride.json?.id);
  t("18b. coluna weight preserva autoridade do template",
    itemA?.weight === 1.5, JSON.stringify(itemA?.weight));
  t("18c. data.weight/data.valueCents snapshot autoritativo",
    itemA?.data?.weight === 1.5 && itemA?.data?.valueCents === 99900, JSON.stringify(itemA?.data));
  t("18d. data.economia não contaminada e campo livre editável",
    itemA?.data?.economia?.precoReferenciaBRL === 250 && itemA?.data?.obs === "nota", JSON.stringify(itemA?.data?.economia));
  t("18e. vínculo regra intacto",
    itemA?.data?.regra?.kind === "item" && itemA?.data?.regra?.key === "pistola_teste", JSON.stringify(itemA?.data?.regra));

  // B. Item vinculado SEM referência de peso/valor (item_sem_referencia).
  const tplSemRef = await req(BASE, "POST", `/campaigns/${ids.camp}/inventario`, {
    cookie: ids.cm, body: { name: "Template Sem Ref", regra: { kind: "item", key: "item_sem_referencia" } },
  });
  t("18f. template sem referência criado", tplSemRef.status === 201, JSON.stringify(tplSemRef.json));
  const addSemRef = await req(BASE, "POST", `/characters/${pjJ1}/inventario`, {
    cookie: ids.j1.cookie, body: { name: "x", templateId: tplSemRef.json?.id, quantity: 1 },
  });
  t("18g. item sem referência adquirido", addSemRef.status === 201, JSON.stringify(addSemRef.json));
  const patchSemRef = await req(BASE, "PATCH", `/characters/${pjJ1}/inventario/${addSemRef.json?.id}`, {
    cookie: ids.j1.cookie,
    body: { weight: 7, valueCents: 4242, data: { weight: 8, valueCents: 9, economia: { moeda: "XXX" } } },
  });
  t("18h. PATCH forjado em item sem referência aceito", patchSemRef.status === 200, `status=${patchSemRef.status}`);
  const invB = await req(BASE, "GET", `/characters/${pjJ1}/inventario`, { cookie: ids.j1.cookie });
  const itemB = (invB.json?.itens ?? []).find((i) => i.id === addSemRef.json?.id);
  t("18i. peso não inventado: coluna e data ausentes",
    (itemB?.weight ?? null) === null && itemB?.data?.weight === undefined, JSON.stringify({ w: itemB?.weight, dw: itemB?.data?.weight }));
  t("18j. valor não inventado: data.valueCents ausente",
    itemB?.data?.valueCents === undefined, JSON.stringify(itemB?.data?.valueCents));
  t("18k. nenhuma economia inventada, vínculo válido",
    itemB?.data?.economia === undefined && itemB?.data?.regra?.key === "item_sem_referencia", JSON.stringify(itemB?.data));

  // C. Item manual sem vínculo: edição legítima de peso/valor preservada.
  const patchLegado = await req(BASE, "PATCH", `/characters/${pjJ1}/inventario/${addLegado.json?.id}`, {
    cookie: ids.j1.cookie, body: { weight: 0.8, valueCents: 500 },
  });
  t("18l. PATCH manual aceito", patchLegado.status === 200, `status=${patchLegado.status}`);
  const invC = await req(BASE, "GET", `/characters/${pjJ1}/inventario`, { cookie: ids.j1.cookie });
  const itemC = (invC.json?.itens ?? []).find((i) => i.id === addLegado.json?.id);
  t("18m. peso/valor manuais editáveis sem vínculo",
    itemC?.weight === 0.8 && itemC?.data?.valueCents === 500, JSON.stringify({ w: itemC?.weight, vc: itemC?.data?.valueCents }));

  // ---- 19. Restaurar referência do Acervo (Issue #119) ----
  // null explícito em campo econômico = pedido de restauração: o
  // override local é removido e a mescla com o elemento repõe a
  // referência — ou deixa ausente quando o Acervo não tem o campo.
  // Omitir a chave no PATCH continua preservando o valor atual.
  sec("19. Restaurar referência do Acervo via PATCH data:null");
  // Estado atual de tplId: overrides 1.5 / 99900 (seção 9) + custom.
  const cat19a = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tpl19 = (cat19a.json?.itens ?? []).find((i) => i.id === tplId);
  t("19a. overrides vigentes antes da restauração",
    tpl19?.data?.weight === 1.5 && tpl19?.data?.valueCents === 99900, JSON.stringify(tpl19?.data));
  // PATCH parcial que OMITE os campos econômicos: overrides preservados.
  const patchOmite = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplId}`, {
    cookie: ids.cm, body: { data: { custom: "preserva-override" } },
  });
  t("19b. PATCH omitindo campos preserva overrides", patchOmite.status === 200);
  const cat19b = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tpl19b = (cat19b.json?.itens ?? []).find((i) => i.id === tplId);
  t("19c. omissão preserva weight/valueCents",
    tpl19b?.data?.weight === 1.5 && tpl19b?.data?.valueCents === 99900 && tpl19b?.data?.custom === "preserva-override",
    JSON.stringify(tpl19b?.data));
  // Restauração explícita: null nos três campos econômicos editáveis.
  const patchRestaura = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplId}`, {
    cookie: ids.cm,
    body: { data: { weight: null, valueCents: null, economia: null, custom: "apos-restaurar" } },
  });
  t("19d. PATCH de restauração aceito", patchRestaura.status === 200, JSON.stringify(patchRestaura.json));
  const cat19c = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tpl19c = (cat19c.json?.itens ?? []).find((i) => i.id === tplId);
  t("19e. peso voltou à referência do Acervo (0.9)", tpl19c?.data?.weight === 0.9, JSON.stringify(tpl19c?.data?.weight));
  t("19f. valor voltou à referência do Acervo (25000)", tpl19c?.data?.valueCents === 25000, JSON.stringify(tpl19c?.data?.valueCents));
  t("19g. economia voltou à referência (precoReferenciaBRL=250)",
    tpl19c?.data?.economia?.precoReferenciaBRL === 250 && tpl19c?.data?.economia?.moeda === "BRL", JSON.stringify(tpl19c?.data?.economia));
  t("19h. campos não relacionados preservados (custom, regra)",
    tpl19c?.data?.custom === "apos-restaurar" && tpl19c?.data?.regra?.key === "pistola_teste", JSON.stringify({ custom: tpl19c?.data?.custom, regra: tpl19c?.data?.regra }));
  // Novo override + restauração parcial: só o peso volta; o valor
  // continua sendo o override local (null seletivo por campo).
  const patchOverride2 = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplId}`, {
    cookie: ids.cm, body: { data: { weight: 2.5, valueCents: 11100 } },
  });
  t("19i. novo override parcial aceito", patchOverride2.status === 200);
  const patchRestauraPeso = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplId}`, {
    cookie: ids.cm, body: { data: { weight: null } },
  });
  t("19j. restauração só do peso aceita", patchRestauraPeso.status === 200);
  const cat19d = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tpl19d = (cat19d.json?.itens ?? []).find((i) => i.id === tplId);
  t("19k. peso restaurado, override de valor preservado",
    tpl19d?.data?.weight === 0.9 && tpl19d?.data?.valueCents === 11100, JSON.stringify({ w: tpl19d?.data?.weight, v: tpl19d?.data?.valueCents }));
  // Elemento SEM referência: override local existe → restaurar deixa ausente.
  const patchSemRefOverride = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplSemRef.json?.id}`, {
    cookie: ids.cm, body: { data: { weight: 3.3, valueCents: 4400, custom: "local" } },
  });
  t("19l. override em item sem referência aceito", patchSemRefOverride.status === 200);
  const patchSemRefRestaura = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplSemRef.json?.id}`, {
    cookie: ids.cm, body: { data: { weight: null, valueCents: null, economia: null, custom: "local" } },
  });
  t("19m. restauração em item sem referência aceita", patchSemRefRestaura.status === 200);
  const cat19e = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tplSemRefRow = (cat19e.json?.itens ?? []).find((i) => i.id === tplSemRef.json?.id);
  t("19n. sem referência: campos permanecem ausentes (nada inventado)",
    tplSemRefRow?.data?.weight === undefined && tplSemRefRow?.data?.valueCents === undefined && tplSemRefRow?.data?.economia === undefined,
    JSON.stringify(tplSemRefRow?.data));
  t("19o. campo livre do template sem referência preservado",
    tplSemRefRow?.data?.custom === "local" && tplSemRefRow?.data?.regra?.key === "item_sem_referencia", JSON.stringify(tplSemRefRow?.data));
  // Template desvinculado: null limpa o campo e NÃO repõe referência
  // (não há elemento para mesclar) — ausência honesta.
  const desvLimpa = await req(BASE, "PATCH", `/campaigns/${ids.camp}/inventario/${tplBuggyRow?.id}`, {
    cookie: ids.cm, body: { data: { weight: null, valueCents: null, economia: null } },
  });
  t("19p. restauração em template desvinculado aceita", desvLimpa.status === 200, `status=${desvLimpa.status}`);
  const cat19f = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm });
  const tplBuggyLimpo = (cat19f.json?.itens ?? []).find((i) => i.id === tplBuggy.json?.id);
  t("19q. desvinculado: campos econômicos ficam ausentes",
    tplBuggyLimpo?.data?.weight === undefined && tplBuggyLimpo?.data?.valueCents === undefined && tplBuggyLimpo?.data?.economia === undefined,
    JSON.stringify(tplBuggyLimpo?.data));
  // Regra do Acervo permanece intocada (imutabilidade já verificada abaixo).

  // Imutabilidade final do Acervo (após TODAS as operações).
  {
    const w = abrirDb(BANCO);
    try {
      const finais = {};
      for (const r of w.prepare("select kind || ':' || key as chave, definition from rule_definitions where rule_set_id=?").all(rs)) {
        finais[r.chave] = r.definition;
      }
      w.close();
      t("2b. rule_definitions inalterado ao final", Object.keys(defsAntes).every((k) => finais[k] === defsAntes[k]));
    } catch (e) { w.close(); throw e; }
  }
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
