// Avaliador WCAG 2.2 AA autocontido — compartilhado entre a suíte de
// fluxos (#297) e as fixtures unitárias DOM. Executado via page.evaluate:
// cada função exportada é autocontida (helpers internos), pois o Playwright
// serializa apenas o fonte da função, sem o fechamento do módulo.
//
// Metodologia (revisão normativa #7104140993):
// - SC 1.4.11: classifica QUAL indicador identifica o controle
//   (conteúdo visível / preenchimento / fronteira) e mede contra o
//   adjacente aplicável — nunca "o maior ratio". Classificação
//   ambígua ⇒ REVIEW com evidência, nunca FAIL/PASS presumido.
// - IMG como identificador exige amostragem real (canvas) ou REVIEW.
// - SC 2.5.8: exceção inline só com disposição inline demonstrada.
// - Foco: alpha composto sobre o adjacente; multi-geometria ⇒ REVIEW.

function avaliarWcag() {
  const parse = (c) => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(c || "");
    if (!m) return null;
    const a = m[4] === undefined ? 1 : (String(m[4]).endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return [+m[1], +m[2], +m[3], a];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const sobre = (fg, bg) => [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    1,
  ];
  const razao = (c1, c2) => {
    const l1 = lum(c1), l2 = lum(c2);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  };
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
  // Fundo efetivo subindo a cadeia; `externo` parte do pai (adjacente fora
  // do componente — exemplo normativo do input). Para no 1º opaco; imagem/
  // gradiente ANTES do opaco ⇒ incalculável ⇒ REVIEW; canvas branco = fundo final.
  const fundoDe = (el, externo = false) => {
    const camadas = [];
    let cur = externo ? el.parentElement : el, img = null, achouOpaco = false;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      if (!img && !achouOpaco && cs.backgroundImage && cs.backgroundImage !== "none") {
        img = `${cur.tagName.toLowerCase()}${cur.id ? "#" + cur.id : ""} bg-image`;
      }
      const bg = parse(cs.backgroundColor);
      if (bg) {
        camadas.push(bg);
        if (bg[3] === 1) { achouOpaco = true; break; }
      }
      cur = cur.parentElement;
    }
    if (img) return { review: img };
    let acc = [255, 255, 255, 1];
    for (const c of camadas.slice().reverse()) acc = sobre(c, acc);
    return { rgb: acc.slice(0, 3) };
  };
  // Texto visível EFETIVO do controle: innerText cobre descendentes (span
  // etc.), mas o valor de campo (input/textarea/select) é conteúdo do
  // campo, não chrome que identifica o controle — não conta.
  const textoEfetivo = (el) => (el.innerText || el.textContent || "").trim();
  const ehCampo = (el) => /^(input|select|textarea)$/.test(el.tagName.toLowerCase());

  // Amostragem conservadora de IMG rasterizado: média dos pixels opacos
  // reduzidos a 32×32 via canvas, comparada ao adjacente. null = não
  // mensurável (CORS/tainted/vazia) ⇒ REVIEW, nunca PASS por existência.
  const medirImg = (img, bgRgb) => {
    try {
      const n = 32;
      const c = document.createElement("canvas");
      c.width = n; c.height = n;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, n, n);
      const d = ctx.getImageData(0, 0, n, n).data;
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 200) { r += d[i]; g += d[i + 1]; b += d[i + 2]; cnt++; }
      }
      if (!cnt) return null;
      return razao([r / cnt, g / cnt, b / cnt], bgRgb);
    } catch { return null; }
  };

  const grande = (cs) => {
    const px = parseFloat(cs.fontSize) || 16;
    const w = parseInt(cs.fontWeight, 10) || 400;
    return px >= 24 || (px >= 18.66 && w >= 700);
  };
  const out = { textos: { viol: [], rev: [] }, naoTexto: { viol: [], rev: [] }, alvos: { viol: [], okEsp: 0 } };
  const todos = [...document.querySelectorAll("body *")].filter(visivel);

  // --- SC 1.4.3: nós de texto visíveis (fora de svg e de inativos) ---
  for (const el of todos) {
    if (el.closest("svg")) continue;
    if (desabilitado(el)) continue;
    const temTexto = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!temTexto) continue;
    const cs = getComputedStyle(el);
    const fg0 = parse(cs.color);
    if (!fg0) continue;
    const bg = fundoDe(el);
    if (bg.review) { out.textos.rev.push(`${sel(el)} (${bg.review})`); continue; }
    const fg = fg0[3] < 1 ? sobre(fg0, [...bg.rgb, 1]) : fg0.slice(0, 3);
    const r = razao(fg, bg.rgb);
    const req = grande(cs) ? 3 : 4.5;
    if (r < req) {
      out.textos.viol.push(`${sel(el)} texto="${(el.textContent || "").trim().slice(0, 30)}" ratio=${r.toFixed(4)} req=${req} fg=rgb(${fg.map(Math.round)}) bg=rgb(${bg.rgb.map(Math.round)})`);
    }
  }

  // --- SC 1.4.11: classificar o indicador que identifica o controle ---
  const ehControle = (el) => {
    const tag = el.tagName.toLowerCase();
    if (/^(button|a|input|select|textarea|summary)$/.test(tag)) return true;
    return ["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option"].includes(el.getAttribute("role"));
  };
  // Identificador visual = texto efetivo (não-campo), svg visível ou
  // IMG mensurável ≥3:1. IMG não mensurável não isenta ⇒ REVIEW à parte.
  const identificadores = (el) => {
    if (!ehCampo(el) && textoEfetivo(el)) return { tipo: "texto", ok: true };
    const svgs = [...el.querySelectorAll("svg")].filter((g) =>
      visivel(g) && !g.closest("[aria-hidden='true'], [role='presentation'], [role='none']"));
    if (svgs.length) return { tipo: "svg", ok: true };
    const imgs = [...el.querySelectorAll("img")].filter((g) =>
      visivel(g) && !g.closest("[aria-hidden='true'], [role='presentation'], [role='none']"));
    if (imgs.length) {
      const bg = fundoDe(el);
      if (bg.review) return { tipo: "img", ok: false, incerto: `adjacente incalculável (${bg.review})` };
      let melhor = 0, incerto = false;
      for (const im of imgs) {
        const r = medirImg(im, bg.rgb);
        if (r === null) { incerto = true; continue; }
        if (r > melhor) melhor = r;
      }
      if (melhor >= 3) return { tipo: "img", ok: true, ratio: melhor };
      if (incerto) return { tipo: "img", ok: false, incerto: "img não mensurável (CORS/vazia)" };
      return { tipo: "img", ok: false, ratio: melhor };
    }
    return { tipo: null, ok: false };
  };
  // Rótulo/contexto visível associado: labels, aria-*, title, placeholder
  // ou <label> ancestral/associado — pode identificar sem fronteira,
  // mas a norma não resolve sozinha ⇒ ambíguo vira REVIEW, não FAIL.
  const temContexto = (el) => {
    if (el.labels && el.labels.length) return true;
    if (el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.getAttribute("title")) return true;
    if (el.placeholder) return true;
    if (el.closest("label")) return true;
    if (el.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && visivel(l)) return true;
      } catch { }
    }
    return false;
  };

  for (const el of todos) {
    if (!ehControle(el) || desabilitado(el)) continue;
    const id = identificadores(el);
    if (id.ok) continue; // conteúdo/ícone/imagem já identifica → fronteira dispensada
    if (id.incerto) {
      out.naoTexto.rev.push(`${sel(el)} identificador ${id.tipo} incerto: ${id.incerto}`);
      continue;
    }
    const cs = getComputedStyle(el);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const bs = cs.borderTopStyle;
    const temBorda = bw >= 1 && bs !== "none" && bs !== "hidden";
    const bgProprio = parse(cs.backgroundColor);
    const temProprio = !!(bgProprio && bgProprio[3] > 0);
    const ext = fundoDe(el, true);
    if (ext.review) {
      out.naoTexto.rev.push(`${sel(el)} adjacente externo incalculável (${ext.review})`);
      continue;
    }
    const extRgb = ext.rgb;
    // Classificação do indicador: preenchimento × externo e fronteira ×
    // externo — cada um contra o SEU adjacente normativo, sem max().
    let fillRatio = null, bordaRatio = null;
    if (temProprio) {
      const prop = bgProprio[3] < 1 ? sobre(bgProprio, [...extRgb, 1]) : bgProprio.slice(0, 3);
      fillRatio = razao(prop, extRgb);
    }
    if (temBorda) {
      const bc = parse(cs.borderTopColor);
      if (bc && bc[3] > 0) {
        const b = bc[3] < 1 ? sobre(bc, [...extRgb, 1]) : bc.slice(0, 3);
        bordaRatio = razao(b, extRgb);
      }
    }
    const fmt = (v) => (v === null ? "ausente" : v.toFixed(4));
    if ((fillRatio !== null && fillRatio >= 3) || (bordaRatio !== null && bordaRatio >= 3)) continue; // PASS
    // Nenhum indicador atinge 3:1 — fronteira é o identificador necessário?
    const ev = `preenchimento×externo=${fmt(fillRatio)} borda×externo=${fmt(bordaRatio)} req=3`;
    if (temContexto(el)) {
      out.naoTexto.rev.push(`${sel(el)} fronteira ambígua (${ev}; contexto/label pode identificar — sem veredito)`);
    } else {
      out.naoTexto.viol.push(`${sel(el)} sem identificador visual: ${ev} ext=rgb(${extRgb.map(Math.round)})`);
    }
  }

  // --- SC 1.4.11: objetos gráficos — filhos do <svg>, não a raiz ---
  for (const svg of todos.filter((e) => e.tagName.toLowerCase() === "svg")) {
    if (svg.getAttribute("aria-hidden") === "true" || ["presentation", "none"].includes(svg.getAttribute("role"))) continue;
    const controlePai = svg.closest("button, a[href], [role='button'], [role='link'], [role='tab']");
    const svgTemNome = !!(svg.getAttribute("aria-label") || svg.querySelector("title"));
    let informativo;
    if (svgTemNome) informativo = true;
    else if (controlePai) {
      // controle só-ícone (sem texto efetivo) → o svg É o identificador;
      // svg acompanhando texto visível (incl. descendentes) → decorativo
      informativo = !ehCampo(controlePai) && !textoEfetivo(controlePai)
        && ![...controlePai.querySelectorAll("img")].some(visivel);
    } else {
      out.naoTexto.rev.push(`${sel(svg)} svg sem nome acessível — decorativo×informativo incerto`);
      continue;
    }
    if (!informativo) continue;
    const bg = fundoDe(svg);
    if (bg.review) { out.naoTexto.rev.push(`${sel(svg)} adjacente incalculável (${bg.review})`); continue; }
    const graf = [...svg.querySelectorAll("path,circle,rect,ellipse,line,polyline,polygon,use,text")].filter(visivel);
    let revSvg = false, violSvg = null;
    for (const g of graf) {
      const cs = getComputedStyle(g);
      for (const prop of ["fill", "stroke"]) {
        let v = cs[prop];
        if (!v || v === "none") continue;
        if (v === "currentColor") v = cs.color;
        const cor = parse(v);
        if (!cor || cor[3] === 0) { revSvg = true; continue; }
        const c = cor[3] < 1 ? sobre(cor, [...bg.rgb, 1]) : cor.slice(0, 3);
        const r = razao(c, bg.rgb);
        if (r < 3 && !violSvg) violSvg = `grafico ${prop} ratio=${r.toFixed(4)} req=3 fg=rgb(${c.map(Math.round)}) bg=rgb(${bg.rgb.map(Math.round)})`;
      }
    }
    if (violSvg) out.naoTexto.viol.push(`${sel(svg)} ${violSvg}`);
    else if (revSvg) out.naoTexto.rev.push(`${sel(svg)} cor de gráfico não classificável`);
  }

  // --- SC 2.5.8: alvos de ponteiro ≥24×24 CSS px ---
  const SELETOR_ALVO = "button, a[href], input, select, textarea, summary, [role='button'], [role='tab'], [role='link'], [role='checkbox'], [role='radio'], [role='switch']";
  const alvos = [...document.querySelectorAll(SELETOR_ALVO)]
    .filter((el) => {
      if (!visivel(el)) return false;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (el.type === "hidden") return false;
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === "none") return false;
      return true;
    })
    .map((el) => ({ el, r: el.getBoundingClientRect(), s: sel(el) }));
  const distPontoRect = (px, py, rc) => {
    const dx = Math.max(rc.left - px, 0, px - rc.right);
    const dy = Math.max(rc.top - py, 0, py - rc.bottom);
    return Math.hypot(dx, dy);
  };
  const circulo = (rc) => ({ x: rc.left + rc.width / 2, y: rc.top + rc.height / 2, r: 12 });
  for (const a of alvos) {
    const { width: w, height: h } = a.r;
    if (w >= 24 && h >= 24) continue;
    // Exceção inline REAL: alvo fraseado com disposição inline demonstrada
    // (display:inline) dentro de frase/bloco de texto — link autônomo em
    // li/td ou botão em célula NÃO é exceptuado.
    const tagAlvo = a.el.tagName.toLowerCase();
    const disp = getComputedStyle(a.el).display;
    const ehInline = (tagAlvo === "a" || a.el.getAttribute("role") === "link")
      && disp === "inline"
      && !!a.el.closest("p, li, td, th, blockquote");
    if (ehInline) { out.alvos.okEsp++; continue; }
    const c = circulo(a.r);
    let conflita = false;
    for (const b of alvos) {
      if (b === a) continue;
      if (distPontoRect(c.x, c.y, b.r) < 12) { conflita = true; break; }
      const cb = circulo(b.r);
      const bw = b.r.width, bh = b.r.height;
      if ((bw < 24 || bh < 24) && Math.hypot(c.x - cb.x, c.y - cb.y) < 24) { conflita = true; break; }
    }
    if (conflita) {
      out.alvos.viol.push(`${a.s} ${w.toFixed(1)}x${h.toFixed(1)}px sem espaçamento 24px`);
    } else out.alvos.okEsp++;
  }
  return out;
}

// Indicador de foco/estado medido separadamente: outline/box-shadow do
// activeElement vs adjacente externo, com alpha COMPOSTO sobre o fundo.
// Múltiplas sombras/cores ou indicador não classificável ⇒ REVIEW.
function avaliarFocoIndicador() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) {
    return { viol: [], rev: ["nenhum elemento em foco para medir"] };
  }
  const parse = (c) => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/.exec(c || "");
    if (!m) return null;
    const a = m[4] === undefined ? 1 : (String(m[4]).endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return [+m[1], +m[2], +m[3], a];
  };
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const sobre = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
  const razao = (c1, c2) => { const l1 = lum(c1), l2 = lum(c2); const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05); };
  const sel = (e) => {
    const id = e.id ? "#" + e.id : "";
    const cls = typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\s+/)[0] : "";
    return (e.tagName.toLowerCase() + id + cls).slice(0, 60);
  };
  const fundoExterno = (e) => {
    const camadas = [];
    let cur = e.parentElement, img = null, opaco = false;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      if (!img && !opaco && cs.backgroundImage && cs.backgroundImage !== "none") img = "bg-image";
      const bg = parse(cs.backgroundColor);
      if (bg) { camadas.push(bg); if (bg[3] === 1) { opaco = true; break; } }
      cur = cur.parentElement;
    }
    if (img) return { review: img };
    let acc = [255, 255, 255, 1];
    for (const c of camadas.slice().reverse()) acc = sobre(c, acc);
    return { rgb: acc.slice(0, 3) };
  };
  const cs = getComputedStyle(el);
  const rotulo = sel(el);
  const bg = fundoExterno(el);
  if (bg.review) return { viol: [], rev: [`${rotulo} adjacente externo incalculável (${bg.review})`] };
  const bgRgb = bg.rgb;
  let cor = null, tipo = null;
  const ow = parseFloat(cs.outlineWidth) || 0;
  if (cs.outlineStyle !== "none" && ow >= 1) {
    const oc = parse(cs.outlineColor);
    if (oc && oc[3] > 0) {
      cor = oc[3] < 1 ? sobre(oc, [...bgRgb, 1]).slice(0, 3) : oc.slice(0, 3);
      tipo = `outline ${ow}px`;
    }
  }
  if (!cor) {
    const bs = cs.boxShadow;
    if (bs && bs !== "none") {
      const cores = [...bs.matchAll(/rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g)]
        .map((m) => parse(m[0])).filter((c) => c && c[3] > 0);
      if (cores.length === 1) {
        cor = cores[0][3] < 1 ? sobre(cores[0], [...bgRgb, 1]).slice(0, 3) : cores[0].slice(0, 3);
        tipo = "box-shadow";
      } else if (cores.length > 1) {
        return { viol: [], rev: [`${rotulo} foco com ${cores.length} sombras/cores — adjacentes distintos não classificados`] };
      }
    }
  }
  if (!cor) {
    return { viol: [], rev: [`${rotulo} foco sem outline/sombra única mensurável (borda/fundo/múltipla — inspeção visual)`] };
  }
  const r = razao(cor, bgRgb);
  if (r < 3) return { viol: [`${rotulo} indicador foco ${tipo} ratio=${r.toFixed(4)} req=3 fg=rgb(${cor.map(Math.round)}) bg=rgb(${bgRgb.map(Math.round)})`], rev: [] };
  return { viol: [], rev: [] };
}

export { avaliarWcag, avaliarFocoIndicador };
