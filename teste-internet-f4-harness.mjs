// Verificação visual/a11y da camada F4 (#352) — Internet diegética.
// Sobe `vite dev` do site e carrega o harness DEV ?harness=internet-f4
// (fixtures ilustrativos, nunca dados de produção). Cobre: inbox,
// badge de não lidas, thread/burbulas, envio otimista, detalhes de
// grupo, aba Conta, aba Contatos e semântica de abas — desktop+mobile.
// Executar: node teste-internet-f4-harness.mjs  (requer `npm ci` na raiz)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(__dirname, "site");
const PORTA = 5199;
const BASE = `http://localhost:${PORTA}`;

let pass = 0, fail = 0;
const t = (n, c, x = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, x); } };

const vite = spawn("npx", ["vite", "--port", String(PORTA), "--strictPort"], {
  cwd: SITE, shell: true, stdio: "ignore",
});
const encerrar = () => { try { vite.kill(); } catch {} };
process.on("exit", encerrar);

// espera o vite responder
let pronto = false;
for (let i = 0; i < 60 && !pronto; i++) {
  try { const r = await fetch(BASE); pronto = r.ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!pronto) { console.log("vite dev não subiu"); process.exit(1); }

const browser = await chromium.launch();
for (const vp of [{ w: 1366, h: 800, n: "desktop" }, { w: 390, h: 844, n: "mobile" }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`${BASE}/?harness=internet-f4`);
  await p.getByText("Caixa de entrada").waitFor({ timeout: 15000 });

  t(`${vp.n}: inbox renderiza`, await p.locator(".internet-conversa-item").count() === 2);
  t(`${vp.n}: badge não lidas`, await p.locator(".internet-badge-nao-lidas").count() >= 1);

  await p.locator(".internet-conversa-item").first().click();
  await p.locator(".internet-bolha").first().waitFor({ timeout: 5000 });
  t(`${vp.n}: bolhas renderizam`, await p.locator(".internet-bolha").count() >= 2);
  t(`${vp.n}: composer visível`, await p.locator("#internet-msg-texto").isVisible());

  await p.locator("#internet-msg-texto").fill("Teste do harness");
  await p.getByRole("button", { name: "Enviar", exact: true }).click();
  await p.waitForTimeout(400);
  t(`${vp.n}: envio otimista`, await p.locator(".internet-bolha", { hasText: "Teste do harness" }).count() === 1);

  await p.getByRole("button", { name: /Voltar/ }).click();
  await p.locator(".internet-conversa-item").nth(1).click();
  await p.getByRole("button", { name: "Detalhes do grupo" }).click();
  await p.locator(".internet-grupo-membro").first().waitFor({ timeout: 5000 });
  t(`${vp.n}: detalhes grupo`, await p.locator(".internet-grupo-membro").count() === 3);
  await p.keyboard.press("Escape");

  await p.getByRole("tab", { name: "Conta" }).click();
  await p.getByText("@lyra_stormwind").waitFor({ timeout: 5000 });
  t(`${vp.n}: conta renderiza`, true);

  await p.getByRole("tab", { name: "Mensagens" }).click();
  await p.getByRole("tab", { name: "Contatos" }).click();
  await p.locator(".internet-contato-item").first().waitFor({ timeout: 5000 });
  t(`${vp.n}: contatos renderizam`, await p.locator(".internet-contato-item").count() === 3);

  t(`${vp.n}: tablist semântico`, await p.locator("[role='tab']").count() >= 4);

  // APG: setas movem seleção+foco; roving tabindex; tab↔tabpanel
  const tabMensagens = p.getByRole("tab", { name: "Mensagens", exact: true });
  await tabMensagens.focus();
  await p.keyboard.press("ArrowRight");
  await p.waitForTimeout(400);
  t(`${vp.n}: seta ativa próxima aba`, await p.getByRole("tab", { name: "Conta", exact: true }).getAttribute("aria-selected") === "true");
  t(`${vp.n}: roving tabindex`, await p.getByRole("tab", { name: "Conta", exact: true }).getAttribute("tabindex") === "0"
    && await p.getByRole("tab", { name: "Mensagens", exact: true }).getAttribute("tabindex") === "-1");
  t(`${vp.n}: tabpanel associado`, await p.locator("#painel-conta[aria-labelledby='aba-conta']").count() === 1);
  await p.keyboard.press("ArrowLeft");
  await p.waitForTimeout(400);

  // Recusar pedido passa por confirmação modal
  await p.getByRole("tab", { name: "Mensagens", exact: true }).click();
  await p.getByRole("tab", { name: "Contatos", exact: true }).click();
  await p.getByRole("tab", { name: /Pedidos recebidos/ }).click();
  await p.getByRole("button", { name: "Recusar", exact: true }).click();
  await p.locator(".modal, [role='dialog']").first().waitFor({ timeout: 3000 }).catch(() => {});
  t(`${vp.n}: recusar pede confirmação`, await p.getByText(/Recusar pedido de @nix_bric/).count() === 1);
  await p.getByRole("button", { name: "Cancelar", exact: true }).click();

  // conversa direta: seleção única (radio)
  await p.getByRole("tab", { name: "Caixa de entrada", exact: true }).click();
  await p.getByRole("button", { name: "Nova conversa direta" }).click();
  await p.locator("input[type='radio'][name='internet-contato-unico']").first().waitFor({ timeout: 3000 });
  t(`${vp.n}: direta usa seleção única`, await p.locator("input[type='radio'][name='internet-contato-unico']").count() === 3);
  await p.getByRole("button", { name: "Cancelar", exact: true }).click();

  await p.waitForTimeout(300);
  t(`${vp.n}: zero pageerror`, errs.length === 0, errs[0]);
  await ctx.close();
}

await browser.close();
encerrar();
console.log(`\n${pass} ok / ${fail} falhas`);
process.exit(fail ? 1 : 0);
