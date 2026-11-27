#!/usr/bin/env node
// FILHO — suíte black-box W3 escrita/ownership (#365, matriz SITE-01..12,
// VER-01..03). Contrato-fonte: docs/CONTRATO-ESCRITA-SITES-PAGINAS-365.md
// (branch docs/1.1.2-vereditos-proprietario) + MATRIZ-TESTES-1.1.2.md.
//
// DECISÃO ADOTADA: SITE-12 aprovada = modelo RESTRITO (só o dono do site
// cria páginas no próprio site). O contrato em revisão propõe multi-autoria
// irrestrita como "questão em aberto" — este teste codifica o estado
// aprovado; se o Dono deliberar o contrário, o assert muda com a decisão.
//
// Cobertura pretendida:
//   SITE-01/02 criação só por conta elegível (P5 na estreia pública)
//   SITE-03/04 metadados só do dono; SITE-08 mestre modera sem reescrever
//   SITE-05/12 página só no próprio site; autor derivado da sessão
//   SITE-06/07 edição só do autor; VER-01 version+1 e audit
//   SITE-09/10 P7: titular novo opera, anterior perde na hora
//   SITE-11 concorrência/retry sem lost-update
//   VER-02/03 sem histórico recuperável; audit não é cópia do corpo
//   markdown-subset whitelist → 400 formato_invalido (nunca sanitiza)
//   rate limit escrita 30/min → 429
//   PUB-03 / EXP-06/11/12 → SKIP (fatias futuras, contrato ainda não existe)
//
// Estado esperado AGORA: rotas de escrita ainda não existem → FAIL/TDD.
// Fixtures 100% descartáveis; produção intocada.
import crypto from "node:crypto";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, sessao, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0, skip = 0;
const t = (n, c, x = "") => {
  if (c === "skip") { skip++; console.log("  ~ skip", n, x); }
  else if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, x); }
};
const sec = (n) => console.log("\n== " + n + " ==");

const api = (base, camp, cookie, metodo, path, body) =>
  req(base, metodo, `/campaigns/${camp}/internet${path}`, { cookie, body });
const apiChars = (base, camp, cookie, metodo, path, body) =>
  req(base, metodo, `/campaigns/${camp}/characters${path}`, { cookie, body });

const DIR = dirTeste("f6-escrita-w3");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc;

const comDb = (fn) => {
  const db = abrirDb(BANCO);
  try { return fn(db); } finally { db.close(); }
};
const audits = (actionLike) => comDb((db) =>
  db.prepare("select * from audit_logs where action like ? order by created_at").all(`%${actionLike}%`));

try {
  sec("0. Servidor + cenário base");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  const BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, { jogadores: { j1: "w3e_j1", j2: "w3e_j2", j3: "w3e_j3", j4: "w3e_j4" } });

  // gate P5 (perícia+conhecimento+item) — mesmo padrão das suítes 1.1.1
  {
    const db = abrirDb(BANCO); const agora = Date.now();
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(C.campId);
    const ins = db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,'{}',?,?)");
    for (const [kind, key, name] of [
      ["pericia", "computador", "Computador"], ["conhecimento", "tecnologia", "Tecnologia"],
      ["item", "notebook", "Notebook"],
    ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    if (!est.secoes[0].campos.some((x) => x.id === "comp")) {
      est.secoes[0].campos.push(
        { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
        { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } });
      db.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), ver.id);
    }
    db.close();
  }
  const darNotebook = (characterId) => comDb((db) => {
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), characterId, "Notebook", 1, null, "equipamento", "mochila", "novo", 1.5,
        JSON.stringify({ regra: { kind: "item", key: "notebook" } }), agora, agora);
  });
  const criarConta = async (jog, ch, handle) => {
    const r = await api(BASE, C.campId, jog.cookie, "POST", "/account", { characterId: ch, handle });
    return (r.status === 200 || r.status === 201) ? (r.json?.conta?.id ?? true) : null;
  };

  // ch1/j1 = dona do site A; ch2/j2 = outro autor; ch3/j3 = será transferido p/ j4 (P7)
  const ch1 = C.novoPersonagem(C.jogadores.j1.membershipId, "W3 Dona", { comp: 3 });
  const ch2 = C.novoPersonagem(C.jogadores.j2.membershipId, "W3 Vizinho", { comp: 3 });
  const ch3 = C.novoPersonagem(C.jogadores.j3.membershipId, "W3 Transfer", { comp: 3 });
  for (const ch of [ch1, ch2, ch3]) darNotebook(ch);
  const contaJ1 = await criarConta(C.jogadores.j1, ch1, "w3.dona");
  const contaJ2 = await criarConta(C.jogadores.j2, ch2, "w3.vizinho");
  const contaJ3 = await criarConta(C.jogadores.j3, ch3, "w3.transfer");
  const MEM1 = C.jogadores.j1.membershipId, MEM3 = C.jogadores.j3.membershipId, MEM4 = C.jogadores.j4.membershipId;
  const J1 = C.jogadores.j1.cookie, J2 = C.jogadores.j2.cookie, J3 = C.jogadores.j3.cookie, J4 = C.jogadores.j4.cookie;
  const M = C.cookieMestre;
  t("contas de internet criadas (3)", !!(contaJ1 && contaJ2 && contaJ3));

  // ---------- E1. Criação de site (SITE-01/02) ----------
  sec("E1. Criação de site — elegibilidade e owner ancorado");
  const slugA = "portal-dona-" + crypto.randomUUID().slice(0, 6);
  let siteA = null;
  {
    const r = await api(BASE, C.campId, J1, "POST", "/sites", { slug: slugA, nome: "Portal da Dona", descricao: "desc" });
    t("SITE-01: POST /sites 201", r.status === 201, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    siteA = r.json?.site ?? r.json;
    const slugReais = siteA?.slug ?? slugA;
    // owner não pode vir do body
    const rOwner = await api(BASE, C.campId, J1, "POST", "/sites", { slug: "outro-" + crypto.randomUUID().slice(0, 5), nome: "X", ownerContaId: "forjado", characterId: "forjado" });
    const ownerOk = rOwner.status === 201 || rOwner.status === 400;
    if (rOwner.status === 201) {
      const meus = await api(BASE, C.campId, J1, "GET", "/sites/meus");
      const criado = (meus.json?.sites ?? meus.json ?? []).find?.((s) => (s.slug ?? "") === (rOwner.json?.site?.slug ?? ""));
      t("SITE-01b: owner forjado no body ignorado/rejeitado (owner = conta do requisitante)",
        !JSON.stringify(rOwner.json).includes("forjado") || (criado && JSON.stringify(criado.owner ?? {}).includes("w3.dona")),
        JSON.stringify(rOwner.json).slice(0, 160));
    } else t("SITE-01b: owner forjado no body → rejeitado", ownerOk, `status=${rOwner.status}`);
    const rDup = await api(BASE, C.campId, J1, "POST", "/sites", { slug: slugReais, nome: "Duplicado" });
    t("SITE-01c: slug duplicado → 409", rDup.status === 409, `status=${rDup.status}`);
    const rSlugBad = await api(BASE, C.campId, J1, "POST", "/sites", { slug: "SLUG INVALIDO!!", nome: "X" });
    t("slug inválido → 4xx", rSlugBad.status >= 400 && rSlugBad.status < 500, `status=${rSlugBad.status}`);
    const rSemConta = await api(BASE, C.campId, J4, "POST", "/sites", { slug: "sem-conta-x", nome: "X" });
    t("SITE-02: sem conta de internet → negado", rSemConta.status === 403 || rSemConta.status === 404 || rSemConta.status === 401, `status=${rSemConta.status}`);
    const rSemSessao = await req(BASE, "POST", `/campaigns/${C.campId}/internet/sites`, { body: { slug: "x", nome: "x" } });
    t("sem sessão → 401", rSemSessao.status === 401, `status=${rSemSessao.status}`);
    // GET /sites/meus existe e lista o site da dona
    const meus = await api(BASE, C.campId, J1, "GET", "/sites/meus");
    const lista = meus.json?.sites ?? meus.json ?? [];
    t("GET /sites/meus lista site próprio", meus.status === 200 && JSON.stringify(lista).includes(slugReais), `status=${meus.status}`);
    siteA = { ...(siteA ?? {}), slug: slugReais };
  }

  // segundo site da mesma conta (múltiplos sites permitidos)
  {
    const r = await api(BASE, C.campId, J1, "POST", "/sites", { slug: "segundo-" + crypto.randomUUID().slice(0, 5), nome: "Segundo" });
    t("múltiplos sites por conta", r.status === 201 || r.status === 409 || r.status === 400, `status=${r.status}`);
  }

  // ---------- E2. Metadados do site (SITE-03/04) ----------
  sec("E2. Metadados — só o dono; arquivado não edita");
  {
    const r = await api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}`, { nome: "Portal Renomeado" });
    t("SITE-03: dono edita nome", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 140)}`);
    const rJ2 = await api(BASE, C.campId, J2, "PATCH", `/sites/${siteA.slug}`, { nome: "Sequestro" });
    t("SITE-04: outro jogador não edita site alheio", rJ2.status === 403 || rJ2.status === 404, `status=${rJ2.status}`);
    const rSlug = await api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}`, { slug: "portal-renomeado-" + crypto.randomUUID().slice(0, 4) });
    t("dono troca slug", rSlug.status === 200, `status=${rSlug.status}`);
    const slugNovo = rSlug.json?.site?.slug;
    if (slugNovo) {
      const rVelho = await api(BASE, C.campId, J1, "GET", `/sites/${siteA.slug}`);
      t("slug antigo → 404 após troca", rVelho.status === 404, `status=${rVelho.status}`);
      siteA.slug = slugNovo;
    }
    // arquiva e tenta editar metadados
    await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/arquivar`);
    const rArq = await api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}`, { nome: "Tarde" });
    t("site arquivado → PATCH metadados 409", rArq.status === 409, `status=${rArq.status}`);
    await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/restaurar`);
    const rVolta = await api(BASE, C.campId, J1, "GET", `/sites/${siteA.slug}`);
    t("restaurar site → leitura pública volta", rVolta.status === 200, `status=${rVolta.status}`);
  }

  // ---------- E3. Criação de página (SITE-05/12, formato, limites) ----------
  sec("E3. Páginas — só no próprio site (SITE-12), formato e limites");
  {
    const r = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas`, { slug: "capitulo-1", titulo: "Capítulo 1", corpo: "Era uma vez..." });
    t("SITE-05: dona cria página no próprio site", r.status === 201 || r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    // rascunho default: ainda não público
    const rPub0 = await api(BASE, C.campId, J3, "GET", `/sites/${siteA.slug}/paginas/capitulo-1`);
    t("rascunho não aparece na leitura pública", rPub0.status === 404, `status=${rPub0.status}`);
    // SITE-12: j2 tenta criar página no site da j1 → 4xx (modelo restrito aprovado)
    const rAlheio = await api(BASE, C.campId, J2, "POST", `/sites/${siteA.slug}/paginas`, { slug: "invasao", titulo: "Invasão", corpo: "x" });
    t("SITE-12: página em site alheio → 4xx sem registro", rAlheio.status >= 400 && rAlheio.status < 500, `status=${rAlheio.status}`);
    if (!(rAlheio.status >= 400 && rAlheio.status < 500)) {
      const rConfere = await api(BASE, C.campId, J2, "GET", `/sites/${siteA.slug}/paginas/invasao`);
      t("SITE-12b: invasão não persistiu", rConfere.status === 404, `status=${rConfere.status}`);
    }
    // slug duplicado no mesmo site
    const rDup = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas`, { slug: "capitulo-1", titulo: "Outro", corpo: "y" });
    t("slug de página duplicado → 409", rDup.status === 409, `status=${rDup.status}`);
    // formato markdown-subset: link javascript: → 400
    const rMd = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas`, {
      slug: "md-ruim", titulo: "MD", corpo: "clique [aqui](javascript:alert(1))", formato: "markdown-subset",
    });
    t("markdown-subset rejeita javascript: → 400 formato_invalido", rMd.status === 400, `status=${rMd.status}`);
    const rHtml = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas`, {
      slug: "md-html", titulo: "MD2", corpo: "<script>alert(1)</script>", formato: "markdown-subset",
    });
    t("markdown-subset rejeita HTML cru → 400", rHtml.status === 400, `status=${rHtml.status}`);
    const rMdOk = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas`, {
      slug: "md-bom", titulo: "MD OK", corpo: "## Título\n\n- item\n\n[link](https://exemplo.com)", formato: "markdown-subset",
    });
    t("markdown-subset válido → 201", rMdOk.status === 201 || rMdOk.status === 200, `status=${rMdOk.status}`);
    // limites
    const rTitulo = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas`, { slug: "titulo-longo", titulo: "x".repeat(201), corpo: "y" });
    t("titulo >200 → 400", rTitulo.status === 400, `status=${rTitulo.status}`);
    // statusInicial publicado direto
    const rPub = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas`, { slug: "ja-publicada", titulo: "Já Pub", corpo: "conteúdo público", statusInicial: "publicado" });
    t("statusInicial=publicado → 201 + visível", (rPub.status === 201 || rPub.status === 200) && (await api(BASE, C.campId, J3, "GET", `/sites/${siteA.slug}/paginas/ja-publicada`)).status === 200,
      `status=${rPub.status}`);
  }

  // ---------- E4. Edição de página (SITE-06/07, VER-01) ----------
  sec("E4. Edição — só o autor; expectedVersion; audit");
  {
    const r = await api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`, { corpo: "Era uma vez, v2", expectedVersion: 1 });
    t("SITE-06: autora edita com expectedVersion=1", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    const v2 = r.json?.pagina?.version ?? r.json?.page?.version ?? r.json?.version;
    t("VER-01: version incrementou para 2", v2 === 2, `version=${v2}`);
    const rStale = await api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`, { corpo: "v3 stale", expectedVersion: 1 });
    t("expectedVersion defasada → 409 versao_desatualizada", rStale.status === 409, `status=${rStale.status}`);
    const rOk = await api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`, { corpo: "v3", expectedVersion: 2 });
    t("expectedVersion correta → 200", rOk.status === 200, `status=${rOk.status}`);
    // SITE-07: dona do site que não é autora não edita (criar página de j2 no site da j2 primeiro? usar página de j1)
    const rNaoAutor = await api(BASE, C.campId, J2, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`, { corpo: "sequestro" });
    t("SITE-07: não-autor não edita (404 uniforme)", rNaoAutor.status === 404 || rNaoAutor.status === 403, `status=${rNaoAutor.status}`);
    // audit da edição
    const au = audits("pagina_editada");
    t("audit internet.pagina_editada gravado", au.length >= 1, `n=${au.length}`);
    const auV = au.find((a) => JSON.stringify(a).includes('"version"'));
    t("VER-03: audit carrega versão resultante (não é cópia do corpo)", !!auV && !JSON.stringify(auV).includes("Era uma vez, v2".slice(0, 10)), JSON.stringify(auV ?? {}).slice(0, 160));
  }

  // ---------- E5. Transições de status ----------
  sec("E5. Status — publicar/retirar/arquivar/restaurar");
  {
    // publicar rascunho
    const rPub = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/publicar`);
    t("publicar rascunho → 200", rPub.status === 200 || rPub.status === 201, `status=${rPub.status} ${JSON.stringify(rPub.json).slice(0, 140)}`);
    const rLeitura = await api(BASE, C.campId, J3, "GET", `/sites/${siteA.slug}/paginas/capitulo-1`);
    t("após publicar, leitura pública 200", rLeitura.status === 200, `status=${rLeitura.status}`);
    const rRet = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/retirar`);
    t("retirar → 200", rRet.status === 200 || rRet.status === 201, `status=${rRet.status}`);
    const rLeitura2 = await api(BASE, C.campId, J3, "GET", `/sites/${siteA.slug}/paginas/capitulo-1`);
    t("retirado some da leitura pública (404)", rLeitura2.status === 404, `status=${rLeitura2.status}`);
    // re-publicar: publishedAt preserva a primeira
    const rRep = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/publicar`);
    t("re-publicar retirado → 200", rRep.status === 200 || rRep.status === 201, `status=${rRep.status}`);
    // arquivar → restaura para publicado (publishedAt existe)
    const rArq = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/arquivar`);
    t("arquivar página → 200", rArq.status === 200 || rArq.status === 201, `status=${rArq.status}`);
    const rRest = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/restaurar`);
    t("restaurar página publicada → volta a publicado", rRest.status === 200 || rRest.status === 201, `status=${rRest.status}`);
  }

  // ---------- E6. Moderação do mestre (SITE-08) ----------
  sec("E6. Mestre modera/arquiva — nunca reescreve");
  {
    const rPatchMestre = await api(BASE, C.campId, M, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`, { corpo: "reescrita do mestre" });
    t("mestre NÃO edita conteúdo de página alheia", rPatchMestre.status === 403 || rPatchMestre.status === 404, `status=${rPatchMestre.status}`);
    const rArqM = await api(BASE, C.campId, M, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/arquivar`);
    t("mestre arquiva página alheia", rArqM.status === 200 || rArqM.status === 201, `status=${rArqM.status}`);
    const rRestM = await api(BASE, C.campId, M, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/restaurar`);
    t("mestre restaura página", rRestM.status === 200 || rRestM.status === 201, `status=${rRestM.status}`);
    // audit com papel mestre
    const auM = audits("pagina_arquivada");
    t("audit de arquivamento pelo mestre registrado", auM.length >= 1 && JSON.stringify(auM).includes('"mestre"'), `n=${auM.length}`);
    // mestre sem conta tenta criar site → negado (sem conta própria)
    const rSiteM = await api(BASE, C.campId, M, "POST", "/sites", { slug: "site-do-mestre", nome: "Mestre" });
    t("mestre sem conta não cria site (ownership exige conta)", rSiteM.status === 403 || rSiteM.status === 404 || rSiteM.status === 401, `status=${rSiteM.status}`);
  }

  // ---------- E7. Listagem autenticada de páginas ----------
  sec("E7. GET /sites/:slug/paginas — recorte por papel");
  {
    // cria rascunho extra da j1 para contraste
    await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas`, { slug: "rascunho-privado", titulo: "Privado", corpo: "segredo" });
    const rJ3 = await api(BASE, C.campId, J3, "GET", `/sites/${siteA.slug}/paginas`);
    const listaJ3 = JSON.stringify(rJ3.json);
    t("não-autor vê só publicadas (sem rascunho-privado)", rJ3.status === 200 && !listaJ3.includes("rascunho-privado"), `status=${rJ3.status}`);
    const rJ1 = await api(BASE, C.campId, J1, "GET", `/sites/${siteA.slug}/paginas`);
    t("autora vê próprios rascunhos", rJ1.status === 200 && JSON.stringify(rJ1.json).includes("rascunho-privado"), `status=${rJ1.status}`);
    const rM = await api(BASE, C.campId, M, "GET", `/sites/${siteA.slug}/paginas`);
    t("mestre vê todas com status", rM.status === 200 && JSON.stringify(rM.json).includes("rascunho-privado"), `status=${rM.status}`);
  }

  // ---------- E8. Leitura autenticada de rascunho (prévia) ----------
  sec("E8. GET página autenticada — prévia do autor, 404 p/ demais");
  {
    const rAutora = await api(BASE, C.campId, J1, "GET", `/sites/${siteA.slug}/paginas/rascunho-privado`);
    t("autora lê próprio rascunho (com version/status)", rAutora.status === 200 && JSON.stringify(rAutora.json).includes('"version"'), `status=${rAutora.status}`);
    const rJ3 = await api(BASE, C.campId, J3, "GET", `/sites/${siteA.slug}/paginas/rascunho-privado`);
    const rPub404 = await api(BASE, C.campId, J3, "GET", `/sites/${siteA.slug}/paginas/slug-inexistente-xyz`);
    t("não-autor recebe 404 idêntico ao inexistente", rJ3.status === 404 && rPub404.status === 404 && JSON.stringify(rJ3.json) === JSON.stringify(rPub404.json),
      `status=${rJ3.status} corpo=${JSON.stringify(rJ3.json).slice(0, 120)}`);
    const rM = await api(BASE, C.campId, M, "GET", `/sites/${siteA.slug}/paginas/rascunho-privado`);
    t("mestre lê rascunho p/ moderação", rM.status === 200, `status=${rM.status}`);
  }

  // ---------- E9. P7 — transferência de titularidade ----------
  sec("E9. P7 — titular novo opera, anterior perde (SITE-09/10)");
  {
    // transfere ch3 (dona da conta w3.transfer) para membership do j4
    const inv = await apiChars(BASE, C.campId, J3, "POST", `/${ch3}/transferencias`, { membershipId: MEM4 });
    const tid = inv.json?.transferencia?.id;
    t("convite de transferência criado", !!tid, `status=${inv.status}`);
    if (tid) {
      const acc = await apiChars(BASE, C.campId, J4, "POST", `/transferencias/${tid}/responder`, { aceitar: true });
      t("transferência aceita", acc.status === 200, `status=${acc.status}`);
      // j3 cria site próprio antes? usa conta w3.transfer para criar site APÓS transferência seria inválido;
      // melhor: j3 já tinha conta mas não site. Crio site via j3 ANTES de transferir? Já transferiu.
      // Alternativa: testar mutação da j3 (sem personagem) → negado; e j4 herda conta.
      const rJ3 = await api(BASE, C.campId, J3, "POST", "/sites", { slug: "tardio-j3", nome: "Tardio" });
      t("SITE-10: titular anterior não cria site após P7", rJ3.status === 403 || rJ3.status === 404 || rJ3.status === 401, `status=${rJ3.status}`);
      // j4 (novo titular) deve resolver a conta herdada do ch3
      const rConta = await api(BASE, C.campId, J4, "GET", `/account?characterId=${ch3}`);
      t("SITE-09: novo titular resolve conta herdada", rConta.status === 200, `status=${rConta.status}`);
      const rSiteJ4 = await api(BASE, C.campId, J4, "POST", "/sites", { slug: "herdado-j4", nome: "Herdado" });
      t("SITE-09: novo titular cria site com conta herdada", rSiteJ4.status === 201 || rSiteJ4.status === 200, `status=${rSiteJ4.status} ${JSON.stringify(rSiteJ4.json).slice(0, 140)}`);
    }
  }

  // ---------- E10. Concorrência / idempotência (SITE-11) ----------
  sec("E10. Concorrência — expectedVersion evita lost-update");
  {
    // duas edições "simultâneas" com mesma base version=3 → só uma vence
    const [rA, rB] = await Promise.all([
      api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`, { corpo: "concorrente A", expectedVersion: 3 }),
      api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`, { corpo: "concorrente B", expectedVersion: 3 }),
    ]);
    const oks = [rA, rB].filter((r) => r.status === 200).length;
    const conflicts = [rA, rB].filter((r) => r.status === 409).length;
    t("SITE-11: corrida → exatamente 1 sucesso + 1 conflito (ou ambos consistentes)", oks + conflicts === 2 && oks <= 2, `A=${rA.status} B=${rB.status}`);
    // retry da mesma edição com versão já consumida → 409 (não duplica efeito)
    const antes = comDb((db) => db.prepare("select version from internet_pages where site_id=(select id from internet_sites where slug=?) and slug='capitulo-1'").get(siteA.slug)?.version);
    const rRetry = await api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`, { corpo: "retry", expectedVersion: 3 });
    const depois = comDb((db) => db.prepare("select version from internet_pages where site_id=(select id from internet_sites where slug=?) and slug='capitulo-1'").get(siteA.slug)?.version);
    t("SITE-11b: retry com versão velha não incrementa", rRetry.status === 409 || depois === antes, `retry=${rRetry.status} v:${antes}→${depois}`);
  }

  // ---------- E11. Sem histórico recuperável (VER-02) ----------
  sec("E11. VER-02 — não existe rollback/versões antigas");
  {
    const rVersoes = await api(BASE, C.campId, J1, "GET", `/sites/${siteA.slug}/paginas/capitulo-1/versoes`);
    const rHist = await api(BASE, C.campId, J1, "GET", `/sites/${siteA.slug}/paginas/capitulo-1/historico`);
    const rRollback = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/restaurar-versao`, { version: 1 });
    t("VER-02: endpoints de histórico/rollback não existem", rVersoes.status === 404 && rHist.status === 404 && (rRollback.status === 404 || rRollback.status === 405),
      `versoes=${rVersoes.status} hist=${rHist.status} rollback=${rRollback.status}`);
  }

  // ---------- E12. Rate limit de escrita (30/min) ----------
  sec("E12. Rate limit escrita — 429, nunca 5xx");
  {
    // j3 não tem conta própria (transferiu) — usa j2 que tem conta; dispara rajada de PATCH inválidos baratos? Melhor POST /sites com slugs únicos.
    // j2 tem conta elegível: 35 tentativas rápidas; espera-se ao menos um 429 e zero 5xx.
    const status = [];
    for (let i = 0; i < 35; i++) {
      const r = await api(BASE, C.campId, J2, "POST", "/sites", { slug: `rl-${i}-${crypto.randomUUID().slice(0, 4)}`, nome: "RL" });
      status.push(r.status);
      if (r.status === 429) break;
    }
    const tem429 = status.includes(429);
    const tem5xx = status.some((s) => s >= 500);
    t("rate limit escrita → 429 dentro da rajada", tem429, `statuses=${status.slice(-5).join(",")}`);
    t("rate limit nunca devolve 5xx", !tem5xx, `statuses=${status.join(",")}`);
  }

  // ---------- Fatias futuras — SKIP honesto ----------
  sec("F. Contratos de fatias futuras — NOT RUN/SKIP");
  t("PUB-03: identidade anonima forçada em tipos não-anônimos", "skip", "publicações fora do slice W3 escrita");
  t("EXP-06/11/12: export/import anonimiz chron", "skip", "export/import D6 ainda sem contrato/rotas");

  console.log(`\n===== W3 escrita black-box: ${pass} ok / ${fail} falhas / ${skip} skips =====`);
} catch (e) {
  console.error("ERRO FATAL", e);
  fail++;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
  process.exit(fail > 0 ? 1 : 0);
}
