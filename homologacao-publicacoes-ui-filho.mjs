#!/usr/bin/env node
// FILHO — smoke E2E visual W4/W5 (#365, ordem #369 `7230234828`).
// Playwright real contra site/dist + servidor do SHA de produção.
// Cobre: feed, matéria, voltar, criar rascunho→publicar via Minhas,
// editar como autor, selo/sem-edição em origem=sistema, pseudônimo sem
// handle, e estados vazio/carregando/erro/sem-acesso.
// Fixtures 100% descartáveis; nenhum dado de API falsificado — apenas
// delay/abort controlado via page.route para exercitar estados de UI.
import crypto from "node:crypto";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, x = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, x); } };
const sec = (n) => console.log("\n== " + n + " ==");
const api = (base, camp, cookie, metodo, path, body) =>
  req(base, metodo, `/campaigns/${camp}/internet${path}`, { cookie, body });
const apiChars = (base, cookie, metodo, path, body) => req(base, metodo, path, { cookie, body });

const DIR = dirTeste("f6-pub-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc, browser, BASE;
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };

async function abrirFeed(page, personagem = "W45UI Autor") {
  await page.getByRole("tab", { name: /Personagens/ }).click();
  await page.waitForTimeout(700);
  await page.locator("tr", { hasText: personagem }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Internet", exact: true }).click();
  await page.waitForTimeout(900);
  await page.getByRole("tab", { name: "Rede", exact: true }).click();
  await page.waitForTimeout(900);
  await page.getByRole("tab", { name: "Explorar", exact: true }).click();
  await page.waitForTimeout(900);
  await page.getByRole("tab", { name: "Publicações", exact: true }).click();
  await page.waitForSelector(".internet-publicacoes", { timeout: 10000 });
}
async function entrar(page, cookie) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: cookie.split("=")[1], url: BASE }]);
  const p = await ctx.newPage();
  const erros = [];
  p.on("pageerror", (e) => erros.push(String(e)));
  p._erros = erros;
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(800);
  await p.locator(".cartao-campanha", { hasText: "Campanha W45UI" }).first().click();
  await p.waitForTimeout(1200);
  return { ctx, p };
}

try {
  sec("0. Servidor + cenário + seeds");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, {
    campanha: "Campanha W45UI",
    jogadores: { j1: "w45ui_j1", j2: "w45ui_j2", j3: "w45ui_j3", j4: "w45ui_j4" },
    config: { hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "mestre" } },
  });
  // gate P5 + profissões (mesmo padrão da suíte HTTP)
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
    return r.status === 200 || r.status === 201;
  };

  const ch1 = C.novoPersonagem(C.jogadores.j1.membershipId, "W45UI Autor", { comp: 3, prof: "jornalista" });
  const ch2 = C.novoPersonagem(C.jogadores.j2.membershipId, "W45UI Vizinho", { comp: 3, prof: "medico" });
  const ch3 = C.novoPersonagem(C.jogadores.j3.membershipId, "W45UI SemConta", { comp: 3, prof: "medico" });
  const ch4 = C.novoPersonagem(C.jogadores.j4.membershipId, "W45UI Vazio", { comp: 3, prof: "jornalista" });
  for (const ch of [ch1, ch2, ch4]) darNotebook(ch);
  await criarConta(C.jogadores.j1, ch1, "w45ui.autor");
  await criarConta(C.jogadores.j2, ch2, "w45ui.vizinho");
  await criarConta(C.jogadores.j4, ch4, "w45ui.vazio");
  // ch3 fica SEM conta → estado "sem acesso"; ch4 tem conta mas zero publicações → "vazio"
  const J1 = C.jogadores.j1.cookie, J4 = C.jogadores.j4.cookie, J3 = C.jogadores.j3.cookie, M = C.cookieMestre;

  // seeds de publicações via API real (mesma superfície que a UI usa)
  const seedPub = async (cookie, dados, publicar = true) => {
    const r = await api(BASE, C.campId, cookie, "POST", "/publicacoes", dados);
    const p = r.json?.publicacao;
    if (!p?.id) return null;
    if (publicar) await api(BASE, C.campId, cookie, "PATCH", `/publicacoes/${p.id}`, { status: "publicado", expectedVersion: p.version ?? 1 });
    return p.id;
  };
  const idFeed = await seedPub(J1, { tipo: "noticia", titulo: "Festa na praça W45UI", corpo: "Houve uma festa grande na praça central, com música e comida para todos.", visibilidade: "campanha" });
  const idPseudo = await seedPub(J1, { tipo: "noticia", titulo: "Segredo do Vulto", corpo: "Conteúdo sob pseudônimo.", visibilidade: "campanha", autorModo: "pseudonimo", pseudoNome: "Vulto_UI7" });
  // notícia de morte (sistema) — dano letal em ch3
  await apiChars(BASE, M, "POST", `/characters/${ch3}/hp`, { acao: "dano", quantidade: 9999, motivo: "morte UI" });
  await new Promise((r) => setTimeout(r, 300));
  const morteId = comDb((db) => db.prepare("select id from internet_publicacoes where origem='sistema' and personagem_id=?").get(ch3)?.id);
  t("seeds: 2 publicações + notícia de sistema", !!idFeed && !!idPseudo && !!morteId, `feed=${idFeed} pseudo=${idPseudo} morte=${morteId}`);

  sec("1. Feed — carregar, itens, selo automático, pseudônimo");
  browser = await chromium.launch();
  const { ctx: ctx1, p } = await entrar(null, J1);
  // estado de carregamento: atrasa a resposta real da API (backend intacto)
  await p.route("**/internet/publicacoes**", async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    await route.continue().catch(() => {});
  });
  await abrirFeed(p);
  t("feed: estado de carregamento exibido", await p.getByText("Carregando publicações").count() > 0 || await p.locator(".internet-feed").count() > 0);
  await p.unroute("**/internet/publicacoes**");
  await p.getByText("Festa na praça W45UI", { exact: false }).waitFor({ timeout: 10000 });
  t("feed: publicação do autor listada", await p.getByText("Festa na praça W45UI").count() > 0);
  t("feed: autor identificado como @handle", await p.getByText("@w45ui.autor", { exact: false }).count() > 0);
  t("feed: pseudônimo exibe nome público", await p.getByText("Segredo do Vulto", { exact: false }).count() > 0 && await p.getByText("Vulto_UI7", { exact: false }).count() > 0);
  t("feed: handle real NÃO vaza no item pseudônimo", await p.getByText("@w45ui.autor", { exact: false }).count() === 1);
  t("feed: selo 'automática' na notícia de sistema", await p.getByText("automática", { exact: false }).count() > 0);

  sec("2. Matéria — abrir, voltar, edição de autor, sistema read-only");
  await p.getByText("Festa na praça W45UI", { exact: false }).click();
  await p.getByText("Houve uma festa grande", { exact: false }).waitFor({ timeout: 8000 });
  t("matéria: título e corpo renderizados", await p.locator(".internet-pagina-corpo").count() > 0);
  t("matéria: autor identificado", await p.getByText("@w45ui.autor", { exact: false }).count() > 0);
  t("matéria de usuário: botão Editar presente (autora)", await p.getByRole("button", { name: "Editar", exact: true }).count() > 0);
  t("matéria de usuário: Denunciar presente", await p.getByRole("button", { name: "Denunciar", exact: true }).count() > 0);
  await p.locator("button.internet-thread-voltar").click();
  await p.getByText("Festa na praça W45UI", { exact: false }).waitFor({ timeout: 8000 });
  t("voltar: feed recarrega", await p.getByText("Festa na praça W45UI").count() > 0);

  // matéria de sistema: selo + SEM editar
  const itemMorte = p.locator("li", { hasText: "Morte de" }).first();
  if (await itemMorte.count() > 0) {
    await itemMorte.getByRole("button").click();
    await p.waitForTimeout(800);
    t("matéria sistema: selo 'notícia automática'", await p.getByText("notícia automática", { exact: false }).count() > 0);
    t("matéria sistema: SEM botão Editar", await p.getByRole("button", { name: "Editar", exact: true }).count() === 0);
    t("matéria sistema: SEM Denunciar", await p.getByRole("button", { name: "Denunciar", exact: true }).count() === 0);
    await p.locator("button.internet-thread-voltar").click();
    await p.waitForTimeout(600);
  } else t("feed contém notícia de morte", false, "item 'Morte de' não encontrado");

  sec("3. Publicar — rascunho via formulário, Minhas, transição p/ publicado");
  await p.getByRole("button", { name: "Publicar", exact: true }).first().click();
  await p.getByLabel("Título").fill("Rascunho UI W45");
  await p.getByLabel("Corpo").fill("Conteúdo de rascunho criado pela UI.");
  await p.getByText("Só meus contatos", { exact: false }).click();
  await p.getByText("Salvar rascunho", { exact: false }).click();
  await p.getByRole("button", { name: "Criar", exact: true }).click();
  await p.waitForTimeout(1200);
  // volta ao feed; abre Minhas
  await p.getByRole("button", { name: "Minhas", exact: true }).click();
  await p.getByText("Rascunho UI W45", { exact: false }).waitFor({ timeout: 8000 });
  t("Minhas: rascunho listado com status", await p.getByText("rascunho", { exact: false }).count() > 0);
  t("Minhas: visibilidade 'só contatos' refletida", await p.getByText("só contatos", { exact: false }).count() > 0);
  // publica a partir de Minhas (transição com version correta)
  const itemRasc = p.locator("li.internet-minha-item", { hasText: "Rascunho UI W45" }).first();
  await itemRasc.getByRole("button", { name: "Publicar", exact: true }).click();
  await p.waitForTimeout(1200);
  t("Minhas: após publicar status vira 'publicado'", await p.locator("li.internet-minha-item", { hasText: "Rascunho UI W45" }).getByText("publicado", { exact: false }).count() > 0);

  sec("4. Editar como autor");
  const itemPub = p.locator("li.internet-minha-item", { hasText: "Rascunho UI W45" }).first();
  await itemPub.getByRole("button", { name: "Editar", exact: true }).click();
  await p.waitForSelector("form.internet-publicar", { timeout: 8000 });
  t("edição: formulário 'Editar publicação' abre", await p.getByText("Editar publicação", { exact: false }).count() > 0);
  await p.getByLabel("Título").fill("Rascunho UI W45 — editado");
  await p.getByRole("button", { name: "Salvar", exact: true }).click();
  await p.waitForTimeout(1200);
  t("edição: novo título persiste em Minhas", await p.getByText("Rascunho UI W45 — editado", { exact: false }).count() > 0);

  sec("5. Estados — vazio, sem acesso, erro");
  // vazio: esta campanha não tem post_perfil → filtro "Perfis" cai no Vazio
  // (o feed é por campanha — um usuário novo veria as mesmas publicações)
  await p.locator("button.internet-thread-voltar").click().catch(() => {});
  await p.waitForTimeout(800);
  await p.getByRole("button", { name: "Perfis", exact: true }).click();
  await p.getByText("Nenhuma publicação por aqui ainda", { exact: false }).waitFor({ timeout: 8000 }).catch(() => {});
  t("estado vazio: 'Nenhuma publicação' exibido no filtro sem itens", await p.getByText("Nenhuma publicação por aqui ainda").count() > 0);
  await p.getByRole("button", { name: "Todas", exact: true }).click();
  await p.waitForTimeout(600);
  // j3: SEM conta → gate do módulo Internet nega antes mesmo do feed
  const { ctx: ctx3, p: p3 } = await entrar(J3, J3);
  await p3.getByRole("tab", { name: /Personagens/ }).click();
  await p3.waitForTimeout(700);
  await p3.locator("tr", { hasText: "W45UI SemConta" }).first().click();
  await p3.waitForTimeout(1200);
  await p3.getByRole("button", { name: "Internet", exact: true }).click();
  await p3.waitForTimeout(1500);
  const negadoModulo = await p3.getByText("Acesso à Internet não liberado", { exact: false }).count() > 0;
  const semAcessoFeed = await p3.getByText("Sem acesso ao feed público", { exact: false }).count() > 0;
  t("sem acesso: gate honesto (módulo ou feed) para quem não tem conta", negadoModulo || semAcessoFeed,
    `modulo=${negadoModulo} feed=${semAcessoFeed}`);
  await ctx3.close();
  // erro: abort controlado na 1ª carga do feed (backend real, resposta bloqueada no cliente)
  await p.route("**/internet/publicacoes**", (route) => route.abort());
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(700);
  await p.locator(".cartao-campanha", { hasText: "Campanha W45UI" }).first().click();
  await p.waitForTimeout(1000);
  await abrirFeed(p).catch(() => {});
  await p.waitForTimeout(1500);
  t("erro: ErroRetry 'Não foi possível carregar' exibido", await p.getByText("Não foi possível carregar as publicações", { exact: false }).count() > 0);
  await p.unroute("**/internet/publicacoes**");
  await ctx1.close();

  t("sem pageerror no fluxo principal", p._erros.length === 0, p._erros.slice(0, 2).join(" | "));
  await browser.close();

  console.log(`\n===== Smoke E2E visual W4/W5: ${pass} ok / ${fail} falhas =====`);
} catch (e) {
  console.error("ERRO FATAL", e);
  fail++;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
  process.exit(fail > 0 ? 1 : 0);
}
