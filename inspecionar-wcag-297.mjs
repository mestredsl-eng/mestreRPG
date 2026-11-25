// FILHO — inspeção visual dirigida dos casos FAIL provável / REVIEW da
// matriz WCAG #297 (ordem 7173173001, #322). Para cada caso:
//   fluxo, papel, viewport, seletor, foreground/background computados,
//   medição local (anel de fundo adjacente aos glifos — não pior-pixel
//   global), screenshot de evidência.
// Não altera produto; REVIEW nunca vira PASS sem medição.
import { chromium } from "playwright";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { avaliarFocoIndicador } from "./wcag-avaliador-297.mjs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("a11y297-insp");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const OUT = join(process.cwd(), "docs", "a11y-297", "inspecao-visual");
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { nome: "celular-390", width: 390, height: 844 },
  { nome: "tablet-768", width: 768, height: 1024 },
  { nome: "desktop-1366", width: 1366, height: 768 },
];

let pass = 0, fail = 0;
const t = (n, c, x = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, x); } };
const sec = (n) => console.log("\n== " + n + " ==");
const resultados = [];
const registrar = (caso) => { resultados.push(caso); console.log("   •", JSON.stringify(caso).slice(0, 300)); };

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

// ---------- medição local de texto ----------
// Localiza o elemento pelo texto, extrai o rect do 1º text node não-vazio,
// screenshot do recorte (deviceScaleFactor da context já amplifica),
// classifica pixels de tinta (perto do fg computado) e mede o anel de
// fundo adjacente aos glifos — contraste "o que o olho vê", não o pior
// pixel de qualquer região do elemento.
async function medirTextoLocal(page, shotName, { textoProcurado, seletor }) {
  const alvo = await page.evaluate(({ textoProcurado, seletor }) => {
    const els = [...document.querySelectorAll(seletor)];
    const el = els.find((e) => (e.innerText || e.textContent || "").includes(textoProcurado));
    if (!el) return null;
    const cs = getComputedStyle(el);
    // 1º text node com conteúdo → rect do Range (só a tinta, sem padding)
    let range = null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.textContent.trim()) {
        range = document.createRange();
        range.selectNodeContents(n);
        break;
      }
    }
    const r = range ? range.getBoundingClientRect() : el.getBoundingClientRect();
    // fundo efetivo: sobe a cadeia até 1º backgroundColor opaco; registra
    // se há backgroundImage antes (fundo real é imagem/gradiente)
    let cur = el, imgDecl = null, imgEl = null, opaca = null, opacaEm = null;
    while (cur && cur.nodeType === 1) {
      const c2 = getComputedStyle(cur);
      if (!imgDecl && c2.backgroundImage && c2.backgroundImage !== "none") {
        imgDecl = c2.backgroundImage.slice(0, 120);
        imgEl = cur.tagName.toLowerCase() + (cur.id ? "#" + cur.id : "") + (typeof cur.className === "string" && cur.className.trim() ? "." + cur.className.trim().split(/\s+/)[0] : "");
      }
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(c2.backgroundColor || "");
      if (m) {
        const a = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (a === 1 && !opaca) { opaca = [+m[1], +m[2], +m[3]]; opacaEm = cur.tagName.toLowerCase() + (cur.className && typeof cur.className === "string" ? "." + cur.className.trim().split(/\s+/)[0] : ""); break; }
      }
      cur = cur.parentElement;
    }
    return {
      achou: true,
      texto: (el.innerText || "").trim().slice(0, 80),
      sel: seletor,
      fg: cs.color,
      fontSize: cs.fontSize, fontWeight: cs.fontWeight,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      fundoImgDecl: imgDecl, fundoImgEl: imgEl, fundoOpaco: opaca, fundoOpacoEm: opacaEm,
    };
  }, { textoProcurado, seletor });
  if (!alvo) return registrar({ caso: shotName, erro: "elemento não encontrado", seletor, textoProcurado });

  const clip = {
    x: Math.max(0, alvo.rect.x - 3), y: Math.max(0, alvo.rect.y - 3),
    width: alvo.rect.w + 6, height: alvo.rect.h + 6,
  };
  const png = await page.screenshot({ clip });
  writeFileSync(join(OUT, `${shotName}.png`), png);

  const med = await page.evaluate(async ({ dataUrl, fgStr }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const parse = (s) => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(s || "");
      return m ? [+m[1], +m[2], +m[3]] : null;
    };
    const fg = parse(fgStr);
    const lum = (r, g, b) => {
      const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const lf = lum(fg[0], fg[1], fg[2]);
    const W = c.width, H = c.height;
    const ink = new Uint8Array(W * H);
    const dist = (i, t) => Math.abs(d[i] - t[0]) + Math.abs(d[i + 1] - t[1]) + Math.abs(d[i + 2] - t[2]);
    let nInk = 0, nTot = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] < 128) continue;
      nTot++;
      if (dist(i, fg) < 60) { ink[y * W + x] = 1; nInk++; }
    }
    // anel: pixels a ≤2px de tinta, fora da tinta e fora da zona de
    // antialias (dist<90 ao fg) — fundo realmente adjacente aos glifos
    const noAnel = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (ink[y * W + x]) continue;
      let perto = false;
      for (let dy = -2; dy <= 2 && !perto; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        if (ink[yy * W + xx]) { perto = true; break; }
      }
      if (!perto) continue;
      const i = (y * W + x) * 4;
      if (dist(i, fg) < 90) continue; // blend fg/bg — não é fundo puro
      noAnel[y * W + x] = 1;
    }
    let minR = Infinity, piorPx = null, nBg = 0;
    const razoes = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!noAnel[y * W + x]) continue;
      const i = (y * W + x) * 4;
      nBg++;
      const lb = lum(d[i], d[i + 1], d[i + 2]);
      const [hi, lo] = lf >= lb ? [lf, lb] : [lb, lf];
      const r = (hi + 0.05) / (lo + 0.05);
      razoes.push(r);
      if (r < minR) { minR = r; piorPx = [d[i], d[i + 1], d[i + 2]]; }
    }
    razoes.sort((a, b) => a - b);
    const pct = (q) => razoes.length ? +razoes[Math.min(razoes.length - 1, Math.floor(q * razoes.length))].toFixed(3) : null;
    // pior pixel GLOBAL do recorte (referência vs método anterior)
    let minGlobal = Infinity;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128 || dist(i, fg) < 90) continue;
      const lb = lum(d[i], d[i + 1], d[i + 2]);
      const [hi, lo] = lf >= lb ? [lf, lb] : [lb, lf];
      const r = (hi + 0.05) / (lo + 0.05);
      if (r < minGlobal) minGlobal = r;
    }
    return {
      fgRgb: fg, nInk, nTot, nBgAnel: nBg,
      minAnel: nBg ? +minR.toFixed(3) : null,
      p5Anel: pct(0.05), p25Anel: pct(0.25), medianaAnel: pct(0.5),
      piorPxAnel: piorPx,
      piorGlobal: minGlobal === Infinity ? null : +minGlobal.toFixed(3),
    };
  }, { dataUrl: "data:image/png;base64," + png.toString("base64"), fgStr: alvo.fg });

  const px = parseFloat(alvo.fontSize) || 16;
  const fw = parseInt(alvo.fontWeight, 10) || 400;
  const grande = px >= 24 || (px >= 18.66 && fw >= 700);
  const req = grande ? 3 : 4.5;
  return registrar({
    caso: shotName, tipo: "texto", seletor: alvo.sel, texto: alvo.texto,
    fg: alvo.fg, req,
    fundoImg: alvo.fundoImgDecl ? { decl: alvo.fundoImgDecl, em: alvo.fundoImgEl } : null,
    fundoOpaco: alvo.fundoOpaco ? `rgb(${alvo.fundoOpaco.join(",")}) @${alvo.fundoOpacoEm}` : null,
    shot: `${shotName}.png`, ...med,
  });
}

// ---------- foco ----------
// Tab real até um controle; mede o indicador do activeElement via
// avaliarFocoIndicador (método da suíte) + screenshot do elemento.
async function medirFoco(page, shotPrefix, fluxo, vpNome, maxTab = 10) {
  const paradas = [];
  for (let i = 0; i < maxTab; i++) {
    await page.keyboard.press("Tab");
    await page.waitForTimeout(120);
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const nome = (el.getAttribute("aria-label") || el.getAttribute("placeholder")
        || (el.tagName === "SELECT" ? "" : el.innerText) || el.getAttribute("title") || "").trim().slice(0, 50);
      return {
        tag: el.tagName.toLowerCase(), nome,
        outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
        boxShadow: cs.boxShadow === "none" ? null : cs.boxShadow.slice(0, 120),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        visivel: r.width > 0 && r.height > 0,
      };
    });
    if (!info || !info.visivel) continue;
    const med = await page.evaluate(avaliarFocoIndicador);
    const limpo = med.viol.length === 0 && med.rev.length === 0;
    paradas.push({ i, ...info, medicao: limpo ? "mensurável" : (med.viol[0] || med.rev[0] || "").slice(0, 140) });
    if (limpo && !paradas._shot) {
      paradas._shot = true;
      const clip = {
        x: Math.max(0, info.rect.x - 4), y: Math.max(0, info.rect.y - 4),
        width: info.rect.w + 8, height: info.rect.h + 8,
      };
      const png = await page.screenshot({ clip });
      writeFileSync(join(OUT, `${shotPrefix}-foco-${vpNome}.png`), png);
    }
    if (paradas.filter((p) => p.medicao === "mensurável").length >= 3) break;
  }
  return registrar({ caso: `${fluxo} · foco`, viewport: vpNome, papel: "mestre", paradas });
}

// ---------- inputs REVIEW (adjacente incalculável / sem pixels amostráveis) ----------
// Enumera inputs visíveis da aba, registra tipo/label/appearance/borda/fundo
// e screenshot recortado — evidência para disposição humana.
async function inspecionarInputs(page, shotPrefix, fluxo, vpNome) {
  const itens = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"
        && !el.closest("[hidden], [aria-hidden='true'], label[for]");
    };
    return [...document.querySelectorAll("input, select")].filter(vis).map((el, i) => {
      const cs = getComputedStyle(el);
      const labels = el.labels ? [...el.labels].map((l) => (l.innerText || "").trim().slice(0, 40)) : [];
      const anc = el.closest("label");
      if (anc) labels.push((anc.innerText || "").trim().slice(0, 40));
      const r = el.getBoundingClientRect();
      const ap = `${cs.appearance || ""} ${cs.webkitAppearance || ""}`.trim();
      return {
        idx: i, tag: el.tagName.toLowerCase(), type: el.type || null,
        id: el.id || null, name: el.name || null,
        aria: el.getAttribute("aria-label"),
        labels: [...new Set(labels.filter(Boolean))],
        placeholder: el.placeholder || null,
        appearance: ap || null,
        border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
        bgColor: cs.backgroundColor, color: cs.color,
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      };
    });
  });
  const capturados = [];
  for (const it of itens) {
    const clip = {
      x: Math.max(0, it.rect.x - 6), y: Math.max(0, it.rect.y - 6),
      width: it.rect.w + 12, height: it.rect.h + 12,
    };
    const png = await page.screenshot({ clip });
    const nome = `${shotPrefix}-input-${vpNome}-${it.idx}-${it.tag}${it.type ? "-" + it.type : ""}.png`;
    writeFileSync(join(OUT, nome), png);
    capturados.push({ ...it, shot: nome });
    delete capturados[capturados.length - 1].rect;
  }
  return registrar({ caso: `${fluxo} · inputs`, viewport: vpNome, papel: "mestre", total: itens.length, itens: capturados });
}

let browser, proc;
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  await criarCenario(BASE, BANCO);
  browser = await chromium.launch();

  for (const vp of VIEWPORTS) {
    sec(`Viewport ${vp.nome}`);
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();

    // login → painel (tela de login + painel pós-login)
    await page.goto(BASE);
    await medirFoco(page, "login", "login→painel", vp.nome);
    await login(page, "mestre_teste", "senha-forte-123");
    await medirFoco(page, "painel", "login→painel", vp.nome);

    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    await page.waitForTimeout(400);
    await medirFoco(page, "campanha", "campanha", vp.nome);

    // textos FAIL provável
    await aba(page, "Diário"); await page.waitForTimeout(400);
    await medirTextoLocal(page, `dica-diario-${vp.nome}`, { textoProcurado: "Nenhuma anotação", seletor: "li.dica" });

    await aba(page, "Arquivos"); await page.waitForTimeout(400);
    await medirTextoLocal(page, `dica-arquivos-${vp.nome}`, { textoProcurado: "Nenhum arquivo", seletor: "li.dica" });
    await inspecionarInputs(page, "arquivos", "Arquivos", vp.nome);

    await aba(page, "Convites"); await page.waitForTimeout(400);
    await medirTextoLocal(page, `label-checkbox-${vp.nome}`, { textoProcurado: "Exigir aprovação", seletor: "label.checkbox" });
    await inspecionarInputs(page, "convites", "Convites", vp.nome);

    // ficha detalhe + patrimônio
    await aba(page, "Personagens"); await page.waitForTimeout(500);
    const linha = page.locator("tr.clicavel", { hasText: "Mestre Herói" }).first();
    if (await linha.count()) {
      await linha.click(); await page.waitForTimeout(600);
      await medirTextoLocal(page, `ficha-dono-${vp.nome}`, { textoProcurado: "Jogador:", seletor: "p.meta.ficha-dono" });
      for (const [sub, nome] of [["Inventário", "inventario"], ["Dinheiro", "dinheiro"]]) {
        const b = page.getByRole("button", { name: sub, exact: true });
        if (await b.count()) {
          await b.first().click(); await page.waitForTimeout(350);
          await medirTextoLocal(page, `ficha-dono-${nome}-${vp.nome}`, { textoProcurado: "Jogador:", seletor: "p.meta.ficha-dono" });
        }
      }
    } else t(`${vp.nome}: linha Mestre Herói`, false);

    await ctx.close();
  }

  writeFileSync(join(OUT, "dados.json"), JSON.stringify({ gerado: new Date().toISOString(), sha: "a5e8c54", ordem: "7173173001", resultados }, null, 2));
  console.log(`\n${pass} ok / ${fail} falhas — dados em docs/a11y-297/inspecao-visual/`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}
process.exit(fail ? 1 : 0);
