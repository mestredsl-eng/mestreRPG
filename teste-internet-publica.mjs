// Issue #365 (Internet pública 1.1.2 — fatia W1/W3, SOMENTE LEITURA):
// diretório de sites da campanha + detalhe de site + leitura de página.
// Sobe servidor real com banco DESCARTÁVEL e prova via HTTP:
//   - migração 0043 cria internet_sites/internet_pages em banco limpo;
//   - gate do leitor: conta Internet autorizada (perícia+dispositivo,
//     revalidado a cada chamada) OU mestre da campanha; demais → 403;
//   - diretório: só sites `ativo` da campanha, contagem de páginas
//     PUBLICADAS, owner público sem vazar ids, paginação keyset,
//     busca por prefixo (?q=);
//   - detalhe: menu derivado só de páginas `publicado`;
//   - página: só `publicado` legível; rascunho/retirado → 404;
//   - anti-enumeração: slug de outra campanha → 404 idêntico;
//   - site `arquivado` some do diretório e do detalhe (404).
import crypto from "node:crypto";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("internet-publica");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;

/** Mesmo fixture do gate Internet 1.1.0 (teste-internet-contas). */
function fixtureGate(banco, campId) {
  const db = abrirDb(banco);
  const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
  const agora = Date.now();
  const ins = db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?, '{}',?,?)");
  for (const [kind, key, name] of [
    ["pericia", "computador", "Computador"],
    ["conhecimento", "tecnologia", "Tecnologia"],
    ["item", "notebook", "Notebook"],
  ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
  const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
  const est = JSON.parse(ver.structure);
  est.secoes[0].campos.push(
    { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
    { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
  );
  db.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), ver.id);
  db.close();
}
function darDispositivo(banco, characterId) {
  const db = abrirDb(banco);
  db.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), characterId, "Notebook", 1, null, "equipamento", "mochila", "novo", 1.5,
      JSON.stringify({ regra: { kind: "item", key: "notebook" } }), Date.now(), Date.now());
  db.close();
}

/** Semeia site/página direto no banco (a fatia é read-only — não há
 *  endpoint de criação; os dados chegam por fixture, como em produção
 *  futura pelas rotas de escrita). */
function semearSite(banco, { campId, slug, nome, ownerContaId, status = "ativo", criadoEm = Date.now() }) {
  const db = abrirDb(banco);
  const id = crypto.randomUUID();
  db.prepare("insert into internet_sites (id,campaign_id,slug,nome,descricao,owner_conta_id,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(id, campId, slug, nome, `desc ${nome}`, ownerContaId, status, criadoEm, criadoEm);
  db.close();
  return id;
}
function semearPagina(banco, { campId, siteId, slug, titulo, corpo, status = "publicado", autorContaId, publicadoEm = Date.now() }) {
  const db = abrirDb(banco);
  const id = crypto.randomUUID();
  db.prepare("insert into internet_pages (id,site_id,campaign_id,slug,titulo,corpo,formato,status,version,autor_conta_id,published_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, siteId, campId, slug, titulo, corpo, "texto", status, 1, autorContaId,
      status === "publicado" ? publicadoEm : null, Date.now(), Date.now());
  db.close();
  return id;
}
function contaBruta(banco, { campId, characterId, handle }) {
  const db = abrirDb(banco);
  const id = crypto.randomUUID();
  const agora = Date.now();
  db.prepare("insert into internet_accounts (id,campaign_id,character_id,handle,display_name,status,mostrar_presenca,mostrar_digitando,created_at,updated_at) values (?,?,?,?,?, 'ativa',0,0,?,?)")
    .run(id, campId, characterId, handle, handle, agora, agora);
  db.close();
  return id;
}

try {
  // ================= MIGRAÇÃO =================
  sec("A. Migração 0043 — banco limpo");
  await prepararBanco(BANCO);
  {
    const db = abrirDb(BANCO);
    const tabelas = new Set(db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name));
    t("banco limpo tem internet_sites", tabelas.has("internet_sites"));
    t("banco limpo tem internet_pages", tabelas.has("internet_pages"));
    db.close();
  }

  // ================= CENÁRIO =================
  sec("B. Cenário — campanha, contas e sites");
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
  proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  await esperarSaudavel(BASE, proc);

  const C = await criarCenario(BASE, BANCO, { jogadores: { j1: "ic_j1", j2: "ic_j2", j3: "ic_j3" } });
  const campId = C.campId;
  fixtureGate(BANCO, campId);
  const charJ1 = C.novoPersonagem(C.jogadores.j1.membershipId, "Ada Site", { comp: 1 });
  const charJ2 = C.novoPersonagem(C.jogadores.j2.membershipId, "Beto Site", { comp: 1 });
  const charJ3 = C.novoPersonagem(C.jogadores.j3.membershipId, "Cida Site", { comp: 1 });
  const charSemGate = C.novoPersonagem(C.jogadores.j3.membershipId, "Sem Gate", { for: 5 });
  for (const ch of [charJ1, charJ2, charJ3]) darDispositivo(BANCO, ch);
  darDispositivo(BANCO, charSemGate);

  const j1 = C.jogadores.j1, j2 = C.jogadores.j2, j3 = C.jogadores.j3;
  const API = (metodo, path, cookie, body) =>
    req(BASE, metodo, `/campaigns/${campId}/internet${path}`, { cookie, body });

  const c1 = await API("POST", "/account", j1.cookie, { characterId: charJ1, handle: "ada.site", displayName: "Ada" });
  t("j1 cria conta diegética", c1.status === 201, JSON.stringify(c1.json).slice(0, 160));
  const contaJ1 = c1.json?.conta?.id;
  const c2 = await API("POST", "/account", j2.cookie, { characterId: charJ2, handle: "beto.site" });
  t("j2 cria conta diegética", c2.status === 201);
  const contaJ2 = c2.json?.conta?.id;
  // conta "fantasma" de personagem SEM gate — prova que o servidor
  // revalida elegibilidade na leitura (não basta existir a aresta).
  const contaSemGate = contaBruta(BANCO, { campId, characterId: charSemGate, handle: "sem.gate" });

  // sites: 2 "reais" + 1 arquivado + 22 extras p/ paginação (limite 20)
  const siteA = semearSite(BANCO, { campId, slug: "taberna-do-mestre", nome: "Taberna do Mestre", ownerContaId: contaJ1, criadoEm: 1000 });
  semearPagina(BANCO, { campId, siteId: siteA, slug: "menu", titulo: "Cardápio", corpo: "Pratos do dia.\n\nSopa da bruxa.", autorContaId: contaJ1 });
  semearPagina(BANCO, { campId, siteId: siteA, slug: "diario", titulo: "Diário rascunho", corpo: "não publicado", status: "rascunho", autorContaId: contaJ1 });
  semearPagina(BANCO, { campId, siteId: siteA, slug: "antigo", titulo: "Página retirada", corpo: "retirada", status: "retirado", autorContaId: contaJ1 });
  const siteB = semearSite(BANCO, { campId, slug: "arquivo-cidade", nome: "Arquivo da Cidade", ownerContaId: contaJ2, criadoEm: 2000 });
  semearPagina(BANCO, { campId, siteId: siteB, slug: "noticia-1", titulo: "Notícia Um", corpo: "Fato público.", autorContaId: contaJ2 });
  semearSite(BANCO, { campId, slug: "site-morto", nome: "Site Morto", ownerContaId: contaJ1, status: "arquivado", criadoEm: 3000 });
  for (let i = 0; i < 22; i++) {
    semearSite(BANCO, { campId, slug: `extra-${String(i).padStart(2, "0")}`, nome: `Extra ${String(i).padStart(2, "0")}`, ownerContaId: contaJ1, criadoEm: 4000 + i });
  }

  // segunda campanha (mesmo admin/mestre) — prova anti-enumeração
  const campB = await req(BASE, "POST", "/campaigns", { cookie: C.cookieMestre, body: { name: "Campanha B" } });
  const campBId = campB.json?.campanha?.id;
  t("segunda campanha criada", !!campBId);
  const APIB = (metodo, path, cookie, body) => req(BASE, metodo, `/campaigns/${campBId}/internet${path}`, { cookie, body });

  // ================= GATE DO LEITOR =================
  sec("C. Gate — quem pode ler a camada pública");

  const dirJ1 = await API("GET", "/sites", j1.cookie);
  t("j1 (conta+gate) lista sites → 200", dirJ1.status === 200, JSON.stringify(dirJ1.json).slice(0, 200));
  t("j3 (membro sem conta) → 403", (await API("GET", "/sites", j3.cookie)).status === 403);
  t("sem cookie → 401", (await req(BASE, "GET", `/campaigns/${campId}/internet/sites`)).status === 401);
  t("mestre da campanha lê sem conta própria → 200", (await API("GET", "/sites", C.cookieMestre)).status === 200);
  // j3 tem conta "sem.gate" no banco (personagem inelegível) → 403
  t("conta de personagem inelegível → 403", (await API("GET", "/sites", j3.cookie)).status === 403);

  // ================= DIRETÓRIO =================
  sec("D. Diretório — escopo, contagem e paginação");

  const todos = await API("GET", "/sites?limit=50", j1.cookie);
  const nomes = (todos.json?.sites ?? []).map((s) => s.slug);
  t("diretório exclui site arquivado", !nomes.includes("site-morto"));
  t("diretório tem os 24 sites ativos", todos.json?.sites?.length === 24, `veio ${todos.json?.sites?.length}`);
  t("siteA conta só páginas publicadas (1)", todos.json?.sites?.find((s) => s.slug === "taberna-do-mestre")?.paginasPublicadas === 1);
  const itemA = todos.json?.sites?.find((s) => s.slug === "taberna-do-mestre");
  t("owner público expõe handle", itemA?.owner?.handle === "ada.site");
  t("diretório não vaza ids internos",
    todos.json?.sites?.every((s) => !("ownerContaId" in s) && !("characterId" in s) && !("userId" in s)));

  // paginação keyset: limit=20 → cursor → resto; sem duplicatas
  const p1 = await API("GET", "/sites?limit=20", j1.cookie);
  t("página 1 tem 20 itens", p1.json?.sites?.length === 20);
  t("página 1 traz cursor", typeof p1.json?.cursor === "string" && p1.json.cursor.length > 0);
  const p2 = await API("GET", `/sites?limit=20&cursor=${encodeURIComponent(p1.json.cursor)}`, j1.cookie);
  const ids1 = new Set(p1.json.sites.map((s) => s.id));
  t("página 2 tem os 4 restantes", p2.json?.sites?.length === 4, `veio ${p2.json?.sites?.length}`);
  t("páginas não se sobrepõem", p2.json.sites.every((s) => !ids1.has(s.id)));
  t("fim da paginação → cursor null", p2.json?.cursor === null);

  // busca por prefixo em `nome`
  const busca = await API("GET", "/sites?q=Arquivo", j1.cookie);
  t("?q= filtra por prefixo de nome", busca.json?.sites?.length === 1 && busca.json.sites[0].slug === "arquivo-cidade",
    JSON.stringify(busca.json?.sites?.map((s) => s.slug)));
  const buscaVazia = await API("GET", "/sites?q=zzzz", j1.cookie);
  t("?q= sem resultado → lista vazia", buscaVazia.json?.sites?.length === 0);
  const paramsInvalidos = await API("GET", "/sites?limit=0", j1.cookie);
  t("limit=0 → 400", paramsInvalidos.status === 400);
  const cursorRuim = await API("GET", "/sites?cursor=@@@", j1.cookie);
  t("cursor inválido → 400", cursorRuim.status === 400);

  // ================= DETALHE DO SITE =================
  sec("E. Detalhe — menu derivado de publicadas");

  const det = await API("GET", "/sites/taberna-do-mestre", j1.cookie);
  t("detalhe 200", det.status === 200, JSON.stringify(det.json).slice(0, 200));
  t("menu lista só página publicada", det.json?.paginas?.length === 1 && det.json.paginas[0].slug === "menu");
  t("detalhe expõe owner", det.json?.site?.owner?.handle === "ada.site");
  t("site inexistente → 404", (await API("GET", "/sites/nao-existe", j1.cookie)).status === 404);
  t("site arquivado → 404", (await API("GET", "/sites/site-morto", j1.cookie)).status === 404);

  // ================= PÁGINA =================
  // só `publicado` é legível para não-privilegiado; autor/mestre têm
  // prévia estendida (coberta pela suíte W3-escrita do FILHO).
  sec("F. Página — só publicado é legível");

  const pg = await API("GET", "/sites/taberna-do-mestre/paginas/menu", j1.cookie);
  t("página publicada → 200", pg.status === 200, JSON.stringify(pg.json).slice(0, 200));
  t("corpo entregue", pg.json?.pagina?.corpo?.includes("Sopa da bruxa"));
  t("site de contexto no payload", pg.json?.site?.slug === "taberna-do-mestre");
  t("autor público expõe handle", pg.json?.pagina?.autor?.handle === "ada.site");
  // j2 não é autor das páginas de contaJ1 → 404 idêntico ao inexistente
  t("rascunho → 404 p/ não-autor", (await API("GET", "/sites/taberna-do-mestre/paginas/diario", j2.cookie)).status === 404);
  t("retirada → 404 p/ não-autor", (await API("GET", "/sites/taberna-do-mestre/paginas/antigo", j2.cookie)).status === 404);
  // prévia estendida: o AUTOR da página lê rascunho/retirado (W3 escrita)
  const rascAutor = await API("GET", "/sites/taberna-do-mestre/paginas/diario", j1.cookie);
  t("autor lê próprio rascunho → 200", rascAutor.status === 200 && rascAutor.json?.pagina?.status === "rascunho", `status=${rascAutor.status}`);
  t("página inexistente → 404", (await API("GET", "/sites/taberna-do-mestre/paginas/nada", j1.cookie)).status === 404);
  t("site arquivado → página 404", (await API("GET", "/sites/site-morto/paginas/x", j1.cookie)).status === 404);

  // ================= ANTI-ENUMERAÇÃO =================
  sec("G. Cross-campaign — 404 idêntico");

  // site/página da campanha A consultados na campanha B (mestre lê B)
  t("site da campanha A → 404 na campanha B",
    (await APIB("GET", "/sites/taberna-do-mestre", C.cookieMestre)).status === 404);
  t("página da campanha A → 404 na campanha B",
    (await APIB("GET", "/sites/taberna-do-mestre/paginas/menu", C.cookieMestre)).status === 404);
  const dirB0 = await APIB("GET", "/sites", C.cookieMestre);
  t("diretório da campanha B não lista sites de A",
    dirB0.status === 200 && (dirB0.json?.sites ?? []).length === 0);
  // slug de B não vaza em A
  semearSite(BANCO, { campId: campBId, slug: "site-de-b", nome: "Site de B", ownerContaId: contaJ1, criadoEm: 5000 });
  // ownerContaId de A é inválido em B (FK não é checada aqui — FK
  // enforcement é off; o diretório de B deve simplesmente não listar)
  const dirB = await APIB("GET", "/sites", C.cookieMestre);
  t("campanha B lista só seus sites", dirB.json?.sites?.length === 1 && dirB.json.sites[0].slug === "site-de-b",
    JSON.stringify(dirB.json?.sites?.map((s) => s.slug)));
  t("site de B → 404 na campanha A", (await API("GET", "/sites/site-de-b", j1.cookie)).status === 404);

  // j1 NÃO é membro de B → papel negado antes mesmo do 404
  t("j1 em campanha B → 403 (sem membership)", (await APIB("GET", "/sites", j1.cookie)).status === 403);

  // ================= RATE LIMIT (aceite #387 "rate limit observado") =========
  sec("H. Rate limit — cota por usuário nas leituras públicas");

  // rajada no MESMO usuário: a cota compartilhada dos 3 GETs (60/min)
  // precisa produzir 429 — enumeração de slugs fica cara. Respostas
  // só podem ser 200 ou 429, nunca 5xx.
  {
    let viu429 = false, viu5xx = false, total = 0;
    for (let i = 0; i < 70 && !viu429; i++) {
      const r = await API("GET", "/sites", j1.cookie);
      total++;
      if (r.status === 429) viu429 = true;
      if (r.status >= 500) viu5xx = true;
    }
    t("rajada gera 429 dentro de 70 requests", viu429, `total=${total}`);
    t("rate limit nunca responde 5xx", !viu5xx);
    // usuário diferente tem cota própria — j2 ainda lê
    const dirJ2 = await API("GET", "/sites", j2.cookie);
    t("cota é por usuário (j2 não herda o 429 de j1)", dirJ2.status === 200, `status=${dirJ2.status}`);
  }
} finally {
  if (proc) await encerrarServidor(proc);
  console.log(`\n${pass} ok, ${fail} falhas`);
  limparDir(DIR);
  process.exit(fail ? 1 : 0);
}
