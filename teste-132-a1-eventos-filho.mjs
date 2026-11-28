#!/usr/bin/env node
// FILHO — homologação independente PR #405 (lote A1 #132):
// EquipamentoArmazem filtra eventos socket por characterId.
// Vetores:
//  A) patrimônio:atualizado {characterId: Alfa} → painel da ALFA recarrega,
//     painel da BETA faz ZERO requests de inventário/equip/veículos.
//  B) evento global inventario:atualizado {} (catálogo) → AMBOS recarregam.
//  C) simetria: mutação na BETA → BETA recarrega, ALFA zero.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("132-a1");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

const CAMPANHA = "Campanha A1";
const MODELO = "Ficha A1";
const J1 = { user: "jog_a1", nome: "PJ A1", senha: "senha-a1-forte" };
const MESTRE = { user: "mst_a1", senha: "senha-mestre-a1" };

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
async function irPersonagem(page, nome) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(CAMPANHA, { exact: true }).first().click();
  await page.locator(".abas button", { hasText: "Personagens" }).first().click();
  await page.locator("tr", { hasText: nome }).first().click();
}
async function abrirArmazem(page, nome) {
  await irPersonagem(page, nome);
  await page.getByRole("button", { name: "Equipamento/Armazém" }).click();
  await page.waitForTimeout(1500); // 3 GETs iniciais assentam
}
// conta GETs de dados do armazém após o settle
function contarArmazem(page) {
  const estado = { n: 0 };
  const ouvinte = (req) => {
    if (req.method() === "GET" && /\/(inventario|equipamentos|veiculos)(\/|\?|$)/.test(req.url())) estado.n++;
  };
  page.on("request", ouvinte);
  return { estado, parar: () => page.off("request", ouvinte) };
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  const ctx1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgA = await ctx1.newPage();
  const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgB = await ctx2.newPage();

  // ===== setup =====
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
  await pgM.getByLabel("Sistema de RPG").fill("Sistema A1");
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
    ] }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await apiFetch(pgM, "PUT", `/campaigns/${campanhaId}/sheet-templates/${tplId}/versions/${verId}`, { estrutura });
  await apiFetch(pgM, "POST", `/campaigns/${campanhaId}/sheet-templates/${tplId}/publish`, { versionId: verId });
  t("modelo publicado", true);

  await pgM.locator(".abas button", { hasText: "Convites" }).first().click();
  await pgM.getByRole("button", { name: "Gerar convite" }).click();
  await pgM.locator(".convite-criado code").first().waitFor({ timeout: 10000 });
  const codigo = (await pgM.locator(".convite-criado code").first().textContent()).trim();

  // jogador entra
  await pgA.goto(`${BASE}/convite?code=${codigo}`);
  await pgA.getByText(CAMPANHA).first().waitFor({ timeout: 15000 });
  await pgA.getByLabel("Usuário").fill(J1.user);
  await pgA.getByLabel("Nome de exibição (opcional)").fill(J1.nome);
  await pgA.getByLabel("Senha").fill(J1.senha);
  await pgA.getByRole("button", { name: "Criar conta e entrar" }).click();
  await pgA.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 15000 });
  await pgA.getByRole("button", { name: "Aceitar convite" }).click();
  await pgA.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });

  // cria Alfa e Beta via API (mesma sessão do jogador)
  const cA = await apiFetch(pgA, "POST", `/campaigns/${campanhaId}/characters`, { name: "Alfa A1", templateVersionId: verId });
  const cB = await apiFetch(pgA, "POST", `/campaigns/${campanhaId}/characters`, { name: "Beta A1", templateVersionId: verId });
  const idA = cA.json?.personagem?.id ?? cA.json?.id;
  const idB = cB.json?.personagem?.id ?? cB.json?.id;
  t("dois personagens criados", !!idA && !!idB, `A=${cA.status} B=${cB.status}`);

  // ===== painéis de Armazém abertos =====
  sec("painéis abertos");
  await abrirArmazem(pgA, "Alfa A1");
  // 2º contexto = sessão nova — login do mesmo jogador
  await pgB.goto(BASE);
  await pgB.getByLabel("Usuário").fill(J1.user);
  await pgB.getByLabel("Senha").fill(J1.senha);
  await pgB.getByRole("button", { name: "Entrar", exact: true }).click();
  await pgB.waitForTimeout(1500);
  await abrirArmazem(pgB, "Beta A1");

  // ===== A) evento per-character =====
  sec("A. patrimônio na Alfa → só painel da Alfa recarrega");
  const cntA = contarArmazem(pgA), cntB = contarArmazem(pgB);
  await dormir(500);
  cntA.estado.n = 0; cntB.estado.n = 0;
  const add = await apiFetch(pgM, "POST", `/characters/${idA}/inventario`, { name: "Poção A1" });
  t("mestre adicionou item ao inventário da Alfa", add.status === 201 || add.status === 200, `status=${add.status}`);
  await dormir(2500);
  t("painel Alfa recarregou (Patrimonio+Armazém)", cntA.estado.n >= 5, `n=${cntA.estado.n}`);
  // Baseline conhecido: Patrimonio.tsx (sempre montado, fora do escopo
  // A1) emite 2 GETs casados por evento — se EquipamentoArmazém
  // regredir, some +3 (sua assinatura exata) → n>=5.
  t("painel Beta: EquipArmazém filtrou (só baseline Patrimonio ≤2)", cntB.estado.n <= 2, `n=${cntB.estado.n}`);
  cntA.parar(); cntB.parar();

  // ===== C) simetria =====
  sec("C. simetria — mutação na Beta");
  const cntA2 = contarArmazem(pgA), cntB2 = contarArmazem(pgB);
  await dormir(500);
  cntA2.estado.n = 0; cntB2.estado.n = 0;
  await apiFetch(pgM, "POST", `/characters/${idB}/inventario`, { name: "Poção B1" });
  await dormir(2500);
  t("painel Beta recarregou", cntB2.estado.n >= 5, `n=${cntB2.estado.n}`);
  t("painel Alfa: EquipArmazém filtrou (só baseline Patrimonio ≤2)", cntA2.estado.n <= 2, `n=${cntA2.estado.n}`);
  cntA2.parar(); cntB2.parar();

  // ===== B) evento global =====
  sec("B. catálogo (evento global {}) → ambos recarregam");
  const cntA3 = contarArmazem(pgA), cntB3 = contarArmazem(pgB);
  await dormir(500);
  cntA3.estado.n = 0; cntB3.estado.n = 0;
  const cat = await apiFetch(pgM, "POST", `/campaigns/${campanhaId}/inventario`, { name: "Item Catálogo A1", isActive: true });
  t("catálogo criado (emissor global)", cat.status === 201 || cat.status === 200, `status=${cat.status}`);
  await dormir(2500);
  t("painel Alfa recarregou no evento global", cntA3.estado.n >= 1, `n=${cntA3.estado.n}`);
  t("painel Beta recarregou no evento global", cntB3.estado.n >= 1, `n=${cntB3.estado.n}`);
  cntA3.parar(); cntB3.parar();
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
}

console.log(`\n===== A1 filtro eventos socket FILHO: ${pass} ok / ${fail} falhas =====`);
process.exit(fail ? 1 : 0);
