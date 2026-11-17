// Homologação visual — Painel de defeitos dos personagens na Mesa.
// Mestre vê o painel com nome do personagem, jogador, nível e descrição
// por nível (biblioteca da campanha); jogador não vê o painel; a lista
// atualiza em tempo real após edição da ficha (socket) sem recarregar.
import { chromium } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("defeitos-mesa-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

let browser, proc;
const errosConsole = [];
function vigiar(page, tag) {
  page.on("pageerror", (e) => errosConsole.push(`${tag}:pageerror:${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/401|Failed to load resource/.test(txt)) return;
    errosConsole.push(`${tag}:console:${txt.slice(0, 160)}`);
  });
}
async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irMesa(page, nomeCampanha = "Campanha Defeitos") {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(nomeCampanha, { exact: true }).first().click();
  await page.locator(".abas button", { hasText: "Mesa" }).first().click();
}
async function abrirSessao(page) {
  const linha = page.locator("tr.clicavel", { hasText: "Mesa Defeitos" });
  await linha.first().waitFor({ timeout: 15000 });
  await linha.first().click();
  await page.locator(".mesa-view").first().waitFor({ timeout: 15000 });
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Defeitos",
    jogadores: { jogador1: "jog_d1", jogador2: "jog_d2" },
  });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.jogador1.cookie;
  const J2 = c.jogadores.jogador2.cookie;

  // ---------- biblioteca da campanha (mesmos elementos da suíte HTTP) ----------
  const elemento = (kind, key, name, definition) =>
    req(BASE, "POST", `/campaigns/${CID}/regras/elementos`, { cookie: M, body: { kind, key, name, definition } });
  await elemento("defeito", "cegueira", "Cegueira", {
    niveis: [
      { descricao: "Cegueira nv1 — visão turva", custo: 1 },
      { descricao: "Cegueira nv2 — visão mínima", custo: 2 },
      { descricao: "Cegueira nv3 — cegueira total", custo: 3 },
    ],
    disponivel: true,
  });
  await elemento("defeito", "fobia_social", "Fobia social", {
    niveis: [
      { descricao: "Fobia nv1 — desconforto", custo: 1 },
      { descricao: "Fobia nv2 — evitação", custo: 2 },
    ],
    disponivel: true,
  });
  await elemento("poder", "foco", "Foco mental", { custoPontos: 2, disponivel: true });

  // ---------- modelo de ficha ----------
  const mod = await req(BASE, "POST", `/campaigns/${CID}/sheet-templates`, { cookie: M, body: { name: "Ficha Defeitos UI" } });
  const vid = mod.json.modelo.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{
      id: "s1", titulo: "Personagem", ordem: 0, campos: [
        { id: "fd-defeitos", label: "Defeitos", tipo: "selecao_nivel", regraKind: "defeito" },
        { id: "fd-poderes", label: "Poderes", tipo: "selecao_multipla", regraKind: "poder" },
      ],
    }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await req(BASE, "PUT", `/campaigns/${CID}/sheet-templates/${mod.json.modelo.id}/versions/${vid}`, { cookie: M, body: { estrutura } });
  await req(BASE, "POST", `/campaigns/${CID}/sheet-templates/${mod.json.modelo.id}/publish`, { cookie: M, body: { versionId: vid } });

  // ---------- personagens ----------
  const novoChar = async (cookie, name, data, extra = {}) => {
    const r = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
      cookie, body: { name, templateVersionId: vid, data, ...extra },
    });
    return r.json?.personagem?.id;
  };
  const ALPHA = await novoChar(J1, "Alpha", {
    "fd-defeitos": [{ key: "cegueira", nivel: 2 }],
  });
  const BETA = await novoChar(J2, "Beta", {
    "fd-defeitos": [{ key: "fobia_social", nivel: 1 }],
    "fd-poderes": ["foco"],
  });
  const VAZIO = await novoChar(J1, "Vazio", {});
  const NPC = await novoChar(M, "Bruto NPC", { "fd-defeitos": [{ key: "fobia_social", nivel: 2 }] }, { isNpc: true });
  t("personagens criados", !!(ALPHA && BETA && VAZIO && NPC));

  // sessão de mesa compartilhada
  const sess = await req(BASE, "POST", `/campaigns/${CID}/sessoes`, { cookie: M, body: { name: "Mesa Defeitos" } });
  t("sessão criada", sess.status === 200 || sess.status === 201, `status=${sess.status}`);

  browser = await chromium.launch();

  // ---------- mestre ----------
  sec("Mestre na Mesa");
  const ctxM = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pageM = await ctxM.newPage();
  vigiar(pageM, "mestre");
  await login(pageM, "mestre_teste", "senha-forte-123");
  await irMesa(pageM);
  await abrirSessao(pageM);

  const painel = pageM.locator("section.cartao", { hasText: "Defeitos dos personagens" });
  await painel.waitFor({ timeout: 15000 });
  t("painel visível para o mestre", await painel.isVisible());
  t("nome do painel correto", await painel.getByText("Defeitos dos personagens", { exact: true }).isVisible());

  // Alpha: nome + jogador + nível
  const blocoAlpha = painel.locator(".defeito-personagem", { hasText: "Alpha" });
  t("Alpha listado", await blocoAlpha.isVisible());
  t("Alpha mostra jogador", await blocoAlpha.getByText("Jogador: Jogador jogador1").isVisible());
  t("Alpha mostra Cegueira", await blocoAlpha.locator(".defeito-nome", { hasText: "Cegueira" }).count() === 1);
  t("Alpha mostra Nv. 2", await blocoAlpha.getByText("Nv. 2").isVisible());
  // descrição do nível: clicar no defeito expande
  await blocoAlpha.locator(".defeito-nome").first().click();
  t("descrição do nv2 exibida", await blocoAlpha.getByText("Cegueira nv2 — visão mínima").isVisible());

  // Beta: fobia nv1; poder NÃO aparece
  const blocoBeta = painel.locator(".defeito-personagem", { hasText: "Beta" });
  t("Beta listado com Fobia social", await blocoBeta.locator(".defeito-nome", { hasText: "Fobia social" }).count() === 1);
  t("poder 'Foco mental' ausente do painel", !(await blocoBeta.getByText("Foco mental").count()));

  // Vazio: mensagem clara
  const blocoVazio = painel.locator(".defeito-personagem", { hasText: "Vazio" });
  t("personagem sem defeitos mostra mensagem", await blocoVazio.getByText("Nenhum defeito registrado.").isVisible());

  // NPC separado
  t("seção NPCs presente", await painel.getByText("NPCs", { exact: true }).isVisible());
  const blocoNpc = painel.locator(".defeito-personagem", { hasText: "Bruto NPC" });
  t("NPC listado com defeito", await blocoNpc.locator(".defeito-nome", { hasText: "Fobia social" }).count() === 1);

  // recolher/expandir personagem
  await blocoAlpha.locator(".defeito-cabecalho").click();
  t("recolher esconde defeitos", !(await blocoAlpha.locator(".defeito-nome").count()));
  await blocoAlpha.locator(".defeito-cabecalho").click();
  t("expandir restaura defeitos", await blocoAlpha.locator(".defeito-nome").count() === 1);

  // ---------- atualização em tempo real ----------
  sec("Atualização via socket");
  await req(BASE, "PATCH", `/characters/${ALPHA}`, {
    cookie: J1, body: { data: { "fd-defeitos": [{ key: "cegueira", nivel: 3 }] } },
  });
  await pageM.getByText("Nv. 3", { exact: true }).waitFor({ timeout: 10000 });
  t("painel atualiza para Nv. 3 sem recarregar", await blocoAlpha.getByText("Nv. 3").isVisible());
  // o detalhe já estava aberto — a descrição deve acompanhar o novo nível
  t("descrição passa a ser a do nv3", await blocoAlpha.getByText("Cegueira nv3 — cegueira total").isVisible());

  // remoção do defeito some do painel
  await req(BASE, "PATCH", `/characters/${ALPHA}`, { cookie: J1, body: { data: { "fd-defeitos": [] } } });
  await blocoAlpha.getByText("Nenhum defeito registrado.").waitFor({ timeout: 10000 });
  t("remoção refletida no painel", await blocoAlpha.getByText("Nenhum defeito registrado.").isVisible());

  // ---------- restauração de snapshot com a Mesa aberta ----------
  // O painel deve reagir a `campanha:restaurada` — o snapshot substitui
  // o estado inteiro da campanha sem emitir personagens:/regras:.
  sec("Restauração de snapshot com a Mesa aberta");
  const snap = async (descricao) => {
    const r = await req(BASE, "POST", `/campaigns/${CID}/snapshots`, { cookie: M, body: { description: descricao } });
    t(`snapshot "${descricao}" criado`, r.status === 201 && !!r.json?.id, `status=${r.status}`);
    return r.json?.id;
  };
  const restaurar = async (id) => {
    const r = await req(BASE, "POST", `/campaigns/${CID}/snapshots/${id}/restaurar`, { cookie: M, body: { confirmacao: "RESTAURAR" } });
    t(`snapshot restaurado (${id?.slice(0, 8)})`, r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  };

  // estado A: cegueira nv1 -> snapshot; estado B: nv3; restaura A
  await req(BASE, "PATCH", `/characters/${ALPHA}`, { cookie: J1, body: { data: { "fd-defeitos": [{ key: "cegueira", nivel: 1 }] } } });
  await blocoAlpha.getByText("Nv. 1", { exact: true }).waitFor({ timeout: 10000 });
  const snapNv1 = await snap("defeitos-nv1");
  await req(BASE, "PATCH", `/characters/${ALPHA}`, { cookie: J1, body: { data: { "fd-defeitos": [{ key: "cegueira", nivel: 3 }] } } });
  await blocoAlpha.getByText("Nv. 3", { exact: true }).waitFor({ timeout: 10000 });
  t("antes da restauração: Nv. 3 visível", await blocoAlpha.getByText("Nv. 3").isVisible());
  await restaurar(snapNv1);
  await blocoAlpha.getByText("Nv. 1", { exact: true }).waitFor({ timeout: 15000 });
  t("após restaurar: painel volta a Nv. 1 sem recarregar", await blocoAlpha.getByText("Nv. 1").isVisible());
  t("após restaurar: descrição do nv1", await blocoAlpha.getByText("Cegueira nv1 — visão turva").isVisible());

  // sentido inverso: snapshot sem defeito -> restaura e o painel limpa
  await req(BASE, "PATCH", `/characters/${ALPHA}`, { cookie: J1, body: { data: { "fd-defeitos": [] } } });
  await blocoAlpha.getByText("Nenhum defeito registrado.").waitFor({ timeout: 10000 });
  const snapVazio = await snap("defeitos-vazio");
  await req(BASE, "PATCH", `/characters/${ALPHA}`, { cookie: J1, body: { data: { "fd-defeitos": [{ key: "cegueira", nivel: 2 }] } } });
  await blocoAlpha.getByText("Nv. 2", { exact: true }).waitFor({ timeout: 10000 });
  await restaurar(snapVazio);
  await blocoAlpha.getByText("Nenhum defeito registrado.").waitFor({ timeout: 15000 });
  t("restauração de snapshot sem defeito limpa o painel", await blocoAlpha.getByText("Nenhum defeito registrado.").isVisible());

  // ---------- jogador ----------
  sec("Jogador na Mesa");
  const ctxJ = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pageJ = await ctxJ.newPage();
  vigiar(pageJ, "jogador");
  await login(pageJ, "jog_d1", "senha-jogador-123");
  await irMesa(pageJ);
  await abrirSessao(pageJ);
  await pageJ.locator(".mesa-view").waitFor({ timeout: 15000 });
  t("jogador NÃO vê o painel de defeitos", !(await pageJ.getByText("Defeitos dos personagens").count()));

  // ---------- mobile ----------
  sec("Mobile");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageMob = await ctxMob.newPage();
  vigiar(pageMob, "mobile");
  await login(pageMob, "mestre_teste", "senha-forte-123");
  await irMesa(pageMob);
  await abrirSessao(pageMob);
  const painelMob = pageMob.locator("section.cartao", { hasText: "Defeitos dos personagens" });
  await painelMob.waitFor({ timeout: 15000 });
  t("painel visível no mobile", await painelMob.isVisible());
  t("sem overflow horizontal", await pageMob.evaluate(() =>
    document.scrollingElement.scrollWidth <= document.documentElement.clientWidth + 1));

  t("sem erros de console", errosConsole.length === 0, errosConsole.slice(0, 3).join(" | "));
  await ctxM.close(); await ctxJ.close(); await ctxMob.close();
} finally {
  await browser?.close().catch(() => {});
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
