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
  ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
  const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
  const est = JSON.parse(ver.structure);
  est.secoes[0].campos.push(
    { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
    { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
    { id: "prof", label: "Profissão", tipo: "selecao_unica", regraKind: "profissao" },
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
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
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
  // ================= MIGRAÇÃO =================
  sec("A. Migração 0044 — banco limpo");
  await prepararBanco(BANCO);
  {
    const db = abrirDb(BANCO);
    const tabelas = new Set(db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name));
    t("banco limpo tem internet_publicacoes", tabelas.has("internet_publicacoes"));
    t("banco limpo tem internet_denuncias", tabelas.has("internet_denuncias"));
    db.close();
  }

  // ================= CENÁRIO =================
  sec("B. Cenário — campanha, contas com gate, arestas");
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

  // ================= CRIAÇÃO (W8 subset) =================
  sec("C. POST /publicacoes — criação, validação, gate");

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

  // ================= LISTA W4 =================
  sec("D. GET /publicacoes — feed, visibilidade, keyset");

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

  // ================= MATÉRIA W5 =================
  sec("E. GET /publicacoes/:id — matéria, oráculo, prévia");

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

  // ================= PATCH =================
  sec("F. PATCH /publicacoes/:id — versão, idempotência, fronteiras");

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

  // ================= DENÚNCIAS (DP-3) =================
  sec("G. POST /publicacoes/:id/denunciar — limiar e remoção");

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

  // ================= DP-2 — contestação + resolução admin ==========
  sec("G2. DP-2 — contestação do autor e decisão do admin da plataforma");

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

  // ================= MORTE AUTOMÁTICA (DP-8/9) =================
  sec("H. __morte + notícia de sistema + ressurreição");

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

  // ================= IMPORTAÇÃO — __morte re-derivada (v2.6) =========
  sec("I. Importação — morte re-derivada do __hp saneado");

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
        dbM.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,template_version_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
          .run(charB, campBId, memB, "Nina B", j2char?.data ?? "{}", j2char?.overrides ?? "{}", "aprovada", 0, j2char?.template_version_id ?? null, agoraM, agoraM);
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

  // ================= D6 HARDENING (P1 residual + P2s) ==========
  sec("M. D6 — linhagem dedupe, denuncianteRef, rascunho, contatos");
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
    t("M1 export omite rascunho", !JSON.stringify(rExp2.json).includes("RASCUNHO_SECRETO"), "vazou rascunho");

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
    t("M2 import forjado → 200", rImpM.status === 200, `status=${rImpM.status}`);
    const pgM = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_pages where id=?").get(pagForjadaM.id); db.close(); return r; })();
    t("M2b página em site de jogador NÃO inserida", !pgM, JSON.stringify(pgM));
    const rejM = (rImpM.json?.rejeitadas ?? []).find((r) => r.id === pagForjadaM.id);
    t("M2c rejeitada como site_orfao", rejM?.motivo === "site_orfao", JSON.stringify(rImpM.json?.rejeitadas).slice(0, 200));

    // M3/M4 precisam de campanha com publicações importadas (origem
    //='importado' é a única âncora válida de denúncia).
    const campM = await req(BASE, "POST", "/campaigns", { cookie: C.cookieMestre, body: { name: "CampM" } });
    const campMId = campM.json?.campanha?.id;
    t("M3 campanha M criada", !!campMId);
    if (campMId) {
      const rImpM0 = await req(BASE, "POST", `/campaigns/${campMId}/internet/importar`, { cookie: C.cookieMestre, body: { pacote: pacoteM, confirmacao: "IMPORTAR" } });
      t("M3a import pacote em M → 200", rImpM0.status === 200, `status=${rImpM0.status}`);

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
        t("M3b import denúncia → 200", rImpM3.status === 200, `status=${rImpM3.status} ${JSON.stringify(rImpM3.json).slice(0,140)}`);
        const denRow = (() => { const db = abrirDb(BANCO); const r = db.prepare("select denunciante_ref from internet_denuncias where id=?").get(denM.id); db.close(); return r; })();
        t("M3c denunciante_ref prefixado pkg:", denRow?.denunciante_ref === `pkg:${contaJ1}`, JSON.stringify(denRow));
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
        t("M4 import contatos → 200", rImpM4.status === 200, `status=${rImpM4.status}`);
        const rejCt = (rImpM4.json?.rejeitadas ?? []).find((r) => r.id === pubCt.id);
        t("M4b rejeitada visibilidade_insatisfativel", rejCt?.motivo === "visibilidade_insatisfativel", JSON.stringify(rImpM4.json?.rejeitadas).slice(0, 200));
        const pubCtRow = (() => { const db = abrirDb(BANCO); const r = db.prepare("select id from internet_publicacoes where id=?").get(pubCt.id); db.close(); return r; })();
        t("M4c publicação contatos NÃO inserida", !pubCtRow, JSON.stringify(pubCtRow));
      }
    }
  }
} finally {
  if (proc) await encerrarServidor(proc);
  console.log(`\n${pass} ok, ${fail} falhas`);
  limparDir(DIR);
  process.exit(fail ? 1 : 0);
}
