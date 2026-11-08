// Testes da Etapa B: Error Boundary, texto do painel e indicador
// de conexão Socket.IO na mesa.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";
import { randomUUID } from "node:crypto";

const BASE = "http://localhost:3001";
const CID = "179dd61c-6f4e-4c54-bf88-1e255a506743"; // campanha de testes existente
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const db = new Database("banco/mestre-rpg.db");
const sessao = (userId, tag) => {
  const token = `${tag}-` + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(randomUUID(), userId, hashToken(token), "teste-estab", "127.0.0.1", Date.now() + 3600000, Date.now());
  return token;
};
const admin = db.prepare("select id from users where username='administrador'").get();
const tokM = sessao(admin.id, "estab-m");
async function req(m, path, body, token = tokM) {
  const r = await fetch(BASE + path, {
    method: m,
    headers: { "content-type": "application/json", cookie: `mestre_rpg_session=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const apiM = (m, p, b) => req(m, p, b);

// sessão de mesa para os testes de conexão
const sessaoNova = await apiM("POST", `/api/campaigns/${CID}/sessoes`, { name: "Sessão Estabilidade" });
const SID = sessaoNova.json?.sessao?.id;
ok("setup. sessão criada", !!SID, `status=${sessaoNova.status}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await ctx.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
const p = await ctx.newPage();
// bloqueio controlado de socket.io — ligado/desligado pela flag
let bloquearSocket = true;
const wsPendentes = new Set();
const wsAtivos = new Set();
await ctx.route("**/socket.io**", (route) => (bloquearSocket ? route.abort() : route.continue()));
await ctx.routeWebSocket(/socket\.io/, (ws) => {
  if (bloquearSocket) { wsPendentes.add(ws); return; } // handshake nunca completa
  wsAtivos.add(ws);
  ws.onClose(() => wsAtivos.delete(ws));
  const server = ws.connectToServer();
  ws.onMessage((m) => server.send(m));
  server.onMessage((m) => ws.send(m));
});
const derrubarSocket = () => { for (const ws of wsAtivos) ws.close(); };
const liberarSocket = () => {
  bloquearSocket = false;
  for (const ws of wsPendentes) ws.close();
  wsPendentes.clear();
};
const erros = [];
p.on("pageerror", (e) => erros.push(String(e)));

// ---------- 1. Painel inicial ----------
await p.goto(BASE, { waitUntil: "networkidle" });
await p.waitForTimeout(600);
const textoPainel = await p.locator("main").textContent();
ok("Painel. novo texto 'O que já está no ar'", textoPainel.includes("O que já está no ar"));
ok("Painel. texto obsoleto removido", !textoPainel.includes("A seguir: editor de fichas"));
ok("Painel. menciona recursos reais", /dados D4|D4–D20|mesa em tempo real/i.test(textoPainel));

// ---------- 2. Error Boundary ----------
await p.goto(`${BASE}/?__erro=1`, { waitUntil: "networkidle" });
await p.waitForTimeout(800);
ok("Boundary. tela de recuperação exibida", await p.locator("text=Algo deu errado").count() === 1);
ok("Boundary. app não ficou em branco", await p.locator(".cartao button", { hasText: "Recarregar aplicação" }).count() === 1);
ok("Boundary. sem stack trace visível", !(await p.locator("main").textContent()).includes("ErroProposital"));
// botão recarregar: limpa o param e clica
await p.evaluate(() => history.replaceState({}, "", "/"));
await p.getByRole("button", { name: "Recarregar aplicação" }).click();
await p.waitForTimeout(1500);
ok("Boundary. recarregar restaura o app", await p.locator("text=Olá").count() > 0 || await p.getByRole("button", { name: "Campanhas" }).count() > 0);

// ---------- 3. Indicador de conexão na mesa ----------
// socket.io já está bloqueado desde antes da navegação
await p.getByRole("button", { name: "Campanhas" }).click();
await p.waitForTimeout(800);
await p.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
await p.waitForTimeout(1200);
await p.getByRole("button", { name: /Mesa/ }).click();
await p.waitForTimeout(1000);
await p.locator("tr", { hasText: "Sessão Estabilidade" }).first().click();
await p.waitForTimeout(2500);
const estadoBloqueado = await p.locator(".mesa-view .conexao").getAttribute("class");
ok("Socket. nunca marca conectado sem confirmação", /conexao-(conectando|reconectando|desconectado)/.test(estadoBloqueado ?? "") && (await p.locator(".conexao-conectado").count()) === 0, estadoBloqueado);
liberarSocket();
await p.waitForFunction(
  () => document.querySelector(".mesa-view .conexao")?.classList.contains("conexao-conectado"),
  { timeout: 30000 }
).catch(() => {});
ok("Socket. conecta quando rota liberada", await p.locator(".conexao-conectado").count() === 1, await p.locator(".mesa-view .conexao").textContent());

const indicador = p.locator(".mesa-view .conexao");
ok("Socket. indicador presente na mesa", await indicador.count() === 1);
ok("Socket. estado conectado após liberar", await p.locator(".conexao-conectado").count() === 1, await indicador.textContent());

// desconexão real: fecha o WS ativo → cliente detecta e reconecta sozinho
await p.evaluate(() => { window.__derrubar = true; });
derrubarSocket();
try {
  await p.waitForFunction(
    () => /conexao-(reconectando|desconectado)/.test(document.querySelector(".mesa-view .conexao")?.className ?? ""),
    { timeout: 20000 }
  );
  ok("Socket. queda mostra reconectando/desconectado", true, await p.locator(".mesa-view .conexao").getAttribute("class"));
} catch {
  ok("Socket. queda mostra reconectando/desconectado", false, await p.locator(".mesa-view .conexao").getAttribute("class"));
}

// reconexão automática
try {
  await p.waitForFunction(
    () => document.querySelector(".mesa-view .conexao")?.classList.contains("conexao-conectado"),
    { timeout: 30000 }
  );
  ok("Socket. reconectou sozinho", true, await indicador.textContent());
} catch {
  ok("Socket. reconectou sozinho", false, await indicador.textContent());
}

// a UI da mesa segue íntegra após a reconexão
ok("Socket. mesa íntegra após reconexão", await p.locator(".mesa-view .chat-lista").count() === 1);

// navega para outra aba e volta — sem listeners duplicados
await p.getByRole("button", { name: /Diário/ }).click();
await p.waitForTimeout(800);
await p.getByRole("button", { name: /Mesa/ }).click();
await p.waitForTimeout(800);
await p.locator("tr", { hasText: "Sessão Estabilidade" }).first().click();
await p.waitForTimeout(2000);
ok("Socket. indicador único após re-navegação", await p.locator(".mesa-view .conexao").count() === 1);
ok("Socket. ainda conectado", await p.locator(".conexao-conectado").count() === 1);

// ---------- 4. Mobile 390px ----------
const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctxM.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
const pm = await ctxM.newPage();
await pm.goto(BASE, { waitUntil: "networkidle" });
await pm.getByRole("button", { name: "Campanhas" }).click();
await pm.waitForTimeout(800);
await pm.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
await pm.waitForTimeout(1200);
await pm.getByRole("button", { name: /Mesa/ }).click();
await pm.waitForTimeout(1000);
await pm.locator("tr", { hasText: "Sessão Estabilidade" }).first().click();
await pm.waitForTimeout(2000);
const overflowM = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok("Mobile. sem overflow com indicador", overflowM <= 1, `overflow=${overflowM}px`);
ok("Mobile. indicador visível", await pm.locator(".mesa-view .conexao").count() === 1);
await ctxM.close();

ok("Geral. sem pageerror", erros.length === 0, erros.slice(0, 3).join(" | "));

await browser.close();
// encerra a sessão de teste
await apiM("PATCH", `/api/campaigns/${CID}/sessoes/${SID}`, { status: "encerrada" });
db.prepare("delete from auth_sessions where user_agent='teste-estab'").run();

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length} passaram, ${falhas.length} falharam`);
process.exit(falhas.length ? 1 : 0);
