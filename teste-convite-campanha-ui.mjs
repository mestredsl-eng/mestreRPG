#!/usr/bin/env node
// Teste E2E — ciclo completo do convite de campanha pela UI (Issue #254).
// Jornada: mestre gera convite na aba Convites → código/link exibidos →
// usuário novo cadastra-se pelo fluxo /convite?code= → aceita → membro
// aparece na aba Participantes com o papel esperado.
// O código do convite NUNCA é impresso (stdout/screenshots).
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let DIR;
let BANCO;
let BASE;

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const FORMATO_CODIGO = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
let browser = null;
let proc = null;
let code = null;

try {
  // Toda aquisição de recursos começa dentro do try/finally, inclusive a fixture
  // temporária e a porta: uma falha de setup também precisa limpar o diretório.
  DIR = dirTeste("convite-campanha-ui");
  BANCO = `${DIR}/mestre-rpg-teste.db`;
  const porta = await portaLivre();
  BASE = `http://127.0.0.1:${porta}`;

  // A preparação aplica migrations em subprocesso: aguardar antes do servidor.
  await prepararBanco(BANCO);
  proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  await esperarSaudavel(BASE, proc);
  browser = await chromium.launch();
  const cenario = await criarCenario(BASE, BANCO, { campanha: "Campanha Convite UI" });
  const cid = cenario.campId;
  ok("cenário criado (admin + campanha)", !!cenario.cookieMestre && !!cid);

  // --- Mestre: aba Convites → gerar convite ---
  const ctxMestre = await browser.newContext();
  await ctxMestre.addCookies([{ name: "mestre_rpg_session", value: cenario.cookieMestre.split("=").pop(), url: BASE }]);
  const pageMestre = await ctxMestre.newPage();
  await pageMestre.goto(BASE);
  await pageMestre.getByRole("button", { name: "Campanhas" }).first().click();
  await pageMestre.locator(".cartao-campanha", { hasText: "Campanha Convite UI" }).first().click();
  await pageMestre.locator(".abas").waitFor({ timeout: 15000 });
  await pageMestre.getByRole("tab", { name: "Convites" }).click();

  // Papel inicial já é "jogador"; gera convite sem aprovação.
  await pageMestre.getByRole("button", { name: "Gerar convite" }).click();
  const codigoEl = pageMestre.locator(".convite-criado code").first();
  await codigoEl.waitFor({ timeout: 10000 });
  code = (await codigoEl.textContent())?.trim() ?? "";
  ok("convite exibido com código no formato esperado", FORMATO_CODIGO.test(code));

  // Link exibido aponta para /convite?code=... (mesmo código, sem logar).
  const linkTexto = await pageMestre.locator(".convite-criado code").nth(1).textContent();
  ok("link /convite exibido corresponde ao código", !!linkTexto && linkTexto.includes(`/convite?code=${code}`));

  // --- Convidado: contexto novo, SEM sessão — fluxo anônimo ---
  const ctxNovo = await browser.newContext();
  const pageNovo = await ctxNovo.newPage();

  // 1) Anônimo abre o link: deve ver cadastro/login (não aceite direto).
  await pageNovo.goto(`${BASE}/convite?code=${code}`);
  await pageNovo.getByText("Crie sua conta de jogador").waitFor({ timeout: 15000 });
  ok("anônimo vê fluxo de cadastro (sem aceite direto)", true);
  const temAceiteAnonimo = await pageNovo.getByRole("button", { name: "Aceitar convite" }).count();
  ok("botão Aceitar ausente para anônimo", temAceiteAnonimo === 0);

  // 2) Registra nova conta de jogador pela UI.
  await pageNovo.locator('label:has-text("Usuário") input').fill("convidada_ui");
  await pageNovo.locator('label:has-text("Nome de exibição") input').fill("Convidada UI");
  await pageNovo.locator('label:has-text("Senha") input').fill("senha-forte-456");
  await pageNovo.getByRole("button", { name: "Criar conta e entrar" }).click();

  // O cadastro abre a sessão e mantém a URL /convite?code=...;
  // espera a UI autenticada, sem atraso fixo nem navegação artificial.
  const btnAceitar = pageNovo.getByRole("button", { name: "Aceitar convite" });
  await btnAceitar.waitFor({ timeout: 15000 });
  const urlAposCadastro = new URL(pageNovo.url());
  ok(
    "cadastro autenticou e preservou o convite atual",
    urlAposCadastro.pathname === "/convite" && urlAposCadastro.searchParams.get("code") === code,
  );

  // 3) Autenticado, aceita explicitamente o mesmo convite.
  await btnAceitar.waitFor({ timeout: 15000 });
  await btnAceitar.click();
  await pageNovo.getByText("Você entrou na campanha!", { exact: true }).waitFor({ timeout: 15000 });
  ok("convidada autenticada conclui aceite pela UI", true);
  // Após a mensagem explícita, o Shell navega ao painel.
  await pageNovo.waitForURL((url) => url.pathname === "/", { timeout: 10000 });

  // --- Mestre: Participantes mostra o novo membro com papel jogador ---
  await pageMestre.getByRole("tab", { name: "Participantes" }).click();
  const secao = pageMestre.locator("#campanha-panel-participantes");
  await secao.getByText("convidada_ui", { exact: false }).first().waitFor({ timeout: 10000 });
  const membroLinha = secao.locator("tbody tr").filter({ hasText: "convidada_ui" }).first();
  await membroLinha.waitFor({ timeout: 10000 });
  const membroTexto = await membroLinha.innerText();
  ok("novo membro visível em Participantes", membroTexto.includes("convidada_ui"));
  ok("papel efetivo = jogador na linha do novo membro", membroTexto.includes("Jogador"));

  // --- Regressão: lista reflete o uso na coluna própria ---
  await pageMestre.getByRole("tab", { name: "Convites" }).click();
  const linha = pageMestre.locator(".tabela tbody tr", { hasText: "Jogador" }).first();
  await linha.waitFor({ timeout: 10000 });
  const usos = (await linha.locator("td").nth(2).innerText()).trim();
  ok("lista de convites reflete uso após aceite", usos === "1", "usos=" + usos);

  // --- Reload completo: código e link não são revelados novamente ---
  await pageMestre.reload();
  await pageMestre.getByRole("button", { name: "Campanhas" }).first().click();
  await pageMestre.locator(".cartao-campanha", { hasText: "Campanha Convite UI" }).first().click();
  await pageMestre.locator(".abas").waitFor({ timeout: 15000 });
  await pageMestre.getByRole("tab", { name: "Convites" }).click();
  await pageMestre.locator(".tabela").waitFor({ timeout: 10000 });
  ok("bloco de código único não reaparece após reload", await pageMestre.locator(".convite-criado").count() === 0);
  const textosDaLista = [
    ...(await pageMestre.locator(".tabela tbody tr").allInnerTexts()),
    ...(await pageMestre.locator(".cartoes-registro .registro-cartao").allInnerTexts()),
  ].join(" ");
  ok("código secreto não aparece na listagem após reload", !textosDaLista.includes(code));

  await ctxNovo.close();
  await ctxMestre.close();
} catch (e) {
  const mensagemErro = String(e?.message ?? e);
  const semCodigo = code ? mensagemErro.replaceAll(code, "[redacted]") : mensagemErro;
  const erroSeguro = semCodigo.replace(/\/convite\?code=[^\s"]+/g, "/convite?code=[redacted]");
  ok("execução sem exceção", false, erroSeguro.slice(0, 200));
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    if (proc) await encerrarServidor(proc);
  } finally {
    if (DIR) limparDir(DIR);
  }
}

const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n==== RESULTADO: ${resultados.length - falhas} ok, ${falhas} falhas ====`);
process.exit(falhas ? 1 : 0);
