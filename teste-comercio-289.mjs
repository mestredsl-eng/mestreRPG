// Testes — Issue #289: delta executável da matriz 1.1.0 (comércio Internet).
// Complementa teste-comercio-lojas.mjs SEM duplicar: este arquivo cobre o
// que a matriz aceita exige e a suíte existente não prova —
//   gate cumulativo com revogação dinâmica e fail-closed por nome/template,
//   realtime (room campanha:*), LOJA-A/B nas bordas (saldo/caixa
//   insuficiente, corrida do último item, rollback multi-item, item
//   equipado, quantidade parcial, preço divergente na venda),
//   gestor não-mestre, isolamento cross-campanha e regressão patrimonial
//   pós-extração UI (IDs/procedência/vínculos/veículos).
// Banco isolado + fixtures sintéticas (teste-base). Somente testes —
// não altera workflow/CI (autorização separada pendente).
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir, sessao,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = dirTeste("comercio-289");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;
const sockets = [];
function conectar(base, cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(base, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  return s;
}
const entrarCampanha = (s, campId) => new Promise((res) => {
  const to = setTimeout(() => res(false), 5000);
  s.emit("entrar-campanha", campId, (ok) => { clearTimeout(to); res(ok === true); });
});
const entrarInternet = (s, campId, charId) => new Promise((res) => {
  const to = setTimeout(() => res(false), 5000);
  s.emit("entrar-internet", { campaignId: campId, characterId: charId }, (ok) => { clearTimeout(to); res(ok === true); });
});

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "j289_j1", jogador2: "j289_j2" } });
  const mestre = cenario.cookieMestre;
  const campId = cenario.campId;
  const j1 = cenario.jogadores.jogador1;
  const j2 = cenario.jogadores.jogador2;

  // ---- Fixture do gate: perícias computação/tecnologia + rule_definitions ----
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
      ["item", "espada", "Espada"],
    ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    est.secoes[0].campos.push(
      { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
      { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
    );
    db.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), ver.id);

    // Templates de item para os casos de resolução canônica templateId→regra.key
    const insTpl = db.prepare("insert into item_templates (id,campaign_id,name,category,description,data,is_active,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)");
    insTpl.run("tpl-notebook-289", campId, "Notebook Template", "equipamento", null,
      JSON.stringify({ regra: { kind: "item", key: "notebook" } }), 1, agora, agora);
    insTpl.run("tpl-espada-289", campId, "Espada Template", "equipamento", null,
      JSON.stringify({ regra: { kind: "item", key: "espada" } }), 1, agora, agora);
    db.close();
  }

  const insItem = (characterId, nome, data, qtd = 1) => {
    const db = abrirDb(BANCO);
    const id = crypto.randomUUID();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(id, characterId, nome, qtd, JSON.stringify(data), Date.now(), Date.now());
    db.close();
    return id;
  };
  const eleg = (charId, cookie) => req(BASE, "GET", `/characters/${charId}/comercio/elegibilidade`, { cookie });
  const comprarDummy = (charId, cookie, requestId) => req(BASE, "POST", `/characters/${charId}/comercio/comprar`, {
    cookie, body: { shopId: "loja-inexistente", accountId: "conta-x", items: [{ offerId: "of-x", qty: 1 }], requestId },
  });
  const contagens = () => comDb(BANCO, (db) => ({
    orders: db.prepare("select count(*) c from shop_orders").get().c,
    txs: db.prepare("select count(*) c from money_transactions").get().c,
    inv: db.prepare("select count(*) c from inventory_entries").get().c,
  }));

  // Personagens do gate
  const charOk = cenario.novoPersonagem(j1.membershipId, "Comp Notebook", { comp: 1 });
  const charZero = cenario.novoPersonagem(j2.membershipId, "Zero Tudo", { comp: 0 });
  const charNameOnly = cenario.novoPersonagem(j2.membershipId, "So Nome", { comp: 1 });
  const charTplOk = cenario.novoPersonagem(j2.membershipId, "Tpl Notebook", { comp: 1 });
  const charTplEspada = cenario.novoPersonagem(j2.membershipId, "Tpl Espada", { comp: 1 });
  const charTplFantasma = cenario.novoPersonagem(j2.membershipId, "Tpl Fantasma", { comp: 1 });
  const charSemNada = cenario.novoPersonagem(j2.membershipId, "Sem Nada", {});
  const charEquip = cenario.novoPersonagem(j1.membershipId, "Equipado", { comp: 1 });
  const charTransf = cenario.novoPersonagem(j1.membershipId, "Doador", { comp: 1 });
  const charDest = cenario.novoPersonagem(j2.membershipId, "Receptor", {});
  const charPerda = cenario.novoPersonagem(j1.membershipId, "Perde Ponto", { comp: 1 });

  insItem(charOk, "Notebook", { regra: { kind: "item", key: "notebook" } });
  insItem(charZero, "Notebook", { regra: { kind: "item", key: "notebook" } });
  insItem(charNameOnly, "Notebook", {}); // mesmo nome, SEM chave canônica
  insItem(charTplOk, "Notebook X", { templateId: "tpl-notebook-289" });
  insItem(charTplEspada, "Espada X", { templateId: "tpl-espada-289" });
  insItem(charTplFantasma, "Coisa X", { templateId: "tpl-inexistente-289" });
  const nbEquipId = insItem(charEquip, "Notebook", { regra: { kind: "item", key: "notebook" } });
  const nbTransfId = insItem(charTransf, "Notebook", { regra: { kind: "item", key: "notebook" } });
  insItem(charPerda, "Notebook", { regra: { kind: "item", key: "notebook" } });

  sec("gate cumulativo — negativos fail-closed");
  // (computador|tecnologia) >= 1  E  dispositivo canônico — os 4 pares
  // válidos já são provados em teste-comercio-lojas.mjs; aqui as NEGATIVAS.

  const eZero = await eleg(charZero, j2.cookie);
  t("comp=0 + notebook → inelegível (perícia)", eZero.json?.elegivel === false
    && eZero.json?.motivos?.includes("pericia_ou_conhecimento_insuficiente"), JSON.stringify(eZero.json));
  const cZero = await comprarDummy(charZero, j2.cookie, "g289-zero-1");
  t("API direta comprar sem perícia → 403", cZero.status === 403 && cZero.json?.erro === "internet_indisponivel", `${cZero.status} ${JSON.stringify(cZero.json)}`);
  const pZero = await req(BASE, "GET", `/characters/${charZero}/comercio/pedidos`, { cookie: j2.cookie });
  t("pedidos sem perícia → 403 sem dados", pZero.status === 403 && pZero.json?.pedidos === undefined, String(pZero.status));
  const vZero = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charZero}`, { cookie: j2.cookie });
  t("vitrine sem perícia → 403 sem dados", vZero.status === 403 && vZero.json?.lojas === undefined, String(vZero.status));

  // nome sozinho NÃO habilita — só chave canônica (regra.key/templateId resolvido)
  const eNome = await eleg(charNameOnly, j2.cookie);
  t("item 'Notebook' sem chave canônica → dispositivo_ausente", eNome.json?.elegivel === false
    && eNome.json?.motivos?.includes("dispositivo_ausente"), JSON.stringify(eNome.json));
  const cNome = await comprarDummy(charNameOnly, j2.cookie, "g289-nome-1");
  t("comprar com device só por nome → 403", cNome.status === 403, String(cNome.status));

  // templateId: resolve via data.regra.key do template; chave não-device e
  // template inexistente falham fechado
  const eTplOk = await eleg(charTplOk, j2.cookie);
  t("templateId→regra.key notebook → elegível", eTplOk.json?.elegivel === true, JSON.stringify(eTplOk.json));
  const eTplEspada = await eleg(charTplEspada, j2.cookie);
  t("templateId→regra.key espada → dispositivo_ausente", eTplEspada.json?.motivos?.includes("dispositivo_ausente"), JSON.stringify(eTplEspada.json));
  const eTplFantasma = await eleg(charTplFantasma, j2.cookie);
  t("templateId inexistente → dispositivo_ausente (fail-closed)", eTplFantasma.json?.motivos?.includes("dispositivo_ausente"), JSON.stringify(eTplFantasma.json));

  // sem perícia E sem dispositivo → os dois motivos
  const eNada = await eleg(charSemNada, j2.cookie);
  t("sem perícia E sem device → ambos os motivos", eNada.json?.motivos?.includes("pericia_ou_conhecimento_insuficiente")
    && eNada.json?.motivos?.includes("dispositivo_ausente"), JSON.stringify(eNada.json));

  // zero efeitos em negativa: contagens globais estáveis após compras negadas
  const antesNeg = contagens();
  await comprarDummy(charZero, j2.cookie, "g289-zero-2");
  await comprarDummy(charNameOnly, j2.cookie, "g289-nome-2");
  await comprarDummy(charSemNada, j2.cookie, "g289-nada-1");
  const depoisNeg = contagens();
  t("negativas: zero pedidos/transações/itens criados",
    depoisNeg.orders === antesNeg.orders && depoisNeg.txs === antesNeg.txs && depoisNeg.inv === antesNeg.inv,
    JSON.stringify({ antesNeg, depoisNeg }));

  sec("gate cumulativo — revogação e revalidação por operação");
  // dispositivo EQUIPADO continua sendo posse (gate lê inventário+equipamento)
  const eqAntes = await eleg(charEquip, j1.cookie);
  t("pré-equipar elegível", eqAntes.json?.elegivel === true, JSON.stringify(eqAntes.json));
  const equipar = await req(BASE, "POST", `/characters/${charEquip}/inventario/${nbEquipId}/equipar`, {
    cookie: j1.cookie, body: {},
  });
  t("equipar notebook → 201", equipar.status === 201, JSON.stringify(equipar.json));
  const eqDepois = await eleg(charEquip, j1.cookie);
  t("device equipado ainda elegível", eqDepois.json?.elegivel === true, JSON.stringify(eqDepois.json));
  const invAposEquip = comDb(BANCO, (db) => db.prepare("select count(*) c from inventory_entries where id=?").get(nbEquipId).c);
  t("unidade saiu do inventário p/ equipamento", invAposEquip === 0, String(invAposEquip));

  // transferência real do dispositivo → origem perde elegibilidade;
  // destino tem device mas segue inelegível por falta de perícia
  const transf = await req(BASE, "POST", `/characters/${charTransf}/inventario/${nbTransfId}/transferir`, {
    cookie: mestre, body: { destinoCharacterId: charDest, ignorarPrerequisitos: true },
  });
  t("transferir notebook → receptor", transf.status === 200 || transf.status === 201, `${transf.status} ${JSON.stringify(transf.json)}`);
  const eOrig = await eleg(charTransf, j1.cookie);
  t("origem sem device → dispositivo_ausente", eOrig.json?.motivos?.includes("dispositivo_ausente"), JSON.stringify(eOrig.json));
  const eDest = await eleg(charDest, j2.cookie);
  t("destino com device mas sem perícia → inelegível", eDest.json?.elegivel === false
    && eDest.json?.motivos?.includes("pericia_ou_conhecimento_insuficiente")
    && !eDest.json?.motivos?.includes("dispositivo_ausente"), JSON.stringify(eDest.json));

  // perda de ponto durante a sessão → próxima operação revalida e nega
  const ePerdaAntes = await eleg(charPerda, j1.cookie);
  t("antes da perda: elegível", ePerdaAntes.json?.elegivel === true, JSON.stringify(ePerdaAntes.json));
  {
    const db = abrirDb(BANCO);
    const row = db.prepare("select data from characters where id=?").get(charPerda);
    const dados = JSON.parse(row.data);
    dados.comp = 0;
    db.prepare("update characters set data=? where id=?").run(JSON.stringify(dados), charPerda);
    db.close();
  }
  const ePerdaDepois = await eleg(charPerda, j1.cookie);
  t("ponto removido → inelegível na chamada seguinte", ePerdaDepois.json?.elegivel === false
    && ePerdaDepois.json?.motivos?.includes("pericia_ou_conhecimento_insuficiente"), JSON.stringify(ePerdaDepois.json));
  const cPerda = await comprarDummy(charPerda, j1.cookie, "g289-perda-1");
  t("compra após perda de ponto → 403 (gate por operação, não por sessão)", cPerda.status === 403, String(cPerda.status));

  sec("realtime — canal Internet separado do OOC (#329 @ 52f680f)");
  // Contrato implementado: sala internet:{campanha}:{personagem} via
  // `entrar-internet` (autorização servidor-side: sessão, membership,
  // titularidade dono/mestre e gate cumulativo NO JOIN). O fan-out
  // revalida o gate de cada personagem antes de CADA entrega — quem
  // perdeu elegibilidade é removido da sala e não recebe nada.
  // A sala geral campanha:* (OOC/Mesa) não carrega mais eventos do módulo.
  //
  // Sockets:
  //   sCampJ1/sCampJ2 — só room OOC (regressão do canal geral)
  //   sICj1 — j1 inscrito em internet:charOk (elegível)
  //   sICj2 — j2: tenta inscrições negadas e entra em charTplOk (elegível)
  //   sRtPerda/sRtDev — j1 inscrito em personagens que perderão o gate
  //     NO MEIO da sessão (ponto e dispositivo) → revogação de entrega
  const charRtPerda = cenario.novoPersonagem(j1.membershipId, "RT Perde Ponto", { comp: 1 });
  insItem(charRtPerda, "Notebook", { regra: { kind: "item", key: "notebook" } });
  const charRtDev = cenario.novoPersonagem(j1.membershipId, "RT Perde Device", { comp: 1 });
  const nbRtDevId = insItem(charRtDev, "Notebook", { regra: { kind: "item", key: "notebook" } });

  const evs = {};
  const escutar = (s, tag) => {
    evs[tag] = { comercio: [], geral: [] };
    s.on("comercio:atualizado", (d) => evs[tag].comercio.push(d));
    s.on("campanha:atualizada", (d) => evs[tag].geral.push(d));
  };
  const sCampJ1 = conectar(BASE, j1.cookie); escutar(sCampJ1, "campJ1");
  const sCampJ2 = conectar(BASE, j2.cookie); escutar(sCampJ2, "campJ2");
  const sICj1 = conectar(BASE, j1.cookie); escutar(sICj1, "icJ1");
  const sICj2 = conectar(BASE, j2.cookie); escutar(sICj2, "icJ2");
  const sRtPerda = conectar(BASE, j1.cookie); escutar(sRtPerda, "rtPerda");
  const sRtDev = conectar(BASE, j1.cookie); escutar(sRtDev, "rtDev");

  t("sockets OOC entram na room campanha:*",
    (await entrarCampanha(sCampJ1, campId)) === true
    && (await entrarCampanha(sCampJ2, campId)) === true);

  // inscrições NEGADAS: inelegível, não-dono, template não-device,
  // template fantasma, sem nada — tudo cb(false), sem entrada na sala
  const negadas = [
    ["inelegível sem perícia (charZero)", sICj2, charZero],
    ["device só por nome (charNameOnly)", sICj2, charNameOnly],
    ["templateId não-device (charTplEspada)", sICj2, charTplEspada],
    ["templateId inexistente (charTplFantasma)", sICj2, charTplFantasma],
    ["sem perícia nem device (charSemNada)", sICj2, charSemNada],
    ["personagem de outro jogador (charOk via j2)", sICj2, charOk],
    ["personagem de j2 via j1 (charZero)", sICj1, charZero],
  ];
  for (const [rot, sock, charId] of negadas) {
    const ok = await entrarInternet(sock, campId, charId);
    t(`entrar-internet NEGADO: ${rot}`, ok === false);
  }
  // positivas: dono elegível entra; j2 entra no SEU personagem elegível
  // (charTplOk) — prova que o gate é por personagem, não por usuário
  t("entrar-internet: j1/dono elegível (charOk) → true",
    (await entrarInternet(sICj1, campId, charOk)) === true);
  t("entrar-internet: j2 no próprio elegível (charTplOk) → true",
    (await entrarInternet(sICj2, campId, charTplOk)) === true);
  t("entrar-internet: j1 em charRtPerda → true",
    (await entrarInternet(sRtPerda, campId, charRtPerda)) === true);
  t("entrar-internet: j1 em charRtDev → true",
    (await entrarInternet(sRtDev, campId, charRtDev)) === true);
  await dormir(300);

  sec("LOJA — setup mínimo (loja, gestor, caixa, ofertas, conta)");
  const loja = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja 289", category: "mercadoria" },
  });
  const shopId = loja.json?.id;
  t("loja criada", loja.status === 201 && !!shopId, JSON.stringify(loja.json));
  await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/gestores`, {
    cookie: mestre, body: { membershipId: j1.membershipId, role: "gestor" },
  });
  const caixa = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Caixa", balanceReais: 1000, papel: "caixa" },
  });
  const caixaId = caixa.json?.id;
  t("caixa da loja", caixa.status === 201 && !!caixaId, JSON.stringify(caixa.json));
  const mkOferta = async (body) => {
    const r = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas`, { cookie: j1.cookie, body });
    return r.json?.id;
  };
  const offRace = await mkOferta({ name: "Item Corrida", priceCents: 1000, stockQty: 1 });
  const offA = await mkOferta({ name: "Item A", priceCents: 2000, stockQty: 5 });
  const offEsg = await mkOferta({ name: "Item Esgotando", priceCents: 500, stockQty: 1 });
  const offCara = await mkOferta({ name: "Item Cara", priceCents: 50000, stockQty: 10 });
  const offInativa = await mkOferta({ name: "Item Inativo", priceCents: 300, stockQty: 10 });
  await req(BASE, "PATCH", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas/${offInativa}`, { cookie: j1.cookie, body: { isActive: false } });
  const conta = await req(BASE, "POST", `/characters/${charOk}/financeiro/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Bolso", balanceReais: 200 },
  });
  const contaId = conta.json?.id;
  t("conta do comprador", conta.status === 201 && !!contaId, JSON.stringify(conta.json));

  // dispara um evento real de comércio (LOJA-A) — a verificação dos
  // eventos recebidos por cada socket acontece no fim da suíte, após
  // também uma venda LOJA-B, para cobrir os dois emissores do módulo.
  const rtCompra = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId: offA, qty: 1 }], requestId: "rt-289-001" },
  });
  t("compra válida p/ gatilho realtime → 201", rtCompra.status === 201, JSON.stringify(rtCompra.json));
  await dormir(800);

  sec("LOJA-A — saldo insuficiente e rollback multi-item");
  const saldoAntes = comDb(BANCO, (db) => db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b);
  const estqAAntes = comDb(BANCO, (db) => db.prepare("select stock_qty s from shop_offers where id=?").get(offA).s);
  const caixaAntes = comDb(BANCO, (db) => db.prepare("select balance_cents b from financial_accounts where id=?").get(caixaId).b);

  // saldo insuficiente: offCara 50000 > saldo (~17000) com estoque de sobra
  const semSaldo = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId: offCara, qty: 1 }], requestId: "saldo-289-1" },
  });
  t("saldo insuficiente → 422 saldo_insuficiente", semSaldo.status === 422 && semSaldo.json?.erro === "saldo_insuficiente", `${semSaldo.status} ${JSON.stringify(semSaldo.json)}`);

  // rollback multi-item: 2ª linha estoura estoque → NADA da 1ª linha vale
  const rollback = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId: offA, qty: 1 }, { offerId: offEsg, qty: 5 }], requestId: "rollback-289-1" },
  });
  t("multi-item c/ estoque estourado → 409", rollback.status === 409 && rollback.json?.erro === "estoque_insuficiente", `${rollback.status} ${JSON.stringify(rollback.json)}`);
  const posRollback = comDb(BANCO, (db) => ({
    estoqA: db.prepare("select stock_qty s from shop_offers where id=?").get(offA).s,
    saldo: db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b,
    caixa: db.prepare("select balance_cents b from financial_accounts where id=?").get(caixaId).b,
    orders: db.prepare("select count(*) c from shop_orders where request_id='rollback-289-1'").get().c,
    txs: db.prepare("select count(*) c from money_transactions where request_id like 'rollback-289-1:%'").get().c,
    itens: db.prepare("select count(*) c from inventory_entries where character_id=? and name='Item A'").get(charOk).c,
  }));
  t("rollback: estoque da 1ª linha intacto", posRollback.estoqA === estqAAntes, `antes ${estqAAntes} atual ${posRollback.estoqA}`);
  t("rollback: saldo/caixa intactos", posRollback.saldo === saldoAntes && posRollback.caixa === caixaAntes, JSON.stringify(posRollback));
  t("rollback: zero recibo/transação/item entregue", posRollback.orders === 0 && posRollback.txs === 0 && posRollback.itens === 1, JSON.stringify(posRollback));

  // corrida do ÚLTIMO item: duas compras independentes (requestIds
  // distintos) disputam stockQty=1 → exatamente uma conclui
  const [r1, r2] = await Promise.all([
    req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
      cookie: j1.cookie,
      body: { shopId, accountId: contaId, items: [{ offerId: offRace, qty: 1 }], requestId: "race289-a" },
    }),
    req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
      cookie: j1.cookie,
      body: { shopId, accountId: contaId, items: [{ offerId: offRace, qty: 1 }], requestId: "race289-b" },
    }),
  ]);
  const stRace = [r1.status, r2.status].sort((a, b) => a - b);
  t("último item: um 201 + um 409", stRace[0] === 201 && stRace[1] === 409, JSON.stringify([r1.status, r2.status, r1.json?.erro, r2.json?.erro]));
  const posCorrida = comDb(BANCO, (db) => ({
    estoq: db.prepare("select stock_qty s from shop_offers where id=?").get(offRace).s,
    orders: db.prepare("select count(*) c from shop_orders where request_id in ('race289-a','race289-b')").get().c,
    txs: db.prepare("select count(*) c from money_transactions where request_id like 'race289-%'").get().c,
    saldo: db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b,
    caixa: db.prepare("select balance_cents b from financial_accounts where id=?").get(caixaId).b,
  }));
  t("último item: estoque zerado, 1 recibo, 2 pernas de ledger",
    posCorrida.estoq === 0 && posCorrida.orders === 1 && posCorrida.txs === 2, JSON.stringify(posCorrida));
  t("último item: débito/crédito aplicados exatamente uma vez",
    posCorrida.saldo === saldoAntes - 1000 && posCorrida.caixa === caixaAntes + 1000,
    `saldo ${saldoAntes}→${posCorrida.saldo} caixa ${caixaAntes}→${posCorrida.caixa}`);

  // oferta inativa → 409 oferta_indisponivel, zero efeitos
  const inativa = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId, accountId: contaId, items: [{ offerId: offInativa, qty: 1 }], requestId: "inativa-289-1" },
  });
  t("oferta inativa → 409 oferta_indisponivel", inativa.status === 409 && inativa.json?.erro === "oferta_indisponivel", `${inativa.status} ${JSON.stringify(inativa.json)}`);

  sec("LOJA-B — venda à loja: bordas");
  const saldoVendedorAntes = comDb(BANCO, (db) => db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b);
  const caixaAntesVenda = comDb(BANCO, (db) => db.prepare("select balance_cents b from financial_accounts where id=?").get(caixaId).b);

  // pilha de 3 unidades a 15.00 — venda parcial de 1
  const invVend = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invVend, charOk, "Relíquia 289", 3, JSON.stringify({ aquisicao: { unitCents: 1500, qtdOriginal: 3 } }), Date.now(), Date.now());
    db.close();
  }
  const vendaParcial = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invVend, qty: 1, accountId: contaId, requestId: "vend289-parcial" },
  });
  t("venda parcial qty1 de pilha 3 → 201", vendaParcial.status === 201 && vendaParcial.json?.totalCents === 1500, `${vendaParcial.status} ${JSON.stringify(vendaParcial.json)}`);
  const posParcial = comDb(BANCO, (db) => ({
    qtd: db.prepare("select quantity q from inventory_entries where id=?").get(invVend).q,
    vendedor: db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b,
    caixa: db.prepare("select balance_cents b from financial_accounts where id=?").get(caixaId).b,
  }));
  t("pilha 3→2, vendedor +1500, caixa −1500",
    posParcial.qtd === 2 && posParcial.vendedor === saldoVendedorAntes + 1500 && posParcial.caixa === caixaAntesVenda - 1500,
    JSON.stringify(posParcial));

  // quantidade insuficiente: restam 2, pedir 5
  const qtdInsuf = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invVend, qty: 5, accountId: contaId, requestId: "vend289-qtd" },
  });
  t("quantidade insuficiente → 409", qtdInsuf.status === 409 && qtdInsuf.json?.erro === "quantidade_insuficiente", `${qtdInsuf.status} ${JSON.stringify(qtdInsuf.json)}`);

  // preço unitário divergente na venda → 409 preco_divergente
  const precoVend = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invVend, qty: 1, accountId: contaId, expectedUnitCents: 999, requestId: "vend289-preco" },
  });
  t("expectedUnitCents divergente → 409 preco_divergente", precoVend.status === 409 && precoVend.json?.erro === "preco_divergente", `${precoVend.status} ${JSON.stringify(precoVend.json)}`);

  // item com unidade EQUIPADA não pode ser vendido (vínculo real via API)
  const invEquip = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invEquip, charOk, "Medalha 289", 2, JSON.stringify({ aquisicao: { unitCents: 800, qtdOriginal: 2 } }), Date.now(), Date.now());
    db.close();
  }
  const equiparMedalha = await req(BASE, "POST", `/characters/${charOk}/inventario/${invEquip}/equipar`, {
    cookie: j1.cookie, body: {},
  });
  t("equipar 1 unidade da pilha → 201", equiparMedalha.status === 201, JSON.stringify(equiparMedalha.json));
  const equipId = equiparMedalha.json?.id;
  const vendaEquip = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invEquip, qty: 1, accountId: contaId, requestId: "vend289-equip" },
  });
  t("item com unidade equipada → 409 item_equipado", vendaEquip.status === 409 && vendaEquip.json?.erro === "item_equipado", `${vendaEquip.status} ${JSON.stringify(vendaEquip.json)}`);
  const qtdAposNegEquip = comDb(BANCO, (db) => db.prepare("select quantity q from inventory_entries where id=?").get(invEquip)?.q);
  t("negativa não baixou a pilha", qtdAposNegEquip === 1, String(qtdAposNegEquip));

  // regressão: vínculo equipamento↔inventário visível na leitura legada
  const eqs = await req(BASE, "GET", `/characters/${charOk}/equipamentos`, { cookie: j1.cookie });
  const eqMedalha = (eqs.json?.equipamentos ?? []).find((e) => e.name === "Medalha 289");
  t("GET /equipamentos mostra vínculo inventoryEntryId",
    !!eqMedalha && eqMedalha.data?.inventoryEntryId === invEquip, JSON.stringify(eqMedalha?.data ?? {}));

  // desequipar devolve a unidade → pilha volta a 2 → venda passa
  const desequipar = await req(BASE, "POST", `/characters/${charOk}/equipamentos/${equipId}/desequipar`, { cookie: j1.cookie, body: {} });
  t("desequipar → unidade devolvida", desequipar.status === 200 || desequipar.status === 201, `${desequipar.status} ${JSON.stringify(desequipar.json)}`);
  const qtdAposDes = comDb(BANCO, (db) => db.prepare("select quantity q from inventory_entries where id=?").get(invEquip)?.q);
  t("pilha restaurada 1→2", qtdAposDes === 2, String(qtdAposDes));
  const vendaPosDes = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invEquip, qty: 1, accountId: contaId, requestId: "vend289-posdes" },
  });
  t("após desequipar, venda conclui → 201", vendaPosDes.status === 201, `${vendaPosDes.status} ${JSON.stringify(vendaPosDes.json)}`);

  // efeito 4 LB1 (#329 @ 2ca6890): entrada no estoque comercial na mesma
  // tx. Sem templateId → casa oferta por name com item_template_id NULL;
  // sem match → cria oferta INATIVA a custo com proveniência revenda_loja.
  const ofertaMedalha = comDb(BANCO, (db) => db.prepare(
    "select id, stock_qty, price_cents, is_active, item_template_id, data from shop_offers where shop_id=? and name='Medalha 289'",
  ).get(shopId));
  const dataMedalha = ofertaMedalha ? JSON.parse(ofertaMedalha.data) : null;
  t("LOJA-B: venda credita estoque comercial (oferta inativa a custo)",
    !!ofertaMedalha && ofertaMedalha.is_active === 0 && ofertaMedalha.stock_qty === 1
    && ofertaMedalha.price_cents === 800 && ofertaMedalha.item_template_id === null
    && dataMedalha?.origem === "revenda_loja" && dataMedalha?.unitCostCents === 800
    && dataMedalha?.orderId === vendaPosDes.json?.id,
    JSON.stringify(ofertaMedalha ?? null).slice(0, 300));

  // segunda venda do mesmo item → acumula stockQty na mesma oferta
  const invEquip2 = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invEquip2, charOk, "Medalha 289", 1, JSON.stringify({ aquisicao: { unitCents: 800, qtdOriginal: 1 } }), Date.now(), Date.now());
    db.close();
  }
  const vendaMedalha2 = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invEquip2, qty: 1, accountId: contaId, requestId: "vend289-med2" },
  });
  t("segunda venda Medalha → 201", vendaMedalha2.status === 201, `${vendaMedalha2.status} ${JSON.stringify(vendaMedalha2.json)}`);
  const estqMedalha = comDb(BANCO, (db) => db.prepare(
    "select count(*) c, sum(stock_qty) s from shop_offers where shop_id=? and name='Medalha 289'",
  ).get(shopId));
  t("estoque comercial acumulou 1→2 na mesma oferta",
    estqMedalha.c === 1 && estqMedalha.s === 2, JSON.stringify(estqMedalha));

  // replay da venda não recredita estoque (idempotência do efeito 4)
  const replayVend = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invEquip2, qty: 1, accountId: contaId, requestId: "vend289-med2" },
  });
  t("replay venda → mesmo pedido", replayVend.status === 200 && replayVend.json?.id === vendaMedalha2.json?.id, JSON.stringify(replayVend.json));
  const estqAposReplay = comDb(BANCO, (db) => db.prepare(
    "select sum(stock_qty) s from shop_offers where shop_id=? and name='Medalha 289'",
  ).get(shopId).s);
  t("replay não recreditou estoque", estqAposReplay === 2, String(estqAposReplay));

  // caixa insuficiente na LOJA-B: loja 2 com caixa zerado
  const lojaPobre = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Pobre 289" },
  });
  const shopPobre = lojaPobre.json?.id;
  await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopPobre}/gestores`, {
    cookie: mestre, body: { membershipId: j1.membershipId, role: "gestor" },
  });
  await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopPobre}/contas`, {
    cookie: j1.cookie, body: { type: "especie", name: "Caixa Pobre", balanceReais: 0, papel: "caixa" },
  });
  const invCaro = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invCaro, charOk, "Relíquia Cara", 1, JSON.stringify({ aquisicao: { unitCents: 5000, qtdOriginal: 1 } }), Date.now(), Date.now());
    db.close();
  }
  const vendedorAntes = comDb(BANCO, (db) => db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b);
  const vendaSemCaixa = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId: shopPobre, inventoryEntryId: invCaro, qty: 1, accountId: contaId, requestId: "vend289-semcaixa" },
  });
  t("caixa insuficiente → 422 caixa_insuficiente", vendaSemCaixa.status === 422 && vendaSemCaixa.json?.erro === "caixa_insuficiente", `${vendaSemCaixa.status} ${JSON.stringify(vendaSemCaixa.json)}`);
  const posSemCaixa = comDb(BANCO, (db) => ({
    vendedor: db.prepare("select balance_cents b from financial_accounts where id=?").get(contaId).b,
    qtd: db.prepare("select quantity q from inventory_entries where id=?").get(invCaro).q,
    orders: db.prepare("select count(*) c from shop_orders where request_id='vend289-semcaixa'").get().c,
    txs: db.prepare("select count(*) c from money_transactions where request_id like 'vend289-semcaixa:%'").get().c,
  }));
  t("caixa insuficiente: vendedor/item/ledger intactos",
    posSemCaixa.vendedor === vendedorAntes && posSemCaixa.qtd === 1 && posSemCaixa.orders === 0 && posSemCaixa.txs === 0,
    JSON.stringify(posSemCaixa));
  const ofertasPobre = comDb(BANCO, (db) => db.prepare(
    "select count(*) c from shop_offers where shop_id=?",
  ).get(shopPobre).c);
  t("caixa insuficiente: zero oferta criada no estoque da loja", ofertasPobre === 0, String(ofertasPobre));

  sec("gestor não-mestre e isolamento entre campanhas");
  // j1 é gestor da shopId mas NÃO da shop2 (criada pelo mestre sem vínculo)
  const loja2 = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Alheia 289" },
  });
  const shop2 = loja2.json?.id;
  const ofShop2 = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shop2}/ofertas`, {
    cookie: mestre, body: { name: "Oferta Loja2", priceCents: 100 },
  });
  t("mestre cria oferta na loja2", ofShop2.status === 201, String(ofShop2.status));
  const j1NaLoja2 = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shop2}/ofertas`, {
    cookie: j1.cookie, body: { name: "Invasão", priceCents: 1 },
  });
  t("gestor da loja1 NÃO gerencia loja2 → 403", j1NaLoja2.status === 403, String(j1NaLoja2.status));
  const j1ContasLoja2 = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas/${shop2}/contas`, { cookie: j1.cookie });
  t("gestor da loja1 NÃO vê caixa da loja2 → 403", j1ContasLoja2.status === 403, String(j1ContasLoja2.status));
  const j1PatchLoja2 = await req(BASE, "PATCH", `/campaigns/${campId}/comercio/lojas/${shop2}`, {
    cookie: j1.cookie, body: { isOpen: false },
  });
  t("gestor da loja1 NÃO edita loja2 → 403", j1PatchLoja2.status === 403, String(j1PatchLoja2.status));

  // cross-campaign: segunda campanha do mesmo mestre; j1 não é membro
  const campB = await req(BASE, "POST", "/campaigns", { cookie: mestre, body: { name: "Campanha B 289" } });
  const campBId = campB.json?.campanha?.id;
  t("segunda campanha criada", !!campBId, JSON.stringify(campB.json).slice(0, 120));
  const lojaB = await req(BASE, "POST", `/campaigns/${campBId}/comercio/lojas`, {
    cookie: mestre, body: { name: "Loja Campanha B" },
  });
  const shopB = lojaB.json?.id;
  await req(BASE, "POST", `/campaigns/${campBId}/comercio/lojas/${shopB}/contas`, {
    cookie: mestre, body: { type: "especie", name: "Caixa B", balanceReais: 100, papel: "caixa" },
  });
  const compraCruzada = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
    cookie: j1.cookie,
    body: { shopId: shopB, accountId: contaId, items: [{ offerId: "of-x", qty: 1 }], requestId: "cruzada-289-1" },
  });
  t("comprar loja de OUTRA campanha → 404 (escopo por campanha)", compraCruzada.status === 404, `${compraCruzada.status} ${JSON.stringify(compraCruzada.json)}`);
  const contasCampB = await req(BASE, "GET", `/campaigns/${campBId}/comercio/lojas/${shopB}/contas`, { cookie: j1.cookie });
  t("j1 sem membership na campanha B → 403 no caixa", contasCampB.status === 403, String(contasCampB.status));
  const vitrineA = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charOk}`, { cookie: j1.cookie });
  const idsVitrine = (vitrineA.json?.lojas ?? []).map((l) => l.id);
  t("vitrine da campanha A não lista loja da campanha B", !idsVitrine.includes(shopB), JSON.stringify(idsVitrine));

  // visibilidade de gestão na vitrine (#329 @ c51e81e): flag
  // podeGerenciar por loja, gestor vê ofertas inativas da própria loja,
  // mestre recebe a lista de gestores — sem vazar caixa
  const lojaVitA = (vitrineA.json?.lojas ?? []).find((l) => l.id === shopId);
  const lojaVit2 = (vitrineA.json?.lojas ?? []).find((l) => l.id === shop2);
  t("vitrine: gestor tem podeGerenciar=true na própria loja",
    lojaVitA?.podeGerenciar === true, JSON.stringify(lojaVitA?.podeGerenciar));
  t("vitrine: gestor tem podeGerenciar=false na loja alheia",
    lojaVit2?.podeGerenciar === false, JSON.stringify(lojaVit2?.podeGerenciar));
  t("vitrine do gestor inclui oferta INATIVA da própria loja (revisão de revenda)",
    (lojaVitA?.ofertas ?? []).some((o) => o.id === offInativa),
    JSON.stringify((lojaVitA?.ofertas ?? []).map((o) => o.id)));
  const vitrineJ2 = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charTplOk}`, { cookie: j2.cookie });
  const lojaVitJ2 = (vitrineJ2.json?.lojas ?? []).find((l) => l.id === shopId);
  t("vitrine de não-gestor: podeGerenciar=false e sem oferta inativa",
    lojaVitJ2?.podeGerenciar === false
    && !(lojaVitJ2?.ofertas ?? []).some((o) => o.id === offInativa),
    JSON.stringify({ p: lojaVitJ2?.podeGerenciar, n: (lojaVitJ2?.ofertas ?? []).length }));
  const vitrineMestre = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas?personagem=${charOk}`, { cookie: mestre });
  const lojaVitM = (vitrineMestre.json?.lojas ?? []).find((l) => l.id === shopId);
  t("vitrine do mestre expõe gestores da loja",
    Array.isArray(lojaVitM?.gestores) && lojaVitM.gestores.some((g) => g.membershipId === j1.membershipId),
    JSON.stringify(lojaVitM?.gestores));
  t("vitrine nunca expõe saldo/caixa das contas",
    !JSON.stringify(vitrineMestre.json).includes("balanceCents") && !JSON.stringify(vitrineMestre.json).includes("balance_cents"),
    "campo de saldo vazou na vitrine");

  // isolamento de template/Acervo entre campanhas (#329 @ f6009fb):
  // template criado na campanha B não pode ser referenciado pela A —
  // nem na criação/PATCH de oferta, nem na venda LOJA-B
  {
    const db = abrirDb(BANCO);
    db.prepare("insert into item_templates (id,campaign_id,name,category,description,data,is_active,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run("tpl-campb-289", campBId, "Template Campanha B", "equipamento", null,
        JSON.stringify({ regra: { kind: "item", key: "notebook" } }), 1, Date.now(), Date.now());
    db.close();
  }
  const ofTplB = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas`, {
    cookie: j1.cookie, body: { name: "Oferta tplB", priceCents: 100, itemTemplateId: "tpl-campb-289" },
  });
  t("oferta com template de OUTRA campanha → 400", ofTplB.status === 400, `${ofTplB.status} ${JSON.stringify(ofTplB.json)}`);
  const patchTplB = await req(BASE, "PATCH", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas/${offA}`, {
    cookie: j1.cookie, body: { itemTemplateId: "tpl-campb-289" },
  });
  t("PATCH oferta com template de OUTRA campanha → 400", patchTplB.status === 400, `${patchTplB.status} ${JSON.stringify(patchTplB.json)}`);
  const invTplB = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(invTplB, charOk, "Item tplB", 1, JSON.stringify({ aquisicao: { unitCents: 500, qtdOriginal: 1 }, templateId: "tpl-campb-289" }), Date.now(), Date.now());
    db.close();
  }
  const vendTplB = await req(BASE, "POST", `/characters/${charOk}/comercio/vender`, {
    cookie: j1.cookie,
    body: { shopId, inventoryEntryId: invTplB, qty: 1, accountId: contaId, requestId: "vend289-tplb" },
  });
  t("venda LOJA-B com template de OUTRA campanha → 409 template_indisponivel",
    vendTplB.status === 409 && vendTplB.json?.erro === "template_indisponivel", `${vendTplB.status} ${JSON.stringify(vendTplB.json)}`);

  // papel espectador: gestão de loja negada (requirePapel mestre|jogador)
  {
    const db = abrirDb(BANCO);
    const uid = crypto.randomUUID();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, "espectador_289", "Espectador", await hashSenha("senha-espectador-123"), Date.now(), Date.now());
    const mid = crypto.randomUUID();
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
      .run(mid, campId, uid, Date.now(), Date.now(), Date.now());
    db.close();
    const cookieEsp = sessao(BANCO, uid);
    const espContas = await req(BASE, "GET", `/campaigns/${campId}/comercio/lojas/${shopId}/contas`, { cookie: cookieEsp });
    t("espectador não vê caixa → 403", espContas.status === 403, String(espContas.status));
    const espOferta = await req(BASE, "POST", `/campaigns/${campId}/comercio/lojas/${shopId}/ofertas`, {
      cookie: cookieEsp, body: { name: "Oferta Esp", priceCents: 1 },
    });
    t("espectador não gerencia loja → 403", espOferta.status === 403, String(espOferta.status));
  }

  sec("regressão patrimonial — dados e IDs preservados");
  // item comprado na loja mantém ID, quantidade, procedência e template
  const inv = await req(BASE, "GET", `/characters/${charOk}/inventario`, { cookie: j1.cookie });
  const itemLoja = (inv.json?.itens ?? []).find((i) => i.name === "Item A");
  const aq = itemLoja?.data?.aquisicao;
  t("item da loja legível via /inventario com procedência",
    !!itemLoja && aq?.origem === "loja" && aq?.shopId === shopId && typeof aq?.orderId === "string",
    JSON.stringify(itemLoja?.data ?? {}).slice(0, 200));
  // uma linha por oferta comprada: Item A entrou 1× (rt-289-001);
  // a tentativa rollback-289-1 não gerou linha (rollback integral)
  t("quantidade do item comprado preservada", itemLoja?.quantity === 1, String(itemLoja?.quantity));

  // veículo criado via API legada permanece intacto após todo o comércio
  const veic = await req(BASE, "POST", `/characters/${charOk}/veiculos`, {
    cookie: j1.cookie, body: { name: "Carroça 289", kind: "terrestre", plate: "ABC-1" },
  });
  t("veículo criado via API legada", veic.status === 201 || veic.status === 200, `${veic.status} ${JSON.stringify(veic.json)}`);
  const veics = await req(BASE, "GET", `/characters/${charOk}/veiculos`, { cookie: j1.cookie });
  const veicOk = (veics.json?.veiculos ?? []).find((v) => v.name === "Carroça 289");
  t("veículo listado intacto", !!veicOk && veicOk.plate === "ABC-1", JSON.stringify(veicOk?.plate));

  // financeiro legado: contas e histórico coerentes após compras/vendas
  const fin = await req(BASE, "GET", `/characters/${charOk}/financeiro`, { cookie: j1.cookie });
  const contaFin = (fin.json?.contas ?? []).find((c) => c.id === contaId);
  t("GET /financeiro mostra saldo pós-comércio", !!contaFin, JSON.stringify(fin.json?.contas?.length));
  const historico = fin.json?.historico ?? [];
  const temCompra = historico.some((h) => h.shopId === shopId);
  t("histórico financeiro contém pernas do comércio", temCompra, `historico=${historico.length}`);

  // characters.data do comprador não foi tocado pelo comércio
  const dadosChar = comDb(BANCO, (db) => db.prepare("select data from characters where id=?").get(charOk).data);
  const dadosObj = JSON.parse(dadosChar);
  t("characters.data do comprador intacto (só ficha)", dadosObj.comp === 1 && dadosObj.for === 5, JSON.stringify(dadosObj).slice(0, 120));

  sec("realtime — entrega, revogação mid-session e regressão OOC");
  await dormir(500); // drena emissões pendentes das compras/vendas já feitas
  // LOJA-A (rtCompra + sondas) e LOJA-B (vendas) já emitiram
  // comercio:atualizado — a entrega agora é SOMENTE via sala internet:*.
  t("elegível inscrito (charOk) recebe comercio:atualizado",
    evs.icJ1.comercio.length > 0, `eventos=${evs.icJ1.comercio.length}`);
  t("j2 no próprio elegível (charTplOk) recebe comercio:atualizado",
    evs.icJ2.comercio.length > 0, `eventos=${evs.icJ2.comercio.length}`);
  const chavesComercio = [...new Set(evs.icJ1.comercio.flatMap((d) => Object.keys(d ?? {})))];
  t("eventos de comércio têm envelope só-ids",
    chavesComercio.length > 0 && chavesComercio.every((k) => ["shopId", "orderId"].includes(k)), chavesComercio.join(","));
  // ASSERT CENTRAL: socket de usuário inelegível permanece na room OOC
  // campanha:* mas NÃO tem inscrição Internet — deve receber ZERO
  // eventos do módulo (nem envelope só-ids).
  t("inelegível só-OOC recebe ZERO comercio:atualizado (gate realtime)",
    evs.campJ2.comercio.length === 0,
    `recebeu ${evs.campJ2.comercio.length} evento(s)`);
  // simétrico: usuário elegível SEM inscrição Internet também não
  // recebe via campanha:* — prova que o fan-out saiu da sala geral
  t("elegível sem inscrição Internet não recebe via OOC",
    evs.campJ1.comercio.length === 0,
    `recebeu ${evs.campJ1.comercio.length} evento(s) na room geral`);

  // ---- revogação de entrega NO MEIO da sessão ----
  // sonda de comércio controlada: oferta nova + compra qty1 do charOk.
  // A criação da oferta também emite comercio:atualizado — drenar ANTES
  // dos snapshots para não confundir gatilho com evento atrasado.
  const offSonda = await mkOferta({ name: "Sonda RT 289", priceCents: 100, stockQty: 50 });
  await dormir(700);
  const sonda = async (rid) => {
    const r = await req(BASE, "POST", `/characters/${charOk}/comercio/comprar`, {
      cookie: j1.cookie,
      body: { shopId, accountId: contaId, items: [{ offerId: offSonda, qty: 1 }], requestId: rid },
    });
    return r;
  };

  // perda de PONTO: charRtPerda perde comp no banco (mesma técnica do
  // charPerda) DEPOIS de já estar inscrito e recebendo eventos
  const nPerdaAntes = evs.rtPerda.comercio.length;
  t("charRtPerda recebia eventos antes da revogação", nPerdaAntes > 0, `eventos=${nPerdaAntes}`);
  {
    const db = abrirDb(BANCO);
    const row = db.prepare("select data from characters where id=?").get(charRtPerda);
    const dados = JSON.parse(row.data);
    dados.comp = 0;
    db.prepare("update characters set data=? where id=?").run(JSON.stringify(dados), charRtPerda);
    db.close();
  }
  const sondaPerda = await sonda("rt-289-sonda-perda");
  t("sonda pós-perda de ponto → 201", sondaPerda.status === 201, `${sondaPerda.status} ${JSON.stringify(sondaPerda.json)}`);
  await dormir(700);
  t("entrega cortada após perda de ponto (revalidação por entrega)",
    evs.rtPerda.comercio.length === nPerdaAntes,
    `${nPerdaAntes} → ${evs.rtPerda.comercio.length}`);
  t("reinscrição negada após perda de ponto",
    (await entrarInternet(sRtPerda, campId, charRtPerda)) === false);

  // perda de DISPOSITIVO: transfere o notebook de charRtDev para charDest
  const nDevAntes = evs.rtDev.comercio.length;
  t("charRtDev recebia eventos antes da revogação", nDevAntes > 0, `eventos=${nDevAntes}`);
  const transfDev = await req(BASE, "POST", `/characters/${charRtDev}/inventario/${nbRtDevId}/transferir`, {
    cookie: mestre, body: { destinoCharacterId: charDest, ignorarPrerequisitos: true },
  });
  t("transferência do notebook (revogação de device) → 200/201",
    transfDev.status === 200 || transfDev.status === 201, `${transfDev.status} ${JSON.stringify(transfDev.json)}`);
  const sondaDev = await sonda("rt-289-sonda-dev");
  t("sonda pós-perda de device → 201", sondaDev.status === 201, `${sondaDev.status} ${JSON.stringify(sondaDev.json)}`);
  await dormir(700);
  t("entrega cortada após perda de dispositivo (revalidação por entrega)",
    evs.rtDev.comercio.length === nDevAntes,
    `${nDevAntes} → ${evs.rtDev.comercio.length}`);
  t("reinscrição negada após perda de dispositivo",
    (await entrarInternet(sRtDev, campId, charRtDev)) === false);

  // ---- regressão OOC/Mesa: canal geral intacto para os dois lados ----
  const g1Antes = evs.campJ1.geral.length, g2Antes = evs.campJ2.geral.length;
  const patchCamp = await req(BASE, "PATCH", `/campaigns/${campId}`, {
    cookie: mestre, body: { description: "regressão canal OOC 289" },
  });
  t("PATCH campanha (gatilho de evento geral) → 200", patchCamp.status === 200, String(patchCamp.status));
  await dormir(600);
  t("canal OOC preservado: elegível recebe campanha:atualizada",
    evs.campJ1.geral.length > g1Antes, `${g1Antes} → ${evs.campJ1.geral.length}`);
  t("canal OOC preservado: inelegível recebe campanha:atualizada",
    evs.campJ2.geral.length > g2Antes, `${g2Antes} → ${evs.campJ2.geral.length}`);
  sec("resumo");
  console.log(`\n${pass} passaram, ${fail} falharam`);
  if (fail) process.exitCode = 1;
} finally {
  for (const s of sockets) { try { s.disconnect(); } catch { } }
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
