// Verificação de acessibilidade dos fluxos principais: todo controle
// interativo deve ter nome acessível; Tab navega; foco é visível.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("a11y");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

let browser, proc;

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
async function semNome(page) {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll("button, a[href], input, select, textarea, [role='button']")];
    return els.filter((el) => {
      const rotulo = el.closest("label");
      const labelledby = el.getAttribute("aria-labelledby");
      const nome = (
        el.getAttribute("aria-label") ||
        (labelledby ? labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" ") : "") ||
        (rotulo ? rotulo.textContent : "") ||
        el.getAttribute("title") || el.getAttribute("placeholder") ||
        el.textContent || el.value || ""
      ).trim();
      const oc = el.closest("[hidden], [aria-hidden='true'], [disabled]");
      return !nome && !oc;
    }).map((el) => el.tagName + ":" + (el.className || "").toString().slice(0, 50));
  });
}
// inputs que dependem SÓ de placeholder (rótulo frágil — achado menor)
async function soPlaceholder(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll("input, textarea, select")].filter((el) => {
      if (el.closest("[hidden], [aria-hidden='true'], [disabled]")) return false;
      const rotulo = el.closest("label");
      const labelledby = el.getAttribute("aria-labelledby");
      const temNomeForte = el.getAttribute("aria-label") || labelledby || (rotulo && rotulo.textContent.trim()) || document.querySelector(`label[for="${el.id}"]`);
      return !temNomeForte && !!el.getAttribute("placeholder");
    }).map((el) => (el.getAttribute("placeholder") || "").slice(0, 40));
  });
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  await criarCenario(BASE, BANCO);
  browser = await chromium.launch();
  const page = await browser.newPage();

  sec("Login + Painel");
  await login(page, "mestre_teste", "senha-forte-123");
  t("painel renderiza após login", await page.getByText("Servidor online").isVisible());
  t("painel: controles com nome acessível", (await semNome(page)).length === 0, (await semNome(page)).join(" | "));

  sec("Campanha — todas as abas");
  await irCampanha(page);
  await page.waitForSelector(".abas", { timeout: 10000 });
  for (const nomeAba of ["Informações", "Mesa", "Personagens", "Diário", "Histórico", "Arquivos", "Fichas", "Regras", "Convites"]) {
    const temAba = await page.locator(".abas button", { hasText: nomeAba }).count();
    if (!temAba) { t(`aba ${nomeAba} existe`, false); continue; }
    await aba(page, nomeAba);
    await page.waitForTimeout(300);
    const s = await semNome(page);
    t(`aba ${nomeAba}: controles nomeados`, s.length === 0, s.slice(0, 3).join(" | "));
  }
  // aba Participantes tem contador no rótulo
  await aba(page, "Participantes");
  await page.waitForTimeout(300);
  t("aba Participantes: controles nomeados", (await semNome(page)).length === 0);
  // patrimônio dentro do detalhe do personagem
  await aba(page, "Personagens");
  await page.waitForTimeout(400);
  const linha = page.locator("tr.clicavel").first();
  if (await linha.count()) {
    await linha.click();
    await page.waitForTimeout(400);
    for (const sub of ["Inventário", "Equipamentos", "Veículos", "Dinheiro"]) {
      const b = page.getByRole("button", { name: sub, exact: true });
      if (await b.count()) {
        await b.first().click();
        await page.waitForTimeout(300);
        const s = await semNome(page);
        t(`patrimônio ${sub}: controles nomeados`, s.length === 0, s.slice(0, 3).join(" | "));
      }
    }
  } else t("linha de personagem clicável", false);
  // volta ao nível da campanha antes de continuar
  const voltar = page.getByRole("button", { name: "Voltar" }).last();
  if (await voltar.count()) await voltar.click().catch(() => {});
  await page.waitForSelector(".abas", { timeout: 10000 }).catch(() => {});

  sec("Navegação por teclado e foco");
  await page.goto(BASE);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.body.focus());
  await page.waitForTimeout(300);
  let focou = false;
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const txt = await page.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.getAttribute("aria-label") || "");
    if (/Campanhas|Painel/.test(txt)) { focou = true; break; }
  }
  t("Tab alcança navegação principal", focou);
  const foco = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Campanhas");
    if (!b) return null;
    b.focus();
    const s = getComputedStyle(b);
    return { outline: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0, shadow: s.boxShadow !== "none" };
  });
  t("foco visível em botão", !!foco && (foco.outline || foco.shadow));

  sec("Jogador — ficha");
  const page2 = await browser.newPage();
  await login(page2, "jogador_um", "senha-jogador-123");
  await irCampanha(page2);
  await page2.waitForSelector(".abas", { timeout: 10000 });
  await aba(page2, "Personagens");
  await page2.waitForTimeout(500);
  const temNovo = await page2.getByRole("button", { name: "Novo personagem" }).count();
  t("jogador vê fluxo de ficha (modelo publicado ativo)", temNovo > 0);
  if (temNovo) {
    await page2.getByRole("button", { name: "Novo personagem" }).click();
    await page2.waitForTimeout(400);
    t("formulário de ficha: controles nomeados", (await semNome(page2)).length === 0);
  }

  sec("Modal — fechamento e foco");
  // qualquer botão que abra modal na aba Regras (novo modelo)
  await page.goto(BASE);
  await irCampanha(page);
  await page.waitForSelector(".abas", { timeout: 10000 });
  await aba(page, "Regras");
  await page.waitForTimeout(300);
  const btnModal = page.locator("button", { hasText: /Novo|Criar|Adicionar/ }).first();
  if (await btnModal.count()) {
    await btnModal.click().catch(() => {});
    await page.waitForTimeout(400);
    const modal = await page.locator(".modal, [role='dialog']").count();
    t("modal abre com role/estrutura", modal > 0);
    if (modal) {
      const s = await semNome(page.locator(".modal, [role='dialog']").first());
      t("modal: controles nomeados", s.length === 0, s.join(" | "));
      await page.keyboard.press("Escape").catch(() => {});
    }
  } else t("botão que abre modal encontrado", false);

  // achado menor (não bloqueante): campos que dependem só de placeholder
  const soPh = await soPlaceholder(page);
  console.log(`  info aba atual: ${soPh.length} campos rotulados apenas por placeholder${soPh.length ? " → " + soPh.join(" | ") : ""}`);

  await browser.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}
console.log(`\n==== acessibilidade: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
