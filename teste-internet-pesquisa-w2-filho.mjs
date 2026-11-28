#!/usr/bin/env node
// FILHO — suíte TDD W2 pesquisa multiescopo (#365, matriz SEARCH-01..10).
// Endpoint de busca ainda não existe → baseline esperado 404/falhas.
// Rota centralizada em BUSCA() para ajuste de 1 linha quando o contrato fechar.
import crypto from "node:crypto";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0, skip = 0;
const t = (n, c, x = "") => {
  if (c === "skip") { skip++; console.log("  ~ skip", n, x); }
  else if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, x); }
};
const sec = (n) => console.log("\n== " + n + " ==");
const BUSCA = (camp, q, extra = "") => `/campaigns/${camp}/internet/busca?q=${encodeURIComponent(q)}${extra}`;

const DIR = dirTeste("f6-pesquisa-w2");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc, BASE;
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };
const apiI = (camp, cookie, metodo, path, body) =>
  req(BASE, metodo, `/campaigns/${camp}/internet${path}`, { cookie, body });

try {
  sec("0. Servidor + cenário");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, {
    jogadores: { j1: "w2_j1", j2: "w2_j2" },
    config: { hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "mestre" } },
  });
  const J1 = C.jogadores.j1.cookie, J2 = C.jogadores.j2.cookie, M = C.cookieMestre;
  const campId = C.campId;
  // elegibilidade Internet (padrão das suítes FILHO)
  {
    const db = abrirDb(BANCO); const agora = Date.now();
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
    for (const [kind, key, name] of [["pericia", "computador", "Computador"], ["item", "notebook", "Notebook"]])
      db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,'{}',?,?)")
        .run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    if (!est.secoes[0].campos.some((x) => x.id === "comp")) {
      est.secoes[0].campos.push({ id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } });
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
  const ch1 = C.novoPersonagem(C.jogadores.j1.membershipId, "W2 Repórter", { comp: 3, prof: "jornalista" });
  const ch2 = C.novoPersonagem(C.jogadores.j2.membershipId, "W2 Anunciante", { comp: 3, prof: "medico" });
  darNotebook(ch1); darNotebook(ch2);
  // contas Internet + aresta de contato mútua (necessária p/ Contatar D9)
  await apiI(campId, J1, "POST", "/account", { characterId: ch1, handle: "w2.rep" });
  await apiI(campId, J2, "POST", "/account", { characterId: ch2, handle: "w2.anun" });
  const acc1 = (await apiI(campId, J1, "GET", "/account")).json?.conta?.id ?? (await apiI(campId, J1, "GET", "/account")).json?.id;
  const acc2 = (await apiI(campId, J2, "GET", "/account")).json?.conta?.id ?? (await apiI(campId, J2, "GET", "/account")).json?.id;
  if (acc1 && acc2) {
    await apiI(campId, J1, "POST", "/contacts", { contaId: acc2 });
    await apiI(campId, J2, "POST", "/contacts", { contaId: acc1 });
  }

  sec("S. Seed de conteúdo pesquisável");
  const site = await apiI(campId, J1, "POST", "/sites", { slug: "w2-site-heroi", nome: "W2SITE Portal do Herói", descricao: "site de teste w2" });
  const siteOk = site.status === 200 || site.status === 201;
  t("seed: site criado", siteOk, `status=${site.status}`);
  let pubNotId = null, pubAnId = null, pubClsId = null;
  if (siteOk) {
    const pg = await apiI(campId, J1, "POST", "/sites/w2-site-heroi/paginas", {
      slug: "w2-pagina-inicial", titulo: "W2PAG Crônica da Cidade", corpo: "Texto público sobre W2PAGinvestigacao.", formato: "texto", statusInicial: "publicado",
    });
    t("seed: página publicada", pg.status === 200 || pg.status === 201, `status=${pg.status}`);
    const pgR = await apiI(campId, J1, "POST", "/sites/w2-site-heroi/paginas", {
      slug: "w2-pagina-rascunho", titulo: "W2RASC Segredo", corpo: "W2RASChidden conteúdo restrito.", formato: "texto", statusInicial: "rascunho",
    });
    t("seed: rascunho restrito criado", pgR.status === 200 || pgR.status === 201, `status=${pgR.status}`);
  }
  const pubNot = await apiI(campId, J1, "POST", "/publicacoes", { tipo: "noticia", titulo: "W2NOT Falha no sistema", corpo: "Detalhes W2NOTsegredo.", visibilidade: "campanha" });
  pubNotId = pubNot.json?.publicacao?.id ?? pubNot.json?.id;
  if (pubNotId) await apiI(campId, J1, "PATCH", `/publicacoes/${pubNotId}`, { status: "publicado", expectedVersion: pubNot.json?.publicacao?.version ?? pubNot.json?.version ?? 1 });
  const pubAn = await apiI(campId, J2, "POST", "/publicacoes", { tipo: "anuncio", titulo: "W2ANUNC Vendo artefato", corpo: "Descrição W2ANUNCdetalhe.", visibilidade: "campanha", autorModo: "anonimo" });
  pubAnId = pubAn.json?.publicacao?.id ?? pubAn.json?.id;
  if (pubAnId) await apiI(campId, J2, "PATCH", `/publicacoes/${pubAnId}`, { status: "publicado", expectedVersion: pubAn.json?.publicacao?.version ?? pubAn.json?.version ?? 1 });
  const pubCls = await apiI(campId, J2, "POST", "/publicacoes", { tipo: "classificado", titulo: "W2CLS Alugo porão", corpo: "Localização W2CLSdetalhe.", visibilidade: "campanha" });
  pubClsId = pubCls.json?.publicacao?.id ?? pubCls.json?.id;
  if (pubClsId) await apiI(campId, J2, "PATCH", `/publicacoes/${pubClsId}`, { status: "publicado", expectedVersion: pubCls.json?.publicacao?.version ?? pubCls.json?.version ?? 1 });

  sec("W2. SEARCH-01..04 — escopos site/página/notícia/anúncio");
  const rSite = await req(BASE, "GET", BUSCA(campId, "W2SITE"), { cookie: J2 });
  t("SEARCH-01: busca encontra site pelo nome", rSite.status === 200 && JSON.stringify(rSite.json).includes("w2-site-heroi"), `status=${rSite.status}`);
  const rPag = await req(BASE, "GET", BUSCA(campId, "W2PAGinvestigacao"), { cookie: J2 });
  t("SEARCH-02: busca encontra página por conteúdo", rPag.status === 200 && JSON.stringify(rPag.json).includes("w2-pagina-inicial"), `status=${rPag.status}`);
  const rNot = await req(BASE, "GET", BUSCA(campId, "W2NOTsegredo"), { cookie: J2 });
  console.log("DEBUG rNot:", JSON.stringify(rNot.json).slice(0, 800));
  console.log("DEBUG pubNot seed:", pubNot.status, JSON.stringify(pubNot.json).slice(0, 300));
  t("SEARCH-03: busca encontra notícia visível", rNot.status === 200 && JSON.stringify(rNot.json).includes("W2NOT"), `status=${rNot.status}`);
  const rAn = await req(BASE, "GET", BUSCA(campId, "W2ANUNCdetalhe"), { cookie: J2 });
  t("SEARCH-04: busca encontra anúncio ativo", rAn.status === 200 && JSON.stringify(rAn.json).includes("W2ANUNC"), `status=${rAn.status}`);
  const rCls = await req(BASE, "GET", BUSCA(campId, "W2CLSdetalhe"), { cookie: J2 });
  t("SEARCH-04b: busca encontra classificado", rCls.status === 200 && JSON.stringify(rCls.json).includes("W2CLS"), `status=${rCls.status}`);

  sec("W2. SEARCH-05/06 — perfis por handle, displayName fora");
  const rHandle = await req(BASE, "GET", BUSCA(campId, "w2.rep"), { cookie: J2 });
  t("SEARCH-05: handle de perfil indexado (depende W9)", rHandle.status === 200, `status=${rHandle.status}`);
  const rDisp = await req(BASE, "GET", BUSCA(campId, "W2 Repórter"), { cookie: J2 });
  t("SEARCH-06: displayName NÃO indexa perfil", !(rDisp.status === 200 && /perfil|profile/i.test(JSON.stringify(rDisp.json))), `status=${rDisp.status}`);

  sec("W2. SEARCH-07 — invisível não altera resultado");
  const rRasc = await req(BASE, "GET", BUSCA(campId, "W2RASChidden"), { cookie: J2 });
  t("SEARCH-07: termo só em rascunho → sem resultados", !(rRasc.status === 200 && JSON.stringify(rRasc.json).includes("W2RASC")), `status=${rRasc.status}`);
  const rAll = await req(BASE, "GET", BUSCA(campId, "W2"), { cookie: J2 });
  t("SEARCH-07b: nenhum resultado contém rascunho", !JSON.stringify(rAll.json).includes("W2RASChidden"), "");

  sec("W2. SEARCH-08 — cursor/campanha");
  const campB = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "CampB W2" } });
  const campBId = campB.json?.campanha?.id;
  if (campBId) {
    const rCross = await req(BASE, "GET", BUSCA(campBId, "W2SITE"), { cookie: J2 });
    t("SEARCH-08: busca em outra campanha não retorna conteúdo da A", !(rCross.status === 200 && JSON.stringify(rCross.json).includes("w2-site-heroi")), `status=${rCross.status}`);
    const rForj = await req(BASE, "GET", BUSCA(campId, "W2", "&cursor=forjado-campB-xyz"), { cookie: J2 });
    t("SEARCH-08b: cursor forjado rejeitado ou inócuo", rForj.status !== 500, `status=${rForj.status}`);
  } else t("SEARCH-08: campanha B", "skip", "criação falhou");

  sec("W2. SEARCH-09 — estado reflete remoção");
  if (pubAnId) {
    await apiI(campId, J2, "PATCH", `/publicacoes/${pubAnId}`, { status: "removido", expectedVersion: 2 });
    const rDepois = await req(BASE, "GET", BUSCA(campId, "W2ANUNCdetalhe"), { cookie: J2 });
    t("SEARCH-09: anúncio removido some da busca ativa", !(rDepois.status === 200 && JSON.stringify(rDepois.json).includes("W2ANUNC Vendo")), `status=${rDepois.status}`);
  } else t("SEARCH-09", "skip", "anúncio não criado");

  sec("W2. SEARCH-10 — paginação estável");
  const rP1 = await req(BASE, "GET", BUSCA(campId, "W2", "&limit=2"), { cookie: J2 });
  const cur = rP1.json?.nextCursor ?? rP1.json?.cursor ?? "";
  const rP2 = await req(BASE, "GET", BUSCA(campId, "W2", `&limit=2&cursor=${encodeURIComponent(cur)}`), { cookie: J2 });
  const ids1 = JSON.stringify(rP1.json).match(/[0-9a-f-]{36}/g) ?? [];
  const ids2 = JSON.stringify(rP2.json).match(/[0-9a-f-]{36}/g) ?? [];
  const dup = ids1.filter((x) => ids2.includes(x));
  t("SEARCH-10: paginação sem duplicatas entre páginas", dup.length === 0, `dups=${dup.length}`);

  sec("ISO. Autenticação");
  const rAnon = await req(BASE, "GET", `/campaigns/${campId}/internet/busca?q=W2SITE`);
  t("sem sessão → 401/403", rAnon.status === 401 || rAnon.status === 403, `status=${rAnon.status}`);
  const rVazio = await req(BASE, "GET", BUSCA(campId, ""), { cookie: J2 });
  t("busca vazia → 400 ou resultado controlado", rVazio.status === 400 || rVazio.status === 200, `status=${rVazio.status}`);

  await encerrarServidor(proc);
  limparDir(DIR);
  console.log(`\n===== W2 pesquisa TDD: ${pass} ok / ${fail} falhas / ${skip} skips =====`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error(e);
  try { await encerrarServidor(proc); } catch {}
  process.exit(1);
}
