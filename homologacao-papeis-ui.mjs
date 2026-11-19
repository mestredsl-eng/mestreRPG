// Homologação E2E — visibilidade de menus/abas/botões por papel (Issue #157).
// Prova em navegador real que jogador e espectador não veem controles que
// o servidor recusaria, e que mestre/admin mantém o escopo completo.
// Também verifica que o login de jogador não dispara chamadas a endpoints
// administrativos só porque componentes invisíveis montaram.
import { chromium } from "playwright";
import { join } from "node:path";
import { hashSenha } from "./servidor/dist/lib/password.js";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, encerrarServidor, limparDir,
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
    for (const abaProibida of ["Fichas", "Regras", "Participantes", "Convites"]) {
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

  console.log(`\n${pass} ok / ${fail} falhas`);
  if (fail > 0) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
