// Evidência complementar ao item 4 (PR #318): mede o contraste REAL do
// texto E das fronteiras de controles sobre os fundos `bg-image` que o
// auditor avaliarWcag marca como REVIEW por não compor gradientes via DOM.
//
// Inspeção prévia (docs/WCAG-REVIEW-1.0.9.md) mostrou que TODAS as
// fontes de background-image nas telas auditadas são linear/radial-
// gradients CSS entre cores opacas ou semi-opacas de tema — nenhum
// bitmap. Este script replica a MESMA fixture e a MESMA matriz de
// telas/viewport da suíte, mas em vez de contar rev[] executa um
// avaliador que:
//
//   TEXTOS (SC 1.4.3):
//   1. encontra elementos de texto cujo fundo efetivo passa por um
//      ancestral com background-image antes de cor opaca (a mesma
//      condição que gera o REVIEW "(tag bg-image)");
//   2. parseia as camadas de gradiente do computed style;
//   3. compõe cada parada de cor sobre o fundo efetivo abaixo dela;
//   4. calcula o pior contraste WCAG (mínimo entre todas as paradas e
//      camadas) do texto contra esse gradiente;
//   5. classifica contra o limiar aplicável (4.5:1 texto normal,
//      3:1 texto grande — mesma regra `grande()` do auditor).
//
//   CONTROLES (SC 1.4.11 — input/select/textarea):
//   6. para cada campo visível, resolve o fundo EXTERNO (a partir do
//      pai, como `fundoDe(el, externo=true)` do auditor);
//   7. quando o externo é gradiente, calcula preenchimento×externo e
//      borda×externo contra CADA parada — o pior caso por parada usa o
//      melhor identificador (preenchimento ou borda), e o veredito usa
//      o PIOR desses melhores (conservador: identifica em qualquer pixel);
//   8. quando o externo é sólido, reproduz os mesmos quocientes do
//      auditor e anexa contexto (labels, tipo, placeholder) para a
//      disposição humana das entradas "fronteira ambígua".
//
//   FOCO:
//   9. nos mesmos passos de Tab da suíte, mede outline/box-shadow do
//      activeElement contra o gradiente externo (os 2 REVIEWs de foco).
//
// Isto NÃO converte REVIEW em PASS: gera evidência numérica para a
// disposição humana (o gate formal continua sendo humano). Elementos
// sobre url()/imagem real são marcados "não-mensurável" honestamente.
//
// Não altera produção nem testes: arquivo novo, somente leitura.
import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req,
} from "./teste-base.mjs";

const REPO = dirname(fileURLToPath(import.meta.url));
const DIR = dirTeste("wcaggrad297");
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

const medicoes = [];   // { tipo: "texto"|"controle"|"foco", ... }

// ---------- avaliador in-page (serializado por page.evaluate) ----------
function medirPagina() {
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const razao = (c1, c2) => {
    const l1 = lum(c1), l2 = lum(c2);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  };
  const sobre = (cima, baixo) => [
    cima[0] * cima[3] + baixo[0] * (1 - cima[3]),
    cima[1] * cima[3] + baixo[1] * (1 - cima[3]),
    cima[2] * cima[3] + baixo[2] * (1 - cima[3]),
    Math.min(1, cima[3] + baixo[3] * (1 - cima[3])),
  ];
  const sel = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return (el.tagName.toLowerCase() + id + cls).slice(0, 60);
  };
  const visivel = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    if (el.closest("[hidden], [aria-hidden='true'], script, style, noscript, template")) return false;
    try { if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false; } catch { }
    return true;
  };
  const desabilitado = (el) => !!(
    el.disabled || el.getAttribute("aria-disabled") === "true" ||
    el.closest("[disabled], [aria-disabled='true']")
  );
  const grande = (cs) => {
    const px = parseFloat(cs.fontSize) || 16;
    const w = parseInt(cs.fontWeight, 10) || 400;
    return px >= 24 || (px >= 18.66 && w >= 700);
  };
  // Divide camadas de background-image respeitando parênteses.
  const splitCamadas = (s) => {
    const out = []; let prof = 0, ini = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") prof++;
      else if (ch === ")") prof--;
      else if (ch === "," && prof === 0) { out.push(s.slice(ini, i).trim()); ini = i + 1; }
    }
    out.push(s.slice(ini).trim());
    return out.filter(Boolean);
  };
  // Cor de parada de gradiente: rgb()/rgba()/hex/transparent.
  const parseCorToken = (s) => {
    const t = (s || "").trim().toLowerCase();
    if (t === "transparent") return [0, 0, 0, 0];
    const m = /rgba?\(([^)]+)\)/.exec(t);
    if (m) {
      const p = m[1].split(",").map((x) => parseFloat(x));
      if (p.length < 3 || p.some(Number.isNaN)) return null;
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    const h = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
    if (h) {
      const x = h[1];
      const v = x.length === 3
        ? [0, 1, 2].map((i) => parseInt(x[i] + x[i], 16))
        : [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
      const a = x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1;
      return [...v, a];
    }
    return null;
  };
  // Extrai paradas (cor + posição) de uma camada gradient(...).
  // Posições em px/em são ignoradas (sequenciais) — suficiente porque a
  // amostragem cobre o espaço paramétrico de cada segmento.
  const paradasDaCamada = (camada) => {
    const ini = camada.indexOf("(");
    if (ini < 0) return [];
    const inner = camada.slice(ini + 1, camada.lastIndexOf(")") > ini ? camada.lastIndexOf(")") : undefined);
    const partes = splitCamadas(inner);
    const paradas = [];
    for (const parte of partes) {
      const cm = /(rgba?\([^()]*\)|#[0-9a-fA-F]{3,8}\b|transparent)/i.exec(parte);
      if (!cm) continue; // color hint — ignorado (raro; não usado no tema)
      const cor = parseCorToken(cm[1]);
      if (!cor) continue;
      paradas.push({ cor });
    }
    return paradas;
  };
  // Amostra o interior do gradiente: 9 pontos por segmento (inclui
  // paradas). Necessário porque a razão de contraste é não-linear na
  // luminância — se a luminância do texto/borda ficar ENTRE as das
  // paradas, o mínimo real ocorre dentro do segmento, não nas pontas.
  const amostrarGradiente = (camadaStr, abaixo, origem) => {
    const paradas = paradasDaCamada(camadaStr);
    if (!paradas.length) return [];
    const out = [];
    const AMOSTRAS = 8;
    const emitir = (cor) => {
      const comp = cor[3] < 1 ? sobre(cor, abaixo) : cor;
      out.push({
        cor: comp.slice(0, 3).map((v) => Math.round(v)),
        origem, tipo: camadaStr.slice(0, 22), alpha: +cor[3].toFixed(2),
      });
    };
    if (paradas.length === 1) { emitir(paradas[0].cor); return out; }
    for (let i = 0; i < paradas.length - 1; i++) {
      const c0 = paradas[i].cor, c1 = paradas[i + 1].cor;
      for (let k = 0; k <= AMOSTRAS; k++) {
        const t = k / AMOSTRAS;
        emitir([0, 1, 2, 3].map((j) => c0[j] + (c1[j] - c0[j]) * t));
      }
    }
    return out;
  };

  // Fundo efetivo subindo a cadeia (partindo de `inicio`): cores e
  // gradientes até cor opaca. Retorna { tipo:"gradiente", camadas,
  // abaixo } | { tipo:"solido", rgb } | { tipo:"imagem", detalhe }.
  const fundoEfetivo = (inicio) => {
    const camadas = [];
    let cur = inicio, achouOpaco = false;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      const temImg = cs.backgroundImage && cs.backgroundImage !== "none";
      const bg = parse(cs.backgroundColor);
      if (temImg) {
        const imgs = splitCamadas(cs.backgroundImage);
        const grads = [], outras = [];
        for (const img of imgs) (/gradient\(/.test(img) ? grads : outras).push(img);
        if (outras.length) return { tipo: "imagem", el: cur, detalhe: outras[0].slice(0, 80) };
        if (grads.length) camadas.push({ el: cur, tipo: "gradiente", camadas: grads });
      }
      if (bg) {
        camadas.push({ el: cur, tipo: "cor", cor: bg });
        if (bg[3] === 1) { achouOpaco = true; break; }
      }
      cur = cur.parentElement;
    }
    if (!camadas.some((c) => c.tipo === "gradiente")) {
      let acc = [255, 255, 255, 1];
      const cores = camadas.filter((c) => c.tipo === "cor").map((c) => c.cor).reverse();
      for (const c of cores) acc = sobre(c, acc);
      return { tipo: "solido", rgb: acc.slice(0, 3) };
    }
    const idxUlt = camadas.map((c, i) => c.tipo === "gradiente" ? i : -1).filter((i) => i >= 0).pop();
    let abaixo = [255, 255, 255, 1];
    for (const c of camadas.slice(idxUlt + 1).reverse()) {
      if (c.tipo === "cor") abaixo = sobre(c.cor, abaixo);
    }
    return { tipo: "gradiente", camadas, abaixo };
  };

  // Cores candidatas do fundo (todas as paradas de todos os gradientes,
  // compostas sobre o que está abaixo; cores sólidas entram como estão).
  const candidatosDeFundo = (fundo) => {
    if (fundo.tipo === "solido") return [{ cor: fundo.rgb, origem: "solido", tipo: "cor" }];
    if (fundo.tipo !== "gradiente") return [];
    const out = [];
    for (const camada of fundo.camadas) {
      if (camada.tipo === "cor") {
        out.push({ cor: camada.cor.slice(0, 3).map((v) => Math.round(v)), origem: sel(camada.el), tipo: "cor" });
      } else {
        for (const img of camada.camadas) {
          out.push(...amostrarGradiente(img, fundo.abaixo, sel(camada.el)));
        }
      }
    }
    return out;
  };

  const textos = [];
  const controles = [];
  const todos = [...document.querySelectorAll("body *")].filter(visivel);

  // --- textos (SC 1.4.3) — mesmo recorte do auditor ---
  for (const el of todos) {
    if (el.closest("svg")) continue;
    if (desabilitado(el)) continue;
    const temTexto = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!temTexto) continue;
    const cs = getComputedStyle(el);
    const fg0 = parse(cs.color);
    if (!fg0) continue;
    const fundo = fundoEfetivo(el);
    if (fundo.tipo === "solido") continue;
    if (fundo.tipo === "imagem") {
      textos.push({ sel: sel(el), fg: fg0.slice(0, 3), fundo: "imagem-real", detalhe: fundo.detalhe });
      continue;
    }
    const candidatos = candidatosDeFundo(fundo);
    const comCor = candidatos.filter((c) => Array.isArray(c.cor));
    if (!comCor.length) { textos.push({ sel: sel(el), fg: fg0.slice(0, 3), fundo: "gradiente-sem-cor" }); continue; }
    const limiar = grande(cs) ? 3.0 : 4.5;
    let pior = Infinity, melhor = 0;
    const razoes = comCor.map((cand) => {
      const fg = fg0[3] < 1 ? sobre(fg0, [...cand.cor, 1]) : fg0;
      const r = razao(fg.slice(0, 3), cand.cor);
      if (r < pior) pior = r;
      if (r > melhor) melhor = r;
      return { ...cand, razao: +r.toFixed(2) };
    });
    textos.push({
      sel: sel(el), fg: fg0.slice(0, 3).map((v) => Math.round(v)),
      fontePx: cs.fontSize, peso: cs.fontWeight,
      limiar, pior: +pior.toFixed(2), melhor: +melhor.toFixed(2),
      veredito: pior >= limiar ? "computado-PASS" : "computado-FAIL",
      fundos: [...new Set(candidatos.map((c) => c.origem))],
      amostra: razoes.slice(0, 4),
      nCores: comCor.length,
    });
  }

  // --- controles (SC 1.4.11) — campos input/select/textarea visíveis ---
  for (const el of todos) {
    const tag = el.tagName.toLowerCase();
    if (!["input", "select", "textarea"].includes(tag)) continue;
    if ((el.getAttribute("type") || "").toLowerCase() === "hidden") continue;
    if (desabilitado(el)) continue;
    const cs = getComputedStyle(el);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const bs = cs.borderTopStyle;
    const temBorda = bw >= 1 && bs !== "none" && bs !== "hidden";
    const bgProprio = parse(cs.backgroundColor);
    const temProprio = !!(bgProprio && bgProprio[3] > 0);
    // contexto auxiliar p/ disposição humana (não decide nada)
    const labels = el.labels ? [...el.labels] : [];
    const contexto = {
      tipo: tag === "input" ? (el.getAttribute("type") || "text") : tag,
      labels: labels.filter(visivel).length,
      labelTexto: labels.map((l) => (l.innerText || l.textContent || "").trim().slice(0, 30)).filter(Boolean).slice(0, 2),
      placeholder: !!(el.placeholder && !(el.value || "")),
    };
    const ext = fundoEfetivo(el.parentElement || el);
    if (ext.tipo === "imagem") {
      controles.push({ sel: sel(el), fundo: "imagem-real", detalhe: ext.detalhe, contexto });
      continue;
    }
    const externos = candidatosDeFundo(ext).filter((c) => Array.isArray(c.cor));
    if (!externos.length) { controles.push({ sel: sel(el), fundo: "gradiente-sem-cor", contexto }); continue; }
    const gradiente = ext.tipo === "gradiente";
    // preenchimento e borda compostos sobre CADA cor externa candidata
    const fillComps = [], bordaComps = [];
    for (const e of externos) {
      const e4 = [...e.cor, 1];
      if (temProprio) {
        const f = bgProprio[3] < 1 ? sobre(bgProprio, e4) : bgProprio;
        fillComps.push(razao(f.slice(0, 3), e.cor));
      }
      if (temBorda) {
        const bc = parse(cs.borderTopColor);
        if (bc && bc[3] > 0) {
          const b = bc[3] < 1 ? sobre(bc, e4) : bc;
          bordaComps.push(razao(b.slice(0, 3), e.cor));
        }
      }
    }
    const fmt = (arr) => (arr.length ? +Math.min(...arr).toFixed(2) : null);
    const fillMin = fmt(fillComps), bordaMin = fmt(bordaComps);
    // identificabilidade por parada externa: melhor entre fill/borda;
    // veredito = PIOR desses melhores (robusto a qualquer pixel do gradiente)
    let piorMelhor = Infinity;
    for (let i = 0; i < externos.length; i++) {
      const ops = [];
      if (fillComps.length) ops.push(fillComps[i]);
      if (bordaComps.length) ops.push(bordaComps[i]);
      if (ops.length) piorMelhor = Math.min(piorMelhor, Math.max(...ops));
    }
    if (!isFinite(piorMelhor)) piorMelhor = null;
    controles.push({
      sel: sel(el), tag, gradiente,
      temProprio, temBorda,
      fillMin, bordaMin,
      piorCaso: piorMelhor === null ? null : +piorMelhor.toFixed(2),
      veredito: piorMelhor === null ? "sem-indicador" : (piorMelhor >= 3 ? "computado-PASS" : "abaixo-3:1"),
      nExternos: externos.length,
      contexto,
    });
  }

  return { textos, controles };
}

// Indicador de foco vs gradiente externo (os 2 REVIEWs de foco da suíte).
function medirFocoGradiente() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || "");
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    if (p.length < 3 || p.some(Number.isNaN)) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const razao = (c1, c2) => {
    const l1 = lum(c1), l2 = lum(c2);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  };
  const sobre = (cima, baixo) => [
    cima[0] * cima[3] + baixo[0] * (1 - cima[3]),
    cima[1] * cima[3] + baixo[1] * (1 - cima[3]),
    cima[2] * cima[3] + baixo[2] * (1 - cima[3]),
  ];
  const sel = (e) => {
    const id = e.id ? "#" + e.id : "";
    const cls = typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/)[0] : "";
    return (e.tagName.toLowerCase() + id + cls).slice(0, 60);
  };
  const splitCamadas = (s) => {
    const out = []; let prof = 0, ini = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") prof++;
      else if (ch === ")") prof--;
      else if (ch === "," && prof === 0) { out.push(s.slice(ini, i).trim()); ini = i + 1; }
    }
    out.push(s.slice(ini).trim());
    return out.filter(Boolean);
  };
  const parseCorToken = (s) => {
    const t = (s || "").trim().toLowerCase();
    if (t === "transparent") return [0, 0, 0, 0];
    const m = /rgba?\(([^)]+)\)/.exec(t);
    if (m) {
      const p = m[1].split(",").map((x) => parseFloat(x));
      if (p.length < 3 || p.some(Number.isNaN)) return null;
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    const h = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
    if (h) {
      const x = h[1];
      const v = x.length === 3
        ? [0, 1, 2].map((i) => parseInt(x[i] + x[i], 16))
        : [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
      const a = x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1;
      return [...v, a];
    }
    return null;
  };
  const paradasDaCamada = (camada) => {
    const ini = camada.indexOf("(");
    if (ini < 0) return [];
    const fim = camada.lastIndexOf(")");
    const inner = camada.slice(ini + 1, fim > ini ? fim : undefined);
    const paradas = [];
    for (const parte of splitCamadas(inner)) {
      const cm = /(rgba?\([^()]*\)|#[0-9a-fA-F]{3,8}\b|transparent)/i.exec(parte);
      if (!cm) continue;
      const cor = parseCorToken(cm[1]);
      if (cor) paradas.push({ cor });
    }
    return paradas;
  };
  // Amostra o interior do gradiente (9 pontos por segmento) — a razão
  // de contraste é não-linear na luminância; o mínimo pode ocorrer
  // dentro do segmento quando a luminância do texto fica entre as paradas.
  const amostrarGradiente = (camadaStr, abaixo, origem) => {
    const paradas = paradasDaCamada(camadaStr);
    const out = [];
    const emitir = (cor) => {
      const comp = cor[3] < 1 ? sobre(cor, [...abaixo, 1]) : cor.slice(0, 3);
      out.push(comp.slice(0, 3).map((v) => Math.round(v)));
    };
    if (paradas.length === 1) { emitir(paradas[0].cor); return out; }
    for (let i = 0; i < paradas.length - 1; i++) {
      const c0 = paradas[i].cor, c1 = paradas[i + 1].cor;
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        emitir([0, 1, 2, 3].map((j) => c0[j] + (c1[j] - c0[j]) * t));
      }
    }
    return out;
  };
  // fundo externo (a partir do pai) — mesma lógica do fundoEfetivo
  const camadas = [];
  let cur = el.parentElement, viuImg = false;
  while (cur && cur.nodeType === 1) {
    const cs = getComputedStyle(cur);
    const temImg = cs.backgroundImage && cs.backgroundImage !== "none";
    const bg = parse(cs.backgroundColor);
    if (temImg) {
      const imgs = splitCamadas(cs.backgroundImage);
      const grads = imgs.filter((i) => /gradient\(/.test(i));
      const outras = imgs.filter((i) => !/gradient\(/.test(i));
      if (outras.length) return { sel: sel(el), resultado: "imagem-real" };
      if (grads.length) camadas.push({ tipo: "gradiente", camadas: grads, el: cur });
    }
    if (bg) { camadas.push({ tipo: "cor", cor: bg }); if (bg[3] === 1) break; }
    cur = cur.parentElement;
  }
  const idxUlt = camadas.map((c, i) => c.tipo === "gradiente" ? i : -1).filter((i) => i >= 0).pop();
  if (idxUlt === undefined) {
    let acc = [255, 255, 255];
    for (const c of camadas.filter((x) => x.tipo === "cor").map((x) => x.cor).reverse()) {
      acc = sobre(c, [...acc, 1]);
    }
    return { sel: sel(el), resultado: "solido", rgb: acc.slice(0, 3) };
  }
  let abaixo = [255, 255, 255];
  for (const c of camadas.slice(idxUlt + 1).reverse()) {
    if (c.tipo === "cor") abaixo = sobre(c.cor, [...abaixo, 1]);
  }
  const externos = [];
  for (const camada of camadas) {
    if (camada.tipo === "cor") externos.push(camada.cor.slice(0, 3).map((v) => Math.round(v)));
    else for (const img of camada.camadas) {
      externos.push(...amostrarGradiente(img, abaixo, sel(camada.el)));
    }
  }
  // cor do indicador: outline ou box-shadow única (mesma regra do auditor)
  const cs = getComputedStyle(el);
  const ow = parseFloat(cs.outlineWidth) || 0;
  let cor = null, tipoInd = null;
  if (cs.outlineStyle !== "none" && ow >= 1) {
    const oc = parse(cs.outlineColor);
    if (oc && oc[3] > 0) { cor = oc.slice(0, 3); tipoInd = `outline ${ow}px`; }
  }
  if (!cor) {
    const bs = cs.boxShadow;
    if (bs && bs !== "none") {
      const cores = [...bs.matchAll(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g)]
        .map((m) => parse(m[0])).filter((c) => c && c[3] > 0);
      if (cores.length === 1) { cor = cores[0].slice(0, 3); tipoInd = "box-shadow"; }
      else if (cores.length > 1) return { sel: sel(el), resultado: "multiplo", n: cores.length };
    }
  }
  if (!cor) return { sel: sel(el), resultado: "sem-indicador" };
  const razoes = externos.map((e) => +razao(cor, e).toFixed(2));
  const pior = Math.min(...razoes);
  return {
    sel: sel(el), resultado: "medido", indicador: tipoInd,
    fg: cor.map((v) => Math.round(v)), pior: +pior.toFixed(2),
    veredito: pior >= 3 ? "computado-PASS" : "abaixo-3:1",
    nExternos: externos.length,
  };
}

// ---------- helpers de navegação (idênticos à suíte) ----------
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

async function medir(page, pagina, viewport) {
  try {
    const r = await page.evaluate(medirPagina);
    for (const m of r.textos) medicoes.push({ tipo: "texto", pagina, viewport, ...m });
    for (const m of r.controles) medicoes.push({ tipo: "controle", pagina, viewport, ...m });
  } catch (e) {
    medicoes.push({ tipo: "erro", pagina, viewport, sel: "(erro)", fundo: "erro-avaliador", detalhe: String(e?.message ?? e).slice(0, 160) });
  }
}

async function medirFoco(page, pagina, viewport) {
  try {
    const r = await page.evaluate(medirFocoGradiente);
    if (r) medicoes.push({ tipo: "foco", pagina, viewport, ...r });
    else medicoes.push({ tipo: "foco", pagina, viewport, resultado: "sem-foco", detalhe: await page.evaluate(() => document.activeElement ? document.activeElement.tagName + "." + String(document.activeElement.className).slice(0, 40) : "null") });
  } catch (e) {
    medicoes.push({ tipo: "erro", pagina, viewport, sel: "(erro)", fundo: "erro-avaliador-foco", detalhe: String(e?.message ?? e).slice(0, 160) });
  }
}

// ---------- geração do markdown ----------
function gerarMarkdown() {
  const L = [];
  L.push("# WCAG — contraste medido sobre gradientes (evidência p/ disposição)");
  L.push("");
  L.push("Complemento de `WCAG-REVIEW-1.0.9.md` (item 4, PR #318). As entradas de" +
    " REVIEW por `bg-image` foram re-medidas com um avaliador que resolve" +
    " `linear-gradient`/`radial-gradient` do computed style: cada parada de cor" +
    " é composta sobre o fundo efetivo abaixo dela (incluindo alpha). Mesma" +
    " fixture, servidor real, telas e viewports da suíte" +
    " `teste-a11y-fluxos-297.mjs`.");
  L.push("");
  L.push("**Isto é evidência, não disposição.** O gate humano continua pendente;");
  L.push("`computado-PASS`/`abaixo-3:1` são medições objetivas para acelerar");
  L.push("a revisão — não alteram o status REVIEW original.");
  L.push("");

  const textos = medicoes.filter((m) => m.tipo === "texto" && m.veredito);
  const controles = medicoes.filter((m) => m.tipo === "controle");
  const focos = medicoes.filter((m) => m.tipo === "foco");
  const erros = medicoes.filter((m) => m.tipo === "erro");

  // ===== TEXTOS =====
  const tPass = textos.filter((m) => m.veredito === "computado-PASS");
  const tFail = textos.filter((m) => m.veredito === "computado-FAIL");
  const tOutros = textos.filter((m) => !m.veredito);
  L.push("## 1. Texto sobre gradiente (SC 1.4.3)");
  L.push("");
  L.push(`**${textos.length} elementos medidos — ${tPass.length} computado-PASS,` +
    ` ${tFail.length} computado-FAIL**${tOutros.length ? `, ${tOutros.length} não mensuráveis` : ""}.`);
  L.push("");
  const grupos = new Map();
  for (const m of textos.filter((x) => x.veredito)) {
    const k = `${m.pagina} | ${m.viewport}`;
    if (!grupos.has(k)) grupos.set(k, { p: 0, f: 0, min: Infinity });
    const g = grupos.get(k);
    if (m.veredito === "computado-PASS") g.p++; else g.f++;
    g.min = Math.min(g.min, m.pior);
  }
  L.push("| tela / fluxo | viewport | elementos | PASS | FAIL | pior razão |");
  L.push("|---|---|---|---|---|---|");
  for (const [k, g] of grupos) {
    const [pagina, viewport] = k.split(" | ");
    L.push(`| ${pagina} | ${viewport} | ${g.p + g.f} | ${g.p} | ${g.f} | ${g.min.toFixed(2)}:1 |`);
  }
  L.push("");
  if (tFail.length) {
    L.push("### computed-FAIL (texto)");
    L.push("");
    L.push("| tela | viewport | elemento | fg | limiar | pior razão | amostra |");
    L.push("|---|---|---|---|---|---|---|");
    for (const m of tFail.slice(0, 100)) {
      const amostra = (m.amostra || []).slice(0, 3).map((a) => `${a.tipo} ${a.cor}→${a.razao}`).join("; ");
      L.push(`| ${m.pagina} | ${m.viewport} | \`${m.sel}\` | rgb(${m.fg}) | ${m.limiar}:1 | ${m.pior}:1 | ${amostra.replace(/\|/g, "\\|")} |`);
    }
    L.push("");
  }
  const porPadrao = new Map();
  for (const m of tPass) {
    const k = `${(m.fundos || []).join(",")}|rgb(${m.fg})|${m.limiar}`;
    if (!porPadrao.has(k)) porPadrao.set(k, { n: 0, min: Infinity, max: 0, exemplos: [] });
    const p = porPadrao.get(k);
    p.n++; p.min = Math.min(p.min, m.pior); p.max = Math.max(p.max, m.pior);
    if (p.exemplos.length < 3 && !p.exemplos.includes(`${m.pagina}/${m.viewport}/${m.sel}`)) {
      p.exemplos.push(`${m.pagina}/${m.viewport}/\`${m.sel}\``);
    }
  }
  L.push("### Padrões computado-PASS (deduplicados por fundo+cor de texto)");
  L.push("");
  L.push("| fundo(s) | cor do texto | limiar | n | pior | melhor | exemplos |");
  L.push("|---|---|---|---|---|---|---|");
  for (const [k, p] of [...porPadrao.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const [fundos, fg, limiar] = k.split("|");
    L.push(`| ${fundos.replace(/\|/g, ", ")} | ${fg} | ${limiar}:1 | ${p.n} | ${p.min.toFixed(2)}:1 | ${p.max.toFixed(2)}:1 | ${p.exemplos.join("; ").replace(/\|/g, "\\|")} |`);
  }
  L.push("");

  // ===== CONTROLES =====
  L.push("## 2. Controles input/select/textarea — fronteira×externo (SC 1.4.11)");
  L.push("");
  const cGrad = controles.filter((m) => m.gradiente === true);
  const cSol = controles.filter((m) => m.gradiente === false);
  const cPass = cGrad.filter((m) => m.veredito === "computado-PASS");
  const cAbaixo = cGrad.filter((m) => m.veredito === "abaixo-3:1");
  const cSem = controles.filter((m) => !["computado-PASS", "abaixo-3:1"].includes(m.veredito));
  L.push(`**${controles.length} campos medidos:** ${cGrad.length} com externo em gradiente` +
    ` (${cPass.length} computado-PASS, ${cAbaixo.length} abaixo-3:1)` +
    ` + ${cSol.length} com externo sólido (quocientes do auditor reproduzidos p/ contexto).`);
  L.push("");
  if (cAbaixo.length) {
    L.push("### Controles sobre gradiente abaixo de 3:1 (pior caso)");
    L.push("");
    L.push("| tela | viewport | campo | tipo | fillMin | bordaMin | piorCaso | contexto |");
    L.push("|---|---|---|---|---|---|---|---|");
    for (const m of cAbaixo.slice(0, 120)) {
      const cx = m.contexto || {};
      const ctx = [cx.tipo, cx.labels ? `${cx.labels} label(is)` : "", cx.placeholder ? "placeholder" : "", (cx.labelTexto || []).join("/")].filter(Boolean).join(" · ");
      L.push(`| ${m.pagina} | ${m.viewport} | \`${m.sel}\` | ${m.tag} | ${m.fillMin ?? "—"} | ${m.bordaMin ?? "—"} | ${m.piorCaso} | ${ctx.replace(/\|/g, "\\|")} |`);
    }
    if (cAbaixo.length > 120) L.push(`| … | | | | | | | +${cAbaixo.length - 120} |`);
    L.push("");
  }
  if (cSol.length) {
    L.push("### Controles com externo sólido — quocientes reproduzidos (contexto p/ disposição)");
    L.push("");
    L.push("São as entradas 'fronteira ambígua' da lista REVIEW: o auditor já tinha" +
      " os quocientes; aqui ficam deduplicadas por (campo, fillMin, bordaMin) com" +
      " o contexto de labels para a decisão humana.");
    L.push("");
    const dedup = new Map();
    for (const m of cSol) {
      const k = `${m.sel}|${m.fillMin}|${m.bordaMin}`;
      if (!dedup.has(k)) dedup.set(k, { m, n: 0, telas: new Set() });
      const d = dedup.get(k); d.n++; d.telas.add(`${m.pagina}/${m.viewport}`);
    }
    L.push("| campo | fillMin | bordaMin | piorCaso | n amostras | telas | tipo | labels | placeholder |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    for (const { m, n, telas } of dedup.values()) {
      const cx = m.contexto || {};
      L.push(`| \`${m.sel}\` | ${m.fillMin ?? "—"} | ${m.bordaMin ?? "—"} | ${m.piorCaso ?? "—"} | ${n} | ${[...telas].slice(0, 4).join(", ").replace(/\|/g, "\\|")} | ${cx.tipo || "—"} | ${cx.labels || 0} | ${cx.placeholder ? "sim" : "não"} |`);
    }
    L.push("");
  }
  if (cSem.length) {
    L.push("### Controles não classificados");
    L.push("");
    const cont = {};
    for (const m of cSem) cont[m.fundo || m.veredito] = (cont[m.fundo || m.veredito] || 0) + 1;
    for (const [k, n] of Object.entries(cont)) L.push(`- \`${k}\`: ${n}`);
    L.push("");
  }

  // ===== FOCO =====
  L.push("## 3. Indicador de foco × gradiente externo");
  L.push("");
  const fMed = focos.filter((m) => m.resultado === "medido");
  const fOut = focos.filter((m) => m.resultado !== "medido");
  for (const m of fMed) {
    L.push(`- **${m.pagina}** (\`${m.sel}\`, ${m.indicador}): pior contraste vs gradiente externo = **${m.pior}:1** → ${m.veredito} (limiar 3:1).`);
  }
  for (const m of fOut) {
    L.push(`- **${m.pagina}** (\`${m.sel}\`): ${m.resultado || m.tipo}${m.n ? ` (${m.n} cores)` : ""} — não mensurável por este avaliador.`);
  }
  if (!focos.length) L.push("- nenhuma medição de foco executada.");
  L.push("");

  if (tOutros.length) {
    L.push("## Texto não mensurável");
    L.push("");
    const cont = {};
    for (const m of tOutros) cont[m.fundo] = (cont[m.fundo] || 0) + 1;
    for (const [k, n] of Object.entries(cont)) L.push(`- \`${k}\`: ${n}`);
    L.push("");
  }
  if (erros.length) {
    L.push("## Erros do avaliador");
    L.push("");
    for (const e of erros) L.push(`- ${e.pagina} / ${e.viewport} / ${e.tipo}: ${e.detalhe || e.fundo}`);
    L.push("");
  }

  L.push("## Notas metodológicas");
  L.push("");
  L.push("- O pior contraste é o mínimo sobre uma AMOSTRAGEM do gradiente" +
    " (9 pontos por segmento, interpolação sRGB entre paradas) — necessário" +
    " porque a razão de contraste é não-linear na luminância: quando a" +
    " luminância do texto/borda fica entre as das paradas, o mínimo real" +
    " ocorre dentro do segmento, não nas extremidades.");
  L.push("- Paradas com alpha < 1 foram compostas sobre o fundo efetivo abaixo" +
    " do gradiente (mesma composição `sobre()` do auditor).");
  L.push("- Texto: limiar 4.5:1 normal, 3.0:1 grande (≥24px ou ≥18.66px negrito)" +
    " — idêntico ao `grande()` de `wcag-avaliador-297.mjs`.");
  L.push("- Controles (1.4.11): por parada de gradiente externa, usa-se o MELHOR" +
    " identificador (preenchimento×externo ou borda×externo ≥3:1); o veredito" +
    " final é o PIOR desses melhores — ou seja, PASS só se a fronteira for" +
    " identificável em qualquer pixel do gradiente.");
  L.push("- `abaixo-3:1` não é violação confirmada: a SC 1.4.11 admite contexto" +
    " adjacente (label visível) como alternativa à fronteira — a decisão é humana.");
  L.push("- Entradas 'select: affordance nativa do UA' e 'stepper nativo' envolvem" +
    " renderização do user-agent não mensurável via DOM — permanecem para" +
    " disposição humana mesmo com quocientes calculados.");
  L.push("");

  L.push("## 4. Análise de correção de borda (opcional — insumo p/ decisão)");
  L.push("");
  L.push("Cálculo offline (mesma fórmula WCAG) das cores de borda candidatas do" +
    " próprio tema contra o conjunto de superfícies escuras onde os campos" +
    " aparecem (paradas dos gradientes `.cartao`/`.ficha-secao`/body/html," +
    " todas entre ~#0b0a0f e ~#211b26). Borda com alpha é composta sobre" +
    " cada externo antes do quociente — reproduz os ~1.3:1 medidos:");
  L.push("");
  L.push("| cor de borda candidata | contraste vs superfícies (min–max) | atinge 3:1? |");
  L.push("|---|---|---|");
  L.push("| atual `rgba(154,130,145,.20–.24)` | 1.27–1.42:1 | não |");
  L.push("| `--horror-borda` `rgba(154,111,125,.24)` | 1.29–1.34:1 | não |");
  L.push("| `--horror-borda-forte` `rgba(177,91,105,.48)` | 1.81–1.84:1 | não |");
  L.push("| `--horror-vinho` `#8d3d4b` | 2.32–2.73:1 | não |");
  L.push("| **`--horror-vinho-claro` `#b85c69`** (já usado em foco/acentos) | **3.82–4.48:1** | **sim** |");
  L.push("| `--horror-ambar` `#b99a62` | 6.29–7.38:1 | sim |");
  L.push("| `--horror-texto-suave` `#b4a9b1` | 7.40–8.69:1 | sim |");
  L.push("| neutro `#5a6272` (sugestão intermediária) | 2.74–3.22:1 | **não uniforme** — falha nas superfícies mais escuras |");
  L.push("| neutro `#6a7285` | 3.49–4.09:1 | sim |");
  L.push("| neutro `#8a93a8` | 5.46–6.41:1 | sim |");
  L.push("");
  L.push("Se a disposição humana decidir reforçar a fronteira dos campos, basta" +
    " apontar `border-color` de `input`/`select`/`textarea` para" +
    " `--horror-vinho-claro` (ou um tom intermediário entre vinho e âmbar) —" +
    " uma alteração de tema de uma linha, sem tocar markup/JS; se preferir tom neutro, `#6a7285` também atinge 3:1 em todas as superfícies (`#5a6272` NÃO — ver tabela). Alternativa" +
    " sem mudança visual: aceitar a identificação por label/contexto adjacente," +
    " prevista na própria SC 1.4.11. **Ambas as saídas dependem de decisão" +
    " humana — este documento só quantifica o custo de cada uma.**");
  L.push("");
  return L.join("\n");
}

// ---------- execução ----------
let browser, proc;
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO);

  if (cenario.personagemMestre) {
    for (const [type, name] of [["especie", "Carteira Teste"], ["banco", "Banco Teste"]]) {
      await req(BASE, "POST", `/characters/${cenario.personagemMestre}/financeiro/contas`, {
        cookie: cenario.cookieMestre,
        body: { type, name, balanceReais: 0 },
      });
    }
  }
  if (cenario.campId) {
    await req(BASE, "POST", `/campaigns/${cenario.campId}/regras/seed`, {
      cookie: cenario.cookieMestre, body: {},
    });
    const mod = await req(BASE, "POST", `/campaigns/${cenario.campId}/sheet-templates`, {
      cookie: cenario.cookieMestre, body: { name: "Ficha A11y Ajuda" },
    });
    const tid = mod.json?.modelo?.id, vid = mod.json?.modelo?.versionId;
    const estrutura = {
      versao: 1,
      secoes: [{ id: "s1", titulo: "Equipamento", ordem: 0, campos: [
        { id: "f-itens", label: "Itens", tipo: "selecao_multipla", regraKind: "item" },
      ] }],
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    };
    await req(BASE, "PUT", `/campaigns/${cenario.campId}/sheet-templates/${tid}/versions/${vid}`, {
      cookie: cenario.cookieMestre, body: { estrutura },
    });
    await req(BASE, "POST", `/campaigns/${cenario.campId}/sheet-templates/${tid}/publish`, {
      cookie: cenario.cookieMestre, body: { versionId: vid },
    });
    await req(BASE, "POST", `/campaigns/${cenario.campId}/characters`, {
      cookie: cenario.cookieMestre, body: { name: "A11y Ajuda Pop", templateVersionId: vid },
    });
  }

  browser = await chromium.launch();

  for (const vp of VIEWPORTS) {
    console.log(`\n== viewport ${vp.nome} (mestre) ==`);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();

    await login(page, "mestre_teste", "senha-forte-123");
    await medir(page, "login→painel", vp.nome);

    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    await medir(page, "campanha (visão geral)", vp.nome);

    for (const nomeAba of ["Personagens", "Diário", "Arquivos", "Convites"]) {
      const tem = await page.locator(".abas button", { hasText: nomeAba }).count();
      if (!tem) continue;
      await aba(page, nomeAba);
      await page.waitForTimeout(400);
      await medir(page, `aba ${nomeAba}`, vp.nome);
    }

    await aba(page, "Personagens");
    await page.waitForTimeout(500);
    const linha = page.locator("tr.clicavel", { hasText: "Mestre Herói" }).first();
    if (await linha.count()) {
      await linha.click();
      await page.waitForTimeout(500);
      await medir(page, "ficha detalhe", vp.nome);
      for (const sub of ["Inventário", "Dinheiro"]) {
        const b = page.getByRole("button", { name: sub, exact: true });
        if (await b.count()) {
          await b.first().click();
          await page.waitForTimeout(300);
          await medir(page, `patrimônio ${sub}`, vp.nome);
        }
      }
      const voltar = page.getByRole("button", { name: "Voltar" }).last();
      if (await voltar.count()) await voltar.click().catch(() => {});
      await page.waitForSelector(".abas", { timeout: 10000 }).catch(() => {});
    }

    await aba(page, "Mesa");
    await page.waitForTimeout(600);
    await medir(page, "aba Mesa", vp.nome);

    await ctx.close();
  }

  for (const vp of [
    { nome: "desktop-1366", width: 1366, height: 768 },
    { nome: "celular-390", width: 390, height: 844 },
    { nome: "tablet-768", width: 768, height: 1024 },
  ]) {
    console.log(`\n== viewport ${vp.nome} (jogador) ==`);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    await login(page, "jogador_um", "senha-jogador-123");
    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    await medir(page, "jogador: campanha", vp.nome);
    await aba(page, "Personagens");
    await page.waitForTimeout(500);
    await medir(page, "jogador: personagens", vp.nome);
    await ctx.close();
  }

  // ---------- foco (paridade com a suíte: só desktop, Tab real) ----------
  console.log("\n== desktop-1366 (foco) ==");
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForLoadState("networkidle").catch(() => {});
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return { rotulo: (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().slice(0, 40) };
      });
      if (info && /Entrar/.test(info.rotulo)) break;
    }
    await medirFoco(page, "login (foco)", "desktop-1366");

    await login(page, "mestre_teste", "senha-forte-123");
    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    await medirFoco(page, "campanha (foco)", "desktop-1366");
    await ctx.close();
  } catch (e) {
    medicoes.push({ tipo: "erro", pagina: "foco", viewport: "desktop-1366", sel: "(bloco)", fundo: "erro-bloco-foco", detalhe: String(e?.message ?? e).slice(0, 200) });
  }

  await browser.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}

const tOk = medicoes.filter((m) => m.tipo === "texto" && m.veredito === "computado-PASS").length;
const tFail = medicoes.filter((m) => m.tipo === "texto" && m.veredito === "computado-FAIL").length;
const cPass = medicoes.filter((m) => m.tipo === "controle" && m.veredito === "computado-PASS").length;
const cAbaixo = medicoes.filter((m) => m.tipo === "controle" && m.veredito === "abaixo-3:1").length;
console.log(`\n==== texto: ${tOk} PASS / ${tFail} FAIL | controles: ${cPass} PASS / ${cAbaixo} abaixo-3:1 | foco: ${medicoes.filter((m) => m.tipo === "foco").length} ==== `);

const outPath = join(REPO, "docs", "WCAG-CONTRASTE-GRADIENTES-1.0.9.md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, gerarMarkdown(), "utf8");
console.log(`doc gerado: ${outPath}`);
