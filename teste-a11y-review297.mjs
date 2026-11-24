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
    let cur = el, imgDecl = null, imgEl = null, corOpaca = null, imgCor = null;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      if (!imgDecl && cs.backgroundImage && cs.backgroundImage !== "none") {
        imgDecl = cs.backgroundImage;
        imgEl = cur.tagName.toLowerCase() + (cur.id ? "#" + cur.id : "") + (cur.className && typeof cur.className === "string" ? "." + cur.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
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
    return { imgDecl, imgEl, corOpaca, imgCor };
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
      bgImage: cs.backgroundImage !== "none" ? cs.backgroundImage : null,
      bgColor: cs.backgroundColor,
      fundoImgDecl: bg.imgDecl, fundoImgEl: bg.imgEl, fundoCorOpaca: bg.corOpaca, fundoCorEm: bg.imgCor,
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
const parseCor = (s) => {
  const rgb = parseRgb(s);
  if (rgb) return rgb;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((s || "").trim());
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return null;
};
const lum = (rgb) => {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const razao = (a, b) => { const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]; return (hi + 0.05) / (lo + 0.05); };

// Resolve linear-gradient(...) entre cores opacas: extrai stops (cor+posição),
// interpola em sRGB ao longo do eixo e devolve o conjunto amostrado.
// Retorna null se a declaração não for gradiente linear simples de cores
// opacas (radial, url(), rgba translúcido, etc.) — nesses casos cai na
// amostragem de pixels como antes. Nunca inventa cor: parse estrito.
function gradienteLinear(decl) {
  if (!decl || !/^linear-gradient\(/i.test(decl.trim())) return null;
  const dentro = decl.replace(/^linear-gradient\(/i, "").replace(/\)\s*$/, "");
  // split por vírgulas fora de parênteses
  const partes = []; let prof = 0, cur = "";
  for (const ch of dentro) {
    if (ch === "(") prof++;
    if (ch === ")") prof--;
    if (ch === "," && prof === 0) { partes.push(cur); cur = ""; } else cur += ch;
  }
  partes.push(cur);
  if (partes.length < 3) return null; // ângulo + >=2 stops
  const stops = [];
  for (const p of partes.slice(1)) {
    const t = p.trim();
    if (!t) return null;
    const m = /^(.*?)(?:\s+(-?[\d.]+%|0(?:\.\d+)?|1(?:\.0+)?))?$/.exec(t);
    const corTxt = (m[1] || "").trim();
    const posTxt = m[2];
    // rejeita rgba com alfa < 1 (translúcido compõe com o que está atrás)
    const alfa = /rgba?\([^)]*[,/\s]([\d.]+%?)\s*\)/.exec(corTxt);
    if (alfa) { const a = parseFloat(alfa[1]); if (!(a >= 0.999)) return null; }
    if (/url\(|var\(|calc\(/i.test(corTxt)) return null;
    const cor = parseCor(corTxt);
    if (!cor) return null;
    stops.push({ cor, pos: posTxt === undefined ? null : parseFloat(posTxt) / (posTxt.endsWith("%") ? 100 : 1) });
  }
  if (stops.length < 2) return null;
  // posições default: primeiro 0, último 1, intermediários distribuídos
  if (stops[0].pos === null) stops[0].pos = 0;
  if (stops[stops.length - 1].pos === null) stops[stops.length - 1].pos = 1;
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].pos === null) stops[i].pos = (stops[i - 1].pos + stops[i + 1].pos) / 2;
  }
  if (stops.some((s, i) => i > 0 && s.pos < stops[i - 1].pos)) return null; // fora de ordem
  // amostra densa ao longo do gradiente (interp linear sRGB por canal)
  const cores = [];
  const N = 65;
  for (let s = 0; s <= N; s++) {
    const t = s / N;
    let j = 0;
    while (j < stops.length - 2 && t > stops[j + 1].pos) j++;
    const a = stops[j], b = stops[j + 1];
    const f = b.pos === a.pos ? 0 : Math.min(1, Math.max(0, (t - a.pos) / (b.pos - a.pos)));
    cores.push([0, 1, 2].map((c) => Math.round(a.cor[c] + (b.cor[c] - a.cor[c]) * f)));
  }
  return cores;
}
// Contraste do indicador contra TODO o gradiente: pior e melhor razões.
function razoesGradiente(decl, fgRgb) {
  const cores = gradienteLinear(decl);
  if (!cores || !fgRgb) return null;
  let min = Infinity, max = 0;
  for (const c of cores) { const r = razao(fgRgb, c); if (r < min) min = r; if (r > max) max = r; }
  return { min: +min.toFixed(3), max: +max.toFixed(3), n: cores.length };
}
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
    for (const [ti, tela] of telas.entries()) {
      if (!logado) { await tela.ir(page); logado = tela.rotulo !== "login→painel"; }
      else await tela.ir(page);
      await page.waitForTimeout(350);
      const wcag = await page.evaluate(avaliarWcag);
      const foco = (tela.rotulo === "login→painel" || tela.rotulo === "campanha")
        ? await page.evaluate(avaliarFocoIndicador) : null;
      const itens = await page.evaluate(coletarReviews, { wcag, foco });
      for (const it of itens) {
        const meta = { fluxo: tela.rotulo, papel: "mestre", viewport: vp.nome, telaIdx: ti };
        const k = chaveDedup(it);
        ocorrencias.push({ ...meta, ...it, caso: k });
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
    const telasJ = [
      { rotulo: "jogador: campanha", ir: async () => {} },
      { rotulo: "jogador: personagens", ir: (p) => aba(p, "Personagens") },
    ];
    for (const [tj, tela] of telasJ.entries()) {
      await tela.ir(pj); await pj.waitForTimeout(350);
      const wcag = await pj.evaluate(avaliarWcag);
      const itens = await pj.evaluate(coletarReviews, { wcag, foco: null });
      for (const it of itens) {
        const meta = { fluxo: tela.rotulo, papel: "jogador", viewport: vp.nome, telaIdx: tj };
        const k = chaveDedup(it);
        ocorrencias.push({ ...meta, ...it, caso: k });
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
  // Replay por grupo (papel × viewport × telaIdx): re-navega até a tela do
  // caso, oculta o indicador (color/border transparent) e fotografa o FUNDO
  // REAL — elimina a contaminação de anti-alias do próprio texto que gerava
  // minR ~1.4 espúrio. Pixels remanescentes só podem REDUZIR minR
  // (direção conservadora: nunca infla contraste).
  const b2 = await chromium.launch();
  const p2 = await (await b2.newContext()).newPage();
  const disposicoes = [];
  // Um contexto por papel×viewport, avançando sequencialmente pelas telas
  // (mesma ordem da travessia): 1 login por contexto, estado acumulado —
  // evita dezenas de logins que derrubavam o "Servidor online" no replay.
  const porCtx = new Map(); // "papel|vp" -> Map<telaIdx, [[k,u]]>
  for (const [k, u] of unicos) {
    const ck = `${u.meta.papel}|${u.meta.viewport}`;
    if (!porCtx.has(ck)) porCtx.set(ck, new Map());
    const m = porCtx.get(ck);
    if (!m.has(u.meta.telaIdx)) m.set(u.meta.telaIdx, []);
    m.get(u.meta.telaIdx).push([k, u]);
  }
  const telasJ = [
    { rotulo: "jogador: campanha", ir: async () => {} },
    { rotulo: "jogador: personagens", ir: (p) => aba(p, "Personagens") },
  ];
  const telasPorPapel = { mestre: telas, jogador: telasJ };
  const credPorPapel = { mestre: ["mestre_teste", "senha-forte-123"], jogador: ["jogador_um", "senha-jogador-123"] };
  const vpPorNome = Object.fromEntries(VIEWPORTS.map((v) => [v.nome, v]));

  const ocultarIndicador = (pg, sel, tipo) => pg.evaluate(({ sel, tipo }) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const props = tipo === "texto" || tipo === "foco"
      ? ["color"]
      : ["borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor", "outlineColor"];
    window.__hideReg = [];
    for (const n of [el, ...el.querySelectorAll("*")]) {
      const cs = getComputedStyle(n);
      for (const p of props) {
        const v = cs[p];
        if (v && v !== "transparent" && v !== "rgba(0, 0, 0, 0)") {
          window.__hideReg.push({ n, p, old: n.style[p] });
          n.style[p] = "transparent";
        }
      }
      if (props[0] === "color") n.style.setProperty("-webkit-text-fill-color", "transparent");
    }
    return true;
  }, { sel, tipo });
  const restaurarIndicador = (pg) => pg.evaluate(() => {
    for (const r of window.__hideReg || []) r.n.style[r.p] = r.old;
    window.__hideReg = [];
  });

  const processarCasos = async (pg, casos) => {
    for (const [k, u] of casos) {
        const it = u.itens[0];
        const req = it.tipo === "texto" ? (it.textoGrande ? 3 : 4.5) : 3;
        const fgStr = it.tipo === "nao-texto" ? (it.borderColor || it.cor) : it.cor;
        const fg = parseRgb(fgStr);
        let amostra = null, shot = null;
        const declGrad = it.fundoImgDecl || it.bgImage;
        const grad = razoesGradiente(declGrad, fg);
        const gradInfo = grad ? { decl: declGrad.slice(0, 200), em: it.fundoImgEl || null, ...grad } : null;
        // fundo real: oculta indicador → screenshot → amostra pixels puros
        if (it.encontrado && it.sel && it.tipo !== "foco" && fg) {
          try {
            if (await ocultarIndicador(pg, it.sel, it.tipo)) {
              const loc = pg.locator(it.sel).first();
              if (await loc.count()) {
                const png = await loc.screenshot({ timeout: 5000 }).catch(() => null);
                if (png) {
                  shot = `shots/${String(disposicoes.length + 1).padStart(3, "0")}-${(it.sel || "el").replace(/[^a-z0-9]+/gi, "_").slice(0, 50)}.png`;
                  writeFileSync(join(OUT, shot), png);
                  amostra = await amostrar(p2, "data:image/png;base64," + png.toString("base64"), fg);
                }
              }
              await restaurarIndicador(pg);
            }
          } catch { }
        }
        let disp, motivo;
        if (!it.encontrado) { disp = "REVIEW"; motivo = "elemento não relocalizado para evidência"; }
        else if (!fg) { disp = "REVIEW"; motivo = "cor do indicador não parseável"; }
        else if (grad && grad.min >= req) {
          disp = "PASS provável";
          motivo = `gradiente linear analítico (${it.fundoImgEl || "próprio"}): pior razão ${grad.min}:1 ≥ ${req}:1 em ${grad.n} amostras do eixo`;
        }
        else if (grad && grad.max < req) {
          disp = "FAIL provável";
          motivo = `gradiente linear analítico: TODA a faixa ${grad.min}–${grad.max}:1 < ${req}:1 — FAIL com evidência, pendente confirmação humana`;
        }
        else if (grad) {
          disp = "REVIEW mantido";
          motivo = `gradiente linear varia ${grad.min}–${grad.max}:1 vs req ${req}:1 — posição do elemento no eixo decide; sem prova pontual`;
        }
        else if (!amostra || amostra.nBg === 0) { disp = "REVIEW"; motivo = "sem pixels de fundo amostráveis"; }
        else if (amostra.minR >= req) {
          disp = "PASS provável";
          motivo = `fundo real sem indicador: pior pixel ${amostra.minR}:1 ≥ ${req}:1 (${amostra.nBg} px / ${amostra.nTot})`;
        }
        else {
          disp = "FAIL provável";
          motivo = `fundo real sem indicador: pior pixel ${amostra.minR}:1 < ${req}:1 (${amostra.nBg} px) — pixels puros de fundo, FAIL com evidência pendente confirmação humana`;
        }
        disposicoes.push({ chave: k, ...u.meta, tipo: it.tipo, causaClasse: it.causaClasse, sel: it.sel, conteudo: it.conteudo, rev: it.rev, req, fg: fgStr, amostra, grad: gradInfo, shot, disposicao: disp, motivo });
    }
  };

  for (const [ck, porTela] of porCtx) {
    const [papel, vpNome] = ck.split("|");
    const vp = vpPorNome[vpNome];
    const ctx = await b2.newContext({ viewport: { width: vp.width, height: vp.height } });
    const pg = await ctx.newPage();
    const seq = telasPorPapel[papel] || [];
    try {
      if (papel === "jogador") {
        await login(pg, ...credPorPapel.jogador);
        await irCampanha(pg); await pg.waitForSelector(".abas", { timeout: 15000 });
      }
      const maxTi = Math.max(...porTela.keys());
      for (let ti = 0; ti <= maxTi && ti < seq.length; ti++) {
        await seq[ti].ir(pg); await pg.waitForTimeout(300);
        if (porTela.has(ti)) await processarCasos(pg, porTela.get(ti));
      }
    } catch (e) {
      for (const casos of porTela.values()) {
        for (const [k, u] of casos) {
          const it = u.itens[0];
          disposicoes.push({ chave: k, ...u.meta, tipo: it.tipo, causaClasse: it.causaClasse, sel: it.sel, conteudo: it.conteudo, rev: it.rev, req: it.tipo === "texto" ? (it.textoGrande ? 3 : 4.5) : 3, fg: null, amostra: null, grad: null, shot: null, disposicao: "REVIEW", motivo: `falha no replay da tela: ${String(e?.message ?? e).slice(0, 120)}` });
        }
      }
    }
    await ctx.close();
  }
  await b2.close();

  // Matriz por OCORRÊNCIA (ordem 7140495471): uma linha por cada entrada
  // rev[] — requisito, fluxo/papel, viewport, arquivo/assert, evidência e
  // estado final herdado do caso deduplicado.
  const porCaso = new Map(disposicoes.map((d) => [d.chave, d]));
  const assertDe = (tipo) => tipo === "foco"
    ? "avaliarFocoIndicador — teste-a11y-fluxos-297.mjs"
    : `avaliarWcag (${tipo === "texto" ? "SC 1.4.3" : "SC 1.4.11"}) — teste-a11y-fluxos-297.mjs`;
  const reqDe = (o) => o.tipo === "texto" ? (o.textoGrande ? 3 : 4.5) : 3;
  const matriz = ocorrencias.map((o) => {
    const d = porCaso.get(o.caso);
    return {
      fluxo: o.fluxo, papel: o.papel, viewport: o.viewport, tipo: o.tipo,
      requisito: o.tipo === "texto" ? "WCAG 1.4.3" : o.tipo === "nao-texto" ? "WCAG 1.4.11" : "WCAG 2.4.7 (foco)",
      req: reqDe(o), seletor: o.sel, conteudo: o.conteudo, rev: o.rev,
      arquivoAssert: assertDe(o.tipo),
      evidencia: d ? { disposicao: d.disposicao, motivo: d.motivo, grad: d.grad, amostra: d.amostra, shot: d.shot } : null,
      estadoFinal: d ? d.disposicao : "REVIEW",
    };
  });

  // resumo por causaClasse
  const porClasse = {};
  for (const d of disposicoes) {
    const c = d.causaClasse;
    porClasse[c] = porClasse[c] || { total: 0, passProvavel: 0, failProvavel: 0, review: 0, reviewMantido: 0 };
    porClasse[c].total++;
    if (d.disposicao === "PASS provável") porClasse[c].passProvavel++;
    else if (d.disposicao === "FAIL provável") porClasse[c].failProvavel++;
    else if (d.disposicao === "REVIEW") porClasse[c].review++;
    else porClasse[c].reviewMantido++;
  }
  const totEst = {};
  for (const m of matriz) totEst[m.estadoFinal] = (totEst[m.estadoFinal] || 0) + 1;

  writeFileSync(join(OUT, "review-contraste.json"), JSON.stringify({
    gerado: new Date().toISOString(), sha: process.env.GIT_SHA || "worktree",
    ordem: "7140495471 (#297) — matriz por ocorrência + casos deduplicados",
    totalOcorrencias: ocorrencias.length,
    casosUnicos: disposicoes.length,
    estadosOcorrencias: totEst,
    porClasse,
    matriz,
    disposicoes,
  }, null, 2));

  const md = [];
  md.push("# Disposição dos REVIEWs de contraste — #297/#318\n");
  md.push(`Gerado: ${new Date().toISOString()} — ${ocorrencias.length} ocorrências → ${disposicoes.length} casos únicos.\n`);
  md.push("| Causa | Casos | PASS provável | FAIL provável | REVIEW s/ evidência | REVIEW mantido |\n|---|---|---|---|---|---|");
  for (const [c, v] of Object.entries(porClasse)) {
    md.push(`| ${c} | ${v.total} | ${v.passProvavel} | ${v.failProvavel || 0} | ${v.review} | ${v.reviewMantido} |`);
  }
  md.push(`\nEstados por ocorrência (${matriz.length}): ` +
    Object.entries(totEst).map(([k, v]) => `${k}=${v}`).join(", ") +
    ". Matriz linha-a-linha por ocorrência em `matriz-review-ocorrencias.md`.\n");
  md.push("\n## Casos\n");
  md.push("| # | Tipo | Causa | Seletor | Conteúdo | req | Amostra (pior px) | Disposição | Shot |\n|---|---|---|---|---|---|---|---|---|");
  disposicoes.forEach((d, idx) => {
    md.push(`| ${idx + 1} | ${d.tipo} | ${d.causaClasse} | \`${d.sel || "—"}\` | ${(d.conteudo || "").slice(0, 40)} | ${d.req} | ${d.amostra ? d.amostra.minR : "—"} | ${d.disposicao} | ${d.shot || "—"} |`);
  });
  writeFileSync(join(OUT, "review-contraste.md"), md.join("\n"));

  // Matriz por ocorrência — uma linha por entrada rev[] (ordem 7140495471).
  const mm = [];
  mm.push("# Matriz por ocorrência — REVIEWs WCAG #297 (ordem 7140495471)\n");
  mm.push(`Gerado: ${new Date().toISOString()} — ${matriz.length} ocorrências sobre ${disposicoes.length} casos únicos.\n`);
  mm.push("Estado final PASS/FAIL provável deriva de prova analítica (gradiente linear) ou amostragem conservadora de pixels; REVIEW permanece para disposição humana.\n");
  mm.push("| # | Requisito | Fluxo | Papel | Viewport | req | Tipo | Seletor | Conteúdo | Arquivo/assert | Evidência | Estado final |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
  matriz.forEach((m, idx) => {
    const ev = m.evidencia;
    const evTxt = ev
      ? (ev.grad ? `gradiente ${ev.grad.min}–${ev.grad.max}:1` : ev.amostra ? `pior px ${ev.amostra.minR}:1` : "sem amostra") +
        (ev.shot ? ` · ${ev.shot}` : "")
      : "—";
    const conteudo = (m.conteudo || "").replace(/\|/g, "\\|").slice(0, 50);
    const sel = (m.seletor || "—").replace(/\|/g, "\\|");
    mm.push(`| ${idx + 1} | ${m.requisito} | ${m.fluxo} | ${m.papel} | ${m.viewport} | ${m.req} | ${m.tipo} | \`${sel}\` | ${conteudo} | ${m.arquivoAssert} | ${evTxt} | ${m.estadoFinal} |`);
  });
  writeFileSync(join(OUT, "matriz-review-ocorrencias.md"), mm.join("\n"));

  console.log(`ocorrências=${ocorrencias.length} únicos=${disposicoes.length}`);
  console.log(JSON.stringify(porClasse, null, 1));
} finally {
  await encerrarServidor(proc).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  limparDir(DIR);
}
