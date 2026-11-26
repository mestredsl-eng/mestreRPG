// Issue #373 — regressão da versão exibida na UI.
//
// A versão apresentada em Administração → Servidor deve acompanhar a
// versão real do pacote: GET /admin/servidor/status lê o package.json
// raiz em cada chamada (lerVersaoServidor) e a UI renderiza esse valor
// sem hardcode. Este teste compara API e tela com o package.json do
// repositório — se o metadado subir (ex.: 1.1.0 → 1.1.1), a tela deve
// mostrar o novo valor; nunca um valor antigo fixado em código.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("versao-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const VERSAO_PKG = JSON.parse(readFileSync("package.json", "utf-8")).version;

let browser, proc;
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { ficha: false, jogadores: {} });

  sec("API — status do servidor reflete o package.json raiz");
  const st = await req(BASE, "GET", "/admin/servidor/status", { cookie: c.cookieMestre });
  t("GET /admin/servidor/status ok", st.status === 200, `status=${st.status}`);
  t(
    "versao da API === version do package.json raiz",
    st.json?.servidor?.versao === VERSAO_PKG,
    `api=${st.json?.servidor?.versao} pkg=${VERSAO_PKG}`,
  );

  sec("UI — Administração → Servidor exibe a mesma versão");
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill("mestre_teste");
  await page.getByLabel("Senha").fill("senha-forte-123");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Administração" }).click();
  const pVersao = page.locator("p", { hasText: "Versão:" }).first();
  await pVersao.waitFor({ timeout: 20000 });
  const txtVersao = (await pVersao.innerText()).replace(/\s+/g, " ").trim();
  t(
    "UI exibe 'Versão: <version do package.json>'",
    new RegExp(`Versão:\\s*${VERSAO_PKG.replace(/\./g, "\\.")}`).test(txtVersao),
    txtVersao,
  );
  t(
    "UI não exibe versão divergente da API",
    txtVersao.includes(st.json.servidor.versao),
    `${txtVersao} vs api=${st.json.servidor.versao}`,
  );

  await browser.close().catch(() => {});
  browser = null;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
