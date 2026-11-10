// Homologação integrada — equipamentos/inventário (PR #34), Etapa 2.
// Cenário mestre + jogador 100% sintético em banco criado do zero
// (teste-base.mjs) — nunca copia banco/mestre-rpg.db.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req,
  encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("homolog-equip");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

const qtdItem = async (base, cookie, charId, nome) => {
  const inv = (await req(base, "GET", `/characters/${charId}/inventario`, { cookie })).json?.itens ?? [];
  const it = inv.find((i) => i.name === nome);
  return it?.quantity ?? 0;
};
const totalItens = async (base, cookie, charId) => {
  const inv = (await req(base, "GET", `/characters/${charId}/inventario`, { cookie })).json?.itens ?? [];
  return inv.reduce((s, i) => s + (i.quantity ?? 0), 0);
};
const nEquip = async (base, cookie, charId) => {
  const eq = (await req(base, "GET", `/characters/${charId}/equipamentos`, { cookie })).json?.equipamentos ?? [];
  return eq.length;
};

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc, ids, cm, cj;


async function novoItem(cookie, charId, nome, qtd, extra = {}) {
  const r = await req(BASE, "POST", `/characters/${charId}/inventario`, {
    cookie, body: { name: nome, quantity: qtd, category: "arma", ...extra },
  });
  return r.json?.id ?? r.json?.item?.id;
}

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO, { jogadores: { jogador: "jogador_homolog" } });
  ids = { camp: cenario.campId, charM: cenario.personagemMestre,
    charJ: cenario.novoPersonagem(cenario.jogadores.jogador.membershipId, "Jogador PJ") };
  cm = cenario.cookieMestre; cj = cenario.jogadores.jogador.cookie;
  console.log("seed:", ids);

  // ===== Jogador: pilha de 5 → equipar 1 =====
  sec("Jogador: pilha 5 → equipar 1");
  const lança = await novoItem(cj, ids.charJ, "Lança", 5);
  t("item criado com 5 unidades", !!lança);
  const eq1 = await req(BASE, "POST", `/characters/${ids.charJ}/inventario/${lança}/equipar`, { cookie: cj, body: { requestId: "eq-homolog-1" } });
  t("jogador equipar → 201", eq1.status === 201, `status=${eq1.status} ${JSON.stringify(eq1.json).slice(0, 140)}`);
  const eqId = eq1.json?.equipamento?.id ?? eq1.json?.id;
  t("inventário ficou com 4", (await qtdItem(BASE, cj, ids.charJ, "Lança")) === 4, `qtd=${await qtdItem(BASE, cj, ids.charJ, "Lança")}`);
  t("1 equipamento registrado", (await nEquip(BASE, cj, ids.charJ)) === 1);

  // ===== Mestre visualiza a ficha do jogador (consistência) =====
  sec("Mestre consulta inventário/equipamento do jogador");
  t("mestre vê 4 no inventário", (await qtdItem(BASE, cm, ids.charJ, "Lança")) === 4);
  t("mestre vê 1 equipamento", (await nEquip(BASE, cm, ids.charJ)) === 1);

  // ===== Jogador: desequipar → volta 1 =====
  sec("Jogador: desequipar");
  const des = await req(BASE, "POST", `/characters/${ids.charJ}/equipamentos/${eqId}/desequipar`, { cookie: cj, body: {} });
  t("desequipar → 200", des.status === 200, `status=${des.status}`);
  t("inventário voltou a 5", (await qtdItem(BASE, cj, ids.charJ, "Lança")) === 5, `qtd=${await qtdItem(BASE, cj, ids.charJ, "Lança")}`);
  t("0 equipamentos", (await nEquip(BASE, cj, ids.charJ)) === 0);

  // ===== Jogador: equipar; mestre: excluir equipamento =====
  sec("Jogador equipa / mestre exclui equipamento");
  const eq2 = await req(BASE, "POST", `/characters/${ids.charJ}/inventario/${lança}/equipar`, { cookie: cj, body: {} });
  const eqId2 = eq2.json?.equipamento?.id ?? eq2.json?.id;
  t("re-equipar → 201 e estoque 4", eq2.status === 201 && (await qtdItem(BASE, cj, ids.charJ, "Lança")) === 4);
  const del = await req(BASE, "DELETE", `/characters/${ids.charJ}/equipamentos/${eqId2}`, { cookie: cj });
  t("jogador DELETE → 403 (jogadorRemoveItens desligado)", del.status === 403, `status=${del.status}`);
  const delM = await req(BASE, "DELETE", `/characters/${ids.charJ}/equipamentos/${eqId2}`, { cookie: cm });
  t("mestre exclui equipamento → 200", delM.status === 200, `status=${delM.status}`);
  t("unidade devolvida (estoque 5)", (await qtdItem(BASE, cj, ids.charJ, "Lança")) === 5, `qtd=${await qtdItem(BASE, cj, ids.charJ, "Lança")}`);

  // ===== Estado interno do inventário não pode ser forjado =====
  sec("Estado interno equipped não pode ser forjado pelo cliente");
  {
    const item = await novoItem(cj, ids.charJ, "Item sem bloqueio forjado", 1, {
      data: { equipped: true, anotacao: "metadado legítimo" },
    });
    const lerItem = async () => {
      const itens = (await req(BASE, "GET", `/characters/${ids.charJ}/inventario`, { cookie: cj })).json?.itens ?? [];
      return itens.find((i) => i.id === item);
    };
    let salvo = await lerItem();
    t("POST remove equipped forjado", salvo && !Object.prototype.hasOwnProperty.call(salvo.data ?? {}, "equipped"),
      JSON.stringify(salvo?.data));
    t("POST preserva metadado legítimo", salvo?.data?.anotacao === "metadado legítimo");
    const patch = await req(BASE, "PATCH", `/characters/${ids.charJ}/inventario/${item}`, {
      cookie: cj, body: { data: { equipped: true, anotacao: "editado" } },
    });
    salvo = await lerItem();
    t("PATCH → 200", patch.status === 200, `status=${patch.status}`);
    t("PATCH não injeta equipped", salvo && !Object.prototype.hasOwnProperty.call(salvo.data ?? {}, "equipped"),
      JSON.stringify(salvo?.data));
    t("PATCH preserva edição legítima", salvo?.data?.anotacao === "editado");
    const del = await req(BASE, "DELETE", `/characters/${ids.charJ}/inventario/${item}`, { cookie: cj });
    t("item não fica bloqueado por estado forjado → 403 (política remove desligada)", del.status === 403, `status=${del.status} ${JSON.stringify(del.json)}`);
  }

  // ===== Equipamento manual não cria item =====
  sec("Equipamento manual");
  {
    const antes = await totalItens(BASE, cj, ids.charJ);
    const man = await req(BASE, "POST", `/characters/${ids.charJ}/equipamentos`, {
      cookie: cj, body: { name: "Anel", slot: "dedo", equipped: true, data: { origem: "inventario", inventoryEntryId: "fake", itemSnapshot: {}, requestId: "fake" } },
    });
    t("POST manual → 201", man.status === 201, `status=${man.status} ${JSON.stringify(man.json).slice(0, 120)}`);
    t("inventário não ganhou item", (await totalItens(BASE, cj, ids.charJ)) === antes, `total=${await totalItens(BASE, cj, ids.charJ)} antes=${antes}`);
    const eqs = (await req(BASE, "GET", `/characters/${ids.charJ}/equipamentos`, { cookie: cj })).json?.equipamentos ?? [];
    const anel = eqs.find((e) => e.name === "Anel");
    const dados = typeof anel?.data === "string" ? JSON.parse(anel.data) : anel?.data;
    t("procedência forjada removida", dados && !("origem" in dados) && !("inventoryEntryId" in dados) && !("itemSnapshot" in dados) && !("requestId" in dados), JSON.stringify(dados));
    await req(BASE, "DELETE", `/characters/${ids.charJ}/equipamentos/${anel.id}`, { cookie: cj });
    t("excluir equipamento manual NÃO devolve item", (await totalItens(BASE, cj, ids.charJ)) === antes);
  }

  // ===== Concorrência: equip × transfer na mesma pilha =====
  sec("Concorrência equip × transfer");
  {
    const arco = await novoItem(cj, ids.charJ, "Arco", 3);
    const destino = ids.charM; // mestre recebe unidade do jogador? transferir exige acesso ao destino — mestre na mesma campanha
    const eqAntes = await nEquip(BASE, cj, ids.charJ);
    const [eqR, trR] = await Promise.all([
      req(BASE, "POST", `/characters/${ids.charJ}/inventario/${arco}/equipar`, { cookie: cj, body: {} }),
      req(BASE, "POST", `/characters/${ids.charJ}/inventario/${arco}/transferir`, { cookie: cj, body: { destinoCharacterId: destino, quantidade: 1 } }),
    ]);
    const invDepois = await qtdItem(BASE, cj, ids.charJ, "Arco");
    const eqDepois = await nEquip(BASE, cj, ids.charJ);
    t("alguma operação venceu (201)", eqR.status === 201 || trR.status === 201, `eq=${eqR.status} tr=${trR.status}`);
    t("exatamente uma venceu", (eqR.status === 201) !== (trR.status === 201), `eq=${eqR.status} tr=${trR.status}`);
    t("estoque Arco = 2 em ambos os casos", invDepois === 2, `qtd=${invDepois}`);
    t("delta de equipamentos = 1 se equipar venceu, 0 se transfer venceu", eqDepois - eqAntes === (eqR.status === 201 ? 1 : 0), `delta=${eqDepois - eqAntes}`);
  }

  // ===== Persistência após reinício =====
  sec("Persistência após reinício");
  {
    // deixa um equipamento ativo antes de reiniciar
    const eqAtivo = await req(BASE, "POST", `/characters/${ids.charJ}/inventario/${lança}/equipar`, { cookie: cj, body: {} });
    t("equipar p/ restart → 201", eqAtivo.status === 201, `status=${eqAtivo.status}`);
    const estoqueAntes = await qtdItem(BASE, cj, ids.charJ, "Lança");
    const eqAntesRestart = await nEquip(BASE, cj, ids.charJ);
    await encerrarServidor(proc);
    proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
    await esperarSaudavel(BASE, proc);
    t("estoque persiste após restart", (await qtdItem(BASE, cj, ids.charJ, "Lança")) === estoqueAntes, `qtd=${await qtdItem(BASE, cj, ids.charJ, "Lança")}`);
    t("equipamentos persistem após restart", (await nEquip(BASE, cj, ids.charJ)) === eqAntesRestart, `eq=${await nEquip(BASE, cj, ids.charJ)} antes=${eqAntesRestart}`);
    const eqs = (await req(BASE, "GET", `/characters/${ids.charJ}/equipamentos`, { cookie: cj })).json?.equipamentos ?? [];
    const lan = eqs.find((e) => {
      const d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      return d?.itemSnapshot?.name === "Lança";
    });
    const snap = lan?.data ? (typeof lan.data === "string" ? JSON.parse(lan.data) : lan.data) : null;
    t("snapshot do item preservado", snap?.origem === "inventario" && snap?.itemSnapshot?.name === "Lança", JSON.stringify(snap?.itemSnapshot?.name));
  }
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
