#!/usr/bin/env node
// Teste E2E UI — delta Playwright da Issue #291 (ciclo campanha/membros).
// Complementa teste-ciclo-campanha.mjs (API, #307): aqui só o que a TELA
// prova — aba Participantes (papel/status/remoção com confirmação), visão
// de espectador, revalidação de membro bloqueado/removido, reload e falha
// de rede sem estado falso. Reutiliza o harness de teste-xp-lote-ui.mjs.
// Campanha "concluída" é verificada só como status exibido — a política de
// escrita em campanha encerrada é achado de produto pendente (#307 S8),
// não contrato desta suíte.
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, comDb,
} from "./teste-base.mjs";

const DIR = dirTeste("ciclo-campanha-ui");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
await prepararBanco(BANCO);

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, {
  banco: BANCO,
  arquivos: `${DIR}/arq`,
  backups: `${DIR}/bks`,
});

let browser = null;
try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Ciclo UI",
    jogadores: { j1: "ui_jogador1", j2: "ui_jogador2" },
  });
  const { campId, cookieMestre, jogadores } = c;
  ok("cenário criado (admin + campanha + 2 jogadores)", !!cookieMestre && !!campId && !!jogadores.j1 && !!jogadores.j2);

  const cookieDe = (cookie) => cookie.split("=").slice(1).join("=");
  browser = await chromium.launch();
  const ctx = async (cookie) => {
    const cx = await browser.newContext();
    await cx.addCookies([{ name: "mestre_rpg_session", value: cookieDe(cookie), url: BASE }]);
    return cx;
  };
  const abrirCampanha = async (page, nome = "Campanha Ciclo UI", { tolerante = false } = {}) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: nome }).first().click();
    if (tolerante) {
      // membro bloqueado/removido: API nega → tela de erro sem .abas
      await page.locator(".abas, .cartao").first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(800);
    } else {
      await page.locator(".abas").waitFor({ timeout: 15000 });
    }
  };

  // ---------- U1: mestre gerencia participantes pela UI ----------
  {
    const cx = await ctx(cookieMestre);
    const p = await cx.newPage();
    await abrirCampanha(p);
    await p.getByRole("button", { name: /Participantes/ }).click();
    await p.waitForSelector("text=ui_jogador1", { timeout: 15000 });

    const linhas = await p.locator(".tabela-responsiva tbody tr").count();
    ok("U1. tabela lista mestre + 2 jogadores", linhas >= 3, `linhas=${linhas}`);

    // j2 → espectador via select de papel (renderização tabela)
    const selPapelJ2 = p.locator('select[aria-label="Papel de ui_jogador2"]').first();
    await selPapelJ2.selectOption("espectador");
    await p.waitForTimeout(800);
    ok("U1. papel de j2 mudou para espectador", (await selPapelJ2.inputValue()) === "espectador");
    // permissões de espectador aparecem (checkboxes chat/arquivos/histórico)
    const checks = await p.locator('.permissoes-membro input[type="checkbox"]').count();
    ok("U1. checkboxes de permissão de espectador visíveis", checks >= 3, `checks=${checks}`);

    // reload prova persistência server-side (SPA volta à home — re-navega)
    await p.reload({ waitUntil: "networkidle" });
    await abrirCampanha(p);
    await p.getByRole("button", { name: /Participantes/ }).click();
    await p.waitForSelector('select[aria-label="Papel de ui_jogador2"]', { timeout: 15000 });
    ok("U1. papel espectador persiste após reload", (await p.locator('select[aria-label="Papel de ui_jogador2"]').first().inputValue()) === "espectador");
    await cx.close();
  }

  // ---------- U2: espectador vê só o que o papel permite ----------
  {
    const cx = await ctx(jogadores.j2.cookie);
    const p = await cx.newPage();
    await abrirCampanha(p);
    const meta = await p.locator(".meta").first().textContent();
    ok("U2. espectador vê 'Você é Espectador'", /Espectador/.test(meta ?? ""), meta ?? "");
    ok("U2. espectador NÃO tem aba Personagens", await p.getByRole("button", { name: "Personagens", exact: true }).count() === 0);
    ok("U2. espectador NÃO tem abas de mestre", await p.getByRole("button", { name: /Participantes|Convites|Fichas|Regras/ }).count() === 0);
    ok("U2. espectador mantém abas de leitura", await p.getByRole("button", { name: "Diário" }).count() === 1);
    await cx.close();
  }

  // ---------- U3: jogador comum não vê gestão ----------
  {
    const cx = await ctx(jogadores.j1.cookie);
    const p = await cx.newPage();
    await abrirCampanha(p);
    ok("U3. jogador vê 'Você é Jogador'", /Jogador/.test(await p.locator(".meta").first().textContent() ?? ""));
    ok("U3. jogador tem aba Personagens", await p.getByRole("button", { name: "Personagens", exact: true }).count() === 1);
    ok("U3. jogador NÃO tem aba Participantes", await p.getByRole("button", { name: /Participantes/ }).count() === 0);
    await cx.close();
  }

  // ---------- U4: bloqueio revalida acesso na próxima carga ----------
  {
    const cxM = await ctx(cookieMestre);
    const pM = await cxM.newPage();
    await abrirCampanha(pM);
    await pM.getByRole("button", { name: /Participantes/ }).click();
    await pM.waitForSelector('select[aria-label="Status de ui_jogador1"]', { timeout: 15000 });
    await pM.locator('select[aria-label="Status de ui_jogador1"]').first().selectOption("bloqueado");
    await pM.waitForTimeout(800);
    ok("U4. status de j1 bloqueado na UI do mestre", (await pM.locator('select[aria-label="Status de ui_jogador1"]').first().inputValue()) === "bloqueado");

    const cxJ = await ctx(jogadores.j1.cookie);
    const pJ = await cxJ.newPage();
    await abrirCampanha(pJ, "Campanha Ciclo UI", { tolerante: true });
    // membro bloqueado: API nega → tela mostra erro/voltar, não estado falso
    const corpo = await pJ.locator("body").textContent();
    const negado = /Sem permissão|sem acesso|Erro/i.test(corpo ?? "");
    ok("U4. membro bloqueado vê negação (sem abas de campanha)", negado && (await pJ.locator(".abas").count()) === 0, (corpo ?? "").slice(0, 100));
    await cxJ.close();
    await cxM.close();
  }

  // ---------- U5: desbloqueio restaura; remoção corta acesso ----------
  {
    const cxM = await ctx(cookieMestre);
    const pM = await cxM.newPage();
    await abrirCampanha(pM);
    await pM.getByRole("button", { name: /Participantes/ }).click();
    await pM.waitForSelector('select[aria-label="Status de ui_jogador1"]', { timeout: 15000 });
    await pM.locator('select[aria-label="Status de ui_jogador1"]').first().selectOption("ativo");
    await pM.waitForTimeout(800);

    const cxJ = await ctx(jogadores.j1.cookie);
    const pJ = await cxJ.newPage();
    await abrirCampanha(pJ);
    ok("U5. membro desbloqueado volta a ver a campanha", await pJ.locator(".abas").count() === 1);

    // remoção via modal de confirmação — re-navega (reload volta à home)
    await abrirCampanha(pM);
    await pM.getByRole("button", { name: /Participantes/ }).click();
    await pM.waitForSelector('select[aria-label="Status de ui_jogador1"]', { timeout: 15000 });
    // botão Remover da linha de ui_jogador1 na tabela (cartões são ocultos no desktop)
    const linha = pM.locator(".tabela-responsiva tbody tr", { hasText: "ui_jogador1" }).first();
    await linha.getByRole("button", { name: "Remover" }).click();
    await pM.waitForSelector(".modal-fundo", { timeout: 10000 });
    const msgModal = await pM.locator(".modal-fundo").textContent();
    ok("U5. modal de remoção pede confirmação explícita", /Remover Jogador j1 da campanha\?/.test(msgModal ?? ""), (msgModal ?? "").slice(0, 80));
    await pM.locator(".modal-fundo").getByRole("button", { name: "Remover", exact: true }).click();
    await pM.waitForTimeout(1000);

    // reload na home: a campanha removida não deve mais aparecer na lista
    await pJ.goto(BASE, { waitUntil: "networkidle" });
    await pJ.getByRole("button", { name: "Campanhas" }).first().click();
    await pJ.waitForTimeout(1200);
    const aindaMembro = comDb(BANCO, (db) => db.prepare("select status from memberships where campaign_id=? and user_id=?").get(campId, jogadores.j1.id)?.status);
    ok("U5. remoção persistiu no banco (status removido)", aindaMembro === "removido", `status=${aindaMembro}`);
    const cardSumiu = await pJ.locator(".cartao-campanha", { hasText: "Campanha Ciclo UI" }).count();
    ok("U5. campanha removida some da lista do ex-membro", cardSumiu === 0, `cards=${cardSumiu}`);
    await cxJ.close();
    await cxM.close();
  }

  // ---------- U6: falha de rede não deixa estado falso ----------
  {
    const cx = await ctx(cookieMestre);
    const p = await cx.newPage();
    await p.route("**/api/campaigns/*/members", (r) => r.abort());
    await abrirCampanha(p);
    await p.getByRole("button", { name: /Participantes/ }).click();
    await p.waitForSelector(".erro", { timeout: 15000 });
    const erroTxt = await p.locator(".erro").first().textContent();
    ok("U6. falha em /members exibe erro na tela", !!erroTxt && erroTxt.length > 0, (erroTxt ?? "").slice(0, 60));
    // sem estado falso: tabela vazia não deve ser apresentada como "sem membros"
    const linhas = await p.locator(".tabela-responsiva tbody tr").count();
    ok("U6. falha não renderiza membros falsos", linhas === 0, `linhas=${linhas}`);
    await cx.close();
  }

  // ---------- U7: campanha concluída — status exibido (política de escrita é achado pendente) ----------
  {
    const cx = await ctx(cookieMestre);
    const p = await cx.newPage();
    await abrirCampanha(p);
    await p.getByRole("button", { name: "Editar campanha" }).click();
    await p.locator('label:has-text("Status") select').selectOption("concluida");
    await p.getByRole("button", { name: "Salvar" }).click();
    await p.waitForTimeout(1000);
    const corpo = await p.locator("body").textContent();
    ok("U7. status Concluída refletido na UI", /Concluída/.test(corpo ?? ""));
    await cx.close();
  }

  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações UI passaram`);
  if (falhas.length) { console.log("FALHAS:", falhas.map((f) => f.nome).join(" | ")); process.exitCode = 1; }
} finally {
  try { await browser?.close(); } catch {}
  await encerrarServidor(proc);
  limparDir(DIR);
}
