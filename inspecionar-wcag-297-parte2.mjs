// FILHO — parte 2 da inspeção WCAG #297: complementos que exigem página viva
// (placeholder ::placeholder, sonda de pixels do checkbox, indicador de foco
// com evidência de screenshot). Ordem 7173173001.
import { chromium } from "playwright";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("a11y297-insp2");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const OUT = join(process.cwd(), "docs", "a11y-297", "inspecao-visual");
mkdirSync(OUT, { recursive: true });

const resultados = [];
const registrar = (c) => { resultados.push(c); console.log("  •", JSON.stringify(c).slice(0, 400)); };
const lumN = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };

async function login(page) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill("mestre_teste");
  await page.getByLabel("Senha").fill("senha-forte-123");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("Campanha Teste", { exact: true }).first().click();
  await page.waitForSelector(".abas", { timeout: 10000 });
}
async function aba(page, nome) {
  await page.locator(".abas button", { hasText: nome }).first().click();
}

// mede ::placeholder e label de um input no contexto atual
async function medirControles(page, rotulo) {
  const r = await page.evaluate(() => {
    const parse = (c) => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(c || "");
      return m ? [+m[1], +m[2], +m[3]] : null;
    };
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const raz = (a, b) => { const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]; return (hi + 0.05) / (lo + 0.05); };
    const els = [...document.querySelectorAll("input, select")].filter((el) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
    });
    return els.map((el) => {
      const cs = getComputedStyle(el);
      const ph = getComputedStyle(el, "::placeholder");
      const labels = el.labels ? [...el.labels].map((l) => (l.innerText || "").trim()) : [];
      const anc = el.closest("label");
      if (anc) labels.push((anc.innerText || "").trim());
      const bg = parse(cs.backgroundColor);
      const phc = parse(ph.color);
      const lab = labels.find(Boolean);
      const labCs = lab ? (() => { const l = el.labels?.[0] || anc; return l ? getComputedStyle(l) : null; })() : null;
      return {
        tag: el.tagName.toLowerCase(), type: el.type || "select",
        bg: cs.backgroundColor,
        placeholderCor: ph.color,
        placeholderRazaoBg: phc && bg ? +raz(phc.slice(0, 3), bg.slice(0, 3)).toFixed(3) : null,
        labelTexto: lab ? lab.slice(0, 50) : null,
        labelCor: labCs ? labCs.color : null,
        labelRazaoBgExterno: null,
      };
    });
  });
  // contraste do label vs fundo externo da seção (aproximação: fundo do pai do form)
  const comLabel = await page.evaluate(() => {
    const els = [...document.querySelectorAll("label")].filter((l) => {
      const r = l.getBoundingClientRect(); const cs = getComputedStyle(l);
      return r.width > 0 && r.height > 0 && cs.display !== "none";
    });
    return els.slice(0, 12).map((l) => {
      const cs = getComputedStyle(l);
      // fundo efetivo do próprio label (sobe até opaco)
      let cur = l, camadas = [];
      while (cur && cur.nodeType === 1) {
        const c2 = getComputedStyle(cur);
        const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(c2.backgroundColor || "");
        if (m) { camadas.push([+m[1], +m[2], +m[3], m[4] === undefined ? 1 : parseFloat(m[4])]); if (camadas[camadas.length - 1][3] === 1) break; }
        cur = cur.parentElement;
      }
      let acc = [255, 255, 255];
      for (const c of camadas.slice().reverse()) acc = [c[0] * c[3] + acc[0] * (1 - c[3]), c[1] * c[3] + acc[1] * (1 - c[3]), c[2] * c[3] + acc[2] * (1 - c[3])];
      return { texto: (l.innerText || "").trim().slice(0, 50), cor: cs.color, fundo: `rgb(${acc.map(Math.round)})`, img: !!(cur && getComputedStyle(cur).backgroundImage !== "none") };
    });
  });
  registrar({ caso: rotulo, controles: r, labelsAmostra: comLabel });
}

// sonda de pixels do checkbox: recorte do elemento, separa caixa do check
async function sondaCheckbox(page) {
  const loc = page.locator('input[type="checkbox"]').first();
  if (!(await loc.count())) return registrar({ caso: "checkbox ausente" });
  const box = await loc.boundingBox();
  const png = await page.screenshot({
    clip: { x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20 },
  });
  const shot = "checkbox-probe.png";
  writeFileSync(join(OUT, shot), png);
  const geo = { off: 10, w: box.width, h: box.height };
  const hist = await page.evaluate(async ({ dataUrl, geo }) => {
    const img = new Image(); img.src = dataUrl; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const escala = c.width / (geo.w + 2 * geo.off); // px de imagem por px CSS
    const hist = (x0, y0, w, h) => {
      const m = new Map();
      for (let y = Math.max(0, y0 | 0); y < Math.min(c.height, (y0 + h) | 0); y++)
        for (let x = Math.max(0, x0 | 0); x < Math.min(c.width, (x0 + w) | 0); x++) {
          const i = (y * c.width + x) * 4; if (d[i + 3] < 128) continue;
          const k = (d[i] >> 4) + "," + (d[i + 1] >> 4) + "," + (d[i + 2] >> 4);
          m.set(k, (m.get(k) || 0) + 1);
        }
      return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => k + "×" + n);
    };
    // caixa do controle em coords de imagem: (off..off+w)*escala
    const x0 = geo.off * escala, y0 = geo.off * escala, cw = geo.w * escala, ch = geo.h * escala;
    return {
      centro: hist(x0 + 1, y0 + 1, cw - 2, ch - 2),
      bordaControle: hist(x0 - 2, y0 - 2, cw + 4, 3).concat(hist(x0 - 2, y0 + ch - 1, cw + 4, 3), hist(x0 - 2, y0, 3, ch), hist(x0 + cw - 1, y0, 3, ch)),
      externo: hist(0, 0, c.width, 5).concat(hist(0, c.height - 5, c.width, 5), hist(0, 0, 5, c.height), hist(c.width - 5, 0, 5, c.height)),
      W: c.width, H: c.height,
    };
  }, { dataUrl: "data:image/png;base64," + png.toString("base64"), geo });
  registrar({ caso: "Convites · checkbox nativo", shot, box, hist });
}

// foco com screenshot do anel: elemento + 12px de contexto
async function focoComEvidencia(page, shotName) {
  await page.keyboard.press("Tab");
  await page.waitForTimeout(150);
  const info = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(), nome: (el.getAttribute("aria-label") || el.innerText || "").trim().slice(0, 40),
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  });
  if (!info) return;
  const clip = {
    x: Math.max(0, info.rect.x - 12), y: Math.max(0, info.rect.y - 12),
    width: info.rect.w + 24, height: info.rect.h + 24,
  };
  const png = await page.screenshot({ clip });
  writeFileSync(join(OUT, shotName), png);
  // mede: cor do outline vs moda do anel externo do recorte
  const med = await page.evaluate(async (dataUrl) => {
    const img = new Image(); img.src = dataUrl; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data; const W = c.width, H = c.height;
    const lum = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const hist = new Map();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const borda = x < 8 || y < 8 || x >= W - 8 || y >= H - 8;
      if (!borda) continue;
      const i = (y * W + x) * 4; if (d[i + 3] < 128) continue;
      const k = (d[i] >> 4) + "," + (d[i + 1] >> 4) + "," + (d[i + 2] >> 4);
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => ({ rgb: k.split(",").map((v) => parseInt(v) * 16 + 8), n }));
    return top;
  }, "data:image/png;base64," + png.toString("base64"));
  const outlineRgb = info.outline.match(/rgb\(([^)]+)\)/);
  const ol = outlineRgb ? outlineRgb[1].split(",").map(Number) : null;
  let razao = null;
  if (ol && med[0]) {
    const la = lumN(...ol), lb = lumN(...med[0].rgb);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    razao = +((hi + 0.05) / (lo + 0.05)).toFixed(2);
  }
  registrar({ caso: `foco evidência ${shotName}`, elemento: info, bgAdjacente: med[0], razaoOutlineBg: razao });
}

let browser, proc;
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  await criarCenario(BASE, BANCO);
  browser = await chromium.launch();

  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  // login: foco + controles da tela de login
  await page.goto(BASE);
  await focoComEvidencia(page, "foco-login-desktop-1366.png");
  await medirControles(page, "login → painel · controles");

  await login(page);
  await focoComEvidencia(page, "foco-painel-desktop-1366.png");
  await irCampanha(page);
  await page.waitForTimeout(400);
  await focoComEvidencia(page, "foco-campanha-desktop-1366.png");

  await aba(page, "Arquivos"); await page.waitForTimeout(400);
  await medirControles(page, "Arquivos · input pesquisa + select categoria");

  await aba(page, "Convites"); await page.waitForTimeout(400);
  await medirControles(page, "Convites · select papel + numbers + checkbox");
  await sondaCheckbox(page);

  writeFileSync(join(OUT, "dados-parte2.json"), JSON.stringify({ gerado: new Date().toISOString(), resultados }, null, 2));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}
