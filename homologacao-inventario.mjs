// Homologação: inventário com cálculos automáticos (tabela semantico "item").
// Cobre validação backend (não-negativos, munição ≤ capacidade), totais
// derivados por linha e resumo geral, persistência e visual desktop/mobile.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const CID = "179dd61c-6f4e-4c54-bf88-1e255a506743"; // teste-mestree (modelo do usuário)
const TPL = "15f955fd-f5aa-4484-8f3e-24980d212760";
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const db = new Database("banco/mestre-rpg.db");
const u = db.prepare("select id from users where username='administrador'").get();
const token = "inv-" + crypto.randomUUID();
db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
  .run(crypto.randomUUID(), u.id, hashToken(token), "hom-inv", "127.0.0.1", Date.now() + 3600000, Date.now());

const H = { "content-type": "application/json", cookie: `mestre_rpg_session=${token}` };
const api = async (m, path, body) => {
  const r = await fetch(BASE + path, { method: m, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
};

// publica v3 do modelo (necessário p/ criar personagem)
const pub = await api("POST", `/api/campaigns/${CID}/sheet-templates/${TPL}/publish`, { versionId: "7ba0d521-8805-4cc0-8838-1c326efce5c2" });
ok("publicar v3", pub.status === 200, `status=${pub.status}`);

const novo = await api("POST", `/api/campaigns/${CID}/characters`, { name: "PJ Inventário" });
ok("criar personagem", novo.status === 201 || novo.status === 200, `status=${novo.status} ${JSON.stringify(novo.json?.erro ?? "")}`);
const charId = novo.json?.personagem?.id;

// descobre o campo Itens (tabela semantico item) e Dinheiro/Veiculos
let ficha = (await api("GET", `/api/characters/${charId}`)).json?.ficha;
const todosCampos = [];
for (const s of ficha.estrutura.secoes) for (const c of s.campos ?? []) todosCampos.push(c);
const itensId = todosCampos.find(c => c.tipo === "tabela" && c.semantico === "item" && (c.colunas ?? []).some(x => x.key === "valor_compra"))?.id;
const veicId = todosCampos.find(c => c.tipo === "tabela" && (c.colunas ?? []).some(x => x.key === "veiculo"))?.id;
ok("campo Itens encontrado", !!itensId, itensId);

const PATCH = (data) => api("PATCH", `/api/characters/${charId}`, { data });

// ---------- backend: validações ----------
{
  const r = await PATCH({ [itensId]: [{ item: "Munição 9mm", quantidade: 3, peso: 0.5, espaco: 1, valor_compra: 80, municao: 50, municao_max: 30 }] });
  ok("munição > capacidade -> 400", r.status === 400, `status=${r.status}`);
  const r2 = await PATCH({ [itensId]: [{ item: "X", quantidade: -1 }] });
  ok("quantidade negativa -> 400", r2.status === 400, `status=${r2.status}`);
  const r3 = await PATCH({ [itensId]: [{ item: "X", peso: -0.5 }] });
  ok("peso negativo -> 400", r3.status === 400, `status=${r3.status}`);
  const r4 = await PATCH({ [itensId]: [{ item: "Revólver", municao: 6, municao_max: 6 }] });
  ok("arma com munição ok -> 200", r4.status === 200, `status=${r4.status} ${JSON.stringify(r4.json?.detalhes ?? "")}`);
}

// ---------- salva inventário de teste ----------
const inv = [
  { item: "Munição 9mm", categoria: "municao", quantidade: 3, municao: 30, municao_max: 30, peso: 0.5, espaco: 1, condicao: "nova", valor_compra: 80, descricao: "3 caixas" },
  { item: "Kit ferramentas", categoria: "ferramenta", quantidade: 1, peso: 2, espaco: 2, condicao: "usada", valor_compra: 150 },
  { item: "Pão", categoria: "alimento", quantidade: 5, peso: 0.2, espaco: 0.5, valor_compra: 2 },
];
{
  const r = await PATCH({ [itensId]: inv });
  ok("salvar inventário -> 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.detalhes ?? "")}`);
}

// ---------- UI: totais por linha, resumo, veículo sem cálculo ----------
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
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
  await p.locator("tr", { hasText: "PJ Inventário" }).first().click();
  await p.waitForTimeout(1500);

  // leitura: resumo geral esperado
  // Munição: 3×0.5=1.5kg, 3×1=3 esp, 3×80=240 | Kit: 1×2=2kg, 2 esp, 150 | Pão: 5×0.2=1kg, 2.5 esp, 10
  // totais: peso 4.5kg | espaço 7.5 | valor R$ 400
  const resumo = await p.locator(".tabela-resumo").first().textContent().catch(() => null);
  ok("resumo: peso total 4,5 kg", !!resumo && resumo.includes("4,5"), resumo);
  ok("resumo: espaço total 7,5", !!resumo && resumo.includes("7,5"), resumo);
  ok("resumo: valor total R$ 400,00", !!resumo && resumo.includes("400,00"), resumo);

  const linhasTot = await p.locator(".linha-totais").allTextContents();
  ok("total por linha visível (3 linhas c/ totais)", linhasTot.length >= 3, `n=${linhasTot.length}`);
  ok("linha Munição: 1,5 kg", linhasTot.some(t => t.includes("1,5")), linhasTot[0]);

  // edição: muda quantidade de 5 -> 10 e confere resumo
  await p.getByRole("button", { name: "Editar ficha" }).click();
  await p.waitForTimeout(1200);
  // campo Itens: inputs na ordem das colunas; Pão é a 3ª linha, quantidade é o 3º input da linha
  const secao = p.locator(".campo", { hasText: "Itens" }).first();
  const linhas = secao.locator(".linha-tabela");
  const nLinhas = await linhas.count();
  ok("3 linhas de inventário na edição", nLinhas === 3, `n=${nLinhas}`);
  // Pão: quantidade é input[2] da linha (item,categoria,quantidade,...)
  const inputQtdPao = linhas.nth(2).locator("input").nth(2);
  await inputQtdPao.fill("10");
  await p.waitForTimeout(400);
  // novo peso total: 1.5+2+ (10×0.2=2) = 5.5kg ; espaço: 3+2+5=10 ; valor: 240+150+20=410
  const resumo2 = await p.locator(".tabela-resumo").first().textContent();
  ok("edição qtd 5->10: peso 5,5", resumo2.includes("5,5"), resumo2);
  ok("edição qtd 5->10: espaço 10", resumo2.includes("10"), resumo2);
  ok("edição qtd 5->10: valor R$ 410,00", resumo2.includes("410,00"), resumo2);

  await p.getByRole("button", { name: "Salvar", exact: true }).click();
  await p.waitForTimeout(1200);
  await ctx.close();

  // recarrega e confere persistência
  const ctx2 = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx2.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const p2 = await ctx2.newPage();
  await p2.goto(BASE, { waitUntil: "networkidle" });
  await p2.getByRole("button", { name: "Campanhas" }).click();
  await p2.waitForTimeout(700);
  await p2.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p2.waitForTimeout(1000);
  await p2.getByRole("button", { name: /Personagens/ }).click();
  await p2.waitForTimeout(800);
  await p2.locator("tr", { hasText: "PJ Inventário" }).first().click();
  await p2.waitForTimeout(1500);
  const resumo3 = await p2.locator(".tabela-resumo").first().textContent().catch(() => null);
  ok("após reload: totais persistem calculados", !!resumo3 && resumo3.includes("410,00"), resumo3);
  await ctx2.close();

  // mobile: sem overflow horizontal
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx3.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const p3 = await ctx3.newPage();
  await p3.goto(BASE, { waitUntil: "networkidle" });
  await p3.getByRole("button", { name: "Campanhas" }).click();
  await p3.waitForTimeout(700);
  await p3.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p3.waitForTimeout(1000);
  await p3.getByRole("button", { name: /Personagens/ }).click();
  await p3.waitForTimeout(800);
  await p3.locator("tr", { hasText: "PJ Inventário" }).first().click();
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
