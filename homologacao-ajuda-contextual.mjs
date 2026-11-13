// Homologação funcional — ajuda contextual na criação de personagem.
// Backend ISOLADO (banco temporário via teste-base.mjs) + frontend buildado
// servido estaticamente com proxy /api. Nunca toca banco/mestre-rpg.db.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb,
  encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("homolog-ajuda");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;
const DIST = join(process.cwd(), "site", "dist");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2", ".map": "application/json" };

// ---------- API: semeia biblioteca com descrições distintas ----------
const ELEMENTOS = [
  { kind: "atributo", key: "forca", name: "Força", definition: { descricao: "DERRUBA-A — descrição exata da Força." } },
  { kind: "atributo", key: "destreza", name: "Destreza" }, // sem descrição
  { kind: "habilidade", key: "cuspe_fogo", name: "Cuspe de Fogo", definition: { descricao: "HAB-1 — lança fogo pela boca." } },
  { kind: "habilidade", key: "planar", name: "Planar" }, // sem descrição
  { kind: "habilidade", key: "bruxaria", name: "Bruxaria", definition: { descricao: "   " } }, // só espaços
  { kind: "poder", key: "telecinesia", name: "Telecinesia", definition: { descricao: "PODER-1 — move objetos à distância." } },
  { kind: "poder", key: "voo", name: "Voo" }, // sem descrição
  { kind: "defeito", key: "covardia", name: "Covardia", definition: { descricao: "DEF-1 — foge de perigo.", niveis: [{ descricao: "Nível 1 fraco", custo: -1 }, { descricao: "Nível 2", custo: -2 }] } },
  { kind: "defeito", key: "manco", name: "Manco" }, // sem descrição
  { kind: "vantagem", key: "reflexos", name: "Reflexos", definition: { descricao: "VANT-1 — reage mais rápido." } },
  { kind: "vantagem", key: "rica", name: "Ricaço" }, // sem descrição
  { kind: "profissao", key: "medico", name: "Médico", definition: { descricao: "PROF-1 — cura feridos." } },
  { kind: "profissao", key: "enfermeiro", name: "Enfermeiro", definition: { descricao: "PROF-2 — assiste o médico." } },
  { kind: "profissao", key: "pedreiro", name: "Pedreiro" }, // sem descrição
  { kind: "talento", key: "lider", name: "Liderança", definition: { descricao: "TAL-1 — comanda grupos." } },
];

const ESTRUTURA = {
  versao: 1,
  secoes: [{
    id: "s1", titulo: "Principal", ordem: 0,
    campos: [
      { id: "forca", label: "Força", tipo: "inteiro", semantico: "atributo", regra: { kind: "atributo", key: "forca" }, padrao: 1, minimo: 0, maximo: 5, obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false },
      { id: "habs", label: "Habilidades", tipo: "selecao_multipla", regraKind: "habilidade", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false },
      { id: "poderes", label: "Poderes", tipo: "selecao_multipla", regraKind: "poder", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false },
      { id: "defeitos", label: "Defeitos", tipo: "selecao_nivel", regraKind: "defeito", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false },
      { id: "vantagens", label: "Vantagens", tipo: "selecao_multipla", regraKind: "vantagem", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false },
      { id: "talentos", label: "Talentos", tipo: "selecao_multipla", regraKind: "talento", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false },
      { id: "prof", label: "Profissão", tipo: "selecao_unica", regraKind: "profissao", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", usadoEmTestes: false },
    ],
  }],
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
};

await prepararBanco(BANCO);
const portaApi = await portaLivre();
const portaUi = await portaLivre();
const BASE = `http://localhost:${portaApi}`;
const UI = `http://localhost:${portaUi}`;
let proc, srvUi, browser;
let cookieToken = "";

try {
  proc = subirServidor(portaApi, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, { jogadores: { jogador: "jogador_homolog" } });
  const cid = cenario.campId;
  const M = cenario.cookieMestre;
  cookieToken = decodeURIComponent(M.split("=")[1]);
  console.log(`backend isolado em ${BASE} — campanha ${cid}`);

  // Estrutura da ficha publicada: campos vinculados à biblioteca
  {
    const db = abrirDb(BANCO);
    const ver = db.prepare("select id from sheet_versions where template_id in (select id from sheet_templates where campaign_id=?) order by created_at desc limit 1").get(cid);
    db.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(ESTRUTURA), ver.id);
    db.close();
    t("estrutura da ficha atualizada", !!ver);
  }

  // Semeia elementos via API real
  for (const el of ELEMENTOS) {
    const r = await req(BASE, "POST", `/campaigns/${cid}/regras/elementos`, { cookie: M, body: el });
    t(`criar ${el.kind}:${el.key}`, r.status === 201, JSON.stringify(r.json).slice(0, 160));
  }

  sec("API /regras/vinculaveis — origem e associação das descrições");
  {
    const semAuth = await req(BASE, "GET", `/campaigns/${cid}/regras/vinculaveis`);
    t("401 sem autenticação", semAuth.status === 401);

    const j = await req(BASE, "GET", `/campaigns/${cid}/regras/vinculaveis`, { cookie: M });
    t("200 mestre", j.status === 200, JSON.stringify(j.json).slice(0, 200));
    const els = j.json?.elementos ?? {};
    const por = (kind, key) => els[kind]?.find((e) => e.key === key);

    // Cenário A/D: descrições exatas e corretas por elemento
    t("atributo forca descrição exata", por("atributo", "forca")?.descricao === "DERRUBA-A — descrição exata da Força.");
    t("habilidade cuspe_fogo descrição exata", por("habilidade", "cuspe_fogo")?.descricao === "HAB-1 — lança fogo pela boca.");
    t("poder telecinesia descrição exata", por("poder", "telecinesia")?.descricao === "PODER-1 — move objetos à distância.");
    t("defeito covardia descrição exata", por("defeito", "covardia")?.descricao === "DEF-1 — foge de perigo.");
    t("vantagem reflexos descrição exata", por("vantagem", "reflexos")?.descricao === "VANT-1 — reage mais rápido.");
    t("profissao medico descrição exata", por("profissao", "medico")?.descricao === "PROF-1 — cura feridos.");
    t("talento lider descrição exata", por("talento", "lider")?.descricao === "TAL-1 — comanda grupos.");
    // 3+ descrições distintas sem cruzamento
    const descs = ["forca", "cuspe_fogo", "telecinesia", "covardia", "reflexos", "medico", "lider"]
      .map((k) => por(k.includes("_") ? "habilidade" : "atributo", k)?.descricao ?? por("habilidade", k)?.descricao);
    // verificação direta de não-duplicação:
    const todos = Object.values(els).flat().map((e) => e.descricao).filter(Boolean);
    t("descrições distintas por elemento", new Set(todos.map((d) => d)).size === todos.length, JSON.stringify(todos));

    // Cenário B/C: sem descrição → undefined (frontend não renderiza ícone)
    t("atributo destreza sem descrição", por("atributo", "destreza")?.descricao === undefined);
    t("habilidade planar sem descrição", por("habilidade", "planar")?.descricao === undefined);
    t("poder voo sem descrição", por("poder", "voo")?.descricao === undefined);
    t("defeito manco sem descrição", por("defeito", "manco")?.descricao === undefined);
    t("vantagem rica sem descrição", por("vantagem", "rica")?.descricao === undefined);
    t("profissao pedreiro sem descrição", por("profissao", "pedreiro")?.descricao === undefined);
    t("whitespace preservado p/ frontend decidir", por("habilidade", "bruxaria")?.descricao === "   ");

    // Jogador também lê vinculaveis
    const J = cenario.jogadores.jogador.cookie;
    const rj = await req(BASE, "GET", `/campaigns/${cid}/regras/vinculaveis`, { cookie: J });
    t("200 jogador", rj.status === 200);
    t("jogador vê mesma descrição", rj.json?.elementos?.atributo?.find((e) => e.key === "forca")?.descricao === "DERRUBA-A — descrição exata da Força.");

    // Isolamento entre campanhas: segunda campanha não herda elementos
    const camp2 = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "Campanha Isolada" } });
    const cid2 = camp2.json?.campanha?.id;
    const v2 = await req(BASE, "GET", `/campaigns/${cid2}/regras/vinculaveis`, { cookie: M });
    const total2 = Object.values(v2.json?.elementos ?? {}).flat().length;
    t("campanha 2 isolada (0 elementos)", v2.status === 200 && total2 === 0, `total=${total2}`);
    void descs;
  }

  // ---------- UI real via Playwright ----------
  sec("UI — criação de personagem com ajuda contextual");
  // Servidor estático do build + proxy /api e /socket.io
  srvUi = createServer(async (reqq, res) => {
    const u = new URL(reqq.url, "http://x");
    if (u.pathname.startsWith("/api") || u.pathname.startsWith("/socket.io")) {
      const chunks = [];
      reqq.on("data", (d) => chunks.push(d));
      reqq.on("end", async () => {
        const body = Buffer.concat(chunks);
        try {
          const headers = { ...reqq.headers };
          delete headers["content-length"]; delete headers["host"]; delete headers["connection"];
          const r = await fetch(`${BASE}${reqq.url}`, {
            method: reqq.method, headers, body: ["GET", "HEAD"].includes(reqq.method) ? undefined : body,
          });
          const hb = {};
          r.headers.forEach((v, k) => { if (!["content-length", "transfer-encoding", "connection"].includes(k)) hb[k] = v; });
          res.writeHead(r.status, hb);
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) { res.writeHead(502); res.end(String(e)); }
      });
      return;
    }
    let p = join(DIST, decodeURIComponent(u.pathname));
    if (u.pathname === "/") p = join(DIST, "index.html");
    try {
      const data = await readFile(p);
      res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
      res.end(data);
    } catch {
      try { const data = await readFile(join(DIST, "index.html")); res.writeHead(200, { "content-type": "text/html" }); res.end(data); }
      catch { res.writeHead(404); res.end("nf"); }
    }
  });
  await new Promise((r) => srvUi.listen(portaUi, "127.0.0.1", r));

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieToken, url: UI }]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

  await page.goto(UI, { waitUntil: "networkidle" });
  // Campanhas → campanha → Personagens → Novo personagem
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.locator(".cartao-campanha", { hasText: "Campanha Teste" }).click();
  await page.getByRole("button", { name: "Personagens" }).click();
  await page.getByRole("button", { name: "Novo personagem" }).click();
  await page.locator("input").first().fill("Herói Homolog");
  await page.locator("select").first().selectOption({ index: 1 });
  await page.getByRole("button", { name: "Criar e preencher" }).click();
  await page.getByRole("button", { name: "Editar ficha" }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Editar ficha" }).click();
  await page.waitForTimeout(500);

  const botao = (rotulo) => page.locator(`button[aria-label="${rotulo}"]`);
  const popover = page.locator(".ajuda-popover");

  // Cenário A: ícones presentes para elementos com descrição
  await t && t; // noop
  {
    const checks = [
      ["Ver descrição de Força", true, "atributo com regra.key"],
      ["Ver descrição de Cuspe de Fogo", true, "habilidade com descrição"],
      ["Ver descrição de Telecinesia", true, "poder com descrição"],
      ["Ver descrição de Covardia", true, "defeito com descrição"],
      ["Ver descrição de Reflexos", true, "vantagem com descrição"],
      ["Ver descrição de Liderança", true, "talento com descrição"],
    ];
    for (const [rot, esperado] of checks) {
      t(`ícone "${rot}"`, (await botao(rot).count()) === (esperado ? 1 : 0));
    }
    // Cenário B/C: sem descrição / whitespace → sem ícone
    const ausentes = [
      "Ver descrição de Destreza", "Ver descrição de Planar", "Ver descrição de Bruxaria",
      "Ver descrição de Voo", "Ver descrição de Manco", "Ver descrição de Ricaço",
    ];
    // Destreza não é campo da ficha — só itens das listas contam.
    // Verifica contagem de botões por seção: Habilidades deve ter exatamente 1 (só Cuspe de Fogo).
    const secaoHab = page.locator("#ficha-campo-habs");
    t("habilidades: 1 ícone (sem descrição/whitespace não renderizam)", await secaoHab.locator(".ajuda-botao").count() === 1);
    t("poderes: 1 ícone", await page.locator("#ficha-campo-poderes .ajuda-botao").count() === 1);
    t("defeitos: 1 ícone", await page.locator("#ficha-campo-defeitos .ajuda-botao").count() === 1);
    t("vantagens: 1 ícone", await page.locator("#ficha-campo-vantagens .ajuda-botao").count() === 1);
    t("talentos: 1 ícone", await page.locator("#ficha-campo-talentos .ajuda-botao").count() === 1);
    for (const rot of ausentes.slice(2)) {
      t(`sem ícone p/ "${rot}"`, (await botao(rot).count()) === 0);
    }
  }

  // Popover: abre, texto exato, ESC, clique fora, dois em sequência, checkbox não alterna
  {
    await botao("Ver descrição de Cuspe de Fogo").click();
    await popover.waitFor({ timeout: 3000 });
    const txt = await popover.locator(".ajuda-conteudo").innerText();
    t("popover exibe descrição exata", txt.trim() === "HAB-1 — lança fogo pela boca.", txt);
    t("aria-expanded=true", await botao("Ver descrição de Cuspe de Fogo").getAttribute("aria-expanded") === "true");

    // ESC fecha
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    t("ESC fecha popover", (await popover.count()) === 0);

    // Reabre e fecha clicando fora
    await botao("Ver descrição de Cuspe de Fogo").click();
    await popover.waitFor();
    await page.locator("h3", { hasText: "Ficha" }).click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(200);
    t("clique fora fecha popover", (await popover.count()) === 0);

    // Dois em sequência: só um aberto por vez
    await botao("Ver descrição de Telecinesia").click();
    await popover.waitFor();
    await botao("Ver descrição de Reflexos").click();
    await page.waitForTimeout(300);
    t("segundo clique fecha o primeiro (só 1 popover)", await popover.count() === 1);
    const txt2 = await popover.locator(".ajuda-conteudo").innerText();
    t("popover mostra descrição do SEGUNDO elemento", txt2.trim() === "VANT-1 — reage mais rápido.", txt2);

    // Clique no ? dentro de label de checkbox NÃO marca a opção
    const habCheck = page.locator("#ficha-campo-habs label.checkbox-inline", { hasText: "Planar" }).locator("input[type=checkbox]");
    const botaoPlanar = page.locator("#ficha-campo-habs label.checkbox-inline", { hasText: "Planar" });
    t("Planar não tem ícone próprio (sem descrição)", await botaoPlanar.locator(".ajuda-botao").count() === 0);
    // Usa Covardia (selecao_nivel não é checkbox) → testar em vantagens: Ricaço sem desc; usar campo habs com Cuspe de Fogo
    const habCuspe = page.locator("#ficha-campo-habs label.checkbox-inline", { hasText: "Cuspe de Fogo" });
    const chk = habCuspe.locator("input[type=checkbox]");
    const antes = await chk.isChecked();
    await habCuspe.locator(".ajuda-botao").click();
    await page.waitForTimeout(200);
    t("clique no ? não alterna checkbox", (await chk.isChecked()) === antes, `antes=${antes} depois=${await chk.isChecked()}`);
    t("popover abriu a partir do label", await popover.count() === 1);

    // Seleção continua funcionando: marcar habilidade
    await page.keyboard.press("Escape");
    await habCuspe.locator("input[type=checkbox]").check();
    t("checkbox marca normalmente", await chk.isChecked());

    // Teclado: foco + Enter abre
    const btnTeclado = botao("Ver descrição de Liderança");
    await btnTeclado.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    t("Enter no botão focado abre popover", await popover.count() === 1);
    const txt3 = await popover.locator(".ajuda-conteudo").innerText();
    t("popover teclado: descrição do talento", txt3.trim() === "TAL-1 — comanda grupos.", txt3);
    await page.keyboard.press("Escape");

    // selecao_unica (SeletorUnico): cada opção tem seu próprio ? na lista
    const gatilhoProf = page.locator("#ficha-campo-prof .seletor-unico-gatilho");
    t("seletor único renderizado (sem <select> nativo)", await page.locator("#ficha-campo-prof select").count() === 0);
    t("fechado: opções não estão no DOM", await page.locator("#ficha-campo-prof [role='option']").count() === 0);
    await gatilhoProf.click();
    await page.locator("#ficha-campo-prof [role='listbox']").waitFor();
    const listaProf = page.locator("#ficha-campo-prof .seletor-unico-lista");
    t("listbox abre com todas as opções", await listaProf.locator("[role='option']").count() === 4, // — + 3 profissões
      String(await listaProf.locator("[role='option']").count()));
    t("Médico tem ?", await listaProf.locator(".seletor-unico-opcao", { hasText: "Médico" }).locator(".ajuda-botao").count() === 1);
    t("Enfermeiro tem ?", await listaProf.locator(".seletor-unico-opcao", { hasText: "Enfermeiro" }).locator(".ajuda-botao").count() === 1);
    t("Pedreiro sem ?", await listaProf.locator(".seletor-unico-opcao", { hasText: "Pedreiro" }).locator(".ajuda-botao").count() === 0);
    t("opção vazia '—' sem ?", await listaProf.locator(".seletor-unico-opcao", { hasText: "—" }).locator(".ajuda-botao").count() === 0);

    // Consultar descrição de opção NÃO selecionada
    await listaProf.locator(".seletor-unico-opcao", { hasText: "Médico" }).locator(".ajuda-botao").click();
    await popover.waitFor();
    const txt4 = await popover.locator(".ajuda-conteudo").innerText();
    t("selecao_unica: descrição exata sem selecionar", txt4.trim() === "PROF-1 — cura feridos.", txt4);
    t("consultar não alterou seleção (gatilho continua '—')",
      (await gatilhoProf.locator(".seletor-unico-valor").innerText()).trim() === "—");
    // Fecha a ajuda e a lista continua aberta
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    t("ESC fecha ajuda; lista permanece aberta", await popover.count() === 0 && await page.locator("#ficha-campo-prof [role='listbox']").count() === 1);

    // Segunda descrição, outra opção
    await listaProf.locator(".seletor-unico-opcao", { hasText: "Enfermeiro" }).locator(".ajuda-botao").click();
    await popover.waitFor();
    const txt4b = await popover.locator(".ajuda-conteudo").innerText();
    t("selecao_unica: 2ª descrição correta", txt4b.trim() === "PROF-2 — assiste o médico.", txt4b);
    await page.keyboard.press("Escape");

    // Seleciona normalmente depois de consultar
    await listaProf.locator(".seletor-unico-opcao", { hasText: "Médico" }).locator("[role='option']").click();
    await page.waitForTimeout(200);
    t("seleção funciona após consultas", (await gatilhoProf.locator(".seletor-unico-valor").innerText()).trim() === "Médico");
    t("lista fecha após selecionar", await page.locator("#ficha-campo-prof [role='listbox']").count() === 0);

    // Teclado: abre com Enter, navega com setas, seleciona com Enter
    await gatilhoProf.focus();
    await page.keyboard.press("Enter");
    await page.locator("#ficha-campo-prof [role='listbox']").waitFor();
    // Ordem alfabética da biblioteca: —, Enfermeiro, Médico, Pedreiro.
    // Foco inicial cai na selecionada (Médico); ArrowUp → Enfermeiro.
    await page.locator("#ficha-campo-prof [role='listbox']").waitFor();
    t("teclado: foco inicial na selecionada", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Médico"));
    await page.keyboard.press("ArrowUp");
    t("teclado: ArrowUp move foco", await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Enfermeiro"));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    t("teclado: Enter seleciona", (await gatilhoProf.locator(".seletor-unico-valor").innerText()).trim() === "Enfermeiro");
    // Escape fecha o seletor e devolve foco ao gatilho
    await gatilhoProf.click();
    await page.locator("#ficha-campo-prof [role='listbox']").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    t("Escape fecha seletor", await page.locator("#ficha-campo-prof [role='listbox']").count() === 0);
    t("Escape devolve foco ao gatilho", await page.evaluate(() => document.activeElement?.classList?.contains("seletor-unico-gatilho") ?? false));
    // volta a Médico para a regressão de salvamento
    await gatilhoProf.click();
    await page.locator("#ficha-campo-prof .seletor-unico-opcao", { hasText: "Médico" }).locator("[role='option']").click();

    // Atributo (bolinhas): ícone no label do campo
    t("atributo Força: ícone presente", await botao("Ver descrição de Força").count() === 1);
    await botao("Ver descrição de Força").click();
    await popover.waitFor();
    const txt5 = await popover.locator(".ajuda-conteudo").innerText();
    t("atributo: descrição exata", txt5.trim() === "DERRUBA-A — descrição exata da Força.", txt5);
    await page.keyboard.press("Escape");

    // Defeito selecao_nivel: descrição do ELEMENTO (não do nível)
    t("defeito Covardia: ícone presente", await botao("Ver descrição de Covardia").count() === 1);
    await botao("Ver descrição de Covardia").click();
    await popover.waitFor();
    const txt6 = await popover.locator(".ajuda-conteudo").innerText();
    t("defeito: descrição do elemento (não nível)", txt6.trim() === "DEF-1 — foge de perigo.", txt6);
    await page.keyboard.press("Escape");
  }

  // Regressão: salvar e recarregar
  sec("Regressão — salvar e reabrir");
  {
    // Marca uma vantagem também
    const chkReflexos = page.locator("#ficha-campo-vantagens label.checkbox-inline", { hasText: "Reflexos" }).locator("input[type=checkbox]");
    await chkReflexos.check();
    // Sobe nível de defeito (SeletorNivel) — clica no botão de nível 1 se existir
    await page.getByRole("button", { name: "Salvar" }).click();
    await page.waitForTimeout(1200);
    // Verifica via API que dados persistiram
    const chars = await req(BASE, "GET", `/campaigns/${cid}/characters`, { cookie: M });
    const heroi = (chars.json?.personagens ?? []).find((p) => p.name === "Herói Homolog");
    t("personagem salvo", !!heroi, JSON.stringify(chars.json).slice(0, 200));
    const det = await req(BASE, "GET", `/characters/${heroi.id}`, { cookie: M });
    const campos = det.json?.ficha?.campos ?? {};
    t("habilidade persistida", (campos.habs ?? []).includes("cuspe_fogo"), JSON.stringify(campos.habs));
    t("vantagem persistida", (campos.vantagens ?? []).includes("reflexos"), JSON.stringify(campos.vantagens));
    t("profissão persistida", campos.prof === "medico", String(campos.prof));

    // Reabre a ficha (modo leitura) — seleções aparecem
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Teste" }).click();
    await page.getByRole("button", { name: "Personagens" }).click();
    await page.getByText("Herói Homolog").click();
    await page.waitForTimeout(800);
    const corpo = await page.locator("body").innerText();
    t("ficha reaberta mostra seleção", corpo.includes("Cuspe de Fogo") && corpo.includes("Reflexos"));
    // Modo leitura: campos seleção não renderizam ícones de edição (somente leitura) — sem erro
    t("modo leitura sem botões de ajuda de edição", await page.locator("#ficha-campo-habs .ajuda-botao").count() === 0);
  }

  // Responsividade — matriz de viewports (celular, tablet, desktop)
  sec("UI — responsividade por viewport");
  const VIEWPORTS = [
    ["celular 375x812", 375, 812],
    ["celular grande 430x932", 430, 932],
    ["tablet compacto 768x1024", 768, 1024],
    ["tablet intermediário 820x1180", 820, 1180],
    ["tablet grande 1024x1366", 1024, 1366],
    ["desktop 1440x900", 1440, 900],
  ];
  for (const [nomeVp, w, h] of VIEWPORTS) {
    const ctxV = await browser.newContext({ viewport: { width: w, height: h } });
    await ctxV.addCookies([{ name: "mestre_rpg_session", value: cookieToken, url: UI }]);
    const pv = await ctxV.newPage();
    await pv.goto(UI, { waitUntil: "networkidle" });
    await pv.getByRole("button", { name: "Campanhas" }).click();
    await pv.locator(".cartao-campanha", { hasText: "Campanha Teste" }).click();
    await pv.getByRole("button", { name: "Personagens" }).click();
    await pv.getByText("Herói Homolog").click();
    await pv.getByRole("button", { name: "Editar ficha" }).click();
    await pv.waitForTimeout(400);

    const dentroVp = async (locator) => {
      const box = await locator.boundingBox();
      return !!box && box.x >= -1 && box.y >= -1 && box.x + box.width <= w + 1 && box.y + box.height <= h + 1;
    };

    // 1) Popover de ajuda comum dentro da viewport
    const bAjuda = pv.locator("#ficha-campo-habs button[aria-label='Ver descrição de Cuspe de Fogo']");
    await bAjuda.click();
    await pv.locator(".ajuda-popover").waitFor();
    t(`${nomeVp}: popover dentro da viewport`, await dentroVp(pv.locator(".ajuda-popover")));
    const mm = await pv.locator(".ajuda-popover .ajuda-conteudo").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    t(`${nomeVp}: texto sem overflow`, mm.sw <= mm.cw + 2, JSON.stringify(mm));
    await pv.keyboard.press("Escape");

    // 2) Seletor único abre e lista cabe na viewport
    const gatilho = pv.locator("#ficha-campo-prof .seletor-unico-gatilho");
    await gatilho.click();
    await pv.locator("#ficha-campo-prof [role='listbox']").waitFor();
    const listaBox = await pv.locator("#ficha-campo-prof .seletor-unico-lista").boundingBox();
    t(`${nomeVp}: lista do seletor dentro da viewport`, !!listaBox && listaBox.x >= -1 && listaBox.x + listaBox.width <= w + 1 && listaBox.y >= -1 && listaBox.y + listaBox.height <= h + 1,
      JSON.stringify({ listaBox, w, h }));

    // 3) Ajuda DENTRO da lista rolável: popover não é cortado (position fixed)
    await pv.locator("#ficha-campo-prof .seletor-unico-opcao", { hasText: "Médico" }).locator(".ajuda-botao").click();
    await pv.locator(".ajuda-popover").waitFor();
    t(`${nomeVp}: popover dentro do seletor visível e na viewport`, await dentroVp(pv.locator(".ajuda-popover")));
    t(`${nomeVp}: lista continua aberta após ajuda`, await pv.locator("#ficha-campo-prof [role='listbox']").count() === 1);
    // Selecionar depois de consultar funciona neste viewport também
    await pv.keyboard.press("Escape");
    await pv.locator("#ficha-campo-prof .seletor-unico-opcao", { hasText: "Enfermeiro" }).locator("[role='option']").click();
    t(`${nomeVp}: seleção funciona`, (await gatilho.locator(".seletor-unico-valor").innerText()).trim() === "Enfermeiro");
    // volta para Médico (estado consistente p/ próximas iterações não importa — cada ctx é novo)

    // 4) Sem overflow horizontal da página
    const overflowX = await pv.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t(`${nomeVp}: sem overflow horizontal`, overflowX <= 1, `overflow=${overflowX}px`);
    await ctxV.close();
  }

  await ctx.close();
} catch (e) {
  fail++;
  console.error("ERRO FATAL:", e);
} finally {
  try { await browser?.close(); } catch { }
  try { srvUi?.close(); } catch { }
  try { await encerrarServidor(proc); } catch { }
  console.log(`\n==== RESULTADO: ${pass} ok, ${fail} falhas ====`);
  limparDir(DIR);
}
process.exit(fail ? 1 : 0);
