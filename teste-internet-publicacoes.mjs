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
  const charJ1 = C.novoPersonagem(C.jogadores.j1.membershipId, "Ada Foca", { comp: 1 });
  const charJ2 = C.novoPersonagem(C.jogadores.j2.membershipId, "Beto Foca", { comp: 1 });
  const charJ3 = C.novoPersonagem(C.jogadores.j3.membershipId, "Cida Foca", { comp: 1 });
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

  const semConta = await API("POST", "/publicacoes", C.cookieMestre, { tipo: "noticia", titulo: "X", corpo: "y" });
  t("mestre sem conta diegética → 403", semConta.status === 403, `status=${semConta.status}`);

  const invalido = await API("POST", "/publicacoes", j1.cookie, { tipo: "anuncio", titulo: "X", corpo: "y" });
  t("tipo fora do subset → 400", invalido.status === 400);
  const html = await API("POST", "/publicacoes", j1.cookie, { tipo: "noticia", titulo: "X", corpo: "<script>x</script>" });
  t("HTML cru no corpo → 400 formato_invalido", html.status === 400);
  const pseudoSemNome = await API("POST", "/publicacoes", j1.cookie, { tipo: "noticia", titulo: "X", corpo: "y", autorModo: "pseudonimo" });
  t("pseudônimo sem pseudoNome → 400", pseudoSemNome.status === 400);

  const pubCampanha = await API("POST", "/publicacoes", j1.cookie, {
    tipo: "noticia", titulo: "Eleição na taverna", corpo: "A aba venceu.",
    visibilidade: "campanha", statusInicial: "publicado",
  });
  t("j1 publica notícia → 201", pubCampanha.status === 201, JSON.stringify(pubCampanha.json).slice(0, 200));
  const pubA = pubCampanha.json?.publicacao?.id;
  t("publicadoEm preenchido ao publicar", !!pubCampanha.json?.publicacao?.publicadoEm);
  t("autorContaId = conta do requisitante", pubCampanha.json?.publicacao?.autorContaId === contaJ1);
  t("origem=usuario forjada no body é ignorada (strict)", pubCampanha.json?.publicacao?.origem === "usuario");

  const pubContatos = await API("POST", "/publicacoes", j1.cookie, {
    tipo: "post_perfil", titulo: "Só pra contatos", corpo: "segredo",
    visibilidade: "contatos", autorModo: "pseudonimo", pseudoNome: "A. F.",
    statusInicial: "publicado",
  });
  t("post_perfil pseudônimo publicado → 201", pubContatos.status === 201, JSON.stringify(pubContatos.json).slice(0, 200));
  const pubB = pubContatos.json?.publicacao?.id;

  const rascunho = await API("POST", "/publicacoes", j1.cookie, {
    tipo: "noticia", titulo: "Rascunho", corpo: "em preparo",
  });
  t("sem statusInicial → rascunho", rascunho.status === 201 && rascunho.json?.publicacao?.status === "rascunho");
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
  t("pseudônimo expõe pseudoNome", itemB?.autor?.modo === "pseudonimo" && itemB?.autor?.nome === "A. F.");
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
  const naoAutor = await API("PATCH", `/publicacoes/${pubA}`, j2.cookie, { titulo: "Sequestro", expectedVersion: 1 });
  t("não-autor → 404 (anti-oráculo)", naoAutor.status === 404);
  const conflito = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { titulo: "X", expectedVersion: 99 });
  t("expectedVersion divergente → 409", conflito.status === 409);

  const edicao = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { titulo: "Eleição — resultado", expectedVersion: 1 });
  t("edição ok → 200 version=2", edicao.status === 200 && edicao.json?.publicacao?.version === 2, JSON.stringify(edicao.json).slice(0, 160));
  const mesma = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { titulo: "Eleição — resultado", expectedVersion: 2 });
  t("PATCH idempotente sem mudança → 200 sem bump", mesma.status === 200 && mesma.json?.publicacao?.version === 2);
  const despublicar = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { status: "rascunho", expectedVersion: 2 });
  t("publicado→rascunho ok", despublicar.status === 200 && despublicar.json?.publicacao?.status === "rascunho");
  const sumiuFeed = await API("GET", "/publicacoes?tipo=noticia", j1.cookie);
  t("despublicada some do feed", !(sumiuFeed.json?.publicacoes ?? []).some((p) => p.id === pubA));
  const republicar = await API("PATCH", `/publicacoes/${pubA}`, j1.cookie, { status: "publicado", expectedVersion: 3 });
  t("republicar → publicadoEm preservado (1ª publicação)", republicar.status === 200 && !!republicar.json?.publicacao?.publicadoEm);

  // ================= DENÚNCIAS (DP-3) =================
  sec("G. POST /publicacoes/:id/denunciar — limiar e remoção");

  // j1 tem 1 conta; denúncia exige conta ≠ autor → j1 não pode denunciar a própria
  const autoDenuncia = await API("POST", `/publicacoes/${pubB}/denunciar`, j1.cookie, { motivo: "spam" });
  t("auto-denúncia → 403 (sem outra conta)", autoDenuncia.status === 403, `status=${autoDenuncia.status}`);

  // publicação extra de j1 p/ denúncia por j2 e j3
  const pubDenuncia = await API("POST", "/publicacoes", j1.cookie, {
    tipo: "noticia", titulo: "Polêmica", corpo: "divisivo", statusInicial: "publicado",
  });
  const pubD = pubDenuncia.json?.publicacao?.id;
  t("publicação p/ denúncia criada", !!pubD);

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
    tipo: "noticia", titulo: "Conteúdo ilegal", corpo: "x", statusInicial: "publicado",
  });
  const pubG = pubGrave.json?.publicacao?.id;
  const dg = await API("POST", `/publicacoes/${pubG}/denunciar`, j2.cookie, { motivo: "ilegal" });
  t("denuncia_grave → removida na 1ª", dg.status === 201 && dg.json?.removida === true);
  const linhaG = lerPub(BANCO, pubG);
  t("grave: denuncia_grave=1 + removido", linhaG.denuncia_grave === 1 && linhaG.status === "removido");

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

  // segunda morte NÃO gera segunda notícia automática (só a 1ª — §5 contrato)
  await req(BASE, "POST", `/characters/${charJ1}/hp`, { cookie: j1.cookie, body: { acao: "dano", quantidade: 200, motivo: "segunda morte" } });
  const dbM2 = abrirDb(BANCO);
  const mort2 = dbM2.prepare("select count(*) n from internet_publicacoes where personagem_id=? and origem='sistema'").get(charJ1);
  t("segunda morte não duplica notícia de sistema", mort2.n === 1, `veio ${mort2.n}`);
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
  // substituir zerou o domínio Internet (pacote não o carrega) e a
  // re-derivação regenerou exatamente 1 notícia para a morte vigente
  const noticiaImp = dbImp.prepare("select * from internet_publicacoes where campaign_id=? and personagem_id=? and origem='sistema'").all(campId, charImpMorto?.id);
  t("notícia de morte regenerada na reimportação", noticiaImp.length === 1, `veio ${noticiaImp.length}`);
  dbImp.close();
} finally {
  if (proc) await encerrarServidor(proc);
  console.log(`\n${pass} ok, ${fail} falhas`);
  limparDir(DIR);
  process.exit(fail ? 1 : 0);
}
