// Homologação E2E — visibilidade de menus/abas/botões por papel (Issue #157).
// Prova em navegador real que jogador e espectador não veem controles que
// o servidor recusaria, e que mestre/admin mantém o escopo completo.
// Também verifica que o login de jogador não dispara chamadas a endpoints
// administrativos só porque componentes invisíveis montaram.
import { chromium } from "playwright";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { hashSenha } from "./servidor/dist/lib/password.js";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, encerrarServidor, limparDir, req,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("papeis-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let browser, proc;

async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("Campanha Papeis", { exact: true }).first().click();
}
const temBotao = (page, nome) => page.getByRole("button", { name: nome, exact: false }).count().then((c) => c > 0);
const temTexto = (page, txt) => page.getByText(txt, { exact: false }).count().then((c) => c > 0);

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Papeis", jogadores: { jogador1: "jogador_ui" } });
  const campId = c.campanhaId ?? c.campanha?.id ?? c.campId;
  // espectador dedicado: usuário novo + membership papel espectador
  const agora = Date.now();
  const especId = crypto.randomUUID();
  const hashEspec = await hashSenha("senha-jogador-123");
  const dbEspec = abrirDb(BANCO);
  dbEspec.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
    .run(especId, "espectador_ui", "Espectador UI", hashEspec, agora, agora);
  dbEspec.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
    .run(crypto.randomUUID(), campId, especId, agora, agora, agora);
  dbEspec.close();

  browser = await chromium.launch();
  const novoContexto = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
    return ctx.newPage();
  };

  sec("Jogador — menu global e campanha");
  const chamadasAdmin = [];
  {
    const page = await novoContexto();
    page.on("request", (r) => { if (/\/admin|\/api\/admin|is_admin|requireAdmin/i.test(r.url())) chamadasAdmin.push(r.url()); });
    await login(page, "jogador_ui", "senha-jogador-123");
    t("jogador não vê aba Administração", !(await temBotao(page, "Administração")));
    t("jogador vê Acervo (consulta permitida)", await temBotao(page, "Acervo"));
    t("jogador vê Guildas (escopo próprio)", await temBotao(page, "Guildas"));
    await page.getByRole("button", { name: "Acervo" }).click();
    await page.getByText("Acervo de Livros de Regras").waitFor({ timeout: 10000 });
    t("Acervo sem Importar JSON para não-admin", !(await temBotao(page, "Importar JSON")));
    t("Acervo sem Exportar acervo para não-admin", !(await temBotao(page, "Exportar acervo")));
    t("Acervo mostra aviso de somente leitura", await temTexto(page, "alterações exigem permissão de administrador"));
    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    for (const abaProibida of ["Fichas", "Regras", "Participantes", "Convites"]) {
      t(`jogador não vê aba ${abaProibida}`, !(await temBotao(page, abaProibida)));
    }
    for (const abaOk of ["Informações", "Mesa", "Personagens", "Diário", "Histórico", "Arquivos"]) {
      t(`jogador vê aba ${abaOk}`, await temBotao(page, abaOk));
    }
    t("jogador não vê Editar campanha", !(await temBotao(page, "Editar campanha")));
    await page.locator(".abas button", { hasText: "Diário" }).first().click();
    await page.waitForTimeout(600);
    t("jogador vê Nova anotação no Diário", await temBotao(page, "Nova anotação"));
    await page.locator(".abas button", { hasText: "Anotações do mestre" }).first().click();
    await page.waitForTimeout(600);
    t("jogador não vê Nova anotação do mestre", !(await temBotao(page, "Nova anotação do mestre")));
    t("nenhuma chamada a endpoint admin no login/navegação", chamadasAdmin.length === 0, chamadasAdmin.join(","));
    await page.context().close();
  }

  sec("Espectador — ainda mais restrito");
  {
    const page = await novoContexto();
    await login(page, "espectador_ui", "senha-jogador-123");
    t("espectador não vê Administração", !(await temBotao(page, "Administração")));
    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    for (const abaProibida of ["Fichas", "Regras", "Participantes", "Convites", "Personagens"]) {
      t(`espectador não vê aba ${abaProibida}`, !(await temBotao(page, abaProibida)));
    }
    t("espectador vê abas de leitura", await temBotao(page, "Mesa") && await temBotao(page, "Diário"));
    await page.locator(".abas button", { hasText: "Diário" }).first().click();
    await page.waitForTimeout(600);
    t("espectador não vê Nova anotação", !(await temBotao(page, "Nova anotação")));
    await page.context().close();
  }

  sec("Mestre/admin — escopo completo preservado");
  {
    const page = await novoContexto();
    await login(page, "mestre_teste", "senha-forte-123");
    t("mestre vê Administração", await temBotao(page, "Administração"));
    await page.getByRole("button", { name: "Administração" }).click();
    await page.waitForTimeout(800);
    t("Admin carrega seção do servidor", await temTexto(page, "Servidor"));
    await page.getByRole("button", { name: "Painel" }).click();
    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    for (const abaOk of ["Fichas", "Regras", "Participantes", "Convites"]) {
      t(`mestre vê aba ${abaOk}`, await temBotao(page, abaOk));
    }
    t("mestre vê Editar campanha", await temBotao(page, "Editar campanha"));
    await page.context().close();
  }

  sec("Mobile — mesmo gating (390px)");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await login(page, "jogador_ui", "senha-jogador-123");
    t("mobile: jogador sem Administração", !(await temBotao(page, "Administração")));
    await irCampanha(page);
    await page.waitForSelector(".abas", { timeout: 10000 });
    t("mobile: sem abas admin", !(await temBotao(page, "Regras")) && !(await temBotao(page, "Participantes")));
    await ctx.close();
  }


  sec("Diário — jogadorCompartilha (Issue #163 N3)");
  {
    const J1 = c.jogadores.jogador1.cookie;
    const API_N = `/campaigns/${campId}/anotacoes`;

    // Com a flag ligada (default), o jogador cria notas compartilhadas.
    const n1 = await req(BASE, "POST", API_N, { cookie: J1, body: { title: "Nota Compartilhada A", content: "segredo do grupo", kind: "diario", visibility: "mestre" } });
    const n2 = await req(BASE, "POST", API_N, { cookie: J1, body: { title: "Nota Compartilhada B", content: "para edição na UI", kind: "diario", visibility: "publica" } });
    t("flag on: jogador cria notas compartilhadas → 201", n1.status === 201 && n2.status === 201, `n1=${n1.status} n2=${n2.status}`);
    const notaA = n1.json?.id, notaB = n2.json?.id;

    // O mestre desliga o compartilhamento pela config da campanha.
    const cfg = await req(BASE, "PUT", `/campaigns/${campId}/regras/config`, { cookie: c.cookieMestre, body: { notas: { jogadorCompartilha: false } } });
    t("mestre desliga jogadorCompartilha → 200", cfg.status === 200, `status=${cfg.status} ${JSON.stringify(cfg.json).slice(0, 150)}`);

    // Negativas HTTP do backend com a flag desligada.
    for (const vis of ["mestre", "publica", "selecionada"]) {
      const r = await req(BASE, "POST", API_N, { cookie: J1, body: { title: "tentativa compartilhada", content: "x", kind: "diario", visibility: vis } });
      t(`flag off: POST visibility=${vis} → 403`, r.status === 403, `status=${r.status}`);
    }
    const rPriv = await req(BASE, "POST", API_N, { cookie: J1, body: { title: "Nota Privada OK", content: "x", kind: "diario", visibility: "privada" } });
    t("flag off: POST privada → 201", rPriv.status === 201, `status=${rPriv.status}`);

    // PATCH: elevar/manter compartilhamento → 403; rebaixar p/ privada → 200.
    const pElev = await req(BASE, "PATCH", `${API_N}/${notaA}`, { cookie: J1, body: { visibility: "publica" } });
    t("flag off: PATCH para compartilhada → 403", pElev.status === 403, `status=${pElev.status}`);
    const pDown = await req(BASE, "PATCH", `${API_N}/${notaA}`, { cookie: J1, body: { visibility: "privada" } });
    t("flag off: PATCH rebaixa para privada → 200", pDown.status === 200, `status=${pDown.status}`);

    // UI do jogador: seletor de visibilidade oferece só "Somente eu".
    {
      const page = await novoContexto();
      await login(page, "jogador_ui", "senha-jogador-123");
      await irCampanha(page);
      await page.locator(".abas button", { hasText: "Diário" }).first().click();
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: "Nova anotação", exact: true }).click();
      await page.waitForTimeout(400);
      const selVis = page.getByLabel("Visibilidade da anotação");
      const opcoes = await selVis.locator("option").allTextContents();
      t("flag off: jogador vê só 'Somente eu' no seletor", opcoes.length === 1 && /Somente eu/.test(opcoes[0] ?? ""), JSON.stringify(opcoes));
      // Editar nota compartilhada B → aviso explícito + salvar rebaixa p/ privada.
      await page.locator(".formulario").getByRole("button", { name: "Cancelar", exact: true }).click();
      await page.waitForTimeout(300);
      const itemB = page.locator("li", { hasText: "Nota Compartilhada B" }).first();
      await itemB.getByRole("button", { name: "Editar", exact: true }).click();
      await page.waitForTimeout(400);
      t("flag off: aviso de rebaixamento ao editar compartilhada", await temTexto(page, "não permite compartilhamento"));
      await page.locator(".formulario").getByRole("button", { name: "Salvar", exact: true }).click();
      await page.waitForTimeout(1200);
      const lst = await req(BASE, "GET", `${API_N}?tipo=diario`, { cookie: J1 });
      const notaEdit = (lst.json?.anotacoes ?? []).find((a) => a.id === notaB);
      t("flag off: edição rebaixou nota para privada", notaEdit?.visibility === "privada", `vis=${notaEdit?.visibility}`);
      await page.context().close();
    }

    // Mestre mantém as quatro opções mesmo com a flag desligada.
    {
      const page = await novoContexto();
      await login(page, "mestre_teste", "senha-forte-123");
      await irCampanha(page);
      await page.locator(".abas button", { hasText: "Diário" }).first().click();
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: "Nova anotação", exact: true }).click();
      await page.waitForTimeout(400);
      const opcoesM = await page.getByLabel("Visibilidade da anotação").locator("option").allTextContents();
      t("flag off: mestre mantém 4 opções de visibilidade", opcoesM.length === 4, JSON.stringify(opcoesM));
      await page.context().close();
    }
  }
  sec("Importar campanha — substituição só para mestre (Issue #157)");
  {
    const pacoteSub = {
      versao: 1, exportadoEm: new Date().toISOString(), campanhaId: campId,
      estado: { campanha: { name: "Qualquer" }, memberships: [], characters: [], files: [] },
      arquivos: {},
    };
    const arqPacote = join(DIR, "pacote-substituir.json");
    writeFileSync(arqPacote, JSON.stringify(pacoteSub));
    {
      const page = await novoContexto();
      await login(page, "jogador_ui", "senha-jogador-123");
      await page.getByRole("button", { name: "Campanhas" }).click();
      await page.getByText("Minhas campanhas").waitFor({ timeout: 10000 });
      await page.locator('input[type="file"][accept*="json"]').setInputFiles(arqPacote);
      await page.waitForTimeout(2500);
      t("jogador: erro de campanha existente exibido", await temTexto(page, "Já existe"));
      t("jogador: modal Substituir NÃO oferecido", !(await temTexto(page, "Deseja SUBSTITUIR")));
      await page.context().close();
    }
    {
      const page = await novoContexto();
      await login(page, "mestre_teste", "senha-forte-123");
      await page.getByRole("button", { name: "Campanhas" }).click();
      await page.getByText("Minhas campanhas").waitFor({ timeout: 10000 });
      await page.locator('input[type="file"][accept*="json"]').setInputFiles(arqPacote);
      await page.waitForTimeout(2500);
      t("mestre: modal Substituir oferecido", await temTexto(page, "Deseja SUBSTITUIR"));
      await page.context().close();
    }
  }
  console.log(`\n${pass} ok / ${fail} falhas`);
  if (fail > 0) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
