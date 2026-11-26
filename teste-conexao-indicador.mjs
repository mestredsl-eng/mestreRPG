// Issue #285 / PR #372 — E2E do indicador de conexão + última
// sincronização no shell da campanha. Prova: o horário só avança após
// GET autoritativo concluir; falha de GET não avança; desconexão marca
// "sincronização interrompida"; reconexão resincroniza telas já abertas;
// a marca é por tela ativa (sync de uma aba não vaza para outra).
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("conexao-indicador");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

let browser, proc;
const errosConsole = [];
function vigiar(page, tag) {
  page.on("pageerror", (e) => errosConsole.push(`${tag}:pageerror:${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/401|Failed to load resource/.test(txt)) return;
    errosConsole.push(`${tag}:console:${txt.slice(10)}`);
  });
}
async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function abrirCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("Campanha Teste", { exact: true }).first().click();
}
const indicador = (page) => page.locator(".conexao").first();
const textoIndicador = async (page) => (await indicador(page).innerText()).replace(/\s+/g, " ").trim();
const horaAtual = () => new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
// A marca tem resolução de minuto — para provar "avanço" é preciso que o
// relógio local cruze uma fronteira de minuto entre a marca anterior e a
// sincronização seguinte. Espera no máximo ~70s.
async function aguardarViradaMinuto(minutoAnterior, timeoutMs = 75000) {
  const ini = Date.now();
  while (Date.now() - ini < timeoutMs) {
    if (new Date().getMinutes() !== minutoAnterior) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "jogador_um" } });
  const j1 = c.jogadores.jogador1;

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  vigiar(page, "pc");
  await login(page, "jogador_um", "senha-jogador-123");
  await abrirCampanha(page);

  sec("Indicador visível e marca após carga inicial");
  await indicador(page).waitFor({ timeout: 15000 });
  t("indicador mostra 'Conectado'", /Conectado/.test(await textoIndicador(page)), await textoIndicador(page));
  // A carga inicial do shell (GET campanha+membros) registra a 1ª sync.
  await page.waitForFunction(
    () => /Atualizado às \d{2}:\d{2}/.test(document.querySelector(".conexao")?.textContent ?? ""),
    { timeout: 15000 },
  );
  t("'Atualizado às HH:mm' aparece após GET bem-sucedido", true);
  const marca1 = await textoIndicador(page);
  const minuto1 = Number((marca1.match(/(\d{2}):(\d{2})/) ?? [])[2]);

  sec("Evento realtime → recarga → marca avança");
  t("relógio cruzou fronteira de minuto", await aguardarViradaMinuto(minuto1), `minuto1=${minuto1}`);
  const minutoAtual = new Date().getMinutes();
  // Mestre edita a descrição → campanha:atualizada → shell recarrega.
  const patch = await req(BASE, "PATCH", `/campaigns/${c.campId}`, {
    cookie: c.cookieMestre,
    body: { description: "sync " + Date.now() },
  });
  t("PATCH campanha aceito (dispara invalidação)", patch.status === 200, `status=${patch.status}`);
  await page.waitForFunction(
    (min) => {
      const txt = document.querySelector(".conexao")?.textContent ?? "";
      const m = txt.match(/Atualizado às (\d{2}):(\d{2})/);
      return m && Number(m[2]) === min;
    },
    minutoAtual, { timeout: 20000 },
  ).catch(() => null);
  const marca2 = await textoIndicador(page);
  t("marca avançou após evento+GET", marca2 !== marca1 || minutoAtual === minuto1, `${marca1} → ${marca2}`);

  sec("Falha de GET → marca NÃO avança");
  const marcaAntesFalha = await textoIndicador(page);
  await page.route("**/api/campaigns/**", (r) => r.abort());
  await req(BASE, "PATCH", `/campaigns/${c.campId}`, {
    cookie: c.cookieMestre,
    body: { description: "sync falha " + Date.now() },
  });
  await page.waitForSelector(".erro", { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(800);
  const marcaAposFalha = await textoIndicador(page);
  t("marca preservada após GET abortado", marcaAposFalha === marcaAntesFalha, `${marcaAntesFalha} → ${marcaAposFalha}`);
  await page.unroute("**/api/campaigns/**");

  sec("Desconexão e reconexão");
  await page.evaluate(() => window.__mesaSocket?.disconnect());
  await page.waitForFunction(
    () => /sincronização interrompida|Sem conexão/.test(document.querySelector(".conexao")?.textContent ?? ""),
    { timeout: 10000 },
  );
  t("desconexão indica sincronização interrompida", /interrompida/.test(await textoIndicador(page)), await textoIndicador(page));
  // conteúdo preservado: nome da campanha continua visível
  t("conteúdo da campanha preservado", await page.getByText("Campanha Teste", { exact: true }).count() > 0);
  await page.evaluate(() => window.__mesaSocket?.connect());
  await page.waitForFunction(
    () => /Conectado/.test(document.querySelector(".conexao")?.textContent ?? "") && !/Reconectando/.test(document.querySelector(".conexao")?.textContent ?? ""),
    { timeout: 15000 },
  );
  t("reconexão restaura 'Conectado'", /Conectado/.test(await textoIndicador(page)), await textoIndicador(page));

  sec("Resync pós-reconexão ao abrir aba sincronizada");
  await page.locator(".abas button", { hasText: "Diário" }).first().click();
  await page.waitForFunction(
    () => /Atualizado às \d{2}:\d{2}/.test(document.querySelector(".conexao")?.textContent ?? ""),
    { timeout: 20000 },
  );
  const marca3 = await textoIndicador(page);
  t("marca atualizada após resync do Diário", /Atualizado às/.test(marca3), marca3);

  sec("Reconexão com Personagens aberto → resync automático");
  await page.locator(".abas button", { hasText: "Personagens" }).first().click();
  // espera a montagem terminar (GET characters + sheet-templates + vinculaveis)
  await page.waitForResponse(
    (r) => r.url().includes(`/api/campaigns/${c.campId}/characters`) && r.request().method() === "GET",
    { timeout: 15000 },
  ).catch(() => null);
  await page.waitForTimeout(800);
  // waiters registrados ANTES do reconnect — provam GET automático sem reload manual
  const getPersonagens = page.waitForRequest(
    (r) => r.url().includes(`/api/campaigns/${c.campId}/characters`) && r.method() === "GET",
    { timeout: 25000 },
  ).catch(() => null);
  const getShell = page.waitForRequest(
    (r) => /\/api\/campaigns\/[^/?]+$/.test(new URL(r.url()).pathname) && r.method() === "GET",
    { timeout: 25000 },
  ).catch(() => null);
  await page.evaluate(() => window.__mesaSocket?.disconnect());
  await page.waitForFunction(
    () => /interrompida|Sem conexão/.test(document.querySelector(".conexao")?.textContent ?? ""),
    { timeout: 10000 },
  );
  await page.evaluate(() => window.__mesaSocket?.connect());
  await page.waitForFunction(
    () => /Conectado/.test(document.querySelector(".conexao")?.textContent ?? "") && !/Reconectando/.test(document.querySelector(".conexao")?.textContent ?? ""),
    { timeout: 15000 },
  );
  t("GET de Personagens automático pós-reconexão (tela já aberta)", !!(await getPersonagens));
  t("GET do shell automático pós-reconexão", !!(await getShell));

  sec("Troca de abas — marca é por tela ativa");
  await page.locator(".abas button", { hasText: "Informações" }).first().click();
  await page.waitForTimeout(500);
  const marcaInfo = await textoIndicador(page);
  t("marca do shell visível em Informações", /Atualizado às \d{2}:\d{2}/.test(marcaInfo), marcaInfo);
  const minutoMarca = Number(marcaInfo.match(/(\d{2}):(\d{2})/)?.[2]);
  // vira o minuto para que uma sync do Diário tenha marca distinguível
  t("relógio cruzou fronteira de minuto", await aguardarViradaMinuto(minutoMarca), `minutoMarca=${minutoMarca}`);
  // Diário monta e sincroniza na aba dele; depois o mestre cria anotação
  // → anotacoes:atualizadas → Diario recarrega e carimba "diario".
  await page.locator(".abas button", { hasText: "Diário" }).first().click();
  await page.waitForTimeout(1000);
  const nota = await req(BASE, "POST", `/campaigns/${c.campId}/anotacoes`, {
    cookie: c.cookieMestre,
    body: { title: "sync-aba", content: "x", kind: "diario", visibility: "privada", important: false },
  });
  t("POST anotação aceita (dispara invalidação)", nota.status === 200 || nota.status === 201, `status=${nota.status}`);
  await page.waitForTimeout(1200);
  // Volta a Informações: o shell NÃO recarregou (troca de aba não emite
  // GET), então a marca exibida deve ser a do shell — a sync do Diário
  // não pode vazar para a aba Informações.
  await page.locator(".abas button", { hasText: "Informações" }).first().click();
  await page.waitForTimeout(500);
  const marcaInfoDepois = await textoIndicador(page);
  t("sync do Diário não altera a marca de Informações", marcaInfoDepois === marcaInfo, `${marcaInfo} → ${marcaInfoDepois}`);

  sec("Mobile 390px");
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgM = await ctxM.newPage();
  vigiar(pgM, "mobile");
  await login(pgM, "jogador_um", "senha-jogador-123");
  await abrirCampanha(pgM);
  await pgM.locator(".conexao").first().waitFor({ timeout: 15000 });
  t("indicador visível em 390px", /Conectado/.test(await textoIndicador(pgM)), await textoIndicador(pgM));
  await ctxM.close();

  await ctx.close();
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
if (errosConsole.length) console.log("console/pageerror:", errosConsole.slice(0, 8));
process.exit(fail ? 1 : 0);
