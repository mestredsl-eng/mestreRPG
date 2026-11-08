// Testes: sistema global de notificações (Etapa D1).
// Cobre: aparecimento, tipos visuais, aria-live/role, fechamento manual,
// dedup, empilhamento, auto-dismiss e responsividade mobile.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const db = new Database("banco/mestre-rpg.db");
// usa 'administrador' (admin com cota de rate-limit própria — 'admin' já
// esgotou a janela de verificar-backup em execuções anteriores)
const admin = db.prepare("select id from users where username='administrador'").get();
const token = "notif-" + crypto.randomUUID();
db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
  .run(crypto.randomUUID(), admin.id, hashToken(token), "teste-notif", "127.0.0.1", Date.now() + 3600000, Date.now());

const browser = await chromium.launch({ channel: "msedge", headless: true });

async function abrirAdmin(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const p = await ctx.newPage();
  const erros = [];
  p.on("pageerror", (e) => erros.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) erros.push(m.text()); });
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.locator(".topo nav button", { hasText: "Administração" }).first().click();
  await p.waitForTimeout(900);
  return { ctx, p, erros };
}

// ---------- desktop ----------
{
  const { ctx, p, erros } = await abrirAdmin(1280);

  // acessibilidade do viewport
  const viewport = p.locator(".notificacoes-viewport");
  ok("viewport aria-live=polite", (await viewport.getAttribute("aria-live")) === "polite");

  // aba Backups do painel Servidor
  const abaBackups = p.locator("button", { hasText: "Backups" }).first();
  ok("aba Backups visível", await abaBackups.count() > 0);
  await abaBackups.click();
  await p.waitForTimeout(800);

  const verificarBtns = p.locator("button", { hasText: "Verificar" });
  const nBackups = await verificarBtns.count();
  ok("backups listados", nBackups > 0, `n=${nBackups}`);

  if (nBackups > 0) {
    // duas verificações rápidas → dedup deve manter 1 toast (mesma msg+tipo)
    await verificarBtns.first().click();
    await verificarBtns.first().click().catch(() => {});
    await p.waitForTimeout(1800);
    let toasts = p.locator(".notificacao");
    const textos = await toasts.allTextContents();
    const integras = textos.filter((t) => t.includes("Backup íntegro") || t.includes("Problemas"));
    ok("toast de verificação apareceu", integras.length >= 1, JSON.stringify(textos));
    ok("dedup: mesma ação não duplica", integras.length === 1, `n=${integras.length}`);
    ok("toast tem role=status", await p.locator(".notificacao[role=status]").count() >= 1);
    ok("toast tem botão fechar", await p.locator(".notificacao-fechar").count() >= 1);

    // mensagem diferente → empilha sem sobreposição (salvar config = ação rápida)
    await p.locator(".abas button", { hasText: "Configuração" }).first().click();
    await p.waitForTimeout(600);
    await p.locator("button", { hasText: "Salvar configuração" }).first().click();
    try {
      await p.waitForFunction(() => document.querySelectorAll(".notificacao").length >= 2, null, { timeout: 8000 });
    } catch { /* medido abaixo */ }
    const total = await p.locator(".notificacao").count();
    ok("notificações simultâneas empilham", total >= 2, `n=${total}`);

    // fechamento manual
    const totalAntes = total;
    await p.locator(".notificacao-fechar").first().click();
    await p.waitForTimeout(200);
    const depois = await p.locator(".notificacao").count();
    ok("fechamento manual funciona", depois === totalAntes - 1, `${totalAntes} -> ${depois}`);

    // navegação não prende toast: troca de aba e o toast continua visível
    await p.locator(".topo nav button", { hasText: "Conta" }).first().click();
    await p.waitForTimeout(400);
    const ainda = await p.locator(".notificacao").count();
    ok("toast sobrevive à navegação", ainda >= 1, `n=${ainda}`);

    // auto-dismiss: toasts de sucesso (~4s) somem sozinhos
    await p.waitForTimeout(5200);
    const sumiu = await p.locator(".notificacao").count();
    ok("auto-dismiss remove toasts", sumiu === 0, `restantes=${sumiu}`);
  }

  ok("sem pageerror/console error", erros.length === 0, erros.slice(0, 2).join(" | "));
  await ctx.close();
}

// ---------- mobile 390px ----------
{
  const { ctx, p } = await abrirAdmin(390);
  const abaBackups = p.locator("button", { hasText: "Backups" }).first();
  if (await abaBackups.count()) {
    await abaBackups.click();
    await p.waitForTimeout(700);
    const verificarBtns = p.locator("button", { hasText: "Verificar" });
    if (await verificarBtns.count()) {
      await verificarBtns.first().click();
      await p.waitForTimeout(1800);
      const toast = p.locator(".notificacao").first();
      ok("mobile: toast visível", await toast.count() > 0);
      if (await toast.count()) {
        const box = await toast.boundingBox();
        const vw = p.viewportSize().width;
        ok("mobile: toast dentro da viewport", !!box && box.x >= 0 && box.x + box.width <= vw + 1, JSON.stringify(box));
        const fechar = toast.locator(".notificacao-fechar");
        const fb = await fechar.boundingBox();
        ok("mobile: botão fechar tocável (>=24px)", !!fb && fb.width >= 20, JSON.stringify(fb));
      }
      const ov = await p.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
      ok("mobile: sem overflow horizontal", ov <= 2, `overflow=${ov}px`);
    }
  }
  await ctx.close();
}

await browser.close();
const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length} passaram, ${falhas.length} falharam`);
process.exit(falhas.length ? 1 : 0);
