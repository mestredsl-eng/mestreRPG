// Homologação — Issue #122: limitação condicional de teto entre elementos.
// Cobre: schema/API (criar/editar elemento com limitacoes), motor
// autoritativo (validarRegras via PATCH da ficha — rejeição específica,
// menor teto entre limitadores, remoção do limitador, referência entre
// tipos e selecao_nivel), e o editor visual (criar, editar, salvar e
// reabrir o campo "Limitações condicionais" no formato tipo:chave@máx).
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("limitacoes");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;

// Estrutura com os campos que a biblioteca vai preencher:
// - manipulacao: inteiro ligado a atributo:manipulacao (nível = número)
// - vantagens: selecao_multipla ligada a vantagem:* (nível = 1 por item)
// - defeitos: selecao_nivel ligada a defeito:* (nível graduado)
const ESTRUTURA = {
  versao: 1,
  secoes: [{
    id: "s1", titulo: "Atributos e vantagens", ordem: 0,
    campos: [
      { id: "manipulacao", label: "Manipulação", tipo: "inteiro", semantico: "atributo", regra: { kind: "atributo", key: "manipulacao" }, editavelPor: "ambos" },
      { id: "forca", label: "Força", tipo: "inteiro", semantico: "atributo", regra: { kind: "atributo", key: "forca" }, editavelPor: "ambos" },
      { id: "vantagens", label: "Vantagens", tipo: "selecao_multipla", semantico: "vantagem", regraKind: "vantagem", editavelPor: "ambos" },
      { id: "defeitos", label: "Defeitos", tipo: "selecao_nivel", semantico: "defeito", regraKind: "defeito", editavelPor: "ambos" },
    ],
  }],
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
};

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "ficha_j1" }, ficha: false });
  const ids = { camp: cenario.campId, cm: cenario.cookieMestre, j1: cenario.jogadores.jogador1 };

  // Template + versão publicados + personagem do jogador1
  const agora = Date.now();
  const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,1,?,?)")
        .run(tplId, ids.camp, "Ficha Limitações", null, cenario.adminId, agora, agora);
      w.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
        .run(verId, tplId, JSON.stringify(ESTRUTURA), agora, agora);
      w.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);
    } finally { w.close(); }
  }
  const pjId = crypto.randomUUID();
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(pjId, ids.camp, ids.j1.membershipId, verId, "PJ Limitações",
          JSON.stringify({ manipulacao: 0, forca: 1, vantagens: [], defeitos: [] }), "{}", "rascunho", 0, agora, agora);
    } finally { w.close(); }
  }

  const API = `/campaigns/${ids.camp}/regras/elementos`;
  const novoEl = (kind, key, name, definition) =>
    req(BASE, "POST", API, { cookie: ids.cm, body: { kind, key, name, definition } });

  sec("API — criação/edição de elementos com limitacoes");
  const rManip = await novoEl("atributo", "manipulacao", "Manipulação", { maximo: 5 });
  t("atributo Manipulação criado", rManip.status === 201, JSON.stringify(rManip.json).slice(0, 140));
  const rForca = await novoEl("atributo", "forca", "Força", { maximo: 5 });
  t("atributo Força criado", rForca.status === 201);
  const rSorte = await novoEl("vantagem", "sorte", "Sorte", {
    custoPontos: 1, limitacoes: [{ kind: "atributo", key: "manipulacao", maximo: 2 }],
  });
  t("vantagem Sorte c/ limitacao criada", rSorte.status === 201, JSON.stringify(rSorte.json).slice(0, 140));
  const rAzar = await novoEl("vantagem", "azar", "Azar", {
    custoPontos: 1, limitacoes: [{ kind: "atributo", key: "manipulacao", maximo: 1 }],
  });
  t("vantagem Azar c/ limitacao criada", rAzar.status === 201);
  const rMemoria = await novoEl("vantagem", "memoria", "Memória", { custoPontos: 1 });
  t("vantagem Memória criada", rMemoria.status === 201);
  const rPraga = await novoEl("defeito", "praga", "Praga", {
    limitacoes: [{ kind: "vantagem", key: "memoria", maximo: 0 }],
  });
  t("defeito Praga c/ limitacao cruzada criada", rPraga.status === 201);

  // round-trip: a definição persistida devolve limitacoes intactas
  const lista = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: ids.cm });
  const sorteApi = lista.json?.elementos?.find((e) => e.key === "sorte");
  t("GET /regras devolve limitacoes persistidas",
    sorteApi?.definition?.limitacoes?.[0]?.kind === "atributo"
    && sorteApi?.definition?.limitacoes?.[0]?.key === "manipulacao"
    && sorteApi?.definition?.limitacoes?.[0]?.maximo === 2,
    JSON.stringify(sorteApi?.definition?.limitacoes));

  // edição via PATCH preserva/atualiza limitacoes
  const sortId = sorteApi?.id;
  const rPatch = await req(BASE, "PATCH", `${API}/${sortId}`, {
    cookie: ids.cm,
    body: { definition: { limitacoes: [{ kind: "atributo", key: "manipulacao", maximo: 3 }] } },
  });
  t("PATCH atualiza limitacao (2→3)", rPatch.status === 200, JSON.stringify(rPatch.json).slice(0, 140));
  const lista2 = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: ids.cm });
  const sorte2 = lista2.json?.elementos?.find((e) => e.key === "sorte");
  t("PATCH persistiu maximo=3", sorte2?.definition?.limitacoes?.[0]?.maximo === 3);
  // volta para 2 para os testes do motor
  await req(BASE, "PATCH", `${API}/${sortId}`, {
    cookie: ids.cm,
    body: { definition: { limitacoes: [{ kind: "atributo", key: "manipulacao", maximo: 2 }] } },
  });

  // payload malformado é rejeitado pelo schema (400)
  const rRuim = await novoEl("vantagem", "ruim", "Ruim", { limitacoes: "nao-e-lista" });
  t("limitacoes malformado → 400", rRuim.status === 400, `status=${rRuim.status}`);

  // Schema estrito (Issue #122 revisão): entradas inválidas → 400 e
  // NADA é persistido — o elemento de controle segue intacto.
  const casosInvalidos = [
    ["kind desconhecido", { kind: "kind_inexistente", key: "forca", maximo: 2 }],
    ["kind vazio", { kind: "", key: "forca", maximo: 2 }],
    ["key vazia", { kind: "atributo", key: "", maximo: 2 }],
    ["key com espaços", { kind: "atributo", key: "for ca", maximo: 2 }],
    ["key com caracteres inválidos", { kind: "atributo", key: "força!", maximo: 2 }],
    ["máximo negativo", { kind: "atributo", key: "forca", maximo: -1 }],
    ["máximo não finito", { kind: "atributo", key: "forca", maximo: "Infinity" }],
    ["máximo ausente", { kind: "atributo", key: "forca" }],
  ];
  let seqInv = 0;
  for (const [rotulo, lim] of casosInvalidos) {
    seqInv += 1;
    const rInv = await novoEl("vantagem", `inv_${seqInv}`, `Inválido ${seqInv}`, { limitacoes: [lim] });
    t(`API rejeita ${rotulo} → 400`, rInv.status === 400, `status=${rInv.status} ${JSON.stringify(rInv.json?.detalhes ?? "").slice(0, 100)}`);
  }
  const listaAposInv = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: ids.cm });
  t("entradas inválidas não persistiram nenhum elemento",
    !listaAposInv.json?.elementos?.some((e) => e.key?.startsWith("inv_")));
  // edição com limitacao inválida também é rejeitada e preserva a definição
  const rPatchInv = await req(BASE, "PATCH", `${API}/${sortId}`, {
    cookie: ids.cm,
    body: { definition: { limitacoes: [{ kind: "atributo", key: "forca", maximo: -3 }] } },
  });
  t("PATCH com limitacao inválida → 400", rPatchInv.status === 400, `status=${rPatchInv.status}`);
  const listaPosInv = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: ids.cm });
  t("definição preservada após PATCH inválido",
    listaPosInv.json?.elementos?.find((e) => e.key === "sorte")?.definition?.limitacoes?.[0]?.maximo === 2);

  sec("Motor — PATCH da ficha aplica o teto condicional");
  const PATCH = (data) => req(BASE, "PATCH", `/characters/${pjId}`, { cookie: ids.j1.cookie, body: { data } });
  const errosDe = (r) => (r.json?.detalhes?.erros ?? []);
  const limDe = (r) => errosDe(r).filter((e) => e.codigo === "limitacao");

  // baseline: manipulação 4 sem limitador → aceita (máx. declarado 5)
  let r = await PATCH({ manipulacao: 4 });
  t("sem limitador: manipulação 4 aceita", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.detalhes ?? "").slice(0, 140)}`);

  // Sorte ativa + Manipulação 3 → rejeitado com erro específico
  r = await PATCH({ vantagens: ["sorte"], manipulacao: 3 });
  t("sorte + manipulação 3 → 400", r.status === 400, `status=${r.status}`);
  t("erro codigo=limitacao", limDe(r).length === 1, JSON.stringify(errosDe(r).map((e) => e.mensagem)));
  t("mensagem: Manipulação limitada a 2 por Sorte",
    limDe(r)[0]?.mensagem === '"Manipulação" está limitada a nível 2 por "Sorte"', limDe(r)[0]?.mensagem);

  // Sorte ativa + Manipulação 2 → aceito
  r = await PATCH({ vantagens: ["sorte"], manipulacao: 2 });
  t("sorte + manipulação 2 → 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.detalhes ?? "").slice(0, 140)}`);

  // Múltiplos limitadores: Azar@1 vence sobre Sorte@2
  r = await PATCH({ vantagens: ["sorte", "azar"], manipulacao: 2 });
  t("sorte+azar + manipulação 2 → 400 (menor teto 1)", r.status === 400);
  t("erro cita Azar nível 1",
    limDe(r).some((e) => e.mensagem.includes("nível 1") && e.mensagem.includes("Azar")), JSON.stringify(limDe(r).map((e) => e.mensagem)));

  // Referência entre tipos: defeito Praga limita vantagem Memória a 0
  r = await PATCH({ vantagens: ["memoria"], defeitos: [{ key: "praga", nivel: 1 }] });
  t("defeito limita vantagem (tipos diferentes) → 400", r.status === 400);
  t("erro cita Memória limitada por Praga",
    limDe(r).some((e) => e.mensagem.includes("Memória") && e.mensagem.includes("Praga")), JSON.stringify(limDe(r).map((e) => e.mensagem)));

  // Sorte removida → limitação retirada automaticamente
  r = await PATCH({ vantagens: [], manipulacao: 4 });
  t("sorte removida: manipulação 4 aceita de novo", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.detalhes ?? "").slice(0, 140)}`);

  sec("UI — editor visual de limitações (criar, editar, salvar, reabrir)");
  const browser = await chromium.launch();
  const errosUi = [];
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: decodeURIComponent(ids.cm.split("=")[1]), url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errosUi.push(String(e)));

  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(900);
  await p.locator(".cartao-campanha", { hasText: "Campanha Teste" }).first().click();
  await p.waitForTimeout(1200);
  await p.getByRole("button", { name: "Regras", exact: true }).click();
  await p.waitForTimeout(1200);
  t("aba Regras aberta", await p.locator(".lista-elementos").count() > 0);

  // CRIAR via UI: novo elemento com limitações no formato tipo:chave@máx
  await p.getByRole("button", { name: "+ Novo elemento" }).click();
  await p.waitForTimeout(400);
  const modal = p.locator(".modal");
  t("modal Novo elemento aberto", await modal.isVisible());
  await modal.locator("label", { hasText: "Tipo" }).locator("select").selectOption("vantagem");
  await modal.locator('input[placeholder="ex.: telepatia"]').fill("sorte_ui");
  await modal.locator("label", { hasText: "Nome" }).locator("input").fill("Sorte UI");
  await modal.locator("label", { hasText: "Limitações condicionais" }).locator("input").fill("atributo:forca@4, atributo:manipulacao@2");
  await modal.getByRole("button", { name: "Salvar" }).click();
  await p.locator(".modal").waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(400);

  const listaUi = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: ids.cm });
  const sorteUi = listaUi.json?.elementos?.find((e) => e.key === "sorte_ui");
  t("UI criou elemento com 2 limitações persistidas",
    sorteUi?.definition?.limitacoes?.length === 2
    && sorteUi.definition.limitacoes[0].kind === "atributo"
    && sorteUi.definition.limitacoes[0].key === "forca"
    && sorteUi.definition.limitacoes[0].maximo === 4
    && sorteUi.definition.limitacoes[1].key === "manipulacao"
    && sorteUi.definition.limitacoes[1].maximo === 2,
    JSON.stringify(sorteUi?.definition?.limitacoes));

  // EDITAR + REABRIR: abrir o modal do elemento e conferir o campo
  await p.locator(".elemento", { hasText: "Sorte UI" }).getByRole("button", { name: "Editar" }).click();
  await p.waitForTimeout(500);
  const modalEd = p.locator(".modal");
  const campoLim = modalEd.locator("label", { hasText: "Limitações condicionais" }).locator("input");
  const valorReaberto = await campoLim.inputValue();
  t("reabrir mostra limitações salvas", valorReaberto === "atributo:forca@4, atributo:manipulacao@2", valorReaberto);

  // edita para um único limitador e salva
  await campoLim.fill("atributo:manipulacao@3");
  await modalEd.getByRole("button", { name: "Salvar" }).click();
  await p.locator(".modal").waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(400);
  const listaEd = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: ids.cm });
  const sorteEd = listaEd.json?.elementos?.find((e) => e.key === "sorte_ui");
  t("edição persistiu 1 limitação (manipulacao@3)",
    sorteEd?.definition?.limitacoes?.length === 1
    && sorteEd.definition.limitacoes[0].key === "manipulacao"
    && sorteEd.definition.limitacoes[0].maximo === 3,
    JSON.stringify(sorteEd?.definition?.limitacoes));

  // formato inválido é bloqueado no cliente (erro nomeado, sem salvar)
  const invalidosUi = [
    ["sem máximo", "atributo:forca"],
    ["@ vazio", "atributo:forca@"],
    ["@ só espaço", "atributo:forca@ "],
    ["@Infinity", "atributo:forca@Infinity"],
    ["@-1", "atributo:forca@-1"],
    ["@2@3", "atributo:forca@2@3"],
  ];
  for (const [rotulo, valor] of invalidosUi) {
    await p.locator(".elemento", { hasText: "Sorte UI" }).getByRole("button", { name: "Editar" }).click();
    await p.waitForTimeout(400);
    const modalInv = p.locator(".modal");
    await modalInv.locator("label", { hasText: "Limitações condicionais" }).locator("input").fill(valor);
    await modalInv.getByRole("button", { name: "Salvar" }).click();
    await p.waitForTimeout(500);
    t(`UI rejeita "${rotulo}" sem salvar`,
      (await modalInv.locator(".erro").count()) > 0 && await modalInv.isVisible());
    await modalInv.getByRole("button", { name: "Cancelar" }).click();
    await p.waitForTimeout(300);
  }

  // zero é um teto válido e deve salvar
  await p.locator(".elemento", { hasText: "Sorte UI" }).getByRole("button", { name: "Editar" }).click();
  await p.waitForTimeout(400);
  const modalZero = p.locator(".modal");
  await modalZero.locator("label", { hasText: "Limitações condicionais" }).locator("input").fill("atributo:forca@0");
  await modalZero.getByRole("button", { name: "Salvar" }).click();
  await p.locator(".modal").waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(400);
  const listaZero = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: ids.cm });
  const sorteZero = listaZero.json?.elementos?.find((e) => e.key === "sorte_ui");
  t("UI aceita teto zero (@0) e persiste",
    sorteZero?.definition?.limitacoes?.[0]?.maximo === 0,
    JSON.stringify(sorteZero?.definition?.limitacoes));

  // nenhuma edição inválida alterou a definição previamente persistida
  const listaFim = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: ids.cm });
  const sorteFim = listaFim.json?.elementos?.find((e) => e.key === "sorte_ui");
  t("entradas inválidas não alteraram a definição",
    sorteFim?.definition?.limitacoes?.length === 1
    && sorteFim.definition.limitacoes[0].maximo === 0);

  t("sem erros de console/pageerror", errosUi.length === 0, errosUi.join(" | ").slice(0, 200));
  await browser.close();

  console.log(`\n${pass} ok, ${fail} falhas`);
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
process.exit(fail > 0 ? 1 : 0);
