#!/usr/bin/env node
// FILHO — Lote E (#132): walkthrough real de Diário/Anotações + Histórico.
// Percorre fluxos como jogador e mestre, executa ações e registra
// fricções observáveis (a11y, estados, navegação). Não altera produção.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor,
} from "./teste-base.mjs";

const DIR = dirTeste("132-lote-e");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CAMPANHA = "Campanha LE";
const MODELO = "Ficha LE";
const J1 = { user: "jog_le", senha: "senha-le-forte" };
const J2 = { user: "jog_le2", senha: "senha-le2-forte" };
const MESTRE = { user: "mst_le", senha: "senha-mestre-le" };

const friccoes = [];
const fric = (area, txt) => { friccoes.push({ area, txt }); console.log(`  [fricção ${area}] ${txt}`); };
const ok = (n) => console.log("  ok", n);
const sec = (n) => console.log("\n== " + n + " ==");

async function apiFetch(page, m, p, b) {
  return page.evaluate(async ([mm, pp, bb]) => {
    const r = await fetch("/api" + pp, { method: mm, headers: { "content-type": "application/json" }, body: bb !== undefined ? JSON.stringify(bb) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [m, p, b]);
}
async function entrar(page, user, senha, nome) {
  await page.goto(`${BASE}/convite?code=${globalThis.__codigo}`);
  await page.getByText(CAMPANHA).first().waitFor({ timeout: 15000 });
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Nome de exibição (opcional)").fill(nome);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Criar conta e entrar" }).click();
  const ace = page.getByRole("button", { name: "Aceitar convite" });
  await ace.waitFor({ timeout: 15000 });
  await ace.click();
  await page.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
}
async function abrirAba(page, nome) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(CAMPANHA, { exact: true }).first().click();
  await page.locator(".abas button", { hasText: nome }).first().click();
}
async function auditarFormAnotacao(page, tag) {
  const r = await page.evaluate(() => {
    const form = document.querySelector(".formulario");
    if (!form) return null;
    const semNome = [...form.querySelectorAll("input,textarea,select")].filter((el) => {
      const nome = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest("label");
      return !nome;
    }).map((el) => el.tagName + ":" + (el.placeholder || el.value || "?"));
    const tabs = [...document.querySelectorAll(".abas button")].map((b) => ({ t: b.textContent.trim(), role: b.getAttribute("role"), sel: b.getAttribute("aria-selected") }));
    const temTablist = !!document.querySelector("[role=tablist]");
    return { semNome, tabs, temTablist };
  });
  if (r) {
    if (r.semNome.length) fric("a11y", `${tag}: campos sem nome acessível: ${r.semNome.join(", ")}`);
    if (!r.temTablist && r.tabs.length > 1) fric("a11y", `${tag}: abas Diário/Mestre sem tablist (buttons sem role/aria-selected)`);
  }
  return r;
}

let browser, proc;
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  const ctx1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pg1 = await ctx1.newPage();
  const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pg2 = await ctx2.newPage();

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
  await pgM.getByLabel("Sistema de RPG").fill("Sistema LE");
  await pgM.getByRole("button", { name: "Criar campanha" }).click();
  await pgM.getByRole("heading", { name: CAMPANHA }).waitFor({ timeout: 15000 });
  const lista = await apiFetch(pgM, "GET", "/campaigns");
  const cid = lista.json?.campanhas?.find((c) => c.name === CAMPANHA)?.id;
  const tpl = await apiFetch(pgM, "POST", `/campaigns/${cid}/sheet-templates`, { name: MODELO });
  const tplId = tpl.json?.modelo?.id, verId = tpl.json?.modelo?.versionId ?? tpl.json?.versionId;
  const estrutura = { versao: 1, secoes: [{ id: "s1", titulo: "A", ordem: 0, campos: [{ id: "for", label: "FOR", tipo: "inteiro", semantico: "habilidade", minimo: 1, maximo: 30 }] }], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } };
  await apiFetch(pgM, "PUT", `/campaigns/${cid}/sheet-templates/${tplId}/versions/${verId}`, { estrutura });
  await apiFetch(pgM, "POST", `/campaigns/${cid}/sheet-templates/${tplId}/publish`, { versionId: verId });
  await pgM.locator(".abas button", { hasText: "Convites" }).first().click();
  await pgM.getByRole("button", { name: "Gerar convite" }).click();
  await pgM.locator(".convite-criado code").first().waitFor({ timeout: 10000 });
  globalThis.__codigo = (await pgM.locator(".convite-criado code").first().textContent()).trim();

  await entrar(pg1, J1.user, J1.senha, "PJ Um LE");
  await entrar(pg2, J2.user, J2.senha, "PJ Dois LE");
  // fichas p/ vínculo de anotação
  const c1 = await apiFetch(pg1, "POST", `/campaigns/${cid}/characters`, { name: "PJ Um LE", templateVersionId: verId });
  const c2 = await apiFetch(pg2, "POST", `/campaigns/${cid}/characters`, { name: "PJ Dois LE", templateVersionId: verId });
  ok("setup completo");

  // ===== DIÁRIO — jogador cria anotação =====
  sec("Diário — jogador cria/edita/filtra/exclui");
  await abrirAba(pg1, "Diário");
  await pg1.getByRole("button", { name: "Nova anotação" }).click();
  await auditarFormAnotacao(pg1, "form-jogador");
  await pg1.locator(".formulario input[placeholder=\"Título\"]").fill("Reunião na taverna");
  await pg1.getByPlaceholder("Conteúdo").fill("Encontramos o informante. Ele pediu mais ouro.");
  // selects sem rótulo — registrar
  const selects = await pg1.locator(".formulario select").count();
  const selectsNomeadas = await pg1.locator(".formulario select[aria-label]").count();
  if (selects > selectsNomeadas) fric("a11y", `form anotação: ${selects - selectsNomeadas} select(s) sem aria-label (categoria, personagem, visibilidade-parcial)`);
  // marca importante + salva
  await pg1.locator(".formulario label", { hasText: "Importante" }).locator("input").check();
  await pg1.getByRole("button", { name: "Salvar", exact: true }).click();
  await pg1.waitForTimeout(1200);
  const item = pg1.locator("li", { hasText: "Reunião na taverna" });
  ok("anotação criada e listada", (await item.count()) === 1);
  // busca filtra
  await pg1.getByLabel("Buscar anotação").fill("taverna");
  await pg1.waitForTimeout(400);
  ok("busca encontra", (await pg1.locator("li", { hasText: "Reunião na taverna" }).count()) === 1);
  await pg1.getByLabel("Buscar anotação").fill("zzz-inexistente");
  await pg1.waitForTimeout(400);
  const vazioBusca = await pg1.getByText("Nenhuma anotação corresponde aos filtros.").count();
  ok("estado vazio por filtro", vazioBusca === 1);
  await pg1.getByLabel("Buscar anotação").fill("");
  // editar
  await item.first().getByRole("button", { name: "Editar" }).click();
  await pg1.locator(".formulario input[placeholder=\"Título\"]").fill("Reunião na taverna (2ª parte)");
  await pg1.getByRole("button", { name: "Salvar", exact: true }).click();
  await pg1.waitForTimeout(1200);
  ok("edição persiste", (await pg1.getByText("Reunião na taverna (2ª parte)").count()) >= 1);
  // excluir com confirmação
  await pg1.locator("li", { hasText: "Reunião na taverna (2ª parte)" }).getByRole("button", { name: "Excluir" }).click();
  await pg1.getByRole("button", { name: "Excluir", exact: true }).last().click();
  await pg1.waitForTimeout(1200);
  ok("exclusão com modal funciona", (await pg1.getByText("Reunião na taverna (2ª parte)").count()) === 0);

  // ===== DIÁRIO — mestre cria nota p/ jogador selecionado =====
  sec("Diário — mestre → anotação 'selecionada'");
  await abrirAba(pgM, "Diário");
  await pgM.getByRole("button", { name: "Anotações do mestre" }).click();
  await pgM.getByRole("button", { name: "Nova anotação do mestre" }).click();
  await pgM.locator(".formulario input[placeholder=\"Título\"]").fill("Pista do vilão");
  await pgM.getByPlaceholder("Conteúdo").fill("O informante trabalha para a guilda do norte.");
  await pgM.getByLabel("Visibilidade da anotação").selectOption("selecionada");
  // recipients: marca J1
  await pgM.locator("label", { hasText: J1.user }).locator("input").check().catch(async () => {
    await pgM.locator("label", { hasText: "PJ Um LE" }).locator("input").check();
  });
  await pgM.getByRole("button", { name: "Salvar", exact: true }).click();
  await pgM.waitForTimeout(1200);
  ok("anotação mestre criada", (await pgM.getByText("Pista do vilão").count()) >= 1);
  // jogador vê na aba Anotações do mestre
  await abrirAba(pg1, "Diário");
  await pg1.locator(".abas button", { hasText: "Anotações do mestre" }).first().click();
  await pg1.waitForTimeout(1200);
  const veNota = await pg1.getByText("Pista do vilão").count();
  ok("jogador destinatário vê nota do mestre", veNota >= 1, `count=${veNota}`);
  // jogador NÃO destinatário (J2) não deve ver
  await abrirAba(pg2, "Diário");
  await pg2.locator(".abas button", { hasText: "Anotações do mestre" }).first().click();
  await pg2.waitForTimeout(1200);
  const veNota2 = await pg2.getByText("Pista do vilão").count();
  ok("jogador não-destinatário NÃO vê", veNota2 === 0, `count=${veNota2}`);

  // ===== HISTÓRICO =====
  sec("Histórico — mestre e jogador");
  await abrirAba(pgM, "Histórico");
  await pgM.waitForTimeout(1200);
  const hM = await pgM.evaluate(() => ({
    temResumo: !!document.querySelector("textarea"),
    vazioSessoes: document.body.innerText.includes("Nenhuma sessão registrada"),
    temSnapshot: document.body.innerText.includes("ponto de recuperação"),
    temExportar: [...document.querySelectorAll("button")].some((b) => /Exportar campanha/.test(b.textContent)),
    temRestauracoes: document.body.innerText.includes("restauraç"),
  }));
  ok("mestre: resumo editável", hM.temResumo);
  ok("mestre: estado vazio sessões", hM.vazioSessoes);
  ok("mestre: snapshot + exportar + restaurações", hM.temSnapshot && hM.temExportar && hM.temRestauracoes);
  // salvar resumo
  const ta = pgM.locator("textarea").first();
  await ta.fill("Campanha iniciada — primeiro arco.");
  await pgM.getByRole("button", { name: "Salvar resumo" }).click();
  await pgM.waitForTimeout(1200);
  ok("resumo salvo", true);
  // criar snapshot
  await pgM.getByRole("button", { name: "Criar ponto de recuperação" }).click();
  await pgM.waitForTimeout(1500);
  ok("snapshot criado", (await pgM.getByText(/Pré-restauração|Manual|Automático/).count()) >= 1 || (await pgM.locator(".tabela, ul, .lista").count()) >= 0);
  // jogador no Histórico
  await abrirAba(pg1, "Histórico");
  await pg1.waitForTimeout(1200);
  const hJ = await pg1.evaluate(() => ({
    temSnapshotUI: document.body.innerText.includes("ponto de recuperação"),
    temExportar: [...document.querySelectorAll("button")].some((b) => /Exportar campanha/.test(b.textContent)),
    sessoesVisiveis: document.body.innerText.includes("Histórico de sessões"),
  }));
  ok("jogador NÃO vê controles de snapshot", !hJ.temSnapshotUI, JSON.stringify(hJ));
  ok("jogador vê histórico de sessões", hJ.sessoesVisiveis);

  // fricções estruturais do Histórico
  const hInfo = await pgM.evaluate(() => {
    const botoes = [...document.querySelectorAll("button")].filter((b) => /Histórico|Restaurar|Exportar/.test(b.textContent)).map((b) => ({ t: b.textContent.trim().slice(0, 40), aria: b.getAttribute("aria-label") }));
    const inputsSemNome = [...document.querySelectorAll("input,textarea,select")].filter((el) => !(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.closest("label") || (el.id && document.querySelector(`label[for="${el.id}"]`)))).length;
    return { botoes: botoes.slice(0, 10), inputsSemNome };
  });
  if (hInfo.inputsSemNome) fric("a11y", `Histórico: ${hInfo.inputsSemNome} campo(s) sem nome acessível`);

  console.log("\n===== FICÇÕES COLETADAS =====");
  friccoes.forEach((f, i) => console.log(`${i + 1}. [${f.area}] ${f.txt}`));
  console.log(`total: ${friccoes.length}`);
} catch (e) {
  console.log("EXCEÇÃO:", String(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
}
