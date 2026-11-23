#!/usr/bin/env node
// Teste E2E UI — delta Playwright da Issue #291 (ciclo campanha/membros).
// Complementa teste-ciclo-campanha.mjs (API, #307): aqui só o que a TELA
// prova — aba Participantes (papel/status/remoção com confirmação), visão
// de espectador, revalidação de membro bloqueado/removido, reload e falha
// de rede sem estado falso. Reutiliza o harness de teste-xp-lote-ui.mjs.
// Campanha "concluída" é verificada só como status exibido — a política de
// escrita em campanha encerrada é achado de produto pendente (#307 S8),
// não contrato desta suíte.
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req, sessao, comDb, abrirDb,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

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
  // usuário novo SEM membership (só existe na campanha se aceitar convite)
  const novoUsuario = async (username) => {
    const id = randomUUID();
    const agora = Date.now();
    const db = abrirDb(BANCO);
    try {
      db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
        .run(id, username, username, await hashSenha("senha-jogador-123"), agora, agora);
    } finally { db.close(); }
    return { id, cookie: sessao(BANCO, id), username };
  };
  const criarConviteApi = async (dados) => {
    const r = await req(BASE, "POST", `/campaigns/${campId}/invitations`, { cookie: cookieMestre, body: dados });
    return r;
  };
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

  // ---------- U8 (S1): mestre cria campanha pelo formulário real ----------
  let campBId = null;
  {
    const cx = await ctx(cookieMestre);
    const p = await cx.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Campanhas" }).first().click();
    await p.getByRole("button", { name: "Nova campanha" }).click();
    await p.locator('label:has-text("Nome da campanha") input').fill("Campanha UI B");
    await p.locator('label:has-text("Sistema de RPG") input').fill("Sistema Teste");
    await p.getByRole("button", { name: "Criar campanha" }).click();
    // criar() navega direto para a campanha nova (aoAbrir) — prova na tela
    await p.locator(".abas").waitFor({ timeout: 15000 });
    const h2 = await p.locator("h2").first().textContent();
    ok("U8. campanha criada pela UI abre direto", /Campanha UI B/.test(h2 ?? ""), (h2 ?? "").slice(0, 60));
    const meta = await p.locator(".meta").first().textContent();
    ok("U8. criador é mestre da campanha criada pela UI", /Mestre/.test(meta ?? ""), (meta ?? "").slice(0, 60));
    campBId = comDb(BANCO, (db) => db.prepare("select id from campaigns where name='Campanha UI B'").get()?.id);
    ok("U8. campanha B persistida no banco", !!campBId);
    await cx.close();
  }

  // ---------- U9 (S2-UI): convite inválido, expirado, aprovação e corrida ----------
  {
    // inválido — anônimo
    const cxAnon = await browser.newContext();
    const pAnon = await cxAnon.newPage();
    await pAnon.goto(`${BASE}/convite?code=XXXX-XXXX-XXXX-XXXX`, { waitUntil: "networkidle" });
    await pAnon.waitForSelector(".erro", { timeout: 15000 });
    ok("U9. convite inexistente mostra erro na UI", /não encontrado|inválido/i.test(await pAnon.locator("body").textContent() ?? ""));
    await cxAnon.close();

    // expirado — autenticado
    const invExp = await criarConviteApi({ role: "jogador" });
    ok("U9. convite para expirar criado", invExp.status === 201, `status=${invExp.status}`);
    const codeExp = invExp.json?.convite?.code;
    { const w = abrirDb(BANCO); w.prepare("update invitations set expires_at=? where id=?").run(Date.now() - 1000, invExp.json.convite.id); w.close(); }
    const uExp = await novoUsuario("ui_expirado");
    {
      const cx = await ctx(uExp.cookie);
      const p = await cx.newPage();
      await p.goto(`${BASE}/convite?code=${codeExp}`, { waitUntil: "networkidle" });
      await p.waitForSelector("text=expirado", { timeout: 15000 });
      ok("U9. convite expirado exibido como inativo na UI", true);
      ok("U9. convite expirado sem botão Aceitar", await p.getByRole("button", { name: "Aceitar convite" }).count() === 0);
      await cx.close();
    }

    // requiresApproval → pendente → mestre aprova pela UI
    const invApr = await criarConviteApi({ role: "jogador", requiresApproval: true });
    const codeApr = invApr.json?.convite?.code;
    const uApr = await novoUsuario("ui_pendente");
    {
      const cx = await ctx(uApr.cookie);
      const p = await cx.newPage();
      await p.goto(`${BASE}/convite?code=${codeApr}`, { waitUntil: "networkidle" });
      await p.getByRole("button", { name: "Aceitar convite" }).click();
      await p.waitForSelector(".online", { timeout: 15000 });
      const msg = await p.locator(".online").textContent();
      ok("U9. aceite com aprovação retorna mensagem", !!msg && msg.length > 0, (msg ?? "").slice(0, 60));
      await cx.close();
    }
    const stPend = comDb(BANCO, (db) => db.prepare("select status from memberships where campaign_id=? and user_id=?").get(campId, uApr.id)?.status);
    ok("U9. aceite com aprovação gera membership pendente", stPend === "pendente", `status=${stPend}`);
    {
      const cx = await ctx(cookieMestre);
      const p = await cx.newPage();
      await abrirCampanha(p);
      await p.getByRole("button", { name: /Participantes/ }).click();
      await p.waitForSelector("text=Aguardando aprovação", { timeout: 15000 });
      const linhaPend = p.locator("tr", { hasText: "ui_pendente" }).first();
      await linhaPend.getByRole("button", { name: "Aprovar" }).click();
      await p.waitForTimeout(1000);
      const stDep = comDb(BANCO, (db) => db.prepare("select status from memberships where campaign_id=? and user_id=?").get(campId, uApr.id)?.status);
      ok("U9. mestre aprova pendente pela UI → ativo", stDep === "ativo", `status=${stDep}`);
      await cx.close();
    }

    // corrida: dois usuários aceitam o mesmo convite maxUses=1 pela UI
    const invCorr = await criarConviteApi({ role: "jogador", maxUses: 1 });
    const codeCorr = invCorr.json?.convite?.code;
    const uA = await novoUsuario("ui_corr_a");
    const uB = await novoUsuario("ui_corr_b");
    {
      const cxA = await ctx(uA.cookie);
      const cxB = await ctx(uB.cookie);
      const pA = await cxA.newPage();
      const pB = await cxB.newPage();
      await pA.goto(`${BASE}/convite?code=${codeCorr}`, { waitUntil: "networkidle" });
      await pB.goto(`${BASE}/convite?code=${codeCorr}`, { waitUntil: "networkidle" });
      await Promise.all([
        pA.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 15000 }),
        pB.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 15000 }),
      ]);
      await Promise.all([
        pA.getByRole("button", { name: "Aceitar convite" }).click(),
        pB.getByRole("button", { name: "Aceitar convite" }).click(),
      ]);
      // resultado: vencedor mostra .online (depois redireciona), perdedor .erro
      const detA = Promise.race([
        pA.waitForSelector(".online", { timeout: 20000 }).then(() => "online"),
        pA.waitForSelector(".erro", { timeout: 20000 }).then(() => "erro"),
      ]);
      const detB = Promise.race([
        pB.waitForSelector(".online", { timeout: 20000 }).then(() => "online"),
        pB.waitForSelector(".erro", { timeout: 20000 }).then(() => "erro"),
      ]);
      const [rA, rB] = await Promise.all([detA, detB]);
      const usos = comDb(BANCO, (db) => db.prepare("select uses from invitations where id=?").get(invCorr.json.convite.id)?.uses);
      const membros = comDb(BANCO, (db) => db.prepare("select count(*) n from memberships where campaign_id=? and user_id in (?,?) and status!='removido'").get(campId, uA.id, uB.id).n);
      ok("U9. corrida maxUses=1: exatamente um entra", usos === 1 && membros === 1 && [rA, rB].sort().join(",") === "erro,online", `usos=${usos} membros=${membros} telas=${rA}+${rB}`);
      await cxA.close(); await cxB.close();
    }
  }

  // ---------- U10 (S6-UI): isolamento — membro de B não vê campanha A ----------
  {
    // uBiso só participa da campanha B (membership direto, como fixture)
    const uIso = await novoUsuario("ui_so_b");
    const agora = Date.now();
    const db = abrirDb(BANCO);
    try {
      db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'jogador','ativo',?,?,?)")
        .run(randomUUID(), campBId, uIso.id, agora, agora, agora);
    } finally { db.close(); }
    const cx = await ctx(uIso.cookie);
    const p = await cx.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Campanhas" }).first().click();
    await p.waitForTimeout(1200);
    ok("U10. membro de B não vê campanha A na lista", await p.locator(".cartao-campanha", { hasText: "Campanha Ciclo UI" }).count() === 0);
    ok("U10. membro de B vê a própria campanha", await p.locator(".cartao-campanha", { hasText: "Campanha UI B" }).count() === 1);
    await cx.close();
  }

  // ---------- U11 (S7-UI): multi-aba — mudança reflete sem reload manual ----------
  {
    const cx = await ctx(cookieMestre);
    const p1 = await cx.newPage();
    const p2 = await cx.newPage();
    await abrirCampanha(p1);
    await p1.getByRole("button", { name: /Participantes/ }).click();
    await abrirCampanha(p2);
    await p2.getByRole("button", { name: /Participantes/ }).click();
    await p2.waitForSelector('select[aria-label="Status de ui_jogador2"]', { timeout: 15000 });

    // p1 bloqueia j2; p2 deve refletir via socket sem reload
    await p1.locator('select[aria-label="Status de ui_jogador2"]').first().selectOption("bloqueado");
    await p2.waitForFunction(() => {
      const s = document.querySelector('select[aria-label="Status de ui_jogador2"]');
      return s && s.value === "bloqueado";
    }, { timeout: 15000 }).then(() => ok("U11. multi-aba reflete bloqueio sem reload", true))
      .catch(() => ok("U11. multi-aba reflete bloqueio sem reload", false));

    // p1 restaura; p2 acompanha
    await p1.locator('select[aria-label="Status de ui_jogador2"]').first().selectOption("ativo");
    await p2.waitForFunction(() => {
      const s = document.querySelector('select[aria-label="Status de ui_jogador2"]');
      return s && s.value === "ativo";
    }, { timeout: 15000 }).then(() => ok("U11. multi-aba reflete desbloqueio sem reload", true))
      .catch(() => ok("U11. multi-aba reflete desbloqueio sem reload", false));

    // troca de campanha na mesma sessão: volta à home e abre B
    await p1.goto(BASE, { waitUntil: "networkidle" });
    await p1.getByRole("button", { name: "Campanhas" }).first().click();
    await p1.locator(".cartao-campanha", { hasText: "Campanha UI B" }).first().click();
    await p1.locator(".abas").waitFor({ timeout: 15000 });
    const metaB = await p1.locator(".meta").first().textContent();
    ok("U11. troca de campanha na mesma sessão funciona", /Mestre/.test(metaB ?? ""), (metaB ?? "").slice(0, 60));
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
