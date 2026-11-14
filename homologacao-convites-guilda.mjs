#!/usr/bin/env node
// Homologação dos convites internos de guilda (Issue #65 — frontend):
// seção de gestão na guilda (GM/ADMIN), link compartilhável
// /?conviteGuilda=<codigo>, preview sem consumo, aceite explícito,
// revogação, limites de uso/expiração e segurança visual.
// Requer a API de convites internos (branch feat/convites-internos-guilda-api).
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, sessao, encerrarServidor, limparDir,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("convites-guilda");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

let browser, proc;
const errosConsole = [];

function observar(page) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const loc = m.location()?.url ?? "";
    if (/Failed to load resource/.test(m.text()) && loc.includes("/api/")) return;
    errosConsole.push(m.text());
  });
  page.on("pageerror", (e) => errosConsole.push(String(e)));
}

async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
}
async function abrirGuilda(page, nome) {
  await page.getByRole("button", { name: "Guildas" }).click();
  // Desktop renderiza tabela; mobile (<=640px) esconde .tabela-responsiva
  // e exibe .registro-cartao — o seletor cobre os dois layouts.
  const item = page.locator("tr:visible, .registro-cartao:visible", { hasText: nome })
    .filter({ has: page.getByRole("button", { name: "Abrir" }) }).first();
  await item.getByRole("button", { name: "Abrir" }).click();
  await page.getByRole("heading", { name: /Membros/ }).waitFor({ timeout: 15000 });
}

/** Cria usuário avulso (sem membership de campanha) e devolve {id, cookie}. */
async function novoUsuario(username, displayName) {
  const uid = crypto.randomUUID();
  const hash = await hashSenha("senha-123");
  const db = abrirDb(BANCO);
  try {
    const agora = Date.now();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, username, displayName, hash, agora, agora);
  } finally { db.close(); }
  return { id: uid, username, cookie: sessao(BANCO, uid) };
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO, { jogadores: {}, ficha: false });

  // ---- atores ----
  const gmA = await novoUsuario("gm_guilda_a", "GM Guilda A");       // GM da guilda A (não-admin)
  const gmB = await novoUsuario("gm_guilda_b", "GM Guilda B");       // GM de OUTRA guilda
  const membroComum = await novoUsuario("membro_comum", "Membro Comum");
  const novato1 = await novoUsuario("novato_um", "Novato Um");
  const novato2 = await novoUsuario("novato_dois", "Novato Dois");
  const novato3 = await novoUsuario("novato_tres", "Novato Três");

  // guilda A criada pelo gmA via API (criador vira GM)
  const gA = await req(BASE, "POST", "/guildas", { cookie: gmA.cookie, body: { name: "Guilda Alfa", description: "teste" } });
  const guildaA = gA.json?.guilda?.id;
  t("GM cria guilda A", gA.status === 201 && !!guildaA, JSON.stringify(gA.json).slice(0, 200));
  const gB = await req(BASE, "POST", "/guildas", { cookie: gmB.cookie, body: { name: "Guilda Beta" } });
  const guildaB = gB.json?.guilda?.id;
  // membro comum adicionado à guilda A pelo GM
  const addM = await req(BASE, "POST", `/guildas/${guildaA}/membros`, { cookie: gmA.cookie, body: { username: "membro_comum" } });
  t("membro comum adicionado à guilda A", addM.status === 200 || addM.status === 201, `status=${addM.status}`);

  browser = await chromium.launch();

  sec("1-2. GM cria convite de uso único e copia o link");
  const ctxGM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgGM = await ctxGM.newPage();
  observar(pgGM);
  await login(pgGM, "gm_guilda_a", "senha-123");
  await abrirGuilda(pgGM, "Guilda Alfa");
  await pgGM.getByRole("heading", { name: "Convites internos" }).waitFor({ timeout: 15000 });
  t("seção Convites internos visível para GM", true);
  const secConvites = pgGM.locator("section.cartao").filter({ has: pgGM.getByRole("heading", { name: "Convites internos" }) });
  await secConvites.locator("select").nth(1).selectOption("1"); // Limite de usos = 1
  await pgGM.getByRole("button", { name: "Gerar convite" }).click();
  const inputLink = pgGM.locator('input[aria-label="Link do convite"]');
  try {
    await inputLink.waitFor({ timeout: 15000 });
  } catch (e) {
    const msgErro = await secConvites.locator(".erro").allTextContents().catch(() => []);
    const boundary = await pgGM.getByText("Algo deu errado").count();
    throw new Error(`link do convite não apareceu. erros na seção: ${msgErro.join(" | ") || "(nenhum)"} | boundary=${boundary} | console: ${errosConsole.slice(-3).join(" || ") || "(limpo)"}`);
  }
  const linkUnico = await inputLink.inputValue();
  t("link de convite gerado no formato /?conviteGuilda=", /\/\?conviteGuilda=.+/.test(linkUnico), linkUnico);
  await pgGM.getByRole("button", { name: "Copiar link" }).click();
  await pgGM.getByRole("button", { name: "Copiado!" }).waitFor({ timeout: 5000 });
  t("botão Copiar link confirma cópia", true);
  // código NÃO reaparece na listagem
  const codigo = linkUnico.split("conviteGuilda=")[1];
  const listaTexto = await pgGM.locator("section.cartao").last().innerText();
  t("código não é exposto na listagem de convites", !listaTexto.includes(codigo), codigo);

  sec("3-6. Preview, aceite e papel membro");
  const ctxN1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgN1 = await ctxN1.newPage();
  observar(pgN1);
  await login(pgN1, "novato_um", "senha-123");
  await pgN1.goto(linkUnico);
  await pgN1.getByRole("heading", { name: "Guilda Alfa" }).waitFor({ timeout: 15000 });
  t("preview exibe o nome da guilda", true);
  t("preview NÃO consumiu o convite (botão ainda ativo)",
    await pgN1.getByRole("button", { name: "Aceitar convite" }).count() > 0);
  await pgN1.getByRole("button", { name: "Aceitar convite" }).click();
  await pgN1.getByText(/entrou na guilda/i).waitFor({ timeout: 15000 });
  await pgN1.waitForTimeout(1800); // redirect pós-sucesso
  await pgN1.getByRole("button", { name: "Guildas" }).click();
  const linhaN1Lista = pgN1.locator("table.tabela tbody tr", { hasText: "Guilda Alfa" }).first();
  await linhaN1Lista.getByRole("button", { name: "Abrir" }).click();
  const linhaN1 = pgN1.locator("table.tabela tbody tr", { hasText: "novato_um" });
  await linhaN1.waitFor({ timeout: 15000 });
  t("novo membro aparece na lista como membro",
    (await linhaN1.innerText()).includes("Membro"), await linhaN1.innerText());
  t("novo membro NÃO recebeu papel GM", !(await linhaN1.innerText()).includes("GM"));

  sec("5. GM vê o novo membro coerentemente");
  await pgGM.reload();
  await abrirGuilda(pgGM, "Guilda Alfa");
  await pgGM.locator("table.tabela tbody tr", { hasText: "novato_um" }).waitFor({ timeout: 15000 });
  t("GM vê novato_um na lista de membros", true);

  sec("7. Reuso de convite de uso único é recusado");
  const ctxN2 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgN2 = await ctxN2.newPage();
  observar(pgN2);
  await login(pgN2, "novato_dois", "senha-123");
  await pgN2.goto(linkUnico);
  await pgN2.waitForTimeout(1500);
  const botaoN2 = await pgN2.getByRole("button", { name: "Aceitar convite" }).count();
  const erroN2 = await pgN2.locator(".erro").allTextContents();
  t("convite esgotado não oferece aceite", botaoN2 === 0 || /esgotado|inválido|expirado|revogado/i.test(erroN2.join(" ")), erroN2.join("|"));
  // aceite via API também deve falhar
  const reuso = await req(BASE, "POST", `/convites-guilda/${codigo}/aceitar`, { cookie: novato2.cookie });
  t("API recusa reuso de convite esgotado", reuso.status >= 400, `status=${reuso.status}`);

  sec("8-9. Convite expirado e revogado recusados");
  // expirado: cria via API e expira no banco
  const invExp = await req(BASE, "POST", `/guildas/${guildaA}/convites-internos`, { cookie: gmA.cookie, body: { validadeHoras: 1, maxUsos: 5 } });
  const codigoExp = invExp.json?.convite?.codigo;
  const idExp = invExp.json?.convite?.id;
  t("convite para expirar criado", !!codigoExp, JSON.stringify(invExp.json).slice(0, 150));
  {
    // Expira o convite direto no banco (a API não cria convites já vencidos).
    // Localiza tabela/coluna de expiração de forma tolerante ao schema.
    const db = abrirDb(BANCO);
    try {
      const tabelas = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
      const tabela = tabelas.find((x) => /guild/i.test(x) && /convite|invite/i.test(x))
        ?? tabelas.find((x) => /convite|invite/i.test(x));
      const colunas = tabela ? db.prepare(`pragma table_info(${tabela})`).all().map((c) => c.name) : [];
      const colExp = colunas.find((c) => /expir/i.test(c));
      if (tabela && colExp) {
        db.prepare(`update ${tabela} set ${colExp}=? where id=?`).run(Date.now() - 1000, idExp);
        t("convite expirado no banco", true, `${tabela}.${colExp}`);
      } else {
        t("convite expirado no banco", false, `tabela=${tabela} colunas=${colunas.join(",")}`);
      }
    } finally { db.close(); }
  }
  const prevExp = await req(BASE, "GET", `/convites-guilda/${codigoExp}`, { cookie: novato3.cookie });
  t("preview de convite expirado retorna status não-ativo",
    prevExp.status === 200 && prevExp.json?.convite?.status !== "ativo", JSON.stringify(prevExp.json).slice(0, 200));
  const accExp = await req(BASE, "POST", `/convites-guilda/${codigoExp}/aceitar`, { cookie: novato3.cookie });
  t("aceite de convite expirado recusado", accExp.status >= 400, `status=${accExp.status}`);

  // revogado: cria, revoga via API, tenta aceitar
  const invRev = await req(BASE, "POST", `/guildas/${guildaA}/convites-internos`, { cookie: gmA.cookie, body: { validadeHoras: 168, maxUsos: 5 } });
  const codigoRev = invRev.json?.convite?.codigo;
  const idRev = invRev.json?.convite?.id;
  const delRev = await req(BASE, "DELETE", `/guildas/${guildaA}/convites-internos/${idRev}`, { cookie: gmA.cookie });
  t("revogação via API aceita", delRev.status === 200 || delRev.status === 204, `status=${delRev.status}`);
  const accRev = await req(BASE, "POST", `/convites-guilda/${codigoRev}/aceitar`, { cookie: novato3.cookie });
  t("aceite de convite revogado recusado", accRev.status >= 400, `status=${accRev.status}`);

  sec("10. Convite multi-uso respeita o limite");
  const invMulti = await req(BASE, "POST", `/guildas/${guildaA}/convites-internos`, { cookie: gmA.cookie, body: { validadeHoras: 168, maxUsos: 2 } });
  const codigoMulti = invMulti.json?.convite?.codigo;
  t("convite multi-uso criado", !!codigoMulti);
  const u4 = await novoUsuario("novato_quatro", "Novato Quatro");
  const u5 = await novoUsuario("novato_cinco", "Novato Cinco");
  const u6 = await novoUsuario("novato_seis", "Novato Seis");
  const tentativas = [u4, u5, u6].map((u) =>
    req(BASE, "POST", `/convites-guilda/${codigoMulti}/aceitar`, { cookie: u.cookie }));
  const resultados = await Promise.all(tentativas);
  const oks = resultados.filter((r) => r.status < 300).length;
  const recusas = resultados.filter((r) => r.status >= 400).length;
  t("exatamente 2 aceites no convite de 2 usos", oks === 2 && recusas === 1, `oks=${oks} recusas=${recusas}`);

  sec("11-12. Segurança de gerenciamento");
  // membro comum não vê a seção nem consegue chamar a API
  const ctxMC = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgMC = await ctxMC.newPage();
  observar(pgMC);
  await login(pgMC, "membro_comum", "senha-123");
  await abrirGuilda(pgMC, "Guilda Alfa");
  t("membro comum NÃO vê seção Convites internos",
    await pgMC.getByRole("heading", { name: "Convites internos" }).count() === 0);
  const mcPost = await req(BASE, "POST", `/guildas/${guildaA}/convites-internos`, { cookie: membroComum.cookie, body: { validadeHoras: 24, maxUsos: 1 } });
  t("API recusa criação por membro comum", mcPost.status === 403 || mcPost.status === 401, `status=${mcPost.status}`);
  const mcList = await req(BASE, "GET", `/guildas/${guildaA}/convites-internos`, { cookie: membroComum.cookie });
  t("API recusa listagem por membro comum", mcList.status === 403 || mcList.status === 401, `status=${mcList.status}`);
  const mcDel = await req(BASE, "DELETE", `/guildas/${guildaA}/convites-internos/qualquer`, { cookie: membroComum.cookie });
  t("API recusa revogação por membro comum", mcDel.status === 403 || mcDel.status === 401 || mcDel.status === 404, `status=${mcDel.status}`);

  // GM de outra guilda não administra convites da guilda A
  const gbPost = await req(BASE, "POST", `/guildas/${guildaA}/convites-internos`, { cookie: gmB.cookie, body: { validadeHoras: 24, maxUsos: 1 } });
  t("GM de outra guilda não cria convite na guilda A", gbPost.status === 403 || gbPost.status === 401 || gbPost.status === 404, `status=${gbPost.status}`);
  const gbList = await req(BASE, "GET", `/guildas/${guildaA}/convites-internos`, { cookie: gmB.cookie });
  t("GM de outra guilda não lista convites da guilda A", gbList.status === 403 || gbList.status === 401 || gbList.status === 404, `status=${gbList.status}`);

  sec("13. Anônimo preserva o código durante o Login");
  const ctxAnon = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgAnon = await ctxAnon.newPage();
  observar(pgAnon);
  const invAnon = await req(BASE, "POST", `/guildas/${guildaA}/convites-internos`, { cookie: gmA.cookie, body: { validadeHoras: 168, maxUsos: 1 } });
  const linkAnon = `${BASE}/?conviteGuilda=${invAnon.json?.convite?.codigo}`;
  await pgAnon.goto(linkAnon);
  await pgAnon.getByLabel("Usuário").waitFor({ timeout: 15000 });
  t("anônimo vê Login e URL preserva o código", pgAnon.url().includes("conviteGuilda="), pgAnon.url());
  await pgAnon.getByLabel("Usuário").fill("novato_tres");
  await pgAnon.getByLabel("Senha").fill("senha-123");
  await pgAnon.getByRole("button", { name: "Entrar", exact: true }).click();
  await pgAnon.getByRole("heading", { name: "Guilda Alfa" }).waitFor({ timeout: 20000 });
  t("após login, preview do convite aparece sem novo link", true);

  sec("14. Link inválido mostra erro sem quebrar");
  const ctxInv = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgInv = await ctxInv.newPage();
  observar(pgInv);
  await login(pgInv, "novato_um", "senha-123");
  await pgInv.goto(`${BASE}/?conviteGuilda=CODIGO-INEXISTENTE-123`);
  await pgInv.locator(".erro").first().waitFor({ timeout: 15000 });
  t("convite inválido mostra erro compreensível", (await pgInv.locator(".erro").first().innerText()).length > 3);
  await pgInv.getByRole("button", { name: "Ir para o painel" }).click();
  await pgInv.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
  t("após erro, painel continua funcional", true);

  sec("15. Responsividade e console");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMob = await ctxMob.newPage();
  observar(pgMob);
  await login(pgMob, "gm_guilda_a", "senha-123");
  await abrirGuilda(pgMob, "Guilda Alfa");
  await pgMob.getByRole("heading", { name: "Convites internos" }).waitFor({ timeout: 15000 });
  const secConvitesMob = pgMob.locator("section.cartao").filter({ has: pgMob.getByRole("heading", { name: "Convites internos" }) });
  await secConvitesMob.waitFor({ timeout: 15000 });
  const cartoesConvite = secConvitesMob.locator(".cartoes-registro .registro-cartao");
  t("seção de convites responsiva no mobile (cartões visíveis)", await cartoesConvite.first().isVisible().catch(() => false));
  await ctxMob.close();

  const espurio = /proposital|__erro|Failed to fetch dynamically|dynamically imported module|ChunkLoadError|ERR_ABORTED|ERR_FAILED|net::ERR/i;
  const inesperados = errosConsole.filter((e) => !espurio.test(e));
  t("nenhum erro de console não intencional", inesperados.length === 0, inesperados.slice(0, 3).join(" | "));

  await ctxGM.close(); await ctxN1.close(); await ctxN2.close(); await ctxMC.close(); await ctxAnon.close(); await ctxInv.close();
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", e?.message ?? e);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n==== convites-guilda: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
