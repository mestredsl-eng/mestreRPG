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
const REGRA_ITEM_F16 = { kind: "item", key: "item_restrito_conducao" };
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

  const seedBiblioteca = await req(BASE, "POST", `/campaigns/${ids.camp}/regras/seed`, { cookie: ids.cm });
  if (seedBiblioteca.status !== 200) throw new Error(`Falha ao carregar biblioteca inicial: ${seedBiblioteca.status}`);

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
  const pjSemPericias = crypto.randomUUID();
  mkPj(pjSemPericias, ids.j2.membershipId, {});

  // Elementos do Acervo no rule_set ativo
  const rs = comDb(BANCO, (db) => db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(ids.camp).id);
  const chavesAcervo = [
    "pericia:armas_brancas", "pericia:armas_de_fogo", "pericia:conducao",
    "pericia:sobrevivencia", "pericia:seguranca", "pericia:empatia_com_animal",
    "talento:hacker", "talento:tecnologia", "talento:quimico", "talento:artista", "talento:esportes",
    "conhecimento:computador", "conhecimento:ciencias",
    "conhecimento:medicina", "conhecimento:investigacao", "conhecimento:geologia",
  ];
  const seedPresentes = comDb(BANCO, (db) => new Set(
    db.prepare("select kind || ':' || key as chave from rule_definitions where rule_set_id=?").all(rs).map((r) => r.chave)
  ));
  const seedAusentes = chavesAcervo.filter((chave) => !seedPresentes.has(chave));
  t("biblioteca inicial inclui os 16 destinos de pré-requisito dos suplementos", seedBiblioteca.status === 200 && seedAusentes.length === 0, seedAusentes.join(", "));
  const insRegra = (kind, key, name, prereqs, disponivel = true) => {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), rs, kind, key, name, null, null,
          JSON.stringify({ descricao: "", custoPontos: 0, niveis: [], minimo: 0, maximo: 1, prerequisitos: prereqs, dependencias: [], gruposExclusividade: [], exclusivos: [], obrigatorios: [], formulas: {}, disponivel }),
          agora, agora);
    } finally { w.close(); }
  };
  // Elementos de apoio (pericias/talentos/conhecimentos) vêm da biblioteca
  // inicial real; aqui o teste cria somente os itens/veículos que consomem essas regras.
  insRegra("item", "carro_popular", "Carro Popular", [{ kind: "pericia", key: "conducao", minLevel: 1 }]);
  // Fixture kind:item para exercitar as rotas de inventário/bypass sem
  // classificar um veículo real como item.
  insRegra("item", "item_restrito_conducao", "Item restrito (teste)", [{ kind: "pericia", key: "conducao", minLevel: 5 }]);
  insRegra("veiculo", "suv_blindado", "SUV reforçado", [{ kind: "pericia", key: "conducao", minLevel: 1 }]);
  insRegra("veiculo", "moto_policial", "Motocicleta de serviço", [{ kind: "pericia", key: "conducao", minLevel: 1 }]);
  insRegra("veiculo", "helicoptero_civil", "Helicóptero civil", [{ kind: "pericia", key: "conducao", minLevel: 1 }]);
  insRegra("veiculo", "caca_f16", "Caça F-16", [{ kind: "pericia", key: "conducao", minLevel: 5 }]);
  insRegra("item", "pistola_compacta_reserva", "Pistola compacta de reserva", [{ kind: "pericia", key: "armas_de_fogo", minLevel: 1 }]);
  insRegra("item", "fuzil_servico", "Fuzil de serviço", [{ kind: "pericia", key: "armas_de_fogo", minLevel: 1 }]);
  insRegra("item", "tonfa", "Tonfa", [{ kind: "pericia", key: "armas_brancas", minLevel: 1 }]);
  insRegra("item", "kit_campo", "Kit de Campo", []);
  insRegra("item", "item_desativado", "Item desativado", [], false);
  insRegra("pericia", "pericia_desativada", "Perícia desativada", [], false);
  insRegra("item", "item_requer_pericia_desativada", "Item que exige perícia desativada", [{ kind: "pericia", key: "pericia_desativada", minLevel: 1 }]);
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
  const det = (r.json?.detalhes?.mensagens ?? []).join(" ");
  t("mensagem explica nível atual/exigido", /Condução/.test(det) && /nível 5/.test(det) && /atual: 2|nível atual é 2/.test(det), det);

  sec("pré-requisito atendido");
  r = await post(pjJ1, "/inventario", { name: "Carro Popular", regra: REGRA_CARRO }, ids.j1.cookie);
  t("j1 Condução 2: carro (exige 1) aceito", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  const itemCarro = r.json?.id;
  const itemRow = comDb(BANCO, (db) => db.prepare("select data from inventory_entries where id=?").get(itemCarro));
  t("referência da regra persistida no item", JSON.parse(itemRow?.data ?? "{}").regra?.key === "carro_popular");

  sec("veículos reais do suplemento exigem Condução 1");
  for (const [key, nome] of [
    ["suv_blindado", "SUV reforçado"],
    ["moto_policial", "Motocicleta de serviço"],
    ["helicoptero_civil", "Helicóptero civil"],
  ]) {
    r = await post(pjJ1, "/veiculos", { name: nome, regra: { kind: "veiculo", key } }, ids.j1.cookie);
    t(`${key}: Condução 2 atende ao nível 1`, r.status === 201, `status=${r.status}`);
  }

  sec("armas reais do suplemento exigem perícia correspondente");
  for (const [key, nome] of [
    ["pistola_compacta_reserva", "Pistola compacta de reserva"],
    ["fuzil_servico", "Fuzil de serviço"],
    ["tonfa", "Tonfa"],
  ]) {
    r = await post(pjJ2, "/inventario", { name: nome, regra: { kind: "item", key } }, ids.j2.cookie);
    t(`${key}: sem perícia, aquisição bloqueada`, r.status === 403, `status=${r.status}`);
  }
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("update characters set data=? where id=?").run(JSON.stringify({
        "cmp-pericias": [
          { key: "armas_de_fogo", nivel: 1 },
          { key: "armas_brancas", nivel: 1 },
        ],
      }), pjJ2);
    } finally { w.close(); }
  }
  for (const [key, nome] of [
    ["pistola_compacta_reserva", "Pistola compacta de reserva"],
    ["fuzil_servico", "Fuzil de serviço"],
    ["tonfa", "Tonfa"],
  ]) {
    r = await post(pjJ2, "/inventario", { name: nome, regra: { kind: "item", key } }, ids.j2.cookie);
    t(`${key}: nível 1 libera aquisição`, r.status === 201, `status=${r.status}`);
  }

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
  r = await post(pjJ1, "/financeiro/operacao", { tipo: "compra", accountId: contaId, valor: 500, item: { name: "Item restrito", regra: REGRA_ITEM_F16 } }, ids.j1.cookie);
  t("compra paga F-16 bloqueada", r.status === 403, `status=${r.status}`);
  const saldoDepois = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
  t("saldo intacto após bloqueio", saldoAntes === saldoDepois, `${saldoAntes}→${saldoDepois}`);
  // carro pago por j1: aceito e debita
  r = await post(pjJ1, "/financeiro/operacao", { tipo: "compra", accountId: contaId, valor: 100, item: { name: "Carro2", regra: REGRA_CARRO } }, ids.j1.cookie);
  t("compra paga carro aceita", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
  const saldoFinal = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId)?.balance_cents);
  t("débito aplicado", saldoFinal === saldoAntes - 10000, `${saldoAntes}→${saldoFinal}`);

  sec("metadados forjados não contornam");
  r = await post(pjSemPericias, "/inventario", { name: "Item restrito fake", regra: REGRA_ITEM_F16, data: { prerequisitos: [], nivelConducao: 99 } }, ids.j2.cookie);
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
  const kitRow = comDb(BANCO, (db) => db.prepare("select id from inventory_entries where character_id=? and name='Kit de Campo'").get(pjJ1));
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


  sec("identidade canônica — nome não pode vestir outro elemento");
  // j1 (Condução 2): referencia kit_campo (livre) mas chama de "Caça F-16"
  r = await post(pjJ1, "/inventario", { name: "Caça F-16 Fighting Falcon", regra: REGRA_LIVRE }, ids.j1.cookie);
  t("spoof de nome aceito só como o elemento real", r.status === 201, `status=${r.status}`);
  const spoofRow = comDb(BANCO, (db) => db.prepare("select name, data from inventory_entries where id=?").get(r.json?.id));
  t("nome persistido é o do elemento, não o forjado", spoofRow?.name === "Kit de Campo", spoofRow?.name);
  // spoof reverso: nome inocente + referência restrita continua exigindo requisito
  r = await post(pjJ2, "/inventario", { name: "Item restrito", regra: REGRA_ITEM_F16 }, ids.j2.cookie);
  t("item restrito por Condução 5 aceito", r.status === 201, `status=${r.status}`);

  sec("PATCH não troca nem remove o vínculo regra");
  const itemRegra = comDb(BANCO, (db) => db.prepare("select id, data from inventory_entries where character_id=? and name='Carro Popular'").get(pjJ1));
  r = await req(BASE, "PATCH", `/characters/${pjJ1}/inventario/${itemRegra?.id}`, { cookie: ids.j1.cookie, body: { data: { regra: { kind: "item", key: "kit_campo" }, templateId: "template-forjado" } } });
  t("PATCH data.regra/templateId não altera procedência", r.status === 200, `status=${r.status}`);
  const aposPatch = JSON.parse(comDb(BANCO, (db) => db.prepare("select data from inventory_entries where id=?").get(itemRegra?.id))?.data ?? "{}");
  t("vínculo original preservado", aposPatch.regra?.key === "carro_popular", JSON.stringify(aposPatch.regra));
  t("templateId forjado via PATCH é removido", aposPatch.templateId === undefined, JSON.stringify(aposPatch.templateId));

  sec("templateId vinculado ao Acervo");
  // mestre cria template vinculado ao F-16
  const tplF16 = await req(BASE, "POST", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm, body: { name: "Caça F-16 (catálogo)", regra: { kind: "veiculo", key: "caca_f16" } } });
  t("template de veículo vinculado criado", tplF16.status === 201, `status=${tplF16.status} ${JSON.stringify(tplF16.json).slice(0,120)}`);
  const tplF16Id = tplF16.json?.id;
  const tplItemRestrito = await req(BASE, "POST", `/campaigns/${ids.camp}/inventario`, {
    cookie: ids.cm, body: { name: "Item restrito (catálogo)", regra: REGRA_ITEM_F16 },
  });
  t("template de item restrito criado", tplItemRestrito.status === 201, `status=${tplItemRestrito.status}`);
  const tplItemRestritoId = tplItemRestrito.json?.id;
  // Template de item do Acervo: a regra do catálogo deve ser aplicada
  // também na rota direta de inclusão no inventário (não só na compra).
  const tplCarro = await req(BASE, "POST", `/campaigns/${ids.camp}/inventario`, {
    cookie: ids.cm, body: { name: "Carro do catálogo", regra: { kind: "item", key: "carro_popular" } },
  });
  t("template Carro Popular vinculado criado", tplCarro.status === 201, `status=${tplCarro.status}`);
  const tplCarroId = tplCarro.json?.id;
  // template manual sem vínculo segue legado
  const tplLivre = await req(BASE, "POST", `/campaigns/${ids.camp}/inventario`, { cookie: ids.cm, body: { name: "Suprimento", data: { peso: 1 } } });
  t("template manual criado", tplLivre.status === 201, `status=${tplLivre.status}`);

  r = await post(pjSemPericias, "/inventario", { name: "Carro", templateId: tplCarroId }, ids.j2.cookie);
  t("POST inventário por template restrito bloqueia sem Condução", r.status === 403, `status=${r.status}`);
  r = await post(pjJ1, "/inventario", { name: "F-16", templateId: tplF16Id }, ids.j1.cookie);
  t("inventário recusa template vinculado a veículo", r.status === 400, `status=${r.status}`);
  r = await post(pjJ2, "/inventario", { name: "Carro", templateId: tplCarroId, regra: REGRA_LIVRE }, ids.j2.cookie);
  t("regra livre do cliente não substitui vínculo restrito do template", r.status === 403, `status=${r.status}`);
  r = await post(pjJ1, "/inventario", { name: "Nome forjado", templateId: tplCarroId }, ids.j1.cookie);
  t("POST inventário por template permite personagem elegível", r.status === 201, `status=${r.status}`);
  const itemTpl = comDb(BANCO, (db) => db.prepare("select name, data from inventory_entries where id=?").get(r.json?.id));
  const dataTpl = JSON.parse(itemTpl?.data ?? "{}");
  t("template persiste identidade e vínculo canônicos", itemTpl?.name === "Carro Popular" && dataTpl.regra?.key === "carro_popular" && dataTpl.templateId === tplCarroId, JSON.stringify({ name: itemTpl?.name, regra: dataTpl.regra, templateId: dataTpl.templateId }));
  r = await post(pjJ1, "/inventario", { name: "Suprimento", templateId: tplLivre.json?.id }, ids.j1.cookie);
  t("POST inventário preserva template manual legado", r.status === 201, `status=${r.status}`);

  // j1 (Condução 2) compra template F-16 → bloqueado antes do débito
  const contaId2 = contaId;
  const saldoAntes2 = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId2)?.balance_cents);
  r = await post(pjJ1, "/financeiro/operacao", { tipo: "compra", accountId: contaId2, valor: 99900, templateId: tplItemRestritoId }, ids.j1.cookie);
  t("compra por template de item restrito bloqueada", r.status === 403, `status=${r.status} ${JSON.stringify(r.json).slice(0,140)}`);
  const saldoDepois2 = comDb(BANCO, (db) => db.prepare("select balance_cents from financial_accounts where id=?").get(contaId2)?.balance_cents);
  t("saldo intacto (template)", saldoAntes2 === saldoDepois2);
  // Template de veículo não pode ser adquirido pela operação financeira,
  // que grava em inventory_entries, nem por referência enviada diretamente.
  r = await post(pjJ1, "/financeiro/operacao", { tipo: "compra", pagar: false, templateId: tplF16Id }, ids.j1.cookie);
  t("compra financeira recusa template kind:veiculo", r.status === 400, `status=${r.status}`);
  r = await post(pjJ1, "/financeiro/operacao", { tipo: "compra", pagar: false, item: { name: "F-16", regra: REGRA_F16 } }, ids.j1.cookie);
  t("compra financeira recusa referência kind:veiculo", r.status === 400, `status=${r.status}`);
  // cliente tenta minar o vínculo enviando regra livre junto ao template
  r = await post(pjJ1, "/financeiro/operacao", { tipo: "compra", pagar: false, templateId: tplItemRestritoId, regra: REGRA_LIVRE }, ids.j1.cookie);
  t("regra do cliente não sobrepõe vínculo do template", r.status === 403, `status=${r.status}`);
  // template manual funciona sem requisito
  r = await post(pjJ1, "/financeiro/operacao", { tipo: "compra", pagar: false, templateId: tplLivre.json?.id }, ids.j1.cookie);
  t("template manual sem vínculo aceito", r.status === 201, `status=${r.status}`);

  sec("equipamentos protegidos e kind coerente por rota");
  r = await post(pjJ1, "/equipamentos", { name: "Colete", regra: REGRA_F16 }, ids.j1.cookie);
  t("equipamento com veículo do Acervo recusado por kind", r.status === 400, `status=${r.status}`);
  r = await post(pjJ1, "/veiculos", { name: "Carro", regra: REGRA_CARRO }, ids.j1.cookie);
  t("rota de veículos recusa elemento kind:item", r.status === 400, `status=${r.status}`);
  r = await post(pjJ1, "/inventario", { name: "F-16", regra: REGRA_F16 }, ids.j1.cookie);
  t("rota de inventário recusa elemento kind:veiculo", r.status === 400, `status=${r.status}`);
  r = await post(pjSemPericias, "/equipamentos", { name: "Colete", regra: REGRA_CARRO }, ids.j2.cookie);
  t("equipamento com pré-req insuficiente bloqueado", r.status === 403, `status=${r.status}`);

  sec("mestre: bypass explícito auditado, sem flag respeita");
  // PJ do mestre com a mesma ficha e ficha vazia
  const pjMestre = crypto.randomUUID();
  mkPj(pjMestre, cenario.membMestre, {});
  r = await post(pjMestre, "/inventario", { name: "Item restrito mestre", regra: REGRA_ITEM_F16 }, ids.cm);
  t("mestre SEM flag também é bloqueado", r.status === 403, `status=${r.status}`);
  r = await post(pjMestre, "/inventario", { name: "Item restrito mestre", regra: REGRA_ITEM_F16, ignorarPrerequisitos: true }, ids.cm);
  t("mestre COM flag explícita adquire", r.status === 201, `status=${r.status}`);
  r = await post(pjMestre, "/inventario", { name: "Item inexistente", regra: { kind: "item", key: "nao_existe" }, ignorarPrerequisitos: true }, ids.cm);
  t("bypass não permite referência inexistente", r.status === 403, `status=${r.status}`);
  r = await post(pjMestre, "/inventario", { name: "Item desativado", regra: { kind: "item", key: "item_desativado" }, ignorarPrerequisitos: true }, ids.cm);
  t("bypass não reativa elemento desativado", r.status === 403, `status=${r.status}`);
  r = await post(pjMestre, "/inventario", { name: "Combo inválido", regra: { kind: "item", key: "combo" }, ignorarPrerequisitos: true }, ids.cm);
  t("bypass não ignora pré-requisito inexistente", r.status === 403, `status=${r.status}`);
  r = await post(pjMestre, "/inventario", { name: "Item com perícia desativada", regra: { kind: "item", key: "item_requer_pericia_desativada" }, ignorarPrerequisitos: true }, ids.cm);
  t("bypass não ignora pré-requisito desativado", r.status === 403, `status=${r.status}`);
  t("detalhes identificam pré-requisito desativado", r.json?.detalhes?.requisitos?.some((q) => q.indisponivel === true), JSON.stringify(r.json?.detalhes?.requisitos));
  const disponibilidadeDesativada = await req(BASE, "GET", `/characters/${pjJ1}/patrimonio/requisitos`, { cookie: ids.j1.cookie });
  const dispDesativada = disponibilidadeDesativada.json?.requisitos?.["item:item_requer_pericia_desativada"];
  t("endpoint de disponibilidade expõe estado desativado", dispDesativada?.ok === false && dispDesativada?.prerequisitos?.[0]?.indisponivel === true);
  // audit() resolve campaignId via req.params.campaignId — nas rotas de
  // personagem esse param não existe, então o escopo fica no detail.
  const auditBypass = comDb(BANCO, (db) => db.prepare("select id, detail from audit_logs where action='patrimonio.prerequisito.ignorado'").all());
  const bypassOk = (auditBypass ?? []).some((r) => { try { return JSON.parse(r.detail ?? "{}").regra?.key === "item_restrito_conducao"; } catch { return false; } });
  t("bypass auditado", bypassOk, `audits=${auditBypass?.length}`);
  // transferência: mestre sem flag deve falhar; com flag passa
  const f16Mestre = comDb(BANCO, (db) => db.prepare("select id from inventory_entries where character_id=? and data like '%item_restrito_conducao%'").get(pjMestre));
  r = await req(BASE, "POST", `/characters/${pjMestre}/inventario/${f16Mestre?.id}/transferir`, { cookie: ids.cm, body: { destinoCharacterId: pjJ1 } });
  t("mestre transfere sem flag → destino inelegível recusado", r.status === 403, `status=${r.status}`);
  r = await req(BASE, "POST", `/characters/${pjMestre}/inventario/${f16Mestre?.id}/transferir`, { cookie: ids.cm, body: { destinoCharacterId: pjJ1, ignorarPrerequisitos: true } });
  t("mestre transfere com flag explícita → ok", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0,120)}`);

  sec("venda/remoção não bloqueadas por pré-req");
  const kitId = comDb(BANCO, (db) => db.prepare("select id from inventory_entries where character_id=? and name='Kit de Campo'").get(pjJ1));
  const contaVend = await req(BASE, "POST", `/characters/${pjJ1}/financeiro/contas`, { cookie: ids.j1.cookie, body: { type: "especie", name: "Venda", balanceReais: 0 } });
  r = await req(BASE, "POST", `/characters/${pjJ1}/financeiro/operacao`, { cookie: ids.j1.cookie, body: { tipo: "venda", accountId: contaVend.json?.id, valor: 10, itemId: kitId?.id, quantidade: 1, requestId: `venda-prq-${Date.now()}` } });
  t("venda de item COM regra permitida", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0,140)}`);

  sec("catálogo expõe acervo");
  const cat = await req(BASE, "GET", `/campaigns/${ids.camp}/inventario`, { cookie: ids.j1.cookie });
  const acervo = cat.json?.acervo ?? [];
  t("catálogo lista elementos do Acervo", acervo.some((e) => e.regra?.key === "carro_popular"), JSON.stringify(acervo).slice(0, 200));
  const f16 = acervo.find((e) => e.regra?.key === "caca_f16");
  t("F-16 expõe pré-requisito Condução 5", f16?.prerequisitos?.some((p) => p.key === "conducao" && p.minLevel === 5), JSON.stringify(f16?.prerequisitos));

  sec("disponibilidade falha fechado sem ficha publicada");
  {
    const w = abrirDb(BANCO);
    try { w.prepare("update characters set template_version_id=NULL where id=?").run(pjSemPericias); }
    finally { w.close(); }
  }
  const reqSemFicha = await req(BASE, "GET", `/characters/${pjSemPericias}/patrimonio/requisitos`, { cookie: ids.j2.cookie });
  const dispCarro = reqSemFicha.json?.requisitos?.["item:carro_popular"];
  const dispKit = reqSemFicha.json?.requisitos?.["item:kit_campo"];
  t("Acervo restrito indisponível sem ficha publicada", reqSemFicha.status === 200 && dispCarro?.ok === false && dispCarro?.prerequisitos?.[0]?.nivelAtual === 0);
  t("até item sem requisito exige ficha verificável", dispKit?.ok === false && /sem ficha publicada/i.test((dispKit?.mensagens ?? []).join(" ")));
  {
    const w = abrirDb(BANCO);
    try { w.prepare("update characters set template_version_id=? where id=?").run(verId, pjSemPericias); }
    finally { w.close(); }
  }

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
