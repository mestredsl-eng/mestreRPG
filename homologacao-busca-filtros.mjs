// Homologação E2E — busca e filtros nas listagens (Personagens, Diário,
// Patrimônio: Equipamentos e Veículos). Servidor isolado + Playwright.
// Desktop (mestre) + mobile 390px (jogador). Somente frontend: toda a
// filtragem ocorre sobre dados já autorizados — nenhuma consulta extra.
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req, encerrarServidor, limparDir } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-hom-busca-"));
const BANCO = join(DIR, "mestre-rpg.db");
await prepararBanco(BANCO);
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
proc.stderr.on("data", (d) => process.stderr.write(d));
await esperarSaudavel(BASE, proc);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const browser = await chromium.launch();
try {
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Busca E2E",
    jogadores: { jogador1: "jogador_um", jogador2: "jogador_dois" },
  });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.jogador1.cookie, J2 = c.jogadores.jogador2.cookie;

  // ---- seeds via API (fluxo real) ----
  const alfa = (await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie: J1, body: { name: "E2E Alfa" } })).json?.personagem?.id;
  const beta = (await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie: J1, body: { name: "E2E Beta" } })).json?.personagem?.id;
  const gama = (await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie: J2, body: { name: "E2E Gama" } })).json?.personagem?.id;
  t("personagens seed", !!alfa && !!beta && !!gama);
  // arquiva Beta → só deve aparecer na visão de arquivados
  await req(BASE, "POST", `/characters/${beta}/arquivar`, { cookie: M });

  // anotações do mestre: pública, privada e uma importante de outra categoria
  const nPub = await req(BASE, "POST", `/campaigns/${CID}/anotacoes`, { cookie: M, body: { title: "E2E Nota Pública", content: "conteúdo marcador único zeta-9", kind: "diario", visibility: "publica", category: "pista" } });
  const nPriv = await req(BASE, "POST", `/campaigns/${CID}/anotacoes`, { cookie: M, body: { title: "E2E Segredo Mestre", content: "não deve vazar", kind: "diario", visibility: "privada", category: "segredo" } });
  const nImp = await req(BASE, "POST", `/campaigns/${CID}/anotacoes`, { cookie: M, body: { title: "E2E Importante", content: "lembrete omega", kind: "diario", visibility: "publica", category: "lembrete", important: true } });
  t("anotações seed", nPub.status === 201 && nPriv.status === 201 && nImp.status === 201, `${nPub.status}/${nPriv.status}/${nImp.status}`);

  // patrimônio no personagem do mestre (personagemMestre existe por padrão)
  const PC = c.personagemMestre;
  await req(BASE, "POST", `/characters/${PC}/equipamentos`, { cookie: M, body: { name: "Espada E2E", slot: "mão", equipped: true } });
  await req(BASE, "POST", `/characters/${PC}/equipamentos`, { cookie: M, body: { name: "Escudo E2E", description: "broquel reforçado" } });
  await req(BASE, "POST", `/characters/${PC}/veiculos`, { cookie: M, body: { name: "Moto E2E", kind: "motocicleta", brand: "Honda" } });
  await req(BASE, "POST", `/characters/${PC}/veiculos`, { cookie: M, body: { name: "Caminhão E2E", kind: "caminhao", plate: "AAA-0000" } });

  async function abrirCampanha(p, nomeCampanha) {
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Campanhas" }).click();
    await p.waitForTimeout(700);
    await p.locator(".cartao-campanha", { hasText: nomeCampanha }).first().click();
    await p.waitForTimeout(1000);
  }
  const NOME = "Campanha Busca E2E";

  // ---------- DESKTOP — mestre ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: M.split("=")[1], url: BASE }]);
    const p = await ctx.newPage();
    const erros = [];
    p.on("pageerror", (e) => erros.push(String(e)));

    // ===== Personagens =====
    sec("Desktop — Personagens");
    await abrirCampanha(p, NOME);
    await p.getByRole("button", { name: /Personagens/ }).click();
    await p.waitForTimeout(1000);
    const buscaP = p.getByLabel("Buscar personagem");
    const linhas = () => p.locator("tbody tr");

    await buscaP.fill("Alfa");
    await p.waitForTimeout(300);
    t("personagens: busca encontra por nome", (await linhas().count()) === 1 && (await linhas().first().innerText()).includes("E2E Alfa"));
    await buscaP.fill("inexistente-xyz");
    await p.waitForTimeout(300);
    t("personagens: busca sem resultado mostra vazio", (await p.getByText("Nenhum personagem corresponde à busca.").count()) > 0);
    await buscaP.fill("");

    // filtro de status: Beta está arquivado → não aparece na lista ativa
    t("personagens: arquivado fora da lista ativa", (await p.locator("tr", { hasText: "E2E Beta" }).count()) === 0);
    await p.getByLabel("Filtrar por status").selectOption("arquivado");
    await p.waitForTimeout(300);
    t("personagens: filtro arquivado na visão ativa zera", (await p.getByText("Nenhum personagem corresponde à busca.").count()) > 0);
    await p.getByLabel("Filtrar por status").selectOption("");
    await p.getByRole("button", { name: "Ver arquivados" }).click();
    await p.waitForTimeout(900);
    t("personagens: arquivado aparece na visão própria", (await p.locator("tr", { hasText: "E2E Beta" }).count()) === 1);
    await buscaP.fill("Beta");
    await p.waitForTimeout(300);
    t("personagens: busca funciona em arquivados", (await linhas().count()) === 1);
    await buscaP.fill("");
    // restauração continua funcionando pela lista filtrada
    await linhas().first().click();
    await p.waitForTimeout(1200);
    await p.getByRole("button", { name: "Restaurar", exact: true }).click();
    await p.waitForTimeout(400);
    await p.locator(".modal").getByRole("button", { name: "Restaurar", exact: true }).click();
    await p.waitForTimeout(1200);
    t("personagens: restaurar funciona após filtro", (await p.locator(".badge", { hasText: "Aprovada" }).count()) > 0 || (await p.locator(".badge", { hasText: "Rascunho" }).count()) > 0);
    const voltar = p.locator("section.cartao").filter({ has: p.locator("h2", { hasText: "E2E Beta" }) }).first().getByRole("button", { name: "Voltar" });
    await voltar.click();
    await p.waitForTimeout(900);
    await p.getByRole("button", { name: "Ver ativos" }).click();
    await p.waitForTimeout(900);

    // ===== Diário =====
    sec("Desktop — Diário");
    await p.getByRole("button", { name: /^Diário$/ }).click();
    await p.waitForTimeout(1000);
    const buscaD = p.getByLabel("Buscar anotação");
    t("diário: campo de busca presente", await buscaD.count() > 0);

    await buscaD.fill("zeta-9");
    await p.waitForTimeout(300);
    const itensVisiveis = () => p.locator(".lista-anotacoes > li");
    t("diário: busca por conteúdo encontra", (await p.locator(".lista-anotacoes", { hasText: "E2E Nota Pública" }).count()) > 0 && (await itensVisiveis().count()) === 1);
    await buscaD.fill("Nota Pública");
    await p.waitForTimeout(300);
    t("diário: busca por título encontra", (await p.locator(".lista-anotacoes", { hasText: "E2E Nota Pública" }).count()) > 0);
    await buscaD.fill("");
    // filtro visibilidade: só "publica" deve esconder a privada do mestre? (mestre vê tudo que é dele — a privada é dele também)
    await p.getByLabel("Filtrar por visibilidade").selectOption("publica");
    await p.waitForTimeout(300);
    t("diário: filtro visibilidade pública oculta privada", (await p.locator(".lista-anotacoes", { hasText: "E2E Segredo Mestre" }).count()) === 0 && (await p.locator(".lista-anotacoes", { hasText: "E2E Nota Pública" }).count()) > 0);
    await p.getByLabel("Filtrar por visibilidade").selectOption("privada");
    await p.waitForTimeout(300);
    t("diário: filtro privada mostra só a secreta", (await p.locator(".lista-anotacoes", { hasText: "E2E Segredo Mestre" }).count()) > 0 && (await p.locator(".lista-anotacoes", { hasText: "E2E Nota Pública" }).count()) === 0);
    await p.getByLabel("Filtrar por visibilidade").selectOption("");
    // categoria + importantes combinados
    await p.getByLabel("Filtrar por categoria").selectOption("lembrete");
    await p.getByLabel("Buscar anotação").fill("omega");
    await p.waitForTimeout(300);
    t("diário: busca+categoria combinam", (await p.locator(".lista-anotacoes", { hasText: "E2E Importante" }).count()) > 0 && (await itensVisiveis().count()) === 1);
    await p.getByLabel("Filtrar por categoria").selectOption("");
    await buscaD.fill("");
    await p.getByLabel("Importantes").check();
    await p.waitForTimeout(300);
    t("diário: filtro importantes", (await p.locator(".lista-anotacoes", { hasText: "E2E Importante" }).count()) > 0 && (await p.locator(".lista-anotacoes", { hasText: "E2E Nota Pública" }).count()) === 0);
    await p.getByLabel("Importantes").uncheck();
    // data: filtrar a partir de amanhã zera tudo
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await p.getByLabel("Filtrar a partir de").fill(amanha);
    await p.waitForTimeout(300);
    t("diário: filtro de data futuro zera", (await p.getByText("Nenhuma anotação corresponde aos filtros.").count()) > 0);
    await p.getByLabel("Filtrar a partir de").fill("");
    t("diário: limpar filtros restaura lista", (await p.locator(".lista-anotacoes", { hasText: "E2E Nota Pública" }).count()) > 0);

    // ===== Patrimônio: equipamentos e veículos =====
    sec("Desktop — Patrimônio");
    await p.getByRole("button", { name: /Personagens/ }).click();
    await p.waitForTimeout(900);
    await p.locator("tr", { hasText: "Mestre Herói" }).first().click();
    await p.waitForTimeout(1500);
    await p.getByRole("button", { name: "Equipamentos" }).click();
    await p.waitForTimeout(800);
    const buscaEq = p.getByLabel("Buscar equipamento");
    await buscaEq.fill("Espada");
    await p.waitForTimeout(300);
    t("equipamentos: busca encontra", (await p.locator(".tabela tbody tr", { hasText: "Espada E2E" }).count()) === 1 && (await p.locator(".tabela tbody tr").count()) === 1);
    await buscaEq.fill("zzz-nada");
    await p.waitForTimeout(300);
    t("equipamentos: busca sem resultado mostra vazio", (await p.getByText("Nenhum equipamento corresponde à busca.").count()) > 0);
    await buscaEq.fill("");
    await p.getByRole("button", { name: "Veículos" }).click();
    await p.waitForTimeout(700);
    const buscaV = p.getByLabel("Buscar veículo");
    await buscaV.fill("Honda");
    await p.waitForTimeout(300);
    t("veículos: busca por marca encontra", (await p.locator(".tabela tbody tr", { hasText: "Moto E2E" }).count()) === 1 && (await p.locator(".tabela tbody tr").count()) === 1);
    await p.getByLabel("Filtrar por tipo de veículo").selectOption("caminhao");
    await p.waitForTimeout(300);
    t("veículos: busca+tipo combinam", (await p.getByText("Nenhum veículo corresponde à busca.").count()) > 0);
    await p.getByLabel("Filtrar por tipo de veículo").selectOption("");
    await buscaV.fill("Caminhão");
    await p.waitForTimeout(300);
    t("veículos: busca por nome encontra", (await p.locator(".tabela tbody tr", { hasText: "Caminhão E2E" }).count()) === 1 && (await p.locator(".tabela tbody tr").count()) === 1);
    await buscaV.fill("");
    t("desktop: sem erros de página", erros.length === 0, erros.join(" | ").slice(0, 200));
    await ctx.close();
  }

  // ---------- MOBILE 390px — jogador2 (privacidade + responsivo) ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: J2.split("=")[1], url: BASE }]);
    const p = await ctx.newPage();
    const erros = [];
    p.on("pageerror", (e) => erros.push(String(e)));

    sec("Mobile — privacidade do diário + busca");
    await abrirCampanha(p, NOME);
    await p.getByRole("button", { name: /^Diário$/ }).click();
    await p.waitForTimeout(1000);
    // J2 não deve ver a anotação privada do mestre nem o segredo
    t("mobile: anotação privada do mestre invisível p/ J2", (await p.locator(".lista-anotacoes", { hasText: "E2E Segredo Mestre" }).count()) === 0);
    t("mobile: pública visível p/ J2", (await p.locator(".lista-anotacoes", { hasText: "E2E Nota Pública" }).count()) > 0);
    // busca no mobile filtra normalmente
    await p.getByLabel("Buscar anotação").fill("omega");
    await p.waitForTimeout(300);
    t("mobile: busca diário filtra", (await p.locator(".lista-anotacoes", { hasText: "E2E Importante" }).count()) > 0);
    await p.getByLabel("Buscar anotação").fill("");

    // personagens no mobile
    await p.getByRole("button", { name: /Personagens/ }).click();
    await p.waitForTimeout(900);
    await p.getByLabel("Buscar personagem").fill("Gama");
    await p.waitForTimeout(300);
    t("mobile: busca personagens filtra", (await p.locator("tbody tr").count()) === 1 && (await p.locator("tbody tr").first().innerText()).includes("E2E Gama"));
    // J2 não vê personagens de J1? (lista mostra todos os da campanha p/ jogador? verificar overflow apenas)
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    t("mobile: sem overflow horizontal (diário+personagens)", !overflow);
    t("mobile: sem erros de página", erros.length === 0, erros.join(" | ").slice(0, 200));
    await ctx.close();
  }

  console.log(`\n==== homologação busca-filtros: ${pass} ok, ${fail} falhas ====`);
} finally {
  await browser.close();
  await encerrarServidor(proc);
  limparDir(DIR);
}
process.exit(fail ? 1 : 0);
