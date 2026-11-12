// Homologação E2E — exclusão e arquivamento de personagens.
// Servidor isolado (banco novo + migrations + build do site) + Playwright.
// Desktop (mestre): arquivar → lista de arquivados → restaurar → excluir
// com confirmação/ cancelamento. Mobile (jogador): botões conforme permissão.
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req, encerrarServidor, limparDir } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-hom-exc-"));
const BANCO = join(DIR, "mestre-rpg.db");
await prepararBanco(BANCO);
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
proc.stderr.on("data", (d) => process.stderr.write(d));
await esperarSaudavel(BASE, proc);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };

const browser = await chromium.launch();
try {
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Exclusão E2E",
    jogadores: { jogador1: "jogador_um" },
    config: { hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "ambos" } },
  });
  const CID = c.campId, M = c.cookieMestre, J = c.jogadores.jogador1.cookie;

  // personagem com HP para verificar que arquivado é somente leitura
  const CHARHP = c.novoPersonagem(c.jogadores.jogador1.membershipId, "E2E HP Arquivado", {
    __hp: { atual: 80, historico: [{ em: new Date().toISOString(), tipo: "dano", quantidade: -20, motivo: "teste", autorId: c.adminId, autorNome: "Mestre" }] },
  });
  await req(BASE, "POST", `/characters/${CHARHP}/arquivar`, { cookie: M });

  // personagens seed via API (fluxo real): um para o mestre operar, um p/ mobile
  const p1 = await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie: J, body: { name: "E2E Mestre Alvo" } });
  const CHAR1 = p1.json?.personagem?.id;
  const p2 = await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie: J, body: { name: "E2E Mobile Alvo" } });
  const CHAR2 = p2.json?.personagem?.id;
  t("personagens seed criados", !!CHAR1 && !!CHAR2 && !!CHARHP);

  async function entrarNaFicha(p, nomeCampanha, nomePersonagem) {
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Campanhas" }).click();
    await p.waitForTimeout(700);
    await p.locator(".cartao-campanha", { hasText: nomeCampanha }).first().click();
    await p.waitForTimeout(1000);
    await p.getByRole("button", { name: /Personagens/ }).click();
    await p.waitForTimeout(800);
    await p.locator("tr", { hasText: nomePersonagem }).first().click();
    await p.waitForTimeout(1200);
  }

  // ---------- DESKTOP — mestre ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: M.split("=")[1], url: BASE }]);
    const p = await ctx.newPage();
    const erros = [];
    p.on("pageerror", (e) => erros.push(String(e)));
    const NOME = "Campanha Exclusão E2E";

    await entrarNaFicha(p, NOME, "E2E Mestre Alvo");
    t("desktop: mestre vê botão Arquivar", await p.getByRole("button", { name: "Arquivar" }).count() > 0);
    t("desktop: mestre vê botão Excluir", await p.getByRole("button", { name: "Excluir", exact: true }).count() > 0);

    // arquivar com confirmação
    await p.getByRole("button", { name: "Arquivar" }).click();
    await p.waitForTimeout(400);
    t("desktop: modal de arquivar visível", await p.locator(".modal").isVisible().catch(() => false));
    await p.getByRole("button", { name: "Arquivar", exact: true }).last().click();
    await p.waitForTimeout(1200);
    t("desktop: voltou à lista após arquivar", await p.locator(".tabela").isVisible().catch(() => false));
    t("desktop: arquivado fora da lista ativa", (await p.locator("tr", { hasText: "E2E Mestre Alvo" }).count()) === 0);

    // lista de arquivados
    t("desktop: mestre vê Ver arquivados na lista", await p.getByRole("button", { name: "Ver arquivados" }).count() > 0);
    await p.getByRole("button", { name: "Ver arquivados" }).click();
    await p.waitForTimeout(900);
    t("desktop: Novo personagem oculto na lista de arquivados", (await p.getByRole("button", { name: /Novo personagem|Cancelar/ }).count()) === 0);
    const linhaArq = p.locator("tr", { hasText: "E2E Mestre Alvo" });
    t("desktop: arquivado aparece na lista própria", await linhaArq.count() === 1);
    t("desktop: badge Arquivado visível", (await linhaArq.innerText().catch(() => "")).includes("Arquivado"));
    t("desktop: status anterior exibido", (await linhaArq.innerText().catch(() => "")).includes("era Rascunho"));

    // abrir arquivado: somente leitura + Restaurar
    await linhaArq.click();
    await p.waitForTimeout(1200);
    t("desktop: meta de arquivado visível", await p.getByText(/Personagem arquivado/).count() > 0);
    t("desktop: sem Editar ficha em arquivado", (await p.getByRole("button", { name: "Editar ficha" }).count()) === 0);
    t("desktop: botão Restaurar visível", await p.getByRole("button", { name: "Restaurar" }).count() > 0);
    t("desktop: botões de status ocultos", (await p.getByRole("button", { name: "Aprovar" }).count()) === 0);

    // restaurar
    await p.getByRole("button", { name: "Restaurar" }).click();
    await p.waitForTimeout(400);
    await p.getByRole("button", { name: "Restaurar", exact: true }).last().click();
    await p.waitForTimeout(1200);
    t("desktop: status restaurado p/ rascunho", await p.locator(".badge", { hasText: "Rascunho" }).count() > 0);
    t("desktop: Editar ficha volta", await p.getByRole("button", { name: "Editar ficha" }).count() > 0);

    // ---- arquivado com HP: somente leitura em todos os controles ----
    const cabVoltar2 = p.locator("section.cartao").filter({ has: p.locator("h2", { hasText: "E2E Mestre Alvo" }) }).first();
    await cabVoltar2.getByRole("button", { name: "Voltar" }).click();
    await p.waitForTimeout(900);
    // ainda na visão de arquivados: abre o personagem com HP arquivado
    await p.locator("tr", { hasText: "E2E HP Arquivado" }).first().click();
    await p.waitForTimeout(1200);
    t("readonly: HP exibido", await p.locator(".hp-resumo").count() > 0);
    t("readonly: sem ações de HP", (await p.locator(".hp-acoes").count()) === 0);
    t("readonly: histórico de HP preservado", (await p.locator(".hp-historico").count()) > 0);
    t("readonly: painel de pontos do mestre oculto", (await p.locator(".painel-pontos").count()) === 0);
    t("readonly: Restaurar visível p/ mestre", await p.getByRole("button", { name: "Restaurar" }).count() > 0);
    // patrimônio — aba inventário
    t("readonly: sem Adicionar item", (await p.getByRole("button", { name: "Adicionar", exact: true }).count()) === 0);
    t("readonly: sem Equipar", (await p.getByRole("button", { name: "Equipar" }).count()) === 0);
    t("readonly: sem Transferir item", (await p.getByRole("button", { name: "Transferir", exact: true }).count()) === 0);
    // demais abas
    await p.getByRole("button", { name: "Equipamentos" }).click();
    await p.waitForTimeout(600);
    t("readonly: sem Adicionar equipamento", (await p.getByRole("button", { name: "Adicionar", exact: true }).count()) === 0);
    t("readonly: sem Equipar/Desequipar", (await p.getByRole("button", { name: /^(Equipar|Desequipar)$/ }).count()) === 0);
    await p.getByRole("button", { name: "Veículos" }).click();
    await p.waitForTimeout(600);
    t("readonly: sem Adicionar veículo", (await p.getByRole("button", { name: "Adicionar veículo" }).count()) === 0);
    // .perigo no escopo do Patrimônio (o Excluir do cabeçalho do personagem é legítimo)
    const pat = p.locator("section.cartao").filter({ has: p.locator("h3", { hasText: "Patrimônio" }) });
    t("readonly: sem remover veículo", (await pat.locator(".perigo").count()) === 0);
    await p.getByRole("button", { name: "Dinheiro" }).click();
    await p.waitForTimeout(800);
    t("readonly: sem Nova conta", (await p.getByRole("button", { name: "Nova conta" }).count()) === 0);
    t("readonly: sem Registrar movimentação", (await p.getByRole("button", { name: "Registrar" }).count()) === 0);
    t("readonly: sem Transferir PIX", (await p.getByRole("button", { name: /Transferir/ }).count()) === 0);
    t("readonly: histórico financeiro visível", await p.getByText("Histórico financeiro").count() > 0);

    // volta à lista de arquivados antes do fluxo de exclusão
    const cabVoltar3 = p.locator("section.cartao").filter({ has: p.locator("h2", { hasText: "E2E HP Arquivado" }) }).first();
    await cabVoltar3.getByRole("button", { name: "Voltar" }).click();
    await p.waitForTimeout(900);

    // excluir: cancelar não apaga; confirmar apaga
    // a visão ainda está em "arquivados" — volta para ativos
    const verAtivos = p.getByRole("button", { name: "Ver ativos" });
    if (await verAtivos.count() > 0) { await verAtivos.click(); await p.waitForTimeout(900); }
    const linha = p.locator("tr", { hasText: "E2E Mestre Alvo" }).first();
    try {
      await linha.click({ timeout: 8000 });
    } catch {
      console.log("  DEBUG body:", (await p.locator("body").innerText()).slice(0, 800));
      throw new Error("linha não encontrada");
    }
    await p.waitForTimeout(1200);
    await p.getByRole("button", { name: "Excluir", exact: true }).click();
    await p.waitForTimeout(400);
    const modalTxt = await p.locator(".modal").innerText().catch(() => "");
    t("desktop: confirmação de exclusão irreversível", modalTxt.includes("não poderá ser desfeita"), modalTxt.slice(0, 200));
    await p.getByRole("button", { name: "Cancelar" }).click();
    await p.waitForTimeout(500);
    t("desktop: cancelar exclusão mantém personagem", await p.getByRole("button", { name: "Excluir", exact: true }).count() > 0);
    await p.getByRole("button", { name: "Excluir", exact: true }).click();
    await p.waitForTimeout(400);
    await p.getByRole("button", { name: "Excluir definitivamente" }).click();
    await p.waitForTimeout(1400);
    t("desktop: personagem excluído some da lista", (await p.locator("tr", { hasText: "E2E Mestre Alvo" }).count()) === 0);
    t("desktop: sem erros de página", erros.length === 0, erros.join(" | ").slice(0, 200));
    await ctx.close();
  }

  // ---------- MOBILE — jogador ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: J.split("=")[1], url: BASE }]);
    const p = await ctx.newPage();
    const erros = [];
    p.on("pageerror", (e) => erros.push(String(e)));
    const NOME = "Campanha Exclusão E2E";

    await entrarNaFicha(p, NOME, "E2E Mobile Alvo");
    t("mobile: jogador vê Excluir no próprio rascunho", await p.getByRole("button", { name: "Excluir", exact: true }).count() > 0);
    t("mobile: jogador NÃO vê Arquivar", (await p.getByRole("button", { name: "Arquivar" }).count()) === 0);
    t("mobile: jogador NÃO vê Ver arquivados", (await p.getByRole("button", { name: "Ver arquivados" }).count()) === 0);

    // excluir o próprio rascunho pela UI
    await p.getByRole("button", { name: "Excluir", exact: true }).click();
    await p.waitForTimeout(400);
    t("mobile: modal de exclusão visível", await p.locator(".modal").isVisible().catch(() => false));
    await p.getByRole("button", { name: "Excluir definitivamente" }).click();
    await p.waitForTimeout(1400);
    t("mobile: personagem excluído some da lista", (await p.locator("tr", { hasText: "E2E Mobile Alvo" }).count()) === 0);
    const overflow = await p.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
    t("mobile: sem overflow horizontal", overflow === 0, `overflow=${overflow}`);
    t("mobile: sem erros de página", erros.length === 0, erros.join(" | ").slice(0, 200));
    await ctx.close();
  }
} finally {
  await browser.close();
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== homologação exclusão-personagem: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
