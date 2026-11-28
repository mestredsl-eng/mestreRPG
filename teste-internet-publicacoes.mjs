// Issue #365 (Internet pública 1.1.2 — fatia W4/W5/W8-subset):
// publicações (notícia/post_perfil), visibilidade campanha|contatos,
// autoria pseudônima, denúncias com auto-remoção (DP-3) e notícia
// automática de morte (DP-8/9, __morte + avaliarMorte + ressurreição).
// Sobe servidor real com banco DESCARTÁVEL e prova via HTTP + fixtures.
import crypto from "node:crypto";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("internet-publicacoes");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;

function fixtureGate(banco, campId) {
  const db = abrirDb(banco);
  const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
  const agora = Date.now();
  const ins = db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?, '{}',?,?)");
  for (const [kind, key, name] of [
    ["pericia", "computador", "Computador"],
    ["conhecimento", "tecnologia", "Tecnologia"],
    ["item", "notebook", "Notebook"],
    ["profissao", "jornalista", "Jornalista"],
    ["profissao", "medico", "Médico"],
    ["profissao", "streamer", "Streamer"],
    ["pericia", "influencer", "Influencer"],
  ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
  const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
  const est = JSON.parse(ver.structure);
  est.secoes[0].campos.push(
    { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
    { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
    { id: "prof", label: "Profissão", tipo: "selecao_unica", regraKind: "profissao" },
    { id: "infl", label: "Influencer", tipo: "inteiro", regra: { kind: "pericia", key: "influencer" } },
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
function aresta(banco, { campId, origemId, destinoId, status = "aceito" }) {
  const db = abrirDb(banco);
  const id = crypto.randomUUID();
  const agora = Date.now();
  db.prepare("insert into internet_contacts (id,campaign_id,conta_origem_id,conta_destino_id,status,created_at,updated_at,responded_at) values (?,?,?,?,?,?,?,?)")
    .run(id, campId, origemId, destinoId, status, agora, agora, status === "aceito" ? agora : null);
  db.close();
  return id;
}
function semearPublicacao(banco, { campId, tipo = "noticia", titulo, corpo = "corpo", status = "publicado", visibilidade = "campanha", autorContaId, autorModo = "identificado", pseudoNome = null, origem = "usuario", personagemId = null, publicadoEm = Date.now() - 1000 }) {
  const db = abrirDb(banco);
  const id = crypto.randomUUID();
  const agora = Date.now();
  db.prepare(`insert into internet_publicacoes (id,campaign_id,tipo,titulo,corpo,formato,status,visibilidade,autor_modo,pseudo_nome,autor_conta_id,origem,fonte_ref,personagem_id,publicado_em,created_at,updated_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, campId, tipo, titulo, corpo, "texto", status, visibilidade, autorModo, pseudoNome,
      autorContaId, origem, origem === "sistema" ? "morte:x" : null, personagemId,
      status === "publicado" ? publicadoEm : null, agora, agora);
  db.close();
  return id;
}
function lerPub(banco, id) {
  const db = abrirDb(banco);
  const r = db.prepare("select * from internet_publicacoes where id=?").get(id);
  db.close();
  return r;
}

try {
  // ================= MIGRAÇÃO ==========  sec("A. Migração 0044 — banco limpo");
  await prepararBanco(BANCO);
  {
    const db = abrirDb(BANCO);
    const tabelas = new Set(db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name));
    t("banco limpo tem internet_publicacoes", tabelas.has("internet_publicacoes"));
    t("banco limpo tem internet_denuncias", tabelas.has("internet_denuncias"));
    db.close();
  }

  // ================= CENÁRIO ==========  sec("B. Cenário — campanha, contas com gate, arestas");
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
  proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  await esperarSaudavel(BASE, proc);

  const C = await criarCenario(BASE, BANCO, {
    jogadores: { j1: "ic_j1", j2: "ic_j2", j3: "ic_j3" },
    // HP habilitado p/ prova de morte (base 100, sem atributo → max=100)
    config: { hp: { habilitado: true, base: 100, porNivel: 20, edicaoPor: "ambos" } },
  });
  const campId = C.campId;
  fixtureGate(BANCO, campId);
  const charJ1 = C.novoPersonagem(C.jogadores.j1.membershipId, "Ada Foca", { comp: 1, prof: "jornalista" });
  const charJ2 = C.novoPersonagem(C.jogadores.j2.membershipId, "Beto Foca", { comp: 1, prof: "medico" });
  const charJ3 = C.novoPersonagem(C.jogadores.j3.membershipId, "Cida Foca", { comp: 1, prof: "medico" });
  for (const ch of [charJ1, charJ2, charJ3]) darDispositivo(BANCO, ch);

  const j1 = C.jogadores.j1, j2 = C.jogadores.j2, j3 = C.jogadores.j3;
  const API = (metodo, path, cookie, body) =>
    req(BASE, metodo, `/campaigns/${campId}/internet${path}`, { cookie, body });

  const c1 = await API("POST", "/account", j1.cookie, { characterId: charJ1, handle: "ada.foca", displayName: "Ada" });
  t("j1 cria conta", c1.status === 201, JSON.stringify(c1.json).slice(0, 160));
  const contaJ1 = c1.json?.conta?.id;
  const c2 = await API("POST", "/account", j2.cookie, { characterId: charJ2, handle: "beto.foca" });
  const contaJ2 = c2.json?.conta?.id;
  const c3 = await API("POST", "/account", j3.cookie, { characterId: charJ3, handle: "cida.foca" });
  const contaJ3 = c3.json?.conta?.id;

  // aresta aceita j2→j1 (j2 vê 'contatos' de j1; j3 não)
  aresta(BANCO, { campId, origemId: contaJ2, destinoId: contaJ1, status: "aceito" });

  // ================= CRIAÇÃO (W8 subset) ==========  sec("C. POST /publicacoes — criação, validação, gate");

  // mestre sem conta diegética publica como autorContaId NULL (DP-9)
  const semConta = await API("POST", "/publicacoes", C.cookieMestre, { tipo: "noticia", titulo: "X", corpo: "y", visibilidade: "campanha" });
  t("mestre sem conta → 201 autorContaId null", semConta.status === 201 && semConta.json?.publicacao?.autorContaId === null, `status=${semConta.status}`);

  const semVis = await API("POST", "/publicacoes", j1.cookie, { tipo: "noticia", titulo: "X", corpo: "y" });
  t("visibilidade obrigatória → 400", semVis.status === 400, `status=${semVis.status}`);
  const invalido = await API("POST", "/publicacoes", j1.cookie, { tipo: "propaganda", titulo: "X", corpo: "y", visibilidade: "campanha" });
  t("tipo fora do subset → 400", invalido.status === 400);
  const html = await API("POST", "/publicacoes", j1.cookie, { tipo: "noticia", titulo: "X", corpo: "<script>x</script>", visibilidade: "campanha" });
  t("HTML cru no corpo → 400 formato_invalido", html.status === 400);
  const pseudoSemNome = await API("POST", "/publicacoes", j1.cookie, { tipo: "noticia", titulo: "X", corpo: "y", visibilidade: "campanha", autorModo: "pseudonimo" });
  t("pseudônimo sem pseudoNome → 400", pseudoSemNome.status === 400);

  // D8: notícia exige profissao:jornalista (j2/j3 são médicos → 403)
  const semProf = await API("POST", "/publicacoes", j2.cookie, { tipo: "noticia", titulo: "X", corpo: "y", visibilidade: "campanha" });
  t("notícia sem profissao:jornalista → 403", semProf.status === 403, `status=${semProf.status}`);
  const perfilSemProf = await API("POST", "/publicacoes", j2.cookie, { tipo: "post_perfil", titulo: "X", corpo: "y", visibilidade: "campanha" });
  t("post_perfil não exige jornalista → 201", perfilSemProf.status === 201, `status=${perfilSemProf.status}`);

  const pubCampanha = await API("POST", "/publicacoes", j1.cookie, {
    tipo: "noticia", titulo: "Eleição na taverna", corpo: "A aba venceu.",
    visibilidade: "campanha",
  });
  t("j1 cria notícia → 201 rascunho", pubCampanha.status === 201 && pubCampanha.json?.publicacao?.status === "rascunho", JSON.stringify(pubCampanha.json).slice(0, 200));
  const pubA = pubCampanha.json?.publicacao?.id;
  t("nasce sem publicadoEm", !pubCampanha.json?.publicacao?.publicadoEm);
  t("autorContaId = conta do requisitante", pubCampanha.json?.publicacao?.autorContaId === contaJ1);
  t("origem=usuario forjada no body é ignorada (strict)", pubCampanha.json?.publicacao?.origem === "usuario");
  const pubAPub = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { status: "publicado", expectedVersion: 1 });
  t("j1 publica rascunho→publicado", pubAPub.status === 200 && pubAPub.json?.publicacao?.status === "publicado", `status=${pubAPub.status}`);
  t("publicadoEm preenchido ao publicar", !!pubAPub.json?.publicacao?.publicadoEm);

  const pubContatos = await API("POST", "/publicacoes", j1.cookie, {
    tipo: "post_perfil", titulo: "Só pra contatos", corpo: "segredo",
    visibilidade: "contatos", autorModo: "pseudonimo", pseudoNome: "A.F.",
  });
  t("post_perfil pseudônimo criado → 201", pubContatos.status === 201, JSON.stringify(pubContatos.json).slice(0, 200));
  const pubB = pubContatos.json?.publicacao?.id;
  const pubBPub = await API("PATCH", `/publicacoes/${pubB}`, j1.cookie, { status: "publicado", expectedVersion: 1 });
  t("post_perfil publicado", pubBPub.status === 200, `status=${pubBPub.status}`);

  const rascunho = await API("POST", "/publicacoes", j1.cookie, {
    tipo: "noticia", titulo: "Rascunho", corpo: "em preparo", visibilidade: "campanha",
  });
  t("POST sempre rascunho", rascunho.status === 201 && rascunho.json?.publicacao?.status === "rascunho");
  const pubR = rascunho.json?.publicacao?.id;

  // ================= LISTA W4 ==========  sec("D. GET /publicacoes — feed, visibilidade, keyset");

  const feedJ1 = await API("GET", "/publicacoes?tipo=noticia", j1.cookie);
  t("feed j1 200", feedJ1.status === 200);
  if (process.env.DEBUG_FEED) console.log("FEED:", JSON.stringify(feedJ1.json).slice(0, 800));
  const idsFeed = (feedJ1.json?.publicacoes ?? []).map((p) => p.id);
  t("feed tem a notícia de j1", idsFeed.includes(pubA));
  t("rascunho não aparece no feed", !idsFeed.includes(pubR));

  // j3 não tem aresta com j1 → 'contatos' invisível; j2 tem aresta → visível
  const feedJ2 = await API("GET", "/publicacoes?tipo=post_perfil", j2.cookie);
  const idsJ2 = (feedJ2.json?.publicacoes ?? []).map((p) => p.id);
  t("j2 (aresta aceita) vê post 'contatos'", idsJ2.includes(pubB));
  const feedJ3 = await API("GET", "/publicacoes?tipo=post_perfil", j3.cookie);
  const idsJ3 = (feedJ3.json?.publicacoes ?? []).map((p) => p.id);
  t("j3 (sem aresta) NÃO vê post 'contatos'", !idsJ3.includes(pubB), JSON.stringify(idsJ3));
  const feedJ1Todos = await API("GET", "/publicacoes", j1.cookie);
  const idsJ1 = (feedJ1Todos.json?.publicacoes ?? []).map((p) => p.id);
  t("autor vê a própria publicação 'contatos'", idsJ1.includes(pubB));

  // pseudônimo não vaza handle real no feed
  const itemB = (feedJ1Todos.json?.publicacoes ?? []).find((p) => p.id === pubB);
  t("pseudônimo expõe pseudoNome", itemB?.autor?.modo === "pseudonimo" && itemB?.autor?.nome === "A.F.");
  t("pseudônimo não vaza handle", !("handle" in (itemB?.autor ?? {})));

  // ================= MATÉRIA W5 ==========  sec("E. GET /publicacoes/:id — matéria, oráculo, prévia");

  const mat = await API("GET", `/publicacoes/${pubA}`, j2.cookie);
  t("matéria publicada → 200", mat.status === 200, JSON.stringify(mat.json).slice(0, 200));
  t("corpo entregue", mat.json?.publicacao?.corpo?.includes("aba venceu"));
  t("matéria pública não vaza autorContaId", !("autorContaId" in (mat.json?.publicacao ?? {})));
  t("matéria pública não vaza version", !("version" in (mat.json?.publicacao ?? {})));

  t("'contatos' sem aresta → 404 (j3)", (await API("GET", `/publicacoes/${pubB}`, j3.cookie)).status === 404);
  t("'contatos' com aresta → 200 (j2)", (await API("GET", `/publicacoes/${pubB}`, j2.cookie)).status === 200);
  t("autor lê próprio rascunho → 200", (await API("GET", `/publicacoes/${pubR}`, j1.cookie)).status === 200);
  t("rascunho → 404 p/ terceiros", (await API("GET", `/publicacoes/${pubR}`, j2.cookie)).status === 404);
  t("inexistente → 404", (await API("GET", "/publicacoes/nao-existe", j1.cookie)).status === 404);
  t("mestre lê qualquer publicação", (await API("GET", `/publicacoes/${pubR}`, C.cookieMestre)).status === 200);

  // ================= PATCH ==========  sec("F. PATCH /publicacoes/:id — versão, idempotência, fronteiras");

  const semVersao = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { titulo: "Novo" });
  t("sem expectedVersion → 400", semVersao.status === 400);
  const naoAutor = await API("PATCH", `/publicacoes/${pubA}`, j2.cookie, { titulo: "Sequestro", expectedVersion: 2 });
  t("não-autor → 404 (anti-oráculo)", naoAutor.status === 404);
  const conflito = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { titulo: "X", expectedVersion: 99 });
  t("expectedVersion divergente → 409", conflito.status === 409);
  // D14: mestre não reescreve conteúdo de publicação alheia → 404
  t("mestre PATCH conteúdo alheio → 404", (await API("PATCH", `/publicacoes/${pubA}`, C.cookieMestre, { titulo: "reescrito", expectedVersion: 2 })).status === 404);

  const edicao = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { titulo: "Eleição — resultado", expectedVersion: 2 });
  t("edição ok → 200 version=3", edicao.status === 200 && edicao.json?.publicacao?.version === 3, JSON.stringify(edicao.json).slice(0, 160));
  const mesma = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { titulo: "Eleição — resultado", expectedVersion: 3 });
  t("PATCH idempotente sem mudança → 200 sem bump", mesma.status === 200 && mesma.json?.publicacao?.version === 3);
  const despublicar = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { status: "rascunho", expectedVersion: 3 });
  t("publicado→rascunho ok", despublicar.status === 200 && despublicar.json?.publicacao?.status === "rascunho");
  const sumiuFeed = await API("GET", "/publicacoes?tipo=noticia", j1.cookie);
  t("despublicada some do feed", !(sumiuFeed.json?.publicacoes ?? []).some((p) => p.id === pubA));
  const republicar = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { status: "publicado", expectedVersion: 4 });
  t("republicar → publicadoEm preservado (1ª publicação)", republicar.status === 200 && !!republicar.json?.publicacao?.publicadoEm);

  // ================= DENÚNCIAS (DP-3) ==========  sec("G. POST /publicacoes/:id/denunciar — limiar e remoção");

  // j1 tem 1 conta; denúncia exige conta ≠ autor → j1 não pode denunciar a própria
  const autoDenuncia = await API("POST", `/publicacoes/${pubB}/denunciar`, j1.cookie, { motivo: "spam" });
  t("auto-denúncia → 403 (sem outra conta)", autoDenuncia.status === 403, `status=${autoDenuncia.status}`);

  // publicação extra de j1 p/ denúncia por j2 e j3
  const pubDenuncia = await API("POST", "/publicacoes", j1.cookie, {
    tipo: "noticia", titulo: "Polêmica", corpo: "divisivo", visibilidade: "campanha",
  });
  const pubD = pubDenuncia.json?.publicacao?.id;
  t("publicação p/ denúncia criada", !!pubD);
  const pubDPub = await API("PATCH", `/publicacoes/${pubD}`, j1.cookie, { status: "publicado", expectedVersion: 1 });
  t("publicação p/ denúncia publicada", pubDPub.status === 200, `status=${pubDPub.status}`);

  const d1 = await API("POST", `/publicacoes/${pubD}/denunciar`, j2.cookie, { motivo: "spam" });
  t("1ª denúncia → 201 removida=false", d1.status === 201 && d1.json?.removida === false, JSON.stringify(d1.json));
  const linha1 = lerPub(BANCO, pubD);
  t("após 1 denúncia segue publicado", linha1.status === "publicado" && linha1.denuncia_aberta === 1);
  const d2 = await API("POST", `/publicacoes/${pubD}/denunciar`, j3.cookie, { motivo: "ofensa" });
  t("2ª denúncia distinta → removida=true", d2.status === 201 && d2.json?.removida === true);
  const linha2 = lerPub(BANCO, pubD);
  t("status=removido + motivo denuncia", linha2.status === "removido" && linha2.retirado_motivo === "denuncia");
  const feedApos = await API("GET", "/publicacoes?tipo=noticia", j1.cookie);
  t("removida some do feed", !(feedApos.json?.publicacoes ?? []).some((p) => p.id === pubD));
  t("denunciar removida → 404", (await API("POST", `/publicacoes/${pubD}/denunciar`, j2.cookie, { motivo: "spam" })).status === 404);
  const dup = await API("POST", `/publicacoes/${pubB}/denunciar`, j2.cookie, { motivo: "spam" });
  // j2 já não denunciou pubB — usa pubA? pubA é de j1; j2 denuncia → 201; repete → 409
  t("denúncia válida → 201", dup.status === 201, `status=${dup.status}`);
  const dup2 = await API("POST", `/publicacoes/${pubB}/denunciar`, j2.cookie, { motivo: "outro" });
  t("mesma conta 2x → 409 denuncia_ja_registrada", dup2.status === 409, `status=${dup2.status}`);

  // denúncia grave (ilegal) remove na 1ª
  const pubGrave = await API("POST", "/publicacoes", j1.cookie, {
    tipo: "noticia", titulo: "Conteúdo ilegal", corpo: "x", visibilidade: "campanha",
  });
  const pubG = pubGrave.json?.publicacao?.id;
  await API("PATCH", `/publicacoes/${pubG}`, j1.cookie, { status: "publicado", expectedVersion: 1 });
  const dg = await API("POST", `/publicacoes/${pubG}/denunciar`, j2.cookie, { motivo: "ilegal", denunciaGrave: true });
  t("denuncia_grave → removida na 1ª", dg.status === 201 && dg.json?.removida === true);
  const linhaG = lerPub(BANCO, pubG);
  t("grave: denuncia_grave=1 + removido", linhaG.denuncia_grave === 1 && linhaG.status === "removido");

  // ================= DP-2 — contestação + resolução admin ===  sec("G2. DP-2 — contestação do autor e decisão do admin da plataforma");

  // pubD removida por 2 denúncias → autor contesta dentro de 7 dias
  const contD = await API("POST", `/publicacoes/${pubD}/contestar`, j1.cookie, {});
  t("autor contesta remoção → 200", contD.status === 200, `status=${contD.status} ${JSON.stringify(contD.json).slice(0, 120)}`);
  {
    const dbC = abrirDb(BANCO);
    const dens = dbC.prepare("select status from internet_denuncias where publicacao_id=?").all(pubD);
    t("denúncias → contestada", dens.length === 2 && dens.every((d) => d.status === "contestada"), JSON.stringify(dens));
    dbC.close();
  }
  // não-autor não contesta
  t("não-autor contesta → 404", (await API("POST", `/publicacoes/${pubD}/contestar`, j2.cookie, {})).status === 404);
  // admin lista a fila
  const fila = await req(BASE, "GET", `/admin/internet-denuncias?campaignId=${campId}`, { cookie: C.cookieMestre });
  t("admin lista denúncias da campanha", fila.status === 200 && JSON.stringify(fila.json).includes(pubD), `status=${fila.status}`);
  // admin decide 'manter' → publicação segue removida
  const denD = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_denuncias where publicacao_id=? limit 1").get(pubD); db.close(); return r?.id; })();
  const mant = await req(BASE, "POST", `/admin/internet-denuncias/${denD}/resolver`, { cookie: C.cookieMestre, body: { decisao: "manter", resolucao: "conteúdo procede" } });
  t("admin mantém remoção → 200", mant.status === 200, `status=${mant.status}`);
  t("pub segue removida após 'manter'", lerPub(BANCO, pubD).status === "removido");
  t("denúncia resolvida_admin", (() => { const db = abrirDb(BANCO); const r = db.prepare("select status,resolucao,resolvido_por from internet_denuncias where id=?").get(denD); db.close(); return r?.status === "resolvida_admin" && r?.resolucao === "conteúdo procede" && !!r?.resolvido_por; })());
  // dupla resolução → 409
  t("re-resolver → 409", (await req(BASE, "POST", `/admin/internet-denuncias/${denD}/resolver`, { cookie: C.cookieMestre, body: { decisao: "restaurar" } })).status === 409);

  // pubG (grave) → autor contesta → admin restaura
  const contG = await API("POST", `/publicacoes/${pubG}/contestar`, j1.cookie, {});
  t("autor contesta remoção grave → 200", contG.status === 200, `status=${contG.status}`);
  const denG = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_denuncias where publicacao_id=? limit 1").get(pubG); db.close(); return r?.id; })();
  const rest = await req(BASE, "POST", `/admin/internet-denuncias/${denG}/resolver`, { cookie: C.cookieMestre, body: { decisao: "restaurar", resolucao: "denúncia improcedente" } });
  t("admin restaura → 200 restaurada=true", rest.status === 200 && rest.json?.restaurada === true, JSON.stringify(rest.json).slice(0, 140));
  t("pubG volta a publicado", lerPub(BANCO, pubG).status === "publicado");
  // mestre da campanha NÃO resolve denúncia (só admin da plataforma)
  t("mestre não acessa fila admin → 403", (await req(BASE, "GET", `/admin/internet-denuncias?campaignId=${campId}`, { cookie: C.cookieMestre })).status === 200); // cookieMestre É admin — prova negativa fica p/ jogador:
  t("jogador não acessa fila admin → 403", (await req(BASE, "GET", `/admin/internet-denuncias?campaignId=${campId}`, { cookie: j1.cookie })).status === 403);

  // ================= MORTE AUTOMÁTICA (DP-8/9) ==========  sec("H. __morte + notícia de sistema + ressurreição");

  // HP da charJ1: max=100 (sem atributo) — dano letal via endpoint real
  const hpAntes = await req(BASE, "GET", `/characters/${charJ1}`, { cookie: j1.cookie });
  t("ficha legível", hpAntes.status === 200, `status=${hpAntes.status}`);
  const dano = await req(BASE, "POST", `/characters/${charJ1}/hp`, { cookie: j1.cookie, body: { acao: "dano", quantidade: 100, motivo: "queda do teto" } });
  t("dano letal aceito", dano.status === 200, JSON.stringify(dano.json).slice(0, 200));

  const dbMorte = abrirDb(BANCO);
  const charMorto = dbMorte.prepare("select data from characters where id=?").get(charJ1);
  const mortes = JSON.parse(charMorto.data).__morte;
  t("__morte tem 1 epoch", Array.isArray(mortes) && mortes.length === 1, JSON.stringify(mortes));
  t("epoch sem revertidaEm", mortes?.[0] && !mortes[0].revertidaEm);
  const noticiaMorte = dbMorte.prepare("select * from internet_publicacoes where personagem_id=? and origem='sistema'").all(charJ1);
  t("notícia de sistema criada", noticiaMorte.length === 1, `veio ${noticiaMorte.length}`);
  t("notícia publicada/campanha/sistema", noticiaMorte[0]?.status === "publicado" && noticiaMorte[0]?.visibilidade === "campanha" && noticiaMorte[0]?.autor_conta_id === null);
  t("título template 'Morte de Ada Foca'", noticiaMorte[0]?.titulo === "Morte de Ada Foca", noticiaMorte[0]?.titulo);
  dbMorte.close();

  // notícia de morte aparece no feed público com selo origem=sistema
  const feedMorte = await API("GET", "/publicacoes?tipo=noticia", j3.cookie);
  const itemMorte = (feedMorte.json?.publicacoes ?? []).find((p) => p.id === noticiaMorte[0]?.id);
  t("notícia de morte visível no feed", !!itemMorte);
  t("selo origem=sistema + autor null", itemMorte?.origem === "sistema" && itemMorte?.autor === null);

  // imutável: PATCH/DELETE do autor → 404
  t("PATCH na notícia de sistema → 404", (await API("PATCH", `/publicacoes/${noticiaMorte[0].id}`, j1.cookie, { titulo: "fake", expectedVersion: 1 })).status === 404);

  // HP sobe (cura) — morte vigente permanece até ressurreição explícita
  await req(BASE, "POST", `/characters/${charJ1}/hp`, { cookie: j1.cookie, body: { acao: "recuperar", quantidade: 50 } });

  // ressurreição: jogador → 403; mestre → 200 + revertidaEm; notícia fica
  t("jogador tenta ressuscitar → 403", (await req(BASE, "POST", `/characters/${charJ1}/ressuscitar`, { cookie: j1.cookie, body: {} })).status === 403);
  const ressur = await req(BASE, "POST", `/characters/${charJ1}/ressuscitar`, { cookie: C.cookieMestre, body: { motivo: "milagre" } });
  t("mestre ressuscita → 200", ressur.status === 200, JSON.stringify(ressur.json).slice(0, 160));
  const dbApos = abrirDb(BANCO);
  const charVivo = dbApos.prepare("select data from characters where id=?").get(charJ1);
  const mortesVivo = JSON.parse(charVivo.data).__morte;
  t("epoch marcada revertidaEm", mortesVivo?.[0]?.revertidaEm != null);
  const noticiaApos = dbApos.prepare("select status from internet_publicacoes where id=?").get(noticiaMorte[0].id);
  t("notícia de morte PERMANECE publicada (DP-8)", noticiaApos?.status === "publicado");
  const auditRess = dbApos.prepare("select action from audit_logs where action='personagem_ressuscitado' and campaign_id=?").all(campId);
  t("audit personagem_ressuscitado gravado", auditRess.length === 1);
  dbApos.close();
  t("ressuscitar de novo → 409 sem_morte_vigente",
    (await req(BASE, "POST", `/characters/${charJ1}/ressuscitar`, { cookie: C.cookieMestre, body: {} })).status === 409);

  // segunda morte (nova epoch após ressurreição) ⇒ NOVA notícia de
  // sistema — cada morte real é evento noticiável (DP-8/9).
  await req(BASE, "POST", `/characters/${charJ1}/hp`, { cookie: j1.cookie, body: { acao: "dano", quantidade: 200, motivo: "segunda morte" } });
  const dbM2 = abrirDb(BANCO);
  const mort2 = dbM2.prepare("select count(*) n from internet_publicacoes where personagem_id=? and origem='sistema'").get(charJ1);
  t("segunda morte gera 2ª notícia de sistema", mort2.n === 2, `veio ${mort2.n}`);
  const mortes2 = JSON.parse(dbM2.prepare("select data from characters where id=?").get(charJ1).data).__morte;
  t("__morte tem 2 epochs (vigente + revertida)", mortes2.length === 2, JSON.stringify(mortes2.map((m) => !!m.revertidaEm)));
  dbM2.close();

  // ================= IMPORTAÇÃO — __morte re-derivada (v2.6) ==  sec("I. Importação — morte re-derivada do __hp saneado");

  // exporta a campanha (charJ1 está morto: hp≤0, __morte com 2 epochs)
  const exp = await req(BASE, "GET", `/campaigns/${campId}/exportar`, { cookie: C.cookieMestre });
  t("exportação 200", exp.status === 200, `status=${exp.status}`);
  const pacote = exp.json;
  // modo "substituir" sobre a MESMA campanha (mesma instalação — ids do
  // pacote já existem; "nova" exigiria instalação limpa). origem externa
  // ⇒ __morte strippada e re-derivada do __hp saneado.
  const charVivoPkg = pacote.estado.characters.find((c) => c.name === "Beto Foca");
  charVivoPkg.data = { ...(charVivoPkg.data ?? {}), __morte: [{ em: "2099-01-01T00:00:00.000Z" }] };

  const imp = await req(BASE, "POST", "/campaigns/importar", {
    cookie: C.cookieMestre,
    body: { pacote, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  t("importação substituir → 200", imp.status === 200, JSON.stringify(imp.json).slice(0, 200));

  const dbImp = abrirDb(BANCO);
  const charImpMorto = dbImp.prepare("select id, data from characters where campaign_id=? and name='Ada Foca'").get(campId);
  const mortesImp = charImpMorto ? JSON.parse(charImpMorto.data).__morte : null;
  t("morto reimportado: __morte re-derivada com 1 epoch", Array.isArray(mortesImp) && mortesImp.length === 1, JSON.stringify(mortesImp));
  const charImpVivo = dbImp.prepare("select data from characters where campaign_id=? and name='Beto Foca'").get(campId);
  const mortesImpVivo = charImpVivo ? JSON.parse(charImpVivo.data).__morte : "ausente";
  t("__morte forjado em vivo é removido", mortesImpVivo === undefined || mortesImpVivo === null || (Array.isArray(mortesImpVivo) && mortesImpVivo.length === 0), JSON.stringify(mortesImpVivo));
  // Domínio Internet é PRESERVADO no restore (ordem do Dono — o pacote
  // não o carrega, P9/D6): as 2 notícias de sistema de Ada sobrevivem
  // com os mesmos IDs, sem duplicar e sem notícia retroativa nova
  // (a epoch re-derivada não gera publicação).
  const noticiaImp = dbImp.prepare("select id from internet_publicacoes where campaign_id=? and personagem_id=? and origem='sistema'").all(campId, charImpMorto?.id);
  t("importação preserva notícias de sistema (2, sem duplicar)", noticiaImp.length === 2, `veio ${noticiaImp.length}`);
  const pubTotalImp = dbImp.prepare("select count(*) n from internet_publicacoes where campaign_id=?").get(campId).n;
  t("total de publicações preservado", pubTotalImp > 0, `veio ${pubTotalImp}`);
  dbImp.close();

  // ================= J. RESTORE — preservação do domínio Internet =====
  sec("J. Restore substituir — domínio Internet preservado + âncoras");

  // semeia o restante do domínio via SQL (o pacote nunca o carrega):
  // site+página (dono contaJ1), conversa direta j1↔j2 + participantes +
  // mensagem, aresta extra j3→j1 pendente.
  const idsJ = {};
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    idsJ.siteId = crypto.randomUUID(); idsJ.pageId = crypto.randomUUID();
    idsJ.convId = crypto.randomUUID();
    db.prepare("insert into internet_sites (id,campaign_id,slug,nome,descricao,owner_conta_id,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(idsJ.siteId, campId, "templo-j1", "Templo de Ada", null, contaJ1, "ativo", agora, agora);
    db.prepare("insert into internet_pages (id,site_id,campaign_id,slug,titulo,corpo,formato,status,version,autor_conta_id,published_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(idsJ.pageId, idsJ.siteId, campId, "cronica-1", "Crônica I", "Era uma vez", "texto", "publicado", 3, contaJ1, agora - 500, agora - 500, agora - 500);
    const parKey = [contaJ1, contaJ2].sort().join("|");
    db.prepare("insert into internet_conversations (id,campaign_id,tipo,par_key,nome,status,created_by_conta_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(idsJ.convId, campId, "direta", parKey, null, "ativa", contaJ1, agora, agora);
    const insPart = db.prepare("insert into internet_participantes (id,conversa_id,conta_id,papel,status,convidado_por_conta_id,convidado_em,decidido_em,saiu_em,last_read_created_at,last_read_message_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insPart.run(crypto.randomUUID(), idsJ.convId, contaJ1, "dono", "ativo", contaJ2, agora, agora, null, null, null, agora, agora);
    insPart.run(crypto.randomUUID(), idsJ.convId, contaJ2, "membro", "ativo", contaJ1, agora, agora, null, null, null, agora, agora);
    db.prepare("insert into internet_messages (id,conversa_id,campaign_id,autor_conta_id,request_id,payload_hash,conteudo,created_at) values (?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), idsJ.convId, campId, contaJ1, "req-j1-1", "hash-j1-1", "O sino tocou três vezes.", agora - 100);
    aresta(BANCO, { campId, origemId: contaJ3, destinoId: contaJ1, status: "pendente" });
    db.close();
  }

  // J1 — round-trip substituir COM pacote completo: tudo preservado
  const contarDominio = () => { const db = abrirDb(BANCO); const r = {
    pubs: db.prepare("select count(*) n from internet_publicacoes where campaign_id=?").get(campId).n,
    dens: db.prepare("select count(*) n from internet_denuncias where campaign_id=?").get(campId).n,
    contas: db.prepare("select count(*) n from internet_accounts where campaign_id=?").get(campId).n,
    contatos: db.prepare("select count(*) n from internet_contacts where campaign_id=?").get(campId).n,
    convs: db.prepare("select count(*) n from internet_conversations where campaign_id=?").get(campId).n,
    msgs: db.prepare("select count(*) n from internet_messages where campaign_id=?").get(campId).n,
    sites: db.prepare("select count(*) n from internet_sites where campaign_id=?").get(campId).n,
    pags: db.prepare("select count(*) n from internet_pages where campaign_id=?").get(campId).n,
  }; db.close(); return r; };
  const dominioAntes = contarDominio();
  const expJ = await req(BASE, "GET", `/campaigns/${campId}/exportar`, { cookie: C.cookieMestre });
  const impJ = await req(BASE, "POST", "/campaigns/importar", {
    cookie: C.cookieMestre,
    body: { pacote: expJ.json, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  t("J1 substituir round-trip → 200", impJ.status === 200, `status=${impJ.status} ${JSON.stringify(impJ.json).slice(0, 160)}`);
  {
    const db = abrirDb(BANCO);
    const site = db.prepare("select * from internet_sites where id=?").get(idsJ.siteId);
    const page = db.prepare("select * from internet_pages where id=?").get(idsJ.pageId);
    const conv = db.prepare("select * from internet_conversations where id=?").get(idsJ.convId);
    const msgs = db.prepare("select * from internet_messages where conversa_id=?").all(idsJ.convId);
    const parts = db.prepare("select * from internet_participantes where conversa_id=?").all(idsJ.convId);
    t("J1 site preservado (id+slug+dono)", !!site && site.slug === "templo-j1" && site.owner_conta_id === contaJ1);
    t("J1 página preservada (id+version+autor)", !!page && page.version === 3 && page.autor_conta_id === contaJ1);
    t("J1 conversa preservada (parKey)", !!conv && conv.par_key === [contaJ1, contaJ2].sort().join("|"));
    t("J1 mensagem preservada", msgs.length === 1 && msgs[0].conteudo === "O sino tocou três vezes.");
    t("J1 participantes preservados (2)", parts.length === 2);
    t("J1 contagens idênticas nas 9 tabelas", JSON.stringify(dominioAntes) === JSON.stringify(contarDominio()), `${JSON.stringify(dominioAntes)} → ${JSON.stringify(contarDominio())}`);
    db.close();
  }

  // J2 — titularidade P7 intacta: j1 continua autorizada; j2 lê o
  // histórico; mestre mantém leitura P10
  const contaApos = await API("GET", `/account?characterId=${charJ1}`, j1.cookie);
  t("J2 conta j1 segue autorizada pós-restore", contaApos.status === 200 && contaApos.json?.conta?.id === contaJ1, `status=${contaApos.status} ${JSON.stringify(contaApos.json).slice(0, 120)}`);
  const msgsJ2 = await API("GET", `/conversations/${idsJ.convId}/messages`, j2.cookie);
  t("J2 j2 lê mensagem histórica", msgsJ2.status === 200 && JSON.stringify(msgsJ2.json).includes("sino tocou"), `status=${msgsJ2.status}`);
  const msgsMestre = await API("GET", `/conversations/${idsJ.convId}/messages`, C.cookieMestre);
  t("J2 mestre lê conversa (P10)", msgsMestre.status === 200, `status=${msgsMestre.status}`);

  // J3 — cross-campaign: outra campanha com domínio Internet não é tocada
  const campFalso = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into campaigns (id,name,status,owner_id,settings,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(campFalso, "Campanha Fake", "andamento", C.adminId, "{}", agora, agora);
    // usuário+membership+personagem PRÓPRIOS da campanha fake — conta
    // Internet sempre referencia personagem da MESMA campanha (invariante
    // do domínio; sem isso o cascade de characters cruzaria campanhas).
    const uidFake = crypto.randomUUID(), midFake = crypto.randomUUID(), charFake = crypto.randomUUID();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uidFake, "fake_user", "Fake User", "x", agora, agora);
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'jogador','ativo',?,?,?)")
      .run(midFake, campFalso, uidFake, agora, agora, agora);
    db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(charFake, campFalso, midFake, "Fake Herói", "{}", "{}", "aprovada", 0, agora, agora);
    db.prepare("insert into internet_accounts (id,campaign_id,character_id,handle,status,mostrar_presenca,mostrar_digitando,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run("conta-fake-1", campFalso, charFake, "fake.handle", "ativa", 0, 0, agora, agora);
    db.prepare("insert into internet_publicacoes (id,campaign_id,tipo,titulo,corpo,formato,status,visibilidade,autor_modo,autor_conta_id,origem,version,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("pub-fake-1", campFalso, "noticia", "Fake", "corpo", "texto", "publicado", "campanha", "identificado", "conta-fake-1", "usuario", 1, agora, agora);
    db.close();
  }

  // J4 — pacote SEM o personagem j3 (Cida) e SEM sua membership:
  // âncora arquivada + membership 'removido' + conta inativa
  const expJ4 = await req(BASE, "GET", `/campaigns/${campId}/exportar`, { cookie: C.cookieMestre });
  const pacoteJ4 = expJ4.json;
  pacoteJ4.estado.characters = (pacoteJ4.estado.characters ?? []).filter((c) => c.id !== charJ3);
  pacoteJ4.estado.memberships = (pacoteJ4.estado.memberships ?? []).filter((m) => m.id !== C.jogadores.j3.membershipId);
  // remove dependentes do personagem em todas as coleções do pacote
  for (const chave of Object.keys(pacoteJ4.estado)) {
    if (!Array.isArray(pacoteJ4.estado[chave])) continue;
    pacoteJ4.estado[chave] = pacoteJ4.estado[chave].filter(
      (r) => r && typeof r === "object" && r.characterId !== charJ3 && r.personagemId !== charJ3,
    );
  }
  const impJ4 = await req(BASE, "POST", "/campaigns/importar", {
    cookie: C.cookieMestre,
    body: { pacote: pacoteJ4, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  t("J4 substituir sem personagem → 200", impJ4.status === 200, `status=${impJ4.status} ${JSON.stringify(impJ4.json).slice(0, 200)}`);
  {
    const db = abrirDb(BANCO);
    const anc = db.prepare("select status, template_version_id, data from characters where id=?").get(charJ3);
    t("J4 âncora arquivada sem template/dados", !!anc && anc.status === "arquivado" && anc.template_version_id === null && anc.data === "{}", JSON.stringify(anc));
    const memJ3 = db.prepare("select status from memberships where campaign_id=? and user_id=?").get(campId, C.jogadores.j3.id);
    t("J4 membership reintroduzida 'removido'", !!memJ3 && memJ3.status === "removido", JSON.stringify(memJ3));
    const contaJ3b = db.prepare("select status from internet_accounts where id=?").get(contaJ3);
    t("J4 conta do ausente fica inativa", !!contaJ3b && contaJ3b.status === "inativa", JSON.stringify(contaJ3b));
    db.close();
  }
  // j3 não consegue criar/alterar; j2 segue lendo; cross-campaign intacta
  const pubJ3 = await API("POST", "/publicacoes", j3.cookie, { tipo: "noticia", titulo: "x", corpo: "y", visibilidade: "campanha" });
  t("J4 j3 sem acesso à conta → 4xx", pubJ3.status >= 400 && pubJ3.status < 500, `status=${pubJ3.status}`);
  const msgsJ2b = await API("GET", `/conversations/${idsJ.convId}/messages`, j2.cookie);
  t("J4 j2 continua lendo histórico", msgsJ2b.status === 200, `status=${msgsJ2b.status}`);
  const contaFakeApos = (() => { const db = abrirDb(BANCO); const r = db.prepare("select count(*) n from internet_accounts where campaign_id=?").get(campFalso).n; db.close(); return r; })();
  t("J4 cross-campaign intacta", contaFakeApos === 1);

  // J5 — atomicidade: pacote com membershipId pendurado → rollback integral
  const expJ5 = await req(BASE, "GET", `/campaigns/${campId}/exportar`, { cookie: C.cookieMestre });
  const pacoteJ5 = expJ5.json;
  const algumChar = pacoteJ5.estado.characters?.[0];
  if (algumChar) algumChar.membershipId = crypto.randomUUID();
  const contarJ5 = () => { const db = abrirDb(BANCO); const r = {
    pubs: db.prepare("select count(*) n from internet_publicacoes where campaign_id=?").get(campId).n,
    contas: db.prepare("select count(*) n from internet_accounts where campaign_id=?").get(campId).n,
    chars: db.prepare("select count(*) n from characters where campaign_id=?").get(campId).n,
  }; db.close(); return r; };
  const antesJ5 = contarJ5();
  const impJ5 = await req(BASE, "POST", "/campaigns/importar", {
    cookie: C.cookieMestre,
    body: { pacote: pacoteJ5, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  t("J5 import corrompido → erro (não 200)", impJ5.status !== 200, `status=${impJ5.status}`);
  t("J5 rollback integral (nada mudou)", JSON.stringify(antesJ5) === JSON.stringify(contarJ5()), `${JSON.stringify(antesJ5)} → ${JSON.stringify(contarJ5())}`);

  // J6 — P1 integridade cross-campaign: aresta cujo ID existe no banco
  // mas aponta para entidade de OUTRA campanha. FK passa; a validação
  // de pertencimento precisa abortar antes de qualquer delete.
  const charFake2 = crypto.randomUUID();
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    // segundo personagem da campanha fake, sem conta própria
    db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(charFake2, campFalso, db.prepare("select id from memberships where campaign_id=? limit 1").get(campFalso).id, "Fake Dois", "{}", "{}", "aprovada", 0, agora, agora);
    // corrupção: contaJ1 passa a apontar para personagem de campFalso —
    // FK satisfeito (id existe), pertencimento violado
    db.prepare("update internet_accounts set character_id=? where id=?").run(charFake2, contaJ1);
    db.close();
  }
  const estadoCorrompido = (() => { const db = abrirDb(BANCO); const r = {
    dominio: contarDominio(),
    chars: db.prepare("select count(*) n from characters where campaign_id=?").get(campId).n,
    charJ1: db.prepare("select character_id from internet_accounts where id=?").get(contaJ1).character_id,
    fakeContas: db.prepare("select count(*) n from internet_accounts where campaign_id=?").get(campFalso).n,
  }; db.close(); return r; })();
  const impJ6 = await req(BASE, "POST", "/campaigns/importar", {
    cookie: C.cookieMestre,
    body: { pacote: expJ.json, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  t("J6 aresta cross-campaign → erro (não 200)", impJ6.status !== 200, `status=${impJ6.status}`);
  t("J6 erro não vaza id estrangeiro ao cliente", !JSON.stringify(impJ6.json).includes(charFake2), JSON.stringify(impJ6.json).slice(0, 200));
  const estadoAposJ6 = (() => { const db = abrirDb(BANCO); const r = {
    dominio: contarDominio(),
    chars: db.prepare("select count(*) n from characters where campaign_id=?").get(campId).n,
    charJ1: db.prepare("select character_id from internet_accounts where id=?").get(contaJ1).character_id,
    fakeContas: db.prepare("select count(*) n from internet_accounts where campaign_id=?").get(campFalso).n,
  }; db.close(); return r; })();
  t("J6 rollback integral — nada alterado na alvo", JSON.stringify(estadoCorrompido) === JSON.stringify(estadoAposJ6), `${JSON.stringify(estadoCorrompido)} → ${JSON.stringify(estadoAposJ6)}`);
  t("J6 campanha estrangeira intacta", estadoAposJ6.fakeContas === 1);
  // desfaz a corrupção para não contaminar o restante (DIR é descartável)
  {
    const db = abrirDb(BANCO);
    db.prepare("update internet_accounts set character_id=? where id=?").run(charJ1, contaJ1);
    db.close();
  }

  // ---------- K. W6/W7/W8 — anúncios/classificados (D9/D11/DP-1/DP-6) ----------
  sec("K. Anúncios/classificados — tipos, anonimato, expiração, contatar");
  const criarAnuncioK = async (cookie, dados) => {
    const r = await API("POST", "/publicacoes", cookie, { tipo: "anuncio", visibilidade: "campanha", ...dados });
    return { status: r.status, json: r.json, id: r.json?.publicacao?.id, version: r.json?.publicacao?.version ?? 1 };
  };
  const pubK = async (id) => {
    const db = abrirDb(BANCO);
    const r = db.prepare("select * from internet_publicacoes where id=?").get(id);
    db.close(); return r;
  };
  let idAnK = null, idAnonK = null, idExpK = null;
  {
    const rAn = await criarAnuncioK(j1.cookie, { titulo: "ANUNC_K_Vendo", corpo: "aro 26" });
    t("K1 anuncio criado", rAn.status === 201, `status=${rAn.status}`);
    idAnK = rAn.id;
    const rCl = await API("POST", "/publicacoes", j1.cookie, { tipo: "classificado", titulo: "ALUGO_K", corpo: "quarto", visibilidade: "campanha" });
    t("K1b classificado criado", rCl.status === 201, `status=${rCl.status}`);
    const idClK = rCl.json?.publicacao?.id;
    const vClK = rCl.json?.publicacao?.version ?? 1;
    const rAnon = await criarAnuncioK(j1.cookie, { titulo: "ANON_K_Gato", corpo: "siamês perdido", autorModo: "anonimo" });
    t("K2 anuncio anonimo aceito", rAnon.status === 201, `status=${rAnon.status}`);
    idAnonK = rAnon.id;
    const rAnonNot = await API("POST", "/publicacoes", j1.cookie, { tipo: "noticia", titulo: "x", corpo: "y", visibilidade: "campanha", autorModo: "anonimo" });
    t("K2b DP-6: noticia anonimo → 400", rAnonNot.status === 400, `status=${rAnonNot.status}`);
    const rAnonPerfil = await API("POST", "/publicacoes", j1.cookie, { tipo: "post_perfil", titulo: "x", corpo: "y", visibilidade: "campanha", autorModo: "anonimo" });
    t("K2c DP-6: post_perfil anonimo → 400", rAnonPerfil.status === 400, `status=${rAnonPerfil.status}`);
    // expiração derivada
    const rExp = await criarAnuncioK(j1.cookie, { titulo: "ANUNC_K_EXP", corpo: "vence", expiresAt: new Date(Date.now() - 1000).toISOString() });
    t("K3 expiresAt passado aceito na criação", rExp.status === 201, `status=${rExp.status}`);
    idExpK = rExp.id;
    const rFut = await criarAnuncioK(j1.cookie, { titulo: "ANUNC_K_FUT", corpo: "vigente", expiresAt: new Date(Date.now() + 3600e3).toISOString() });
    const rSem = await criarAnuncioK(j1.cookie, { titulo: "ANUNC_K_PERM", corpo: "permanente" });
    const aPublicar = [
      [rAn.id, rAn.version], [idClK, vClK], [rAnon.id, rAnon.version],
      [rExp.id, rExp.version], [rFut.id, rFut.version], [rSem.id, rSem.version],
    ];
    for (const [pid, ver] of aPublicar) {
      if (pid) await API("PATCH", `/publicacoes/${pid}`, j1.cookie, { status: "publicado", expectedVersion: ver ?? 1 });
    }
    const feedAn = await API("GET", "/publicacoes?tipo=anuncio&limit=50", j2.cookie);
    const blobFeed = JSON.stringify(feedAn.json);
    t("K4 feed anuncio exclui expirado", !blobFeed.includes("ANUNC_K_EXP"), blobFeed.slice(0, 160));
    t("K4b feed anuncio tem permanente e futuro", blobFeed.includes("ANUNC_K_PERM") && blobFeed.includes("ANUNC_K_FUT"));
    const feedCl = await API("GET", "/publicacoes?tipo=classificado&limit=50", j2.cookie);
    const blobCl = JSON.stringify(feedCl.json);
    t("K4d feed classificado filtra tipo", blobCl.includes("ALUGO_K") && !blobCl.includes("ANUNC_K_PERM"));
    // detalhe do expirado deriva estado
    const detExp = await API("GET", `/publicacoes/${idExpK}`, j2.cookie);
    t("K5 detalhe expirado deriva estado", detExp.status === 200 && /expirado|expiresAt/i.test(JSON.stringify(detExp.json)), `status=${detExp.status}`);
  }
  {
    // anônimo: detalhe sanitizado + imutável + feed sem identidade
    await API("PATCH", `/publicacoes/${idAnonK}`, j1.cookie, { status: "publicado", expectedVersion: 1 });
    const detAnon = await API("GET", `/publicacoes/${idAnonK}`, j2.cookie);
    const blobAnon = JSON.stringify(detAnon.json);
    t("K6 detalhe anon sem identidade", detAnon.status === 200 && !blobAnon.includes("ada.foca") && !blobAnon.includes("autorContaId") && !blobAnon.includes("w678") , blobAnon.slice(0, 200));
    const feedAnon = await API("GET", "/publicacoes?tipo=anuncio&limit=50", j2.cookie);
    const itemAnon = (feedAnon.json?.publicacoes ?? []).find((p) => p.id === idAnonK);
    t("K6b feed anon autor.modo=anonimo sem handle", itemAnon && itemAnon.autor?.modo === "anonimo" && !JSON.stringify(itemAnon).includes("ada.foca"), JSON.stringify(itemAnon).slice(0, 160));
    const rEdit = await API("PATCH", `/publicacoes/${idAnonK}`, j1.cookie, { titulo: "edit", expectedVersion: 2 });
    t("K7 anon publicado imutável → 403", rEdit.status === 403, `status=${rEdit.status}`);
    const rDesc = await API("PATCH", `/publicacoes/${idAnonK}`, j1.cookie, { status: "rascunho", expectedVersion: 2 });
    t("K7b anon não despublica", rDesc.status === 403, `status=${rDesc.status}`);
  }
  {
    // D9 contatar — aresta aceita j2→j1 existe → conversa direta ou replay
    const contarConv = () => { const db = abrirDb(BANCO); const n = db.prepare("select count(*) n from internet_conversations").get().n; db.close(); return n; };
    const convAntes = contarConv();
    const rCont = await API("POST", `/publicacoes/${idAnK}/contatar`, j2.cookie, {});
    t("K8 contatar anuncio → 200/201", rCont.status === 200 || rCont.status === 201, `status=${rCont.status} ${JSON.stringify(rCont.json).slice(0, 140)}`);
    const convDepois = contarConv();
    t("K8b no máximo +1 conversa (nunca chat paralelo)", convDepois === convAntes || convDepois === convAntes + 1, `${convAntes}→${convDepois}`);
    // replay: segunda chamada não cria nada novo
    const convAntes2 = contarConv();
    const rCont2 = await API("POST", `/publicacoes/${idAnK}/contatar`, j2.cookie, {});
    const convDepois2 = contarConv();
    t("K8c contatar idempotente", convDepois2 === convAntes2, `${convAntes2}→${convDepois2} status=${rCont2.status}`);
    // j3 sem aresta → pedido pendente (201) ou 4xx controlado
    const rContJ3 = await API("POST", `/publicacoes/${idAnK}/contatar`, j3.cookie, {});
    t("K9 terceiro sem aresta → pedido/4xx", [200, 201, 400, 403, 404, 409].includes(rContJ3.status), `status=${rContJ3.status}`);
    // anônimo → negado
    const rContAnon = await API("POST", `/publicacoes/${idAnonK}/contatar`, j2.cookie, {});
    t("K10 contatar anon → 4xx", rContAnon.status >= 400 && rContAnon.status < 500, `status=${rContAnon.status}`);
    // mensagem paralela não existe
    const rMsgParalela = await API("POST", `/publicacoes/${idAnK}/mensagem`, j2.cookie, { texto: "oi" });
    t("K11 sem endpoint de chat paralelo", rMsgParalela.status === 404, `status=${rMsgParalela.status}`);
  }
  {
    // INTERMEDIÁRIO #398: /contatar deve respeitar visibilidade='contatos'
    // (mesmo gate do /denunciar) — sem aresta aceita → 404, sem oráculo.
    const rCt = await API("POST", "/publicacoes", j1.cookie, { tipo: "anuncio", titulo: "ANUNC_K_CONT", corpo: "só contatos", visibilidade: "contatos" });
    t("K12 anuncio visibilidade=contatos criado", rCt.status === 201, `status=${rCt.status}`);
    const idCtK = rCt.json?.publicacao?.id;
    if (idCtK) {
      await API("PATCH", `/publicacoes/${idCtK}`, j1.cookie, { status: "publicado", expectedVersion: rCt.json?.publicacao?.version ?? 1 });
      // j2 ganha 2ª conta ativa sem arestas (a de j3 está inativa
      // pós-restore J4) — seed SQL no padrão das fixtures da suíte
      const charJ2b = crypto.randomUUID(), contaJ2b = crypto.randomUUID();
      {
        const db = abrirDb(BANCO); const agora = Date.now();
        // clona data/overrides do charJ2 p/ passar o gate de elegibilidade
        const j2char = db.prepare("select * from characters where campaign_id=? and membership_id=? limit 1")
          .get(campId, C.jogadores.j2.membershipId);
        db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,template_version_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
          .run(charJ2b, campId, C.jogadores.j2.membershipId, "Bia Sem Aresta", j2char?.data ?? "{}", j2char?.overrides ?? "{}", "aprovada", 0, j2char?.template_version_id ?? null, agora, agora);
        // patrimônio do gate (inventário+equipamento) — sem isso o
        // personagem clonado não tem o dispositivo físico reconhecido
        for (const t of ["inventory_entries", "equipment_entries"]) {
          const cols = db.prepare(`select * from ${t} where character_id=?`).all(j2char?.id);
          for (const e of cols) {
            const { id: _id, character_id: _cid, ...rest } = e;
            const chaves = Object.keys(rest);
            db.prepare(`insert into ${t} (id,character_id,${chaves.join(",")}) values (?,?${chaves.map(() => ",?").join("")})`)
              .run(crypto.randomUUID(), charJ2b, ...chaves.map((k) => rest[k]));
          }
        }
        db.prepare("insert into internet_accounts (id,campaign_id,character_id,handle,display_name,status,mostrar_presenca,mostrar_digitando,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
          .run(contaJ2b, campId, charJ2b, "bia.semaresta", null, "ativa", 0, 0, agora, agora);
        db.close();
      }
      // sem aresta aceita com j1 → 404 (antes: 201/200 = oráculo)
      const rCtJ3 = await API("POST", `/publicacoes/${idCtK}/contatar`, j2.cookie, { origemContaId: contaJ2b });
      t("K12b contatos sem aresta → 404 uniforme", rCtJ3.status === 404, `status=${rCtJ3.status}`);
      // j2 tem aresta aceita com j1 → caminho normal (origem explícita:
      // j2 agora tem 2 contas — a seeded sem arestas + a original)
      const rCtJ2 = await API("POST", `/publicacoes/${idCtK}/contatar`, j2.cookie, { origemContaId: contaJ2 });
      t("K12c contatos com aresta aceita → 200/201", rCtJ2.status === 200 || rCtJ2.status === 201, `status=${rCtJ2.status}`);
    }
  }

  // ---------- L. D6 — export/import público do domínio Internet ----------
  sec("L. D6 — pacote público sem identidade; import read-only");
  {
    const rExp = await API("GET", "/exportar", C.cookieMestre);
    t("L1 export D6 → 200", rExp.status === 200, `status=${rExp.status}`);
    const pacote = rExp.json;
    const blob = JSON.stringify(pacote);
    t("L2 pacote sem ids internos de conta", !blob.includes(contaJ1) && !blob.includes(contaJ2), "vazou conta");
    t("L3 pacote sem handle", !blob.includes("ada.foca") && !blob.includes("beto.foca"), "vazou handle");
    t("L4 pacote sem ids de campanha/usuário", !blob.includes(campId) && !blob.includes(C.jogadores.j1.id), "vazou id interno");
    t("L5 pacote tem formato internet-publica", pacote?.formato === "internet-publica" && pacote?.versao === 1);
    t("L6 pacote sem coleções privadas", !/internet_(accounts|contacts|conversations|participants|messages)/.test(JSON.stringify(Object.keys(pacote?.estado ?? {}))));
    // import na mesma campanha → dedupe, nada muda
    const domAntes = (() => { const db = abrirDb(BANCO); const n = db.prepare("select count(*) n from internet_publicacoes where campaign_id=?").get(campId).n; db.close(); return n; })();
    const rImp = await API("POST", "/importar", C.cookieMestre, { pacote, confirmacao: "IMPORTAR" });
    t("L7 import round-trip → 200", rImp.status === 200, `status=${rImp.status} ${JSON.stringify(rImp.json).slice(0, 140)}`);
    const domDepois = (() => { const db = abrirDb(BANCO); const n = db.prepare("select count(*) n from internet_publicacoes where campaign_id=?").get(campId).n; db.close(); return n; })();
    t("L8 reimport não duplica", domAntes === domDepois, `${domAntes}→${domDepois}`);
    // import em campanha nova → tudo read-only
    const campB = await req(BASE, "POST", "/campaigns", { cookie: C.cookieMestre, body: { name: "CampB L" } });
    const campBId = campB.json?.campanha?.id;
    t("L9 campanha B criada", !!campBId);
    if (campBId) {
      const rImpB = await req(BASE, "POST", `/campaigns/${campBId}/internet/importar`, { cookie: C.cookieMestre, body: { pacote, confirmacao: "IMPORTAR" } });
      t("L10 import em B → 200", rImpB.status === 200, `status=${rImpB.status}`);
      const pubB = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id,origem,autor_conta_id from internet_publicacoes where campaign_id=? and titulo='ANUNC_K_Vendo'").get(campBId); db.close(); return r; })();
      t("L11 importado nasce origem=importado sem conta", pubB?.origem === "importado" && pubB?.autor_conta_id === null, JSON.stringify(pubB));
      if (pubB) {
        const rPatch = await req(BASE, "PATCH", `/campaigns/${campBId}/internet/publicacoes/${pubB.id}`, { cookie: C.cookieMestre, body: { titulo: "hack", expectedVersion: 1 } });
        t("L12 mestre NÃO edita importado → 4xx", rPatch.status === 403 || rPatch.status === 404, `status=${rPatch.status}`);
      }
      // anonRef novo no reexport da campanha B
      const rExpB = await req(BASE, "GET", `/campaigns/${campBId}/internet/exportar`, { cookie: C.cookieMestre });
      const refsB = JSON.stringify(rExpB.json).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
      t("L13 reexport emite refs opacas", rExpB.status === 200 && refsB.length > 0, `status=${rExpB.status}`);
      // pacote adulterado → rejeitado
      const ruim = JSON.parse(JSON.stringify(pacote));
      ruim.estado.publicacoes[0].campoSecreto = "x";
      const rRuim = await req(BASE, "POST", `/campaigns/${campBId}/internet/importar`, { cookie: C.cookieMestre, body: { pacote: ruim, confirmacao: "IMPORTAR" } });
      t("L14 campo desconhecido → 4xx", rRuim.status === 400, `status=${rRuim.status}`);

      // L15 (P1-1 INTERMEDIÁRIO 7232671701): página NÃO pode pendurar
      // em site local pré-existente fora do pacote — siteId resolve
      // só pelo mapa do que a tx inseriu/dedupou.
      const forjado = JSON.parse(JSON.stringify(pacote));
      const paginaOrig = forjado.estado.paginas[0];
      const paginaForjada = { ...paginaOrig, id: crypto.randomUUID() };
      forjado.estado.sites = [];
      forjado.estado.paginas = [paginaForjada];
      forjado.estado.publicacoes = [];
      forjado.estado.denuncias = [];
      const rForjado = await req(BASE, "POST", `/campaigns/${campBId}/internet/importar`, { cookie: C.cookieMestre, body: { pacote: forjado, confirmacao: "IMPORTAR" } });
      t("L15 import forjado site-orfão → 200", rForjado.status === 200, `status=${rForjado.status}`);
      const pgForjada = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_pages where id=?").get(paginaForjada.id); db.close(); return r; })();
      t("L15b página órfã NÃO inserida", !pgForjada, JSON.stringify(pgForjada));

      // L16 (P1-1b): denúncia forjada contra publicação local
      // pré-existente (fora do pacote) → rejeitada, não pollue
      // contadores rederivados.
      const pubLocalB = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_publicacoes where campaign_id=? limit 1").get(campBId); db.close(); return r; })();
      if (pubLocalB) {
        const denForjada = {
          id: crypto.randomUUID(), publicacaoId: pubLocalB.id,
          denuncianteRef: crypto.randomUUID(), motivo: "spam", denunciaGrave: 0,
          status: "resolvida_admin", resolucao: "forjada", prazoContestacaoEm: null,
          criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
        };
        const forjado2 = JSON.parse(JSON.stringify(pacote));
        forjado2.estado.sites = []; forjado2.estado.paginas = [];
        forjado2.estado.publicacoes = []; forjado2.estado.denuncias = [denForjada];
        const rForjado2 = await req(BASE, "POST", `/campaigns/${campBId}/internet/importar`, { cookie: C.cookieMestre, body: { pacote: forjado2, confirmacao: "IMPORTAR" } });
        t("L16 import denúncia órfã → 200", rForjado2.status === 200, `status=${rForjado2.status}`);
        const denNoBanco = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_denuncias where id=?").get(denForjada.id); db.close(); return r; })();
        t("L16b denúncia forjada NÃO inserida", !denNoBanco, JSON.stringify(denNoBanco));
      }

      // L17 (P1-2): conteúdo importado (autorContaId NULL) É
      // denunciável por conta local elegível — sem via de moderação
      // era o bloqueio. j1 ganha personagem+conta em campB via SQL.
      {
        const dbM = abrirDb(BANCO); const agoraM = Date.now();
        // campB não tem ruleset — semeia o mesmo gate da fixture (o
        // personagem clonado resolve escolhas contra estas definições)
        const rsB = crypto.randomUUID();
        dbM.prepare("insert into rule_sets (id,campaign_id,name,version,is_active,config,created_at,updated_at) values (?,?,?,?,1,?,?,?)")
          .run(rsB, campBId, "Regras B", 1, "{}", agoraM, agoraM);
        const insDef = dbM.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?, '{}',?,?)");
        for (const [kind, key, name] of [
          ["pericia", "computador", "Computador"],
          ["conhecimento", "tecnologia", "Tecnologia"],
          ["item", "notebook", "Notebook"],
        ]) insDef.run(crypto.randomUUID(), rsB, kind, key, name, null, null, agoraM, agoraM);
        const memB = crypto.randomUUID(), charB = crypto.randomUUID(), contaB = crypto.randomUUID();
        dbM.prepare("insert into memberships (id,campaign_id,user_id,role,status,created_at,updated_at) values (?,?,?,?,?,?,?)")
          .run(memB, campBId, C.jogadores.j1.id, "jogador", "ativo", agoraM, agoraM);
        const j2char = dbM.prepare("select * from characters where campaign_id=? and name='Beto Foca' limit 1").get(campId);
        // template_version_id tem que ser de campB: apontar para a versão
        // de campId criava aresta cross-campaign em sheet_versions e o
        // restore "substituir" de campId falhava com FK (sheet_versions
        // não pode ser deletada enquanto campB referencia). Clona a
        // estrutura sob um template novo da própria campB.
        let tplVerB = null;
        if (j2char?.template_version_id) {
          const verOrig = dbM.prepare("select * from sheet_versions where id=?").get(j2char.template_version_id);
          if (verOrig) {
            const tplB = crypto.randomUUID();
            dbM.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,current_version_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
              .run(tplB, campBId, "Ficha Nina B", null, C.adminId, 1, 0, null, agoraM, agoraM);
            tplVerB = crypto.randomUUID();
            dbM.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,?,?,?,?)")
              .run(tplVerB, tplB, 1, verOrig.structure, verOrig.published_at, agoraM);
          }
        }
        dbM.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,template_version_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
          .run(charB, campBId, memB, "Nina B", j2char?.data ?? "{}", j2char?.overrides ?? "{}", "aprovada", 0, tplVerB, agoraM, agoraM);
        for (const t2 of ["inventory_entries", "equipment_entries"]) {
          const cols = dbM.prepare(`select * from ${t2} where character_id=?`).all(j2char?.id);
          for (const e of cols) {
            const { id: _i, character_id: _c, ...rest } = e;
            const chaves = Object.keys(rest);
            dbM.prepare(`insert into ${t2} (id,character_id,${chaves.join(",")}) values (?,?${chaves.map(() => ",?").join("")})`)
              .run(crypto.randomUUID(), charB, ...chaves.map((k) => rest[k]));
          }
        }
        dbM.prepare("insert into internet_accounts (id,campaign_id,character_id,handle,display_name,status,mostrar_presenca,mostrar_digitando,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
          .run(contaB, campBId, charB, "nina.b", null, "ativa", 0, 0, agoraM, agoraM);
        dbM.close();
        if (pubLocalB) {
          const rDen = await req(BASE, "POST", `/campaigns/${campBId}/internet/publicacoes/${pubLocalB.id}/denunciar`, { cookie: j1.cookie, body: { motivo: "ilegal" } });
          t("L17 denunciar importado → 201", rDen.status === 201, `status=${rDen.status} ${JSON.stringify(rDen.json).slice(0,140)}`);
          const pubApos = (() => { const db = abrirDb(BANCO); const r = db.prepare("select status,denuncia_aberta,denuncia_grave from internet_publicacoes where id=?").get(pubLocalB.id); db.close(); return r; })();
          t("L17b denúncia grave auto-remove importado", pubApos?.status === "removido" && pubApos?.denuncia_grave === 1, JSON.stringify(pubApos));
        }
      }
    }
  }

  // ========= W9/W10 — PERFIS PÚBLICOS =================
  sec("M. W9/W10 — ativação irreversível, perfil público, ciclo de vida");
  {
    const PERFIL_PUB = (handle) => `/campaigns/${campId}/internet/perfis/${handle}`;
    const BUSCA = (q) => `/campaigns/${campId}/internet/busca?q=${encodeURIComponent(q)}`;

    // M1–M2: antes de ativar → 404; ativação → 201
    const rAntes = await req(BASE, "GET", PERFIL_PUB("beto.foca"), { cookie: j1.cookie });
    t("H1 perfil não ativado → 404", rAntes.status === 404, `status=${rAntes.status}`);
    const rAtivar = await API("POST", "/perfil/ativar", j2.cookie, { characterId: charJ2, descricao: "Beto da vizinhança" });
    t("H2 ativação → 201", rAtivar.status === 201, `status=${rAtivar.status} ${JSON.stringify(rAtivar.json).slice(0, 140)}`);
    // M3: idempotente
    const rAtivar2 = await API("POST", "/perfil/ativar", j2.cookie, { characterId: charJ2 });
    t("H3 reativação idempotente → 200", rAtivar2.status === 200, `status=${rAtivar2.status}`);
    // M4: leitura pública por terceiro elegível — sem ids internos
    const rPerfil = await req(BASE, "GET", PERFIL_PUB("beto.foca"), { cookie: j1.cookie });
    const blobPerfil = JSON.stringify(rPerfil.json);
    t("H4 perfil público legível", rPerfil.status === 200, `status=${rPerfil.status}`);
    t("H5 sem ids internos no perfil", !/contaId|accountId|userId|membershipId|characterId/.test(blobPerfil), blobPerfil.slice(0, 200));
    t("H6 nome público default = personagem", rPerfil.json?.perfil?.nomePublico === "Beto Foca", JSON.stringify(rPerfil.json?.perfil?.nomePublico));
    // M7: irreversibilidade estrutural — desativar/excluir/ocultar → 4xx/404
    for (const [op, path, metodo] of [
      ["desativar", "/perfil/desativar", "POST"],
      ["excluir", "/perfil", "DELETE"],
      ["ocultar", "/perfil/ocultar", "POST"],
    ]) {
      const r = await req(BASE, metodo, `/campaigns/${campId}/internet${path}`, { cookie: j2.cookie, body: { characterId: charJ2 } });
      t(`M7 ${op} → rejeitado`, [400, 403, 404, 405].includes(r.status), `status=${r.status}`);
    }
    // M8: leitura sem conta própria → 403 (mesmo gate de sites/feed)
    const semConta = await req(BASE, "GET", PERFIL_PUB("beto.foca"), { cookie: C.cookieMestre });
    t("H8 mestre lê perfil público", semConta.status === 200, `status=${semConta.status}`);
    // M9: não-titular não edita (j1 tenta PATCH no perfil de j2)
    const rPatchTerceiro = await API("PATCH", "/perfil", j1.cookie, { characterId: charJ2, descricao: "hack" });
    t("H9 terceiro não edita → 403/404", rPatchTerceiro.status === 403 || rPatchTerceiro.status === 404, `status=${rPatchTerceiro.status}`);
    // M10: mestre não edita conteúdo diegético do perfil
    const rPatchMestre = await API("PATCH", "/perfil", C.cookieMestre, { characterId: charJ2, descricao: "hack" });
    t("H10 mestre não edita perfil → 403/404", rPatchMestre.status === 403 || rPatchMestre.status === 404, `status=${rPatchMestre.status}`);
    // M11: edição legítima do titular
    const rEdit = await API("PATCH", "/perfil", j2.cookie, { characterId: charJ2, nomePublico: "Beto Vizinho", descricao: "novo texto" });
    t("H11 titular edita → 200", rEdit.status === 200, `status=${rEdit.status}`);
    const rPerfil2 = await req(BASE, "GET", PERFIL_PUB("beto.foca"), { cookie: j1.cookie });
    t("H12 nome público editado visível", rPerfil2.json?.perfil?.nomePublico === "Beto Vizinho", JSON.stringify(rPerfil2.json?.perfil?.nomePublico));
    // M13: avatar inválido → 4xx (não 500)
    const rAvatar = await API("POST", "/perfil/avatar", j2.cookie, { characterId: charJ2, arquivoId: crypto.randomUUID() });
    t("H13 avatar arquivo inexistente → 4xx", rAvatar.status >= 400 && rAvatar.status < 500, `status=${rAvatar.status}`);
    // M14: busca por handle encontra; displayName/nome público NÃO indexa
    const rBusca = await req(BASE, "GET", BUSCA("beto.foca"), { cookie: j1.cookie });
    t("H14 busca por handle → acha perfil", rBusca.status === 200 && JSON.stringify(rBusca.json).includes("beto.foca"), `status=${rBusca.status}`);
    const rBuscaNome = await req(BASE, "GET", BUSCA("Beto Vizinho"), { cookie: j1.cookie });
    t("H15 nome público NÃO indexa", !JSON.stringify(rBuscaNome.json).includes("beto.foca"), `status=${rBuscaNome.status}`);
    // M16: P7 — perfil segue o personagem; novo titular edita, antigo não
    const inv = await req(BASE, "POST", `/campaigns/${campId}/characters/${charJ2}/transferencias`, { cookie: j2.cookie, body: { membershipId: C.jogadores.j1.membershipId } });
    const tid = inv.json?.transferencia?.id;
    t("H16 transferência criada", !!tid, `status=${inv.status}`);
    if (tid) {
      await req(BASE, "POST", `/campaigns/${campId}/characters/transferencias/${tid}/responder`, { cookie: j1.cookie, body: { aceitar: true } });
      await new Promise((r) => setTimeout(r, 300));
      const rAntigo = await API("PATCH", "/perfil", j2.cookie, { characterId: charJ2, descricao: "hack" });
      t("H17 titular anterior não edita → 403/404", rAntigo.status === 403 || rAntigo.status === 404, `status=${rAntigo.status}`);
      const rNovo = await API("PATCH", "/perfil", j1.cookie, { characterId: charJ2, descricao: "sou o novo titular" });
      t("H18 novo titular edita → 200", rNovo.status === 200, `status=${rNovo.status}`);
      const rLeAntigo = await req(BASE, "GET", PERFIL_PUB("beto.foca"), { cookie: j2.cookie });
      t("H19 titular anterior ainda LÊ perfil", rLeAntigo.status === 200 || rLeAntigo.status === 403, `status=${rLeAntigo.status}`);
    }
    // M20–M22: morte vigente → leitura ok + escrita negada; ressurreição reabre
    const dano = await req(BASE, "POST", `/characters/${charJ2}/hp`, { cookie: C.cookieMestre, body: { acao: "dano", quantidade: 9999, motivo: "morte p9" } });
    t("H20 dano letal → 200", dano.status === 200, `status=${dano.status}`);
    if (dano.status === 200) {
      await new Promise((r) => setTimeout(r, 300));
      const rMorto = await req(BASE, "GET", PERFIL_PUB("beto.foca"), { cookie: j1.cookie });
      t("H21 perfil de morto legível + flag", rMorto.status === 200 && rMorto.json?.perfil?.personagemFalecido === true, `status=${rMorto.status}`);
      const rEditMorto = await API("PATCH", "/perfil", j1.cookie, { characterId: charJ2, descricao: "x" });
      t("H22 escrita em morto → 403/404", rEditMorto.status === 403 || rEditMorto.status === 404, `status=${rEditMorto.status}`);
      // TG-P2: ativação também é escrita — charJ1 morto nunca ativou
      const rAtivarMorto = await API("POST", "/perfil/ativar", j1.cookie, { characterId: charJ1 });
      t("H22b ativar perfil de morto → 403", rAtivarMorto.status === 403, `status=${rAtivarMorto.status}`);
      const perfilMorto = (() => { const db = abrirDb(BANCO); const r = db.prepare("select count(*) n from internet_perfis where character_id=?").get(charJ1); db.close(); return r?.n; })();
      t("H22c nenhuma linha de perfil criada p/ morto", perfilMorto === 0, `linhas=${perfilMorto}`);
      const ress = await req(BASE, "POST", `/characters/${charJ2}/ressuscitar`, { cookie: C.cookieMestre, body: {} });
      t("H23 ressurreição → 200", ress.status === 200, `status=${ress.status}`);
      if (ress.status === 200) {
        const rVivo = await API("PATCH", "/perfil", j1.cookie, { characterId: charJ2, descricao: "voltei" });
        t("H24 escrita reabre após ressurreição", rVivo.status === 200, `status=${rVivo.status}`);
      }
    }
    // M25: cross-campaign → 404; sem sessão → 401
    const campM = await req(BASE, "POST", "/campaigns", { cookie: C.cookieMestre, body: { name: "CampM" } });
    const campMId = campM.json?.campanha?.id;
    const rCross = campMId
      ? await req(BASE, "GET", `/campaigns/${campMId}/internet/perfis/beto.foca`, { cookie: C.cookieMestre })
      : { status: 0 };
    t("H25 perfil de outra campanha → 404", rCross.status === 404, `status=${rCross.status}`);
    const rAnon = await req(BASE, "GET", PERFIL_PUB("beto.foca"), {});
    t("H26 sem sessão → 401", rAnon.status === 401, `status=${rAnon.status}`);
  }

  // ================= PATROCÍNIO AUTOMÁTICO ==========  sec("N. Patrocínio — acordo, aceite bilateral, liquidação atômica");
  {
    // charJ3 foi arquivado e a membership de j3 removida na seção J
    // (D6/restore) — o beneficiário precisa ser um personagem vivo com
    // conta Internet ativa: charJ4 (novo, de j2).
    const charJ4 = C.novoPersonagem(C.jogadores.j2.membershipId, "Duda Foca", { comp: 1, prof: "medico" });
    darDispositivo(BANCO, charJ4);
    const c4 = await API("POST", "/account", j2.cookie, { characterId: charJ4, handle: "duda.foca" });
    t("N0 conta Internet do beneficiário → 201", c4.status === 201, `status=${c4.status}`);
    // contas financeiras fictícias: pagador=charJ2 (titular j1 pós-P7),
    // beneficiário=charJ4 (titular j2). Saldo em centavos.
    const fin = (charId, cents) => {
      const db = abrirDb(BANCO); const id = crypto.randomUUID(); const agora = Date.now();
      db.prepare(`insert into financial_accounts (id,character_id,campaign_id,type,name,currency,balance_cents,data,created_at,updated_at)
        values (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, charId, campId, "banco", `Conta ${charId.slice(0, 6)}`, "BRL", cents, "{}", agora, agora);
      db.close(); return id;
    };
    const accPagador = fin(charJ2, 50000);
    const accBenef = fin(charJ4, 1000);
    const saldo = (accId) => { const db = abrirDb(BANCO); const r = db.prepare("select balance_cents b from financial_accounts where id=?").get(accId); db.close(); return r?.b; };
    const txs = () => { const db = abrirDb(BANCO); const r = db.prepare("select kind,amount_cents,request_id from money_transactions where campaign_id=? and request_id like 'patrocinios:%'").all(campId); db.close(); return r; };

    // N1: propor sem titular → 404; beneficiário sem conta Internet → 404
    const rPropSemTitular = await API("POST", "/patrocinios", j2.cookie, { characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador, amountCents: 5000, condicao: { tipo: "imediato" } });
    t("N1 propor sem titularidade → 404", rPropSemTitular.status === 404, `status=${rPropSemTitular.status}`);
    // N2: propor válido (j1 é titular de charJ2)
    const prop = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador, amountCents: 5000, condicao: { tipo: "imediato" }, requestId: "prop-n2-0001" });
    t("N2 propor → 201 proposto", prop.status === 201 && prop.json?.acordo?.estado === "proposto", `status=${prop.status} body=${JSON.stringify(prop.json).slice(0,200)}`);
    const acordoId = prop.json?.acordo?.id;
    // N3: replay requestId → mesmo acordo, sem duplicar
    const replay = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador, amountCents: 5000, condicao: { tipo: "imediato" }, requestId: "prop-n2-0001" });
    t("N3 replay requestId → 200 mesmo id", replay.status === 200 && replay.json?.acordo?.id === acordoId, `status=${replay.status}`);
    const nAcordos = (() => { const db = abrirDb(BANCO); const r = db.prepare("select count(*) n from internet_patrocinios where campaign_id=?").get(campId); db.close(); return r?.n; })();
    t("N3b nenhuma linha duplicada", nAcordos === 1, `linhas=${nAcordos}`);
    // N4: IDOR — j2 (não-partes) não vê o acordo
    const rIdor = await API("GET", `/patrocinios/${acordoId}`, j3.cookie);
    t("N4 IDOR detalhe → 404", rIdor.status === 404, `status=${rIdor.status}`);
    // N5: auto-aceite pelo pagador → 404 (só beneficiário aceita)
    const rAutoAceite = await API("POST", `/patrocinios/${acordoId}/aceitar`, j1.cookie, { beneficiarioAccountId: accBenef });
    t("N5 pagador não aceita → 404", rAutoAceite.status === 404, `status=${rAutoAceite.status}`);
    // N6: beneficiário aceita com conta própria → liquida imediato
    const ace = await API("POST", `/patrocinios/${acordoId}/aceitar`, j2.cookie, { beneficiarioAccountId: accBenef });
    t("N6 aceite beneficiário → 200 liquidado", ace.status === 200 && ace.json?.liquidado === true, `status=${ace.status} body=${JSON.stringify(ace.json).slice(0,120)}`);
    t("N6b saldo pagador debitado", saldo(accPagador) === 45000, `saldo=${saldo(accPagador)}`);
    t("N6c saldo beneficiário creditado", saldo(accBenef) === 6000, `saldo=${saldo(accBenef)}`);
    const pernas = txs();
    t("N6d duas pernas pix_ficticio idempotentes", pernas.length === 2 && pernas.every((p) => p.kind === "pix_ficticio"), `pernas=${pernas.length}`);
    // N7: segundo aceite → 409 (estado terminal)
    const reAce = await API("POST", `/patrocinios/${acordoId}/aceitar`, j2.cookie, { beneficiarioAccountId: accBenef });
    t("N7 re-aceite → 409", reAce.status === 409, `status=${reAce.status}`);
    const saldoFinal = saldo(accPagador);
    t("N7b saldo não duplicou", saldoFinal === 45000, `saldo=${saldoFinal}`);

    // N8: saldo insuficiente → falha_liquidacao sem débito
    const accPobre = fin(charJ2, 100);
    const prop2 = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPobre, amountCents: 99999, condicao: { tipo: "imediato" }, requestId: "prop-n8-0001" });
    const acordo2 = prop2.json?.acordo?.id;
    const ace2 = await API("POST", `/patrocinios/${acordo2}/aceitar`, j2.cookie, { beneficiarioAccountId: accBenef });
    t("N8 aceite c/ saldo insuficiente → 200 liquidado=false", ace2.status === 200 && ace2.json?.liquidado === false, `status=${ace2.status}`);
    const det2 = await API("GET", `/patrocinios/${acordo2}`, j2.cookie);
    t("N8b estado falha_liquidacao", det2.json?.acordo?.estado === "falha_liquidacao", `estado=${det2.json?.acordo?.estado}`);
    t("N8c saldo intacto", saldo(accPobre) === 100, `saldo=${saldo(accPobre)}`);

    // N9: data_alvo futuro → aceito não liquida; data passada → lazy liquida na leitura
    const futuro = new Date(Date.now() + 3600_000).toISOString();
    const prop3 = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador, amountCents: 1000, condicao: { tipo: "data_alvo", em: futuro }, requestId: "prop-n9-0001" });
    const acordo3 = prop3.json?.acordo?.id;
    const ace3 = await API("POST", `/patrocinios/${acordo3}/aceitar`, j2.cookie, { beneficiarioAccountId: accBenef });
    t("N9 aceite data_alvo futuro → não liquida", ace3.status === 200 && ace3.json?.liquidado === false, `status=${ace3.status}`);
    t("N9b saldo inalterado", saldo(accPagador) === 45000, `saldo=${saldo(accPagador)}`);
    // força a data para o passado e lê → lazy settlement
    const dbF = abrirDb(BANCO);
    dbF.prepare("update internet_patrocinios set condicao_json=? where id=?")
      .run(JSON.stringify({ tipo: "data_alvo", em: new Date(Date.now() - 1000).toISOString() }), acordo3);
    dbF.close();
    const det3 = await API("GET", `/patrocinios/${acordo3}`, j2.cookie);
    t("N9c lazy settlement após data → liquidado", det3.json?.acordo?.estado === "liquidado", `estado=${det3.json?.acordo?.estado}`);
    t("N9d débito aplicado", saldo(accPagador) === 44000, `saldo=${saldo(accPagador)}`);

    // N10: cancelar — proposta e aceite
    const prop4 = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador, amountCents: 700, condicao: { tipo: "imediato" }, requestId: "prop-n10-0001" });
    const acordo4 = prop4.json?.acordo?.id;
    const canc = await API("POST", `/patrocinios/${acordo4}/cancelar`, j2.cookie);
    t("N10 beneficiário cancela proposta → 200", canc.status === 200, `status=${canc.status}`);
    const ace4 = await API("POST", `/patrocinios/${acordo4}/aceitar`, j2.cookie, { beneficiarioAccountId: accBenef });
    t("N10b aceite após cancelar → 409", ace4.status === 409, `status=${ace4.status}`);

    // N11: condicaoTipo não suportada → 400 (metrica reservada)
    const prop5 = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador, amountCents: 100, condicao: { tipo: "metrica_publicacao" }, requestId: "prop-n11-0001" });
    t("N11 condição não-verificável → 400", prop5.status === 400, `status=${prop5.status}`);
    // N12: valor zero/negativo/float → 400
    const prop6 = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador, amountCents: 0, condicao: { tipo: "imediato" } });
    t("N12 amountCents=0 → 400", prop6.status === 400, `status=${prop6.status}`);
    // N13: conta de outro personagem → 404
    const prop7 = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accBenef, amountCents: 100, condicao: { tipo: "imediato" } });
    t("N13 conta alheia como origem → 404", prop7.status === 404, `status=${prop7.status}`);
    // N14: beneficiário sem conta Internet → 404 (charJ1 tem conta? sim — usa char inexistente)
    const prop8 = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: crypto.randomUUID(), pagadorAccountId: accPagador, amountCents: 100, condicao: { tipo: "imediato" } });
    t("N14 beneficiário inexistente → 404", prop8.status === 404, `status=${prop8.status}`);
    // N15: trilha de auditoria — transições registradas
    const aud = (() => { const db = abrirDb(BANCO); const r = db.prepare("select action from audit_logs where campaign_id=? and action like 'patrocinio.%' order by created_at").all(campId); db.close(); return r.map((x) => x.action); })();
    t("N15 auditoria propor/aceitar/liquidar", aud.includes("patrocinio.propor") && aud.includes("patrocinio.aceitar") && aud.includes("patrocinio.liquidar"), JSON.stringify(aud));

    // N16 (Dono #401 / TG 7233180172): expiresAt só limita a
    // PROPOSTA. Aceite bilateral com expiresAt vencido + data_alvo
    // atingida → liquida mesmo assim; e nunca exibe "expirado".
    const propX7 = await API("POST", "/patrocinios", j1.cookie, {
      characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador,
      amountCents: 300, condicao: { tipo: "data_alvo", em: new Date(Date.now() + 3600_000).toISOString() },
      expiresAt: new Date(Date.now() + 1800_000).toISOString(), requestId: "prop-n16-0001",
    });
    const acordoX7 = propX7.json?.acordo?.id;
    t("N16a proposta com expiresAt → 201", propX7.status === 201, `status=${propX7.status}`);
    const aceX7 = await API("POST", `/patrocinios/${acordoX7}/aceitar`, j2.cookie, { beneficiarioAccountId: accBenef });
    t("N16b aceite dentro da validade → 200", aceX7.status === 200, `status=${aceX7.status}`);
    // vence expiresAt E atinge data_alvo via SQL (relógio não espera)
    const dbXa = abrirDb(BANCO);
    dbXa.prepare("update internet_patrocinios set expires_at=?, condicao_json=? where id=?")
      .run(new Date(Date.now() - 1000).toISOString(), JSON.stringify({ tipo: "data_alvo", em: new Date(Date.now() - 500).toISOString() }), acordoX7);
    dbXa.close();
    const detX7 = await API("GET", `/patrocinios/${acordoX7}`, j2.cookie);
    t("N16c aceito+expiresAt vencido NÃO vira 'expirado' e liquida", detX7.json?.acordo?.estado === "liquidado", `estado=${detX7.json?.acordo?.estado} real=${detX7.json?.acordo?.estadoReal}`);
    t("N16d débito aplicado", saldo(accPagador) === 43700, `saldo=${saldo(accPagador)}`);

    // N16e: proposta NÃO aceita com expiresAt vencido → aceite 409
    // (expiresAt continua limitando a janela de aceite — M38).
    const propX8 = await API("POST", "/patrocinios", j1.cookie, {
      characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador,
      amountCents: 100, condicao: { tipo: "imediato" },
      expiresAt: new Date(Date.now() + 60000).toISOString(), requestId: "prop-n16e-001",
    });
    const acordoX8 = propX8.json?.acordo?.id;
    const dbXb = abrirDb(BANCO);
    dbXb.prepare("update internet_patrocinios set expires_at=? where id=?").run(new Date(Date.now() - 1000).toISOString(), acordoX8);
    dbXb.close();
    const aceX8 = await API("POST", `/patrocinios/${acordoX8}/aceitar`, j2.cookie, { beneficiarioAccountId: accBenef });
    t("N16e proposta expirada → aceite 409", aceX8.status === 409, `status=${aceX8.status}`);
    const detX8 = await API("GET", `/patrocinios/${acordoX8}`, j2.cookie);
    t("N16f proposta expirada serializa 'expirado'", detX8.json?.acordo?.estado === "expirado", `estado=${detX8.json?.acordo?.estado}`);

    // N17 (Dono #401): beneficiário ARQUIVADO não pode ser alvo —
    // sem proposta zumbi. (Pagador/aceitante já bloqueados por
    // contaAutorizadaPara — não duplicar.)
    const charJ11x = C.novoPersonagem(C.jogadores.j2.membershipId, "Arquivado Foca", { comp: 1, prof: "medico" });
    darDispositivo(BANCO, charJ11x);
    const c11 = await API("POST", "/account", j2.cookie, { characterId: charJ11x, handle: "arq.foca" });
    t("N17a conta do arquivado → 201", c11.status === 201, `status=${c11.status}`);
    {
      const db = abrirDb(BANCO);
      db.prepare("update characters set status='arquivado' where id=?").run(charJ11x);
      db.close();
    }
    const propX9 = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: charJ11x, pagadorAccountId: accPagador, amountCents: 100, condicao: { tipo: "imediato" }, requestId: "prop-n17-0001" });
    t("N17 beneficiário arquivado → 404", propX9.status === 404, `status=${propX9.status}`);
    // Dono #401: arquivado indistinguível de inexistente — mesma
    // resposta, mesmo corpo.
    const propInex = await API("POST", "/patrocinios", j1.cookie, { characterId: charJ2, beneficiarioCharacterId: crypto.randomUUID(), pagadorAccountId: accPagador, amountCents: 100, condicao: { tipo: "imediato" }, requestId: "prop-n17-0002" });
    t("N17b arquivado ≡ inexistente (status+corpo)", propInex.status === propX9.status && JSON.stringify(propInex.json) === JSON.stringify(propX9.json),
      `${propX9.status}/${JSON.stringify(propX9.json)} vs ${propInex.status}/${JSON.stringify(propInex.json)}`);

    // N18 (TG #401 TOCTOU-1): titularidade relida DENTRO da tx das
    // três mutações. A janela exata (entre a checagem externa e o
    // commit) não é reproduzível de forma determinística neste
    // harness — better-sqlite3 executa a tx de forma síncrona e o
    // servidor é processo separado; o que é determinístico é o
    // ESTADO FINAL: quem perdeu a titularidade não propõe, não
    // aceita e não cancela — 404 uniforme nas três.
    const propT = await API("POST", "/patrocinios", j1.cookie, {
      characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador,
      amountCents: 100, condicao: { tipo: "imediato" }, requestId: "prop-n18-0001",
    });
    const acordoT = propT.json?.acordo?.id;
    t("N18a proposta p/ teste TOCTOU → 201", propT.status === 201 && !!acordoT, `status=${propT.status}`);
    // "transferência" instantânea: charJ4 passa a pertencer a j1 —
    // j2 deixa de ser titular da conta Internet dela.
    {
      const db = abrirDb(BANCO);
      db.prepare("update characters set membership_id=? where id=?").run(C.jogadores.j1.membershipId, charJ4);
      db.close();
    }
    const aceT = await API("POST", `/patrocinios/${acordoT}/aceitar`, j2.cookie, { beneficiarioAccountId: accBenef });
    t("N18b ex-titular não aceita → 404", aceT.status === 404, `status=${aceT.status}`);
    const cancT = await API("POST", `/patrocinios/${acordoT}/cancelar`, j2.cookie);
    t("N18c ex-parte não cancela → 404", cancT.status === 404, `status=${cancT.status}`);
    const propT2 = await API("POST", "/patrocinios", j2.cookie, {
      characterId: charJ2, beneficiarioCharacterId: charJ4, pagadorAccountId: accPagador,
      amountCents: 100, condicao: { tipo: "imediato" }, requestId: "prop-n18-0002",
    });
    t("N18d ex-titular não propõe → 404", propT2.status === 404, `status=${propT2.status}`);
    // novo titular (j1) recupera o controle: cancelar como parte
    const cancT1 = await API("POST", `/patrocinios/${acordoT}/cancelar`, j1.cookie);
    t("N18e titular atual cancela → 200", cancT1.status === 200, `status=${cancT1.status}`);
    // devolve charJ4 a j2 — seções seguintes não dependem, mas o
    // estado fica consistente com o restante da suíte.
    {
      const db = abrirDb(BANCO);
      db.prepare("update characters set membership_id=? where id=?").run(C.jogadores.j2.membershipId, charJ4);
      db.close();
    }
  }
  // ================= RESTAURAÇÃO × PERFIS (TG P1) ==========  sec("O. Restore substituir — perfis preservados, avatar saneado");
  {
    // perfil de charJ2 já existe (seção M, titular j1 pós-P7). Cria um
    // arquivo real e o referencia como avatar; depois o pacote de
    // restore NÃO carrega o arquivo → avatar_file_id deve virar NULL
    // (crit. TG 7232390928 §3), nunca restaurar aresta inválida.
    const arquivoAvatar = crypto.randomUUID();
    const db0 = abrirDb(BANCO);
    const perfilAntes = db0.prepare("select * from internet_perfis where character_id=?").get(charJ2);
    t("O0 perfil de charJ2 existe", !!perfilAntes, JSON.stringify(perfilAntes?.id));
    const agoraO = Date.now();
    db0.prepare(`insert into files (id,campaign_id,folder_path,display_name,file_name,mime_type,size_bytes,uploaded_by,visibility,status,created_at,updated_at)
      values (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(arquivoAvatar, campId, "/", "Avatar O", "avatar-o.png", "image/png", 10, C.adminId, "mestre", "aprovado", agoraO, agoraO);
    db0.prepare("update internet_perfis set avatar_file_id=? where character_id=?").run(arquivoAvatar, charJ2);
    db0.close();
    const expO = await req(BASE, "GET", `/campaigns/${campId}/exportar`, { cookie: C.cookieMestre });
    // remove o arquivo do pacote → restore não o recria → aresta do
    // avatar fica pendente e deve ser saneada para NULL.
    if (Array.isArray(expO.json?.estado?.files)) {
      expO.json.estado.files = expO.json.estado.files.filter((f) => f.id !== arquivoAvatar);
    }
    // O5: acordos de patrocínio (seção N) preservados pelo restore —
    // snapshot ANTES do importar, compara DEPOIS (TG P1 #401).
    const patAntes = (() => { const db = abrirDb(BANCO); const r = db.prepare("select estado,count(*) n from internet_patrocinios where campaign_id=? group by estado").all(campId); db.close(); return r; })();
    const pernasAntes = (() => { const db = abrirDb(BANCO); const r = db.prepare("select count(*) n from money_transactions where campaign_id=? and request_id like 'patrocinios:%'").get(campId); db.close(); return r?.n; })();
    const impO = await req(BASE, "POST", "/campaigns/importar", {
      cookie: C.cookieMestre,
      body: { pacote: expO.json, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
    });
    t("O1 substituir → 200", impO.status === 200, `status=${impO.status} ${JSON.stringify(impO.json).slice(0, 160)}`);
    const db1 = abrirDb(BANCO);
    const perfilDepois = db1.prepare("select * from internet_perfis where character_id=?").get(charJ2);
    t("O2 perfil preservado (mesmo id, descrição intacta)",
      !!perfilDepois && perfilDepois.id === perfilAntes?.id && perfilDepois.descricao === perfilAntes?.descricao,
      JSON.stringify({ antes: perfilAntes?.id, depois: perfilDepois?.id }));
    t("O3 avatar_file_id inválido → NULL", !!perfilDepois && perfilDepois.avatar_file_id === null,
      `avatar=${perfilDepois?.avatar_file_id}`);
    db1.close();
    const rPerfilO = await req(BASE, "GET", `/campaigns/${campId}/internet/perfis/beto.foca`, { cookie: j1.cookie });
    t("O4 perfil público segue legível", rPerfilO.status === 200, `status=${rPerfilO.status}`);
    // O5: acordos de patrocínio (seção N) preservados pelo restore —
    // estados e pernas financeiras intactos (TG P1 #401).
    const patDepois = (() => { const db = abrirDb(BANCO); const r = db.prepare("select estado,count(*) n from internet_patrocinios where campaign_id=? group by estado").all(campId); db.close(); return r; })();
    t("O5 patrocínios preservados no restore",
      JSON.stringify(patDepois.map((r) => [r.estado, r.n]).sort()) === JSON.stringify(patAntes.map((r) => [r.estado, r.n]).sort()),
      JSON.stringify({ antes: patAntes, depois: patDepois }));
    const pernasO = (() => { const db = abrirDb(BANCO); const r = db.prepare("select count(*) n from money_transactions where campaign_id=? and request_id like 'patrocinios:%'").get(campId); db.close(); return r?.n; })();
    t("O6 pernas financeiras dos acordos preservadas", pernasO === pernasAntes, `pernas=${pernasO} antes=${pernasAntes}`);
  }

  // ================= D6 HARDENING (P1 residual + P2s) ==========
  sec("L2. D6 — linhagem dedupe, denuncianteRef, rascunho, contatos");
  {
    const rExpM = await API("GET", "/exportar", C.cookieMestre);
    const pacoteM = rExpM.json;

    // M1 (P2-1 INTERMEDIÁRIO 7232738783): rascunho é trabalho não
    // publicado — pacote público não o transporta.
    const idRasc = crypto.randomUUID();
    {
      const db = abrirDb(BANCO); const ag = Date.now();
      db.prepare("insert into internet_publicacoes (id,campaign_id,tipo,titulo,corpo,formato,status,visibilidade,autor_modo,origem,version,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(idRasc, campId, "post_perfil", "RASCUNHO_SECRETO", "corpo", "texto", "rascunho", "campanha", "identificado", "usuario", 1, ag, ag);
      db.close();
    }
    const rExp2 = await API("GET", "/exportar", C.cookieMestre);
    t("L2-1 export omite rascunho", !JSON.stringify(rExp2.json).includes("RASCUNHO_SECRETO"), "vazou rascunho");

    // M2 (P1 residual 7232925593 / PoC Gerente 7232846030): página
    // forjada NÃO pendura em site de JOGADOR — dedupe por id não
    // prova linhagem; siteMap só resolve site sem dono local.
    const forjadoM = JSON.parse(JSON.stringify(pacoteM));
    const pagForjadaM = {
      id: crypto.randomUUID(), siteId: idsJ.siteId, slug: "pagina-injetada-m",
      titulo: "Injetada", corpo: "sem autor", formato: "texto",
      status: "publicado", version: 1,
      criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
    };
    forjadoM.estado.paginas = [pagForjadaM];
    forjadoM.estado.publicacoes = [];
    forjadoM.estado.denuncias = [];
    const rImpM = await API("POST", "/importar", C.cookieMestre, { pacote: forjadoM, confirmacao: "IMPORTAR" });
    t("L2-2 import forjado → 200", rImpM.status === 200, `status=${rImpM.status}`);
    const pgM = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_pages where id=?").get(pagForjadaM.id); db.close(); return r; })();
    t("L2-2b página em site de jogador NÃO inserida", !pgM, JSON.stringify(pgM));
    const rejM = (rImpM.json?.rejeitadas ?? []).find((r) => r.id === pagForjadaM.id);
    t("L2-2c rejeitada como site_orfao", rejM?.motivo === "site_orfao", JSON.stringify(rImpM.json?.rejeitadas).slice(0, 200));

    // M3/M4 precisam de campanha com publicações importadas (origem
    //='importado' é a única âncora válida de denúncia).
    const campM = await req(BASE, "POST", "/campaigns", { cookie: C.cookieMestre, body: { name: "CampM" } });
    const campMId = campM.json?.campanha?.id;
    t("L2-3 campanha M criada", !!campMId);
    if (campMId) {
      const rImpM0 = await req(BASE, "POST", `/campaigns/${campMId}/internet/importar`, { cookie: C.cookieMestre, body: { pacote: pacoteM, confirmacao: "IMPORTAR" } });
      t("L2-3a import pacote em M → 200", rImpM0.status === 200, `status=${rImpM0.status}`);

      // M3b (P2-2): denuncianteRef forjado (UUID de conta real de
      // outra campanha) grava com prefixo pkg: — nunca colide com
      // conta.id de denúncia local na UNIQUE.
      const pkgM3 = JSON.parse(JSON.stringify(pacoteM));
      const pubRefM3 = pkgM3.estado.publicacoes[0]?.id;
      if (pubRefM3) {
        const denM = {
          id: crypto.randomUUID(), publicacaoId: pubRefM3,
          denuncianteRef: contaJ1, motivo: "spam", denunciaGrave: 0,
          status: "aberta", resolucao: null, prazoContestacaoEm: null,
          criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString(),
        };
        pkgM3.estado.denuncias = [denM];
        const rImpM3 = await req(BASE, "POST", `/campaigns/${campMId}/internet/importar`, { cookie: C.cookieMestre, body: { pacote: pkgM3, confirmacao: "IMPORTAR" } });
        t("L2-3b import denúncia → 200", rImpM3.status === 200, `status=${rImpM3.status} ${JSON.stringify(rImpM3.json).slice(0,140)}`);
        const denRow = (() => { const db = abrirDb(BANCO); const r = db.prepare("select denunciante_ref from internet_denuncias where id=?").get(denM.id); db.close(); return r; })();
        t("L2-3c denunciante_ref prefixado pkg:", denRow?.denunciante_ref === `pkg:${contaJ1}`, JSON.stringify(denRow));
      }

      // M4 (P2-4): visibilidade 'contatos' é insatisfativel sem autor
      // — rejeitada com relatório em vez de virar zumbi.
      const pkgM4 = JSON.parse(JSON.stringify(pacoteM));
      const pubCt = pkgM4.estado.publicacoes.find((p) => p.status === "publicado") ?? pkgM4.estado.publicacoes[0];
      if (pubCt) {
        pubCt.id = crypto.randomUUID(); pubCt.titulo = "CT_" + pubCt.titulo;
        pubCt.visibilidade = "contatos";
        pkgM4.estado.publicacoes = [pubCt];
        pkgM4.estado.sites = []; pkgM4.estado.paginas = []; pkgM4.estado.denuncias = [];
        const rImpM4 = await req(BASE, "POST", `/campaigns/${campMId}/internet/importar`, { cookie: C.cookieMestre, body: { pacote: pkgM4, confirmacao: "IMPORTAR" } });
        t("L2-4 import contatos → 200", rImpM4.status === 200, `status=${rImpM4.status}`);
        const rejCt = (rImpM4.json?.rejeitadas ?? []).find((r) => r.id === pubCt.id);
        t("L2-4b rejeitada visibilidade_insatisfativel", rejCt?.motivo === "visibilidade_insatisfativel", JSON.stringify(rImpM4.json?.rejeitadas).slice(0, 200));
        const pubCtRow = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_publicacoes where id=?").get(pubCt.id); db.close(); return r; })();
        t("L2-4c publicação contatos NÃO inserida", !pubCtRow, JSON.stringify(pubCtRow));
      }

      // M5 (INTERMEDIÁRIO O1 #399): contadores derivados contam só
      // status='aberta' — denúncias terminais do pacote não podem
      // disparar o limiar de auto-remoção na primeira denúncia local.
      const pkgM5 = JSON.parse(JSON.stringify(pacoteM));
      const pubM5 = pkgM5.estado.publicacoes.find((p) => p.status === "publicado") ?? pkgM5.estado.publicacoes[0];
      if (pubM5) {
        pubM5.id = crypto.randomUUID(); pubM5.titulo = "DEN_M5_" + pubM5.titulo;
        pkgM5.estado.publicacoes = [pubM5];
        pkgM5.estado.sites = []; pkgM5.estado.paginas = [];
        const agM5 = new Date().toISOString();
        pkgM5.estado.denuncias = [
          { id: crypto.randomUUID(), publicacaoId: pubM5.id, denuncianteRef: crypto.randomUUID(), motivo: "spam", denunciaGrave: 1, status: "encerrada", resolucao: null, prazoContestacaoEm: null, criadoEm: agM5, atualizadoEm: agM5 },
          { id: crypto.randomUUID(), publicacaoId: pubM5.id, denuncianteRef: crypto.randomUUID(), motivo: "spam", denunciaGrave: 0, status: "resolvida_admin", resolucao: "ok", prazoContestacaoEm: null, criadoEm: agM5, atualizadoEm: agM5 },
          { id: crypto.randomUUID(), publicacaoId: pubM5.id, denuncianteRef: crypto.randomUUID(), motivo: "spam", denunciaGrave: 0, status: "aberta", resolucao: null, prazoContestacaoEm: null, criadoEm: agM5, atualizadoEm: agM5 },
          { id: crypto.randomUUID(), publicacaoId: pubM5.id, denuncianteRef: crypto.randomUUID(), motivo: "grave", denunciaGrave: 1, status: "aberta", resolucao: null, prazoContestacaoEm: null, criadoEm: agM5, atualizadoEm: agM5 },
          // TG 7233323948: em_analise é status ATIVO — conta nos
          // contadores (e a grave em_analise conta em denuncia_grave).
          { id: crypto.randomUUID(), publicacaoId: pubM5.id, denuncianteRef: crypto.randomUUID(), motivo: "grave", denunciaGrave: 1, status: "em_analise", resolucao: null, prazoContestacaoEm: null, criadoEm: agM5, atualizadoEm: agM5 },
        ];
        const rImpM5 = await req(BASE, "POST", `/campaigns/${campMId}/internet/importar`, { cookie: C.cookieMestre, body: { pacote: pkgM5, confirmacao: "IMPORTAR" } });
        t("M5 import com denuncias mistas → 200", rImpM5.status === 200, `status=${rImpM5.status}`);
        const ctrM5 = (() => { const db = abrirDb(BANCO); const r = db.prepare("select denuncia_aberta, denuncia_grave from internet_publicacoes where id=?").get(pubM5.id); db.close(); return r; })();
        t("M5b denuncia_aberta=3 (aberta+em_analise; terminais fora)", ctrM5?.denuncia_aberta === 3, JSON.stringify(ctrM5));
        t("M5c denuncia_grave=2 (graves ativas; grave terminal fora)", ctrM5?.denuncia_grave === 2, JSON.stringify(ctrM5));

        // M6 (INTERMEDIÁRIO O2 #399): resolver admin encerra irmãs
        // 'aberta'/'em_analise' trazidas pelo pacote — não ficam
        // presas na fila para sempre.
        const pubM6 = pkgM5.estado.publicacoes[0];
        {
          const db = abrirDb(BANCO); const ag = Date.now();
          const ins = db.prepare("insert into internet_denuncias (id,campaign_id,publicacao_id,denunciante_conta_id,denunciante_ref,motivo,denuncia_grave,status,prazo_contestacao_em,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)");
          ins.run(crypto.randomUUID(), campMId, pubM6.id, null, "pkg:b1", "spam", 0, "aberta", null, ag, ag);
          ins.run(crypto.randomUUID(), campMId, pubM6.id, null, "pkg:b2", "spam", 0, "em_analise", null, ag, ag);
          db.close();
        }
        const denM6 = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_denuncias where publicacao_id=? and status='aberta' order BY created_at DESC limit 1").get(pubM6.id); db.close(); return r?.id; })();
        const resM6 = await req(BASE, "POST", `/admin/internet-denuncias/${denM6}/resolver`, { cookie: C.cookieMestre, body: { decisao: "manter", resolucao: " improcedente " } });
        t("M6 resolver admin → 200", resM6.status === 200, `status=${resM6.status}`);
        const irmasM6 = (() => { const db = abrirDb(BANCO); const r = db.prepare("select status from internet_denuncias where publicacao_id=? and id!=?").all(pubM6.id, denM6); db.close(); return r.map((x) => x.status); })();
        t("M6b irmãs pendentes encerradas", irmasM6.length > 0 && irmasM6.every((s) => s === "encerrada" || s === "resolvida_admin"), JSON.stringify(irmasM6));
        t("M6c nenhuma 'aberta'/'em_analise' restante", irmasM6.every((s) => s !== "aberta" && s !== "em_analise"), JSON.stringify(irmasM6));
      }
    }
  }

  // ================= LIVE + MÉTRICAS ==========  sec("P. Streamer ao vivo, seguidores, views");
  {
    // charJ5: streamer real — profissão streamer no ruleset ativo.
    const charJ5 = C.novoPersonagem(C.jogadores.j1.membershipId, "Live Foca", { comp: 1, prof: "streamer" });
    darDispositivo(BANCO, charJ5);
    const c5 = await API("POST", "/account", j1.cookie, { characterId: charJ5, handle: "live.foca" });
    t("P0 conta Internet do streamer → 201", c5.status === 201, `status=${c5.status}`);
    // P12 precisa do perfil ativado — sem isso /perfis/live.foca → 404
    // e o assert morria silencioso (JSON.stringify(undefined).slice).
    const atv5 = await API("POST", "/perfil/ativar", j1.cookie, { characterId: charJ5 });
    t("P0b perfil do streamer ativado", atv5.status === 201 || atv5.status === 200, `status=${atv5.status}`);

    // P1: sem sessão → 401
    const rAnon = await req(BASE, "POST", `/campaigns/${campId}/internet/ao-vivo`, { body: { characterId: charJ5, titulo: "Live teste" } });
    t("P1 sem sessão → 401", rAnon.status === 401, `status=${rAnon.status}`);
    // P2: sem gate streamer (charJ2 = médico) → 403
    const rSemGate = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ2, titulo: "Live teste" });
    t("P2 sem profissao:streamer → 403", rSemGate.status === 403, `status=${rSemGate.status}`);
    // P3: morto não transmite (charJ1 falecido, conta ativa) → 403
    const rMorto = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ1, titulo: "Live teste" });
    t("P3 personagem falecido → 403", rMorto.status === 403 && rMorto.json?.erro === "personagem_falecido", `status=${rMorto.status} ${JSON.stringify(rMorto.json).slice(0,120)}`);
    // P4: streamer entra ao vivo → 201
    const entrar = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ5, titulo: "Noite de terror", descricao: "campanha ao vivo" });
    t("P4 entrar ao vivo → 201", entrar.status === 201 && entrar.json?.live?.vigente === true, `status=${entrar.status} body=${JSON.stringify(entrar.json).slice(0,160)}`);
    const liveId = entrar.json?.live?.id;
    // P5: segunda live aberta na mesma conta → 409
    const rDup = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ5, titulo: "Segunda live" });
    t("P5 live duplicada → 409", rDup.status === 409, `status=${rDup.status}`);
    // P6: diretório público — leitor elegível vê a live com handle, sem ids internos
    const dir = await API("GET", "/ao-vivo", j2.cookie);
    const livePub = dir.json?.lives?.find((l) => l.id === liveId);
    t("P6 diretório lista a live", !!livePub && livePub.handle === "live.foca", JSON.stringify(dir.json?.lives?.[0]).slice(0, 200));
    t("P6b sem ids internos na serialização", !!livePub && livePub.personagemId === undefined && livePub.contaId === undefined, JSON.stringify(livePub).slice(0, 200));
    // P7: não-titular não encerra a live alheia (j2 tenta sair da live de j1) → 404
    const rSairAlheio = await API("POST", `/ao-vivo/${liveId}/sair`, j2.cookie);
    t("P7 sair live alheia → 404", rSairAlheio.status === 404, `status=${rSairAlheio.status}`);
    // P8: titular sai → diretório esvazia
    const sair = await API("POST", `/ao-vivo/${liveId}/sair`, j1.cookie);
    t("P8 sair → 200", sair.status === 200, `status=${sair.status}`);
    const dir2 = await API("GET", "/ao-vivo", j2.cookie);
    t("P8b diretório vazio após sair", (dir2.json?.lives ?? []).length === 0, JSON.stringify(dir2.json).slice(0, 120));
    // P9: live expirada some da leitura (TTL derivado — força expira_em)
    const reEntrar = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ5, titulo: "Live dois" });
    const liveId2 = reEntrar.json?.live?.id;
    const dbExp = abrirDb(BANCO);
    dbExp.prepare("update internet_ao_vivo set expira_em=? where id=?").run(Date.now() - 1000, liveId2);
    dbExp.close();
    const dir3 = await API("GET", "/ao-vivo", j2.cookie);
    t("P9 live expirada fora do diretório", !(dir3.json?.lives ?? []).some((l) => l.id === liveId2), JSON.stringify(dir3.json).slice(0, 120));
    const detExp = await API("GET", `/ao-vivo/${liveId2}`, j2.cookie);
    t("P9b detalhe de expirada → 404", detExp.status === 404, `status=${detExp.status}`);
    // P9c/P9d (TG #402 P1): live expirada por TTL não pode travar a
    // conta — POST /ao-vivo lazy-closes as expiradas na mesma tx
    // (antes: UNIQUE parcial → 409 eterno, /sair exigia id oculto).
    const reLive3 = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ5, titulo: "Live três" });
    t("P9c entrar após expirar → 201", reLive3.status === 201, `status=${reLive3.status} ${JSON.stringify(reLive3.json).slice(0,120)}`);
    const encErrada = (() => { const db = abrirDb(BANCO); const r = db.prepare("select encerrado_em from internet_ao_vivo where id=?").get(liveId2); db.close(); return r?.encerrado_em; })();
    t("P9d expirada lazy-closed (encerrado_em preenchido)", !!encErrada, `encerrado_em=${encErrada}`);

    // P10: seguidores — aresta idempotente, contador derivado
    const seg = await API("POST", "/contas/live.foca/seguir", j2.cookie);
    t("P10 seguir → 200 seguidores=1", seg.status === 200 && seg.json?.seguidores === 1, `status=${seg.status} body=${JSON.stringify(seg.json).slice(0,120)}`);
    const seg2 = await API("POST", "/contas/live.foca/seguir", j2.cookie);
    t("P10b seguir de novo → idempotente", seg2.status === 200 && seg2.json?.seguidores === 1, `status=${seg2.status}`);
    const nSeg = (() => { const db = abrirDb(BANCO); const r = db.prepare("select count(*) n from internet_seguidores where alvo_conta_id=(select id from internet_accounts where handle='live.foca')").get(); db.close(); return r?.n; })();
    t("P10c uma única aresta", nSeg === 1, `arestas=${nSeg}`);
    // P11: auto-seguir → 400 — j2 controla duas contas (bia.semaresta
    // e duda.foca); a aresta conta→ela mesma é inválida. origemContaId
    // explícito (mesmo padrão /contatar) torna o alvo determinístico.
    const contaDuda = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_accounts where campaign_id=? and handle='duda.foca'").get(campId); db.close(); return r?.id; })();
    const segSelf = await API("POST", "/contas/duda.foca/seguir", j2.cookie, { origemContaId: contaDuda });
    t("P11 auto-seguir → 400", segSelf.status === 400, `status=${segSelf.status}`);
    // P12: perfil público expõe contador derivado
    const perfilLive = await API("GET", "/perfis/live.foca", j2.cookie);
    t("P12 perfil mostra seguidores=1", perfilLive.status === 200 && perfilLive.json?.perfil?.seguidores === 1, `status=${perfilLive.status} body=${JSON.stringify(perfilLive.json?.perfil).slice(0,160)}`);
    // P13: deixar de seguir → contador zera
    const desf = await API("POST", "/contas/live.foca/deixar-de-seguir", j2.cookie);
    t("P13 deixar de seguir → seguidores=0", desf.status === 200 && desf.json?.seguidores === 0, `status=${desf.status}`);
    // P14: views — incremento atômico só em matéria publicada vigente
    const idViews = semearPublicacao(BANCO, { campId, titulo: "Matéria views", corpo: "x", autorContaId: null, autorModo: "anonimo" });
    const v1 = await API("GET", `/publicacoes/${idViews}`, j2.cookie);
    const v2 = await API("GET", `/publicacoes/${idViews}`, j2.cookie);
    t("P14 views incrementa por leitura", v1.json?.publicacao?.views === 1 && v2.json?.publicacao?.views === 2,
      `v1=${v1.json?.publicacao?.views} v2=${v2.json?.publicacao?.views}`);
    const idExp = semearPublicacao(BANCO, { campId, titulo: "Expirada", corpo: "x", autorContaId: null, autorModo: "anonimo", publicadoEm: Date.now() - 100000 });
    const dbV = abrirDb(BANCO);
    dbV.prepare("update internet_publicacoes set expires_at=? where id=?").run(Date.now() - 1000, idExp);
    dbV.close();
    const vExp = await API("GET", `/publicacoes/${idExp}`, j2.cookie);
    t("P15 expirada não incrementa views", vExp.json?.publicacao?.views === 0 && vExp.json?.publicacao?.expirado === true,
      `views=${vExp.json?.publicacao?.views} expirado=${vExp.json?.publicacao?.expirado}`);
    // P16 (INTERMEDIÁRIO P2 #402): arquivado não entra ao vivo —
    // conta criada com personagem ativo, arquiva via SQL, entrar →
    // rejeitado (somente leitura).
    const charJ6 = C.novoPersonagem(C.jogadores.j1.membershipId, "Live Arquivada", { comp: 1, prof: "streamer" });
    darDispositivo(BANCO, charJ6);
    const c6 = await API("POST", "/account", j1.cookie, { characterId: charJ6, handle: "live.arquivo" });
    t("P16a conta Internet do arquivado → 201", c6.status === 201, `status=${c6.status}`);
    {
      const db = abrirDb(BANCO);
      db.prepare("update characters set status='arquivado' where id=?").run(charJ6);
      db.close();
    }
    const rArq = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ6, titulo: "Live arquivada" });
    t("P16b arquivado não entra ao vivo → 403/404", rArq.status === 403 || rArq.status === 404,
      `status=${rArq.status} ${JSON.stringify(rArq.json).slice(0, 120)}`);

    // P17 (INTERMEDIÁRIO P2 #402): morte DURANTE a transmissão — a
    // "Live três" do charJ5 segue aberta; forçar __morte → some do
    // diretório e detalhe → 404 (revalidação derivada na leitura,
    // sem job — a linha morre pelo TTL).
    const live3Id = reLive3.json?.live?.id;
    {
      const db = abrirDb(BANCO);
      const row = db.prepare("select data from characters where id=?").get(charJ5);
      const dados = JSON.parse(row.data);
      dados.__morte = [{ em: new Date().toISOString(), causa: "teste P17" }];
      db.prepare("update characters set data=? where id=?").run(JSON.stringify(dados), charJ5);
      db.close();
    }
    const dirMorto = await API("GET", "/ao-vivo", j2.cookie);
    t("P17 live de morto some do diretório", !(dirMorto.json?.lives ?? []).some((l) => l.id === live3Id),
      JSON.stringify((dirMorto.json?.lives ?? []).map((l) => l.id)));
    const detMorto = await API("GET", `/ao-vivo/${live3Id}`, j2.cookie);
    t("P17b detalhe de live de morto → 404", detMorto.status === 404, `status=${detMorto.status}`);

    // P18 (Dono #402 P1): live aberta → personagem ARQUIVADO durante
    // a transmissão — some do diretório, detalhe 404 e a linha é
    // ENCERRADA de fato (encerrado_em preenchido pela varredura
    // derivada na leitura — não é só filtro visual).
    const charJ7 = C.novoPersonagem(C.jogadores.j1.membershipId, "Live Sete", { comp: 1, prof: "streamer" });
    darDispositivo(BANCO, charJ7);
    await API("POST", "/account", j1.cookie, { characterId: charJ7, handle: "live.sete" });
    const lv7 = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ7, titulo: "Live sete" });
    t("P18a live aberta antes do arquivamento", lv7.status === 201, `status=${lv7.status}`);
    const live7Id = lv7.json?.live?.id;
    {
      const db = abrirDb(BANCO);
      db.prepare("update characters set status='arquivado' where id=?").run(charJ7);
      db.close();
    }
    const dirArq = await API("GET", "/ao-vivo", j2.cookie);
    t("P18b live de arquivado some do diretório", !(dirArq.json?.lives ?? []).some((l) => l.id === live7Id),
      JSON.stringify((dirArq.json?.lives ?? []).map((l) => l.id)));
    const detArq = await API("GET", `/ao-vivo/${live7Id}`, j2.cookie);
    t("P18c detalhe de live de arquivado → 404", detArq.status === 404, `status=${detArq.status}`);
    const encArq = (() => { const db = abrirDb(BANCO); const r = db.prepare("select encerrado_em from internet_ao_vivo where id=?").get(live7Id); db.close(); return r?.encerrado_em; })();
    t("P18d live de arquivado encerrada de fato", encArq !== null && encArq !== undefined, `encerrado_em=${encArq}`);

    // P19 (Dono #402 P1): live aberta → CONTA desativada durante a
    // transmissão — mesmo tratamento: some, 404, encerrada.
    const charJ8 = C.novoPersonagem(C.jogadores.j1.membershipId, "Live Oito", { comp: 1, prof: "streamer" });
    darDispositivo(BANCO, charJ8);
    await API("POST", "/account", j1.cookie, { characterId: charJ8, handle: "live.oito" });
    const lv8 = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ8, titulo: "Live oito" });
    t("P19a live aberta antes da desativação", lv8.status === 201, `status=${lv8.status}`);
    const live8Id = lv8.json?.live?.id;
    {
      const db = abrirDb(BANCO);
      db.prepare("update internet_accounts set status='inativa' where handle='live.oito'").run();
      db.close();
    }
    const dirInat = await API("GET", "/ao-vivo", j2.cookie);
    t("P19b live de conta inativa some do diretório", !(dirInat.json?.lives ?? []).some((l) => l.id === live8Id),
      JSON.stringify((dirInat.json?.lives ?? []).map((l) => l.id)));
    const detInat = await API("GET", `/ao-vivo/${live8Id}`, j2.cookie);
    t("P19c detalhe de live de conta inativa → 404", detInat.status === 404, `status=${detInat.status}`);
    const encInat = (() => { const db = abrirDb(BANCO); const r = db.prepare("select encerrado_em from internet_ao_vivo where id=?").get(live8Id); db.close(); return r?.encerrado_em; })();
    t("P19d live de conta inativa encerrada de fato", encInat !== null && encInat !== undefined, `encerrado_em=${encInat}`);

    // P20 (Dono #402 / adjudicação TG 7233180172): gate aceita
    // pericia:influencer — ruleset v10 canônico tem a perícia sem
    // profissão. Personagem com SÓ infl=1 (sem prof streamer) entra.
    const charJ9 = C.novoPersonagem(C.jogadores.j1.membershipId, "Live Influencer", { comp: 1, infl: 1 });
    darDispositivo(BANCO, charJ9);
    await API("POST", "/account", j1.cookie, { characterId: charJ9, handle: "live.infl" });
    const lv9 = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ9, titulo: "Live influencer" });
    t("P20 pericia:influencer entra ao vivo → 201", lv9.status === 201, `status=${lv9.status} ${JSON.stringify(lv9.json).slice(0, 140)}`);
    // P20b: sem nenhum dos três → 403 (fail-closed mantido)
    const charJ10 = C.novoPersonagem(C.jogadores.j1.membershipId, "Sem Gate", { comp: 1 });
    darDispositivo(BANCO, charJ10);
    await API("POST", "/account", j1.cookie, { characterId: charJ10, handle: "live.sem" });
    const lv10 = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ10, titulo: "Sem gate" });
    t("P20b sem streamer/influencer → 403", lv10.status === 403, `status=${lv10.status}`);

    // P21/P22 (TG #402 TOCTOU — adjudicado P2): titularidade/morte
    // relidos DENTRO da tx do /ao-vivo. A janela exata não é
    // reproduzível deterministicamente neste harness (tx síncrona,
    // servidor em processo separado) — a cobertura prova o invariante
    // de estado final: quem perdeu titularidade/conta não transmite.
    // charJ5 segue streamer; "transferência" = membership_id direto.
    {
      const db = abrirDb(BANCO);
      db.prepare("update characters set membership_id=? where id=?").run(C.jogadores.j2.membershipId, charJ5);
      db.close();
    }
    const lvT = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ5, titulo: "Live ex-titular" });
    t("P21 ex-titular não entra ao vivo → 404", lvT.status === 404, `status=${lvT.status}`);
    {
      const db = abrirDb(BANCO);
      db.prepare("update characters set membership_id=? where id=?").run(C.jogadores.j1.membershipId, charJ5);
      const conta5 = db.prepare("select id from internet_accounts where character_id=?").get(charJ5);
      db.prepare("update internet_accounts set status='inativa' where id=?").run(conta5.id);
      db.close();
    }
    const lvI = await API("POST", "/ao-vivo", j1.cookie, { characterId: charJ5, titulo: "Live conta inativa" });
    t("P22 conta inativa não entra ao vivo → 404", lvI.status === 404, `status=${lvI.status}`);
    {
      const db = abrirDb(BANCO);
      const conta5 = db.prepare("select id from internet_accounts where character_id=?").get(charJ5);
      db.prepare("update internet_accounts set status='ativa' where id=?").run(conta5.id);
      db.close();
    }
  }
  // ================= W2/timeline — correções Dono+TG (#400) =================
  // Pacote adjudicado: `contatos` NUNCA em busca/timeline (mesmo com
  // aresta), expiração no SQL antes do corte, paginação keyset sem
  // caps truncadores (L+1 por categoria), V-08 sem PK de site/página
  // no payload, DP-5 TOCTOU com morte revalidada dentro da tx.
  sec("Q. W2/timeline — contatos fora, caps removidos, V-08, DP-5 tx");
  try {
    const BUSCA_Q = (q, extra = "") => `/campaigns/${campId}/internet/busca?q=${encodeURIComponent(q)}${extra}`;
    const agoraMs = Date.now();

    // Q1: >100 publicações 'contatos' (invisíveis MESMO com aresta
    // aceita j2→j1) mais antigas que uma 'campanha' visível — o cap
    // antigo de 100 linhas sem filtro a escondia; agora o WHERE
    // exclui contatos antes do LIMIT.
    for (let i = 0; i < 110; i++) {
      semearPublicacao(BANCO, { campId, tipo: "noticia", titulo: `QCT${i} segredo`, corpo: "corpo", status: "publicado", visibilidade: "contatos", autorContaId: contaJ1, publicadoEm: agoraMs - 100000 - i });
    }
    semearPublicacao(BANCO, { campId, tipo: "noticia", titulo: "QVCPUB visivel antiga", corpo: "corpo", status: "publicado", visibilidade: "campanha", autorContaId: contaJ1, publicadoEm: agoraMs - 200000 });
    // publicação campanha EXPIRADA com o mesmo prefixo — fora da busca
    const pubExpQ = semearPublicacao(BANCO, { campId, tipo: "noticia", titulo: "QVEXPIRADA velha", corpo: "corpo", status: "publicado", visibilidade: "campanha", autorContaId: contaJ1, publicadoEm: agoraMs - 300000 });
    {
      const db = abrirDb(BANCO);
      db.prepare("update internet_publicacoes set expires_at=? where id=?").run(agoraMs - 1000, pubExpQ);
      db.close();
    }
    const rQV = await req(BASE, "GET", BUSCA_Q("QV"), { cookie: j2.cookie });
    const titulosQV = (rQV.json?.resultados ?? []).map((i) => i.titulo ?? "");
    t("Q1a publicação campanha antiga aparece apesar de 110 contatos", rQV.status === 200 && titulosQV.some((x) => x.includes("QVCPUB")), `status=${rQV.status} n=${titulosQV.length}`);
    t("Q1b 'contatos' NUNCA em busca mesmo com aresta aceita", !titulosQV.some((x) => x.includes("QCT")), JSON.stringify(titulosQV).slice(0, 200));
    t("Q1c publicação expirada fora da busca", !titulosQV.some((x) => x.includes("QVEXPIRADA")), "");

    // Q2a: 55 sites (> cap antigo de 50) — keyset alcança todos.
    {
      const db = abrirDb(BANCO);
      const ins = db.prepare("insert into internet_sites (id,campaign_id,slug,nome,descricao,status,created_at,updated_at) values (?,?,?,?,?,?,?,?)");
      for (let i = 0; i < 55; i++) ins.run(crypto.randomUUID(), campId, `qsite-${i}`, `QsiteVolume ${i}`, "desc QVOLSITE", "ativo", agoraMs - 500000 + i, agoraMs);
      db.close();
    }
    // Q2b: 55 páginas publicadas (> cap antigo de 50).
    {
      const db = abrirDb(BANCO);
      const siteId = db.prepare("select id from internet_sites where campaign_id=? and slug='qsite-0'").get(campId).id;
      const ins = db.prepare("insert into internet_pages (id,site_id,campaign_id,slug,titulo,corpo,formato,status,version,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)");
      for (let i = 0; i < 55; i++) ins.run(crypto.randomUUID(), siteId, campId, `qpag-${i}`, `QpagVolume ${i}`, "corpo QVOLPAG", "texto", "publicado", 1, agoraMs - 400000 + i, agoraMs);
      db.close();
    }
    // Q2c: 25 perfis (> cap antigo de 20) — semeados via SQL (sem
    // rate-limit de API): personagem + conta + perfil por handle.
    {
      const db = abrirDb(BANCO);
      const membJ1 = C.jogadores.j1.membershipId;
      const tpl = db.prepare("select template_version_id from characters where campaign_id=? limit 1").get(campId);
      const insChar = db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)");
      const insAcc = db.prepare("insert into internet_accounts (id,campaign_id,character_id,handle,status,mostrar_presenca,mostrar_digitando,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)");
      const insPerf = db.prepare("insert into internet_perfis (id,campaign_id,character_id,ativado_em,created_at,updated_at) values (?,?,?,?,?,?)");
      for (let i = 0; i < 25; i++) {
        const chId = crypto.randomUUID(), accId = crypto.randomUUID(), pId = crypto.randomUUID();
        insChar.run(chId, campId, membJ1, tpl.template_version_id, `QVPerf${i}`, "{}", "{}", "aprovada", 0, agoraMs, agoraMs);
        insAcc.run(accId, campId, chId, `qvperf${String(i).padStart(2, "0")}`, "ativa", 0, 0, agoraMs, agoraMs);
        insPerf.run(pId, campId, chId, agoraMs - 300000 + i, agoraMs, agoraMs);
      }
      db.close();
    }
    // pagina tudo com limit=10 até esgotar o cursor
    const contarEscopo = async (q, escopo) => {
      let vistos = 0, cursor = "", paginas = 0;
      do {
        const r = await req(BASE, "GET", BUSCA_Q(q, `&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), { cookie: j2.cookie });
        if (r.status !== 200) return { vistos: -1, erro: r.status };
        vistos += (r.json?.resultados ?? []).filter((i) => i.escopo === escopo).length;
        cursor = r.json?.nextCursor ?? "";
        paginas++;
      } while (cursor && paginas < 30);
      return { vistos, paginas };
    };
    const rSites = await contarEscopo("QsiteVol", "site");
    t("Q2a 55 sites > cap 50 — todos alcançáveis via cursor", rSites.vistos >= 55, JSON.stringify(rSites));
    const rPags = await contarEscopo("QpagVol", "pagina");
    t("Q2b 55 páginas > cap 50 — todas alcançáveis", rPags.vistos >= 55, JSON.stringify(rPags));
    const rPerfs = await contarEscopo("qvperf", "perfil");
    t("Q2c 25 perfis > cap 20 — todos alcançáveis", rPerfs.vistos >= 25, JSON.stringify(rPerfs));

    // Q3: V-08 — payload sem PK interna de site/página (e sem
    // criadoEmMs interno); refs públicas preservadas.
    const rPk = await req(BASE, "GET", BUSCA_Q("QsiteVol", "&limit=5"), { cookie: j2.cookie });
    const rPkP = await req(BASE, "GET", BUSCA_Q("QpagVol", "&limit=5"), { cookie: j2.cookie });
    const itemSite = (rPk.json?.resultados ?? []).find((i) => i.escopo === "site");
    const itemPag = (rPkP.json?.resultados ?? []).find((i) => i.escopo === "pagina");
    const chavesOk = (i) => i && Object.keys(i).every((k) => ["escopo", "titulo", "trecho", "ref", "ref2"].includes(k));
    t("Q3a site serializado sem id/criadoEmMs (allowlist)", chavesOk(itemSite), JSON.stringify(itemSite));
    t("Q3b página serializada sem id/criadoEmMs", chavesOk(itemPag), JSON.stringify(itemPag));
    t("Q3c refs públicas preservadas (slug/siteSlug+pageSlug)", !!itemSite?.ref && !!itemPag?.ref && !!itemPag?.ref2, JSON.stringify({ s: itemSite?.ref, p: [itemPag?.ref, itemPag?.ref2] }));

    // Q4: tie-break de timestamp — itens de categorias distintas com
    // o MESMO ms ordenam deterministicamente por chave DESC e o
    // cursor não repete nem pula.
    {
      const db = abrirDb(BANCO);
      const tsEmpate = agoraMs - 600000;
      db.prepare("insert into internet_sites (id,campaign_id,slug,nome,descricao,status,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
        .run("tie-site-aaaa", campId, "tie-site-a", "QTIE site alpha", "x", "ativo", tsEmpate, agoraMs);
      const pubTie = semearPublicacao(BANCO, { campId, tipo: "noticia", titulo: "QTIE pub beta", corpo: "x", status: "publicado", visibilidade: "campanha", autorContaId: contaJ1, publicadoEm: tsEmpate });
      db.prepare("update internet_publicacoes set created_at=? where id=?").run(tsEmpate, pubTie);
      db.close();
      const rTie = await req(BASE, "GET", BUSCA_Q("QTIE", "&limit=10"), { cookie: j2.cookie });
      const ord = (rTie.json?.resultados ?? []).map((i) => `${i.escopo}:${i.titulo}`);
      t("Q4a empate de timestamp retorna as duas categorias", ord.length >= 2, JSON.stringify(ord));
      // empate total → chave DESC: "tie-site-aaaa" > uuid hex da
      // publicação → site ordena primeiro (determinístico).
      t("Q4b empate resolve por chave DESC (site antes da publicação)", ord[0] === "site:QTIE site alpha", JSON.stringify(ord));
    }

    // Q5: timeline do perfil — `contatos` NUNCA (mesmo com aresta
    // aceita), expirados fora, anônima só p/ titular. Cenário próprio:
    // j3 perdeu permissão no restore da seção O e charJ1 morreu na H;
    // charJ2 mudou de titular (P7). Criamos charQ de j2 + conta +
    // perfil; leitor com aresta = j1 via contaJ2 (conta do charJ2,
    // hoje de j1).
    const charQ = C.novoPersonagem(C.jogadores.j2.membershipId, "QPerf Beto", { comp: 1, prof: "medico" });
    darDispositivo(BANCO, charQ);
    const cQ = await API("POST", "/account", j2.cookie, { characterId: charQ, handle: "qperf.beto" });
    const contaQ = cQ.json?.conta?.id;
    t("Q5a-1 conta qperf.beto criada", cQ.status === 201 && !!contaQ, `status=${cQ.status} ${JSON.stringify(cQ.json).slice(0, 160)}`);
    const rAtivarQ = await req(BASE, "POST", `/campaigns/${campId}/internet/perfil/ativar`, { cookie: j2.cookie, body: { characterId: charQ } });
    t("Q5a0 perfil qperf.beto ativado", rAtivarQ.status === 201 || rAtivarQ.status === 200, `status=${rAtivarQ.status} ${JSON.stringify(rAtivarQ.json).slice(0, 200)}`);
    // aresta aceita contaJ2(j1)↔contaQ(j2): j1 é leitor COM aresta do
    // autor — prova de que 'contatos' não vaza nem com aresta vigente.
    aresta(BANCO, { campId, origemId: contaJ2, destinoId: contaQ, status: "aceito" });
    semearPublicacao(BANCO, { campId, tipo: "post_perfil", titulo: "QTLCONT so contatos", corpo: "x", status: "publicado", visibilidade: "contatos", autorContaId: contaQ, publicadoEm: agoraMs - 1000 });
    semearPublicacao(BANCO, { campId, tipo: "post_perfil", titulo: "QTLVIS campanha", corpo: "x", status: "publicado", visibilidade: "campanha", autorContaId: contaQ, publicadoEm: agoraMs - 2000 });
    const pubTlExp = semearPublicacao(BANCO, { campId, tipo: "post_perfil", titulo: "QTLEXP expirada", corpo: "x", status: "publicado", visibilidade: "campanha", autorContaId: contaQ, publicadoEm: agoraMs - 3000 });
    semearPublicacao(BANCO, { campId, tipo: "anuncio", titulo: "QTLANON anonimo", corpo: "x", status: "publicado", visibilidade: "campanha", autorContaId: contaQ, autorModo: "anonimo", publicadoEm: agoraMs - 4000 });
    {
      const db = abrirDb(BANCO);
      db.prepare("update internet_publicacoes set expires_at=? where id=?").run(agoraMs - 500, pubTlExp);
      db.close();
    }
    const rTlJ1 = await req(BASE, "GET", `/campaigns/${campId}/internet/perfis/qperf.beto`, { cookie: j1.cookie });
    const tlJ1 = JSON.stringify(rTlJ1.json?.perfil?.publicacoes ?? []);
    t("Q5a timeline: campanha visível presente", tlJ1.includes("QTLVIS"), `status=${rTlJ1.status}`);
    t("Q5b timeline: 'contatos' ausente MESMO com aresta aceita", !tlJ1.includes("QTLCONT"), tlJ1.slice(0, 200));
    t("Q5c timeline: expirada fora", !tlJ1.includes("QTLEXP"), "");
    t("Q5d timeline: anônima oculta p/ terceiro", !tlJ1.includes("QTLANON"), "");
    const rTlJ2 = await req(BASE, "GET", `/campaigns/${campId}/internet/perfis/qperf.beto`, { cookie: j2.cookie });
    const pubsJ2 = rTlJ2.json?.perfil?.publicacoes ?? [];
    const anonJ2 = pubsJ2.find((p) => p.titulo === "QTLANON anonimo");
    t("Q5e timeline titular: anônima aparece marcada 'anonima'", !!anonJ2 && anonJ2.anonima === true, JSON.stringify(anonJ2));
    t("Q5f timeline titular: 'contatos' continua fora", !JSON.stringify(pubsJ2).includes("QTLCONT"), "");

    // Q6: DP-5 TOCTOU — PATCH/avatar revalidam morte DENTRO da tx
    // (perfil de charQ já ativo desde Q5a0).
    const rPatchVivo = await req(BASE, "PATCH", `/campaigns/${campId}/internet/perfil`, { cookie: j2.cookie, body: { characterId: charQ, descricao: "vivo" } });
    t("Q6b PATCH perfil vivo → 200", rPatchVivo.status === 200, `status=${rPatchVivo.status}`);
    {
      const db = abrirDb(BANCO);
      const row = db.prepare("select data from characters where id=?").get(charQ);
      const dados = JSON.parse(row.data);
      dados.__morte = [{ em: new Date(agoraMs).toISOString(), causa: "teste Q6", revertidaEm: null }];
      db.prepare("update characters set data=? where id=?").run(JSON.stringify(dados), charQ);
      db.close();
    }
    const rPatchMorto = await req(BASE, "PATCH", `/campaigns/${campId}/internet/perfil`, { cookie: j2.cookie, body: { characterId: charQ, descricao: "morto" } });
    t("Q6c PATCH perfil morto → 403 personagem_falecido", rPatchMorto.status === 403 && JSON.stringify(rPatchMorto.json).includes("falecido"), `status=${rPatchMorto.status} ${JSON.stringify(rPatchMorto.json).slice(0, 120)}`);
    const rAvMorto = await req(BASE, "POST", `/campaigns/${campId}/internet/perfil/avatar`, { cookie: j2.cookie, body: { characterId: charQ, arquivoId: crypto.randomUUID() } });
    t("Q6d POST avatar morto → 403 personagem_falecido (gate antes do arquivo)", rAvMorto.status === 403 && JSON.stringify(rAvMorto.json).includes("falecido"), `status=${rAvMorto.status}`);
  } catch (eQ) {
    fail++;
    console.log("  FALHOU exceção na seção Q:", String(eQ).slice(0, 500));
  }
} finally {
  if (proc) await encerrarServidor(proc);
  console.log(`\n${pass} ok, ${fail} falhas`);
  limparDir(DIR);
  process.exit(fail ? 1 : 0);
}
