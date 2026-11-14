#!/usr/bin/env node
// Homologação da transferência de responsável da guilda (Issue #65 — UI):
// responsável atual visível, ação só para responsável/ADMIN, seletor
// restrito a GMs ativos, confirmação explícita, atualização sem reload e
// em tempo real nas demais telas, erros 403/409 e responsividade.
// Requer a API de transferência (branch feat/guilda-responsavel-backend).
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

const DIR = dirTeste("responsavel-guilda");
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
  // Desktop renderiza tabela; mobile (<=640px) exibe .registro-cartao.
  const item = page.locator("tr:visible, .registro-cartao:visible", { hasText: nome })
    .filter({ has: page.getByRole("button", { name: "Abrir" }) }).first();
  await item.getByRole("button", { name: "Abrir" }).click();
  await page.getByRole("heading", { name: /Membros/ }).waitFor({ timeout: 15000 });
}
const secaoResp = (page) =>
  page.locator("section.cartao").filter({ has: page.getByRole("heading", { name: "Transferir responsabilidade" }) });

/** Cria usuário avulso e devolve {id, cookie}. */
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
  // criarCenario provisiona o ADMIN global (mestre_teste) — única conta
  // que pode ser admin por trigger; não é possível semear outro via SQL.
  const cenario = await criarCenario(BASE, BANCO, { jogadores: {}, ficha: false });
  const admin = { id: cenario.adminId, username: "mestre_teste", cookie: cenario.cookieMestre };

  // ---- atores ----
  const gmA = await novoUsuario("gm_resp_a", "GM Resp A");          // criador → responsável inicial
  const gmB = await novoUsuario("gm_resp_b", "GM Resp B");          // vira GM, alvo da 1ª transferência
  const gmC = await novoUsuario("gm_resp_c", "GM Resp C");          // GM comum (não-responsável)
  const gmD = await novoUsuario("gm_resp_d", "GM Resp D");          // GM que será BLOQUEADO
  const membro = await novoUsuario("membro_resp", "Membro Resp");

  // guilda criada pelo gmA via API (criador vira responsável e GM)
  const gA = await req(BASE, "POST", "/guildas", { cookie: gmA.cookie, body: { name: "Guilda Responsável", description: "teste" } });
  const guildaId = gA.json?.guilda?.id;
  t("GM cria guilda (responsável inicial)", gA.status === 201 && gA.json?.guilda?.responsavelId === gmA.id,
    `status=${gA.status} resp=${gA.json?.guilda?.responsavelId}`);

  // adiciona gmB, gmC, gmD e membro; promove gmB, gmC e gmD a GM
  for (const u of [gmB, gmC, gmD, membro]) {
    const add = await req(BASE, "POST", `/guildas/${guildaId}/membros`, { cookie: gmA.cookie, body: { username: u.username } });
    t(`membro ${u.username} adicionado`, add.status === 201 || add.status === 200, `status=${add.status}`);
  }
  for (const u of [gmB, gmC, gmD]) {
    const prom = await req(BASE, "PATCH", `/guildas/${guildaId}/membros/${u.id}`, { cookie: gmA.cookie, body: { role: "gm" } });
    t(`${u.username} promovido a GM`, prom.status === 200, `status=${prom.status}`);
  }
  // gmD é bloqueado ANTES de qualquer tela abrir — deve sumir do seletor
  // de transferência mas permanecer visível no roster de membros.
  const bloqueio = await req(BASE, "PATCH", `/admin/users/${gmD.id}`, { cookie: admin.cookie, body: { status: "bloqueado" } });
  t("gmD bloqueado via ADMIN", bloqueio.status === 200, `status=${bloqueio.status}`);

  browser = await chromium.launch();

  sec("1. Responsável atual exibido e ação restrita");
  const ctxA = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgA = await ctxA.newPage();
  observar(pgA);
  await login(pgA, "gm_resp_a", "senha-123");
  await abrirGuilda(pgA, "Guilda Responsável");
  await pgA.getByText(/Responsável:/).waitFor({ timeout: 15000 });
  const linhaResp = pgA.locator("p.dica", { hasText: "Responsável:" });
  t("responsável atual exibido (GM Resp A)", (await linhaResp.innerText()).includes("GM Resp A"), await linhaResp.innerText());
  t("responsável se reconhece ((você))", (await linhaResp.innerText()).includes("(você)"));
  const respA = secaoResp(pgA);
  t("seção Transferir responsabilidade visível para o responsável", await respA.count() === 1);
  const opcoes = await respA.locator("select option").allTextContents();
  t("seletor lista apenas GMs elegíveis (B e C)",
    opcoes.some((o) => o.includes("GM Resp B")) && opcoes.some((o) => o.includes("GM Resp C"))
      && !opcoes.some((o) => o.includes("GM Resp A") || o.includes("GM Resp D") || o.includes("Membro Resp")),
    opcoes.join(" | "));
  t("GM bloqueado (gmD) ausente do seletor", !opcoes.some((o) => o.includes("GM Resp D")), opcoes.join(" | "));
  t("GM bloqueado permanece visível no roster",
    (await pgA.getByText("gm_resp_d").count()) > 0);

  // segunda tela do mesmo usuário + tela do futuro responsável (gmB)
  const ctxA2 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgA2 = await ctxA2.newPage();
  observar(pgA2);
  await login(pgA2, "gm_resp_a", "senha-123");
  await abrirGuilda(pgA2, "Guilda Responsável");
  await pgA2.getByText(/Responsável:/).waitFor({ timeout: 15000 });
  const ctxB = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgB = await ctxB.newPage();
  observar(pgB);
  await login(pgB, "gm_resp_b", "senha-123");
  await abrirGuilda(pgB, "Guilda Responsável");
  await pgB.getByText(/Responsável:/).waitFor({ timeout: 15000 });

  sec("2. Transferência válida com confirmação");
  await respA.locator("select").selectOption(gmB.id);
  await respA.getByRole("button", { name: "Transferir", exact: true }).click();
  await respA.getByText(/Confirmar:.*GM Resp B/).waitFor({ timeout: 5000 });
  t("confirmação explícita mostra o novo responsável", true);
  // resposta do PUT interceptada para validar o contrato
  const putResp = pgA.waitForResponse((r) => r.url().includes("/responsavel") && r.request().method() === "PUT", { timeout: 15000 });
  await respA.getByRole("button", { name: "Confirmar transferência" }).click();
  const putJson = await (await putResp).json();
  t("PUT /responsavel retorna contrato {ok, anterior, novo}",
    putJson?.ok === true && putJson?.responsavelAnteriorId === gmA.id && putJson?.responsavelId === gmB.id,
    JSON.stringify(putJson));
  await pgA.getByText(/Responsabilidade transferida para/).waitFor({ timeout: 15000 }).catch(() => {});
  await pgA.locator("p.dica", { hasText: "Responsável:" }).filter({ hasText: "GM Resp B" }).waitFor({ timeout: 15000 });
  t("responsável atualizado na tela sem reload", true);
  t("ex-responsável não se reconhece mais", !(await pgA.locator("p.dica", { hasText: "Responsável:" }).innerText()).includes("(você)"));

  sec("3. Atualização em tempo real nas outras telas");
  await pgA2.locator("p.dica", { hasText: "Responsável:" }).filter({ hasText: "GM Resp B" }).waitFor({ timeout: 15000 });
  t("segunda tela do mesmo usuário atualiza via socket", true);
  await pgB.locator("p.dica", { hasText: "Responsável:" }).filter({ hasText: "GM Resp B" }).waitFor({ timeout: 15000 });
  t("tela do novo responsável atualiza via socket", true);
  await pgB.locator("p.dica", { hasText: "Responsável:" }).filter({ hasText: "(você)" }).waitFor({ timeout: 15000 });
  t("novo responsável passa a se reconhecer ((você))", true);

  sec("4. Papéis preservados — ninguém mudou de papel");
  const membrosDepois = await req(BASE, "GET", `/guildas/${guildaId}/membros`, { cookie: gmB.cookie });
  const papelDe = (uid) => membrosDepois.json?.membros?.find((m) => m.userId === uid)?.role;
  t("ex-responsável continua GM", papelDe(gmA.id) === "gm", papelDe(gmA.id));
  t("novo responsável é GM", papelDe(gmB.id) === "gm", papelDe(gmB.id));
  t("membro comum continua membro", papelDe(membro.id) === "membro", papelDe(membro.id));

  sec("5. GM comum sem ação autorizada");
  await pgA.reload();
  await abrirGuilda(pgA, "Guilda Responsável");
  await pgA.getByText(/Responsável:/).waitFor({ timeout: 15000 });
  t("ex-responsável (GM comum) NÃO vê seção de transferência",
    await secaoResp(pgA).count() === 0);
  const ctxC = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgC = await ctxC.newPage();
  observar(pgC);
  await login(pgC, "gm_resp_c", "senha-123");
  await abrirGuilda(pgC, "Guilda Responsável");
  await pgC.getByText(/Responsável:/).waitFor({ timeout: 15000 });
  t("GM comum gmC não vê seção de transferência", await secaoResp(pgC).count() === 0);
  const putC = await req(BASE, "PUT", `/guildas/${guildaId}/responsavel`, { cookie: gmC.cookie, body: { userId: gmC.id } });
  t("API recusa transferência por GM comum (403)", putC.status === 403, `status=${putC.status}`);
  const putMC = await req(BASE, "PUT", `/guildas/${guildaId}/responsavel`, { cookie: membro.cookie, body: { userId: gmC.id } });
  t("API recusa transferência por membro comum (403)", putMC.status === 403, `status=${putMC.status}`);

  sec("6. ADMIN autorizado + alvo inválido + idempotência");
  const putAdmin = await req(BASE, "PUT", `/guildas/${guildaId}/responsavel`, { cookie: admin.cookie, body: { userId: gmC.id } });
  t("ADMIN transfere para gmC", putAdmin.status === 200 && putAdmin.json?.responsavelId === gmC.id,
    `status=${putAdmin.status} ${JSON.stringify(putAdmin.json).slice(0, 120)}`);
  const putInvalido = await req(BASE, "PUT", `/guildas/${guildaId}/responsavel`, { cookie: admin.cookie, body: { userId: membro.id } });
  t("alvo membro comum recusado (409)", putInvalido.status === 409, `status=${putInvalido.status}`);
  const putFora = await req(BASE, "PUT", `/guildas/${guildaId}/responsavel`, { cookie: admin.cookie, body: { userId: crypto.randomUUID() } });
  t("alvo inexistente recusado (409)", putFora.status === 409, `status=${putFora.status}`);
  const putBloqueado = await req(BASE, "PUT", `/guildas/${guildaId}/responsavel`, { cookie: admin.cookie, body: { userId: gmD.id } });
  t("alvo GM com conta bloqueada recusado (409)", putBloqueado.status === 409, `status=${putBloqueado.status}`);
  const putMesmo = await req(BASE, "PUT", `/guildas/${guildaId}/responsavel`, { cookie: admin.cookie, body: { userId: gmC.id } });
  t("transferência idempotente para o mesmo responsável", putMesmo.status === 200 && putMesmo.json?.ok === true, `status=${putMesmo.status}`);

  sec("7. Novo responsável vê a ação; mobile e console");
  await pgC.reload();
  await abrirGuilda(pgC, "Guilda Responsável");
  await pgC.getByText(/Responsável:/).waitFor({ timeout: 15000 });
  t("gmC agora responsável vê a seção", await secaoResp(pgC).count() === 1);
  t("gmC se reconhece como responsável", (await pgC.locator("p.dica", { hasText: "Responsável:" }).innerText()).includes("(você)"));

  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMob = await ctxMob.newPage();
  observar(pgMob);
  await login(pgMob, "gm_resp_c", "senha-123");
  await abrirGuilda(pgMob, "Guilda Responsável");
  await pgMob.getByText(/Responsável:/).waitFor({ timeout: 15000 });
  const respMob = await pgMob.locator("p.dica", { hasText: "Responsável:" }).first().isVisible().catch(() => false);
  const secaoMob = await secaoResp(pgMob).first().isVisible().catch(() => false);
  t("responsável e seção visíveis no mobile", respMob && secaoMob, `resp=${respMob} secao=${secaoMob}`);
  await ctxMob.close();

  const espurio = /proposital|__erro|Failed to fetch dynamically|dynamically imported module|ChunkLoadError|ERR_ABORTED|ERR_FAILED|net::ERR/i;
  const inesperados = errosConsole.filter((e) => !espurio.test(e));
  t("nenhum erro de console não intencional", inesperados.length === 0, inesperados.slice(0, 3).join(" | "));

  await ctxA.close(); await ctxA2.close(); await ctxB.close(); await ctxC.close();
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", e?.message ?? e);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n==== responsavel-guilda: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
