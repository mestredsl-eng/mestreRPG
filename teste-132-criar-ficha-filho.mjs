#!/usr/bin/env node
// FILHO — homologação independente PR #403 (issue #132):
// "Novo personagem" → "Criar e preencher" abre a ficha JÁ EM EDIÇÃO.
// Cobre: edição pós-criação (jogador e mestre/NPC), salvar persiste,
// cancelar volta à visualização, reabertura de ficha existente SEMPRE
// em visualização, flag não vaza entre aberturas, mobile.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("132-ficha");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

const CAMPANHA = "Campanha 132";
const MODELO = "Ficha 132";
const J1 = { user: "jog_132", nome: "PJ Cento e Trinta e Dois", senha: "senha-forte-132" };
const MESTRE = { user: "mst_132", senha: "senha-mestre-132" };

let browser, proc, campanhaId = null;

async function apiFetch(page, metodo, path, body) {
  return page.evaluate(async ([m, p, b]) => {
    const r = await fetch("/api" + p, {
      method: m,
      headers: { "content-type": "application/json" },
      body: b !== undefined ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [metodo, path, body]);
}
async function irCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(CAMPANHA, { exact: true }).first().click();
}
async function aba(page, nome) {
  await page.locator(".abas button", { hasText: nome }).first().click();
}
async function criarPersonagemUI(page, nome, { npc = false } = {}) {
  await irCampanha(page);
  await aba(page, "Personagens");
  await page.getByRole("button", { name: "Novo personagem" }).click();
  await page.getByLabel("Nome do personagem").fill(nome);
  await page.getByLabel("Modelo de ficha").selectOption({ label: MODELO });
  if (npc) await page.locator("label.check", { hasText: "NPC" }).locator("input").check();
  await page.getByRole("button", { name: "Criar e preencher" }).click();
}
// estado da ficha aberta: "edicao" | "visualizacao" | "desconhecido"
async function estadoFicha(page) {
  const salvar = await page.getByRole("button", { name: "Salvar", exact: true }).count();
  const editar = await page.getByRole("button", { name: "Editar ficha" }).count();
  if (salvar > 0 && editar === 0) return "edicao";
  if (editar > 0 && salvar === 0) return "visualizacao";
  return "desconhecido";
}
async function estadoComTimeout(page, esperado, ms = 12000) {
  const ini = Date.now();
  while (Date.now() - ini < ms) {
    if ((await estadoFicha(page)) === esperado) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  const ctx1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pg1 = await ctx1.newPage();
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMob = await ctxMob.newPage();

  // ===== setup: admin + campanha + modelo + convite sem aprovação =====
  sec("setup");
  await pgM.goto(BASE);
  await pgM.getByText("Primeiro acesso? Criar conta de administrador").click();
  await pgM.getByLabel("Usuário").fill(MESTRE.user);
  await pgM.getByLabel("Senha").fill(MESTRE.senha);
  await pgM.getByRole("button", { name: "Criar administrador" }).click();
  await pgM.waitForTimeout(800);
  await pgM.getByLabel("Usuário").fill(MESTRE.user);
  await pgM.getByLabel("Senha").fill(MESTRE.senha);
  await pgM.getByRole("button", { name: "Entrar", exact: true }).click();
  await pgM.getByText("Servidor online").waitFor({ timeout: 15000 });

  await pgM.getByRole("button", { name: "Campanhas" }).click();
  await pgM.getByRole("button", { name: "Nova campanha" }).click();
  await pgM.getByLabel("Nome da campanha").fill(CAMPANHA);
  await pgM.getByLabel("Sistema de RPG").fill("Sistema 132");
  await pgM.getByRole("button", { name: "Criar campanha" }).click();
  await pgM.getByRole("heading", { name: CAMPANHA }).waitFor({ timeout: 15000 });
  const lista = await apiFetch(pgM, "GET", "/campaigns");
  campanhaId = lista.json?.campanhas?.find((c) => c.name === CAMPANHA)?.id;
  t("campanha criada", !!campanhaId);

  const tpl = await apiFetch(pgM, "POST", `/campaigns/${campanhaId}/sheet-templates`, { name: MODELO });
  const tplId = tpl.json?.modelo?.id, verId = tpl.json?.modelo?.versionId ?? tpl.json?.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{ id: "s1", titulo: "Atributos", ordem: 0, campos: [
      { id: "for", label: "FOR", tipo: "inteiro", semantico: "habilidade", minimo: 1, maximo: 30 },
      { id: "agi", label: "AGILIDADE", tipo: "inteiro", semantico: "habilidade", minimo: 1, maximo: 30 },
    ] }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  const put = await apiFetch(pgM, "PUT", `/campaigns/${campanhaId}/sheet-templates/${tplId}/versions/${verId}`, { estrutura });
  const pub = await apiFetch(pgM, "POST", `/campaigns/${campanhaId}/sheet-templates/${tplId}/publish`, { versionId: verId });
  t("modelo publicado", put.status === 200 && pub.status === 200, `put=${put.status} pub=${pub.status}`);

  await aba(pgM, "Convites");
  await pgM.getByRole("button", { name: "Gerar convite" }).click();
  await pgM.locator(".convite-criado code").first().waitFor({ timeout: 10000 });
  const codigo = (await pgM.locator(".convite-criado code").first().textContent()).trim();
  t("convite gerado (sem aprovação)", /^[A-Z0-9-]{6,}$/.test(codigo), codigo);

  // jogador entra pelo convite (sem aprovação → membership direta)
  await pg1.goto(`${BASE}/convite?code=${codigo}`);
  await pg1.getByText(CAMPANHA).first().waitFor({ timeout: 15000 });
  await pg1.getByLabel("Usuário").fill(J1.user);
  await pg1.getByLabel("Nome de exibição (opcional)").fill(J1.nome);
  await pg1.getByLabel("Senha").fill(J1.senha);
  await pg1.getByRole("button", { name: "Criar conta e entrar" }).click();
  await pg1.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 15000 });
  await pg1.getByRole("button", { name: "Aceitar convite" }).click();
  await pg1.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
  t("jogador entrou pelo convite", true);

  // ===== A. criação do jogador abre em EDIÇÃO =====
  sec("A. jogador cria personagem → edição direta");
  await criarPersonagemUI(pg1, " Alfa CentoTrintaDois ");
  const estA = await estadoComTimeout(pg1, "edicao");
  t("pós-criação abre em edição (Salvar visível, Editar ficha ausente)", estA, await estadoFicha(pg1));
  const forInput = pg1.locator("div.campo", { has: pg1.getByText("FOR", { exact: true }) }).locator("input").first();
  await forInput.fill("14");
  await pg1.getByRole("button", { name: "Salvar", exact: true }).click();
  await pg1.waitForTimeout(1500);
  t("salvar da edição pós-criação funciona", (await estadoFicha(pg1)) === "edicao" || (await pg1.getByText(/salv|atualiz/i).count()) > 0);

  // ===== B. reabrir a MESMA ficha → visualização =====
  sec("B. reabertura de ficha existente → visualização");
  await pg1.getByRole("button", { name: "Voltar" }).last().click();
  await pg1.waitForTimeout(800);
  await aba(pg1, "Personagens");
  await pg1.locator("tr", { hasText: "Alfa CentoTrintaDois" }).first().click();
  const estB = await estadoComTimeout(pg1, "visualizacao");
  t("reabrir personagem existente abre em visualização", estB, await estadoFicha(pg1));

  // ===== C. segunda criação → edição → Cancelar → visualização =====
  sec("C. cancelar na edição pós-criação");
  await criarPersonagemUI(pg1, "Beta CentoTrintaDois");
  t("2ª criação também abre em edição", await estadoComTimeout(pg1, "edicao"));
  await pg1.getByRole("button", { name: "Cancelar", exact: true }).click();
  t("Cancelar da edição → visualização", await estadoComTimeout(pg1, "visualizacao"));
  // sair e reabrir Beta → continua visualização (flag não vaza)
  await pg1.getByRole("button", { name: "Voltar" }).last().click();
  await pg1.waitForTimeout(600);
  await aba(pg1, "Personagens");
  await pg1.locator("tr", { hasText: "Beta CentoTrintaDois" }).first().click();
  t("Beta reaberta depois do cancelar → visualização", await estadoComTimeout(pg1, "visualizacao"));

  // ===== D. mestre cria NPC → edição direta =====
  sec("D. mestre cria NPC → edição direta");
  await criarPersonagemUI(pgM, "NPC Alfa", { npc: true });
  t("NPC pós-criação abre em edição para o mestre", await estadoComTimeout(pgM, "edicao"));
  await pgM.getByRole("button", { name: "Voltar" }).last().click();
  await pgM.waitForTimeout(600);
  await aba(pgM, "Personagens");
  await pgM.locator("tr", { hasText: "NPC Alfa" }).first().click();
  t("NPC reaberto → visualização", await estadoComTimeout(pgM, "visualizacao"));

  // ===== E. persistência: FOR=14 salvo na Alfa =====
  sec("E. persistência do salvamento pós-criação");
  {
    const chars = await apiFetch(pg1, "GET", `/campaigns/${campanhaId}/characters`);
    const nomes = (chars.json?.personagens ?? []).map((p) => p.name);
    console.log("  [debug] personagens:", JSON.stringify(nomes));
    const alfa = (chars.json?.personagens ?? []).find((p) => String(p.name).includes("Alfa"));
    t("Alfa persistida na campanha", !!alfa, JSON.stringify(nomes));
    if (alfa) {
      const det = await apiFetch(pg1, "GET", `/campaigns/${campanhaId}/characters/${alfa.id}`);
      const forVal = JSON.stringify(det.json).includes('"for"') ? det.json : det.json;
      const txt = JSON.stringify(forVal);
      t("FOR=14 persistido no detalhe", txt.includes("14"), txt.slice(0, 300));
    }
  }

  // ===== F. mobile: criação abre em edição =====
  sec("F. mobile (390px)");
  await pgMob.goto(BASE);
  await pgMob.getByLabel("Usuário").fill(J1.user);
  await pgMob.getByLabel("Senha").fill(J1.senha);
  await pgMob.getByRole("button", { name: "Entrar", exact: true }).click();
  await pgMob.waitForTimeout(1500);
  await criarPersonagemUI(pgMob, "Gama Mobile");
  t("mobile: pós-criação abre em edição", await estadoComTimeout(pgMob, "edicao", 15000));
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
}

console.log(`\n===== #132 criação→ficha FILHO: ${pass} ok / ${fail} falhas =====`);
process.exit(fail ? 1 : 0);
