// Homologação: sistema financeiro do personagem (carteira).
// Cobre saldo inicial, movimentações entrada/saída, totais calculados,
// permissões mestre/jogador, valores BRL legados, persistência e UI.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const CID = "179dd61c-6f4e-4c54-bf88-1e255a506743"; // teste-mestree
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const db = new Database("banco/mestre-rpg.db");
const sessao = (userId, tag) => {
  const token = `${tag}-` + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, hashToken(token), "hom-fin", "127.0.0.1", Date.now() + 3600000, Date.now());
  return token;
};
const admin = db.prepare("select id from users where username='administrador'").get();
const jog = db.prepare("select id from users where username='jogador_teste'").get();
// garante membership de jogador na campanha
if (!db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, jog.id)) {
  db.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), CID, jog.id, "jogador", "{}", "ativo", Date.now(), Date.now(), Date.now());
}
const tokM = sessao(admin.id, "fin-m");
const tokJ = sessao(jog.id, "fin-j");
const apiM = (m, path, body) => req(m, path, body, tokM);
const apiJ = (m, path, body) => req(m, path, body, tokJ);
async function req(m, path, body, token) {
  const r = await fetch(BASE + path, {
    method: m,
    headers: { "content-type": "application/json", cookie: `mestre_rpg_session=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const getFicha = async (charId, api) => (await api("GET", `/api/characters/${charId}`)).json?.ficha;

// ---------- cria personagem do jogador na v7 (com carteira) ----------
const novo = await apiJ("POST", `/api/campaigns/${CID}/characters`, { name: "PJ Finanças" });
ok("jogador cria personagem", novo.status === 201 || novo.status === 200, `status=${novo.status} ${JSON.stringify(novo.json?.erro ?? "")}`);
const charId = novo.json?.personagem?.id;

let ficha = await getFicha(charId, apiJ);
const todosCampos = [];
for (const s of ficha.estrutura.secoes) for (const c of s.campos ?? []) todosCampos.push(c);
const dinId = todosCampos.find(c => c.tipo === "tabela" && c.semantico === "moeda" && c.carteira)?.id;
ok("campo Dinheiro com carteira encontrado", !!dinId, dinId);
const DIN = dinId + "::saldo";

// saldo inicial padrão do modelo ("1.111,11" -> 1111.11)
{
  const cart = ficha.carteiras?.[dinId];
  ok("carteira exposta no GET", !!cart, JSON.stringify(cart));
  ok("saldo inicial padrão R$ 1.111,11", cart && Math.abs(cart.saldoInicial - 1111.11) < 0.001, `saldo=${cart?.saldoInicial}`);
}

// ---------- mestre define saldo inicial ----------
{
  const r = await apiM("PATCH", `/api/characters/${charId}`, { data: { [DIN]: 1000 } });
  ok("mestre altera saldo inicial -> 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.detalhes ?? r.json?.erro ?? "")}`);
  ficha = await getFicha(charId, apiM);
  ok("saldo inicial persistido = 1000", ficha.carteiras?.[dinId]?.saldoInicial === 1000, JSON.stringify(ficha.carteiras?.[dinId]));
}

// ---------- jogador NÃO pode alterar saldo inicial ----------
{
  const r = await apiJ("PATCH", `/api/characters/${charId}`, { data: { [DIN]: 99999 } });
  ok("jogador altera saldo -> 400", r.status === 400, `status=${r.status}`);
  ficha = await getFicha(charId, apiM);
  ok("saldo inicial continua 1000", ficha.carteiras?.[dinId]?.saldoInicial === 1000);
}

// ---------- movimentações ----------
const movs = [
  { data: "2026-11-01", descricao: "Pagamento recebido", tipo: "entrada", valor: 500 },
  { data: "2026-11-02", descricao: "Compra de equipamento", tipo: "saida", valor: 200 },
  { data: "2026-11-03", descricao: "Serviço prestado", tipo: "entrada", valor: 150 },
];
{
  const r = await apiJ("PATCH", `/api/characters/${charId}`, { data: { [dinId]: movs } });
  ok("jogador registra movimentações -> 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.detalhes ?? "")}`);
  ficha = await getFicha(charId, apiJ);
  const c = ficha.carteiras?.[dinId];
  ok("entradas = R$ 650", c && Math.abs(c.entradas - 650) < 0.001, `entradas=${c?.entradas}`);
  ok("saídas = R$ 200", c && Math.abs(c.saidas - 200) < 0.001, `saidas=${c?.saidas}`);
  ok("saldo atual = R$ 1.450", c && Math.abs(c.saldo - 1450) < 0.001, `saldo=${c?.saldo}`);
}

// ---------- edição e exclusão recalculam ----------
{
  const edit = [movs[0], { ...movs[1], valor: 250 }, movs[2]];
  await apiJ("PATCH", `/api/characters/${charId}`, { data: { [dinId]: edit } });
  ficha = await getFicha(charId, apiJ);
  let c = ficha.carteiras?.[dinId];
  ok("edição valor 200->250: saldo 1400", c && Math.abs(c.saldo - 1400) < 0.001, `saldo=${c?.saldo}`);
  await apiJ("PATCH", `/api/characters/${charId}`, { data: { [dinId]: [movs[0], movs[2]] } });
  ficha = await getFicha(charId, apiJ);
  c = ficha.carteiras?.[dinId];
  ok("exclusão recalcula: saldo 1650", c && Math.abs(c.saldo - 1650) < 0.001, `saldo=${c?.saldo}`);
}

// ---------- valores com centavos e saldo zero ----------
{
  await apiJ("PATCH", `/api/characters/${charId}`, { data: { [dinId]: [{ tipo: "entrada", descricao: "Troco", valor: 0.5 }] } });
  ficha = await getFicha(charId, apiJ);
  let c = ficha.carteiras?.[dinId];
  ok("centavos: saldo 1000,50", c && Math.abs(c.saldo - 1000.5) < 0.001, `saldo=${c?.saldo}`);
  await apiM("PATCH", `/api/characters/${charId}`, { data: { [DIN]: 0, [dinId]: [{ tipo: "saida", descricao: "Tudo", valor: 0 }] } });
  ficha = await getFicha(charId, apiJ);
  c = ficha.carteiras?.[dinId];
  ok("saldo zero funciona", c && c.saldo === 0, `saldo=${c?.saldo}`);
}

// ---------- valores BRL legados e tipo variado ----------
{
  const r = await apiJ("PATCH", `/api/characters/${charId}`, {
    data: { [dinId]: [{ data: "2026-11-05", descricao: "Legado", tipo: "Entrada", valor: "1.111,11" }] },
  });
  ok("valor '1.111,11' + tipo 'Entrada' aceito", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.detalhes ?? "")}`);
  ficha = await getFicha(charId, apiJ);
  const c = ficha.carteiras?.[dinId];
  ok("BRL normalizado: entradas 1111,11", c && Math.abs(c.entradas - 1111.11) < 0.001, `entradas=${c?.entradas}`);
  const salvo = ficha.campos[dinId];
  ok("tipo gravado canônico 'entrada'", salvo?.[0]?.tipo === "entrada", JSON.stringify(salvo?.[0]?.tipo));
  ok("valor gravado número 1111.11", salvo?.[0]?.valor === 1111.11, JSON.stringify(salvo?.[0]?.valor));
}

// ---------- escalar legado vira saldo inicial ----------
{
  const r = await apiM("PATCH", `/api/characters/${charId}`, { data: { [dinId]: "2.500,00" } });
  ok("escalar legado aceito", r.status === 200, `status=${r.status}`);
  ficha = await getFicha(charId, apiM);
  const c = ficha.carteiras?.[dinId];
  ok("escalar '2.500,00' virou saldo inicial", c && Math.abs(c.saldoInicial - 2500) < 0.001, `saldoInicial=${c?.saldoInicial}`);
  ok("movimentações zeradas na migração", Array.isArray(ficha.campos[dinId]) && ficha.campos[dinId].length === 0);
}

// ---------- validações rejeitadas ----------
{
  const casos = [
    ["tipo inválido", { [dinId]: [{ tipo: "transferencia", valor: 10 }] }],
    ["valor negativo", { [dinId]: [{ tipo: "entrada", valor: -10 }] }],
    ["valor texto", { [dinId]: [{ tipo: "entrada", valor: "abc" }] }],
    ["sem tipo", { [dinId]: [{ valor: 10 }] }],
  ];
  for (const [nome, data] of casos) {
    const r = await apiJ("PATCH", `/api/characters/${charId}`, { data });
    ok(`${nome} -> 400`, r.status === 400, `status=${r.status}`);
  }
}

// ---------- persistência: salvar e recarregar ----------
{
  const finais = [
    { data: "2026-11-01", descricao: "Pagamento recebido", tipo: "entrada", valor: 500 },
    { data: "2026-11-02", descricao: "Compra de equipamento", tipo: "saida", valor: 200 },
    { data: "2026-11-03", descricao: "Serviço prestado", tipo: "entrada", valor: 150 },
  ];
  await apiM("PATCH", `/api/characters/${charId}`, { data: { [dinId]: finais, [DIN]: 1000 } });
  ficha = await getFicha(charId, apiM);
  const c = ficha.carteiras?.[dinId];
  ok("persistência: saldo 1450", c && Math.abs(c.saldo - 1450) < 0.001, `saldo=${c?.saldo}`);
  ok("persistência: 3 movimentações", Array.isArray(ficha.campos[dinId]) && ficha.campos[dinId].length === 3);
}

// ---------- UI ----------
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
  const p = await ctx.newPage();
  const erros = [];
  p.on("pageerror", e => erros.push(String(e)));
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(900);
  await p.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p.waitForTimeout(1200);
  await p.getByRole("button", { name: /Personagens/ }).click();
  await p.waitForTimeout(800);
  await p.locator("tr", { hasText: "PJ Finanças" }).first().click();
  await p.waitForTimeout(1500);

  const saldoTxt = await p.locator(".carteira-saldo strong").first().textContent().catch(() => null);
  ok("UI. saldo atual R$ 1.450,00", !!saldoTxt && saldoTxt.includes("1.450"), saldoTxt);
  const totais = await p.locator(".carteira-totais").first().textContent().catch(() => null);
  ok("UI. entradas/saídas visíveis", !!totais && totais.includes("650") && totais.includes("200"), totais);
  const nMov = await p.locator(".carteira-linha").count();
  ok("UI. 3 movimentações no histórico", nMov === 3, `n=${nMov}`);

  // edição: adiciona movimentação e confere recálculo
  await p.getByRole("button", { name: "Editar ficha" }).click();
  await p.waitForTimeout(1200);
  await p.getByRole("button", { name: /Adicionar movimentação/ }).click();
  await p.waitForTimeout(300);
  const ultima = p.locator(".carteira-linha-edicao").last();
  await ultima.locator("input[type='text']").fill("Recompensa");
  await ultima.locator("input[type='number']").fill("50");
  await p.waitForTimeout(400);
  const saldo2 = await p.locator(".carteira-saldo strong").first().textContent();
  ok("UI. nova entrada recalcula saldo 1500", saldo2.includes("1.500"), saldo2);
  await p.getByRole("button", { name: "Salvar", exact: true }).click();
  await p.waitForTimeout(1200);

  // mobile
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx3.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
  const p3 = await ctx3.newPage();
  await p3.goto(BASE, { waitUntil: "networkidle" });
  await p3.getByRole("button", { name: "Campanhas" }).click();
  await p3.waitForTimeout(700);
  await p3.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p3.waitForTimeout(1000);
  await p3.getByRole("button", { name: /Personagens/ }).click();
  await p3.waitForTimeout(800);
  await p3.locator("tr", { hasText: "PJ Finanças" }).first().click();
  await p3.waitForTimeout(1500);
  const overflow = await p3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("mobile 390px: sem overflow horizontal", overflow <= 1, `overflow=${overflow}px`);
  await ctx3.close();

  ok("UI. sem erros de console", erros.length === 0, erros.slice(0, 2).join(" | "));
  await browser.close();
}

await db.close();
const falhas = resultados.filter(r => !r.ok).length;
console.log(`\n${resultados.length - falhas} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
