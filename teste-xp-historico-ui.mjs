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
    setXp(charLongo, 450, Array.from({ length: 45 }, (_, i) =>
      ev("concessao", 10, `Evento ${i + 1}`, (i + 1) * 10, i + 1)));
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

  // ---------- 7. P3-1: resposta atrasada de A não sobrescreve B ----------
  // Determinístico: GET /progressao de A fica retido; troca para B;
  // B resolve; A é liberado por último. No SHA-base a resposta de A
  // sobrescreve o estado de B (falha); com a guarda de geração, é
  // descartada e o extrato final pertence somente a B.
  {
    const { ctx, page } = await novaPagina(cookieMestre);
    let liberarA;
    const travaA = new Promise((res) => { liberarA = res; });
    const padraoA = `**/characters/${charA}/progressao**`;
    await page.route(padraoA, async (route) => { await travaA; await route.continue(); });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Extrato XP" }).click();
    await page.getByRole("button", { name: "Personagens", exact: true }).click();
    await page.locator("tr.clicavel", { hasText: "Herói Ledger" }).click();
    await page.waitForSelector(".extrato-xp", { timeout: 15000 });
    // GET de A retido → volta à lista e abre B
    // detalhe do personagem (o "Voltar" do cabeçalho da campanha é o primeiro)
    await page.locator("button.secundario", { hasText: "Voltar" }).last().click();
    await page.locator("tr.clicavel", { hasText: "Sem Movimentos" }).waitFor({ timeout: 15000 });
    await page.locator("tr.clicavel", { hasText: "Sem Movimentos" }).click();
    await page.waitForSelector("text=XP disponíveis", { timeout: 15000 });
    // B (saldo 0, sem histórico) resolveu; agora libera A por último
    liberarA();
    await page.waitForTimeout(800);
    const txt = await page.locator(".extrato-xp").textContent();
    ok("UI. resposta atrasada de A descartada — extrato é de B",
      txt.includes("Nenhuma movimentação de XP registrada") && !txt.includes("Sessão 4"),
      txt.replace(/\s+/g, " ").slice(0, 90));
    await page.unroute(padraoA);
    await ctx.close();
  }

  // ---------- 7b. P3-1 (prova diferencial): resposta obsoleta via realtime ----------
  // A troca A→B desmonta o ExtratoXp, então o cenário acima não
  // reproduz o bug no SHA-base. A corrida real e alcançável é entre
  // cargas do MESMO personagem: mount + personagens:atualizados.
  // GET #1 é capturado com saldo 100 e retido; concessão real de +40
  // XP (saldo 140) emite o evento → GET #2 aplica 140; a resposta
  // velha de 100 chega por último e deve ser descartada pela guarda.
  {
    const { ctx, page } = await novaPagina(cookieMestre);
    // Toda resposta é capturada na hora (route.fetch) e a ENTREGA é
    // controlada por um portão individual — permite entregar a mais
    // velha por último, depois de todas as novas.
    const pendentes = []; // { resp, liberar, done }
    const padrao = `**/characters/${charLongo}/progressao**`;
    await page.route(padrao, async (route) => {
      const resp = await route.fetch();
      const j = await resp.json().catch(() => null);
      let liberar, done;
      const p = {
        j,
        liberar: () => liberar(),
        done: new Promise((res) => { done = res; }),
      };
      await new Promise((res) => { liberar = res; pendentes.push(p); });
      await route.fulfill({
        status: resp.status(),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(j ?? {}),
      });
      done();
    });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Extrato XP" }).click();
    await page.getByRole("button", { name: "Personagens", exact: true }).click();
    await page.locator("tr.clicavel", { hasText: "Histórico Longo" }).click();
    await page.waitForSelector(".extrato-xp", { timeout: 15000 });
    // GET #1 retido (capturou saldo 450). Muta o XP no banco e emite
    // personagens:atualizados via PATCH real → novas cargas capturam 490.
    const det = await req(BASE, "GET", `/characters/${charLongo}`, { cookie: cookieMestre });
    const upd = det.json?.personagem?.updatedAt;
    const w = abrirDb(BANCO);
    const row = w.prepare("select data from characters where id=?").get(charLongo);
    const d = JSON.parse(row.data);
    d.__xp.saldo = 490;
    d.__xp.historico.unshift({ em: new Date().toISOString(), tipo: "concessao", quantidade: 40, motivo: "corrida p3-1", autorId: "x", autorNome: "Mestre Teste", saldoResultante: 490 });
    w.prepare("update characters set data=? where id=?").run(JSON.stringify(d), charLongo);
    w.close();
    const g = await req(BASE, "PATCH", `/characters/${charLongo}`, {
      cookie: cookieMestre,
      body: { name: "Histórico Longo", baseUpdatedAt: upd },
    });
    ok("setup. PATCH emite personagens:atualizados", g.status === 200, `status=${g.status}`);
    // dá tempo do socket entregar o evento e a carga nova ser capturada
    // (pode haver capturas anteriores ao PATCH — a obsoleta é sempre a #1)
    await page.waitForTimeout(2000);
    ok("setup. carga nova capturada", pendentes.length >= 2, `n=${pendentes.length} saldos=${pendentes.map((p) => p.j?.xp?.saldo).join(",")}`);
    // entrega todas as respostas NOVAS (490) e espera os fulfills
    // completarem; a #1 (450) segue retida
    for (const p of pendentes.slice(1)) p.liberar();
    await Promise.all(pendentes.slice(1).map((p) => p.done));
    await page.waitForSelector("text=490 XP", { timeout: 15000 });
    // entrega a resposta OBSOLETA por último e espera o fulfill
    pendentes[0].liberar();
    await pendentes[0].done;
    await page.waitForTimeout(800);
    const txt = await page.locator(".extrato-xp").textContent();
    ok("UI. resposta obsoleta descartada — saldo permanece 490",
      txt.includes("490 XP") && !txt.includes("450 XP"),
      txt.replace(/\s+/g, " ").slice(0, 90));
    for (const p of pendentes) p.liberar();
    await page.unroute(padrao);
    await ctx.close();
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
