// teste-acervo-campanha.mjs — Etapa 4 (Issue #33):
// aplicação de livros do Acervo global às regras da campanha.
// Banco 100% sintético via teste-base.mjs. Cobre:
// listagem pelo mestre, permissão de jogador, aplicação, idempotência,
// atualização disponível, conflitos 409 + decisões, kind incompatível 422,
// livro excluído 404 e elementos refletidos em /regras/elementos.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, comDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("acervo-campanha");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Acervo",
    jogadores: { jogador1: "jog_acervo" },
    ficha: false,
  });
  const cm = cenario.cookieMestre;
  const cj = cenario.jogadores.jogador1.cookie;
  const camp = cenario.campId;

  // ===== 1. livro no acervo global =====
  sec("Livro no Acervo");
  const livro = {
    titulo: "Bestiário Sintético",
    tipo: "livro",
    itens: [
      { kind: "atributo", key: "forca_bib", name: "Força (livro)", definition: { descricao: "v1" } },
      { kind: "habilidade", key: "furtividade_bib", name: "Furtividade (livro)", definition: {} },
      { kind: "item", key: "pocao_bib", name: "Poção (livro)", definition: { descricao: "cura 1d8" } },
    ],
  };
  const criado = await req(BASE, "POST", "/biblioteca/livros", { cookie: cm, body: livro });
  const bookId = criado.json?.livro?.id;
  t("livro criado no acervo", criado.status === 201 && !!bookId, `status=${criado.status} ${JSON.stringify(criado.json).slice(0, 140)}`);

  // livro com kind fora de TIPOS_REGRA (válido no acervo, incompatível na campanha)
  const incompat = await req(BASE, "POST", "/biblioteca/livros", {
    cookie: cm,
    body: { titulo: "Incompatível", tipo: "livro", itens: [{ kind: "regra_combate", key: "vant_ataque", name: "Vantagem", definition: {} }] },
  });
  const bookIncomp = incompat.json?.livro?.id;
  t("livro com kind incompatível criado no acervo", incompat.status === 201 && !!bookIncomp, `status=${incompat.status}`);

  // ===== 2. listagem e permissões =====
  sec("Acervo da campanha: listagem e permissões");
  const listaM = await req(BASE, "GET", `/campaigns/${camp}/regras/acervo`, { cookie: cm });
  const itemLista = (listaM.json?.livros ?? []).find((l) => l.id === bookId);
  t("mestre lista livros do acervo", listaM.status === 200 && !!itemLista, `status=${listaM.status}`);
  t("livro aparece não aplicado", itemLista?.aplicado === false && itemLista?.totalItens === 3,
    JSON.stringify(itemLista).slice(0, 160));
  const listaJ = await req(BASE, "GET", `/campaigns/${camp}/regras/acervo`, { cookie: cj });
  t("jogador NÃO lista acervo da campanha", listaJ.status === 403, `status=${listaJ.status}`);
  const aplicaJ = await req(BASE, "POST", `/campaigns/${camp}/regras/acervo/${bookId}/aplicar`, { cookie: cj, body: {} });
  t("jogador NÃO aplica livro", aplicaJ.status === 403, `status=${aplicaJ.status}`);

  // ===== 3. aplicação =====
  sec("Aplicação do livro às regras da campanha");
  const aplica = await req(BASE, "POST", `/campaigns/${camp}/regras/acervo/${bookId}/aplicar`, { cookie: cm, body: {} });
  t("mestre aplica livro", aplica.status === 200 && aplica.json?.ok === true && aplica.json?.inseridos === 3,
    `status=${aplica.status} ${JSON.stringify(aplica.json).slice(0, 160)}`);
  t("versão aplicada registrada", aplica.json?.versaoAplicada >= 1, `v=${aplica.json?.versaoAplicada}`);

  const elementos = await req(BASE, "GET", `/campaigns/${camp}/regras/elementos`, { cookie: cm });
  const elJson = JSON.stringify(elementos.json?.elementos ?? {});
  t("elementos do livro visíveis em /regras/elementos",
    elementos.status === 200
      && elJson.includes('"forca_bib"') && elJson.includes('"furtividade_bib"') && elJson.includes('"pocao_bib"'),
    elJson.slice(0, 200));

  const lista2 = await req(BASE, "GET", `/campaigns/${camp}/regras/acervo`, { cookie: cm });
  const item2 = (lista2.json?.livros ?? []).find((l) => l.id === bookId);
  t("livro marcado como aplicado", item2?.aplicado === true && item2?.versaoAplicada === item2?.versao,
    JSON.stringify(item2).slice(0, 160));

  // idempotência: reaplicar sem mudanças
  const reapply = await req(BASE, "POST", `/campaigns/${camp}/regras/acervo/${bookId}/aplicar`, { cookie: cm, body: {} });
  t("reaplicação idempotente (semAlteracao)", reapply.status === 200 && reapply.json?.semAlteracao === true,
    `status=${reapply.status} ${JSON.stringify(reapply.json).slice(0, 140)}`);

  // ===== 4. atualização disponível + conflito =====
  sec("Atualização do livro e conflitos");
  // campanha diverge: altera o elemento localmente
  const elId = comDbElementId(BANCO, camp, "atributo", "forca_bib");
  const patchEl = await req(BASE, "PATCH", `/campaigns/${camp}/regras/elementos/${elId}`, {
    cookie: cm, body: { definition: { descricao: "versão local da campanha" } },
  });
  t("mestre altera elemento local (divergência)", patchEl.status === 200, `status=${patchEl.status} ${JSON.stringify(patchEl.json).slice(0, 120)}`);

  // livro evolui: descrição do item muda -> versão incrementa
  const itensLivro = (await req(BASE, "GET", `/biblioteca/livros/${bookId}`, { cookie: cm })).json.itens;
  const itemForca = itensLivro.find((i) => i.key === "forca_bib");
  const editaItem = await req(BASE, "PATCH", `/biblioteca/livros/${bookId}/itens/${itemForca.id}`, {
    cookie: cm, body: { definition: { descricao: "v2 do livro" } },
  });
  t("item do livro editado (nova versão)", editaItem.status === 200, `status=${editaItem.status}`);

  const lista3 = await req(BASE, "GET", `/campaigns/${camp}/regras/acervo`, { cookie: cm });
  const item3 = (lista3.json?.livros ?? []).find((l) => l.id === bookId);
  t("atualização disponível sinalizada", item3?.atualizacaoDisponivel === true && item3?.versaoAplicada < item3?.versao,
    JSON.stringify({ va: item3?.versaoAplicada, v: item3?.versao }));

  // aplicar sem decisões -> 409 com conflito explícito
  const conflita = await req(BASE, "POST", `/campaigns/${camp}/regras/acervo/${bookId}/aplicar`, { cookie: cm, body: {} });
  t("conflito sem decisão → 409", conflita.status === 409, `status=${conflita.status}`);
  t("conflito aponta a chave", JSON.stringify(conflita.json?.detalhes ?? conflita.json).includes("atributo:forca_bib"),
    JSON.stringify(conflita.json).slice(0, 200));

  // com decisão manter_campanha -> ok e campanha preserva versão local
  const comDecisao = await req(BASE, "POST", `/campaigns/${camp}/regras/acervo/${bookId}/aplicar`, {
    cookie: cm, body: { decisoes: { "atributo:forca_bib": "manter_campanha" } },
  });
  t("aplicar com decisão manter_campanha → ok", comDecisao.status === 200 && comDecisao.json?.ok === true && comDecisao.json?.mantidos >= 1,
    `status=${comDecisao.status} ${JSON.stringify(comDecisao.json).slice(0, 160)}`);
  const elDepois = await req(BASE, "GET", `/campaigns/${camp}/regras/elementos`, { cookie: cm });
  const elJsonDepois = JSON.stringify(elDepois.json);
  t("versão local preservada após manter_campanha", elJsonDepois.includes("versão local da campanha"), elJsonDepois.slice(0, 200));

  // ===== 5. rejeições =====
  sec("Rejeições");
  const incomp = await req(BASE, "POST", `/campaigns/${camp}/regras/acervo/${bookIncomp}/aplicar`, { cookie: cm, body: {} });
  t("kind incompatível → 422", incomp.status === 422, `status=${incomp.status} ${JSON.stringify(incomp.json).slice(0, 140)}`);

  // exclui o livro incompatível e tenta aplicar -> 404
  await req(BASE, "DELETE", `/biblioteca/livros/${bookIncomp}`, { cookie: cm });
  const excluido = await req(BASE, "POST", `/campaigns/${camp}/regras/acervo/${bookIncomp}/aplicar`, { cookie: cm, body: {} });
  t("livro excluído → 404", excluido.status === 404, `status=${excluido.status}`);

  // limpeza do livro de teste
  await req(BASE, "DELETE", `/biblioteca/livros/${bookId}`, { cookie: cm });
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);

function comDbElementId(banco, campId, kind, key) {
  return comDb(banco, (db) => db.prepare(
    `select rd.id from rule_definitions rd
     join rule_sets rs on rs.id = rd.rule_set_id
     where rs.campaign_id = ? and rd.kind = ? and rd.key = ?`,
  ).get(campId, kind, key)?.id);
}
