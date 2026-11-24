// Issue #297 / #318 — artefato individual dos REVIEWs de contraste.
// Ordem do Dono Técnico (#297 comment 7139082779, #318 item 4):
// cada ocorrência REVIEW com fluxo, papel, viewport, seletor estável,
// tipo (texto/não-texto/foco), conteúdo/controle, CSS background e causa
// exata; deduplicar sem apagar diferenças reais de viewport/papel;
// amostragem conservadora dos pixels renderizados (nunca média global);
// screenshot por caso representativo; tabela de disposição.
// Não altera produto; REVIEW nunca vira PASS por fallback.
import { chromium } from "playwright";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { avaliarWcag, avaliarFocoIndicador } from "./wcag-avaliador-297.mjs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("a11yreview297");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const OUT = join(process.cwd(), "docs", "a11y-297");
mkdirSync(join(OUT, "shots"), { recursive: true });

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

// Coletor autocontido: recebe o resultado de avaliarWcag/avaliarFocoIndicador
// e devolve detalhe por entrada REVIEW — seletor, conteúdo, CSS bg, cor.
function coletarReviews({ wcag, foco }) {
  const parseSel = (s) => { const m = /^([^\s(]+)/.exec(s); return m ? m[1] : null; };
  const bgInfo = (el) => {
    // replica fundoDe: primeiro backgroundImage não-none antes do 1º opaco
    let cur = el, imgDecl = null, corOpaca = null, imgCor = null;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      if (!imgDecl && cs.backgroundImage && cs.backgroundImage !== "none") {
        imgDecl = cs.backgroundImage.slice(0, 160);
      }
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(cs.backgroundColor || "");
      if (m) {
        const a = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (a === 1 && !corOpaca) {
          corOpaca = `rgb(${m[1]},${m[2]},${m[3]})`;
          imgCor = cur.tagName.toLowerCase() + (cur.id ? "#" + cur.id : "");
          break;
        }
      }
      cur = cur.parentElement;
    }
    return { imgDecl, corOpaca, imgCor };
  };
  const detalhes = (el) => {
    const cs = getComputedStyle(el);
    const bg = bgInfo(el);
    const txt = (el.innerText || el.textContent || "").trim().slice(0, 80);
    const px = parseFloat(cs.fontSize) || 16;
    const w = parseInt(cs.fontWeight, 10) || 400;
    const ehTexto = !!([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      conteudo: txt,
      cor: cs.color, borderColor: cs.borderTopColor,
      bgImage: cs.backgroundImage !== "none" ? cs.backgroundImage.slice(0, 160) : null,
      bgColor: cs.backgroundColor,
      fundoImgDecl: bg.imgDecl, fundoCorOpaca: bg.corOpaca, fundoCorEm: bg.imgCor,
      fontePx: px, fontePeso: w, textoGrande: px >= 24 || (px >= 18.66 && w >= 700),
      ehTextoNode: ehTexto,
      href: el.getAttribute("href") || null,
      ariaLabel: el.getAttribute("aria-label"),
      name: el.getAttribute("name"),
    };
  };
  const itens = [];
  const classes = [
    [/bg-image|bg-/, "fundo-imagem"],
    [/fronteira ambígua.*select:/, "nao-texto/seletor-nativo"],
    [/fronteira ambígua.*stepper/, "nao-texto/stepper-nativo"],
    [/fronteira ambígua/, "nao-texto/fronteira-ambigua"],
    [/adjacente externo incalculável|adjacente incalculável/, "adjacente-incalculavel"],
    [/identificador .*incerto/, "identificador-incerto"],
    [/svg sem nome/, "svg-sem-nome"],
    [/cor de gráfico/, "svg-grafico"],
    [/sem identificador/, "nao-texto/sem-identificador"],
  ];
  const classeDe = (s) => {
    for (const [re, c] of classes) if (re.test(s)) return c;
    return "outro";
  };
  const add = (tipo, revStr) => {
    const sel = parseSel(revStr);
    let el = null, encontrado = false;
    if (sel) { try { el = document.querySelector(sel); } catch { } encontrado = !!el; }
    itens.push({
      tipo, rev: revStr, sel, encontrado,
      causaClasse: classeDe(revStr),
      ...(encontrado ? detalhes(el) : {}),
    });
  };
  for (const s of wcag.textos.rev) add("texto", s);
  for (const s of wcag.naoTexto.rev) add("nao-texto", s);
  if (foco) for (const s of foco.rev || []) add("foco", s);
  return itens;
}

// Amostragem conservadora: screenshot do elemento → pixels; exclui pixels
// próximos da cor do indicador (texto/borda); pior razão vs cada pixel
// restante = limite inferior do contraste real. Nunca média global.
function amostrar(page, dataUrl, fgRgb) {
  return page.evaluate(async ({ dataUrl, fgRgb }) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const lum = (r, g, b) => {
      const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const lf = lum(fgRgb[0], fgRgb[1], fgRgb[2]);
    let minR = Infinity, nBg = 0, nTot = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      nTot++;
      const dr = Math.abs(d[i] - fgRgb[0]), dg = Math.abs(d[i + 1] - fgRgb[1]), db = Math.abs(d[i + 2] - fgRgb[2]);
      if (dr + dg + db < 90) continue; // pixel do próprio indicador/texto
      nBg++;
      const lb = lum(d[i], d[i + 1], d[i + 2]);
      const [hi, lo] = lf >= lb ? [lf, lb] : [lb, lf];
      const r = (hi + 0.05) / (lo + 0.05);
      if (r < minR) minR = r;
    }
    return { minR: minR === Infinity ? null : +minR.toFixed(3), nBg, nTot };
  }, { dataUrl, fgRgb });
}

const parseRgb = (s) => {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(s || "");
  return m ? [+m[1], +m[2], +m[3]] : null;
};
// Dedup por elemento real: seletores genéricos (span/p/td) não distinguem
// nós diferentes — o discriminador (conteúdo/aria/nome/href) evita fundir
// casos distintos. Viewport/papel/fluxo ficam como ocorrências do caso.
const discriminador = (it) => (it.conteudo || it.ariaLabel || it.name || it.href || "").replace(/\s+/g, " ").slice(0, 60);
const chaveDedup = (it) => `${it.tipo}|${it.sel || it.rev.slice(0, 40)}|${it.causaClasse}|${discriminador(it)}`;

let browser, proc;
const ocorrencias = [];
const unicos = new Map(); // chave -> {meta, itens, png?}
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  await criarCenario(BASE, BANCO);
  browser = await chromium.launch();

  const telas = [
    { rotulo: "login→painel", ir: async (p) => { await login(p, "mestre_teste", "senha-forte-123"); } },
    { rotulo: "campanha", ir: async (p) => { await irCampanha(p); await p.waitForSelector(".abas", { timeout: 10000 }); } },
    { rotulo: "Personagens", ir: (p) => aba(p, "Personagens") },
    { rotulo: "Diário", ir: (p) => aba(p, "Diário") },
    { rotulo: "Arquivos", ir: (p) => aba(p, "Arquivos") },
    { rotulo: "Convites", ir: (p) => aba(p, "Convites") },
    { rotulo: "ficha detalhe", ir: async (p) => {
        await aba(p, "Personagens"); await p.waitForTimeout(500);
        const l = p.locator("tr.clicavel", { hasText: "Mestre Herói" }).first();
        if (await l.count()) { await l.click(); await p.waitForTimeout(600); }
      } },
    { rotulo: "patrimônio Inventário", ir: async (p) => {
        const b = p.getByRole("button", { name: "Inventário", exact: true });
        if (await b.count()) { await b.first().click(); await p.waitForTimeout(300); }
      } },
    { rotulo: "patrimônio Dinheiro", ir: async (p) => {
        const b = p.getByRole("button", { name: "Dinheiro", exact: true });
        if (await b.count()) { await b.first().click(); await p.waitForTimeout(300); }
      } },
    { rotulo: "Mesa", ir: (p) => aba(p, "Mesa") },
  ];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    let logado = false;
    for (const tela of telas) {
      if (!logado) { await tela.ir(page); logado = tela.rotulo !== "login→painel"; }
      else await tela.ir(page);
      await page.waitForTimeout(350);
      const wcag = await page.evaluate(avaliarWcag);
      const foco = (tela.rotulo === "login→painel" || tela.rotulo === "campanha")
        ? await page.evaluate(avaliarFocoIndicador) : null;
      const itens = await page.evaluate(coletarReviews, { wcag, foco });
      for (const it of itens) {
        const meta = { fluxo: tela.rotulo, papel: "mestre", viewport: vp.nome };
        ocorrencias.push({ ...meta, ...it });
        const k = chaveDedup(it);
        if (!unicos.has(k)) {
          unicos.set(k, { meta: { ...meta, fluxo: tela.rotulo }, itens: [it], png: null });
          // screenshot representativo do 1º caso do grupo
          if (it.encontrado && it.sel) {
            try {
              const loc = page.locator(it.sel).first();
              if (await loc.count()) {
                unicos.get(k).png = await loc.screenshot({ timeout: 5000 }).catch(() => null);
              }
            } catch { }
          }
        } else unicos.get(k).itens.push(it);
      }
    }
    // papel jogador — campanha + personagens
    const ctxJ = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const pj = await ctxJ.newPage();
    await login(pj, "jogador_um", "senha-jogador-123");
    await irCampanha(pj); await pj.waitForSelector(".abas", { timeout: 10000 });
    for (const tela of [
      { rotulo: "jogador: campanha", ir: async () => {} },
      { rotulo: "jogador: personagens", ir: (p) => aba(p, "Personagens") },
    ]) {
      await tela.ir(pj); await pj.waitForTimeout(350);
      const wcag = await pj.evaluate(avaliarWcag);
      const itens = await pj.evaluate(coletarReviews, { wcag, foco: null });
      for (const it of itens) {
        const meta = { fluxo: tela.rotulo, papel: "jogador", viewport: vp.nome };
        ocorrencias.push({ ...meta, ...it });
        const k = chaveDedup(it);
        if (!unicos.has(k)) {
          unicos.set(k, { meta, itens: [it], png: null });
          if (it.encontrado && it.sel) {
            try {
              const loc = pj.locator(it.sel).first();
              if (await loc.count()) unicos.get(k).png = await loc.screenshot({ timeout: 5000 }).catch(() => null);
            } catch { }
          }
        } else unicos.get(k).itens.push(it);
      }
    }
    await ctx.close(); await ctxJ.close();
  }
  await browser.close();

  // ---- Amostragem de pixels + disposição ----
  const b2 = await chromium.launch();
  const p2 = await (await b2.newContext()).newPage();
  const disposicoes = [];
  let i = 0;
  for (const [k, u] of unicos) {
    i++;
    const it = u.itens[0];
    const req = it.tipo === "texto" ? (it.textoGrande ? 3 : 4.5) : 3;
    // cor do indicador: texto→color; não-texto→borderColor; foco→color
    const fgStr = it.tipo === "nao-texto" ? (it.borderColor || it.cor) : it.cor;
    const fg = parseRgb(fgStr);
    let amostra = null, shot = null;
    if (u.png && fg) {
      const dataUrl = "data:image/png;base64," + u.png.toString("base64");
      shot = `shots/${String(i).padStart(3, "0")}-${(it.sel || "el").replace(/[^a-z0-9]+/gi, "_").slice(0, 50)}.png`;
      writeFileSync(join(OUT, shot), u.png);
      amostra = await amostrar(p2, dataUrl, fg);
    }
    let disp, motivo;
    if (!it.encontrado) { disp = "REVIEW"; motivo = "elemento não relocalizado para evidência"; }
    else if (!fg) { disp = "REVIEW"; motivo = "cor do indicador não parseável"; }
    else if (!amostra || amostra.nBg === 0) { disp = "REVIEW"; motivo = "sem pixels de fundo amostráveis"; }
    else if (amostra.minR >= req) { disp = "PASS provável"; motivo = `pior fundo amostrado ${amostra.minR}:1 ≥ ${req}:1 (${amostra.nBg} px bg / ${amostra.nTot})`; }
    else { disp = "REVIEW mantido"; motivo = `pior pixel ${amostra.minR}:1 < ${req}:1 — prova inconclusiva (anti-alias/texto residual), sem conversão` ; }
    disposicoes.push({ chave: k, ...u.meta, tipo: it.tipo, causaClasse: it.causaClasse, sel: it.sel, conteudo: it.conteudo, rev: it.rev, req, fg: fgStr, amostra, shot, disposicao: disp, motivo });
  }
  await b2.close();

  // resumo por causaClasse
  const porClasse = {};
  for (const d of disposicoes) {
    const c = d.causaClasse;
    porClasse[c] = porClasse[c] || { total: 0, passProvavel: 0, review: 0, reviewMantido: 0 };
    porClasse[c].total++;
    if (d.disposicao === "PASS provável") porClasse[c].passProvavel++;
    else if (d.disposicao === "REVIEW") porClasse[c].review++;
    else porClasse[c].reviewMantido++;
  }

  writeFileSync(join(OUT, "review-contraste.json"), JSON.stringify({
    gerado: new Date().toISOString(), sha: process.env.GIT_SHA || "worktree",
    totalOcorrencias: ocorrencias.length,
    casosUnicos: disposicoes.length,
    porClasse,
    ocorrencias, disposicoes,
  }, null, 2));

  const md = [];
  md.push("# Disposição dos REVIEWs de contraste — #297/#318\n");
  md.push(`Gerado: ${new Date().toISOString()} — ${ocorrencias.length} ocorrências → ${disposicoes.length} casos únicos.\n`);
  md.push("| Causa | Casos | PASS provável | REVIEW s/ evidência | REVIEW mantido |\n|---|---|---|---|---|");
  for (const [c, v] of Object.entries(porClasse)) {
    md.push(`| ${c} | ${v.total} | ${v.passProvavel} | ${v.review} | ${v.reviewMantido} |`);
  }
  md.push("\n## Casos\n");
  md.push("| # | Tipo | Causa | Seletor | Conteúdo | req | Amostra (pior px) | Disposição | Shot |\n|---|---|---|---|---|---|---|---|---|");
  disposicoes.forEach((d, idx) => {
    md.push(`| ${idx + 1} | ${d.tipo} | ${d.causaClasse} | \`${d.sel || "—"}\` | ${(d.conteudo || "").slice(0, 40)} | ${d.req} | ${d.amostra ? d.amostra.minR : "—"} | ${d.disposicao} | ${d.shot || "—"} |`);
  });
  writeFileSync(join(OUT, "review-contraste.md"), md.join("\n"));

  console.log(`ocorrências=${ocorrencias.length} únicos=${disposicoes.length}`);
  console.log(JSON.stringify(porClasse, null, 1));
} finally {
  await encerrarServidor(proc).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  limparDir(DIR);
}
