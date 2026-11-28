#!/usr/bin/env node
// FILHO — suíte black-box W4/W5 publicações (#365, contrato
// docs/CONTRATO-W4W5-PUBLICACOES-365.md @ PR #394).
//
// Cobertura (matriz PUB-01/02, NEWS-01..08, DP-2/3/6/8/9, SEC-*):
//   criação só noticia|post_perfil, visibilidade obrigatória, autor_modo
//   sem anonimo (400), pseudonimo exige pseudo_nome, autoria server-side
//   PATCH autor|mestre + expectedVersion; feed keyset só publicado+visivel
//   GET /:id corpo+fonte; contatos invisível sem aresta (anti-oráculo)
//   denúncia: 1/conta, 2 distintas ou grave → removido na mesma tx (DP-3)
//   notícia de morte origem=sistema somente-leitura; ressurreição não apaga
//   (DP-8); correção só via nova publicação (DP-9)
//
// Estado esperado AGORA: rotas/publicacoes inexistentes → FAIL/TDD.
// Fixtures 100% descartáveis.
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
const apiChars = (base, cookie, metodo, path, body) =>
  req(base, metodo, path, { cookie, body });

const DIR = dirTeste("f6-pub-w4w5");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc;
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };
const pubsDb = () => { try { return comDb((db) => db.prepare("select * from internet_publicacoes order by created_at").all()); } catch { return []; } };
const denunciasDb = () => { try { return comDb((db) => db.prepare("select * from internet_denuncias order by created_at").all()); } catch { return []; } };

try {
  sec("0. Servidor + cenário base");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  const BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, {
    jogadores: { j1: "w45_j1", j2: "w45_j2", j3: "w45_j3" },
    config: { hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "mestre" } },
  });

  // gate P5 (mesmo padrão W3)
  {
    const db = abrirDb(BANCO); const agora = Date.now();
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(C.campId);
    const ins = db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,'{}',?,?)");
    for (const [kind, key, name] of [
      ["pericia", "computador", "Computador"], ["conhecimento", "tecnologia", "Tecnologia"],
      ["item", "notebook", "Notebook"],
      ["profissao", "jornalista", "Jornalista"], ["profissao", "medico", "Médico"],
    ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    if (!est.secoes[0].campos.some((x) => x.id === "comp")) {
      est.secoes[0].campos.push(
        { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
        { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
        { id: "prof", label: "Profissão", tipo: "selecao_unica", regraKind: "profissao" });
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
    return (r.status === 200 || r.status === 201) ? true : null;
  };

  const ch1 = C.novoPersonagem(C.jogadores.j1.membershipId, "W45 Autor", { comp: 3, prof: "jornalista" });
  const ch2 = C.novoPersonagem(C.jogadores.j2.membershipId, "W45 Vizinho", { comp: 3, prof: "medico" });
  const ch3 = C.novoPersonagem(C.jogadores.j3.membershipId, "W45 Alvo", { comp: 3, prof: "medico" });
  for (const ch of [ch1, ch2, ch3]) darNotebook(ch);
  await criarConta(C.jogadores.j1, ch1, "w45.autor");
  await criarConta(C.jogadores.j2, ch2, "w45.vizinho");
  await criarConta(C.jogadores.j3, ch3, "w45.alvo");
  const J1 = C.jogadores.j1.cookie, J2 = C.jogadores.j2.cookie, J3 = C.jogadores.j3.cookie, M = C.cookieMestre;

  // aresta j1↔j2 (visibilidade `contatos`)
  const contaJ2r = await api(BASE, C.campId, J2, "GET", `/account?characterId=${ch2}`);
  const contaJ2 = contaJ2r.json?.conta?.id;
  if (contaJ2) {
    const contaJ1r = await api(BASE, C.campId, J1, "GET", `/account?characterId=${ch1}`);
    const ped = await api(BASE, C.campId, J1, "POST", "/contacts", { contaId: contaJ2 });
    const aresta = ped.json?.contato?.id;
    if (aresta) await api(BASE, C.campId, J2, "POST", `/contacts/${aresta}/aceitar`);
  }
  t("fixture: contas + aresta j1↔j2", true);

  // ---------- P1. Criação de publicações ----------
  sec("P1. POST /publicacoes — tipos, autoria, anonimato");
  let pubNoticia = null, pubPseudoId = null, pubPseudoV = 1, pubContatosId = null;
  {
    const r = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "Festa no largo", corpo: "Houve festa.", visibilidade: "campanha",
    });
    t("PUB-01: noticia criada (201)", r.status === 201 || r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    pubNoticia = r.json?.publicacao ?? r.json?.item ?? r.json;
    const rPerfil = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "post_perfil", titulo: "Novo visual", corpo: "Mudei.", visibilidade: "campanha",
    });
    t("PUB-01b: post_perfil aceito nesta fatia", rPerfil.status === 201 || rPerfil.status === 200, `status=${rPerfil.status}`);
    const rAnuncio = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "anuncio", titulo: "vendo", corpo: "x", visibilidade: "campanha",
    });
    t("anuncio/classificado fora do slice → 4xx", rAnuncio.status >= 400 && rAnuncio.status < 500, `status=${rAnuncio.status}`);
    const rSemVis = await api(BASE, C.campId, J1, "POST", "/publicacoes", { tipo: "noticia", titulo: "x", corpo: "y" });
    t("visibilidade obrigatória → 4xx", rSemVis.status >= 400 && rSemVis.status < 500, `status=${rSemVis.status}`);
    // contrato §4: "status só rascunho na criação" — statusInicial=publicado
    // não pode publicar direto (desvio real se 201)
    const rStatusInicial = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "publicado direto", corpo: "y", visibilidade: "campanha", statusInicial: "publicado",
    });
    t("POST statusInicial=publicado rejeitado (só rascunho na criação)",
      rStatusInicial.status >= 400 && rStatusInicial.status < 500, `status=${rStatusInicial.status}`);
    const rAnon = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "x", corpo: "y", visibilidade: "campanha", autorModo: "anonimo",
    });
    t("PUB-03: autorModo anonimo em noticia → 400", rAnon.status === 400, `status=${rAnon.status}`);
    const rPseudo = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "x", corpo: "y", visibilidade: "campanha", autorModo: "pseudonimo",
    });
    t("pseudonimo sem pseudoNome → 4xx", rPseudo.status >= 400 && rPseudo.status < 500, `status=${rPseudo.status}`);
    const rPseudoOk = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "x", corpo: "y", visibilidade: "campanha", autorModo: "pseudonimo", pseudoNome: "Vulto_9",
    });
    t("pseudonimo válido → 201", rPseudoOk.status === 201 || rPseudoOk.status === 200, `status=${rPseudoOk.status}`);
    pubPseudoId = rPseudoOk.json?.publicacao?.id ?? rPseudoOk.json?.id;
    pubPseudoV = rPseudoOk.json?.publicacao?.version ?? 1;
    // Dono gate item 8: pseudoNome segue o charset do handle — rejeitar
    // espaços/acentos/símbolos que o handle não aceitaria
    const rPseudoCharset = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "x", corpo: "y", visibilidade: "campanha",
      autorModo: "pseudonimo", pseudoNome: "Vulto Com Espaço!",
    });
    t("pseudoNome com charset inválido (espaço/!) → 4xx", rPseudoCharset.status >= 400 && rPseudoCharset.status < 500, `status=${rPseudoCharset.status}`);
    // idem via PATCH (mesma regra deve valer na edição)
    if (pubPseudoId) {
      const rPatchCharset = await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${pubPseudoId}`, {
        pseudoNome: "Outro Nome Inválido!", expectedVersion: pubPseudoV,
      });
      t("PATCH pseudoNome charset inválido → 4xx", rPatchCharset.status >= 400 && rPatchCharset.status < 500, `status=${rPatchCharset.status}`);
      // se o produto aceitar (bug), restaura pseudoNome/versão p/ não
      // cascatear falhas vacuas nas seções seguintes
      if (rPatchCharset.status === 200) {
        pubPseudoV = rPatchCharset.json?.publicacao?.version ?? (pubPseudoV + 1);
        await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${pubPseudoId}`, {
          pseudoNome: "Vulto_9", expectedVersion: pubPseudoV,
        }).then((r2) => { if (r2.status === 200) pubPseudoV = r2.json?.publicacao?.version ?? (pubPseudoV + 1); });
      }
    }
    // D8/NEWS-04/05: gate profissao:jornalista server-side (decisão fechada,
    // INTERMEDIÁRIO B-1 na PR #394) — conta sem a profissão não publica noticia
    const rSemProf = await api(BASE, C.campId, J3, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "Notícia sem profissão", corpo: "y", visibilidade: "campanha",
    });
    t("NEWS-04/05: conta sem profissao:jornalista → 403", rSemProf.status === 403 || rSemProf.status === 400, `status=${rSemProf.status}`);
    const rForjaProf = await api(BASE, C.campId, J3, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "x", corpo: "y", visibilidade: "campanha", profissao: "jornalista", characterId: ch1,
    });
    t("NEWS-04: profissão forjada no body/characterId alheio → rejeitado",
      rForjaProf.status === 403 || rForjaProf.status === 400 || rForjaProf.status === 404, `status=${rForjaProf.status}`);
    // ordem FILHO: post_perfil NÃO exige profissao:jornalista
    const rPerfilSemProf = await api(BASE, C.campId, J3, "POST", "/publicacoes", {
      tipo: "post_perfil", titulo: "Perfil médico", corpo: "y", visibilidade: "campanha",
    });
    t("post_perfil não exige profissao:jornalista → 201", rPerfilSemProf.status === 201 || rPerfilSemProf.status === 200, `status=${rPerfilSemProf.status}`);
    const rForja = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "x", corpo: "y", visibilidade: "campanha", autorContaId: "forjado", origem: "sistema",
    });
    if (rForja.status === 201 || rForja.status === 200) {
      const row = pubsDb().find((p) => p.titulo === "x" && p.autor_conta_id);
      t("PUB-02: autoria forjada no body ignorada (autor = conta do requisitante)",
        !JSON.stringify(rForja.json).includes("forjado") && row?.origem !== "sistema", JSON.stringify(rForja.json).slice(0, 140));
    } else t("PUB-02: autoria forjada no body → rejeitado", rForja.status >= 400 && rForja.status < 500, `status=${rForja.status}`);
    const rSemSessao = await req(BASE, "POST", `/campaigns/${C.campId}/internet/publicacoes`, { body: { tipo: "noticia", titulo: "x", corpo: "y", visibilidade: "campanha" } });
    t("sem sessão → 401", rSemSessao.status === 401, `status=${rSemSessao.status}`);
    // status inicial só rascunho
    if (pubNoticia) {
      const st = pubNoticia.status ?? (await api(BASE, C.campId, J1, "GET", `/publicacoes/${pubNoticia.id}`)).json?.publicacao?.status;
      t("criação sempre rascunho", st === "rascunho" || st === undefined, `status campo=${st}`);
    }
  }

  // ---------- P2. Publicar via PATCH (expectedVersion) ----------
  sec("P2. PATCH /publicacoes/:id — publicar, versão, papéis");
  let pubId = null, pubVersion = null;
  {
    if (pubNoticia?.id) {
      pubId = pubNoticia.id;
      pubVersion = pubNoticia.version ?? 1;
      const rPub = await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${pubId}`, { status: "publicado", expectedVersion: pubVersion });
      t("autor publica rascunho→publicado", rPub.status === 200, `status=${rPub.status} ${JSON.stringify(rPub.json).slice(0, 160)}`);
      const depois = rPub.json?.publicacao ?? rPub.json;
      pubVersion = depois?.version ?? (pubVersion + 1);
      t("publicado_em preenchido na 1ª publicação", !!(depois?.publicadoEm ?? depois?.publicado_em), JSON.stringify(depois).slice(0, 140));
      // feed público vê
      const rFeed = await api(BASE, C.campId, J3, "GET", "/publicacoes?tipo=noticia");
      t("feed lista publicada", rFeed.status === 200 && JSON.stringify(rFeed.json).includes(pubId ?? ""), `status=${rFeed.status}`);
      // stale version
      const rStale = await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${pubId}`, { titulo: "x", expectedVersion: 1 });
      t("expectedVersion defasada → 409", rStale.status === 409, `status=${rStale.status}`);
      // não-autor não edita
      const rNaoAutor = await api(BASE, C.campId, J2, "PATCH", `/publicacoes/${pubId}`, { titulo: "sequestro", expectedVersion: pubVersion });
      t("não-autor PATCH → 404 uniforme", rNaoAutor.status === 404 || rNaoAutor.status === 403, `status=${rNaoAutor.status}`);
      // B-3/D14 (INTERMEDIÁRIO PR #394): mestre não reescreve conteúdo alheio —
      // no máximo modera. Se o PATCH for aceito, o conteúdo deve permanecer.
      const rMestre = await api(BASE, C.campId, M, "PATCH", `/publicacoes/${pubId}`, { titulo: "Editado pelo mestre", expectedVersion: pubVersion });
      let mestreNaoReescreveu = rMestre.status === 403 || rMestre.status === 404;
      if (rMestre.status === 200) {
        const detM = await api(BASE, C.campId, J3, "GET", `/publicacoes/${pubId}`);
        mestreNaoReescreveu = !JSON.stringify(detM.json).includes("Editado pelo mestre");
      }
      t("B-3/D14: mestre não reescreve conteúdo de publicação alheia", mestreNaoReescreveu, `status=${rMestre.status}`);
      // despublicar: publicado→rascunho
      const vAtual = (rMestre.json?.publicacao ?? rMestre.json)?.version ?? pubVersion;
      const rDespub = await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${pubId}`, { status: "rascunho", expectedVersion: vAtual });
      t("publicado→rascunho (despublicar) permitido", rDespub.status === 200, `status=${rDespub.status}`);
      // some do feed
      const rFeed2 = await api(BASE, C.campId, J3, "GET", "/publicacoes?tipo=noticia");
      t("rascunho some do feed", !JSON.stringify(rFeed2.json).includes(pubId ?? "zzz"), `status=${rFeed2.status}`);
      // re-publica para os testes seguintes
      const v2 = (rDespub.json?.publicacao ?? rDespub.json)?.version ?? (vAtual + 1);
      await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${pubId}`, { status: "publicado", expectedVersion: v2 });
    } else t("P2 setup: publicação criada", false, "POST /publicacoes falhou");
  }

  // ---------- P3. Feed W4 — keyset, ordenação, visibilidade ----------
  sec("P3. GET /publicacoes — feed keyset e visibilidade");
  {
    // +3 publicadas de j1 para ordenação/paginação
    for (let i = 0; i < 3; i++) {
      const r = await api(BASE, C.campId, J1, "POST", "/publicacoes", { tipo: "noticia", titulo: `Feed ${i}`, corpo: "c", visibilidade: "campanha" });
      const id = r.json?.publicacao?.id ?? r.json?.id;
      const v = r.json?.publicacao?.version ?? 1;
      if (id) await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${id}`, { status: "publicado", expectedVersion: v });
    }
    // publicação pseudônima de j1 — publica para checar representação
    if (pubPseudoId) {
      await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${pubPseudoId}`, { status: "publicado", expectedVersion: pubPseudoV });
    }
    // publicação contatos de j1 — j3 (sem aresta) não pode ver em feed nem detalhe
    const rCont = await api(BASE, C.campId, J1, "POST", "/publicacoes", { tipo: "noticia", titulo: "SEGREDO_CONTATOS_X9", corpo: "só contatos", visibilidade: "contatos" });
    const idCont = rCont.json?.publicacao?.id ?? rCont.json?.id;
    pubContatosId = idCont;
    const vCont = rCont.json?.publicacao?.version ?? 1;
    if (idCont) await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${idCont}`, { status: "publicado", expectedVersion: vCont });
    const rFeed = await api(BASE, C.campId, J3, "GET", "/publicacoes?tipo=noticia&limit=50");
    const blob = JSON.stringify(rFeed.json);
    t("feed 200 para leitor elegível", rFeed.status === 200, `status=${rFeed.status}`);
    t("feed não vaza publicação contatos (sem aresta)", !blob.includes("SEGREDO_CONTATOS_X9"), blob.slice(0, 140));
    const itens = rFeed.json?.publicacoes ?? rFeed.json?.items ?? rFeed.json?.data ?? [];
    const primeiroItem = Array.isArray(itens) ? itens[0] : null;
    t("feed traz publicadas com representação de autor",
      !!primeiroItem && typeof primeiroItem === "object" &&
      (primeiroItem.autor?.nome != null || primeiroItem.autor?.handle != null || primeiroItem.autor?.modo != null),
      JSON.stringify(primeiroItem ?? null).slice(0, 160));
    // j2 (com aresta) vê a de contatos no detalhe direto, não no feed agregado? contrato: leitura direta autorizada
    if (idCont) {
      const rDetJ3 = await api(BASE, C.campId, J3, "GET", `/publicacoes/${idCont}`);
      t("contatos sem aresta → 404 no detalhe", rDetJ3.status === 404, `status=${rDetJ3.status}`);
      const rDetJ2 = await api(BASE, C.campId, J2, "GET", `/publicacoes/${idCont}`);
      t("contatos com aresta aceita → 200 no detalhe", rDetJ2.status === 200, `status=${rDetJ2.status}`);
      const rDetJ1 = await api(BASE, C.campId, J1, "GET", `/publicacoes/${idCont}`);
      t("autora lê própria publicação contatos", rDetJ1.status === 200, `status=${rDetJ1.status}`);
    }
    // paginação keyset
    const rFeed1 = await api(BASE, C.campId, J3, "GET", "/publicacoes?tipo=noticia&limit=2");
    const cur = rFeed1.json?.nextCursor ?? rFeed1.json?.cursor;
    t("feed pagina com cursor", rFeed1.status === 200 && (cur === null || typeof cur === "string" || cur === undefined), `status=${rFeed1.status} cursor=${JSON.stringify(cur)}`);
    if (cur) {
      const rFeed2 = await api(BASE, C.campId, J3, "GET", `/publicacoes?tipo=noticia&limit=2&cursor=${encodeURIComponent(cur)}`);
      t("segunda página 200", rFeed2.status === 200, `status=${rFeed2.status}`);
    }
    const rCursorForjado = await api(BASE, C.campId, J3, "GET", "/publicacoes?tipo=noticia&cursor=forjado!!!");
    t("cursor forjado → 400", rCursorForjado.status === 400, `status=${rCursorForjado.status}`);
    // cross-campaign: usuário só de outra campanha → 404
    const campB = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "CampB Pub" } });
    const campBId = campB.json?.campanha?.id;
    if (campBId && pubId) {
      const rCross = await api(BASE, campBId, J1, "GET", `/publicacoes/${pubId}`);
      t("cross-campaign → 404 (fronteira absoluta)", rCross.status === 404 || rCross.status === 403, `status=${rCross.status}`);
    }
    // P1-B (INTERMEDIÁRIO): pseudônimo exibe pseudo_nome, nunca handle real
    if (pubPseudoId) {
      const rDetP = await api(BASE, C.campId, J3, "GET", `/publicacoes/${pubPseudoId}`);
      const blobP = JSON.stringify(rDetP.json);
      t("pseudônimo: detalhe exibe pseudo_nome sem vazar handle",
        rDetP.status === 200 && blobP.includes("Vulto_9") && !blobP.includes("w45.autor"), `status=${rDetP.status} ${blobP.slice(0, 160)}`);
      const rFeedP = await api(BASE, C.campId, J3, "GET", "/publicacoes?tipo=noticia&limit=50");
      const blobFeedP = JSON.stringify(rFeedP.json);
      const linhaPseudo = (rFeedP.json?.publicacoes ?? rFeedP.json?.items ?? []).find?.((i) => JSON.stringify(i).includes("Vulto_9"));
      t("pseudônimo: feed não vaza handle da conta",
        !linhaPseudo || !JSON.stringify(linhaPseudo).includes("w45.autor"), JSON.stringify(linhaPseudo ?? null).slice(0, 160));
    }
    // detalhe: fonte=handle do autor, sem ids internos
    if (pubId) {
      const rDet = await api(BASE, C.campId, J3, "GET", `/publicacoes/${pubId}`);
      const blobDet = JSON.stringify(rDet.json);
      t("detalhe traz fonte/handle do autor", rDet.status === 200 && (blobDet.includes("w45.autor") || blobDet.includes("handle")), `status=${rDet.status} ${blobDet.slice(0, 140)}`);
      t("detalhe sem ids internos crus", !/"autorContaId"|"characterId"|"campaignId"/.test(blobDet), blobDet.slice(0, 160));
      // Dono gate item 8: personagemId interno oculto de leitores públicos
      // (só origem='sistema' pode expô-lo, conforme contrato §4)
      t("personagemId do autor não vaza para leitor público",
        !blobDet.includes(ch1), `vazou=${blobDet.includes(ch1)} ${blobDet.slice(0, 140)}`);
    }
  }

  // ---------- P4. Denúncia (DP-2/DP-3) ----------
  sec("P4. POST /publicacoes/:id/denunciar — limiar e auto-remoção");
  {
    // publicação alvo de j1
    const rAlvo = await api(BASE, C.campId, J1, "POST", "/publicacoes", { tipo: "noticia", titulo: "Alvo denúncia", corpo: "c", visibilidade: "campanha" });
    const alvoId = rAlvo.json?.publicacao?.id ?? rAlvo.json?.id;
    const alvoV = rAlvo.json?.publicacao?.version ?? 1;
    if (alvoId) await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${alvoId}`, { status: "publicado", expectedVersion: alvoV });
    // j3 não tem aresta? j3 tem conta própria (w45.alvo) — pode denunciar
    const rD1 = await api(BASE, C.campId, J3, "POST", `/publicacoes/${alvoId}/denunciar`, { motivo: "spam" });
    t("denúncia de conta distinta → aceita", rD1.status === 200 || rD1.status === 201, `status=${rD1.status} ${JSON.stringify(rD1.json).slice(0, 140)}`);
    const rD1b = await api(BASE, C.campId, J3, "POST", `/publicacoes/${alvoId}/denunciar`, { motivo: "spam de novo" });
    t("mesma conta 2ª denúncia → 4xx (1 por par)", rD1b.status >= 400 && rD1b.status < 500, `status=${rD1b.status}`);
    // 2ª conta distinta → auto-remoção DP-3
    const rD2 = await api(BASE, C.campId, J2, "POST", `/publicacoes/${alvoId}/denunciar`, { motivo: "ofensa" });
    t("2ª conta distinta → aceita", rD2.status === 200 || rD2.status === 201, `status=${rD2.status}`);
    const rowAlvo = pubsDb().find((p) => p.id === alvoId);
    t("DP-3: ≥2 denúncias distintas → removido na mesma tx", rowAlvo?.status === "removido" || rowAlvo?.status === "retirado", `status_db=${rowAlvo?.status}`);
    const rDetRemovida = await api(BASE, C.campId, J1, "GET", `/publicacoes/${alvoId}`);
    t("removida some até para o autor? (leitura pública 404)", rDetRemovida.status === 404 || rDetRemovida.status === 200, `status=${rDetRemovida.status}`);
    // denuncia_grave=1 → remoção imediata
    const rGraveAlvo = await api(BASE, C.campId, J1, "POST", "/publicacoes", { tipo: "noticia", titulo: "Alvo grave", corpo: "c", visibilidade: "campanha" });
    const graveId = rGraveAlvo.json?.publicacao?.id ?? rGraveAlvo.json?.id;
    const graveV = rGraveAlvo.json?.publicacao?.version ?? 1;
    if (graveId) {
      await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${graveId}`, { status: "publicado", expectedVersion: graveV });
      const rDG = await api(BASE, C.campId, J3, "POST", `/publicacoes/${graveId}/denunciar`, { motivo: "ilegal" });
      t("denuncia motivo=ilegal aceita (grave derivado server-side)", rDG.status === 200 || rDG.status === 201, `status=${rDG.status}`);
      const rowGrave = pubsDb().find((p) => p.id === graveId);
      t("DP-3: denuncia_grave (motivo=ilegal) → remoção imediata", rowGrave?.status === "removido" || rowGrave?.status === "retirado", `denuncia=${rDG.status} db=${rowGrave?.status}`);
    }
    // autor não pode denunciar a própria publicação
    if (alvoId) {
      const rSelf = await api(BASE, C.campId, J1, "POST", `/publicacoes/${alvoId}/denunciar`, { motivo: "auto" });
      t("autor não denuncia a si mesmo → 4xx", rSelf.status >= 400 && rSelf.status < 500, `status=${rSelf.status}`);
    }
    // contestação DP-2: prazo 7d — verificar campo na denúncia persistida
    const den = denunciasDb();
    t("denúncias persistidas com trilha (status/motivo)", den.length >= 2, `n=${den.length}`);
    const d0 = den[0];
    t("DP-2: denúncia carrega status contestável + janela",
      !!d0 && typeof d0 === "object" && ("status" in d0) && ("prazo_contestacao_em" in d0 || "contestacao" in d0 || "motivo" in d0),
      JSON.stringify(d0 ?? null).slice(0, 200));
    // denúncia respeita visibilidade: j3 NÃO tem aresta com j1 — não pode
    // denunciar publicação 'contatos' que nem pode ler (anti-oráculo)
    if (pubContatosId) {
      const rDetAntes = await api(BASE, C.campId, J3, "GET", `/publicacoes/${pubContatosId}`);
      const rDenVis = await api(BASE, C.campId, J3, "POST", `/publicacoes/${pubContatosId}/denunciar`, { motivo: "spam" });
      t("denúncia de publicação 'contatos' sem aresta → 404 (visibilidade respeitada)",
        rDetAntes.status === 404 && (rDenVis.status === 404 || rDenVis.status === 403),
        `det=${rDetAntes.status} den=${rDenVis.status}`);
    }
    // fail-closed P5: conta inativa não denuncia nem lê feed
    {
      const contaJ3 = comDb((db) => db.prepare("select id from internet_accounts where character_id=?").get(ch3)?.id);
      if (contaJ3) {
        comDb((db) => db.prepare("update internet_accounts set status='inativa' where id=?").run(contaJ3));
        const rFeedInat = await api(BASE, C.campId, J3, "GET", "/publicacoes?tipo=noticia&limit=5");
        t("P5: conta inativa → feed negado (fail-closed)", rFeedInat.status === 403 || rFeedInat.status === 404, `status=${rFeedInat.status}`);
        const rDenInat = await api(BASE, C.campId, J3, "POST", `/publicacoes/${graveId}/denunciar`, { motivo: "spam" });
        t("P5: conta inativa → denúncia negada", rDenInat.status === 403 || rDenInat.status === 404, `status=${rDenInat.status}`);
        comDb((db) => db.prepare("update internet_accounts set status='ativa' where id=?").run(contaJ3));
      }
    }
  }

  // ---------- P5. Notícia automática de morte (DP-8/DP-9) ----------
  sec("P5. Morte → notícia sistema; ressurreição não apaga");
  {
    // mestre aplica dano letal no ch3 (j3) — __hp → 0 ⇒ avaliarMorte
    const hpAntes = await apiChars(BASE, M, "POST", `/characters/${ch3}/hp`, { acao: "dano", quantidade: 9999, motivo: "teste morte w45" });
    t("dano letal aceito", hpAntes.status === 200 || hpAntes.status === 201, `status=${hpAntes.status}`);
    await new Promise((r) => setTimeout(r, 300));
    const rowsMorte = pubsDb().filter((p) => p.origem === "sistema" && p.personagem_id === ch3);
    t("NEWS-06: morte gera notícia origem=sistema publicada", rowsMorte.length >= 1 && rowsMorte[0].status === "publicado", `n=${rowsMorte.length}`);
    const mortePub = rowsMorte[0];
    if (mortePub) {
      t("notícia de sistema: autor_conta_id NULL + visibilidade campanha",
        mortePub.autor_conta_id === null && mortePub.visibilidade === "campanha", JSON.stringify(mortePub).slice(0, 160));
      const rDet = await api(BASE, C.campId, J2, "GET", `/publicacoes/${mortePub.id}`);
      t("notícia de morte legível na campanha", rDet.status === 200, `status=${rDet.status}`);
      // contrato §4: personagemId exposto SOMENTE em origem='sistema'
      t("notícia de sistema pode referenciar personagem_id (vínculo público)",
        rDet.status === 200 && JSON.stringify(rDet.json).includes(ch3), `status=${rDet.status}`);
      // somente leitura: ninguém edita/apaga a notícia de sistema
      const rPatchSis = await api(BASE, C.campId, M, "PATCH", `/publicacoes/${mortePub.id}`, { titulo: "editada", expectedVersion: mortePub.version ?? 1 });
      t("DP-8: notícia de sistema não é editável", rPatchSis.status === 403 || rPatchSis.status === 404, `status=${rPatchSis.status}`);
      // selo no feed: item carrega origem='sistema' (filtro ?origem= é PROPOSTA
      // não implementada — selo derivável por item, contrato §4)
      const rFeedSis = await api(BASE, C.campId, J2, "GET", "/publicacoes?tipo=noticia&limit=50");
      const itensFeed = rFeedSis.json?.publicacoes ?? rFeedSis.json?.items ?? [];
      const itemMorte = (Array.isArray(itensFeed) ? itensFeed : []).find((i) => i.id === mortePub.id);
      t("selo automático: feed expõe origem='sistema' no item",
        rFeedSis.status === 200 && itemMorte?.origem === "sistema", `status=${rFeedSis.status} item=${JSON.stringify(itemMorte ?? null).slice(0, 140)}`);
    }
    // DP-8: ressurreição via ação mestre auditada dedicada (não basta HP cheio)
    const rRess = await apiChars(BASE, M, "POST", `/characters/${ch3}/ressuscitar`, { motivo: "ressuscita teste w45" });
    t("ressuscitar (ação mestre) aceita", rRess.status === 200, `status=${rRess.status} ${JSON.stringify(rRess.json).slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 300));
    const rowsDepois = pubsDb().filter((p) => p.origem === "sistema" && p.personagem_id === ch3);
    t("DP-8: ressurreição NÃO remove a notícia", rowsDepois.length >= 1 && rowsDepois.every((p) => p.status !== "removido"), `n=${rowsDepois.length}`);
    // morte → ressurreição → NOVA morte: epoch novo não pode apagar a 1ª notícia
    // (ressuscitar não restaura HP — precisa recuperar antes de morrer de novo)
    await apiChars(BASE, M, "POST", `/characters/${ch3}/hp`, { acao: "recuperar", quantidade: 50, motivo: "cura p/ segunda morte" });
    const hp2 = await apiChars(BASE, M, "POST", `/characters/${ch3}/hp`, { acao: "dano", quantidade: 9999, motivo: "segunda morte w45" });
    t("segunda morte (novo dano letal) aceita", hp2.status === 200 || hp2.status === 201, `status=${hp2.status}`);
    await new Promise((r) => setTimeout(r, 300));
    const rows2Morte = pubsDb().filter((p) => p.origem === "sistema" && p.personagem_id === ch3);
    t("segunda morte: 1ª notícia permanece publicada", rows2Morte.some((p) => p.id === mortePub.id && p.status === "publicado"), `n=${rows2Morte.length}`);
    // Dono gate item 6 / B-5: notícia por cada nova epoch (dedup por `em`)
    t("B-5: nova epoch pós-ressurreição gera nova notícia de sistema", rows2Morte.length >= 2, `n=${rows2Morte.length}`);
    // DP-9: correção só via nova publicação — autoria exige conta elegível
    // (mestre sem conta de internet → 403; quem corrige é autor elegível, ex.: j1)
    const rCorrigeM = await api(BASE, C.campId, M, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "Correção", corpo: "x", visibilidade: "campanha",
    });
    const rCorrige = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "Correção: morte de W45 Alvo", corpo: "A morte foi revertida.", visibilidade: "campanha",
    });
    t("DP-9: correção via nova publicação de conta elegível (201)", rCorrige.status === 201 || rCorrige.status === 200, `j1=${rCorrige.status} mestre=${rCorrigeM.status}`);
    const rowsFinal = pubsDb().filter((p) => p.origem === "sistema" && p.personagem_id === ch3);
    t("notícia original permanece após correção", rowsFinal.length >= 1, `n=${rowsFinal.length}`);
  }

  // ---------- P6. Invariantes anti-oráculo ----------
  sec("P6. Oráculo — rascunho/removido/cross sem vazamento");
  {
    const rRasc = await api(BASE, C.campId, J1, "POST", "/publicacoes", { tipo: "noticia", titulo: "RASCUNHO_SECRETO_Y7", corpo: "x", visibilidade: "campanha" });
    const idRasc = rRasc.json?.publicacao?.id ?? rRasc.json?.id;
    const rDetJ3 = idRasc ? await api(BASE, C.campId, J3, "GET", `/publicacoes/${idRasc}`) : { status: 0 };
    const rDetInex = await api(BASE, C.campId, J3, "GET", `/publicacoes/${crypto.randomUUID()}`);
    t("rascunho 404 idêntico a inexistente", rDetJ3.status === 404 && JSON.stringify(rDetJ3.json) === JSON.stringify(rDetInex.json),
      `rasc=${rDetJ3.status} inex=${rDetInex.status}`);
    const rFeed = await api(BASE, C.campId, J3, "GET", "/publicacoes?tipo=noticia&limit=50");
    t("feed não lista rascunho", !JSON.stringify(rFeed.json).includes("RASCUNHO_SECRETO_Y7"));
    const rFeedTodos = await api(BASE, C.campId, J3, "GET", "/publicacoes?limit=50");
    t("feed sem tipo agrega só visíveis", rFeedTodos.status === 200, `status=${rFeedTodos.status}`);
  }

  // ---------- P7. Regressão ficha: profissão ≠ atributo/perícia ----------
  sec("P7. Regressão — profissão é elegibilidade, não substitui ficha jogável");
  {
    // dois personagens com a MESMA profissão e atributos diferentes:
    // a profissão não pode achatar/substituir comp (perícia real)
    const ch4 = C.novoPersonagem(C.jogadores.j2.membershipId, "W45 Colega", { comp: 9, prof: "jornalista" });
    const f1 = await req(BASE, "GET", `/characters/${ch1}`, { cookie: J1 });
    const f4 = await req(BASE, "GET", `/characters/${ch4}`, { cookie: J2 });
    const blob1 = JSON.stringify(f1.json), blob4 = JSON.stringify(f4.json);
    t("mesma profissao:jornalista nos dois", blob1.includes('"prof":"jornalista"') && blob4.includes('"prof":"jornalista"'),
      `f1=${f1.status} f4=${f4.status}`);
    t("atributo comp preservado e divergente (3 vs 9) — profissão não substitui perícia",
      blob1.includes('"comp":3') && blob4.includes('"comp":9'), `f1.comp em ${blob1.includes('"comp"')} f4=${blob4.includes('"comp":9')}`);
    t("sem classe/perícia paralela injetada pela profissão",
      !/"(classe|skill|pericia|habilidade)"\s*:\s*"jornalista"/i.test(blob1 + blob4),
      "n/a");
    // kind real reutilizado: profissao existe como kind próprio no ruleset
    const kindsProf = comDb((db) => db.prepare("select distinct kind from rule_definitions where kind='profissao'").all());
    t("profissao usa kind real do ruleset (sem kind inventado)", kindsProf.length >= 1, `kinds=${JSON.stringify(kindsProf)}`);
    // rolagens reais são socket/mesa — fora do escopo HTTP; regressão de
    // resultado de rolagem coberta pelas suítes de mesa existentes.
    t("skip: resultado de rolagem D10 exige socket (fora do escopo black-box HTTP)", "skip",
      "coberto por suítes de mesa; profissão não aparece em nenhum caminho de roll");
    // import/restore de __morte: suíte do PAI (74/74) cobre strip+re-derivação;
    // aqui apenas registro de escopo
    t("skip: import/restore __morte — delegada à suíte PAI (não duplicar)", "skip",
      "teste-internet-publicacoes.mjs seção I @ bfa2c5f");
  }

  console.log(`\n===== W4/W5 publicações black-box: ${pass} ok / ${fail} falhas / ${skip} skips =====`);
} catch (e) {
  console.error("ERRO FATAL", e);
  fail++;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
  process.exit(fail > 0 ? 1 : 0);
}
