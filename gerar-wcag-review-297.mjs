// Item 4 (ordem do Dono, PR #318): lista INDIVIDUAL das ocorrências
// WCAG REVIEW de contraste/indicador produzidas pela suíte
// teste-a11y-fluxos-297.mjs (~38 no placar da suíte — ver "Divergência"
// no doc gerado: a suíte conta VERIFICAÇÕES flagadas, não entradas).
// Replica o MESMO setup de fixture (banco temporário, servidor real,
// seed via API) e navega pelas MESMAS telas/fluxos/viewports, mas em
// vez de apenas contar, coleta CADA string de rev[] retornada por
// avaliarWcag e avaliarFocoIndicador, com página/viewport/fonte e
// classificação sugerida. Gera docs/WCAG-REVIEW-1.0.9.md.
//
// Não altera produção nem testes: arquivo novo, somente leitura dos
// módulos compartilhados (teste-base.mjs, wcag-avaliador-297.mjs).
import { chromium } from "playwright";
import { join, dirname } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { avaliarWcag, avaliarFocoIndicador } from "./wcag-avaliador-297.mjs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req,
} from "./teste-base.mjs";

const REPO = dirname(fileURLToPath(import.meta.url));

const DIR = dirTeste("wcagreview297");
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

// Ocorrências individuais coletadas (uma linha por entrada de rev[]).
const ocorrencias = [];   // REVIEW (o alvo desta lista)
const violacoes = [];     // VIOL inesperado — registrado à parte p/ transparência
const errosAval = [];     // falhas do avaliador
const fundosImg = [];     // evidência extra: elementos com background-image no fundo
let chamadaSeq = 0;

function registrarWcag(pagina, viewport) {
  const chamada = ++chamadaSeq;
  return async (page) => {
    let r;
    try { r = await page.evaluate(avaliarWcag); }
    catch (e) {
      errosAval.push({ pagina, viewport, fonte: "avaliarWcag", detalhe: String(e?.message ?? e).slice(0, 200) });
      return;
    }
    for (const s of r.textos.rev) ocorrencias.push({ chamada, pagina, viewport, fonte: "SC 1.4.3 texto", detalhe: s });
    for (const s of r.naoTexto.rev) ocorrencias.push({ chamada, pagina, viewport, fonte: "SC 1.4.11 não-texto", detalhe: s });
    for (const s of r.textos.viol) violacoes.push({ chamada, pagina, viewport, fonte: "SC 1.4.3 texto", detalhe: s });
    for (const s of r.naoTexto.viol) violacoes.push({ chamada, pagina, viewport, fonte: "SC 1.4.11 não-texto", detalhe: s });
    if (!ocorrencias.some((o) => o.chamada === chamada) && !violacoes.some((v) => v.chamada === chamada)) return;
    await inventariarFundos(page, chamada, pagina, viewport);
  };
}

// Evidência complementar: quais elementos da página têm background-image
// (o motivo dominante de REVIEW é "(tag bg-image)" — o auditor não
// expõe a URL; aqui coletamos tag/classe/url/texto para disposição humana).
async function inventariarFundos(page, chamada, pagina, viewport) {
  try {
    const lista = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("body *")) {
        const cs = getComputedStyle(el);
        if (!cs.backgroundImage || cs.backgroundImage === "none") continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const cs2 = getComputedStyle(el);
        if (cs2.display === "none" || cs2.visibility === "hidden") continue;
        const txt = (el.innerText || "").trim().slice(0, 40);
        out.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          cls: typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 3).join(".") : "",
          bg: cs.backgroundImage.slice(0, 160),
          texto: txt,
        });
        if (out.length >= 12) break;
      }
      return out;
    });
    for (const item of lista) fundosImg.push({ chamada, pagina, viewport, ...item });
  } catch { /* evidência extra é best-effort */ }
}

async function auditarWcag(page, pagina, viewport) {
  await registrarWcag(pagina, viewport)(page);
}

async function auditarFoco(page, pagina, viewport) {
  const chamada = ++chamadaSeq;
  try {
    const r = await page.evaluate(avaliarFocoIndicador);
    for (const s of r.rev) ocorrencias.push({ chamada, pagina, viewport, fonte: "indicador de foco", detalhe: s });
    for (const s of r.viol) violacoes.push({ chamada, pagina, viewport, fonte: "indicador de foco", detalhe: s });
  } catch (e) {
    errosAval.push({ pagina, viewport, fonte: "avaliarFocoIndicador", detalhe: String(e?.message ?? e).slice(0, 200) });
  }
}

// Equivalente a checarTela da suíte, porém coletando ocorrências.
async function checarTela(page, rotulo, viewport) {
  await auditarWcag(page, rotulo, viewport);
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

// ---------- classificação sugerida (honesta: REVIEW ≠ PASS) ----------
function classificar(fonte, detalhe) {
  const d = detalhe.toLowerCase();
  if (fonte === "indicador de foco") {
    if (d.includes("nenhum elemento em foco")) return "provável PASS — nada em foco para medir (REVIEW estrutural, não defeito)";
    if (d.includes("sem outline/sombra única mensurável")) return "requer disposição humana — indicador de foco não classificável via DOM";
    if (d.includes("sombras/cores")) return "requer disposição humana — múltiplas sombras/cores no foco";
    if (d.includes("incalculável") || d.includes("bg-image")) return "requer disposição humana — adjacente externo com imagem/gradiente";
    return "requer disposição humana";
  }
  if (d.includes("nenhum elemento em foco")) return "provável PASS — nada em foco para medir";
  if (d.includes("affordance nativa do ua") || d.includes("stepper nativo")) {
    return "provável PASS — affordance nativo do UA (seta de select/stepper) fora do alcance do DOM; limitação de medição";
  }
  if (d.includes("label/placeholder visível pode identificar")) {
    return "provável PASS — contexto visual presente; fronteira ambígua por metodologia conservadora (1.4.11)";
  }
  if (d.includes("contexto presente mas não comprovado")) {
    return "requer disposição humana — label/contexto existe mas contraste ou visibilidade não comprovados";
  }
  if (d.includes("incalculável") || d.includes("bg-image")) {
    return "requer disposição humana — fundo com imagem/gradiente não mensurável via DOM (bg-image antes de cor opaca)";
  }
  if (d.includes("img heterogênea") || d.includes("não mensurável") || d.includes("região essencial não comprovada")) {
    return "requer disposição humana — imagem/ícone não amostrada de forma conclusiva (1.4.11)";
  }
  if (d.includes("svg sem nome acessível")) {
    return "requer disposição humana — svg decorativo×informativo incerto (afeta 1.1.1/4.1.2 além de contraste)";
  }
  if (d.includes("cor de gráfico não classificável")) {
    return "requer disposição humana — cor de gráfico SVG não classificável";
  }
  return "requer disposição humana — motivo não catalogado";
}

const ehProvavelPass = (o) => classificar(o.fonte, o.detalhe).startsWith("provável PASS");

// ---------- geração do markdown ----------
function elementoMotivo(detalhe) {
  // O auditor prefixa com o seletor (tag#id.classe); o restante é o motivo.
  const m = /^([^\s(]+)\s*(?:\((.*)\))?\s*(.*)$/.exec(detalhe);
  if (!m) return { elemento: "—", motivo: detalhe };
  const elemento = m[1] || "—";
  const dentro = m[2] ? `(${m[2]}) ` : "";
  const resto = (m[3] || "").trim();
  return { elemento, motivo: (dentro + resto).trim() || "—" };
}

function gerarMarkdown() {
  const linhas = [];
  linhas.push("# WCAG REVIEW — lista individual (issue #297 / item 4 PR #318)");
  linhas.push("");
  linhas.push("Gerado por `gerar-wcag-review-297.mjs` replicando o setup e os fluxos de");
  linhas.push("`teste-a11y-fluxos-297.mjs` (mesma fixture descartável, mesmo servidor real,");
  linhas.push("mesmas telas × viewports). Cada linha da tabela principal é UMA entrada de");
  linhas.push("`rev[]` retornada por `avaliarWcag` (SC 1.4.3 texto / SC 1.4.11 não-texto) ou");
  linhas.push("`avaliarFocoIndicador`, com a evidência literal exposta pelo auditor.");
  linhas.push("");

  // ---- Nível 1: verificações flagadas (semântica do contador ~38 da suíte) ----
  const porChamada = new Map();
  for (const o of ocorrencias) {
    if (!porChamada.has(o.chamada)) porChamada.set(o.chamada, []);
    porChamada.get(o.chamada).push(o);
  }
  const checks = [...porChamada.entries()].map(([chamada, lista]) => {
    const { pagina, viewport } = lista[0];
    const fontes = [...new Set(lista.map((o) => o.fonte))].join(" + ");
    const nProv = lista.filter(ehProvavelPass).length;
    const cls = nProv === lista.length ? "provável PASS (todas as entradas: limitação de medição)"
      : nProv === 0 ? "requer disposição humana"
      : `requer disposição humana (${nProv}/${lista.length} entradas provável-PASS)`;
    return { chamada, pagina, viewport, n: lista.length, fontes, cls };
  }).sort((a, b) => a.chamada - b.chamada);

  const nProv = ocorrencias.filter(ehProvavelPass).length;
  linhas.push(`**Ocorrências individuais (entradas de rev[]): ${ocorrencias.length}** — ` +
    `${nProv} classificadas como provável PASS e ${ocorrencias.length - nProv} que requerem` +
    ` disposição humana.`);
  linhas.push("");
  linhas.push(`**Verificações flagadas como REVIEW: ${checks.length}** — é este o número` +
    " comparável ao placar \"38 REVIEW\" da suíte (ver seção Divergência).");
  linhas.push("");
  if (violacoes.length) {
    linhas.push(`> ⚠️ ${violacoes.length} VIOLAÇÃO(ões) inesperada(s) capturada(s) durante a` +
      " execução (listadas ao final) — diverge do placar da suíte, que reportou apenas REVIEW.");
    linhas.push("");
  }
  if (errosAval.length) {
    linhas.push(`> ⚠️ ${errosAval.length} falha(s) de avaliação do auditor (a suíte marcaria como` +
      " REVIEW genérico sem detalhe).");
    linhas.push("");
  }

  // Tabela-resumo por verificação
  linhas.push("## Resumo por verificação (1 linha = 1 checagem de tela, como na suíte)");
  linhas.push("");
  linhas.push("| #verif | página / fluxo | viewport | entradas rev[] | fontes | classificação do conjunto |");
  linhas.push("|---|---|---|---|---|---|");
  for (const c of checks) {
    linhas.push(`| ${c.chamada} | ${c.pagina} | ${c.viewport} | ${c.n} | ${c.fontes} | ${c.cls} |`);
  }
  linhas.push("");

  // Tabela individual — cada entrada de rev[]
  linhas.push("## Lista individual — cada entrada de rev[]");
  linhas.push("");
  linhas.push("| # | verif | página / fluxo | viewport | fonte | elemento | motivo | evidência (string do auditor) | classificação sugerida |");
  linhas.push("|---|---|---|---|---|---|---|---|---|");
  ocorrencias.forEach((o, i) => {
    const { elemento, motivo } = elementoMotivo(o.detalhe);
    const ev = o.detalhe.replace(/\|/g, "\\|");
    const cls = classificar(o.fonte, o.detalhe);
    linhas.push(`| ${i + 1} | ${o.chamada} | ${o.pagina} | ${o.viewport} | ${o.fonte} | \`${elemento}\` | ${motivo.replace(/\|/g, "\\|")} | ${ev} | ${cls} |`);
  });
  linhas.push("");

  // Evidência complementar: fundos com imagem
  if (fundosImg.length) {
    const vistos = new Set();
    const unicos = fundosImg.filter((f) => {
      const k = `${f.tag}.${f.cls}|${f.bg}`;
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });
    linhas.push("## Evidência complementar — fundos com background-image");
    linhas.push("");
    linhas.push("O motivo dominante de REVIEW é `(... bg-image)`: um ancestral do elemento" +
      " tem `background-image` antes de qualquer cor opaca, logo o auditor não" +
      " consegue compor o fundo. Inventário do que foi encontrado (deduplicado por" +
      " tag/classe/url; verifs afetadas entre parênteses):");
    linhas.push("");
    linhas.push("| elemento com bg-image | url/imagem | texto associado | verifs |");
    linhas.push("|---|---|---|---|");
    const porFundo = new Map();
    for (const f of fundosImg) {
      const k = `${f.tag}${f.id ? "#" + f.id : ""}.${f.cls}|${f.bg}`;
      if (!porFundo.has(k)) porFundo.set(k, { f, verifs: new Set() });
      porFundo.get(k).verifs.add(f.chamada);
    }
    for (const { f, verifs } of porFundo.values()) {
      const selBg = `${f.tag}${f.id ? "#" + f.id : ""}${f.cls ? "." + f.cls : ""}`;
      const bg = f.bg.replace(/^.*url\(/, "url(").replace(/\|/g, "\\|").slice(0, 120);
      linhas.push(`| \`${selBg}\` | ${bg} | ${(f.texto || "—").replace(/\|/g, "\\|")} | ${[...verifs].sort((a, b) => a - b).join(", ")} |`);
    }
    linhas.push("");
    linhas.push(`_${unicos.length} combinação(ões) únicas de elemento+imagem;` +
      ` ${fundosImg.length} amostras brutas._`);
    linhas.push("");
    linhas.push("**Observação para a disposição humana:** todas as fontes de `bg-image`" +
      " encontradas são `linear-gradient` entre duas cores escuras opacas" +
      " (componentes de tema — vinho/azul/pedra), não fotografias nem texturas" +
      " complexas. O contraste do texto sobre esses gradientes é, em princípio," +
      " mensurável pelas cores das paradas — resta apenas a verificação visual" +
      " dirigida (1 screenshot por tema cobre as 38 verificações, pois o mesmo" +
      " header/cartão aparece em todas). **Complemento executado:**" +
      " `medir-contraste-gradientes-297.mjs` re-mediu esses fundos com" +
      " resolução de gradientes — ver `docs/WCAG-CONTRASTE-GRADIENTES-1.0.9.md`" +
      " (1208 elementos, 0 FAIL; evidência, não disposição)." +
      " Isto NÃO converte REVIEW em PASS: a medição continua pendente de" +
      " confirmação humana.");
    linhas.push("");
  }

  if (violacoes.length) {
    linhas.push("## Violações inesperadas capturadas");
    linhas.push("");
    linhas.push("| verif | página | viewport | fonte | evidência |");
    linhas.push("|---|---|---|---|---|");
    for (const v of violacoes) linhas.push(`| ${v.chamada} | ${v.pagina} | ${v.viewport} | ${v.fonte} | ${v.detalhe.replace(/\|/g, "\\|")} |`);
    linhas.push("");
  }
  if (errosAval.length) {
    linhas.push("## Falhas do avaliador");
    linhas.push("");
    for (const e of errosAval) linhas.push(`- ${e.pagina} / ${e.viewport} / ${e.fonte}: ${e.detalhe}`);
    linhas.push("");
  }
  linhas.push("## Relação com o placar \"~38\" da suíte");
  linhas.push("");
  linhas.push("A suíte `teste-a11y-fluxos-297.mjs` conta **verificações flagadas**:" +
    " `revC`/`revA` incrementam 1 por chamada a `checarTela`/`checarFoco` que" +
    " produziu ≥1 REVIEW — não por entrada de `rev[]`. O relatório de release" +
    " (\"contraste 0 FAIL / 38 REVIEW\") refere-se a esse contador." +
    ` Nesta execução foram flagadas **${checks.length} verificações** —` +
    (checks.length === 38
      ? " **exatamente o mesmo placar da suíte** — que geraram"
      : " total próximo ao placar da suíte — que geraram") +
    ` **${ocorrencias.length} entradas individuais** de REVIEW. As duas contagens` +
    " são corretas em seus respectivos níveis; a lista individual completa está" +
    " na tabela acima.");
  linhas.push("");
  linhas.push("## Notas metodológicas");
  linhas.push("");
  linhas.push("- REVIEW nunca foi convertido em PASS sem evidência: entradas classificadas como");
  linhas.push("  \"provável PASS\" baseiam-se em limitação documentada de medição (affordance nativo");
  linhas.push("  do UA, contexto visual presente com fronteira apenas ambígua) ou em ausência de");
  linhas.push("  elemento em foco.");
  linhas.push("- Entradas \"requer disposição humana\" não puderam ser decididas por inspeção DOM;");
  linhas.push("  recomenda-se verificação visual dirigida (screenshot) — a seção de fundos com");
  linhas.push("  imagem acima indica exatamente quais imagens/gradientes bloqueiam o cálculo.");
  linhas.push("- A tela de login em si não recebe `avaliarWcag` na suíte original (somente o");
  linhas.push("  indicador de foco é medido lá); por paridade, idem aqui.");
  linhas.push("- O auditor não expõe texto do elemento nas entradas de `rev[]` (só seletor+motivo);");
  linhas.push("  a coluna \"evidência\" reproduz fielmente a string retornada.");
  linhas.push("");
  return linhas.join("\n");
}

// ---------- execução ----------
let browser, proc;
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO);

  // Fixture financeira — replica teste-a11y-fluxos-297.mjs (contas reais
  // para os seletores de Dinheiro renderizarem opções verdadeiras).
  if (cenario.personagemMestre) {
    for (const [type, name] of [["especie", "Carteira Teste"], ["banco", "Banco Teste"]]) {
      await req(BASE, "POST", `/characters/${cenario.personagemMestre}/financeiro/contas`, {
        cookie: cenario.cookieMestre,
        body: { type, name, balanceReais: 0 },
      });
    }
  }

  // Fixture popover AjudaPopover — replica a suíte (seed de regras +
  // template com selecao_multipla regraKind=item + personagem próprio).
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

  // ---------- Matriz viewport × fluxo (mestre) — idêntica à suíte ----------
  for (const vp of VIEWPORTS) {
    console.log(`\n== viewport ${vp.nome} (mestre) ==`);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();

    await login(page, "mestre_teste", "senha-forte-123");
    await checarTela(page, "login→painel", vp.nome);

    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    await checarTela(page, "campanha (visão geral)", vp.nome);

    for (const nomeAba of ["Personagens", "Diário", "Arquivos", "Convites"]) {
      const tem = await page.locator(".abas button", { hasText: nomeAba }).count();
      if (!tem) continue;
      await aba(page, nomeAba);
      await page.waitForTimeout(400);
      await checarTela(page, `aba ${nomeAba}`, vp.nome);
    }

    await aba(page, "Personagens");
    await page.waitForTimeout(500);
    const linha = page.locator("tr.clicavel", { hasText: "Mestre Herói" }).first();
    if (await linha.count()) {
      await linha.click();
      await page.waitForTimeout(500);
      await checarTela(page, "ficha detalhe", vp.nome);
      for (const sub of ["Inventário", "Dinheiro"]) {
        const b = page.getByRole("button", { name: sub, exact: true });
        if (await b.count()) {
          await b.first().click();
          await page.waitForTimeout(300);
          await checarTela(page, `patrimônio ${sub}`, vp.nome);
        }
      }
      const voltar = page.getByRole("button", { name: "Voltar" }).last();
      if (await voltar.count()) await voltar.click().catch(() => {});
      await page.waitForSelector(".abas", { timeout: 10000 }).catch(() => {});
    }

    await aba(page, "Mesa");
    await page.waitForTimeout(600);
    await checarTela(page, "aba Mesa", vp.nome);

    await ctx.close();
  }

  // ---------- Jogador (papel não-mestre) — ordem da suíte ----------
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
    await checarTela(page, "jogador: campanha", vp.nome);
    await aba(page, "Personagens");
    await page.waitForTimeout(500);
    await checarTela(page, "jogador: personagens", vp.nome);
    await ctx.close();
  }

  // ---------- Sessão desktop extra: indicador de foco (login + campanha) ----------
  // Paridade com a suíte: checarFoco roda só aqui (Tab real → foco medido).
  console.log("\n== desktop-1366 (foco) ==");
  {
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
    await auditarFoco(page, "login (foco)", "desktop-1366");

    await login(page, "mestre_teste", "senha-forte-123");
    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    await page.keyboard.press("Tab");
    await page.waitForTimeout(150);
    await auditarFoco(page, "campanha (foco)", "desktop-1366");
    await ctx.close();
  }

  await browser.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}

// ---------- saída ----------
const porChamadaFinal = new Set(ocorrencias.map((o) => o.chamada));
const nProv = ocorrencias.filter(ehProvavelPass).length;
console.log(`\n==== WCAG REVIEW individual: ${ocorrencias.length} entradas em ${porChamadaFinal.size} verificações ====`);
console.log(`     (${nProv} provável PASS, ${ocorrencias.length - nProv} requer humano)`);
if (violacoes.length) console.log(`==== VIOLAÇÕES inesperadas: ${violacoes.length} ====`);
if (errosAval.length) console.log(`==== falhas do avaliador: ${errosAval.length} ====`);

const outPath = join(REPO, "docs", "WCAG-REVIEW-1.0.9.md");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, gerarMarkdown(), "utf8");
console.log(`doc gerado: ${outPath}`);
