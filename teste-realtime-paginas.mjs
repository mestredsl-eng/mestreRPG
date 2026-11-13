// Issue #67 — sincronização em tempo real das páginas da campanha.
// Dois+ clientes reais (Playwright): alteração feita por A deve aparecer
// em B sem refresh manual, sem vazar conteúdo privado e sem loops.
// Cobre: Diário (privada/mestre/selecionada), Arquivos, Regras,
// Modelos de ficha e Histórico — em desktop e mobile.
// Banco temporário + fixtures sintéticas; nunca toca dados reais.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, sessao, req, encerrarServidor, limparDir, abrirDb,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = dirTeste("rt-paginas");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

let browser, proc;

async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function abrirCampanha(page, nome) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(nome, { exact: true }).first().click();
  await page.locator(".abas").waitFor({ timeout: 15000 });
}
async function aba(page, nome) {
  await page.locator(".abas button", { hasText: nome }).first().click();
}
/** Seleciona opção de um <select> pelo texto da <option>. */
async function selecionarOpcao(page, escopo, rotulo) {
  const sel = page.locator(escopo).filter({ has: page.locator(`option:text-is("${rotulo}")`) }).first();
  await sel.selectOption({ label: rotulo });
}
async function aparece(page, texto, timeout = 12000) {
  try { await page.getByText(texto, { exact: false }).first().waitFor({ timeout }); return true; }
  catch { return false; }
}
async function naoAparece(page, texto, esperaMs = 3000) {
  await sleep(esperaMs);
  return (await page.getByText(texto, { exact: false }).count()) === 0;
}

try {
  mkdirSync(join(DIR, "banco"), { recursive: true });
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  const NOME_CAMP = "Campanha RT Páginas";
  const cenario = await criarCenario(BASE, BANCO, {
    campanha: NOME_CAMP,
    jogadores: { a: "rt_jog_a", b: "rt_jog_b" },
  });
  const { campId, cookieMestre, adminId } = cenario;
  const cookieA = cenario.jogadores.a.cookie;
  const cookieB = cenario.jogadores.b.cookie;

  // Segundo mestre (mesma campanha) para provar sincronização mestre↔mestre.
  const dbw = abrirDb(BANCO);
  const uidM2 = crypto.randomUUID();
  const agora = Date.now();
  dbw.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
    .run(uidM2, "rt_mestre2", "Mestre Dois", await hashSenha("senha-mestre2-123"), agora, agora);
  dbw.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'mestre','ativo',?,?,?)")
    .run(crypto.randomUUID(), campId, uidM2, agora, agora, agora);
  dbw.close();
  const cookieM2 = sessao(BANCO, uidM2);

  browser = await chromium.launch();

  // ---------- desktop: 4 contextos (mestre1, mestre2, jogadorA, jogadorB) ----------
  sec("desktop — Diário com dois clientes");
  const ctxM = await browser.newContext();
  const ctxM2 = await browser.newContext();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pm = await ctxM.newPage();
  const pm2 = await ctxM2.newPage();
  const pa = await ctxA.newPage();
  const pb = await ctxB.newPage();

  await login(pm, "mestre_teste", "senha-forte-123");
  await login(pm2, "rt_mestre2", "senha-mestre2-123");
  await login(pa, "rt_jog_a", "senha-jogador-123");
  await login(pb, "rt_jog_b", "senha-jogador-123");
  for (const p of [pm, pm2, pa, pb]) await abrirCampanha(p, NOME_CAMP);

  // todos na aba Diário
  for (const p of [pm, pa, pb]) await aba(p, "Diário");

  // 1) Jogador A cria anotação pública → mestre vê sem refresh
  await aba(pa, "Diário");
  await pa.getByRole("button", { name: "Nova anotação", exact: true }).click();
  await pa.locator('.formulario input[placeholder="Título"]').fill("Nota RT pública");
  await pa.locator('.formulario textarea').fill("conteúdo público de teste");
  await selecionarOpcao(pa, ".formulario select", "Todos os participantes");
  await pa.locator(".formulario").getByRole("button", { name: "Salvar" }).click();
  t("diário: anotação pública do jogador aparece para o mestre", await aparece(pm, "Nota RT pública"));
  t("diário: autor mantém a própria anotação", await aparece(pa, "Nota RT pública"));

  // 2) Privada do jogador → mestre NÃO vê
  await pa.getByRole("button", { name: "Nova anotação", exact: true }).click();
  await pa.locator('.formulario input[placeholder="Título"]').fill("Nota RT privada A");
  await pa.locator('.formulario textarea').fill("segredo do jogador A");
  await selecionarOpcao(pa, ".formulario select", "Somente eu");
  await pa.locator(".formulario").getByRole("button", { name: "Salvar" }).click();
  t("diário: anotação privada do jogador não vaza para o mestre", await naoAparece(pm, "Nota RT privada A"));

  // 3) Só-mestre do mestre → jogadores A e B NÃO veem
  await aba(pm, "Diário");
  await pm.getByRole("button", { name: "Nova anotação", exact: true }).click();
  await pm.locator('.formulario input[placeholder="Título"]').fill("Nota RT só mestre");
  await pm.locator('.formulario textarea').fill("anotação restrita");
  await selecionarOpcao(pm, ".formulario select", "Mestre");
  await pm.locator(".formulario").getByRole("button", { name: "Salvar" }).click();
  t("diário: anotação do mestre aparece para o próprio mestre", await aparece(pm, "Nota RT só mestre"));
  t("diário: anotação 'mestre' não vaza para jogador A", await naoAparece(pa, "Nota RT só mestre"));
  t("diário: anotação 'mestre' não vaza para jogador B", await naoAparece(pb, "Nota RT só mestre"));

  // 4) Selecionada (só mestre como destinatário) → mestre vê, jogador B não
  await pa.getByRole("button", { name: "Nova anotação", exact: true }).click();
  await pa.locator('.formulario input[placeholder="Título"]').fill("Nota RT selecionada");
  await pa.locator('.formulario textarea').fill("só para o mestre");
  await selecionarOpcao(pa, ".formulario select", "Jogadores selecionados");
  await pa.locator('.formulario label', { hasText: "Mestre Teste" }).locator("input[type=checkbox]").check();
  await pa.locator(".formulario").getByRole("button", { name: "Salvar" }).click();
  t("diário: anotação selecionada aparece para o destinatário (mestre)", await aparece(pm, "Nota RT selecionada"));
  t("diário: anotação selecionada não vaza para não-destinatário", await naoAparece(pb, "Nota RT selecionada"));

  // ---------- Arquivos ----------
  sec("desktop — Arquivos com dois clientes");
  const arqTeste = join(DIR, "arquivo-rt.txt");
  writeFileSync(arqTeste, "conteúdo de teste realtime\n");
  await aba(pa, "Arquivos");
  await aba(pm, "Arquivos");
  await pa.locator('input[type="file"]').setInputFiles(arqTeste);
  t("arquivos: upload do jogador aparece para o mestre", await aparece(pm, "arquivo-rt.txt"));

  // moderação do mestre → some da visão pública do jogador (fica pendente)
  const modBtn = pm.locator("button", { hasText: "Aprovar" }).first();
  if (await modBtn.count()) {
    await modBtn.click();
    await sleep(1500);
  }

  // ---------- Regras (mestre1 → mestre2) ----------
  sec("desktop — Regras mestre↔mestre");
  const criados = await req(BASE, "POST", `/campaigns/${campId}/regras/elementos`, {
    cookie: cookieMestre,
    body: { kind: "habilidade", key: "rt_habilidade_sync", name: "Habilidade RT Sync", definition: {} },
  });
  t("regras: POST elemento ok", criados.status === 201, JSON.stringify(criados.json));
  await aba(pm2, "Regras");
  t("regras: novo elemento aparece para o outro mestre", await aparece(pm2, "Habilidade RT Sync"));

  // alteração de config também invalida (mesmo evento)
  const cfg = await req(BASE, "PUT", `/campaigns/${campId}/regras/config`, {
    cookie: cookieMestre, body: { notas: { jogadorCompartilha: true } },
  });
  t("regras: PUT config ok", cfg.status === 200, JSON.stringify(cfg.json));

  // ---------- Modelos de ficha (mestre1 → mestre2) ----------
  sec("desktop — Modelos de ficha mestre↔mestre");
  const mod = await req(BASE, "POST", `/campaigns/${campId}/sheet-templates`, {
    cookie: cookieMestre, body: { name: "Modelo RT Sync 123" },
  });
  t("fichas: POST modelo ok", mod.status === 201 || mod.status === 200, JSON.stringify(mod.json));
  await aba(pm2, "Fichas");
  t("fichas: novo modelo aparece para o outro mestre", await aparece(pm2, "Modelo RT Sync 123"));

  // ---------- Histórico (mestre → jogador) ----------
  sec("desktop — Histórico mestre→jogador");
  const sess = await req(BASE, "POST", `/campaigns/${campId}/sessoes`, {
    cookie: cookieMestre, body: { name: "Sessão RT Sync 456" },
  });
  t("sessões: POST sessão ok", sess.status === 201, JSON.stringify(sess.json));
  await aba(pa, "Histórico");
  t("histórico: nova sessão aparece para o jogador", await aparece(pa, "Sessão RT Sync 456"));

  // encerramento da sessão também invalida
  const sid = sess.json?.sessao?.id;
  if (sid) {
    await req(BASE, "PATCH", `/campaigns/${campId}/sessoes/${sid}`, {
      cookie: cookieMestre, body: { status: "encerrada" },
    });
    await sleep(1500);
    t("histórico: status encerrada refletido", await aparece(pa, "encerrada"));
  }

  // snapshot manual → evento snapshots:atualizados (mestre2 observa seu próprio Histórico)
  sec("desktop — snapshots no Histórico do mestre2");
  await aba(pm2, "Histórico");
  await req(BASE, "POST", `/campaigns/${campId}/snapshots`, { cookie: cookieMestre, body: { description: "Ponto RT Sync" } });
  t("histórico: novo ponto de recuperação aparece", await aparece(pm2, "Ponto RT Sync"));

  // ---------- isolamento por aba/troca de campanha ----------
  sec("desktop — troca de aba não duplica nem quebra");
  // volta ao Diário no mestre: estado continua consistente
  await aba(pm, "Diário");
  t("diário: conteúdo anterior preservado após troca de aba", await aparece(pm, "Nota RT pública") && await aparece(pm, "Nota RT só mestre"));

  // ---------- mobile ----------
  sec("mobile — Diário e Arquivos");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pmob = await ctxMob.newPage();
  await login(pmob, "rt_jog_a", "senha-jogador-123");
  await abrirCampanha(pmob, NOME_CAMP);
  await aba(pmob, "Diário");
  const notaMob = await req(BASE, "POST", `/campaigns/${campId}/anotacoes`, {
    cookie: cookieMestre,
    body: { title: "Nota RT mobile", content: "via api", kind: "diario", visibility: "publica" },
  });
  t("mobile: POST nota ok", notaMob.status === 201, JSON.stringify(notaMob.json));
  t("mobile: anotação remota aparece no Diário", await aparece(pmob, "Nota RT mobile"));

  await aba(pmob, "Arquivos");
  await aba(pm, "Arquivos"); // mestre desktop precisa estar com a aba montada
  const arqMob = join(DIR, "arquivo-rt-mobile.png");
  writeFileSync(arqMob, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await pmob.locator('input[type="file"]').setInputFiles(arqMob);
  t("mobile: upload aparece para o mestre desktop", await aparece(pm, "arquivo-rt-mobile.png"));

  // privacidade no mobile também vale
  t("mobile: nota privada do mestre não vaza", await naoAparece(pmob, "Nota RT só mestre"));

  await ctxMob.close();
  await ctxA.close(); await ctxB.close(); await ctxM.close(); await ctxM2.close();
} catch (e) {
  console.error("ERRO FATAL:", e);
  fail++;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
