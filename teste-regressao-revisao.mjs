// Regressão dos bloqueios da revisão — Etapa 2.
// 1) PATCH inventário: reduzir quantidade exige jogadorRemoveItens,
//    aumentar/editar exige jogadorAdicionaItens.
// 2) HP: alterações simultâneas não perdem entradas do histórico.
// 3) Vitalidade: idem.
// 4) money_transactions.amount respeita financeiro.casasDecimais.
// Banco 100% sintético via teste-base.mjs — nunca toca banco/mestre-rpg.db.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("regressao-revisao");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

// Mescla uma seção do config do rule_set ativo (ex.: "patrimonio", "financeiro")
function setCfg(campId, chave, patch) {
  const db = abrirDb(BANCO);
  const rs = db.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(campId);
  const cfg = JSON.parse(rs.config);
  cfg[chave] = { ...(cfg[chave] ?? {}), ...patch };
  db.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
  db.close();
}
const qtdDb = (itemId) => comDb(BANCO, (db) => db.prepare("select quantity from inventory_entries where id=?").get(itemId)?.quantity);
const vitDb = (charId) => JSON.parse(comDb(BANCO, (db) => db.prepare("select data from characters where id=?").get(charId).data)).__vitalidade;
const hpDb = (charId) => JSON.parse(comDb(BANCO, (db) => db.prepare("select data from characters where id=?").get(charId).data)).__hp;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc, ids, cm, cj1;

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "jogador_reg" },
    config: {
      hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "ambos" },
      vitalidade: { edicaoPor: "ambos", niveis: [
        { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
        { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
        { nome: "Incapacitado", penalidadeDados: 0, bloqueiaAcoes: true },
      ] },
      financeiro: { casasDecimais: 2, moedaPrincipal: "BRL", moedas: [{ codigo: "BRL", nome: "Real" }] },
      patrimonio: { jogadorAdicionaItens: true, jogadorRemoveItens: false, jogadorCompraVenda: true, jogadorPix: true },
    },
  });
  ids = { camp: cenario.campId, charM: cenario.personagemMestre,
    charJ: cenario.novoPersonagem(cenario.jogadores.jogador1.membershipId, "PJ Reg") };
  cm = cenario.cookieMestre; cj1 = cenario.jogadores.jogador1.cookie;
  console.log("seed:", ids);

  // ===== 1. PATCH quantidade × permissões =====
  sec("PATCH inventário — reduzir exige remove, aumentar/editar exige adiciona");
  {
    const item = (await req(BASE, "POST", `/characters/${ids.charJ}/inventario`, {
      cookie: cj1, body: { name: "Tônica", quantity: 5, category: "consumivel" },
    })).json?.id;
    t("item qtd5 criado", !!item);

    // defaults: adiciona=true, remove=false → reduzir deve dar 403
    let r = await req(BASE, "PATCH", `/characters/${ids.charJ}/inventario/${item}`, { cookie: cj1, body: { quantity: 3 } });
    t("reduzir 5→3 com remove=false → 403", r.status === 403, `status=${r.status}`);
    t("quantidade intacta no banco", qtdDb(item) === 5, `qtd=${qtdDb(item)}`);
    r = await req(BASE, "PATCH", `/characters/${ids.charJ}/inventario/${item}`, { cookie: cj1, body: { quantity: 7 } });
    t("aumentar 5→7 com adiciona=true → 200", r.status === 200, `status=${r.status}`);
    r = await req(BASE, "PATCH", `/characters/${ids.charJ}/inventario/${item}`, { cookie: cj1, body: { description: "nova desc" } });
    t("editar metadados com adiciona=true → 200", r.status === 200, `status=${r.status}`);

    // remove=true, adiciona=false → reduzir ok, aumentar/editar 403
    setCfg(ids.camp, "patrimonio", { jogadorAdicionaItens: false, jogadorRemoveItens: true });
    r = await req(BASE, "PATCH", `/characters/${ids.charJ}/inventario/${item}`, { cookie: cj1, body: { quantity: 4 } });
    t("reduzir 7→4 com remove=true → 200", r.status === 200, `status=${r.status}`);
    t("banco reflete qtd 4", qtdDb(item) === 4, `qtd=${qtdDb(item)}`);
    r = await req(BASE, "PATCH", `/characters/${ids.charJ}/inventario/${item}`, { cookie: cj1, body: { quantity: 6 } });
    t("aumentar com adiciona=false → 403", r.status === 403, `status=${r.status}`);
    r = await req(BASE, "PATCH", `/characters/${ids.charJ}/inventario/${item}`, { cookie: cj1, body: { description: "x" } });
    t("editar metadados com adiciona=false → 403", r.status === 403, `status=${r.status}`);

    // ambos false → nada para jogador
    setCfg(ids.camp, "patrimonio", { jogadorAdicionaItens: false, jogadorRemoveItens: false });
    r = await req(BASE, "PATCH", `/characters/${ids.charJ}/inventario/${item}`, { cookie: cj1, body: { quantity: 2 } });
    t("reduzir com ambos false → 403", r.status === 403, `status=${r.status}`);
    // mestre sempre pode
    r = await req(BASE, "PATCH", `/characters/${ids.charJ}/inventario/${item}`, { cookie: cm, body: { quantity: 2 } });
    t("mestre reduz → 200", r.status === 200, `status=${r.status}`);
    setCfg(ids.camp, "patrimonio", { jogadorAdicionaItens: true, jogadorRemoveItens: false });
  }

  // ===== 2. HP concorrente =====
  sec("HP — 10 alterações simultâneas preservam todo o histórico");
  {
    const antes = hpDb(ids.charJ);
    const nAntes = antes?.historico?.length ?? 0;
    const hpAntes = antes?.atual;
    const rs = await Promise.all(Array.from({ length: 10 }, () =>
      req(BASE, "POST", `/characters/${ids.charJ}/hp`, { cookie: cj1, body: { acao: "dano", quantidade: 1, motivo: "rajada" } })));
    t("10 respostas 200", rs.every((r) => r.status === 200), rs.map((r) => r.status).join(","));
    const depois = hpDb(ids.charJ);
    t("histórico ganhou exatamente 10 eventos", (depois?.historico?.length ?? 0) === nAntes + 10,
      `antes=${nAntes} depois=${depois?.historico?.length}`);
    // __hp pode não existir ainda: o HP inicial é o máximo (100 + FOR5×10 = 150)
    const hpInicial = hpAntes ?? 150;
    t("HP diminuiu exatamente 10", depois?.atual === hpInicial - 10, `antes=${hpInicial} depois=${depois?.atual}`);
    const motivos = new Set(depois.historico.slice(-10).map((e) => e.motivo));
    t("todos os eventos têm motivo 'rajada'", motivos.size === 1 && motivos.has("rajada"), JSON.stringify([...motivos]));
  }

  // ===== 3. Vitalidade concorrente =====
  sec("Vitalidade — 6 alterações simultâneas preservam todo o histórico");
  {
    const antes = vitDb(ids.charM);
    const nAntes = antes?.historico?.length ?? 0;
    const rs = await Promise.all([0, 1, 2, 1, 0, 1].map((nivel, i) =>
      req(BASE, "POST", `/characters/${ids.charM}/vitalidade`, { cookie: cm, body: { nivel, motivo: `conc-${i}` } })));
    t("6 respostas 200", rs.every((r) => r.status === 200), rs.map((r) => r.status).join(","));
    const depois = vitDb(ids.charM);
    t("histórico ganhou exatamente 6 eventos", (depois?.historico?.length ?? 0) === nAntes + 6,
      `antes=${nAntes} depois=${depois?.historico?.length}`);
    const ultimos = depois.historico.slice(-6);
    t("níveis anteriores encadeados sem salto", ultimos.every((e, i) => e.nivelNovo === [0, 1, 2, 1, 0, 1][i]),
      JSON.stringify(ultimos.map((e) => [e.nivelAnterior, e.nivelNovo])));
  }

  // ===== 4. amount × casasDecimais =====
  sec("money_transactions.amount respeita casasDecimais=4");
  {
    setCfg(ids.camp, "financeiro", { casasDecimais: 4 });
    const conta = (await req(BASE, "POST", `/characters/${ids.charJ}/financeiro/contas`, {
      cookie: cj1, body: { type: "especie", name: "Bolso", balanceReais: 10 },
    })).json?.id;
    t("conta criada", !!conta);

    // movimentar entrada de 1.5 → amountCents=15000, amount=1.5
    await req(BASE, "POST", `/characters/${ids.charJ}/financeiro/movimentar`, {
      cookie: cj1, body: { accountId: conta, tipo: "entrada", valor: 1.5, descricao: "x" },
    });
    // transferência para conta do mestre
    const contaM = (await req(BASE, "POST", `/characters/${ids.charM}/financeiro/contas`, {
      cookie: cm, body: { type: "especie", name: "Mestre", balanceReais: 0 },
    })).json?.id;
    await req(BASE, "POST", `/characters/${ids.charJ}/financeiro/transferir`, {
      cookie: cj1, body: { origemAccountId: conta, destinoAccountId: contaM, valor: 0.25, descricao: "pix" },
    });
    // compra de 0.75
    await req(BASE, "POST", `/characters/${ids.charJ}/financeiro/operacao`, {
      cookie: cj1, body: { tipo: "compra", accountId: conta, valor: 0.75, item: { name: "Gema", quantity: 1 } },
    });

    const txs = comDb(BANCO, (db) => db.prepare(
      "select kind, amount, amount_cents from money_transactions where character_id=? order by created_at"
    ).all(ids.charJ));
    const porKind = Object.fromEntries(txs.map((x) => [x.kind, x]));
    const confere = (kind, amountCents, amount) => {
      const tx = porKind[kind];
      return tx && tx.amount_cents === amountCents && Math.abs(tx.amount - amount) < 1e-9;
    };
    // saldo_inicial 10.00 → 100000; entrada 1.5 → 15000; saída pix -0.25 → -2500; compra -0.75 → -7500
    t("saldo_inicial: amount=10 (não 1000)", porKind.saldo_inicial && Math.abs(porKind.saldo_inicial.amount - 10) < 1e-9,
      `amount=${porKind.saldo_inicial?.amount}`);
    t("entrada: amountCents=15000 e amount=1.5", confere("entrada", 15000, 1.5), JSON.stringify(porKind.entrada));
    // transferência gera saída na origem (kind pix_ficticio ou transferencia, amount negativo)
    const saidaPix = txs.find((x) => x.amount_cents === -2500);
    t("PIX saída: amount=-0.25", !!saidaPix && Math.abs(saidaPix.amount - -0.25) < 1e-9, JSON.stringify(saidaPix));
    t("compra: amountCents=-7500 e amount=-0.75", confere("compra", -7500, -0.75), JSON.stringify(porKind.compra));

    // Regressão pedida: casas 0, 2 e 3 — amount deve bater com a escala
    for (const [casas, saldoIni, entrada] of [[0, 10, 2], [2, 5.5, 1.25], [3, 1.234, 0.5]]) {
      setCfg(ids.camp, "financeiro", { casasDecimais: casas });
      const c = (await req(BASE, "POST", `/characters/${ids.charM}/financeiro/contas`, {
        cookie: cm, body: { type: "especie", name: `C${casas}`, balanceReais: saldoIni },
      })).json?.id;
      await req(BASE, "POST", `/characters/${ids.charM}/financeiro/movimentar`, {
        cookie: cm, body: { accountId: c, tipo: "entrada", valor: entrada, descricao: "reg" },
      });
      const txs2 = comDb(BANCO, (db) => db.prepare(
        "select kind, amount, amount_cents from money_transactions where account_id=? order by created_at"
      ).all(c));
      const ini = txs2.find((x) => x.kind === "saldo_inicial");
      const ent = txs2.find((x) => x.kind === "entrada");
      const fator = 10 ** casas;
      t(`casas=${casas}: saldo_inicial amount=${saldoIni}`,
        ini && Math.abs(ini.amount - saldoIni) < 1e-9 && ini.amount_cents === Math.round(saldoIni * fator),
        JSON.stringify(ini));
      t(`casas=${casas}: entrada amount=${entrada}`,
        ent && Math.abs(ent.amount - entrada) < 1e-9 && ent.amount_cents === Math.round(entrada * fator),
        JSON.stringify(ent));
    }
    setCfg(ids.camp, "financeiro", { casasDecimais: 2 });
  }
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
