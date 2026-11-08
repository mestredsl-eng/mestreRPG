// Homologação da correção de bolinhas: quantidade = máximo, zero = tudo vazio.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const PID = "c31be31f-752a-4f4d-bbae-bb85cc52ffe1";
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const db = new Database("banco/mestre-rpg.db");
const u = db.prepare("select id from users where username='admin'").get();
const token = "fd-" + crypto.randomUUID();
db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
  .run(crypto.randomUUID(), u.id, hashToken(token), "hom-faixa", "127.0.0.1", Date.now() + 3600000, Date.now());

const browser = await chromium.launch();

async function novaPagina(w = 1920, h = 1080) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR", String(e)));
  await p.goto(BASE, { waitUntil: "networkidle" });
  return { ctx, p };
}

async function abrirPersonagem(p) {
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(700);
  await p.locator(".cartao-campanha", { hasText: "Caçadores" }).first().click();
  await p.waitForTimeout(1000);
  await p.getByRole("button", { name: /Personagens/ }).click();
  await p.waitForTimeout(800);
  await p.locator("tr", { hasText: "PJ Ficha Definitiva" }).first().click();
  await p.waitForTimeout(1200);
}

// conta bolinhas/cheias de um campo pelo rótulo exato do .campo-label
const medirCampo = (p, label) => p.evaluate((lab) => {
  const labels = [...document.querySelectorAll(".campo-label")];
  const l = labels.find((x) => (x.childNodes[0]?.textContent ?? "").trim() === lab);
  const campo = l?.closest(".campo");
  if (!campo) return { total: -1, cheias: -1, temInput: false };
  return {
    total: campo.querySelectorAll(".bolinha").length,
    cheias: campo.querySelectorAll(".bolinha.cheia").length,
    temInput: !!campo.querySelector("input[type=number]"),
    valor: campo.querySelector(".seletor-valor")?.textContent?.trim() ?? null,
  };
}, label);

// ---------- A) Personagem real: 0-5, 0-10, input numérico, salvar/recarregar ----------
{
  const { ctx, p } = await novaPagina();
  await abrirPersonagem(p);

  const forca = await medirCampo(p, "Força");
  ok("Força (0-5): 5 bolinhas", forca.total === 5, `total=${forca.total}`);
  const humanidade = await medirCampo(p, "Humanidade");
  ok("Humanidade (0-10): 10 bolinhas", humanidade.total === 10, `total=${humanidade.total}`);
  const idade = await medirCampo(p, "Idade");
  ok("Idade (18-60): sem bolinhas", idade.total === 0, `bolinhas=${idade.total}`);

  // edição: 4 -> clica 3 (3 cheias) -> clica 3 de novo (limpa) -> clica 2 -> salvar
  await p.getByRole("button", { name: "Editar ficha" }).click();
  await p.waitForTimeout(1000);
  const idadeEdit = await medirCampo(p, "Idade");
  ok("Idade em edição: input numérico", idadeEdit.temInput && idadeEdit.total === 0, `input=${idadeEdit.temInput}`);
  await p.locator('button[aria-label="Força: 3"]').click();
  await p.waitForTimeout(400);
  let m = await medirCampo(p, "Força");
  ok("Força=3: 3 bolinhas cheias", m.cheias === 3 && m.valor === "3", `cheias=${m.cheias} valor=${m.valor}`);
  await p.locator('button[aria-label="Força: 3"]').click();
  await p.waitForTimeout(400);
  m = await medirCampo(p, "Força");
  ok("Força limpa: 0 cheias (zero = tudo vazio)", m.cheias === 0, `cheias=${m.cheias} valor=${m.valor}`);
  await p.locator('button[aria-label="Força: 2"]').click();
  await p.waitForTimeout(400);
  m = await medirCampo(p, "Força");
  ok("Força=2: 2 cheias", m.cheias === 2 && m.valor === "2", `cheias=${m.cheias} valor=${m.valor}`);

  await p.getByRole("button", { name: "Salvar", exact: true }).click();
  await p.waitForTimeout(1200);
  await ctx.close();
}

// recarrega e confere persistência
{
  const { ctx, p } = await novaPagina();
  await abrirPersonagem(p);
  const m = await medirCampo(p, "Força");
  ok("Após salvar/recarregar: Força=2 persistido", m.cheias === 2 && m.valor === "2", `cheias=${m.cheias} valor=${m.valor}`);
  ok("Após reload: ainda 5 bolinhas", m.total === 5, `total=${m.total}`);
  await ctx.close();
}

// ---------- B) Editor: pré-visualização com ranges 1-5, 0-3, 1-3 ----------
async function previaComRange(p, min, max) {
  // abre editor do modelo, expande Talentos, edita Prontidão
  await p.getByRole("button", { name: /Fichas/ }).click();
  await p.waitForTimeout(1200);
  await p.locator(".cartao-item", { hasText: "Ficha Caçadores & Caçados" }).first().click();
  await p.waitForTimeout(1000);
  await p.locator("button.link", { hasText: "Talentos" }).first().click();
  await p.waitForTimeout(400);
  const linha = p.locator(".campo-editor-linha", { hasText: "Prontidão" }).first();
  await linha.locator("button", { hasText: "Editar" }).click();
  await p.waitForTimeout(400);
  const ed = p.locator(".formulario-edicao");
  await ed.getByRole("spinbutton", { name: "Mínimo", exact: true }).fill(String(min));
  await ed.getByRole("spinbutton", { name: "Máximo", exact: true }).fill(String(max));
  await ed.getByRole("button", { name: "Salvar campo" }).click();
  await p.waitForTimeout(400);
  await p.locator(".abas button", { hasText: "Pré-visualização" }).click();
  await p.waitForTimeout(800);
  // conta bolinhas do campo Prontidão na prévia (botões com aria-label)
  return await p.locator('button.bolinha[aria-label^="Prontidão:"]').count();
}

{
  const { ctx, p } = await novaPagina();
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(700);
  await p.locator(".cartao-campanha", { hasText: "Caçadores" }).first().click();
  await p.waitForTimeout(1000);

  const casos = [
    [1, 5, 5], [0, 3, 3], [1, 3, 3], [0, 5, 5],
  ];
  for (const [min, max, esperado] of casos) {
    // volta à aba Editor antes de re-editar (a menos da primeira)
    const n = await previaComRange(p, min, max);
    ok(`Range ${min}-${max}: ${esperado} bolinhas`, n === esperado, `bolinhas=${n}`);
    // volta para o editor para o próximo caso
    await p.locator(".abas button", { hasText: "Editor" }).click();
    await p.waitForTimeout(400);
  }
  await ctx.close();
}

await browser.close();
const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
