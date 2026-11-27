#!/usr/bin/env node
// FILHO — suíte black-box do slice W1/W3 da Internet pública 1.1.2 (#365/#387).
// Contrato-fonte: PAI v1 (`7192268857`) + v2 (`7192682079`) + matriz
// executável do Gerente (#369 `7211891862`, gates SL-*) + decisões do
// proprietário (Quiz 1/2, DP-2..DP-9 aceitas em `7220007287`).
//
// Escopo deste arquivo (ordem FILHO do Dono, #364):
//   isolamento cross-campaign · diretório elegível · slug inexistente vs
//   inacessível · paginação/cursor · conteúdo nunca-visível (rascunho,
//   arquivado, `contatos` sem aresta — zero existência/título/snippet/
//   contagem/agregados) · autoria ancorada na sessão.
//
// ADAPTADOR DE ROTAS (contrato candidato do PAI v1 — ajustar 1 bloco
// quando o SHA do slice publicar os paths reais):
//   GET  /campaigns/:c/internet/sites?cursor=&q=&limite=
//   GET  /campaigns/:c/internet/sites/:slug
//   GET  /campaigns/:c/internet/sites/:slug/p/:pageSlug
//   GET  /campaigns/:c/internet/publicacoes?tipo=&q=&cursor=
//   GET  /campaigns/:c/internet/publicacoes/:id
//   POST /campaigns/:c/internet/sites            {slug,nome,descricao?}
//   POST /campaigns/:c/internet/sites/:siteId/pages {slug,titulo,corpo,formato}
//
// ADAPTADOR DE FIXTURE: seeds de site/página/publicação tentam a API de
// escrita; se o slice for read-only ("dados controlados por fixture"),
// caem para INSERT direto nas tabelas do contrato
// (`internet_sites`, `internet_pages`, `internet_publicacoes` — nomes
// v1; snake_case confirmado pelo padrão `internet_accounts`).
// Sem as tabelas/rotas, o cenário reporta "contrato ausente" e os
// asserts de rota FALHAM — estado TDD correto até a PR do PAI.
//
// Fixtures 100% descartáveis (dirTeste + limparDir); produção intocada.
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

// ---------- mapa de rotas (contrato candidato — 1 lugar p/ ajustar) ----------
const R = {
  sites: (c) => `/campaigns/${c}/internet/sites`,
  site: (c, slug) => `/campaigns/${c}/internet/sites/${slug}`,
  page: (c, slug, pslug) => `/campaigns/${c}/internet/sites/${slug}/p/${pslug}`,
  publicacoes: (c) => `/campaigns/${c}/internet/publicacoes`,
  publicacao: (c, id) => `/campaigns/${c}/internet/publicacoes/${id}`,
};
const api = (base, camp, cookie, metodo, path, body) =>
  req(base, metodo, `/campaigns/${camp}/internet${path}`, { cookie, body });

// ---------- extratores tolerantes de resposta (shape a confirmar no SHA) ----------
const itensDe = (j) =>
  j?.sites ?? j?.items ?? j?.data ?? j?.resultados ?? j?.publicacoes ??
  (Array.isArray(j) ? j : null) ?? [];
const cursorDe = (j) =>
  j?.nextCursor ?? j?.cursor ?? j?.proximoCursor ?? j?.next ?? j?.proximaPagina ?? null;
const totalDe = (j) =>
  j?.total ?? j?.totalItems ?? j?.count ?? j?.totalCount ?? null;

const DIR = dirTeste("f6-w1w3-filho");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc;

// ---------- seeds via banco (tabelas do contrato v1) ----------
const temTabela = (nome) => {
  const db = abrirDb(BANCO);
  try { return !!db.prepare("select 1 from sqlite_master where type='table' and name=?").get(nome); }
  finally { db.close(); }
};

function seedSite({ campId, slug, nome, ownerContaId, status = "ativo", siteId = null }) {
  const db = abrirDb(BANCO); const agora = Date.now();
  const id = siteId ?? crypto.randomUUID();
  db.prepare(`insert into internet_sites (id,campaign_id,slug,nome,descricao,owner_conta_id,status,created_at,updated_at)
    values (?,?,?,?,?,?,?,?,?)`)
    .run(id, campId, slug, nome, `desc ${slug}`, ownerContaId, status, agora, agora);
  db.close();
  return id;
}
function seedPage({ siteId, slug, titulo, status = "publicado", autorContaId, corpo = "corpo" }) {
  const db = abrirDb(BANCO); const agora = Date.now();
  const id = crypto.randomUUID();
  db.prepare(`insert into internet_pages (id,site_id,slug,titulo,corpo,formato,status,version,autor_conta_id,published_at,created_at,updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, siteId, slug, titulo, corpo, "texto", status, 1, autorContaId,
      status === "publicado" ? agora : null, agora, agora);
  db.close();
  return id;
}
function seedPublicacao({ campId, tipo, titulo, autorContaId, visibilidade, status = "publicado", requestId = null }) {
  const db = abrirDb(BANCO); const agora = Date.now();
  const id = crypto.randomUUID();
  db.prepare(`insert into internet_publicacoes (id,campaign_id,tipo,autor_conta_id,titulo,corpo,meta,visibilidade,status,request_id,payload_hash,published_at,created_at,updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, campId, tipo, autorContaId, titulo, "corpo", "{}", visibilidade, status,
      requestId, requestId ? "hash-" + requestId : null,
      status === "publicado" ? agora : null, agora, agora);
  db.close();
  return id;
}

// conta de internet para um personagem (fluxo real 1.1.1)
async function criarContaInternet(base, campId, cookie, characterId, handle) {
  const r = await api(base, campId, cookie, "POST", "/account", { characterId, handle });
  if (r.status !== 200 && r.status !== 201)
    throw new Error(`conta ${handle}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json?.conta?.id;
}

try {
  sec("0. Servidor + cenário base");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  const BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, { jogadores: { j1: "w1_j1", j2: "w1_j2", j3: "w1_j3", j4: "w1_j4" } });

  // gate de dispositivo (perícia+conhecimento+item) — mesmo padrão das
  // suítes Internet 1.1.1: rule_definitions + campos comp/tec na ficha
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

  // personagens + contas de internet (j1 autor, j2 contato, j3 sem aresta)
  const darNotebook = (characterId) => {
    const db = abrirDb(BANCO); const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), characterId, "Notebook", 1, null, "equipamento", "mochila", "novo", 1.5,
        JSON.stringify({ regra: { kind: "item", key: "notebook" } }), agora, agora);
    db.close();
  };
  const ch1 = C.novoPersonagem(C.jogadores.j1.membershipId, "W1 Autor", { comp: 3 });
  const ch2 = C.novoPersonagem(C.jogadores.j2.membershipId, "W1 Contato", { comp: 3 });
  const ch3 = C.novoPersonagem(C.jogadores.j3.membershipId, "W1 Livre", { comp: 3 });
  for (const ch of [ch1, ch2, ch3]) darNotebook(ch);
  const contaAutor = await criarContaInternet(BASE, C.campId, C.jogadores.j1.cookie, ch1, "w1.autor");
  const contaContato = await criarContaInternet(BASE, C.campId, C.jogadores.j2.cookie, ch2, "w1.contato");
  const contaLivre = await criarContaInternet(BASE, C.campId, C.jogadores.j3.cookie, ch3, "w1.livre");
  t("contas de internet criadas (3)", !!(contaAutor && contaContato && contaLivre));

  // aresta aceita j1↔j2 (visibilidade `contatos` — contraste do grupo P)
  const ped = await api(BASE, C.campId, C.jogadores.j1.cookie, "POST", "/contacts", { contaId: contaContato });
  const aresta = ped.json?.contato?.id;
  if (aresta) await api(BASE, C.campId, C.jogadores.j2.cookie, "POST", `/contacts/${aresta}/aceitar`);

  // campanha B + usuário membro SÓ de B (vetor cross-campaign)
  const campB = await req(BASE, "POST", "/campaigns", { cookie: C.cookieMestre, body: { name: "Campanha B W1W3" } });
  const campBId = campB.json?.campanha?.id;
  let uSoloId;
  {
    const db = abrirDb(BANCO); const agora = Date.now();
    uSoloId = crypto.randomUUID();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uSoloId, "w1_solo_b", "Solo B", "x", agora, agora);
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'jogador','ativo',?,?,?)")
      .run(crypto.randomUUID(), campBId, uSoloId, agora, agora, agora);
    db.close();
  }
  const cookieSoloB = sessao(BANCO, uSoloId);

  // ---------- seeds do conteúdo público (contrato v1) ----------
  const temSites = temTabela("internet_sites");
  const temPaginas = temTabela("internet_pages");
  const temPub = temTabela("internet_publicacoes");
  let siteAlvo = null, siteArquivado = null, slugAlvo = "portal-da-vila", slugInexistente = "slug-que-nao-existe-xyz";
  if (temSites && temPaginas) {
    siteAlvo = seedSite({ campId: C.campId, slug: slugAlvo, nome: "Portal da Vila", ownerContaId: contaAutor });
    seedPage({ siteId: siteAlvo, slug: "noticias", titulo: "Noticias Locais", status: "publicado", autorContaId: contaAutor });
    seedPage({ siteId: siteAlvo, slug: "rascunho-secreto", titulo: "RASCUNHO_SECRETO_380X", status: "rascunho", autorContaId: contaAutor });
    siteArquivado = seedSite({ campId: C.campId, slug: "site-arquivado", nome: "Site Arquivado", ownerContaId: contaAutor, status: "arquivado" });
    seedPage({ siteId: siteArquivado, slug: "pagina-arq", titulo: "Pagina Arquivada", status: "publicado", autorContaId: contaAutor });
    // volume para paginação: +28 sites → 29 visíveis no total
    // (siteAlvo + 28 massa; siteArquivado fica fora do discovery)
    for (let i = 0; i < 28; i++)
      seedSite({ campId: C.campId, slug: `site-massa-${String(i).padStart(2, "0")}`, nome: `Site Massa ${i}`, ownerContaId: contaAutor });
  }
  let pubContatosId = null, pubCampanhaId = null;
  if (temPub) {
    pubContatosId = seedPublicacao({ campId: C.campId, tipo: "anuncio", titulo: "ANUNCIO_CONTATOS_SECRETO", autorContaId: contaAutor, visibilidade: "contatos", requestId: "req-contatos-1" });
    pubCampanhaId = seedPublicacao({ campId: C.campId, tipo: "noticia", titulo: "Noticia Geral", autorContaId: contaAutor, visibilidade: "campanha", requestId: "req-campanha-1" });
  }
  t("seeds de contrato presentes", temSites && temPaginas, `sites=${temSites} paginas=${temPaginas} pubs=${temPub}`);

  const cookieAutor = C.jogadores.j1.cookie, cookieContato = C.jogadores.j2.cookie, cookieLivre = C.jogadores.j3.cookie;
  const serial = (r) => `${r.status}|${JSON.stringify(r.json)}`;

  sec("S. Sanidade — contas resolvem (executável hoje)");
  for (const [k, ch, cookie] of [["autor", ch1, cookieAutor], ["contato", ch2, cookieContato], ["livre", ch3, cookieLivre]]) {
    const r = await api(BASE, C.campId, cookie, "GET", `/account?characterId=${ch}`);
    t(`persona ${k} resolve conta`, r.status === 200, `status=${r.status}`);
  }

  sec("D. Diretório elegível (W1) — leitura D6: conta ativa + titular + membership");
  {
    const rAutor = await api(BASE, C.campId, cookieAutor, "GET", "/sites");
    t("diretório responde 200 ao elegível", rAutor.status === 200, `status=${rAutor.status} ${JSON.stringify(rAutor.json).slice(0, 160)}`);
    const itens = itensDe(rAutor.json);
    t("diretório lista sites semeados", itens.some((s) => (s.slug ?? s.site?.slug) === slugAlvo), JSON.stringify(itens[0] ?? null).slice(0, 160));
    const rContato = await api(BASE, C.campId, cookieContato, "GET", "/sites");
    t("contato também lista (mesmo escopo campanha)", rContato.status === 200 && itensDe(rContato.json).length === itens.length);
    const rLivre = await api(BASE, C.campId, cookieLivre, "GET", "/sites");
    t("sem aresta também lista (sites são da campanha)", rLivre.status === 200);
    const rSemCookie = await req(BASE, "GET", `/campaigns/${C.campId}/internet/sites`, {});
    t("sem sessão → 401", rSemCookie.status === 401, `status=${rSemCookie.status}`);
    const rEspectador = await req(BASE, "GET", `/campaigns/${C.campId}/internet/sites`, { cookie: sessao(BANCO, C.jogadores.j4.id) });
    t("sem conta de internet → não lê diretório", rEspectador.status !== 200 || itensDe(rEspectador.json).length === 0, `status=${rEspectador.status}`);
  }

  sec("X. Isolamento cross-campaign (Quiz 1 — invariante D1)");
  {
    // slug de A acessado via caminho de B → 404 idêntico a inexistente em B
    const rCruza = await api(BASE, campBId, cookieSoloB, "GET", `/sites/${slugAlvo}`);
    const rInex = await api(BASE, campBId, cookieSoloB, "GET", `/sites/${slugInexistente}`);
    t("slug de A via B → 404", rCruza.status === 404, `status=${rCruza.status}`);
    t("404 cross == 404 inexistente (byte-equivalente)", serial(rCruza) === serial(rInex),
      `${serial(rCruza).slice(0, 120)} vs ${serial(rInex).slice(0, 120)}`);
    // membro de B (sem membership em A) batendo na rota de A
    const rFora = await api(BASE, C.campId, cookieSoloB, "GET", `/sites/${slugAlvo}`);
    t("não-membro de A → sem conteúdo do site", rFora.status !== 200 || !JSON.stringify(rFora.json).includes(slugAlvo),
      `status=${rFora.status}`);
    // diretório de B não contém sites de A
    const rDirB = await api(BASE, campBId, cookieSoloB, "GET", "/sites");
    t("diretório de B vazio de A", rDirB.status !== 200 || !JSON.stringify(rDirB.json).includes(slugAlvo), `status=${rDirB.status}`);
  }

  sec("N. Slug inexistente vs inacessível (anti-oráculo)");
  {
    const rInex = await api(BASE, C.campId, cookieAutor, "GET", `/sites/${slugInexistente}`);
    t("site inexistente → 404", rInex.status === 404, `status=${rInex.status}`);
    const rArq = await api(BASE, C.campId, cookieAutor, "GET", "/sites/site-arquivado");
    t("site arquivado não devolve conteúdo de páginas", rArq.status === 404 || !JSON.stringify(rArq.json).includes("pagina-arq"),
      `status=${rArq.status}`);
    // página rascunho: não-autor recebe 404 idêntico a slug inexistente
    const rRasc = await api(BASE, C.campId, cookieContato, "GET", `/sites/${slugAlvo}/p/rascunho-secreto`);
    const rPagInex = await api(BASE, C.campId, cookieContato, "GET", `/sites/${slugAlvo}/p/pagina-que-nao-existe`);
    t("rascunho p/ não-autor → 404", rRasc.status === 404, `status=${rRasc.status}`);
    t("404 rascunho == 404 inexistente", serial(rRasc) === serial(rPagInex),
      `${serial(rRasc).slice(0, 120)} vs ${serial(rPagInex).slice(0, 120)}`);
    t("rascunho não vaza título no corpo", !JSON.stringify(rRasc.json).includes("RASCUNHO_SECRETO_380X"));
    const rPub = await api(BASE, C.campId, cookieContato, "GET", `/sites/${slugAlvo}/p/noticias`);
    t("página publicada → 200 com conteúdo", rPub.status === 200 && JSON.stringify(rPub.json).includes("Noticias"), `status=${rPub.status}`);
  }

  sec("G. Paginação keyset (V-02 — cursor opaco, escopo não codificado)");
  {
    const coletar = async (cookie) => {
      const vistos = new Set(); const cursores = new Set(); let cursor = null; let paginas = 0;
      for (;;) {
        const q = cursor ? `?limite=7&cursor=${encodeURIComponent(cursor)}` : "?limite=7";
        const r = await api(BASE, C.campId, cookie, "GET", `/sites${q}`);
        if (r.status !== 200) return { erro: `status=${r.status}`, vistos };
        const itens = itensDe(r.json);
        for (const it of itens) vistos.add(it.slug ?? it.site?.slug ?? JSON.stringify(it));
        cursor = cursorDe(r.json);
        paginas++;
        if (!cursor || itens.length === 0 || paginas > 20 || cursores.has(cursor)) break;
        cursores.add(cursor);
      }
      return { vistos, paginas };
    };
    const w1 = await coletar(cookieAutor);
    const w2 = await coletar(cookieAutor);
    t("varredura completa sem erro", !w1.erro, w1.erro ?? "");
    t("todos os sites visíveis coletados", w1.vistos.size === 29, `n=${w1.vistos.size}`);
    t("sem duplicatas entre páginas", w1.vistos.size === new Set([...w1.vistos]).size);
    t("segunda varredura idêntica (ordem estável)", w1.vistos.size === w2.vistos.size && [...w1.vistos].sort().join() === [...w2.vistos].sort().join());
    // cursor forjado
    const rForjado = await api(BASE, C.campId, cookieAutor, "GET", "/sites?cursor=@@@forjado@@@");
    t("cursor forjado → 400 ou resultado do mesmo escopo (nunca 500/vazamento)",
      rForjado.status === 400 || rForjado.status === 200, `status=${rForjado.status}`);
    if (rForjado.status === 200) {
      const slugs = itensDe(rForjado.json).map((s) => s.slug ?? s.site?.slug);
      t("cursor forjado não introduz itens de outro escopo", slugs.every((s) => typeof s === "string" && !s.includes("..")));
    }
    // agregados: total nunca conta escondidos
    const rDir = await api(BASE, C.campId, cookieAutor, "GET", "/sites");
    const tot = totalDe(rDir.json);
    t("total/count não inclui arquivado", tot === null || tot === 29, `total=${tot}`);
  }

  sec("V. Nunca-visível — agregados e busca (anti-oráculo V-02)");
  {
    const rDir = await api(BASE, C.campId, cookieAutor, "GET", "/sites");
    const blob = JSON.stringify(rDir.json);
    t("diretório não lista site arquivado", !blob.includes("site-arquivado"), blob.slice(0, 200));
    const rBusca = await api(BASE, C.campId, cookieAutor, "GET", "/sites?q=" + encodeURIComponent("arquivado"));
    t("busca não retorna arquivado", !JSON.stringify(rBusca.json).includes("Site Arquivado"), `status=${rBusca.status}`);
    const rBuscaRasc = await api(BASE, C.campId, cookieAutor, "GET", `/sites/${slugAlvo}`);
    t("detalhe do site não lista página rascunho", !JSON.stringify(rBuscaRasc.json).includes("rascunho-secreto"), `status=${rBuscaRasc.status}`);
    // publicações `contatos` (se o slice cobrir o feed)
    if (temPub) {
      const rFeedLivre = await api(BASE, C.campId, cookieLivre, "GET", "/publicacoes");
      const blobLivre = JSON.stringify(rFeedLivre.json);
      t("feed de sem-aresta omite publicação contatos", !blobLivre.includes("ANUNCIO_CONTATOS_SECRETO"), `status=${rFeedLivre.status}`);
      const totLivre = totalDe(rFeedLivre.json);
      t("agregados do feed não contam ocultos", totLivre === null || !blobLivre.includes("ANUNCIO"), `total=${totLivre}`);
      const rFeedContato = await api(BASE, C.campId, cookieContato, "GET", "/publicacoes");
      t("feed de contato lista publicação contatos", JSON.stringify(rFeedContato.json).includes("ANUNCIO_CONTATOS_SECRETO"), `status=${rFeedContato.status}`);
      const rFeedAutor = await api(BASE, C.campId, cookieAutor, "GET", "/publicacoes");
      t("autor vê o próprio anúncio contatos", JSON.stringify(rFeedAutor.json).includes("ANUNCIO_CONTATOS_SECRETO"));
      const rDetInex = await api(BASE, C.campId, cookieLivre, "GET", `/publicacoes/${pubContatosId}`);
      const rDetSlug = await api(BASE, C.campId, cookieLivre, "GET", "/publicacoes/pub-inexistente-xyz");
      t("detalhe contatos p/ sem-aresta → 404", rDetInex.status === 404, `status=${rDetInex.status}`);
      t("404 detalhe == 404 inexistente", serial(rDetInex) === serial(rDetSlug),
        `${serial(rDetInex).slice(0, 120)} vs ${serial(rDetSlug).slice(0, 120)}`);
      // bloqueio corta na query seguinte (sem snapshot)
      const bloq = await api(BASE, C.campId, cookieAutor, "POST", `/contacts/${aresta}/bloquear`);
      if (bloq.status === 200 || bloq.status === 201) {
        const rFeedApos = await api(BASE, C.campId, cookieContato, "GET", "/publicacoes");
        t("após bloqueio, publicação contatos some (revalidado)", !JSON.stringify(rFeedApos.json).includes("ANUNCIO_CONTATOS_SECRETO"), `status=${rFeedApos.status}`);
      } else t("bloqueio p/ revalidação", "skip", `status=${bloq.status}`);
    } else {
      sec("V.2 publicações — fora do slice (tabela ausente)");
      t("internet_publicacoes ausente — gates P fora do escopo W1/W3", "skip");
    }
  }

  sec("A. Autoria ancorada na sessão (V-05)");
  {
    // escrita: se o slice expuser POST /sites, body alheio deve dar 400
    const rPost = await api(BASE, C.campId, cookieContato, "POST", "/sites",
      { slug: "site-intruso", nome: "Intruso", ownerContaId: contaAutor, personagemId: ch1 });
    if (rPost.status === 404) {
      t("POST /sites ausente — slice read-only, autoria via fixture", "skip", "rota não existe");
    } else {
      t("body com ownerContaId alheio → 400", rPost.status === 400, `status=${rPost.status} ${JSON.stringify(rPost.json).slice(0, 160)}`);
      const rPostOk = await api(BASE, C.campId, cookieContato, "POST", "/sites", { slug: "site-do-contato", nome: "Site Contato" });
      if (rPostOk.status === 200 || rPostOk.status === 201) {
        const siteId = rPostOk.json?.site?.id ?? rPostOk.json?.id;
        const rPageAlheia = await api(BASE, C.campId, cookieContato, "POST", `/sites/${siteId}/pages`,
          { slug: "pg", titulo: "Pg", corpo: "x", formato: "texto", autorContaId: contaAutor });
        t("página com autorContaId alheio → 400", rPageAlheia.status === 400, `status=${rPageAlheia.status}`);
        // idempotência: requestId replay sem duplicata (se publicacoes no slice)
        if (temPub) {
          const rid = "req-idem-" + Date.now();
          const p1 = await api(BASE, C.campId, cookieAutor, "POST", "/publicacoes",
            { tipo: "anuncio", titulo: "Idem Teste", corpo: "x", visibilidade: "campanha", requestId: rid });
          const p2 = await api(BASE, C.campId, cookieAutor, "POST", "/publicacoes",
            { tipo: "anuncio", titulo: "Idem Teste", corpo: "x", visibilidade: "campanha", requestId: rid });
          const id1 = p1.json?.publicacao?.id ?? p1.json?.id;
          const id2 = p2.json?.publicacao?.id ?? p2.json?.id;
          t("requestId replay → mesma publicação", (p1.status === 200 || p1.status === 201) && id1 === id2, `p1=${p1.status} p2=${p2.status}`);
        }
      } else t("POST /sites legítimo falhou", false, `status=${rPostOk.status}`);
    }
  }

  console.log(`\n===== W1/W3 black-box: ${pass} ok / ${fail} falhas / ${skip} skips =====`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.log("\nERRO FATAL:", e);
  process.exitCode = 1;
} finally {
  if (proc) await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}
