#!/usr/bin/env node
// FILHO — suíte black-box W3 escrita/ownership (#365), conforme contrato
// W3-write e matriz integrada SITE-01..14 / VER-01..06.
//
// Decisões fechadas: SITE-12 = criação de página somente no site próprio;
// sem colaboração/convite nesta versão. P5 é revalidado em cada mutação
// diegética de personagem (inclui rascunhos, edições e transições).
// Mestre administrativo, sem conta de personagem, pode somente arquivar/
// restaurar via membership ativa; nunca cria ou reescreve conteúdo.
//
// Cobertura: ownership/autoria, gate por operação, transfer P7, version +
// expectedVersion em conteúdo e transições, auditoria atômica (falha do
// insert deve reverter a mutação), ausência de snapshots/rollback,
// moderação restrita, concorrência/retry, validação e rate limit.
// PUB-03 / EXP-06/11/12 seguem SKIP por pertencerem a fatias posteriores.
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
const snapshotPagina = (siteSlug, pageSlug) => comDb((db) =>
  db.prepare("select p.corpo,p.version,p.status from internet_pages p join internet_sites s on s.id=p.site_id where s.slug=? and p.slug=?")
    .get(siteSlug, pageSlug));
const versionPagina = (siteSlug, pageSlug) => snapshotPagina(siteSlug, pageSlug)?.version;

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
    const rNaoAutor = await api(BASE, C.campId, J2, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`, { corpo: "sequestro", expectedVersion: versionPagina(siteA.slug, "capitulo-1") });
    t("SITE-07: não-autor não edita (404 uniforme)", rNaoAutor.status === 404 || rNaoAutor.status === 403, `status=${rNaoAutor.status}`);
    // auditoria registra metadados, nunca o corpo anterior/atual.
    const au = audits("pagina_editada");
    t("audit internet.pagina_editada gravado", au.length >= 1, `n=${au.length}`);
    const auV = au.find((a) => JSON.stringify(a).includes('"version"'));
    t("VER-03: audit carrega versão resultante (não é cópia do corpo)", !!auV && !JSON.stringify(auV).includes("Era uma vez, v2".slice(0, 10)), JSON.stringify(auV ?? {}).slice(0, 160));

    // VER-05: falha forçada do INSERT de auditoria deve reverter a página.
    const antes = snapshotPagina(siteA.slug, "capitulo-1");
    comDb((db) => db.exec(`
      CREATE TRIGGER teste_falha_audit_w3
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'internet.pagina_editada'
      BEGIN SELECT RAISE(ABORT, 'falha de auditoria simulada'); END;
    `));
    let rFalhaAudit;
    try {
      rFalhaAudit = await api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`,
        { corpo: "NAO PERSISTIR - audit falhou", expectedVersion: antes.version });
    } finally {
      comDb((db) => db.exec("DROP TRIGGER IF EXISTS teste_falha_audit_w3"));
    }
    const depois = snapshotPagina(siteA.slug, "capitulo-1");
    t("VER-05: falha de audit devolve erro", rFalhaAudit && rFalhaAudit.status >= 400, `status=${rFalhaAudit?.status}`);
    t("VER-05: falha de audit reverte corpo, status e versão",
      depois?.corpo === antes?.corpo && depois?.status === antes?.status && depois?.version === antes?.version,
      `antes=${JSON.stringify(antes)} depois=${JSON.stringify(depois)}`);
  }

  // ---------- E5. Transições de status ----------
  sec("E5. Status — expectedVersion, version+1 e audit atômica");
  {
    const transicao = async (rota, rotulo) => {
      const antes = versionPagina(siteA.slug, "capitulo-1");
      const r = await api(BASE, C.campId, J1, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/${rota}`,
        { expectedVersion: antes });
      const depois = versionPagina(siteA.slug, "capitulo-1");
      t(`${rotulo}: transição incrementa version uma vez`,
        (r.status === 200 || r.status === 201) && depois === antes + 1,
        `status=${r.status} version=${antes}→${depois}`);
      return r;
    };

    // expectedVersion stale em transição também deve conflitar.
    const versaoInicial = versionPagina(siteA.slug, "capitulo-1");
    const rStale = await api(BASE, C.campId, J1, "POST",
      `/sites/${siteA.slug}/paginas/capitulo-1/publicar`,
      { expectedVersion: versaoInicial - 1 });
    t("VER-04: transição com expectedVersion antiga → 409", rStale.status === 409,
      `status=${rStale.status}`);

    await transicao("publicar", "publicar rascunho");
    const rLeitura = await api(BASE, C.campId, J3, "GET", `/sites/${siteA.slug}/paginas/capitulo-1`);
    t("após publicar, leitura pública 200", rLeitura.status === 200, `status=${rLeitura.status}`);

    await transicao("retirar", "retirar página");
    const rLeitura2 = await api(BASE, C.campId, J3, "GET", `/sites/${siteA.slug}/paginas/capitulo-1`);
    t("retirado some da leitura pública (404)", rLeitura2.status === 404, `status=${rLeitura2.status}`);

    await transicao("publicar", "re-publicar retirado");
    await transicao("arquivar", "arquivar página");
    await transicao("restaurar", "restaurar página publicada");

    const audStatus = audits("pagina_status");
    const audArchive = audits("pagina_arquivada");
    const audRestore = audits("pagina_restaurada");
    t("VER-06: cada tipo de transição deixou trilha", audStatus.length >= 3 && audArchive.length >= 1 && audRestore.length >= 1,
      `status=${audStatus.length} archive=${audArchive.length} restore=${audRestore.length}`);
  }

  // ---------- E6. Moderação do mestre (SITE-08) ----------
  sec("E6. Mestre modera/arquiva — nunca reescreve");
  {
    const vMestre = versionPagina(siteA.slug, "capitulo-1");
    const rPatchMestre = await api(BASE, C.campId, M, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`,
      { corpo: "reescrita do mestre", expectedVersion: vMestre });
    t("mestre NÃO edita conteúdo de página alheia", rPatchMestre.status === 403 || rPatchMestre.status === 404, `status=${rPatchMestre.status}`);
    const rArqM = await api(BASE, C.campId, M, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/arquivar`,
      { expectedVersion: vMestre });
    t("SITE-08/SITE-14: Mestre sem conta arquiva por papel administrativo",
      rArqM.status === 200 || rArqM.status === 201, `status=${rArqM.status}`);
    const vMestreRest = versionPagina(siteA.slug, "capitulo-1");
    const rRestM = await api(BASE, C.campId, M, "POST", `/sites/${siteA.slug}/paginas/capitulo-1/restaurar`,
      { expectedVersion: vMestreRest });
    t("SITE-14: Mestre sem conta restaura por papel administrativo",
      rRestM.status === 200 || rRestM.status === 201, `status=${rRestM.status}`);
    // audit com papel mestre
    const auM = audits("pagina_arquivada");
    t("audit de arquivamento pelo mestre registrado", auM.length >= 1 && JSON.stringify(auM).includes('"mestre"'), `n=${auM.length}`);
    // mestre sem conta tenta criar site → negado (sem conta própria)
    const rSiteM = await api(BASE, C.campId, M, "POST", "/sites", { slug: "site-do-mestre", nome: "Mestre" });
    t("SITE-14: Mestre sem conta não cria site", rSiteM.status === 403 || rSiteM.status === 404 || rSiteM.status === 401, `status=${rSiteM.status}`);
    const rMetaM = await api(BASE, C.campId, M, "PATCH", `/sites/${siteA.slug}`, { nome: "metadado reescrito pelo Mestre" });
    t("SITE-14: Mestre sem conta não altera metadados do titular", rMetaM.status === 403 || rMetaM.status === 404 || rMetaM.status === 401, `status=${rMetaM.status}`);
    const rPaginaM = await api(BASE, C.campId, M, "POST", `/sites/${siteA.slug}/paginas`, { slug: "pagina-do-mestre", titulo: "Não", corpo: "não" });
    t("SITE-14: Mestre sem conta não cria página por privilégio administrativo", rPaginaM.status === 403 || rPaginaM.status === 404 || rPaginaM.status === 401, `status=${rPaginaM.status}`);
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

  // ---------- E9b. Gate P5 revalidado em toda escrita de personagem (SITE-13) ----------
  sec("E9b. P5 — revogação do dispositivo bloqueia toda mutação diegética");
  {
    const slugJ4 = "herdado-j4";
    const slugRestore = "p5-restaura-site-" + crypto.randomUUID().slice(0, 5);

    // Pré-condições: titular novo herdou conta/personagem e ainda tem gate.
    const siteAntes = await api(BASE, C.campId, J4, "GET", `/sites/${slugJ4}`);
    t("SITE-13 setup: titular novo lê o próprio site", siteAntes.status === 200, `status=${siteAntes.status}`);

    const rRascunho = await api(BASE, C.campId, J4, "POST", `/sites/${slugJ4}/paginas`,
      { slug: "p5-rascunho", titulo: "Rascunho gate", corpo: "privado" });
    const rPublicada = await api(BASE, C.campId, J4, "POST", `/sites/${slugJ4}/paginas`,
      { slug: "p5-publicada", titulo: "Publicada gate", corpo: "publico", statusInicial: "publicado" });
    const rRetirada = await api(BASE, C.campId, J4, "POST", `/sites/${slugJ4}/paginas`,
      { slug: "p5-retirada", titulo: "Retirada gate", corpo: "publico", statusInicial: "publicado" });
    const rArquivada = await api(BASE, C.campId, J4, "POST", `/sites/${slugJ4}/paginas`,
      { slug: "p5-arquivada", titulo: "Arquivada gate", corpo: "privado" });
    const paginasPreparadas = [rRascunho, rPublicada, rRetirada, rArquivada]
      .every((r) => r.status === 201 || r.status === 200);
    t("SITE-13 setup: páginas draft/publicadas criadas antes de revogar gate", paginasPreparadas,
      [rRascunho.status, rPublicada.status, rRetirada.status, rArquivada.status].join(","));

    if (paginasPreparadas) {
      const archVer = versionPagina(slugJ4, "p5-arquivada");
      const arquivarPreparacao = await api(BASE, C.campId, J4, "POST",
        `/sites/${slugJ4}/paginas/p5-arquivada/arquivar`, { expectedVersion: archVer });
      t("SITE-13 setup: página de teste ficou arquivada",
        arquivarPreparacao.status === 200 || arquivarPreparacao.status === 201,
        `status=${arquivarPreparacao.status}`);
    }

    const rSiteRestore = await api(BASE, C.campId, J4, "POST", "/sites",
      { slug: slugRestore, nome: "Site para teste de gate de restauração" });
    const slugRestoreCriado = rSiteRestore.json?.site?.slug ?? slugRestore;
    const rSiteArchive = await api(BASE, C.campId, J4, "POST", `/sites/${slugRestoreCriado}/arquivar`);
    t("SITE-13 setup: site de teste arquivado antes de revogar gate",
      (rSiteRestore.status === 201 || rSiteRestore.status === 200) &&
      (rSiteArchive.status === 200 || rSiteArchive.status === 201),
      `create=${rSiteRestore.status} archive=${rSiteArchive.status}`);

    // O personagem perde o dispositivo: gateInternetDoPersonagem deve falhar
    // mesmo com conta ativa, ficha/requisitos e ownership preservados.
    comDb((db) => db.prepare("delete from inventory_entries where character_id=?").run(ch3));

    const tentativas = [
      ["metadados do site", () => api(BASE, C.campId, J4, "PATCH", `/sites/${slugJ4}`, { nome: "não pode editar" })],
      ["criação de rascunho", () => api(BASE, C.campId, J4, "POST", `/sites/${slugJ4}/paginas`,
        { slug: "p5-negado-criacao", titulo: "Não", corpo: "não" })],
      ["edição de página", () => api(BASE, C.campId, J4, "PATCH", `/sites/${slugJ4}/paginas/p5-publicada`,
        { corpo: "não pode editar", expectedVersion: 1 })],
      ["publicação de rascunho", () => api(BASE, C.campId, J4, "POST", `/sites/${slugJ4}/paginas/p5-rascunho/publicar`,
        { expectedVersion: 1 })],
      ["retirada de página", () => api(BASE, C.campId, J4, "POST", `/sites/${slugJ4}/paginas/p5-retirada/retirar`,
        { expectedVersion: 1 })],
      ["arquivamento por autor", () => api(BASE, C.campId, J4, "POST", `/sites/${slugJ4}/paginas/p5-publicada/arquivar`,
        { expectedVersion: 1 })],
      ["restauração de página", () => api(BASE, C.campId, J4, "POST", `/sites/${slugJ4}/paginas/p5-arquivada/restaurar`,
        { expectedVersion: 2 })],
      ["restauração de site", () => api(BASE, C.campId, J4, "POST", `/sites/${slugRestoreCriado}/restaurar`)],
    ];
    const negados = [];
    for (const [nome, executar] of tentativas) {
      const r = await executar();
      negados.push(r.status === 403);
      t(`SITE-13: gate revogado bloqueia ${nome}`, r.status === 403, `status=${r.status}`);
    }

    // Nenhuma tentativa negada pode ter alterado conteúdo, estado ou versão.
    const pgPub = snapshotPagina(slugJ4, "p5-publicada");
    const pgRasc = snapshotPagina(slugJ4, "p5-rascunho");
    const pgRet = snapshotPagina(slugJ4, "p5-retirada");
    const pgArq = snapshotPagina(slugJ4, "p5-arquivada");
    const siteRestoreStatus = comDb((db) => db.prepare("select status from internet_sites where slug=?").get(slugRestoreCriado)?.status);
    const siteJ4Nome = comDb((db) => db.prepare("select nome from internet_sites where slug=?").get(slugJ4)?.nome);
    t("SITE-13: recusas não alteram conteúdo/status/version",
      negados.every(Boolean) &&
      pgPub?.corpo === "publico" && pgPub?.status === "publicado" && pgPub?.version === 1 &&
      pgRasc?.status === "rascunho" && pgRasc?.version === 1 &&
      pgRet?.status === "publicado" && pgRet?.version === 1 &&
      pgArq?.status === "arquivado" && pgArq?.version === 2 &&
      siteRestoreStatus === "arquivado" && siteJ4Nome === "Herdado",
      `pub=${JSON.stringify(pgPub)} draft=${JSON.stringify(pgRasc)} withdraw=${JSON.stringify(pgRet)} archive=${JSON.stringify(pgArq)} site=${siteRestoreStatus}/${siteJ4Nome}`);

    // Devolver o dispositivo recupera o gate sem trocar conta/autor.
    darNotebook(ch3);
    const rSiteRestaurado = await api(BASE, C.campId, J4, "POST",
      `/sites/${slugRestoreCriado}/restaurar`);
    t("SITE-13: após recuperar dispositivo, titular volta a restaurar site",
      rSiteRestaurado.status === 200 || rSiteRestaurado.status === 201,
      `status=${rSiteRestaurado.status}`);
    const vArq = versionPagina(slugJ4, "p5-arquivada");
    const rPaginaRestaurada = await api(BASE, C.campId, J4, "POST",
      `/sites/${slugJ4}/paginas/p5-arquivada/restaurar`, { expectedVersion: vArq });
    t("SITE-13: após recuperar dispositivo, autor volta a restaurar página",
      rPaginaRestaurada.status === 200 || rPaginaRestaurada.status === 201,
      `status=${rPaginaRestaurada.status}`);
  }

  // ---------- E10. Concorrência / idempotência (SITE-11) ----------
  sec("E10. Concorrência — expectedVersion evita lost-update");
  {
    const baseVersion = versionPagina(siteA.slug, "capitulo-1");
    const [rA, rB] = await Promise.all([
      api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`,
        { corpo: "concorrente A", expectedVersion: baseVersion }),
      api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`,
        { corpo: "concorrente B", expectedVersion: baseVersion }),
    ]);
    const oks = [rA, rB].filter((r) => r.status === 200).length;
    const conflicts = [rA, rB].filter((r) => r.status === 409).length;
    t("SITE-11: corrida → exatamente 1 sucesso + 1 conflito",
      oks === 1 && conflicts === 1, `A=${rA.status} B=${rB.status}`);
    const antesRetry = versionPagina(siteA.slug, "capitulo-1");
    const rRetry = await api(BASE, C.campId, J1, "PATCH", `/sites/${siteA.slug}/paginas/capitulo-1`,
      { corpo: "retry", expectedVersion: baseVersion });
    const depoisRetry = versionPagina(siteA.slug, "capitulo-1");
    t("SITE-11b: retry com versão consumida não incrementa",
      rRetry.status === 409 && depoisRetry === antesRetry,
      `retry=${rRetry.status} v:${antesRetry}→${depoisRetry}`);
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
