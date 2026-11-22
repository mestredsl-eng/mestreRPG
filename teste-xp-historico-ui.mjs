#!/usr/bin/env node
// Teste E2E do Extrato de XP somente-leitura (Mission 2 / Issue #185).
// Cobre: dono vê saldo+eventos, mestre vê de qualquer personagem,
// jogador não-dono e cross-campaign não acessam (403/404 API),
// ledger ausente/vazio, histórico longo com "Mostrar mais",
// quantidades negativas, ordenação recente-primeiro, ausência de IDs
// internos na UI e layout mobile. Servidor+SQLite+site descartáveis.
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  abrirDb, criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("xp-historico-ui");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const base = Date.now() - 86400000;
const ev = (tipo, quantidade, motivo, saldo, i, extra = {}) => ({
  em: new Date(base + i * 60000).toISOString(),
  tipo, quantidade, motivo, autorId: "autor-interno-secreto", autorNome: "Mestre Teste",
  saldoResultante: saldo, ...extra,
});

try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Extrato XP",
    jogadores: { j1: "jog_his1", j2: "jog_his2" },
  });
  const { campId, cookieMestre, jogadores, novoPersonagem, membMestre } = c;

  // charA (j1): saldo 100, histórico com negativo/ajuste/compra
  const charA = novoPersonagem(jogadores.j1.membershipId, "Herói Ledger");
  // charVazio (j2): sem __xp → estado vazio
  const charVazio = novoPersonagem(jogadores.j2.membershipId, "Sem Movimentos");
  // charLongo (mestre): 45 eventos → paginação
  const charLongo = novoPersonagem(membMestre, "Histórico Longo");
  // charAncora (j1): 501 eventos → ledger trunca em 500 + âncora
  const charAncora = novoPersonagem(jogadores.j1.membershipId, "Extrato Truncado");

  {
    const w = abrirDb(BANCO);
    const setXp = (id, saldo, historico) => {
      const p = w.prepare("select data from characters where id=?").get(id);
      const d = JSON.parse(p.data);
      d.__xp = { saldo, historico };
      w.prepare("update characters set data=? where id=?").run(JSON.stringify(d), id);
    };
    setXp(charA, 100, [
      ev("concessao", 50, "Início da campanha", 50, 1),
      ev("remocao", -30, "Correção de lançamento", 20, 2),
      ev("ajuste", -5, "Ajuste manual", 15, 3),
      ev("concessao", 85, "Sessão 4", 100, 4),
    ]);
    // 45 eventos com um negativo no índice 2: 10+10−10+42×10 = 430
    setXp(charLongo, 430, Array.from({ length: 45 }, (_, i) =>
      i === 2
        ? ev("remocao", -10, "Correção de lançamento", 10, i + 1)
        : ev("concessao", 10, `Evento ${i + 1}`, i === 0 ? 10 : i === 1 ? 20 : i * 10 - 10, i + 1)));
    // 501 eventos de +1 XP: saldo final 501; o evento #1 (descartado na
    // retenção) tinha saldoResultante 1 → âncora = 1 − 1 = 0? Não:
    // âncora = saldoResultante do 1º retido (evento #2 = 2) − qtd (1) = 1.
    setXp(charAncora, 501, Array.from({ length: 501 }, (_, i) =>
      ev("concessao", 1, `Mov ${i + 1}`, i + 1, i + 1)));
    // ancora explícita no formato do ledger: saldo anterior ao 1º
    // evento retido (o servidor só grava ancora quando > 0).
    {
      const p = w.prepare("select data from characters where id=?").get(charAncora);
      const d = JSON.parse(p.data);
      d.__xp = { ...d.__xp, historico: d.__xp.historico.slice(1), ancora: 1 };
      w.prepare("update characters set data=? where id=?").run(JSON.stringify(d), charAncora);
    }
    w.close();
  }

  // Segunda campanha criada pelo JOGADOR j1 — o mestre da campanha 1
  // NÃO é membro dela: leitura do personagem deve falhar (cross-campaign).
  const cookieJ1Par = `mestre_rpg_session=${jogadores.j1.cookie.split("=").pop()}`;
  const camp2 = await req(BASE, "POST", "/campaigns", {
    cookie: cookieJ1Par, body: { name: "Outra Campanha" },
  });
  const camp2Id = camp2.json?.campanha?.id;
  let charCamp2 = null;
  if (camp2Id) {
    const w = abrirDb(BANCO);
    const agora = Date.now();
    const memb2 = w.prepare("select id from memberships where campaign_id=? and user_id=?").get(camp2Id, jogadores.j1.id);
    charCamp2 = crypto.randomUUID();
    w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
      .run(charCamp2, camp2Id, memb2.id, null, "De Outra Campanha", JSON.stringify({ __xp: { saldo: 777, historico: [] } }), "{}", "aprovada", 0, agora, agora);
    w.close();
  }
  ok("setup. segunda campanha criada", !!camp2Id);

  const browser = await chromium.launch();
  const novaPagina = async (cookiePar) => {
    const ctx = await browser.newContext();
    const token = cookiePar.includes("=") ? cookiePar.split("=").slice(1).join("=") : cookiePar;
    await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
    return { ctx, page: await ctx.newPage() };
  };
  const abrirPersonagem = async (page, nomeCampanha, nomeChar) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: nomeCampanha }).click();
    await page.getByRole("button", { name: "Personagens", exact: true }).click();
    await page.locator("tr.clicavel", { hasText: nomeChar }).click();
    await page.waitForSelector(".extrato-xp, .cartao:has-text('Ficha')", { timeout: 15000 });
  };

  // ---------- 1. Dono vê extrato ----------
  {
    const { ctx, page } = await novaPagina(jogadores.j1.cookie);
    await abrirPersonagem(page, "Campanha Extrato XP", "Herói Ledger");
    await page.waitForSelector(".extrato-xp", { timeout: 15000 });
    await page.waitForSelector("text=XP disponíveis", { timeout: 15000 });
    const txt = await page.locator(".extrato-xp").textContent();
    ok("UI. dono vê saldo 100 XP", txt.includes("100") && txt.includes("XP disponíveis"));
    ok("UI. evento mais recente primeiro", txt.indexOf("Sessão 4") < txt.indexOf("Início da campanha"));
    ok("UI. quantidade negativa exibida", /-30 XP|-30 XP/.test(txt) && txt.includes("-30"));
    ok("UI. ajuste exibido", txt.includes("Ajuste"));
    ok("UI. motivo exibido", txt.includes("Correção de lançamento"));
    ok("UI. saldo resultante exibido", txt.includes("saldo 100"));
    ok("UI. autor por nome (não ID)", txt.includes("Mestre Teste") && !txt.includes("autor-interno-secreto"));
    await ctx.close();
  }

  // ---------- 2. Mestre vê extrato de personagem de jogador ----------
  {
    const { ctx, page } = await novaPagina(cookieMestre);
    await abrirPersonagem(page, "Campanha Extrato XP", "Herói Ledger");
    await page.waitForSelector(".extrato-xp", { timeout: 15000 });
    await page.waitForSelector("text=XP disponíveis", { timeout: 15000 });
    const txt = await page.locator(".extrato-xp").textContent();
    ok("UI. mestre vê extrato do jogador", txt.includes("100") && txt.includes("Sessão 4"));
    await ctx.close();
  }

  // ---------- 3. Jogador NÃO dono não vê o componente ----------
  {
    const { ctx, page } = await novaPagina(jogadores.j2.cookie);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Extrato XP" }).click();
    await page.getByRole("button", { name: "Personagens", exact: true }).click();
    // j2 só vê os próprios personagens — Herói Ledger não deve nem abrir
    const temHerói = await page.locator("tr.clicavel", { hasText: "Herói Ledger" }).count();
    ok("UI. jogador não vê personagem alheio na lista", temHerói === 0);
    // e mesmo forçando detalhe, ExtratoXp não monta para não-dono
    await ctx.close();
  }

  // ---------- 4. API: não-dono → 403; cross-campaign → 403/404 ----------
  {
    const r1 = await req(BASE, "GET", `/characters/${charA}/progressao`, {
      cookie: `mestre_rpg_session=${jogadores.j2.cookie.split("=").pop()}`,
    });
    ok("API. jogador não-dono → 403/404", r1.status === 403 || r1.status === 404, `status=${r1.status}`);
    const r2 = await req(BASE, "GET", `/characters/${charA}/progressao`, { cookie: cookieMestre });
    ok("API. mestre lê extrato", r2.status === 200 && r2.json?.xp?.saldo === 100);
    if (charCamp2) {
      const r3 = await req(BASE, "GET", `/characters/${charCamp2}/progressao`, { cookie: cookieMestre });
      ok("API. cross-campaign bloqueado", r3.status === 403 || r3.status === 404, `status=${r3.status}`);
    }
  }

  // ---------- 5. Ledger vazio ----------
  {
    const { ctx, page } = await novaPagina(jogadores.j2.cookie);
    await abrirPersonagem(page, "Campanha Extrato XP", "Sem Movimentos");
    await page.waitForSelector(".extrato-xp", { timeout: 15000 });
    await page.waitForSelector("text=XP disponíveis", { timeout: 15000 });
    await page.waitForSelector("text=XP disponíveis", { timeout: 15000 });
    const txt = await page.locator(".extrato-xp").textContent();
    ok("UI. ledger ausente → estado vazio", txt.includes("Nenhuma movimentação de XP registrada") && txt.includes("0"));
    await ctx.close();
  }

  // ---------- 6. Histórico longo → "Mostrar mais" ----------
  {
    const { ctx, page } = await novaPagina(cookieMestre);
    await abrirPersonagem(page, "Campanha Extrato XP", "Histórico Longo");
    await page.waitForSelector(".extrato-xp", { timeout: 15000 });
    await page.waitForSelector("text=XP disponíveis", { timeout: 15000 });
    const antes = await page.locator(".extrato-xp-evento").count();
    ok("UI. pagina inicial limitada a 20", antes === 20, `n=${antes}`);
    const btn = page.getByRole("button", { name: /Mostrar mais/ });
    ok("UI. botão Mostrar mais presente", await btn.count() === 1);
    await btn.click();
    await page.waitForTimeout(300);
    const depois = await page.locator(".extrato-xp-evento").count();
    ok("UI. Mostrar mais revela mais eventos", depois === 40, `n=${depois}`);
    // mais recente primeiro: Evento 45 antes de Evento 1
    const txt = await page.locator(".extrato-xp-lista").textContent();
    ok("UI. ordenação recente-primeiro", txt.indexOf("Evento 45") < txt.indexOf("Evento 1"));
    await ctx.close();
  }

  // ---------- 6b. Âncora de truncamento (>500 eventos) ----------
  // API: mestre e dono recebem xp.ancora; personagem sem truncamento
  // NÃO recebe o campo. UI: aviso visível só no truncado e some na
  // troca de personagem.
  {
    const rMestre = await req(BASE, "GET", `/characters/${charAncora}/progressao`, { cookie: cookieMestre });
    ok("API. mestre recebe ancora=1 no truncado", rMestre.status === 200 && rMestre.json?.xp?.ancora === 1, `status=${rMestre.status} ancora=${rMestre.json?.xp?.ancora}`);
    ok("API. histórico retido tem 500 eventos", rMestre.json?.xp?.historico?.length === 500, `n=${rMestre.json?.xp?.historico?.length}`);
    const rDono = await req(BASE, "GET", `/characters/${charAncora}/progressao`, {
      cookie: `mestre_rpg_session=${jogadores.j1.cookie.split("=").pop()}`,
    });
    ok("API. dono recebe ancora=1", rDono.status === 200 && rDono.json?.xp?.ancora === 1, `status=${rDono.status} ancora=${rDono.json?.xp?.ancora}`);
    const rSem = await req(BASE, "GET", `/characters/${charA}/progressao`, { cookie: cookieMestre });
    ok("API. sem truncamento → ancora ausente", rSem.status === 200 && !("ancora" in (rSem.json?.xp ?? {})), `ancora=${rSem.json?.xp?.ancora}`);

    const { ctx, page } = await novaPagina(jogadores.j1.cookie);
    await abrirPersonagem(page, "Campanha Extrato XP", "Extrato Truncado");
    await page.waitForSelector(".extrato-xp .extrato-xp-ancora", { timeout: 15000 });
    const aviso = await page.locator(".extrato-xp-ancora").textContent();
    ok("UI. aviso de truncamento visível", aviso.includes("500") && aviso.includes("1 XP"), aviso.slice(0, 120));
    // troca de personagem: aviso some no histórico íntegro
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Extrato XP" }).click();
    await page.getByRole("button", { name: "Personagens", exact: true }).click();
    await page.locator("tr.clicavel", { hasText: "Herói Ledger" }).click();
    await page.waitForSelector(".extrato-xp", { timeout: 15000 });
    await page.waitForSelector("text=XP disponíveis", { timeout: 15000 });
    ok("UI. aviso ausente em histórico íntegro", (await page.locator(".extrato-xp-ancora").count()) === 0);
    await ctx.close();
  }

  // ---------- 7. Resposta obsoleta — carga realtime sobrepõe inicial atrasada ----------
  // Determinístico: a PRIMEIRA resposta de /progressao do charA é
  // buscada no servidor (snapshot S1, saldo 100) mas a entrega ao
  // browser fica retida. Um POST /xp concede +25 → o servidor emite
  // personagens:atualizados → o Extrato recarrega (S2, saldo 125) e
  // renderiza. Só então S1 é entregue: sem guarda de geração o estado
  // regrediria para o snapshot velho; com a guarda, S1 é descartado.
  // Nota: a troca A→B por navegação desmonta o componente (Voltar →
  // lista → outro personagem), então o caminho obsoleto alcançável é
  // o de cargas sobrepostas do MESMO personagem via realtime.
  {
    // selo de pontos — pré-requisito do POST /xp (ficha_nao_selada)
    const w = abrirDb(BANCO);
    const row = w.prepare("select data from characters where id=?").get(charA);
    const d = JSON.parse(row.data);
    d.__pontos = { ...(d.__pontos ?? {}), selo: { em: new Date().toISOString(), autorId: "teste", autorNome: "Teste" } };
    w.prepare("update characters set data=? where id=?").run(JSON.stringify(d), charA);
    w.close();
    const { ctx, page } = await novaPagina(cookieMestre);
    // DUAS requisições iniciais de /progressao chegam (ExtratoXp +
    // ProgressaoXp montam juntas) — ambas ficam retidas com snapshot S1.
    let reqA = 0;
    const pendentes = [];
    await page.route("**/api/characters/*/progressao", async (route) => {
      if (!route.request().url().includes(charA)) { await route.continue(); return; }
      reqA += 1;
      if (reqA <= 2) {
        const resp = await route.fetch();       // snapshot S1 já no servidor
        pendentes.push({ route, resp });        // entrega retida
      } else {
        await route.continue();                 // recargas seguintes passam
      }
    });
    await abrirPersonagem(page, "Campanha Extrato XP", "Herói Ledger");
    await page.waitForSelector(".extrato-xp", { timeout: 15000 });
    for (let i = 0; i < 100 && pendentes.length < 2; i++) await page.waitForTimeout(50);
    ok("corrida. respostas iniciais de A interceptadas", pendentes.length === 2, `reqA=${reqA}`);
    // concessão de XP → personagens:atualizados → segunda carga (S2)
    const xp = await req(BASE, "POST", `/characters/${charA}/xp`, {
      cookie: cookieMestre,
      body: { acao: "conceder", quantidade: 25, motivo: "Corrida XP" },
    });
    ok("corrida. XP concedido", xp.status === 200, `status=${xp.status} body=${JSON.stringify(xp.json).slice(0,120)}`);
    await page.waitForSelector(".extrato-xp:has-text('125 XP disponíveis')", { timeout: 15000 });
    ok("corrida. UI mostra saldo novo (125) via realtime", true);
    // entrega as respostas obsoletas S1 por último
    for (const p of pendentes) await p.route.fulfill({ response: p.resp });
    await page.waitForTimeout(800);
    const txt = await page.locator(".extrato-xp").textContent();
    ok("corrida. resposta obsoleta não regride o saldo", txt.includes("125 XP disponíveis") && !txt.includes("100 XP disponíveis"), txt.slice(0, 140));
    ok("corrida. evento novo permanece (Corrida XP)", txt.includes("Corrida XP"));
    ok("corrida. histórico de S2 preservado (Sessão 4)", txt.includes("Sessão 4"));
    ok("corrida. sem erro residual", !(await page.locator(".extrato-xp .erro").count()));
    await ctx.close();
  }

  // ---------- 7. Acabamento visual — estilos dedicados extrato-xp-* ----------
  {
    const { ctx, page } = await novaPagina(jogadores.j1.cookie);
    await abrirPersonagem(page, "Campanha Extrato XP", "Herói Ledger");
    await page.waitForSelector(".extrato-xp .progresso-saldo", { timeout: 15000 });
    const estilo = (sel, prop) => page.locator(sel).first().evaluate((el, pr) => getComputedStyle(el)[pr], prop);
    ok("CSS. .extrato-xp-evento com borda lateral dedicada", parseFloat(await estilo(".extrato-xp-evento", "borderLeftWidth")) >= 3, await estilo(".extrato-xp-evento", "borderLeftWidth"));
    const saldoStrong = await estilo(".extrato-xp .progresso-saldo strong", "fontSize");
    ok("CSS. saldo em destaque (>1rem)", parseFloat(saldoStrong) > 16, saldoStrong);
    const metaSize = await estilo(".extrato-xp-evento .meta", "fontSize");
    ok("CSS. meta do evento menor (<=13px)", parseFloat(metaSize) <= 13, metaSize);
    // quantidade +/- com cores distintas (convenção do app)
    const qtdPos = await estilo(".extrato-xp-qtd.positivo", "color");
    const qtdNeg = await estilo(".extrato-xp-qtd.negativo", "color");
    ok("CSS. quantidade positiva/negativa com tons distintos", qtdPos !== qtdNeg && qtdPos !== "" && qtdNeg !== "", `pos=${qtdPos} neg=${qtdNeg}`);
    // botão Mostrar mais: fixture precisa ter >20 eventos — Herói Ledger
    // tem 4, então o foco é assertado em "Histórico Longo" (45 eventos,
    // membro do mestre). Assert incondicional: falha se o botão não existir.
    await ctx.close();
    const { ctx: ctx2, page: page2 } = await novaPagina(cookieMestre);
    await abrirPersonagem(page2, "Campanha Extrato XP", "Histórico Longo");
    await page2.waitForSelector(".extrato-xp", { timeout: 15000 });
    await page2.waitForSelector("text=XP disponíveis", { timeout: 15000 });
    const btn = page2.getByRole("button", { name: /Mostrar mais/ });
    const nBtn = await btn.count();
    // focusVisible:true força :focus-visible (foco de teclado) de forma determinística
    if (nBtn === 1) await btn.evaluate((el) => el.focus({ focusVisible: true }));
    const outline = nBtn === 1 ? await btn.evaluate((el) => getComputedStyle(el).outlineStyle) : "ausente";
    ok("CSS. botão Mostrar mais presente e com foco visível", nBtn === 1 && outline !== "none" && outline !== "ausente", `count=${nBtn} outline=${outline}`);
    await ctx2.close();
  }

  // ---------- 8. Mobile ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await abrirPersonagem(page, "Campanha Extrato XP", "Herói Ledger");
    await page.waitForSelector(".extrato-xp", { timeout: 15000 });
    await page.waitForSelector("text=XP disponíveis", { timeout: 15000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok("UI. mobile: extrato sem overflow horizontal", !overflow);
    await ctx.close();
  }

  await browser.close();
} finally {
  await encerrarServidor(proc).catch(() => {});
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length} passaram, ${falhas.length} falharam`);
limparDir(DIR);
process.exit(falhas.length ? 1 : 0);
