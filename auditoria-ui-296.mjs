// FILHO — auditoria UI de ações por papel/estado (#296, ordem 7173172179).
// Verifica que a UI esconde/mostra ações conforme papel (mestre/jogador/
// espectador/pendente/bloqueado/sem-membership) e estado — SEM tratar UI
// como substituto da autorização do servidor. Produz matriz superfície ×
// papel → ações visíveis + veredito por invariante.
import { chromium } from "playwright";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import crypto from "node:crypto";
import { hashSenha } from "./servidor/dist/lib/password.js";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req, sessao, comDb, abrirDb,
} from "./teste-base.mjs";

const DIR = dirTeste("ui296");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const OUT = join(process.cwd(), "docs", "auditoria-ui-296");
mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0, rev = 0;
const t = (n, c, x = "") => { if (c === true) { pass++; console.log("  ok", n); } else if (c === "rev") { rev++; console.log("  REVIEW", n, x); } else { fail++; console.log("  FALHOU", n, x); } };
const sec = (n) => console.log("\n== " + n + " ==");
const matriz = {};

async function login(page, user, senha = "senha-jogador-123") {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irCampanha(page, nome = "Campanha Teste") {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(nome, { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(800);
}
async function aba(page, nome) {
  const b = page.locator(".abas button", { hasText: nome }).first();
  if (await b.count()) { await b.click(); await page.waitForTimeout(450); return true; }
  return false;
}

// Inventário de ações visíveis: botões + links + inputs interativos.
async function inventario(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden"
        && !el.closest("[hidden], [aria-hidden='true']");
    };
    const botoes = [...document.querySelectorAll("button, a[href], [role='button']")].filter(vis)
      .map((el) => (el.innerText || el.getAttribute("aria-label") || "").trim().split("\n")[0].slice(0, 60))
      .filter(Boolean);
    const inputs = [...document.querySelectorAll("input:not([type='hidden']), select, textarea")].filter(vis)
      .map((el) => `${el.tagName.toLowerCase()}${el.type ? ":" + el.type : ""}${el.placeholder ? "(" + el.placeholder.slice(0, 20) + ")" : ""}`);
    const abas = [...document.querySelectorAll(".abas button")].filter(vis).map((b) => b.innerText.trim());
    return { botoes: [...new Set(botoes)].sort(), inputs: [...new Set(inputs)].sort(), abas };
  });
}

async function cenarioPapel(browser, user, senha, nomeCampanha = "Campanha Teste") {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const erros = [];
  page.on("pageerror", (e) => erros.push(String(e).slice(0, 120)));
  await login(page, user, senha);
  await irCampanha(page, nomeCampanha);
  const inv = {};
  inv.campanha = await inventario(page);
  // percorrer abas visíveis
  for (const nomeAba of ["Personagens", "Diário", "Histórico", "Arquivos", "Mesa", "Fichas", "Regras", "Participantes", "Convites"]) {
    if (await aba(page, nomeAba)) {
      await page.waitForTimeout(400);
      inv[`aba:${nomeAba}`] = await inventario(page);
    }
  }
  // ficha detalhe do próprio personagem (se houver linha clicável do usuário)
  await aba(page, "Personagens");
  const linha = page.locator("tr.clicavel").first();
  if (await linha.count()) {
    await linha.click(); await page.waitForTimeout(600);
    inv["ficha detalhe"] = await inventario(page);
    // sub-abas patrimônio
    for (const sub of ["Inventário", "Dinheiro"]) {
      const b = page.getByRole("button", { name: sub, exact: true });
      if (await b.count()) { await b.first().click(); await page.waitForTimeout(350); inv[`ficha:${sub}`] = await inventario(page); }
    }
  }
  return { ctx, page, inv, erros };
}

const tem = (inv, trecho) => JSON.stringify(inv).includes(trecho);
const botoesDe = (inv, chave) => (inv[chave]?.botoes ?? []).join(" | ");

let browser, proc;
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "jogador_um", jogador2: "jogador_dois" } });
  // personagem do jogador1 (superfícies "ehEu")
  const charJogador = cenario.novoPersonagem(cenario.jogadores.jogador1.membershipId, "Aventureiro Um");

  // papéis extras via INSERT direto (mesmo padrão do criarCenario)
  const db = abrirDb(BANCO);
  const agora = Date.now();
  const mkUser = async (username, display) => {
    const uid = crypto.randomUUID();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, username, display, await hashSenha("senha-jogador-123"), agora, agora);
    return uid;
  };
  const mkMember = (uid, role, status) => {
    const mid = crypto.randomUUID();
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
      .run(mid, cenario.campId, uid, role, status, agora, agora, agora);
    return mid;
  };
  const uidEsp = await mkUser("espectador_um", "Espectador Um");
  mkMember(uidEsp, "espectador", "ativo");
  const uidPend = await mkUser("pendente_um", "Pendente Um");
  mkMember(uidPend, "jogador", "pendente");
  const uidBloq = await mkUser("bloqueado_um", "Bloqueado Um");
  mkMember(uidBloq, "jogador", "bloqueado");
  const uidSem = await mkUser("sem_campanha", "Sem Campanha");
  db.close();
  const cookies = {
    mestre: cenario.cookieMestre,
    jogador: cenario.jogadores.jogador1.cookie,
    jogador2: cenario.jogadores.jogador2.cookie,
    espectador: sessao(BANCO, uidEsp),
    pendente: sessao(BANCO, uidPend),
    bloqueado: sessao(BANCO, uidBloq),
    sem_membership: sessao(BANCO, uidSem),
  };

  browser = await chromium.launch();
  const usuarios = {
    mestre: { user: "mestre_teste", senha: "senha-forte-123" },
    jogador: { user: "jogador_um" },
    jogador2: { user: "jogador_dois" },
    espectador: { user: "espectador_um" },
    pendente: { user: "pendente_um" },
    bloqueado: { user: "bloqueado_um" },
    sem_membership: { user: "sem_campanha" },
  };

  for (const [papel, u] of Object.entries(usuarios)) {
    sec(`Papel: ${papel}`);
    const { ctx, inv, erros } = await cenarioPapel(browser, u.user, u.senha);
    matriz[papel] = inv;
    // ---- invariantes por papel/estado ----
    // Contrato servidor: GET detalhe permite todo membro não-removido/não-
    // bloqueado (pendente pré-visualiza); requirePapel exige status=ativo.
    // bloqueado/sem-membership → 403 → UI não deve renderizar abas.
    const SEM_ACESSO = ["bloqueado", "sem_membership"];
    const abas = inv.campanha?.abas ?? [];
    const temAba = (n) => abas.some((a) => a.includes(n));
    if (SEM_ACESSO.includes(papel)) {
      t("SEM abas de campanha (acesso negado na UI)", abas.length === 0, JSON.stringify(abas));
    } else {
      t("abas base presentes", ["Informações", "Mesa", "Diário", "Histórico", "Arquivos"].every(temAba), JSON.stringify(abas));
      if (papel === "mestre") {
        t("abas admin presentes (Fichas/Regras/Participantes/Convites)", ["Fichas", "Regras", "Participantes", "Convites"].every(temAba), JSON.stringify(abas));
      } else {
        t("abas admin AUSENTES", !["Fichas", "Regras", "Participantes", "Convites"].some(temAba), JSON.stringify(abas));
      }
      if (papel === "espectador") {
        t("Personagens oculto p/ espectador", !temAba("Personagens"), JSON.stringify(abas));
      } else {
        t("aba Personagens presente", temAba("Personagens"), JSON.stringify(abas));
      }
    }
    // ações proibidas não devem aparecer em nenhuma tela do papel
    const PROIBIDAS = {
      mestre: [],
      jogador: ["Criar convite", "Editar campanha", "Aprovar", "Rejeitar", "Excluir conta", "Novo modelo", "Publicar"],
      jogador2: ["Criar convite", "Editar campanha", "Aprovar", "Rejeitar", "Excluir conta", "Novo modelo", "Publicar"],
      espectador: ["Criar convite", "Editar campanha", "Aprovar", "Rejeitar", "Novo modelo", "Publicar", "Enviar arquivo", "Nova pasta", "Clicar", "Nova sessão", "Rolar dados"],
      pendente: ["Criar convite", "Editar campanha", "Aprovar"],
      bloqueado: ["Criar convite", "Editar campanha", "Aprovar"],
      sem_membership: ["Criar convite", "Editar campanha", "Aprovar"],
    };
    for (const [chave, inv2] of Object.entries(inv)) {
      for (const p of PROIBIDAS[papel] ?? []) {
        if (botoesDe(inv2, chave).includes(p)) t(`${papel} @ ${chave}: ação proibida "${p}" visível`, false, botoesDe(inv2, chave).slice(0, 200));
      }
    }
    // Estado pendente: servidor exige status=ativo (requirePapel) — a UI
    // não deve oferecer ações de escrita a quem aguarda aprovação.
    if (papel === "pendente") {
      const btns = Object.values(inv).flatMap((v) => v?.botoes ?? []);
      const escreve = btns.filter((b) => /Enviar arquivo|Nova pasta|Nova sessão|Rolar|Anotar/.test(b));
      t("pendente: ações de escrita ocultas (meuStatus=pendente)", escreve.length === 0, escreve.join(" | "));
    }
    t(`${papel}: sem pageerror`, erros.length === 0, erros.slice(0, 2).join(" | "));
    // resumo das telas visitadas
    console.log(`   telas: ${Object.keys(inv).join(", ")}`);
    for (const [k, v] of Object.entries(inv)) {
      if (v.botoes?.length) console.log(`     ${k}: ${v.botoes.slice(0, 10).join(" · ")}${v.botoes.length > 10 ? ` …+${v.botoes.length - 10}` : ""}`);
    }
    await ctx.close();
  }

  writeFileSync(join(OUT, "matriz-acoes.json"), JSON.stringify({ gerado: new Date().toISOString(), sha: "0ee6c8b", matriz }, null, 2));
  console.log(`\n${pass} ok / ${fail} falhas / ${rev} review`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc).catch(() => {});
  limparDir(DIR);
}
process.exit(fail ? 1 : 0);
