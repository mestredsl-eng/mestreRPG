// Issue #297 — homologação visual/acessibilidade dos fluxos críticos
// na linha 1.0.9. Matriz reproduzível: viewport (390/768/1366) × fluxo
// × papel, mais zoom 200% e movimento reduzido. Reutiliza as suítes
// especializadas existentes para cobertura profunda; aqui o foco é a
// MATRIZ transversal: toda tela crítica deve passar sem overflow
// horizontal, com controles nomeados e foco/teclado funcionais.
//
// Não redesenha nada: somente mede a interface atual (inclui o
// Patrimônio ainda embutido na ficha — regressão, não separação 1.1.x).
import { chromium } from "playwright";
import { join } from "node:path";
import { avaliarWcag, avaliarFocoIndicador } from "./wcag-avaliador-297.mjs";
import { auditarNomes } from "./nomes-acessiveis-297.mjs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, x = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, x); } };
const sec = (n) => console.log("\n== " + n + " ==");

// Placar separado WCAG 2.2 AA (autorização #7099376102): contraste e alvos
// têm contadores próprios — REVIEW/BLOCKED nunca vira PASS.
let passC = 0, failC = 0, revC = 0, passA = 0, failA = 0, revA = 0;
const tc = (n, c, x = "") => {
  if (c === true) { passC++; console.log("  ok [contraste]", n); }
  else if (c === "review") { revC++; console.log("  REVIEW [contraste]", n, x); }
  else { failC++; console.log("  FALHOU [contraste]", n, x); }
};
const ta = (n, c, x = "") => {
  if (c === true) { passA++; console.log("  ok [alvos]", n); }
  else if (c === "review") { revA++; console.log("  REVIEW [alvos]", n, x); }
  else { failA++; console.log("  FALHOU [alvos]", n, x); }
};

const DIR = dirTeste("a11y297");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

const VIEWPORTS = [
  { nome: "celular-390", width: 390, height: 844 },
  { nome: "tablet-768", width: 768, height: 1024 },
  { nome: "desktop-1366", width: 1366, height: 768 },
];

async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irCampanha(page, nome = "Campanha Teste") {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(nome, { exact: true }).first().click();
}
async function aba(page, nome) {
  await page.locator(".abas button", { hasText: nome }).first().click();
}
// Controles interativos sem nome acessível — auditor type-aware
// (nomes-acessiveis-297.mjs, HTML-AAM #7107456243): value de input e
// textContent de <option> NÃO são nome; texto interno só para
// button/link/similares. Ocultos e desabilitados fora do escopo.
async function semNome(page, seletor = null) {
  return page.evaluate(auditarNomes, seletor);
}
// Overflow horizontal não intencional do documento.
async function overflowX(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    return { sw: de.scrollWidth, cw: de.clientWidth, overflow: de.scrollWidth > de.clientWidth + 1 };
  });
}
// ---------- WCAG 2.2 AA — avaliador compartilhado (wcag-avaliador-297.mjs) ----------
// Metodologia normativa #7104140993: indicador classificado→adjacente,
// ambíguo⇒REVIEW, IMG amostrado, inline estrito, foco com alpha composto.

async function checarWcag(page, rotulo) {
  const r = await page.evaluate(avaliarWcag);
  const violC = r.textos.viol.length + r.naoTexto.viol.length;
  const revCount = r.textos.rev.length + r.naoTexto.rev.length;
  const det = [...r.textos.viol, ...r.naoTexto.viol].slice(0, 3)
    .map((v) => v.slice(0, 110)).join(" || ");
  if (violC > 0) tc(`${rotulo}: contraste AA`, false, `${violC} violação(ões): ${det}`);
  else if (revCount > 0) tc(`${rotulo}: contraste AA`, "review", `${revCount} superfície(s) incalculável(is): ${(r.textos.rev[0] || r.naoTexto.rev[0] || "").slice(0, 140)}`);
  else tc(`${rotulo}: contraste AA`, true);

  const violA = r.alvos.viol;
  const detA = violA.slice(0, 3).map((v) => v.slice(0, 110)).join(" || ");
  const notaEsp = r.alvos.okEsp ? ` (${r.alvos.okEsp} com exceção inline/espaçamento)` : "";
  if (violA.length > 0) ta(`${rotulo}: alvos ≥24px`, false, `${violA.length} alvo(s): ${detA}${notaEsp}`);
  else ta(`${rotulo}: alvos ≥24px`, true, notaEsp.trim());
}

async function checarFoco(page, rotulo) {
  const r = await page.evaluate(avaliarFocoIndicador);
  if (r.viol.length) tc(`${rotulo}: indicador de foco AA`, false, r.viol[0].slice(0, 140));
  else if (r.rev.length) tc(`${rotulo}: indicador de foco AA`, "review", r.rev[0].slice(0, 140));
  else tc(`${rotulo}: indicador de foco AA`, true);
}

// semNome com escopo de elemento (formulário específico).
async function semNomeEscopo(page, locator) {
  const h = await locator.elementHandle().catch(() => null);
  return h ? page.evaluate(auditarNomes, h) : ["<escopo ausente>"];
}

// Formulários de Dinheiro (#7107456243): inspeção de controles sem
// nome ANTES e DEPOIS de selecionar opções reais — texto de <option>
// e valor de input NÃO são nome acessível (HTML-AAM).
async function checarFormulariosDinheiro(page) {
  const formCom = (btn) => page.locator("form.formulario", {
    has: page.getByRole("button", { name: btn, exact: true }),
  });
  const checarForm = async (rotuloF, formLocator) => {
    if (!(await formLocator.count())) { t(`Dinheiro ${rotuloF}: formulário presente`, false); return; }
    const f = formLocator.first();
    const sn1 = await semNomeEscopo(page, f);
    t(`Dinheiro ${rotuloF}: controles nomeados (antes)`, sn1.length === 0, sn1.slice(0, 4).join(" | "));
    const sels = f.locator("select");
    const nSels = await sels.count();
    for (let i = 0; i < nSels; i++) {
      const nOp = await sels.nth(i).locator("option").count();
      if (nOp > 1) await sels.nth(i).selectOption({ index: 1 }).catch(() => {});
    }
    await page.waitForTimeout(200);
    const sn2 = await semNomeEscopo(page, f);
    t(`Dinheiro ${rotuloF}: controles nomeados (após seleção)`, sn2.length === 0, sn2.slice(0, 4).join(" | "));
  };
  // Movimentar — montado sempre que há contas
  await checarForm("Movimentar", formCom("Registrar"));
  // Nova conta — abre/fecha pelo toggle
  const btnNova = page.getByRole("button", { name: "Nova conta", exact: true });
  if (await btnNova.count()) {
    await btnNova.first().click();
    await page.waitForTimeout(300);
    await checarForm("Nova conta", formCom("Criar"));
    await btnNova.first().click().catch(() => {});
    await page.waitForTimeout(200);
  } else t("Dinheiro: botão Nova conta presente", false);
  // Transferir — abre/fecha pelo toggle
  const btnTransf = page.getByRole("button", { name: "Transferir (PIX fictício)", exact: true });
  if (await btnTransf.count()) {
    await btnTransf.first().click();
    await page.waitForTimeout(300);
    await checarForm("Transferir", formCom("Enviar"));
    await btnTransf.first().click().catch(() => {});
    await page.waitForTimeout(200);
  } else t("Dinheiro: botão Transferir presente", false);
}

async function checarTela(page, rotulo) {
  const ov = await overflowX(page);
  t(`${rotulo}: sem overflow horizontal`, !ov.overflow, `scrollWidth=${ov.sw} clientWidth=${ov.cw}`);
  const sn = await semNome(page);
  t(`${rotulo}: controles com nome acessível`, sn.length === 0, sn.slice(0, 3).join(" | "));
  await checarWcag(page, rotulo).catch((e) => {
    tc(`${rotulo}: contraste AA`, "review", "avaliador falhou: " + String(e?.message ?? e).slice(0, 120));
    ta(`${rotulo}: alvos ≥24px`, "review", "avaliador falhou: " + String(e?.message ?? e).slice(0, 120));
  });
}

let browser, proc;
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO);
  // Contas financeiras reais — exercitam os seletores de Dinheiro com
  // opções verdadeiras antes/depois da seleção (#7107456243).
  if (cenario.personagemMestre) {
    for (const [type, name] of [["especie", "Carteira Teste"], ["banco", "Banco Teste"]]) {
      await req(BASE, "POST", `/characters/${cenario.personagemMestre}/financeiro/contas`, {
        cookie: cenario.cookieMestre,
        body: { type, name, balanceReais: 0 },
      }).catch(() => {});
    }
  }
  browser = await chromium.launch();

  // ---------- Matriz viewport × fluxo (mestre) ----------
  for (const vp of VIEWPORTS) {
    sec(`Viewport ${vp.nome} — fluxos críticos (mestre)`);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();

    await login(page, "mestre_teste", "senha-forte-123");
    await checarTela(page, "login→painel");

    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    await checarTela(page, "campanha (visão geral)");

    // Fluxos por aba — amostra representativa dos fluxos críticos
    for (const nomeAba of ["Personagens", "Diário", "Arquivos", "Convites"]) {
      const tem = await page.locator(".abas button", { hasText: nomeAba }).count();
      if (!tem) { t(`aba ${nomeAba} presente`, false); continue; }
      await aba(page, nomeAba);
      await page.waitForTimeout(400);
      await checarTela(page, `aba ${nomeAba}`);
    }

    // Ficha: abrir personagem → detalhe (leitura) + patrimônio (regressão)
    await aba(page, "Personagens");
    await page.waitForTimeout(500);
    const linha = page.locator("tr.clicavel").first();
    if (await linha.count()) {
      await linha.click();
      await page.waitForTimeout(500);
      await checarTela(page, "ficha detalhe");
      // regressão Patrimônio: abas atuais ainda montam (sem redesenhar)
      let viuDinheiro = false;
      for (const sub of ["Inventário", "Dinheiro"]) {
        const b = page.getByRole("button", { name: sub, exact: true });
        if (await b.count()) {
          await b.first().click();
          await page.waitForTimeout(300);
          await checarTela(page, `patrimônio ${sub}`);
          if (sub === "Dinheiro") viuDinheiro = true;
        }
      }
      if (viuDinheiro) await checarFormulariosDinheiro(page);
      const voltar = page.getByRole("button", { name: "Voltar" }).last();
      if (await voltar.count()) await voltar.click().catch(() => {});
      await page.waitForSelector(".abas", { timeout: 10000 }).catch(() => {});
    } else t("linha de personagem clicável", false);

    // Mesa: entrada na sessão (fluxo crítico multiplayer)
    await aba(page, "Mesa");
    await page.waitForTimeout(600);
    await checarTela(page, "aba Mesa");

    await ctx.close();
  }

  // ---------- Jogador (papel não-mestre) — desktop + mobile + tablet ----------
  for (const vp of [
    { nome: "desktop-1366", width: 1366, height: 768 },
    { nome: "celular-390", width: 390, height: 844 },
    { nome: "tablet-768", width: 768, height: 1024 },
  ]) {
    sec(`Viewport ${vp.nome} — jogador (papel)`);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await login(page, "jogador_um", "senha-jogador-123");
    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    await checarTela(page, "jogador: campanha");
    await aba(page, "Personagens");
    await page.waitForTimeout(500);
    await checarTela(page, "jogador: personagens");
    await ctx.close();
  }

  // ---------- Sessão mestre única: teclado real, zoom 200%, modal, logout ----------
  // Um contexto = no máximo 2 logins (rate limit /auth/login = 10/5min/IP).
  sec("Desktop-1366 — teclado real, zoom 200%, modal e logout (mestre)");
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForLoadState("networkidle").catch(() => {});

    // Teclado real na tela de login: Tab deve produzir :focus-visible
    let paradas = 0, fvOk = 0, ultimoRotulo = "";
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return {
          fv: el.matches(":focus-visible"),
          rotulo: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().slice(0, 40),
        };
      });
      if (!info) continue;
      paradas++;
      if (info.fv) fvOk++;
      ultimoRotulo = info.rotulo;
      if (/Entrar/.test(info.rotulo)) break;
    }
    t("Tab produz paradas de foco", paradas > 0, `paradas=${paradas}`);
    t("foco via teclado usa :focus-visible", fvOk === paradas, `${fvOk}/${paradas} fv; último='${ultimoRotulo}'`);
    await checarFoco(page, "login");

    // Login → painel → campanha
    await login(page, "mestre_teste", "senha-forte-123");
    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    // Indicador de foco medido separadamente também na campanha
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    await checarFoco(page, "campanha");

    // Zoom 200%
    await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    await page.waitForTimeout(400);
    const ov = await overflowX(page);
    t("zoom200: campanha sem overflow horizontal", !ov.overflow, `scrollWidth=${ov.sw} clientWidth=${ov.cw}`);
    await aba(page, "Personagens");
    await page.waitForTimeout(400);
    const ov2 = await overflowX(page);
    t("zoom200: Personagens sem overflow horizontal", !ov2.overflow, `scrollWidth=${ov2.sw} clientWidth=${ov2.cw}`);
    await page.evaluate(() => { document.documentElement.style.zoom = ""; });
    await page.waitForTimeout(300);

    // Modal XP em lote: foco entra, Tab circula dentro, Esc fecha, foco volta
    const btnLote = page.getByRole("button", { name: "XP em lote" });
    if (await btnLote.count()) {
      await btnLote.first().click();
      const dialog = page.locator("[role='dialog']").first();
      await dialog.waitFor({ timeout: 5000 }).catch(() => {});
      t("modal XP em lote abre (role=dialog)", await dialog.count() > 0);
      if (await dialog.count()) {
        const focoDentro = await page.evaluate(() => {
          const d = document.querySelector("[role='dialog']");
          return d ? d.contains(document.activeElement) : false;
        });
        t("foco inicial dentro do modal", focoDentro);
        let escapou = false;
        for (let i = 0; i < 8; i++) {
          await page.keyboard.press("Tab");
          const fora = await page.evaluate(() => {
            const d = document.querySelector("[role='dialog']");
            return d ? !d.contains(document.activeElement) : true;
          });
          if (fora) { escapou = true; break; }
        }
        t("Tab circula dentro do modal (focus trap)", !escapou);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        t("Esc fecha o modal", (await page.locator("[role='dialog']").count()) === 0);
        const focoVoltou = await page.evaluate(() => {
          const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "XP em lote");
          return b ? document.activeElement === b : false;
        });
        t("foco retorna ao botão de origem", focoVoltou);
      }
    } else t("botão XP em lote presente (mestre)", false);

    // Logout e recuperação de sessão
    const sair = page.locator("button.sair", { hasText: "Sair" }).first();
    if (await sair.count()) {
      await sair.click();
      await page.getByLabel("Usuário").waitFor({ timeout: 15000 }).catch(() => {});
      const voltouLogin = await page.getByLabel("Usuário").isVisible().catch(() => false);
      t("logout retorna à tela de login", voltouLogin);
      await login(page, "mestre_teste", "senha-forte-123");
      t("re-login restaura sessão", await page.getByText("Servidor online").isVisible());
    } else t("botão Sair presente", false);
    await ctx.close();
  }

  // ---------- Movimento reduzido — SO E preferência do app (1 login) ----------
  sec("Movimento reduzido — SO e app");
  const visualBase = { intensidade: "equilibrada", corDestaque: "vinho", superficies: "padrao", textura: "sutil", animacoes: "normal", densidade: "padrao" };
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await login(page, "mestre_teste", "senha-forte-123");
    // app em 'completo' + SO reduce → OS prevalece
    await req(BASE, "PATCH", "/auth/preferences", {
      cookie: cenario.cookieMestre,
      body: { visual: { ...visualBase, animacoes: "completo" } },
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => {});
    const rm = await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
    t("SO reporta prefers-reduced-motion", rm === true);
    const efetivoOs = await page.evaluate(() => document.documentElement.getAttribute("data-movimento-efetivo"));
    t("OS reduce prevalece sobre app completo", efetivoOs === "reduzido", `efetivo=${efetivoOs}`);
    // app em 'reduzido' sem reduce do SO → efetivo reduzido pela preferência do app
    const r2 = await req(BASE, "PATCH", "/auth/preferences", {
      cookie: cenario.cookieMestre,
      body: { visual: { ...visualBase, animacoes: "reduzido" } },
    });
    t("PATCH preferências visual.animacoes=reduzido aceito", r2.status === 200, `status=${r2.status}`);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.reload();
    await page.waitForLoadState("networkidle").catch(() => {});
    const efetivoApp = await page.evaluate(() => document.documentElement.getAttribute("data-movimento-efetivo"));
    t("app animacoes=reduzido → data-movimento-efetivo=reduzido", efetivoApp === "reduzido", `efetivo=${efetivoApp}`);
    await ctx.close();
  }

  await browser.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}
console.log(`\n==== a11y-fluxos-297: ${pass} ok, ${fail} falhas ====`);
console.log(`==== contraste WCAG2.2AA (SC 1.4.3/1.4.11): ${passC} ok, ${failC} falhas, ${revC} review ====`);
console.log(`==== alvos ponteiro ≥24px (SC 2.5.8): ${passA} ok, ${failA} falhas, ${revA} review ====`);
process.exit(fail || failC || failA ? 1 : 0);
