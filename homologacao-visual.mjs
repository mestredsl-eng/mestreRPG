#!/usr/bin/env node
// Homologação visual, mobile e acessibilidade — auditoria real com
// Playwright (navegador de verdade, servidor real, site/dist de produção,
// banco sintético). NÃO é auditoria WCAG completa: cobre overflow,
// elementos cortados, labels, nomes de botões, contraste amostral,
// navegação por teclado, foco visível, modais (encaixe, ESC, trap de
// Tab, retorno de foco) e fluxo de mesa (chat + rolagem).
// Gera screenshots em _evidencias/<viewport>/.
import { chromium } from "playwright";
import { join } from "path";
import { mkdirSync } from "fs";
import {
  req, dirTeste, prepararBanco, portaLivre, subirServidor,
  esperarSaudavel, encerrarServidor, limparDir, criarCenario,
} from "./teste-base.mjs";

const DIR = dirTeste("homologacao-visual");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;

const VIEWPORTS = [
  { nome: "desktop", width: 1366, height: 768 },
  { nome: "tablet", width: 768, height: 1024 },
  { nome: "celular", width: 390, height: 844 },
];

const achados = [];
function anotar(tela, vp, tipo, detalhe) {
  achados.push({ tela, vp, tipo, detalhe });
  console.log(`  [${vp}/${tela}] ${tipo}: ${detalhe}`);
}

async function clicaSeExiste(page, seletor, timeout = 4000) {
  try { await page.click(seletor, { timeout }); return true; } catch { return false; }
}

// ---------- medições ----------
async function medirPagina(page, tela, vp, shot = true) {
  await page.waitForTimeout(500);
  if (shot) await page.screenshot({ path: join(SHOTS, vp.nome, `${tela.replaceAll("/", "_")}.png`), fullPage: false }).catch(() => {});
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const visiveis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const overflowX = de.scrollWidth > de.clientWidth + 1;
    const dentroDeScrollX = (el) => {
      let n = el.parentElement;
      while (n && n !== document.body) {
        const s = getComputedStyle(n);
        if ((s.overflowX === "auto" || s.overflowX === "scroll") && n.scrollWidth > n.clientWidth) return true;
        n = n.parentElement;
      }
      return false;
    };
    const largos = [];
    for (const el of document.querySelectorAll("body *")) {
      if (!visiveis(el) || dentroDeScrollX(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > de.clientWidth + 1 || r.right > de.clientWidth + 1 || r.left < -1) {
        const cls = (el.className && typeof el.className === "string") ? "." + el.className.split(" ")[0] : el.tagName.toLowerCase();
        largos.push(`${el.tagName.toLowerCase()}${cls} w=${Math.round(r.width)} left=${Math.round(r.left)}`);
        if (largos.length >= 5) break;
      }
    }
    const botoesSemNome = [];
    for (const b of document.querySelectorAll("button, [role='button'], a[href], input[type='submit'], input[type='button']")) {
      if (!visiveis(b)) continue;
      const nome = (b.textContent || "").trim() || b.getAttribute("aria-label") || b.getAttribute("title") || b.getAttribute("value") || "";
      if (!nome) botoesSemNome.push(b.outerHTML.slice(0, 120));
    }
    const inputsSemLabel = [];
    for (const i of document.querySelectorAll("input, select, textarea")) {
      if (!visiveis(i) || i.type === "hidden") continue;
      const id = i.id;
      const temLabel = (id && document.querySelector(`label[for="${id}"]`))
        || i.closest("label")
        || i.getAttribute("aria-label") || i.getAttribute("aria-labelledby")
        || i.getAttribute("placeholder") || i.getAttribute("title");
      if (!temLabel) inputsSemLabel.push(`${i.tagName.toLowerCase()} type=${i.type || ""} :: ${i.outerHTML.slice(0, 120)}`);
    }
    // contraste amostral: elementos com texto direto
    const lum = (rgb) => {
      const m = rgb.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
      const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
    };
    const fundoDe = (el) => {
      let n = el;
      while (n && n !== document.documentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
        n = n.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor || "rgb(20,22,26)";
    };
    const contrastesFracos = [];
    let amostras = 0;
    for (const el of document.querySelectorAll("p, span, td, th, label, h1, h2, h3, h4, button, a, li, strong, small, code, .meta, .suave")) {
      if (!visiveis(el) || amostras > 250) continue;
      const texto = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
      if (!texto || texto.length < 2) continue;
      amostras++;
      const cor = getComputedStyle(el).color;
      const fundo = fundoDe(el);
      const l1 = lum(cor), l2 = lum(fundo);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const tam = parseFloat(getComputedStyle(el).fontSize);
      const peso = getComputedStyle(el).fontWeight;
      const grande = tam >= 24 || (tam >= 18.66 && Number(peso) >= 700);
      const limite = grande ? 3 : 4.5;
      if (ratio < limite) {
        contrastesFracos.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""} "${texto.slice(0, 30)}" ratio=${ratio.toFixed(2)}`);
        if (contrastesFracos.length >= 6) break;
      }
    }
    return { overflowX, scrollW: de.scrollWidth, clientW: de.clientWidth, largos, botoesSemNome, inputsSemLabel, contrastesFracos };
  });
  if (m.overflowX) anotar(tela, vp.nome, "rolagem-horizontal", `scrollWidth=${m.scrollW} clientWidth=${m.clientW}`);
  for (const l of m.largos) anotar(tela, vp.nome, "elemento-fora-da-tela", l);
  for (const b of m.botoesSemNome) anotar(tela, vp.nome, "botao-sem-nome", b);
  for (const i of m.inputsSemLabel) anotar(tela, vp.nome, "input-sem-label", i);
  for (const cc of m.contrastesFracos) anotar(tela, vp.nome, "contraste-fraco", cc);
  return m;
}

// ---------- teclado ----------
async function checarTeclado(page, tela, vp, passos = 15) {
  const semIndicador = [];
  const foraDeOrdem = [];
  let anterior = null;
  for (let i = 0; i < passos; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(60);
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { tag: "body", indicador: true, texto: "" };
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const visivel = r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      const indicador = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0)
        || s.boxShadow !== "none";
      const rotulo = (el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.tagName).trim().slice(0, 40);
      return { tag: el.tagName.toLowerCase(), indicador, visivel, texto: rotulo, y: Math.round(r.top) };
    });
    if (!info.indicador && info.tag !== "body") semIndicador.push(`${i}:<${info.tag}> "${info.texto}"`);
    if (anterior && info.y !== null && anterior.y !== null && info.y < anterior.y - 400) {
      foraDeOrdem.push(`${i}: salto ${anterior.y}→${info.y}`);
    }
    anterior = info;
  }
  if (semIndicador.length) anotar(tela, vp.nome, "foco-sem-indicador", semIndicador.slice(0, 4).join(" | "));
  if (foraDeOrdem.length) anotar(tela, vp.nome, "ordem-foco-estranha", foraDeOrdem.slice(0, 3).join(" | "));
}

async function checarModal(page, tela, vp) {
  // abre "Novo livro" no Acervo
  const abriu = await clicaSeExiste(page, 'button:has-text("+ Novo livro")', 3000);
  if (!abriu) { anotar(tela, vp.nome, "modal-nao-abriu", "botão + Novo livro"); return; }
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  const geo = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
    return { w: Math.round(d.width), h: Math.round(d.height), vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, overflow: d.bottom > document.documentElement.clientHeight + 1 || d.right > document.documentElement.clientWidth + 1 };
  });
  if (geo.overflow) anotar(tela, vp.nome, "modal-fora-da-tela", JSON.stringify(geo));
  // foco inicial dentro do modal
  const focoInicial = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return d.contains(document.activeElement);
  });
  if (!focoInicial) anotar(tela, vp.nome, "modal-foco-inicial", "foco não entrou no diálogo");
  // trap de Tab: 20 tabs não podem sair do modal
  let saiu = false;
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const dentro = await page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
    if (!dentro) { saiu = true; break; }
  }
  if (saiu) anotar(tela, vp.nome, "modal-trap-tab", "foco escapou do diálogo");
  await page.screenshot({ path: join(SHOTS, vp.nome, `${tela.replaceAll("/", "_")}-modal.png`) }).catch(() => {});
  // Escape fecha e foco retorna ao botão
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const fechou = await page.locator('[role="dialog"]').count() === 0;
  if (!fechou) anotar(tela, vp.nome, "modal-escape", "Escape não fechou");
  const focoVoltou = await page.evaluate(() => document.activeElement?.textContent?.includes("Novo livro") || document.activeElement?.getAttribute("aria-label")?.includes("livro"));
  if (fechou && !focoVoltou) anotar(tela, vp.nome, "modal-retorno-foco", `foco foi para <${await page.evaluate(() => document.activeElement?.tagName.toLowerCase())}>`);
}

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  for (const vp of VIEWPORTS) mkdirSync(join(SHOTS, vp.nome), { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO);
  const cm = c.cookieMestre;

  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    const errosJs = [];
    page.on("pageerror", (e) => errosJs.push(String(e).slice(0, 200)));

    // ===== anônimo: login =====
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await medirPagina(page, "login", vp);
    await checarTeclado(page, "login", vp, 8);

    // ===== autenticado =====
    const [ckN, ckV] = cm.split("=", 2);
    await ctx.addCookies([{ name: ckN, value: decodeURIComponent(ckV), url: BASE }]);
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await medirPagina(page, "painel", vp);
    await checarTeclado(page, "painel", vp, 15);

    // campanhas
    await clicaSeExiste(page, 'button:has-text("Campanhas")');
    await page.waitForTimeout(600);
    await medirPagina(page, "campanhas", vp);
    const abriuCamp = await clicaSeExiste(page, ".cartao-campanha", 4000);
    if (!abriuCamp) anotar("campanha", vp.nome, "campanha-nao-abriu", "");
    await page.waitForTimeout(800);
    await medirPagina(page, "campanha/info", vp);

    // abas da campanha
    const abas = [
      ["mesa", async () => {
        // inicia sessão de mesa e testa chat + rolagem
        await clicaSeExiste(page, 'button:has-text("Iniciar sessão")', 3000);
        await page.waitForTimeout(800);
        const inputChat = page.locator('.chat-form input[placeholder]').first();
        if (await inputChat.count()) {
          await inputChat.fill(`msg-visual-${vp.nome}`);
          await page.click('.chat-form button[type="submit"], .chat-form button:has-text("Enviar")');
          await page.waitForSelector(`text=msg-visual-${vp.nome}`, { timeout: 8000 }).catch(() => anotar("campanha/mesa", vp.nome, "chat-nao-apareceu", ""));
        } else anotar("campanha/mesa", vp.nome, "chat-input-ausente", "");
        // rolagem livre
        await clicaSeExiste(page, 'button[role="tab"]:has-text("Rolagem e dano")', 3000);
        await page.waitForTimeout(400);
        const dadosSel = page.locator(".rolagem-controles select").first();
        if (await dadosSel.count()) {
          await dadosSel.selectOption("20");
          await page.click('.rolagem-form button[type="submit"]');
          await page.waitForSelector("text=Total", { timeout: 8000 }).catch(() => anotar("campanha/mesa", vp.nome, "rolagem-sem-resultado", ""));
        }
      }],
      ["personagens", async () => {
        await clicaSeExiste(page, "tr.clicavel", 3000);
        await page.waitForTimeout(800);
        await medirPagina(page, "personagem/detalhe", vp);
        // a navegação .abas permanece visível — não é preciso voltar
      }],
      ["diario", async () => {}],
      ["historico", async () => {}],
      ["arquivos", async () => {}],
      ["fichas", async () => {}],
      ["regras", async () => {}],
      ["participantes", async () => {}],
      ["convites", async () => {}],
    ];
    for (const [aba, extra] of abas) {
      const ok = await clicaSeExiste(page, `.abas button:has-text("${aba === "mesa" ? "Mesa" : aba === "personagens" ? "Personagens" : aba === "diario" ? "Diário" : aba === "historico" ? "Histórico" : aba === "arquivos" ? "Arquivos" : aba === "fichas" ? "Fichas" : aba === "regras" ? "Regras" : aba === "participantes" ? "Participantes" : "Convites"}")`, 3000);
      if (!ok) { anotar(`campanha/${aba}`, vp.nome, "aba-nao-encontrada", ""); continue; }
      await page.waitForTimeout(800);
      await medirPagina(page, `campanha/${aba}`, vp);
      await extra();
      await medirPagina(page, `campanha/${aba}-pos`, vp, false);
    }

    // acervo + modal
    await clicaSeExiste(page, 'button:has-text("Acervo")');
    await page.waitForTimeout(800);
    await medirPagina(page, "acervo", vp);
    await checarModal(page, "acervo/modal-livro", vp);

    // admin + conta
    await clicaSeExiste(page, 'button:has-text("Administração")');
    await page.waitForTimeout(600);
    await medirPagina(page, "admin", vp);
    await clicaSeExiste(page, 'button:has-text("Conta")');
    await page.waitForTimeout(600);
    await medirPagina(page, "conta", vp);

    if (errosJs.length) anotar("global", vp.nome, "erro-js", errosJs.slice(0, 3).join(" | "));
    await ctx.close();
  }
  await browser.close();
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== homologação visual: ${achados.length} achados ====`);
process.exit(0);
