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
      { id: "f-habs", label: "Habilidades", tipo: "selecao_nivel", semantico: "habilidade", regraKind: "habilidade" },
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
    cookie: ids.j1.cookie,
    // Níveis iniciais ≥1: fora de "poder" o XP não adquire do zero
    // (aquisicao_nao_permitida) e selecao_nivel aceita {key, nivel}.
    body: {
      name: "Herói Prog", templateVersionId: vid,
      data: { "f-forca": 1, "f-habs": [{ key: "manipulacao", nivel: 1 }] },
    },
  });
  const CHAR = pj.json?.personagem?.id ?? pj.json?.id;
  t("personagem criado", !!CHAR, JSON.stringify(pj.json).slice(0, 150));

  // Ciclo real de selo: o mestre aprova (aplica __pontos.selo via
  // comSeloPontos), o XP é concedido com o selo existente e a ficha é
  // reaberta pelo fluxo real do mestre — o selo é preservado e a
  // ficha volta a ser editável para as compras do jogador.
  const ap = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: ids.cm, body: { status: "aprovada" } });
  t("ficha aprovada — selo de pontos aplicado", ap.status === 200, `status=${ap.status} ${JSON.stringify(ap.json).slice(0, 200)}`);

  // XP concedido DEPOIS do selo (ficha aprovada — ação do mestre).
  const xp0 = await req(BASE, "POST", `/characters/${CHAR}/xp`, {
    cookie: ids.cm, body: { acao: "conceder", quantidade: 5, motivo: "sessão inaugural" },
  });
  t("XP concedido via API com selo", xp0.status === 200 && xp0.json?.xp?.saldo === 5, `status=${xp0.status}`);

  // Reabertura real pelo mestre: aprovada → reaberta preserva o selo.
  const re = await req(BASE, "PATCH", `/characters/${CHAR}`, { cookie: ids.cm, body: { status: "reaberta" } });
  t("ficha reaberta pelo mestre", re.status === 200, `status=${re.status} ${JSON.stringify(re.json).slice(0, 200)}`);
  const det = await req(BASE, "GET", `/characters/${CHAR}`, { cookie: ids.j1.cookie });
  t("selo preservado após reabertura", det.json?.ficha?.pontosBonus?.selado === true, `selado=${det.json?.pontosBonus?.selado} status=${det.status}`);

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

    // agora qualquer compra falha por saldo — Manipulação já está nv.2 e
    // Força nv.2 → nv.3 custa 2 XP
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

  sec("BUG_0006 — erro de ação persiste após refresh de socket");
  {
    // Campo Força vira exclusivo do mestre via override → a compra do
    // jogador falha com 403 campo_nao_editavel (erro de ação real).
    const ov = await req(BASE, "PATCH", `/characters/${CHAR}`, {
      cookie: ids.cm, body: { overrides: { "f-forca": { editavelPor: "mestre" } } },
    });
    t("override editavelPor=mestre aplicado", ov.status === 200, `status=${ov.status}`);
    const { ctx, pg } = await novaPagina(ids.j1.cookie);
    await abrirFicha(pg, "Herói Prog");
    const painel = pg.locator(".progressao-xp");
    const linhaForca = painel.locator("tr", { hasText: "Força" });
    const btn = linhaForca.getByRole("button", { name: "Comprar" });
    if (await btn.count()) {
      await btn.click();
      await linhaForca.getByRole("button", { name: /Confirmar/ }).click();
      await pg.waitForFunction(
        () => /não|permite|editad|mestre/i.test(document.querySelector(".progressao-xp .ficha-aviso")?.textContent ?? "")
          || /não|permite|editad|mestre/i.test(document.querySelector(".progressao-xp")?.textContent ?? ""),
        null, { timeout: 15000 }).catch(() => {});
      await pg.waitForTimeout(600);
    }
    const txtErro = await painel.textContent();
    t("erro de compra exibido ao jogador", /não|permite|editad|mestre|insuficiente/i.test(txtErro ?? ""), txtErro?.slice(0, 250));
    // Socket: mestre concede XP → personagens:atualizados → carregar()
    // tem sucesso e NÃO pode apagar o erro de ação (BUG_0006).
    await req(BASE, "POST", `/characters/${CHAR}/xp`, {
      cookie: ids.cm, body: { acao: "conceder", quantidade: 3, motivo: "refresh socket" },
    });
    await pg.waitForFunction(() => /saldo 14/.test(document.querySelector(".progressao-xp")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});
    await pg.waitForTimeout(800);
    const txtDepois = await painel.textContent();
    t("erro persiste após refresh via socket", /não|permite|editad|mestre|insuficiente/i.test(txtDepois ?? ""), txtDepois?.slice(0, 300));
    // limpeza do override para não afetar outras verificações
    await req(BASE, "PATCH", `/characters/${CHAR}`, {
      cookie: ids.cm, body: { overrides: { "f-forca": { editavelPor: "ambos" } } },
    });
    await ctx.close();
  }

  sec("P1 — formulário sincroniza após conflito 409");
  {
    // Jogador abre a ficha e edita (rascunho local com snapshot velho).
    const { ctx, pg } = await novaPagina(ids.j1.cookie);
    await abrirFicha(pg, "Herói Prog");
    await pg.getByRole("button", { name: "Editar ficha" }).click();
    await pg.waitForTimeout(400);
    // Força (atributo) renderiza como seletor de bolinhas — o valor atual
    // aparece no span .seletor-valor dentro de #ficha-campo-f-forca.
    const campoForca = pg.locator("#ficha-campo-f-forca .seletor-valor");
    const valorAntigo = (await campoForca.textContent().catch(() => null))?.trim() ?? null;
    // Outra sessão (mestre via API) compra nível de Força com XP —
    // o snapshot do jogador fica desatualizado.
    const compraApi = await req(BASE, "POST", `/characters/${CHAR}/comprar-ponto`, {
      cookie: ids.cm, body: { kind: "atributo", key: "forca", nivelAlvo: 3 },
    });
    t("compra XP por outra sessão → 200", compraApi.status === 200, `status=${compraApi.status} ${JSON.stringify(compraApi.json).slice(0, 200)}`);
    // Jogador salva com o formulário antigo → 409 + sincronização.
    await pg.getByRole("button", { name: "Salvar", exact: true }).first().click();
    await pg.waitForTimeout(1500);
    const corpoFicha = await pg.locator("body").textContent();
    t("conflito 409 exibido ao usuário", /alterada|sincronizado|atualize|não foi possível/i.test(corpoFicha ?? ""), corpoFicha?.slice(0, 300));
    // Formulário resincronizado com o estado do servidor (Força=3).
    const valorNovo = (await campoForca.textContent().catch(() => null))?.trim() ?? null;
    t("campo Força resincronizado com o servidor", valorNovo === "3", `antes=${valorAntigo} depois=${valorNovo}`);
    // Novo salvamento com base atual funciona e preserva o nível pago.
    await pg.getByRole("button", { name: "Salvar", exact: true }).first().click();
    await pg.waitForTimeout(1500);
    const pgProg = await req(BASE, "GET", `/characters/${CHAR}/progressao`, { cookie: ids.j1.cookie });
    const elForca = (pgProg.json?.disponiveis ?? []).find((d) => d.key === "forca");
    t("nível comprado por XP permanece após salvar", elForca?.nivelAtual === 3, `nivel=${elForca?.nivelAtual}`);
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
