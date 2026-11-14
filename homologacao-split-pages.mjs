#!/usr/bin/env node
// Homologação do code-splitting das telas secundárias (PR #84):
// - chunks JS sob demanda para telas secundárias (React.lazy + Suspense);
// - Login e Painel NÃO dependem dos chunks secundários;
// - navegação completa por todas as abas autenticadas;
// - detalhe de campanha e retorno à lista;
// - convite anônimo (/convite?code=...) e aceite autenticado;
// - falha de chunk (módulo abortado) cai no ErrorBoundary e recupera;
// - /?__erro=1 aciona o ErrorBoundary de main.tsx;
// - zero erros de console não intencionais.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("split-pages");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

// Chunks gerados pelo Vite para as telas secundárias (nomes estáveis por página).
const CHUNKS_SECUNDARIOS = [
  "Admin-", "Conta-", "Campanhas-", "Campanha-", "Convite-",
  "ConviteCadastro-", "Acervo-", "Guildas-", "Novidades-", "Modal-",
];
const ehChunkSecundario = (url) =>
  /\/assets\/[A-Za-z]+-[A-Za-z0-9_-]+\.js$/.test(url)
  && CHUNKS_SECUNDARIOS.some((p) => url.includes(`/assets/${p}`));

let browser, proc;
const errosConsole = [];

function observar(page) {
  const chunks = new Set();
  page.on("request", (r) => { if (ehChunkSecundario(r.url())) chunks.add(r.url().split("/").pop()); });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // "Failed to load resource" em /api/* é resposta HTTP esperada
    // (ex.: /auth/me 401 na tela de login) — não é erro de JS/chunk.
    const loc = m.location()?.url ?? "";
    if (/Failed to load resource/.test(m.text()) && loc.includes("/api/")) return;
    errosConsole.push(m.text());
  });
  page.on("pageerror", (e) => errosConsole.push(String(e)));
  return chunks;
}

async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
}
async function aba(page, nome) {
  await page.getByRole("button", { name: nome, exact: true }).click();
}
const chunksDe = (set, prefixo) => [...set].filter((c) => c.startsWith(prefixo));

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO);
  // Dois convites: um para o fluxo anônimo e outro para o aceite autenticado.
  const inv1 = await req(BASE, "POST", `/campaigns/${cenario.campId}/invitations`, {
    cookie: cenario.cookieMestre, body: { role: "jogador", requiresApproval: false },
  });
  const CODE1 = inv1.json?.convite?.code;
  const inv2 = await req(BASE, "POST", `/campaigns/${cenario.campId}/invitations`, {
    cookie: cenario.cookieMestre, body: { role: "jogador", requiresApproval: false },
  });
  const CODE2 = inv2.json?.convite?.code;
  t("convites de teste criados", !!CODE1 && !!CODE2);
  // Conta existente FORA da campanha — jogadores do cenário já são
  // membros e veriam "Ir para o painel" em vez de "Aceitar convite".
  const hashFora = await hashSenha("senha-jogador-123");
  const dbFora = abrirDb(BANCO);
  try {
    const agora = Date.now();
    dbFora.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(crypto.randomUUID(), "fora_campanha", "Fora da Campanha", hashFora, agora, agora);
  } finally { dbFora.close(); }

  browser = await chromium.launch();

  sec("1. Login e Painel sem chunks secundários");
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  const chunksM = observar(pgM);
  await pgM.goto(BASE);
  await pgM.getByLabel("Usuário").waitFor({ timeout: 15000 });
  t("tela de login renderiza", await pgM.getByLabel("Senha").count() > 0);
  t("login NÃO carrega chunks secundários",
    ![...chunksM].some((c) => CHUNKS_SECUNDARIOS.some((p) => c.startsWith(p))),
    [...chunksM].join(","));
  await pgM.getByLabel("Usuário").fill("mestre_teste");
  await pgM.getByLabel("Senha").fill("senha-forte-123");
  await pgM.getByRole("button", { name: "Entrar", exact: true }).click();
  await pgM.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
  await pgM.waitForTimeout(500);
  t("após login (Painel) ainda sem chunks secundários",
    ![...chunksM].some((c) => CHUNKS_SECUNDARIOS.some((p) => c.startsWith(p))),
    [...chunksM].join(","));

  sec("2. Navegação por todas as telas secundárias");
  const casos = [
    ["Campanhas", "Campanhas-", "Minhas campanhas"],
    ["Acervo", "Acervo-", "Acervo de Livros de Regras"],
    ["Novidades", "Novidades-", "Novidades"],
    ["Guildas", "Guildas-", "Guildas"],
    ["Conta", "Conta-", "Sua conta"],
    ["Administração", "Admin-", "Usuários"],
  ];
  for (const [nome, chunk, marcador] of casos) {
    await aba(pgM, nome);
    await pgM.getByRole("heading", { name: marcador }).first().waitFor({ timeout: 15000 });
    t(`${nome}: chunk ${chunk} carregado`, chunksDe(chunksM, chunk).length > 0, [...chunksM].join(","));
    t(`${nome}: conteúdo renderizado`, await pgM.getByRole("heading", { name: marcador }).count() > 0);
  }
  t("Suspense não ficou preso em 'Carregando módulo…'",
    !(await pgM.getByText("Carregando módulo…").count()));

  sec("3. Detalhe de campanha e retorno");
  await aba(pgM, "Campanhas");
  await pgM.getByRole("heading", { name: "Minhas campanhas" }).waitFor({ timeout: 15000 });
  await pgM.getByText("Campanha Teste", { exact: true }).first().click();
  // "Voltar" também existe no estado de carregamento — esperar o h2
  // do detalhe garante que a campanha realmente abriu.
  await pgM.getByRole("heading", { name: "Campanha Teste" }).waitFor({ timeout: 20000 });
  t("detalhe da campanha carrega chunk Campanha-", chunksDe(chunksM, "Campanha-").length > 0);
  t("detalhe exibe a campanha", await pgM.getByRole("heading", { name: "Campanha Teste" }).count() > 0);
  await pgM.getByRole("button", { name: "Voltar" }).first().click();
  await pgM.getByRole("heading", { name: "Minhas campanhas" }).waitFor({ timeout: 15000 });
  t("retorno à lista de campanhas", await pgM.getByRole("heading", { name: "Minhas campanhas" }).count() > 0);

  sec("4. Convite anônimo em /convite?code=...");
  const ctxA = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgA = await ctxA.newPage();
  const chunksA = observar(pgA);
  await pgA.goto(`${BASE}/convite?code=${CODE1}`);
  await pgA.getByRole("heading", { name: "Convite para campanha" }).waitFor({ timeout: 15000 });
  t("fluxo anônimo carrega chunk ConviteCadastro-", chunksDe(chunksA, "ConviteCadastro-").length > 0, [...chunksA].join(","));
  // a prévia da campanha chega por fetch assíncrono — esperar o h2
  await pgA.getByRole("heading", { name: "Campanha Teste" }).waitFor({ timeout: 15000 });
  t("prévia do convite mostra a campanha", await pgA.getByRole("heading", { name: "Campanha Teste" }).count() > 0);
  t("anônimo vê opção de cadastro/entrada", await pgA.getByRole("button", { name: /Criar conta|Entrar/ }).count() > 0);
  await ctxA.close();

  sec("5. Aceite de convite autenticado");
  const ctxJ = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgJ = await ctxJ.newPage();
  const chunksJ = observar(pgJ);
  await login(pgJ, "fora_campanha", "senha-jogador-123");
  await pgJ.goto(`${BASE}/convite?code=${CODE2}`);
  await pgJ.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 20000 });
  t("aceite autenticado carrega chunk Convite-", chunksDe(chunksJ, "Convite-").length > 0 || chunksDe(chunksJ, "ConviteCadastro-").length > 0, [...chunksJ].join(","));
  await pgJ.getByRole("button", { name: "Aceitar convite" }).click();
  await pgJ.getByText(/entra|membro|campanha/i).first().waitFor({ timeout: 15000 }).catch(() => {});
  await pgJ.waitForTimeout(2500); // aceite redireciona ao painel (aoEntrar)
  t("após aceite, painel acessível", await pgJ.getByRole("button", { name: "Campanhas" }).count() > 0);
  await ctxJ.close();

  sec("6. Falha de chunk → ErrorBoundary → recuperação");
  // Falha de chunk → ErrorBoundary → recuperação.
  // pgM é autenticado: /convite carrega o chunk Convite- (não o
  // ConviteCadastro-, exclusivo do fluxo anônimo), ainda não buscado
  // neste contexto.
  await pgM.route("**/assets/Convite-*.js", (r) => r.abort());
  await pgM.goto(`${BASE}/convite?code=${CODE1}`);
  await pgM.getByRole("heading", { name: "Algo deu errado" }).waitFor({ timeout: 15000 });
  t("chunk abortado cai no ErrorBoundary", await pgM.getByText("Algo deu errado").count() > 0);
  await pgM.unroute("**/assets/Convite-*.js");
  await pgM.getByRole("button", { name: "Recarregar aplicação" }).click();
  await pgM.waitForLoadState("load");
  // sessão persiste via cookie; /convite autenticado mostra a tela de aceite
  await pgM.getByRole("heading", { name: "Convite para campanha" }).waitFor({ timeout: 20000 });
  // os botões dependem da resposta assíncrona de validarConvite
  await pgM.getByRole("button", { name: /Aceitar convite|Ir para o painel/ }).first()
    .waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  t("após remover a falha, módulo carrega e tela recupera",
    await pgM.getByRole("button", { name: /Aceitar convite|Ir para o painel/ }).count() > 0);

  sec("7. ErrorBoundary via /?__erro=1");
  await pgM.goto(`${BASE}/?__erro=1`);
  await pgM.getByRole("heading", { name: "Algo deu errado" }).waitFor({ timeout: 15000 });
  t("__erro=1 aciona o ErrorBoundary", await pgM.getByRole("button", { name: "Recarregar aplicação" }).count() > 0);

  sec("8. Console e falhas de chunk");
  const espurio = /proposital|__erro|Failed to fetch dynamically|dynamically imported module|ChunkLoadError|ERR_ABORTED|ERR_FAILED|net::ERR/i;
  const inesperados = errosConsole.filter((e) => !espurio.test(e));
  t("nenhum erro de console não intencional", inesperados.length === 0, inesperados.slice(0, 3).join(" | "));

  await ctxM.close();
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", e?.message ?? e);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n==== split-pages: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
