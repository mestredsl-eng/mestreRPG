// Evidência complementar ao item 4 (PR #318): mede o contraste REAL do
// texto sobre os fundos `bg-image` que o auditor avaliarWcag marca como
// REVIEW por não compor gradientes via DOM.
//
// Inspeção prévia (docs/WCAG-REVIEW-1.0.9.md) mostrou que TODAS as
// fontes de background-image nas telas auditadas são linear/radial-
// gradients CSS entre cores opacas ou semi-opacas de tema — nenhum
// bitmap. Este script replica a MESMA fixture e a MESMA matriz de
// telas/viewport da suíte, mas em vez de contar rev[] executa um
// avaliador que:
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

const medicoes = [];

// ---------- avaliador in-page (serializado por page.evaluate) ----------
function medirContrasteGradientes() {
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
  // Extrai cores de parada de uma camada gradient(...).
  const coresDaCamada = (camada) => {
    const cores = [];
    const re = /(?:rgba?|color|hsla?)\([^()]*\)|#[0-9a-fA-F]{3,8}\b/g;
    let m;
    while ((m = re.exec(camada))) {
      const c = parse(m[0]);
      if (c) cores.push(c);
    }
    return cores;
  };

  // Fundo efetivo: sobe a cadeia coletando cores e gradientes até cor
  // opaca. Retorna { tipo: "gradiente", el, camadas, abaixo } ou
  // { tipo: "solido", rgb } ou { tipo: "imagem", el } (url real).
  const fundoGradiente = (el) => {
    const camadas = [];   // {el, tipo:'gradiente'|'cor', cores?}
    let cur = el, achouOpaco = false;
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
      // sem gradiente: reproduz o resultado do auditor (sólido ou branco)
      let acc = [255, 255, 255, 1];
      const cores = camadas.filter((c) => c.tipo === "cor").map((c) => c.cor).reverse();
      for (const c of cores) acc = sobre(c, acc);
      return { tipo: "solido", rgb: acc.slice(0, 3) };
    }
    // "abaixo" = composto das camadas posteriores ao ÚLTIMO gradiente
    // (fundo que aparece através de paradas translúcidas). Se houver
    // cor opaca depois do último gradiente, é ela; senão canvas branco
    // (mesmo fallback do auditor — não ocorre: html tem cor opaca).
    const idxUlt = camadas.map((c, i) => c.tipo === "gradiente" ? i : -1).filter((i) => i >= 0).pop();
    let abaixo = [255, 255, 255, 1];
    for (const c of camadas.slice(idxUlt + 1).reverse()) {
      if (c.tipo === "cor") abaixo = sobre(c.cor, abaixo);
    }
    return { tipo: "gradiente", camadas, abaixo };
  };

  const out = [];
  const todos = [...document.querySelectorAll("body *")].filter(visivel);
  for (const el of todos) {
    if (el.closest("svg")) continue;
    if (desabilitado(el)) continue;
    const temTexto = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!temTexto) continue;
    const cs = getComputedStyle(el);
    const fg0 = parse(cs.color);
    if (!fg0) continue;
    const fundo = fundoGradiente(el);
    if (fundo.tipo === "solido") continue;               // já medido pelo auditor
    if (fundo.tipo === "imagem") {
      out.push({ sel: sel(el), fg: fg0.slice(0, 3), fundo: "imagem-real", detalhe: fundo.detalhe });
      continue;
    }
    // composto do texto sobre cada cor candidata (fg translúcido compõe)
    const candidatos = [];
    // cores sólidas acima do primeiro gradiente também contam
    for (const camada of fundo.camadas) {
      if (camada.tipo === "cor") {
        candidatos.push({ tipo: "cor", cor: camada.cor.slice(0, 3), origem: sel(camada.el) });
      } else {
        for (const img of camada.camadas) {
          const cores = coresDaCamada(img);
          if (!cores.length) {
            candidatos.push({ tipo: "gradiente-sem-cor", origem: sel(camada.el) });
            continue;
          }
          for (const c of cores) {
            const comp = c[3] < 1 ? sobre(c, fundo.abaixo) : c;
            candidatos.push({
              tipo: img.slice(0, 22), cor: comp.slice(0, 3).map((v) => Math.round(v)),
              alpha: c[3], origem: sel(camada.el),
            });
          }
        }
      }
    }
    const comCor = candidatos.filter((c) => Array.isArray(c.cor));
    if (!comCor.length) { out.push({ sel: sel(el), fg: fg0.slice(0, 3), fundo: "gradiente-sem-cor" }); continue; }
    const limiar = grande(cs) ? 3.0 : 4.5;
    let pior = Infinity, melhor = 0;
    const razoes = comCor.map((cand) => {
      const fg = fg0[3] < 1 ? sobre(fg0, cand.cor.concat ? [...cand.cor, 1] : cand.cor) : fg0;
      const r = razao(fg.slice(0, 3), cand.cor);
      if (r < pior) pior = r;
      if (r > melhor) melhor = r;
      return { ...cand, razao: +r.toFixed(2) };
    });
    out.push({
      sel: sel(el), fg: fg0.slice(0, 3).map((v) => Math.round(v)),
      fontePx: cs.fontSize, peso: cs.fontWeight,
      limiar, pior: +pior.toFixed(2), melhor: +melhor.toFixed(2),
      veredito: pior >= limiar ? "computado-PASS" : "computado-FAIL",
      fundos: [...new Set(candidatos.map((c) => c.origem))],
      amostra: razoes.slice(0, 4),
      nCores: comCor.length,
    });
  }
  return out;
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
    const r = await page.evaluate(medirContrasteGradientes);
    for (const m of r) medicoes.push({ pagina, viewport, ...m });
  } catch (e) {
    medicoes.push({ pagina, viewport, sel: "(erro)", fundo: "erro-avaliador", detalhe: String(e?.message ?? e).slice(0, 160) });
  }
}

// ---------- geração do markdown ----------
function gerarMarkdown() {
  const L = [];
  L.push("# WCAG — contraste medido sobre gradientes (evidência p/ disposição)");
  L.push("");
  L.push("Complemento de `WCAG-REVIEW-1.0.9.md` (item 4, PR #318). As ~1340 entradas" +
    " de REVIEW por `bg-image` foram re-medidas com um avaliador que resolve" +
    " `linear-gradient`/`radial-gradient` do computed style: cada parada de cor" +
    " é composta sobre o fundo efetivo abaixo dela (incluindo alpha) e o pior" +
    " contraste WCAG texto×fundo é calculado. Mesma fixture, servidor real," +
    " telas e viewports da suíte `teste-a11y-fluxos-297.mjs`.");
  L.push("");
  L.push("**Isto é evidência, não disposição.** O gate humano continua pendente;");
  L.push("`computado-PASS`/`computado-FAIL` são medições objetivas para acelerar");
  L.push("a revisão — não alteram o status REVIEW original.");
  L.push("");

  const validas = medicoes.filter((m) => m.veredito);
  const falhas = validas.filter((m) => m.veredito === "computado-FAIL");
  const passes = validas.filter((m) => m.veredito === "computado-PASS");
  const outros = medicoes.filter((m) => !m.veredito);
  L.push(`**Medições:** ${validas.length} elementos de texto sobre gradiente` +
    ` — **${passes.length} computado-PASS**, **${falhas.length} computado-FAIL**` +
    (outros.length ? `, ${outros.length} não mensuráveis/erros` : "") + ".");
  L.push("");

  // resumo por página×viewport
  const grupos = new Map();
  for (const m of validas) {
    const k = `${m.pagina} | ${m.viewport}`;
    if (!grupos.has(k)) grupos.set(k, { p: 0, f: 0, min: Infinity });
    const g = grupos.get(k);
    if (m.veredito === "computado-PASS") g.p++; else g.f++;
    g.min = Math.min(g.min, m.pior);
  }
  L.push("## Resumo por tela × viewport (pior contraste encontrado)");
  L.push("");
  L.push("| tela / fluxo | viewport | elementos | PASS | FAIL | pior razão | limiar mínimo |");
  L.push("|---|---|---|---|---|---|---|");
  for (const [k, g] of grupos) {
    const [pagina, viewport] = k.split(" | ");
    L.push(`| ${pagina} | ${viewport} | ${g.p + g.f} | ${g.p} | ${g.f} | ${g.min.toFixed(2)}:1 | ${g.f ? "ver abaixo" : "4.5:1 / 3:1 (grande)"} |`);
  }
  L.push("");

  // FAILs primeiro — são os que exigem decisão
  if (falhas.length) {
    L.push("## computed-FAIL — exigem decisão de design/revisão");
    L.push("");
    L.push("| # | tela | viewport | elemento | fg | limiar | pior razão | fundos | amostra de paradas |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    falhas.slice(0, 200).forEach((m, i) => {
      const amostra = (m.amostra || []).slice(0, 3).map((a) => `${a.tipo} ${a.cor}→${a.razao}`).join("; ");
      L.push(`| ${i + 1} | ${m.pagina} | ${m.viewport} | \`${m.sel}\` | rgb(${m.fg}) | ${m.limiar}:1 | ${m.pior}:1 | ${(m.fundos || []).join(", ")} | ${amostra.replace(/\|/g, "\\|")} |`);
    });
    if (falhas.length > 200) L.push(`| … | | | | | | | | +${falhas.length - 200} FAILs adicionais (mesmo padrão) |`);
    L.push("");
  }

  // PASS: agrega por assinatura de fundo+fg para não listar 1300 linhas
  const porPadrao = new Map();
  for (const m of passes) {
    const k = `${(m.fundos || []).join(",")}|rgb(${m.fg})|${m.limiar}`;
    if (!porPadrao.has(k)) porPadrao.set(k, { n: 0, min: Infinity, max: 0, exemplos: [] });
    const p = porPadrao.get(k);
    p.n++; p.min = Math.min(p.min, m.pior); p.max = Math.max(p.max, m.pior);
    if (p.exemplos.length < 3 && !p.exemplos.includes(`${m.pagina}/${m.viewport}/${m.sel}`)) {
      p.exemplos.push(`${m.pagina}/${m.viewport}/\`${m.sel}\``);
    }
  }
  L.push("## Padrões computado-PASS (deduplicados por fundo+cor de texto)");
  L.push("");
  L.push("| fundo(s) | cor do texto | limiar | n elementos | pior razão | melhor razão | exemplos |");
  L.push("|---|---|---|---|---|---|---|");
  const ord = [...porPadrao.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [k, p] of ord) {
    const [fundos, fg, limiar] = k.split("|");
    L.push(`| ${fundos.replace(/\|/g, ", ")} | ${fg} | ${limiar}:1 | ${p.n} | ${p.min.toFixed(2)}:1 | ${p.max.toFixed(2)}:1 | ${p.exemplos.join("; ").replace(/\|/g, "\\|")} |`);
  }
  L.push("");

  if (outros.length) {
    L.push("## Não mensuráveis / erros");
    L.push("");
    const cont = {};
    for (const m of outros) cont[m.fundo] = (cont[m.fundo] || 0) + 1;
    for (const [k, n] of Object.entries(cont)) L.push(`- \`${k}\`: ${n}`);
    L.push("");
  }

  L.push("## Notas metodológicas");
  L.push("");
  L.push("- O pior contraste é o mínimo entre TODAS as paradas de cor de todos os" +
    " gradientes do fundo efetivo — conservador: pixels do meio do gradiente" +
    " têm contraste intermediário, nunca pior que as extremidades.");
  L.push("- Paradas com alpha < 1 foram compostas sobre o fundo efetivo abaixo" +
    " do gradiente (mesma composição `sobre()` do auditor).");
  L.push("- Limiar: 4.5:1 texto normal, 3.0:1 texto grande (≥24px ou ≥18.66px" +
    " negrito) — idêntico ao `grande()` de `wcag-avaliador-297.mjs`.");
  L.push("- Entradas SC 1.4.11 (não-texto) e indicador de foco não são cobertas" +
    " aqui — permanecem para disposição humana.");
  L.push("- `computado-FAIL` não é violação confirmada: gradiente com parada" +
    " extrema pode não cobrir a área do glifo; a decisão visual final é humana.");
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

  await browser.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}

const validas = medicoes.filter((m) => m.veredito);
console.log(`\n==== medições: ${validas.length} | PASS ${validas.filter((m) => m.veredito === "computado-PASS").length} | FAIL ${validas.filter((m) => m.veredito === "computado-FAIL").length} | outros ${medicoes.length - validas.length} ====`);

const outPath = join(REPO, "docs", "WCAG-CONTRASTE-GRADIENTES-1.0.9.md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, gerarMarkdown(), "utf8");
console.log(`doc gerado: ${outPath}`);
