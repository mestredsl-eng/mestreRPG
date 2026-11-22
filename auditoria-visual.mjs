#!/usr/bin/env node
// Auditoria visual/acessibilidade essencial (E2E real, Playwright).
// Sobe servidor com banco sintético + SPA de produção (site/dist) e
// percorre as telas em 3 viewports medindo:
//   - rolagem horizontal indevida (scrollWidth > clientWidth)
//   - elementos mais largos que a viewport
//   - botões sem nome acessível
//   - inputs sem label associado
// Não é suíte de assertiva de design: imprime relatório de achados.
import { chromium } from "playwright";
import { join } from "path";
import { mkdirSync } from "fs";
import {
  req, dirTeste, prepararBanco, portaLivre, subirServidor,
  esperarSaudavel, encerrarServidor, limparDir, criarCenario,
} from "./teste-base.mjs";

const DIR = dirTeste("visual");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let browser;

const VIEWPORTS = [
  { nome: "desktop", width: 1366, height: 768 },
  { nome: "tablet", width: 768, height: 1024 },
  { nome: "celular", width: 390, height: 844 },
];

const achados = [];
function anotar(tela, viewport, tipo, detalhe) {
  achados.push({ tela, viewport, tipo, detalhe });
  console.log(`  [${viewport}/${tela}] ${tipo}: ${detalhe}`);
}

async function medirPagina(page, tela, vp, { registrar = true } = {}) {
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const overflowX = de.scrollWidth > de.clientWidth + 1;
    // Elementos visíveis mais largos que a viewport. O conteúdo de uma
    // área com overflow-x:auto|scroll é intencionalmente navegável; não
    // deve virar um falso positivo por cada thead/tr/td descendente.
    // Fora dessas áreas, agrupa a árvore no ancestral largo mais externo,
    // para não contar cada nó de um mesmo componente como um defeito novo.
    const largosPorRaiz = new Map();
    const areasRolaveis = new Map();
    const seletorCurto = (el) => {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : "";
      const classes = typeof el.className === "string"
        ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join("")
        : "";
      return `${tag}${id}${classes}`;
    };
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width <= de.clientWidth + 1 || r.height <= 0) continue;

      let raiz = el;
      let ancestral = el.parentElement;
      let areaRolavel = null;
      while (ancestral && ancestral !== document.body && ancestral !== de) {
        const estilo = getComputedStyle(ancestral);
        const larguraAncestral = ancestral.getBoundingClientRect();
        const permiteRolagem = /(auto|scroll)/.test(estilo.overflowX)
          && ancestral.clientWidth > 0
          && ancestral.scrollWidth > ancestral.clientWidth + 1;
        if (permiteRolagem) {
          areaRolavel = ancestral;
          break;
        }
        if (larguraAncestral.width > de.clientWidth + 1 && larguraAncestral.height > 0) {
          raiz = ancestral;
        }
        ancestral = ancestral.parentElement;
      }

      if (areaRolavel) {
        const existente = areasRolaveis.get(areaRolavel) ?? {
          seletor: seletorCurto(areaRolavel),
          clientW: areaRolavel.clientWidth,
          scrollW: areaRolavel.scrollWidth,
          maiorConteudo: 0,
          descendentesLargos: 0,
        };
        existente.maiorConteudo = Math.max(existente.maiorConteudo, Math.round(r.width));
        existente.descendentesLargos++;
        areasRolaveis.set(areaRolavel, existente);
        continue;
      }

      if (raiz === document.body || raiz === de) continue;
      const existente = largosPorRaiz.get(raiz) ?? {
        seletor: seletorCurto(raiz),
        largura: Math.round(raiz.getBoundingClientRect().width),
        maiorDescendente: 0,
        descendentesLargos: 0,
      };
      existente.maiorDescendente = Math.max(existente.maiorDescendente, Math.round(r.width));
      existente.descendentesLargos++;
      largosPorRaiz.set(raiz, existente);
    }
    const largos = [...largosPorRaiz.values()].map((x) =>
      `${x.seletor} largura=${x.largura}px (maior descendente=${x.maiorDescendente}px; ${x.descendentesLargos} nós)`,
    );
    const areasRolaveisLista = [...areasRolaveis.values()].map((x) =>
      `${x.seletor} clientWidth=${x.clientW}px scrollWidth=${x.scrollW}px (conteúdo até ${x.maiorConteudo}px; ${x.descendentesLargos} nós)`,
    );
    // O valor de aria-labelledby é uma lista de IDREFs, não o nome.
    // Só conta se ao menos um ID resolver para um elemento com texto útil.
    // Referências inexistentes/vazias não podem mascarar controles sem nome.
    const textoUtil = (valor) => typeof valor === "string" && valor.replace(/\\s+/g, " ").trim().length > 0;
    const temTextoIdRef = (el) => {
      const ids = (el.getAttribute("aria-labelledby") || "").trim().split(/\\s+/).filter(Boolean);
      return ids.some((id) => {
        const alvo = document.getElementById(id);
        return !!alvo && textoUtil(alvo.innerText || alvo.textContent || "");
      });
    };
    const temAtributoComTexto = (el, atributo) => textoUtil(el.getAttribute(atributo) || "");

    // botões sem nome acessível — texto, aria-label, IDREF resolvido ou title
    const botoesSemNome = [];
    for (const b of document.querySelectorAll("button")) {
      const nome = textoUtil(b.innerText || b.textContent || "")
        || temAtributoComTexto(b, "aria-label")
        || temTextoIdRef(b)
        || temAtributoComTexto(b, "title");
      const r = b.getBoundingClientRect();
      if (!nome && r.width > 0 && r.height > 0) botoesSemNome.push(b.outerHTML.slice(0, 120));
    }
    // inputs sem label/aria. Placeholder isolado continua sendo aviso
    // próprio; não é um rótulo acessível. Labels explícitos/envolventes
    // só contam quando têm texto útil.
    const inputsSemLabel = [];
    const inputsPlaceholder = [];
    for (const i of document.querySelectorAll("input, select, textarea")) {
      const r = i.getBoundingClientRect();
      if (r.width === 0) continue;
      const labels = Array.from(i.labels || []);
      const temLabelAssociado = labels.some((label) => textoUtil(label.innerText || label.textContent || ""));
      const temLabel = temLabelAssociado
        || temAtributoComTexto(i, "aria-label")
        || temTextoIdRef(i);
      const detalhe = `${i.tagName.toLowerCase()} type=${i.type || ""} :: ${i.outerHTML.slice(0, 140)}`;
      if (!temLabel) {
        if (i.getAttribute("placeholder")) inputsPlaceholder.push(detalhe);
        else inputsSemLabel.push(detalhe);
      }
    }
    return { overflowX, scrollW: de.scrollWidth, clientW: de.clientWidth, largos, areasRolaveis: areasRolaveisLista, botoesSemNome, inputsSemLabel, inputsPlaceholder };
  });
  if (!registrar) return m;
  if (m.overflowX) anotar(tela, vp.nome, "rolagem-horizontal", `scrollWidth=${m.scrollW} clientWidth=${m.clientW}`);
  for (const l of m.largos) anotar(tela, vp.nome, "elemento-mais-largo", l);
  for (const a of m.areasRolaveis) console.log(`  [${vp.nome}/${tela}] area-rolavel: ${a}`);
  for (const b of m.botoesSemNome) anotar(tela, vp.nome, "botao-sem-nome", b);
  for (const i of m.inputsSemLabel) anotar(tela, vp.nome, "input-sem-label", i);
  for (const i of m.inputsPlaceholder) anotar(tela, vp.nome, "input-placeholder", i);
  return m;
}

async function clicaSeExiste(page, seletor, timeout = 4000) {
  try { await page.click(seletor, { timeout }); return true; } catch { return false; }
}

// ---------- fixtures determinísticas (F22/#251) ----------
// Árvore controlada via page.setContent — mede o MESMO classificador de
// medirPagina sem depender do app. Larguras > 1366px para que o resultado
// seja idêntico nos 3 viewports; cada fixture roda 2× por viewport e a
// assinatura dos achados precisa ser estável (determinismo).
let fixOk = 0, fixFalhas = 0;
const fixT = (nome, cond, extra = "") => {
  if (cond) { fixOk++; console.log("  ok fixture:", nome); }
  else { fixFalhas++; console.log("  FALHOU fixture:", nome, extra); }
};
const assinatura = (m) => JSON.stringify({
  o: m.overflowX, l: m.largos, a: m.areasRolaveis,
  b: m.botoesSemNome, i: m.inputsSemLabel, p: m.inputsPlaceholder,
});

const FIXTURES = [
  {
    // 1) descendente largo dentro de ancestral overflow-x:auto → área rolável
    nome: "fx1-descendente-em-area-rolavel",
    html: `<div id="area" style="width:300px;overflow-x:auto"><div style="width:2000px;height:20px">x</div></div>`,
    verificar: (m) => {
      fixT("fx1 sem elemento-mais-largo", m.largos.length === 0, JSON.stringify(m.largos));
      fixT("fx1 uma area-rolavel", m.areasRolaveis.length === 1, JSON.stringify(m.areasRolaveis));
      fixT("fx1 sem overflow global", m.overflowX === false);
    },
  },
  {
    // 2) vários descendentes largos no MESMO ancestral → 1 resumo c/ contagem
    nome: "fx2-varios-descendentes-um-resumo",
    html: `<div id="tabela" style="width:300px;overflow-x:auto">
      <div class="linha" style="width:2000px">a</div>
      <div class="linha" style="width:1900px">b</div>
      <div class="linha" style="width:1800px">c</div></div>`,
    verificar: (m) => {
      fixT("fx2 um unico resumo por ancestral", m.areasRolaveis.length === 1, JSON.stringify(m.areasRolaveis));
      fixT("fx2 resumo traz contagem de descendentes", /3 nós/.test(m.areasRolaveis[0] ?? ""), m.areasRolaveis[0]);
      fixT("fx2 sem elemento-mais-largo", m.largos.length === 0);
    },
  },
  {
    // 3) overflow real no documentElement + tabela rolável → rolagem-horizontal permanece
    nome: "fx3-overflow-global-com-tabela-rolavel",
    html: `<div id="area" style="width:300px;overflow-x:auto"><div style="width:2000px;height:20px">x</div></div>
      <div id="global" style="width:2000px;height:10px"></div>`,
    verificar: (m) => {
      fixT("fx3 rolagem-horizontal real preservada", m.overflowX === true, `scrollW=${m.scrollW} clientW=${m.clientW}`);
      fixT("fx3 tabela rolavel segue como area", m.areasRolaveis.length === 1);
    },
  },
  {
    // 4) elemento largo fora de ancestral rolável → elemento-mais-largo
    nome: "fx4-elemento-largo-solto",
    html: `<div id="solto" style="width:2000px;height:10px"></div>`,
    verificar: (m) => {
      fixT("fx4 elemento-mais-largo reportado", m.largos.length === 1 && /#solto/.test(m.largos[0]), JSON.stringify(m.largos));
      fixT("fx4 sem area-rolavel espuria", m.areasRolaveis.length === 0);
    },
  },
  {
    // 5) combinada: área rolável legítima + elemento largo global → ambos reportados
    nome: "fx5-rolavel-mais-global",
    html: `<div id="area" style="width:300px;overflow-x:auto"><div style="width:2000px;height:20px">x</div></div>
      <div id="global" style="width:2000px;height:10px"></div>`,
    verificar: (m) => {
      fixT("fx5 area rolavel nao suprime achado global", m.areasRolaveis.length === 1 && m.largos.length === 1,
        `areas=${m.areasRolaveis.length} largos=${m.largos.length}`);
      fixT("fx5 overflow global presente", m.overflowX === true);
    },
  },
  {
    // 6) acessibilidade: nome acessível por texto, aria-label, aria-labelledby; vazio falha
    nome: "fx6-botoes-acessibilidade",
    html: `<button id="b1">Salvar</button>
      <button id="b2" aria-label="Fechar janela"></button>
      <button id="b3" aria-labelledby="rot-b3"></button><span id="rot-b3">Rotulo assoc</span>
      <button id="b4" title="Dica"></button>
      <button id="b5"></button>
      <button id="b6" aria-labelledby="id-inexistente"></button>
      <button id="b7" aria-labelledby="rot-vazio"></button><span id="rot-vazio">   </span>
      <button id="b8" aria-labelledby="rot-b3 id-inexistente"></button>
      <button id="b9" aria-labelledby="rot-vazio outro-inexistente"></button>
      <button id="b10" aria-label="   "></button>`,
    verificar: (m) => {
      const semNome = m.botoesSemNome.join(" ");
      fixT("fx6 IDs ausentes/vazios e aria-label vazio continuam sem nome",
        m.botoesSemNome.length === 5 && ["b5", "b6", "b7", "b9", "b10"].every((id) => semNome.includes(`id="${id}"`)),
        JSON.stringify(m.botoesSemNome));
      fixT("fx6 IDREF múltiplo com texto resolvido é válido", !semNome.includes('id="b8"'), semNome);
    },
  },
  {
    // 7) formulários: label[for], label envolvendo, aria-labelledby, aria-label;
    //    placeholder isolado → lista própria; input/select nus → sem-label
    nome: "fx7-inputs-label",
    html: `<label for="i1">Nome</label><input id="i1">
      <label>Env <input id="i2"></label>
      <span id="lb3">Email</span><input id="i3" aria-labelledby="lb3">
      <input id="i4" aria-label="Busca">
      <input id="i5" placeholder="Digite aqui">
      <input id="i6">
      <select id="i7"><option>a</option></select>
      <input id="i8" aria-labelledby="id-inexistente">
      <input id="i9" aria-labelledby="rotulo-vazio"><span id="rotulo-vazio">   </span>
      <input id="i10" aria-labelledby="lb3 outro-inexistente">
      <input id="i11" aria-labelledby="rotulo-vazio sem-alvo">
      <input id="i12" aria-label="   ">`,
    verificar: (m) => {
      const semLabel = m.inputsSemLabel.join(" ");
      fixT("fx7 controles nus/IDREF inválido/aria-label vazio sem rótulo",
        m.inputsSemLabel.length === 6 && ["i6", "i7", "i8", "i9", "i11", "i12"].every((id) => semLabel.includes(`id="${id}"`)),
        JSON.stringify(m.inputsSemLabel));
      fixT("fx7 placeholder NAO e label (lista propria)", m.inputsPlaceholder.length === 1 && /i5/.test(m.inputsPlaceholder[0]), JSON.stringify(m.inputsPlaceholder));
      fixT("fx7 IDREF múltiplo com texto resolvido e labels explícitos válidos",
        !["i1", "i2", "i3", "i4", "i10"].some((id) => semLabel.includes(`id="${id}"`)),
        semLabel);
    },
  },
];

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO);
  const campId = c.campId;

  browser = await chromium.launch();

  // ---- fixtures determinísticas: 2 repetições × 3 viewports ----
  console.log("\n== fixtures determinísticas (scroll-roots/a11y/forms) ==");
  const assPorViewport = new Map();
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    for (const fx of FIXTURES) {
      const assinaturas = [];
      let mFinal;
      for (let rep = 0; rep < 2; rep++) {
        await page.setContent(fx.html);
        const m = await medirPagina(page, `fixture/${fx.nome}`, vp, { registrar: false });
        mFinal = m;
        assinaturas.push(assinatura(m));
      }
      fixT(`${fx.nome} determinístico em ${vp.nome}`, assinaturas[0] === assinaturas[1]);
      fx.verificar(mFinal);
      if (!assPorViewport.has(fx.nome)) assPorViewport.set(fx.nome, new Map());
      assPorViewport.get(fx.nome).set(vp.nome, assinaturas[0]);
    }
    await ctx.close();
  }
  // mesma árvore → mesma assinatura em todos os viewports (fixtures usam
  // larguras > 1366px, acima do maior viewport medido)
  for (const [fxNome, porVp] of assPorViewport) {
    const vals = [...porVp.values()];
    fixT(`${fxNome} idêntico nos 3 viewports`, vals.every((v) => v === vals[0]),
      JSON.stringify([...porVp.entries()]));
  }
  console.log(`\n==== fixtures: ${fixOk} ok, ${fixFalhas} falhas ====`);

  // AUDIT_SO_FIXTURES=1: roda só as fixtures (iteração rápida; a auditoria
  // completa continua sendo o caminho default).
  if (process.env.AUDIT_SO_FIXTURES) {
    if (fixFalhas > 0) process.exitCode = 1;
    await browser.close();
    await encerrarServidor(proc);
    limparDir(DIR);
    process.exit(process.exitCode ?? 0);
  }

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => anotar("global", vp.nome, "erro-js", String(e).slice(0, 200)));

    // ---- anônimo: login ----
    // falha de navegação é achado, não exceção silenciosa (F22/#251)
    try {
      await page.goto(BASE + "/", { waitUntil: "networkidle" });
    } catch (e) {
      anotar("global", vp.nome, "falha-navegacao", `login: ${String(e).slice(0, 160)}`);
    }
    if (page.isClosed()) anotar("global", vp.nome, "pagina-fechada", "após goto inicial");
    await medirPagina(page, "login", vp);

    // ---- autenticado como mestre ----
    const [ckNome, ckValor] = c.cookieMestre.split("=", 2);
    await ctx.addCookies([{ name: ckNome, value: decodeURIComponent(ckValor), url: BASE }]);
    try {
      await page.goto(BASE + "/", { waitUntil: "networkidle" });
    } catch (e) {
      anotar("global", vp.nome, "falha-navegacao", `auth: ${String(e).slice(0, 160)}`);
    }
    await page.waitForTimeout(800);

    const telas = [
      ["painel", async () => {}],
      ["campanhas", async () => clicaSeExiste(page, 'button:has-text("Campanhas")')],
      ["acervo", async () => clicaSeExiste(page, 'button:has-text("Acervo")')],
      ["admin", async () => clicaSeExiste(page, 'button:has-text("Administração")')],
      ["conta", async () => clicaSeExiste(page, 'button:has-text("Conta")')],
    ];
    for (const [tela, acao] of telas) {
      await acao();
      await page.waitForTimeout(500);
      await medirPagina(page, tela, vp);
    }

    // ---- dentro da campanha: cada aba ----
    await clicaSeExiste(page, 'button:has-text("Campanhas")');
    await page.waitForTimeout(500);
    // abre o card da campanha (section.clicavel via onClick)
    const abriu = await clicaSeExiste(page, ".cartao-campanha", 3000);
    await page.waitForTimeout(800);
    if (!abriu) anotar("campanha", vp.nome, "campanha-nao-abriu", "");
    const abas = ["Informações", "Mesa", "Personagens", "Diário", "Histórico", "Arquivos", "Fichas", "Regras", "Participantes", "Convites"];
    for (const aba of abas) {
      const ok = await clicaSeExiste(page, `button:has-text("${aba}")`, 3000);
      if (!ok) { anotar(`campanha/${aba.toLowerCase()}`, vp.nome, "aba-nao-encontrada", ""); continue; }
      await page.waitForTimeout(700);
      await medirPagina(page, `campanha/${aba.toLowerCase()}`, vp);
      // Personagens: abre a ficha do mestre para medir patrimônio/ficha
      if (aba === "Personagens") {
        await clicaSeExiste(page, "tr.clicavel", 3000);
        await page.waitForTimeout(700);
        await medirPagina(page, "personagem/detalhe", vp);
      }
    }

    await ctx.close();
  }
} finally {
  try { await browser?.close(); } catch { /* já fechado */ }
  await encerrarServidor(proc);
  limparDir(DIR);
}

if (fixFalhas > 0) process.exitCode = 1;
console.log(`\n==== auditoria visual concluída — ${achados.length} achados ==== (fixtures: ${fixOk} ok, ${fixFalhas} falhas)`);
process.exit(process.exitCode ?? 0);
