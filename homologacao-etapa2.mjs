// Homologação E2E — Etapa 2 completa (Issue #33).
// Mestre + 2 jogadores 100% sintéticos em banco criado do zero
// (teste-base.mjs) — nunca copia banco/mestre-rpg.db.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("etapa2-e2e");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

const saldo = async (base, cookie, charId) => {
  const fin = (await req(base, "GET", `/characters/${charId}/financeiro`, { cookie })).json;
  return fin?.contas?.[0]?.saldo;
};

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc, ids, cm, cj1, cj2;


try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  // Cenário sintético: admin + campanha + 2 jogadores + regras completas
  const cenario = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "jogador_um_e2e", jogador2: "jogador_dois_e2e" },
    config: {
      hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "ambos" },
      vitalidade: { edicaoPor: "ambos", niveis: [
        { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
        { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
        { nome: "Incapacitado", penalidadeDados: 0, bloqueiaAcoes: true },
      ] },
      financeiro: { casasDecimais: 2, moedaPrincipal: "BRL", moedas: [{ codigo: "EUR", nome: "Euro" }] },
      patrimonio: { jogadorCriaContas: true, jogadorCompraVenda: true, jogadorPix: true },
    },
  });
  ids = {
    admin: cenario.adminId, j1: cenario.jogadores.jogador1.id, j2: cenario.jogadores.jogador2.id,
    camp: cenario.campId, charM: cenario.personagemMestre,
    charJ1: cenario.novoPersonagem(cenario.jogadores.jogador1.membershipId, "Jogador Um"),
    charJ2: cenario.novoPersonagem(cenario.jogadores.jogador2.membershipId, "Jogador Dois"),
  };
  cm = cenario.cookieMestre; cj1 = cenario.jogadores.jogador1.cookie; cj2 = cenario.jogadores.jogador2.cookie;
  console.log("seed:", ids);

  // ===== 1. Fichas: mestre vê os 3, jogadores veem a própria =====
  sec("Fichas e permissões de leitura");
  for (const [nome, cookie, cid, esperado] of [["mestre", cm, ids.charJ1, 200], ["jogador1", cj1, ids.charJ1, 200], ["jogador2", cj2, ids.charJ1, 403]]) {
    const r = await req(BASE, "GET", `/characters/${cid}`, { cookie });
    t(`${nome} lê ficha → ${esperado}`, r.status === esperado, `status=${r.status}`);
  }
  {
    const r = await req(BASE, "GET", `/characters/${ids.charJ1}`, { cookie: cj1 });
    t("jogador1 vê vida.hp na própria ficha", !!r.json?.ficha?.vida?.hp);
  }
  const invJ2 = await req(BASE, "GET", `/characters/${ids.charJ1}/inventario`, { cookie: cj2 });
  t("jogador2 NÃO acessa inventário do jogador1", invJ2.status === 403 || invJ2.status === 404, `status=${invJ2.status}`);

  // ===== 2. Inventário + equipamento + transferência =====
  sec("Inventário, equipamento e transferência");
  {
    const item = (await req(BASE, "POST", `/characters/${ids.charJ1}/inventario`, {
      cookie: cj1, body: { name: "Espada", quantity: 5, category: "arma" },
    })).json?.id;
    t("jogador1 cria item qtd5", !!item);
    const eq = await req(BASE, "POST", `/characters/${ids.charJ1}/inventario/${item}/equipar`, { cookie: cj1, body: {} });
    t("jogador1 equipa 1 → 201", eq.status === 201, `status=${eq.status}`);
    const inv = (await req(BASE, "GET", `/characters/${ids.charJ1}/inventario`, { cookie: cj1 })).json?.itens ?? [];
    t("estoque = 4", inv.find((i) => i.name === "Espada")?.quantity === 4);
    const tr = await req(BASE, "POST", `/characters/${ids.charJ1}/inventario/${item}/transferir`, {
      cookie: cj1, body: { destinoCharacterId: ids.charJ2, quantidade: 1 },
    });
    t("transferir pilha vinculada → 409", tr.status === 409, `status=${tr.status}`);
    const eqId = eq.json?.equipamento?.id ?? eq.json?.id;
    await req(BASE, "POST", `/characters/${ids.charJ1}/equipamentos/${eqId}/desequipar`, { cookie: cj1, body: {} });
    const tr2 = await req(BASE, "POST", `/characters/${ids.charJ1}/inventario/${item}/transferir`, {
      cookie: cj1, body: { destinoCharacterId: ids.charJ2, quantidade: 2 },
    });
    t("após desequipar, transferir 2 → 200", tr2.status === 200, `status=${tr2.status} ${JSON.stringify(tr2.json).slice(0, 100)}`);
    const inv2 = (await req(BASE, "GET", `/characters/${ids.charJ2}/inventario`, { cookie: cj2 })).json?.itens ?? [];
    t("jogador2 recebeu 2 Espadas", inv2.find((i) => i.name === "Espada")?.quantity === 2, JSON.stringify(inv2.map((i) => [i.name, i.quantity])));
    t("jogador1 ficou com 3", (await req(BASE, "GET", `/characters/${ids.charJ1}/inventario`, { cookie: cj1 })).json?.itens?.find((i) => i.name === "Espada")?.quantity === 3);
  }

  // ===== 3. HP: dano + recuperação + histórico =====
  sec("HP e histórico");
  {
    const dano = await req(BASE, "POST", `/characters/${ids.charJ1}/hp`, {
      cookie: cj1, body: { acao: "dano", quantidade: 30, motivo: "Golpe do goblin" },
    });
    t("jogador1 causa dano → 200", dano.status === 200, `status=${dano.status}`);
    t("HP 150→120", dano.json?.hp?.atual === 120, `atual=${dano.json?.hp?.atual}`);
    const rec = await req(BASE, "POST", `/characters/${ids.charJ1}/hp`, {
      cookie: cj1, body: { acao: "recuperar", quantidade: 10, motivo: "Descanso" },
    });
    t("recuperação → HP 130", rec.json?.hp?.atual === 130, `atual=${rec.json?.hp?.atual}`);
    const hist = rec.json?.hp?.historico ?? [];
    t("histórico HP ≥ 2 eventos reais", hist.length >= 2, `n=${hist.length}`);
    t("evento de dano tem motivo e autor", hist.some((e) => e.motivo === "Golpe do goblin" && e.autorId === ids.j1));
    // jogador2 não altera HP do jogador1
    const negado = await req(BASE, "POST", `/characters/${ids.charJ1}/hp`, {
      cookie: cj2, body: { acao: "dano", quantidade: 5 },
    });
    t("jogador2 não altera HP alheio", negado.status === 403 || negado.status === 404, `status=${negado.status}`);
  }

  // ===== 4. Vitalidade com motivo =====
  sec("Vitalidade e motivo");
  {
    const v = await req(BASE, "POST", `/characters/${ids.charM}/vitalidade`, {
      cookie: cm, body: { nivel: 1, motivo: "Ferimento em treino" },
    });
    t("mestre define vitalidade → 200", v.status === 200, `status=${v.status}`);
    t("nível 1 = Machucado", v.json?.vitalidade?.nome === "Machucado", v.json?.vitalidade?.nome);
    const ficha = (await req(BASE, "GET", `/characters/${ids.charM}`, { cookie: cm })).json?.ficha?.vida?.vitalidade;
    t("histórico de vitalidade gravado", ficha?.historico?.length === 1 && ficha.historico[0].motivo === "Ferimento em treino", JSON.stringify(ficha?.historico).slice(0, 150));
    t("evento tem nível anterior/novo", ficha?.historico?.[0]?.nivelAnterior === 0 && ficha?.historico?.[0]?.nivelNovo === 1);
    const v2 = await req(BASE, "POST", `/characters/${ids.charM}/vitalidade`, {
      cookie: cm, body: { nivel: 2 },
    });
    t("2ª mudança → histórico cresce", v2.json?.vitalidade?.historico?.length === 2, `n=${v2.json?.vitalidade?.historico?.length}`);
  }

  // ===== 5. Financeiro: compra, venda, PIX =====
  sec("Financeiro: compra/venda/PIX");
  {
    const contaJ1 = (await req(BASE, "POST", `/characters/${ids.charJ1}/financeiro/contas`, {
      cookie: cj1, body: { type: "especie", name: "Bolso", balanceReais: 100 },
    })).json?.id;
    const contaJ2 = (await req(BASE, "POST", `/characters/${ids.charJ2}/financeiro/contas`, {
      cookie: cj2, body: { type: "especie", name: "Poupança", balanceReais: 50 },
    })).json?.id;
    t("contas criadas", !!contaJ1 && !!contaJ2);

    const compra = await req(BASE, "POST", `/characters/${ids.charJ1}/financeiro/operacao`, {
      cookie: cj1, body: { tipo: "compra", accountId: contaJ1, valor: 30, item: { name: "Poção", quantity: 2 }, requestId: "e2e-compra-1" },
    });
    t("compra → 201", compra.status === 201, `status=${compra.status}`);
    t("saldo J1 = 70.00", (await saldo(BASE, cj1, ids.charJ1)) === 70, `saldo=${await saldo(BASE, cj1, ids.charJ1)}`);

    const itemPo = (await req(BASE, "GET", `/characters/${ids.charJ1}/inventario`, { cookie: cj1 })).json?.itens?.find((i) => i.name === "Poção");
    t("Poção entrou no inventário (qtd2)", itemPo?.quantity === 2, JSON.stringify(itemPo?.quantity));

    const venda = await req(BASE, "POST", `/characters/${ids.charJ1}/financeiro/operacao`, {
      cookie: cj1, body: { tipo: "venda", accountId: contaJ1, valor: 10, itemId: itemPo.id, quantidade: 1, requestId: "e2e-venda-1" },
    });
    t("venda parcial → 201", venda.status === 201, `status=${venda.status}`);
    t("saldo J1 = 80.00", (await saldo(BASE, cj1, ids.charJ1)) === 80, `saldo=${await saldo(BASE, cj1, ids.charJ1)}`);

    // PIX fictício J1 → J2 (jogador pode, config.jogadorPix)
    const pix = await req(BASE, "POST", `/characters/${ids.charJ1}/financeiro/transferir`, {
      cookie: cj1, body: { origemAccountId: contaJ1, destinoAccountId: contaJ2, valor: 25, descricao: "Divide do loot" },
    });
    t("PIX J1→J2 → 201", pix.status === 201, `status=${pix.status} ${JSON.stringify(pix.json).slice(0, 120)}`);
    t("saldo J1 = 55.00", (await saldo(BASE, cj1, ids.charJ1)) === 55, `saldo=${await saldo(BASE, cj1, ids.charJ1)}`);
    t("saldo J2 = 75.00", (await saldo(BASE, cj2, ids.charJ2)) === 75, `saldo=${await saldo(BASE, cj2, ids.charJ2)}`);

    // Venda acima do estoque → 400
    const over = await req(BASE, "POST", `/characters/${ids.charJ1}/financeiro/operacao`, {
      cookie: cj1, body: { tipo: "venda", accountId: contaJ1, valor: 10, itemId: itemPo.id, quantidade: 99 },
    });
    t("venda > estoque → 400", over.status === 400, `status=${over.status}`);
  }

  // ===== 6. Reinício e persistência =====
  sec("Reinício do servidor — persistência");
  {
    proc.kill();
    await new Promise((r) => setTimeout(r, 800));
    proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
    await esperarSaudavel(BASE, proc);
    const ficha = (await req(BASE, "GET", `/characters/${ids.charJ1}`, { cookie: cj1 })).json?.ficha;
    t("HP persiste (130)", ficha?.vida?.hp?.atual === 130, `atual=${ficha?.vida?.hp?.atual}`);
    t("histórico HP persiste", (ficha?.vida?.hp?.historico?.length ?? 0) >= 2);
    const inv = (await req(BASE, "GET", `/characters/${ids.charJ1}/inventario`, { cookie: cj1 })).json?.itens ?? [];
    t("inventário persiste (Espada=3, Poção=1)", inv.find((i) => i.name === "Espada")?.quantity === 3 && inv.find((i) => i.name === "Poção")?.quantity === 1, JSON.stringify(inv.map((i) => [i.name, i.quantity])));
    const vit = (await req(BASE, "GET", `/characters/${ids.charM}`, { cookie: cm })).json?.ficha?.vida?.vitalidade;
    t("vitalidade persiste (nível 2, 2 eventos)", vit?.nivel === 2 && vit?.historico?.length === 2, `nivel=${vit?.nivel} hist=${vit?.historico?.length}`);
    t("saldos persistem", (await saldo(BASE, cj1, ids.charJ1)) === 55 && (await saldo(BASE, cj2, ids.charJ2)) === 75);
  }
} finally {
  proc?.kill();
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
