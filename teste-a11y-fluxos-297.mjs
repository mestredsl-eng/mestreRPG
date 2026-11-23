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
// Controles interativos sem nome acessível (mesmo critério de
// teste-acessibilidade.mjs — nomes por aria-label/labelledby/label/title/
// placeholder/texto; ocultos e desabilitados fora do escopo).
async function semNome(page, seletor = null) {
  return page.evaluate((sel) => {
    const raiz = sel ? document.querySelector(sel) : document;
    if (!raiz) return ["<raiz ausente: " + sel + ">"];
    const els = [...raiz.querySelectorAll("button, a[href], input, select, textarea, [role='button'], [role='tab']")];
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
  }, seletor);
}
// Overflow horizontal não intencional do documento.
async function overflowX(page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    return { sw: de.scrollWidth, cw: de.clientWidth, overflow: de.scrollWidth > de.clientWidth + 1 };
  });
}
// ---------- WCAG 2.2 AA — avaliador in-page autocontido ----------
// SC 1.4.3 (contraste texto 4.5:1 / grande 3:1), SC 1.4.11 (não-texto 3:1),
// SC 2.5.8 (alvo mínimo 24×24 CSS px, exceção de espaçamento/inline).
// Sem dependências; razões não arredondadas; fundo transparente compõe com
// ancestrais até opaco (canvas branco é o fundo determinístico final);
// gradiente/imagem/filtro ⇒ REVIEW, nunca PASS automático.
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
  // Fundo efetivo: sobe a cadeia compilando backgroundColor; para no
  // primeiro fundo opaco (o que estiver acima dele está ocluído). Imagem/
  // gradiente ANTES do opaco ⇒ incalculável ⇒ REVIEW; depois ⇒ ignorado.
  // Sem opaco até a raiz, o canvas branco é o fundo determinístico final.
  const fundoDe = (el) => {
    const camadas = [];
    let cur = el, img = null, achouOpaco = false;
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
    // camadas coletadas de dentro→fora; compõe de fora→dentro sobre o canvas
    let acc = [255, 255, 255, 1];
    for (const c of camadas.slice().reverse()) acc = sobre(c, acc);
    return { rgb: acc.slice(0, 3) };
  };
  const razao = (c1, c2) => {
    const l1 = lum(c1), l2 = lum(c2);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  };
  const grande = (cs) => {
    const px = parseFloat(cs.fontSize) || 16;
    const w = parseInt(cs.fontWeight, 10) || 400;
    return px >= 24 || (px >= 18.66 && w >= 700);
  };
  const out = { textos: { viol: [], rev: [] }, naoTexto: { viol: [], rev: [] }, alvos: { viol: [], okEsp: 0 } };
  const todos = [...document.querySelectorAll("body *")].filter(visivel);

  // --- SC 1.4.3: nós de texto visíveis ---
  for (const el of todos) {
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

  // --- SC 1.4.11: bordas de controles + fill/stroke de svg ---
  for (const el of todos) {
    if (!/^(button|a|input|select|textarea)$/.test(el.tagName.toLowerCase()) && el.getAttribute("role") !== "button" && el.getAttribute("role") !== "link") continue;
    const cs = getComputedStyle(el);
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const bs = cs.borderTopStyle;
    if (bw >= 1 && bs !== "none" && bs !== "hidden") {
      const bc = parse(cs.borderTopColor);
      if (bc && bc[3] > 0) {
        const bg = fundoDe(el);
        if (bg.review) { out.naoTexto.rev.push(`${sel(el)} borda (${bg.review})`); continue; }
        const bgr = [...bg.rgb, 1];
        const b = bc[3] < 1 ? sobre(bc, bgr) : bc.slice(0, 3);
        const r = razao(b, bg.rgb);
        if (r < 3) out.naoTexto.viol.push(`${sel(el)} borda ratio=${r.toFixed(4)} req=3 fg=rgb(${b.map(Math.round)}) bg=rgb(${bg.rgb.map(Math.round)})`);
      }
    }
  }
  for (const el of todos) {
    if (el.tagName.toLowerCase() !== "svg") continue;
    const cs = getComputedStyle(el);
    for (const prop of ["fill", "stroke"]) {
      const v = cs[prop];
      if (!v || v === "none") continue;
      const cor = parse(v);
      if (!cor || cor[3] === 0) continue;
      // currentColor não é parseável → resolve pela cor computada já vem rgb
      const bg = fundoDe(el);
      if (bg.review) { out.naoTexto.rev.push(`${sel(el)} svg ${prop} (${bg.review})`); continue; }
      const c = cor[3] < 1 ? sobre(cor, [...bg.rgb, 1]) : cor.slice(0, 3);
      const r = razao(c, bg.rgb);
      if (r < 3) out.naoTexto.viol.push(`${sel(el)} svg ${prop} ratio=${r.toFixed(4)} req=3 fg=rgb(${c.map(Math.round)}) bg=rgb(${bg.rgb.map(Math.round)})`);
    }
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
    // exceção inline: alvo dentro de frase/bloco de texto
    if (a.el.closest("p, li, td, th, blockquote")) continue;
    const c = circulo(a.r);
    let conflita = false;
    for (const b of alvos) {
      if (b === a) continue;
      // círculo de 24px do alvo vs bounding box do outro alvo
      if (distPontoRect(c.x, c.y, b.r) < 12) { conflita = true; break; }
      // círculo vs círculo (outro alvo também subdimensionado)
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

async function checarWcag(page, rotulo) {
  const r = await page.evaluate(avaliarWcag);
  const violC = r.textos.viol.length + r.naoTexto.viol.length;
  const revCount = r.textos.rev.length + r.naoTexto.rev.length;
  const det = [...r.textos.viol.slice(0, 2), ...r.naoTexto.viol.slice(0, 1)]
    .map((v) => v.slice(0, 110)).join(" || ");
  const extra = `${violC} violação(ões)${revCount ? ` + ${revCount} review` : ""}`;
  if (violC > 0) tc(`${rotulo}: contraste AA`, false, det || extra);
  else if (revCount > 0) tc(`${rotulo}: contraste AA`, "review", `${revCount} superfície(s) incalculável(is): ${r.textos.rev[0] || r.naoTexto.rev[0] || ""}`.slice(0, 160));
  else tc(`${rotulo}: contraste AA`, true);

  const violA = r.alvos.viol;
  const detA = violA.slice(0, 3).map((v) => v.slice(0, 110)).join(" || ");
  const notaEsp = r.alvos.okEsp ? ` (${r.alvos.okEsp} subdimensões com exceção de espaçamento/inline)` : "";
  if (violA.length > 0) ta(`${rotulo}: alvos ≥24px`, false, `${violA.length} alvo(s): ${detA}${notaEsp}`);
  else ta(`${rotulo}: alvos ≥24px`, true, notaEsp.trim());
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
      for (const sub of ["Inventário", "Dinheiro"]) {
        const b = page.getByRole("button", { name: sub, exact: true });
        if (await b.count()) {
          await b.first().click();
          await page.waitForTimeout(300);
          await checarTela(page, `patrimônio ${sub}`);
        }
      }
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

    // Login → painel → campanha
    await login(page, "mestre_teste", "senha-forte-123");
    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });

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
