// Homologação de navegador — Issue #124: painel de progressão XP na ficha.
// Cobre: saldo e histórico visíveis, preço calculado pelo servidor,
// compra com confirmação em dois passos, erro de saldo insuficiente,
// concessão de XP pelo mestre na UI, atualização em tempo real via
// socket e responsividade do painel.
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("progressao-ui");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;

const ESTRUTURA = {
  versao: 1,
  secoes: [{
    id: "s1", titulo: "Personagem", ordem: 0,
    campos: [
      { id: "f-forca", label: "Força", tipo: "inteiro", semantico: "atributo", regra: { kind: "atributo", key: "forca" } },
      { id: "f-habs", label: "Habilidades", tipo: "selecao_multipla", semantico: "habilidade", regraKind: "habilidade" },
    ],
  }],
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
};

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Progressão UI",
    jogadores: { jogador1: "prog_j1" },
    ficha: false,
  });
  const ids = { camp: cenario.campId, cm: cenario.cookieMestre, j1: cenario.jogadores.jogador1 };

  // Biblioteca: forca custo fixo 2, manipulacao custo fixo 3
  const API = `/campaigns/${ids.camp}/regras/elementos`;
  await req(BASE, "POST", API, { cookie: ids.cm, body: { kind: "atributo", key: "forca", name: "Força", definition: { custoPontos: 2, disponivel: true } } });
  await req(BASE, "POST", API, { cookie: ids.cm, body: { kind: "habilidade", key: "manipulacao", name: "Manipulação", definition: { custoPontos: 3, disponivel: true } } });

  // Template + personagem do jogador via API real
  const mod = await req(BASE, "POST", `/campaigns/${ids.camp}/sheet-templates`, { cookie: ids.cm, body: { name: "Ficha Prog" } });
  const tid = mod.json.modelo.id, vid = mod.json.modelo.versionId;
  await req(BASE, "PUT", `/campaigns/${ids.camp}/sheet-templates/${tid}/versions/${vid}`, { cookie: ids.cm, body: { estrutura: ESTRUTURA } });
  await req(BASE, "POST", `/campaigns/${ids.camp}/sheet-templates/${tid}/publish`, { cookie: ids.cm, body: { versionId: vid } });
  const pj = await req(BASE, "POST", `/campaigns/${ids.camp}/characters`, {
    cookie: ids.j1.cookie, body: { name: "Herói Prog", templateVersionId: vid, data: {} },
  });
  const CHAR = pj.json?.personagem?.id ?? pj.json?.id;
  t("personagem criado", !!CHAR, JSON.stringify(pj.json).slice(0, 150));

  // XP inicial via API (5): manipulação custa 3, força custa 2
  const xp0 = await req(BASE, "POST", `/characters/${CHAR}/xp`, {
    cookie: ids.cm, body: { acao: "conceder", quantidade: 5, motivo: "sessão inaugural" },
  });
  t("XP concedido via API", xp0.status === 200 && xp0.json?.xp?.saldo === 5, `status=${xp0.status}`);

  const browser = await chromium.launch();
  const errosUi = [];

  async function novaPagina(cookieStr, viewport) {
    const ctx = await browser.newContext({ viewport: viewport ?? { width: 1400, height: 900 } });
    const [nome, valor] = cookieStr.split("=");
    await ctx.addCookies([{ name: nome, value: decodeURIComponent(valor), url: BASE }]);
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => errosUi.push(String(e)));
    return { ctx, pg };
  }

  async function abrirFicha(pg, nomePersonagem) {
    await pg.goto(BASE, { waitUntil: "networkidle" });
    await pg.getByRole("button", { name: "Campanhas" }).click();
    await pg.waitForTimeout(900);
    await pg.locator(".cartao-campanha", { hasText: "Campanha Progressão UI" }).first().click();
    await pg.waitForTimeout(1200);
    await pg.getByRole("button", { name: "Personagens" }).click();
    await pg.waitForTimeout(1200);
    await pg.locator("tr.clicavel", { hasText: nomePersonagem }).first().click();
    await pg.locator(".progressao-xp").waitFor({ state: "visible", timeout: 15000 });
  }

  sec("UI do jogador — saldo, compra e confirmação");
  {
    const { ctx, pg } = await novaPagina(ids.j1.cookie);
    await abrirFicha(pg, "Herói Prog");

    const painel = pg.locator(".progressao-xp");
    t("painel de progressão visível na ficha", await painel.isVisible());
    t("saldo 5 XP exibido", (await painel.textContent())?.includes("5"), (await painel.textContent())?.slice(0, 120));
    t("histórico mostra concessão", (await painel.textContent())?.includes("XP recebido"), "");
    t("Manipulação com custo 3", (await painel.locator("tr", { hasText: "Manipulação" }).textContent())?.includes("3"), "");

    // compra em dois passos: Comprar → Confirmar −3 XP
    const linhaManip = painel.locator("tr", { hasText: "Manipulação" });
    await linhaManip.getByRole("button", { name: "Comprar" }).click();
    await pg.waitForTimeout(300);
    t("confirmação exibida antes de gastar", await linhaManip.getByRole("button", { name: /Confirmar/ }).isVisible());
    await linhaManip.getByRole("button", { name: /Confirmar/ }).click();
    await pg.waitForFunction(
      () => /Compra/.test(document.querySelector(".progressao-xp")?.textContent ?? "")
        && /^\s*2\s*XP/.test(document.querySelector(".progressao-xp .progresso-saldo")?.textContent ?? ""),
      null, { timeout: 15000 });
    t("histórico registrou a compra e saldo virou 2", true);
    const saldoApos = await pg.locator(".progressao-xp .progresso-saldo").textContent();
    t("saldo caiu para 2 XP", saldoApos?.includes("2"), saldoApos);

    // compra da força (2 XP) → saldo 0; depois tentativa sem saldo
    const linhaForca = painel.locator("tr", { hasText: "Força" });
    await linhaForca.getByRole("button", { name: "Comprar" }).click();
    await linhaForca.getByRole("button", { name: /Confirmar/ }).click();
    await pg.waitForFunction(() => document.querySelector(".progressao-xp")?.textContent?.includes("saldo 0"), null, { timeout: 15000 }).catch(() => {});
    await pg.waitForTimeout(800);

    // agora qualquer compra falha por saldo — Manipulação já está nv.1 e
    // a seleção simples não avança; Força nv.1 → nv.2 custa 2 XP
    const saldoTxt = await pg.locator(".progressao-xp .progresso-saldo").textContent();
    t("saldo zerou após duas compras", /^\s*0\s*XP/.test(saldoTxt ?? ""), saldoTxt);
    const linhaForca2 = painel.locator("tr", { hasText: "Força" });
    const btnComprar = linhaForca2.getByRole("button", { name: "Comprar" });
    if (await btnComprar.count()) {
      await btnComprar.click();
      await linhaForca2.getByRole("button", { name: /Confirmar/ }).click();
      await pg.waitForTimeout(1200);
      const txtErro = await painel.textContent();
      t("saldo insuficiente mostra erro", /insuficiente/i.test(txtErro ?? ""), txtErro?.slice(0, 200));
    } else {
      t("botão Comprar ausente sem saldo (motivo visível)", (await linhaForca2.textContent())?.includes("XP insuficiente") ?? false, await linhaForca2.textContent());
    }
    await ctx.close();
  }

  sec("UI do mestre — concessão de XP e histórico");
  {
    const { ctx, pg } = await novaPagina(ids.cm);
    await abrirFicha(pg, "Herói Prog");
    const painel = pg.locator(".progressao-xp");
    t("mestre vê formulário de XP", await painel.getByLabel("Quantidade de XP").isVisible());
    await painel.getByLabel("Quantidade de XP").fill("7");
    await painel.getByLabel("Motivo do ajuste de XP").fill("bônus de fechamento");
    await painel.getByRole("button", { name: "Aplicar" }).click();
    await pg.waitForFunction(() => /saldo 7/.test(document.querySelector(".progressao-xp")?.textContent ?? ""), null, { timeout: 15000 });
    t("saldo subiu para 7 via UI do mestre", true);
    t("histórico mostra concessão do mestre", (await painel.textContent())?.includes("bônus de fechamento") ?? false, "");
    await ctx.close();
  }

  sec("Tempo real — jogador vê concessão sem recarregar");
  {
    const { ctx, pg } = await novaPagina(ids.j1.cookie);
    await abrirFicha(pg, "Herói Prog");
    const painel = pg.locator(".progressao-xp");
    // mestre concede via API enquanto o jogador está com a ficha aberta
    await req(BASE, "POST", `/characters/${CHAR}/xp`, {
      cookie: ids.cm, body: { acao: "conceder", quantidade: 4, motivo: "recompensa tempo real" },
    });
    await pg.waitForFunction(() => /saldo 11/.test(document.querySelector(".progressao-xp")?.textContent ?? ""), null, { timeout: 15000 });
    t("saldo atualizou para 11 sem reload", true);
    t("motivo do tempo real apareceu", (await painel.textContent())?.includes("recompensa tempo real") ?? false, "");
    await ctx.close();
  }

  sec("Responsividade do painel");
  {
    const { ctx, pg } = await novaPagina(ids.j1.cookie, { width: 390, height: 844 });
    await abrirFicha(pg, "Herói Prog");
    const painel = pg.locator(".progressao-xp");
    t("painel visível em viewport mobile", await painel.isVisible());
    t("tabela de elementos renderizada", await painel.locator("table.tabela").isVisible());
    await ctx.close();
  }

  t("sem erros de console/pageerror", errosUi.length === 0, errosUi.slice(0, 3).join(" | "));
  await browser.close();
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
