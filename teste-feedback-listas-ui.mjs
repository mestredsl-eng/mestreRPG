#!/usr/bin/env node
// Teste E2E de feedback de carregamento/erro (Issue #239 / #132).
// Cobre: EstadoCarregando (role=status, texto visível, indicador discreto),
// EstadoErro (role=alert, mensagem segura, sem stack/detalhes internos),
// retry manual que reexecuta a carga existente (1 clique = 1 nova request),
// convites sem flash de estado vazio, reduced-motion e mobile 390px.
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir, comDb,
} from "./teste-base.mjs";

const DIR = dirTeste("feedback-listas");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

async function abrirAba(page, nome) {
  await page.locator(".abas button", { hasText: nome }).first().click();
  await page.waitForTimeout(400);
}
async function abrirCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).first().click();
  await page.locator(".cartao-campanha", { hasText: "Campanha Teste" }).first().click();
  await page.locator(".abas").waitFor({ timeout: 15000 });
}

try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Teste" });
  const urlChars = `**/api/campaigns/${c.campId}/characters*`;
  const urlConvites = `**/api/campaigns/${c.campId}/invitations*`;

  const browser = await chromium.launch();
  const ctxM = await browser.newContext();
  await ctxM.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
  const pm = await ctxM.newPage();

  // ---------- 1) Loading: role=status, texto visível, spinner aria-hidden ----------
  let liberarChars;
  const charsPendente = new Promise((res) => { liberarChars = res; });
  let charsAtrasadas = 0;
  await pm.route(urlChars, async (route) => {
    charsAtrasadas++;
    await charsPendente;
    await route.continue();
  });
  await pm.goto(BASE, { waitUntil: "domcontentloaded" });
  await abrirCampanha(pm);
  await abrirAba(pm, "Personagens");
  await pm.waitForSelector(".estado-feedback-carregando", { timeout: 8000 });
  const st = pm.locator(".estado-feedback-carregando");
  const live = st.locator(".estado-feedback-texto");
  ok("loading. role=status presente no nó de texto", (await live.getAttribute("role")) === "status");
  // Live region estável (P3 #238): o nó role=status monta vazio e é
  // preenchido no MESMO nó — leitores de tela anunciam a atualização.
  // Guarde a referência real antes do efeito preencher o texto. A espera
  // precisa acontecer NESTE ElementHandle; consultar o locator novamente
  // poderia resolver um nó substituto e tornar o teste tautológico.
  const noStatus = await live.elementHandle();
  const textoAtualizouNoOriginal = await pm.waitForFunction(
    (el) => !!el && el.isConnected && (el.textContent ?? "").includes("Carregando"),
    noStatus,
    { timeout: 8000 },
  ).then(() => true).catch(() => false);
  ok("loading. texto sempre visível", (await live.innerText()).includes("Carregando"));
  const estadoNoOriginal = noStatus
    ? await noStatus.evaluate((el) => ({
        conectado: el.isConnected,
        mesmoNo: el === document.querySelector(".estado-feedback-carregando .estado-feedback-texto[role='status']"),
        texto: el.textContent ?? "",
      }))
    : { conectado: false, mesmoNo: false, texto: "" };
  ok(
    "live region. a referência original permanece conectada e recebe a mensagem",
    textoAtualizouNoOriginal && estadoNoOriginal.conectado && estadoNoOriginal.mesmoNo &&
      estadoNoOriginal.texto.includes("Carregando"),
    JSON.stringify({ textoAtualizouNoOriginal, ...estadoNoOriginal }),
  );
  ok("loading. indicador visual discreto presente", (await st.locator(".estado-feedback-icone").count()) === 1);
  // ---- asserts de CSS da folha dedicada estado-feedback.css ----
  const css = await st.evaluate((el) => {
    const s = getComputedStyle(el);
    const icone = getComputedStyle(el.querySelector(".estado-feedback-icone"));
    return {
      display: s.display, dir: s.flexDirection, anim: icone.animationName,
      raio: icone.borderRadius, rolagem: el.scrollWidth <= el.clientWidth + 1,
    };
  });
  ok("css. folha dedicada: container flex-column centralizado", css.display === "flex" && css.dir === "column", JSON.stringify(css));
  ok("css. spinner com animação própria e borda circular", css.anim === "estado-feedback-girar" && css.raio === "50%", `anim=${css.anim} raio=${css.raio}`);
  liberarChars();
  await pm.waitForSelector(".estado-feedback-carregando", { state: "detached", timeout: 8000 }).catch(() => {});
  await pm.unroute(urlChars);
  await pm.waitForTimeout(300);
  ok("loading. some após carga", (await pm.locator(".estado-feedback-carregando").count()) === 0);
  const nCharsApos = charsAtrasadas;

  // ---------- 2) Erro: role=alert, mensagem segura, retry dispara nova carga ----------
  let falharChars = true;
  let reqsChars = 0;
  await pm.route(urlChars, async (route) => {
    reqsChars++;
    if (falharChars) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ erro: "falha interna simulada" }) });
    } else {
      await route.continue();
    }
  });
  // força recarga: troca aba Personagens→Mesa→Personagens via socket-free path: reload da página
  await pm.reload({ waitUntil: "domcontentloaded" });
  await abrirCampanha(pm);
  await abrirAba(pm, "Personagens");
  await pm.waitForSelector(".estado-feedback-erro", { timeout: 8000 });
  const er = pm.locator(".estado-feedback-erro");
  ok("erro. role=alert presente", (await er.getAttribute("role")) === "alert");
  const txtErro = await er.locator(".estado-feedback-texto").innerText();
  ok("erro. mensagem útil e segura (sem stack/token)", txtErro.length > 3 && !/stack|at \w+ \(|token|sqlite|SELECT/i.test(txtErro), `"${txtErro.trim()}"`);
  ok("erro. botão Tentar novamente visível", (await er.getByRole("button", { name: "Tentar novamente" }).count()) === 1);
  const corErro = await er.locator(".estado-feedback-texto").evaluate((el) => getComputedStyle(el).color);
  ok("css. texto de erro usa tom de erro do tema (#f87171)", corErro === "rgb(248, 113, 113)", corErro);
  const focoRetry = await er.getByRole("button", { name: "Tentar novamente" }).evaluate((el) => {
    el.focus();
    const s = getComputedStyle(el);
    return { tag: el.tagName, outline: s.outlineStyle, tab: el.tabIndex };
  });
  ok("css. retry focável por teclado", focoRetry.tag === "BUTTON" && focoRetry.tab === 0, JSON.stringify(focoRetry));
  falharChars = false;
  const reqsAntesRetry = reqsChars;
  await er.getByRole("button", { name: "Tentar novamente" }).click();
  await pm.waitForTimeout(1200);
  ok("retry. 1 clique = 1 nova request de carga", reqsChars === reqsAntesRetry + 1, `reqs ${reqsAntesRetry}→${reqsChars}`);
  ok("retry. erro some e lista carrega", (await pm.locator(".estado-feedback-erro").count()) === 0);
  await pm.unroute(urlChars);
  ok("sanidade. personagens listou após retry", nCharsApos >= 1);

  // ---------- 3) Convites: gate de loading (sem flash de vazio) ----------
  await abrirAba(pm, "Convites");
  let liberarConv;
  const convPendente = new Promise((res) => { liberarConv = res; });
  await pm.route(urlConvites, async (route) => { await convPendente; await route.continue(); });
  // remount da aba convites via troca de aba força novo GET? carregar só roda 1x; recarregamos página
  await pm.reload({ waitUntil: "domcontentloaded" });
  await abrirCampanha(pm);
  await abrirAba(pm, "Convites");
  await pm.waitForSelector(".estado-feedback-carregando", { timeout: 8000 });
  const temVazioAntes = await pm.locator(".estado-vazio:has-text('Nenhum convite')").count();
  ok("convites. estado vazio NÃO pisca durante carga", temVazioAntes === 0);
  liberarConv();
  await pm.waitForSelector(".estado-feedback-carregando", { state: "detached", timeout: 8000 }).catch(() => {});
  await pm.unroute(urlConvites);
  await pm.waitForTimeout(300);
  ok("convites. vazio real aparece após carga", (await pm.locator(".estado-vazio:has-text('Nenhum convite')").count()) === 1);
  ok("convites. formulário Gerar convite preservado", (await pm.locator('button[type="submit"]', { hasText: "Gerar convite" }).count()) === 1);

  // ---------- 3b) Campanha: PATCH rejeitado preserva rascunho; retry reenvia a mutação ----------
  await abrirAba(pm, "Informações");
  let falharPatchCamp = true;
  let patchesCamp = 0;
  let getsCamp = 0;
  await pm.route(`**/api/campaigns/${c.campId}`, async (route) => {
    const metodo = route.request().method();
    if (metodo === "GET") { getsCamp++; return route.continue(); }
    if (metodo !== "PATCH") return route.continue();
    patchesCamp++;
    if (falharPatchCamp) {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ erro: "falha simulada" }) });
    }
    return route.continue();
  });
  await pm.getByRole("button", { name: "Editar campanha" }).click();
  const nomeInput = pm.locator("form.formulario label", { hasText: "Nome" }).locator("input");
  const descInput = pm.locator("form.formulario label", { hasText: "Descrição" }).locator("textarea");
  await nomeInput.fill("Rascunho Secreto 123");
  await descInput.fill("Descrição rascunho que não pode sumir");
  await pm.getByRole("button", { name: "Salvar", exact: true }).click();
  await pm.waitForSelector(".estado-feedback-erro", { timeout: 8000 });
  ok("campanha. erro de ação visível (role=alert)", (await pm.locator(".estado-feedback-erro").first().getAttribute("role")) === "alert");
  ok("campanha. rascunho preservado após PATCH rejeitado",
    (await nomeInput.inputValue()) === "Rascunho Secreto 123" && (await descInput.inputValue()).includes("não pode sumir"),
    `nome="${await nomeInput.inputValue()}"`);
  // F25B-5/6 — GET disparado por evento de socket DURANTE a edição não
  // pode sobrescrever o rascunho: carregar() sincroniza o form só fora
  // de edição. PATCH idempotente no servidor emite campanha:atualizada
  // → aoMudar → carregar() → GET /campaigns/:id.
  const getsAntesSocket = getsCamp;
  await req(BASE, "PATCH", `/campaigns/${c.campId}`, { cookie: c.cookieMestre, body: { name: "Campanha Teste" } });
  for (let i = 0; i < 50 && getsCamp === getsAntesSocket; i++) await pm.waitForTimeout(100);
  ok("campanha. GET por socket durante edição ocorreu", getsCamp > getsAntesSocket, `gets ${getsAntesSocket}→${getsCamp}`);
  ok("campanha. rascunho preservado após GET de sincronização",
    (await nomeInput.inputValue()) === "Rascunho Secreto 123" && (await descInput.inputValue()).includes("não pode sumir"),
    `nome="${await nomeInput.inputValue()}" desc="${await descInput.inputValue()}"`);
  falharPatchCamp = false;
  const patchesAntesRetry = patchesCamp;
  await pm.locator(".estado-feedback-erro").first().getByRole("button", { name: "Tentar novamente" }).click();
  await pm.waitForTimeout(1500);
  ok("campanha. retry reenvia PATCH da mutação (não GET de carga)", patchesCamp === patchesAntesRetry + 1, `patches ${patchesAntesRetry}→${patchesCamp}`);
  ok("campanha. edição salva e volta ao modo leitura", (await pm.getByRole("button", { name: "Editar campanha" }).count()) === 1);
  // restaura o nome original — seções seguintes localizam "Campanha Teste"
  await req(BASE, "PATCH", `/campaigns/${c.campId}`, { cookie: c.cookieMestre, body: { name: "Campanha Teste" } });
  await pm.unroute(`**/api/campaigns/${c.campId}`);

  // ---------- 3c) F30: POST convite ambíguo — commit real + resposta perdida ----------
  await abrirAba(pm, "Convites");
  const contarConvites = () => comDb(BANCO, (db) =>
    db.prepare("select count(*) n from invitations where campaign_id=?").get(c.campId).n);
  const convAntes = contarConvites();
  let postsConvite = 0;
  let anunciarCommit;
  const commitConcluido = new Promise((resolve) => { anunciarCommit = resolve; });
  let liberarResposta;
  const aguardarResposta = new Promise((resolve) => { liberarResposta = resolve; });
  const urlConvPost = "**/api/campaigns/" + c.campId + "/invitations";
  const chavePendente = "mestre-rpg:convite-indefinido:" + c.campId;

  // Valores não-default: provar que rascunho persiste após resposta perdida,
  // reload e reentrada na tela.
  await pm.getByLabel("Papel do convite").selectOption("espectador");
  const maxUsesInput = pm.locator("label", { hasText: "Máx. de usos" }).locator("input");
  const expiraInput = pm.locator("label", { hasText: "Expira em (horas)" }).locator("input");
  await maxUsesInput.fill("3");
  await expiraInput.fill("48");
  await pm.getByRole("checkbox", { name: "Exigir aprovação do mestre" }).check();

  await pm.route(urlConvPost, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    postsConvite++;
    const resposta = await route.fetch(); // commit real no servidor
    anunciarCommit(resposta.status());
    await aguardarResposta;                // mantém o cliente sem resposta
    try { await route.abort(); } catch { /* página pode já ter sido recarregada */ }
  });

  await pm.getByRole("button", { name: "Gerar convite" }).click();
  const statusCommit = await commitConcluido;
  const marcadorAntesDaResposta = await pm.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    if (!raw) return false;
    const pend = JSON.parse(raw);
    return Array.isArray(pend.idsAntes) && pend.form?.maxUses === "3" &&
      pend.form?.expiresInHours === "48" && pend.form?.role === "espectador";
  }, chavePendente);
  ok("convite. bloqueio persistido ANTES de receber resposta do POST",
    statusCommit === 201 && marcadorAntesDaResposta, "HTTP real=" + statusCommit);
  liberarResposta();

  await pm.waitForSelector(".estado-feedback-erro", { timeout: 8000 });
  ok("convite. ambíguo: aviso fail-closed visível", (await pm.locator(".estado-feedback-erro").count()) >= 1);
  ok("convite. submit desabilitado enquanto indeterminado",
    await pm.getByRole("button", { name: "Gerar convite" }).isDisabled());
  ok("convite. ambíguo não oferece reenvio do POST",
    (await pm.locator(".estado-feedback-erro").getByRole("button", { name: "Tentar novamente" }).count()) === 0);
  ok("convite. rascunho permanece após perda de resposta",
    await pm.getByLabel("Papel do convite").inputValue() === "espectador" &&
      await maxUsesInput.inputValue() === "3" && await expiraInput.inputValue() === "48" &&
      await pm.getByRole("checkbox", { name: "Exigir aprovação do mestre" }).isChecked());
  await pm.waitForTimeout(400);
  const convDepois = contarConvites();
  ok("convite. exatamente 1 linha commitada no SQLite", convDepois === convAntes + 1, convAntes + "→" + convDepois);
  ok("convite. nenhum segundo POST na recuperação", postsConvite === 1, "posts=" + postsConvite);

  // reload + reentrada: o marcador e o formulário são restaurados antes
  // de liberar o submit; o GET da lista não pode emitir novo POST.
  await pm.reload({ waitUntil: "domcontentloaded" });
  await abrirCampanha(pm);
  await abrirAba(pm, "Convites");
  ok("convite. bloqueio sobrevive a reload", await pm.getByRole("button", { name: "Gerar convite" }).isDisabled());
  ok("convite. rascunho sobrevive a reload",
    await pm.getByLabel("Papel do convite").inputValue() === "espectador" &&
      await pm.locator("label", { hasText: "Máx. de usos" }).locator("input").inputValue() === "3" &&
      await pm.locator("label", { hasText: "Expira em (horas)" }).locator("input").inputValue() === "48");
  ok("convite. reload não gerou POST extra", postsConvite === 1, "posts=" + postsConvite);

  // Uma leitura momentaneamente vazia NÃO pode liberar o bloqueio:
  // o POST pode ainda concluir depois do GET. Simula resposta vazia da
  // primeira consulta autoritativa; a recarga seguinte já vê o commit.
  let esconderConviteUmaVez = true;
  await pm.route(urlConvites, async (route) => {
    if (route.request().method() === "GET" && esconderConviteUmaVez) {
      esconderConviteUmaVez = false;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ convites: [] }) });
    } else {
      await route.continue();
    }
  });
  await pm.getByRole("button", { name: "Verificar convites" }).click();
  await pm.waitForTimeout(800);
  ok("convite. lista vazia em primeira reconciliação NÃO libera submit",
    await pm.getByRole("button", { name: "Gerar convite" }).isDisabled());
  ok("convite. pendência persiste após snapshot vazio",
    await pm.evaluate((key) => !!sessionStorage.getItem(key), chavePendente));
  ok("convite. mensagem não presume que POST não comitou",
    /não prova|bloqueio continua/i.test(await pm.locator(".estado-feedback-erro").filter({
      hasText: /não prova|bloqueio continua/i,
    }).innerText()));
  ok("convite. snapshot vazio não gerou POST", postsConvite === 1, "posts=" + postsConvite);
  await pm.unroute(urlConvites);

  // A consulta seguinte encontra o convite ativo órfão: continua bloqueado
  // até o mestre revogá-lo, pois o código secreto one-time foi perdido.
  await pm.getByRole("button", { name: "Verificar convites" }).click();
  await pm.waitForTimeout(800);
  ok("convite. commit detectado mantém submit bloqueado até revogação",
    await pm.getByRole("button", { name: "Gerar convite" }).isDisabled());
  ok("convite. instrução orienta revogar o código órfão",
    /Revogue todos|Revogue-o/i.test(await pm.locator(".estado-feedback-erro").filter({
      hasText: /Revogue todos|Revogue-o/i,
    }).innerText()));
  ok("convite. reconciliação não gerou POST", postsConvite === 1, "posts=" + postsConvite);

  const linhaOrfa = pm.locator(".tabela tbody tr").first();
  await linhaOrfa.getByRole("button", { name: "Revogar" }).click();
  await pm.waitForFunction(() => {
    const row = document.querySelector(".tabela tbody tr");
    return !!row && /revogado/i.test(row.textContent || "");
  }, null, { timeout: 8000 });

  // Segunda reconciliação confirma que todos os convites novos estão
  // inativos/revogados e só então libera nova criação.
  await pm.getByRole("button", { name: "Verificar convites" }).click();
  await pm.waitForTimeout(800);
  ok("convite. bloqueio só libera após detectar revogação",
    !(await pm.getByRole("button", { name: "Gerar convite" }).isDisabled()));
  ok("convite. verificação pós-revogação não gerou POST", postsConvite === 1, "posts=" + postsConvite);

  // erro definitivo 4xx → retry da mutação é seguro; rascunho preservado
  await pm.route(urlConvPost, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    postsConvite++;
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ erro: "papel inválido" }) });
  });
  await maxUsesInput.fill("4");
  await pm.getByRole("button", { name: "Gerar convite" }).click();
  await pm.waitForTimeout(800);
  ok("convite. 4xx definitivo oferece retry da mutação",
    (await pm.locator(".estado-feedback-erro").getByRole("button", { name: "Tentar novamente" }).count()) >= 1);
  ok("convite. rascunho preservado após 4xx", (await maxUsesInput.inputValue()) === "4");
  await pm.unroute(urlConvPost);
  // retry real agora passa (201) — limpa o erro de ação para não
  // vazar um segundo .estado-feedback-texto nas seções seguintes
  await pm.locator(".estado-feedback-erro").getByRole("button", { name: "Tentar novamente" }).click();
  await pm.waitForTimeout(1200);

  // ---------- 4) Reduced motion: texto permanece, animação desligada ----------
  await pm.emulateMedia({ reducedMotion: "reduce" });
  // força loading de novo em Arquivos
  await abrirAba(pm, "Arquivos");
  let liberarArq;
  const arqPendente = new Promise((res) => { liberarArq = res; });
  await pm.route(`**/api/campaigns/${c.campId}/arquivos*`, async (route) => {
    await arqPendente;
    try { await route.continue(); } catch { /* rota já tratada por reload concorrente */ }
  });
  // Arquivos já montou? trocar de aba remonta → novo GET
  await abrirAba(pm, "Personagens");
  await abrirAba(pm, "Arquivos");
  await pm.waitForSelector(".estado-feedback-carregando", { timeout: 8000 });
  const estilo = await pm.locator(".estado-feedback-icone").evaluate((el) => {
    const s = getComputedStyle(el);
    return { dur: s.animationDuration, iter: s.animationIterationCount };
  });
  const durMs = parseFloat(estilo.dur) * (estilo.dur.endsWith("ms") ? 1 : 1000);
  ok("reduced-motion. animação do indicador neutralizada", durMs <= 1 || estilo.iter === "1", `dur=${estilo.dur} iter=${estilo.iter}`);
  ok("reduced-motion. texto de loading continua visível", (await pm.locator(".estado-feedback-texto").innerText()).includes("Carregando"));
  liberarArq();
  await pm.unroute(`**/api/campaigns/${c.campId}/arquivos`);
  await pm.waitForTimeout(400);

  // ---------- 5) Mobile 390px sem overflow ----------
  await pm.setViewportSize({ width: 390, height: 844 });
  await pm.waitForTimeout(300);
  const ov = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("mobile 390px sem overflow horizontal", ov <= 1, `overflow=${ov}px`);

  // ---------- 6) Jogador: mesmo feedback consistente ----------
  const ctxJ = await browser.newContext();
  await ctxJ.addCookies([{ name: "mestre_rpg_session", value: c.jogadores.jogador1.cookie.split("=").pop(), url: BASE }]);
  const pj = await ctxJ.newPage();
  let falharCharsJ = true;
  await pj.route(urlChars, async (route) => {
    if (falharCharsJ) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ erro: "x" }) });
    else await route.continue();
  });
  await pj.goto(BASE, { waitUntil: "domcontentloaded" });
  await abrirCampanha(pj);
  await abrirAba(pj, "Personagens");
  await pj.waitForSelector(".estado-feedback-erro", { timeout: 8000 });
  ok("jogador. erro acessível (role=alert)", (await pj.locator(".estado-feedback-erro").getAttribute("role")) === "alert");
  falharCharsJ = false;
  await pj.locator(".estado-feedback-erro").getByRole("button", { name: "Tentar novamente" }).click();
  await pj.waitForTimeout(1200);
  ok("jogador. retry recupera a lista", (await pj.locator(".estado-feedback-erro").count()) === 0);

  // ---------- 7) Live region: duas atualizações sucessivas no mesmo nó ----------
  // Jornada real: POST /api/admin/novidades publica → socket
  // `novidade:publicada` → toast "Nova publicação: …" no viewport
  // aria-live=polite montado na raiz do App (nunca desmonta). Duas
  // publicações sucessivas devem atualizar o MESMO nó de live region.
  // (EstadoCarregando não tem jornada real de texto mutável — seus
  // `children` são literais estáticos em todos os usos.)
  await pm.setViewportSize({ width: 1280, height: 800 });
  await pm.waitForTimeout(300);
  const viewport = pm.locator(".notificacoes-viewport");
  await viewport.waitFor({ state: "attached", timeout: 8000 });
  const noViewport = await viewport.elementHandle();
  const pub1 = await req(BASE, "POST", "/admin/novidades", {
    cookie: c.cookieMestre,
    body: { titulo: "F37 Publicação Um", estado: "publicada" },
  });
  const pub2 = await req(BASE, "POST", "/admin/novidades", {
    cookie: c.cookieMestre,
    body: { titulo: "F37 Publicação Dois", estado: "publicada" },
  });
  ok("notificações. publicações sucessivas aceitas", pub1.status === 201 && pub2.status === 201, `status=${pub1.status}/${pub2.status}`);
  await pm.locator(".notificacao", { hasText: "F37 Publicação Um" }).waitFor({ timeout: 8000 });
  await pm.locator(".notificacao", { hasText: "F37 Publicação Dois" }).waitFor({ timeout: 8000 });
  const estadoViewport = noViewport
    ? await noViewport.evaluate((el) => ({
        conectado: el.isConnected,
        ariaLive: el.getAttribute("aria-live"),
        mesmoNo: el === document.querySelector(".notificacoes-viewport"),
        texto: el.textContent ?? "",
        total: el.querySelectorAll(".notificacao").length,
      }))
    : { conectado: false, ariaLive: null, mesmoNo: false, texto: "", total: -1 };
  ok(
    "live region. duas atualizações sucessivas no mesmo nó conectado",
    estadoViewport.conectado && estadoViewport.mesmoNo &&
      estadoViewport.ariaLive === "polite" &&
      estadoViewport.texto.includes("F37 Publicação Um") &&
      estadoViewport.texto.includes("F37 Publicação Dois") &&
      estadoViewport.total >= 2,
    JSON.stringify(estadoViewport),
  );
  ok(
    "live region. cada notificação é role=status anunciável",
    (await pm.locator(".notificacao", { hasText: "F37 Publicação" }).evaluateAll(
      (els) => els.every((e) => e.getAttribute("role") === "status"),
    )),
  );

  await browser.close();
} finally {
  encerrarServidor(proc);
  limparDir(DIR);
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações OK`);
if (falhas.length) { console.log("FALHAS:", falhas.map((f) => f.nome).join(" | ")); process.exit(1); }
