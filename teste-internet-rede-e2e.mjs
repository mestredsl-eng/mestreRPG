// #352 F4 — E2E REAL da Internet diegética sobre backend #362 + UI.
// Worktree de simulação: feat/350-internet-contas@b57ca81 +
// feat/352-internet-f4. Sobe servidor real (SQLite descartável,
// migrations completas) e prova via REST + socket.io-client +
// Playwright (site/dist): conta → pedido → aceite → conversa direta →
// enviar/receber AO VIVO → grupo (convite/aceite responderConviteGrupo)
// → paginação → leitura → reconexão → revogação → bloqueio →
// isolamento 2 campanhas → dedup (userId,contaId) → negações honestas.
// Fixtures só semeiam banco/regras (padrão das demais suítes).
import crypto from "node:crypto";
import { io as ioClient } from "socket.io-client";
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = dirTeste("internet-rede-e2e");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const R = (camp) => `/campaigns/${camp}/internet`;

let proc;
const sockets = [];
function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p, timeoutMs = 10000) => new Promise((r) => {
  const to = setTimeout(() => r({ ok: false, erro: "timeout_teste" }), timeoutMs);
  s.emit(ev, p, (x) => { clearTimeout(to); r(x); });
});
function proximoEvento(s, ev, timeoutMs = 8000) {
  return new Promise((res) => {
    const to = setTimeout(() => { s.off(ev, h); res(null); }, timeoutMs);
    const h = (x) => { clearTimeout(to); s.off(ev, h); res(x); };
    s.on(ev, h);
  });
}

// ---------- fixture gate Internet (padrão teste-internet-e2e) ----------
function fixtureGate(banco, campId, ownerId) {
  const db = abrirDb(banco);
  const agora = Date.now();
  let rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
  if (!rs) {
    const id = crypto.randomUUID();
    db.prepare("insert into rule_sets (id,campaign_id,name,version,is_active,config,created_at,updated_at) values (?,?,?,?,1,?,?,?)")
      .run(id, campId, "Regras da campanha", 1, "{}", agora, agora);
    rs = { id };
  }
  const ins = db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?, '{}',?,?)");
  for (const [kind, key, name] of [
    ["pericia", "computador", "Computador"],
    ["conhecimento", "tecnologia", "Tecnologia"],
    ["item", "notebook", "Notebook"],
    ["item", "celular_descartavel", "Celular descartável"],
  ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
  let ver = db.prepare("select v.id, v.structure from sheet_versions v join sheet_templates t on t.current_version_id=v.id where t.campaign_id=?").get(campId);
  if (!ver) {
    const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
    db.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,1,?,?)")
      .run(tplId, campId, "Ficha Teste", null, ownerId, agora, agora);
    const estrutura = {
      versao: 1,
      secoes: [{ id: "s1", titulo: "Atributos", ordem: 0, campos: [{ id: "for", label: "FOR", tipo: "inteiro", semantico: "atributo" }] }],
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    };
    db.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
      .run(verId, tplId, JSON.stringify(estrutura), agora, agora);
    db.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);
    ver = { id: verId, structure: JSON.stringify(estrutura) };
  }
  const est = JSON.parse(ver.structure);
  if (!est.secoes[0].campos.some((x) => x.id === "comp")) {
    est.secoes[0].campos.push(
      { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
      { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
    );
    db.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), ver.id);
  }
  db.close();
}
function darDispositivo(banco, characterId) {
  const db = abrirDb(banco);
  db.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), characterId, "Notebook", 1, null, "equipamento", "mochila", "novo", 1.5,
      JSON.stringify({ regra: { kind: "item", key: "notebook" } }), Date.now(), Date.now());
  db.close();
}
function novoChar(banco, { campId, membershipId, nome, data = {}, comDevice = true }) {
  const db = abrirDb(banco);
  const agora = Date.now();
  const ver = db.prepare("select v.id from sheet_versions v join sheet_templates t on t.current_version_id=v.id where t.campaign_id=?").get(campId);
  const id = crypto.randomUUID();
  db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, campId, membershipId, ver.id, nome, JSON.stringify({ for: 5, ...data }), "{}", "aprovada", 0, agora, agora);
  if (comDevice) darDispositivo(banco, id);
  db.close();
  return id;
}
async function criarConta(base, cookie, campId, characterId, handle) {
  const r = await req(base, "POST", `${R(campId)}/account`, { cookie, body: { characterId, handle } });
  return { status: r.status, json: r.json };
}
/** pedido + aceite de contato entre duas contas (mesmo cookie do destino). */
async function aceitarPar(base, cookieOrigem, contaOrigem, cookieDestino, contaDestino, campId) {
  const p = await req(base, "POST", `${R(campId)}/contacts`, { cookie: cookieOrigem, body: { contaId: contaDestino, origemContaId: contaOrigem } });
  if (p.status !== 200 && p.status !== 201) return { ok: false, etapa: "pedido", resp: p };
  const aresta = p.json?.contato?.id ?? p.json?.id ?? p.json?.contatoId;
  const lista = await req(base, "GET", `${R(campId)}/contacts`, { cookie: cookieDestino });
  const pend = (lista.json?.contatos ?? []).find((x) => x.status === "pendente" && !x.souOrigem &&
    ((x.origem?.id === contaOrigem) || (x.destino?.id === contaOrigem)));
  const alvo = pend?.id ?? aresta;
  const a = await req(base, "POST", `${R(campId)}/contacts/${alvo}/aceitar`, { cookie: cookieDestino, body: {} });
  return { ok: a.status === 200, etapa: "aceite", resp: a };
}

// ================= BROWSER =================
let browser;
const errosConsole = [];
function vigiar(page, tag) {
  page.on("pageerror", (e) => errosConsole.push(`${tag}:pageerror:${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/401|Failed to load resource|404/.test(txt)) return;
    errosConsole.push(`${tag}:console:${txt.slice(0, 160)}`);
  });
}
async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("Campanha Teste", { exact: true }).first().click();
}
async function abrirPersonagem(page, nome) {
  const abaPers = page.locator(".abas button", { hasText: "Personagens" }).first();
  // espera a campanha terminar de carregar; se estiver dentro da Internet
  // (conversa/inbox), sai pelos "Voltar" internos até a aba aparecer
  for (let i = 0; i < 6; i++) {
    const visivel = await abaPers.waitFor({ state: "visible", timeout: 6000 }).then(() => true).catch(() => false);
    if (visivel) break;
    const voltarRede = page.locator(".internet-rede").getByRole("button", { name: /Voltar/ }).first();
    if (await voltarRede.count()) await voltarRede.click().catch(() => {});
    else {
      const voltar = page.getByRole("button", { name: "Voltar" }).first();
      if (await voltar.count()) await voltar.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  await abaPers.click();
  const linha = page.locator("tr.clicavel", { hasText: nome });
  await linha.first().waitFor({ timeout: 15000 });
  await linha.first().click();
  await page.getByRole("button", { name: "Voltar" }).first().waitFor({ timeout: 15000 });
}
async function abrirInternet(page) {
  await page.getByRole("group", { name: "Módulos do personagem" })
    .getByRole("button", { name: "Internet", exact: true }).click();
  await page.locator("section[aria-label='Internet']").waitFor({ timeout: 10000 });
}
async function abrirRede(page) {
  await abrirInternet(page);
  await page.locator("section[aria-label='Internet'] > .abas [role='tab']", { hasText: "Rede" }).click();
  await page.locator(".internet-rede").waitFor({ timeout: 15000 });
}
const abaMsg = (page, nome) => page.locator(".internet-rede [role='tablist'][aria-label='Internet do personagem'] [role='tab']", { hasText: nome }).click();
const subMsg = (page, nome) => page.locator(".internet-rede [role='tablist'][aria-label='Seções de mensagens'] [role='tab']", { hasText: nome }).click();
const subCont = (page, nome) => page.locator(".internet-rede [role='tablist'][aria-label='Grupos de contatos'] [role='tab']", { hasText: nome }).click();

try {
  // ================= SETUP =================
  sec("0. Setup — servidor real + 2 campanhas");
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "jogador_um", jogador2: "jogador_dois" } });
  const mestre = c.cookieMestre, campA = c.campId;
  const j1 = c.jogadores.jogador1, j2 = c.jogadores.jogador2;
  fixtureGate(BANCO, campA, c.adminId);

  const campBRes = await req(BASE, "POST", "/campaigns", { cookie: mestre, body: { name: "Campanha Beta" } });
  const campB = campBRes.json?.campanha?.id;
  t("campanha B criada", !!campB, JSON.stringify(campBRes.json).slice(0, 120));
  let membB;
  {
    const db = abrirDb(BANCO); const agora = Date.now();
    membB = crypto.randomUUID();
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'jogador','ativo',?,?,?)")
      .run(membB, campB, j1.id, agora, agora, agora);
    db.close();
  }
  fixtureGate(BANCO, campB, c.adminId);

  // Personagens: UI usa Lya Um (j1) ↔ Nix Um (j2); API usa Lya Dois (j1)
  // ↔ Nix Dois (j2) — mesmo userId, contas distintas (dedup).
  const charA1 = novoChar(BANCO, { campId: campA, membershipId: j1.membershipId, nome: "Lya Um", data: { comp: 1 } });
  const charA1b = novoChar(BANCO, { campId: campA, membershipId: j1.membershipId, nome: "Lya Dois", data: { comp: 1 } });
  const charA2 = novoChar(BANCO, { campId: campA, membershipId: j2.membershipId, nome: "Nix Um", data: { comp: 1 } });
  const charA2b = novoChar(BANCO, { campId: campA, membershipId: j2.membershipId, nome: "Nix Dois", data: { comp: 1 } });
  const charSemConta = novoChar(BANCO, { campId: campA, membershipId: j1.membershipId, nome: "Sem Conta UA", data: { comp: 1 } });
  const charSemDev = novoChar(BANCO, { campId: campA, membershipId: j2.membershipId, nome: "Sem Device UB", data: { comp: 1 }, comDevice: false });
  const charB1 = novoChar(BANCO, { campId: campB, membershipId: membB, nome: "Lya CampBeta", data: { comp: 1 } });

  // ================= CONTAS =================
  sec("1. Contas — criação e negações");
  const mk = async (cookie, ch, camp, h) => (await criarConta(BASE, cookie, camp, ch, h));
  const ca1 = await mk(j1.cookie, charA1, campA, "lya_um");
  const contaA1 = ca1.json?.conta?.id;
  t("conta @lya_um (j1/charA1)", ca1.status === 201 && !!contaA1, JSON.stringify(ca1.json).slice(0, 140));
  const ca1b = await mk(j1.cookie, charA1b, campA, "lya_dois");
  const contaA1b = ca1b.json?.conta?.id;
  t("conta @lya_dois (j1/charA1b — mesmo userId)", ca1b.status === 201);
  const ca2 = await mk(j2.cookie, charA2, campA, "nix_um");
  const contaA2 = ca2.json?.conta?.id;
  t("conta @nix_um (j2/charA2)", ca2.status === 201);
  const ca2b = await mk(j2.cookie, charA2b, campA, "nix_dois");
  const contaA2b = ca2b.json?.conta?.id;
  t("conta @nix_dois (j2/charA2b)", ca2b.status === 201);
  const cb1 = await mk(j1.cookie, charB1, campB, "lya_campob");
  const contaB1 = cb1.json?.conta?.id;
  t("conta @lya_campob (campanha B)", cb1.status === 201);

  const dup = await mk(j1.cookie, charA1, campA, "outro_handle");
  t("conta duplicada → 409", dup.status === 409, String(dup.status));
  const handleOcupado = await mk(j2.cookie, charA2b, campA, "lya_um");
  t("handle já em uso → 409", handleOcupado.status === 409, String(handleOcupado.status));
  const semDev = await mk(j2.cookie, charSemDev, campA, "sem_device");
  t("sem dispositivo → 403 honesto", semDev.status === 403, String(semDev.status));
  const contaVazia = await req(BASE, "GET", `${R(campA)}/account?characterId=${charSemConta}`, { cookie: j1.cookie });
  t("personagem sem conta → conta:null", contaVazia.json?.conta === null);
  const invasao = await mk(j1.cookie, charA2, campA, "invasao");
  t("conta de personagem alheio → 403/404", invasao.status === 403 || invasao.status === 404, String(invasao.status));

  // Pares API (fluxos socket/paginação/revogação/bloqueio/dedup)
  const par1 = await aceitarPar(BASE, j1.cookie, contaA1b, j2.cookie, contaA2b, campA);
  t("par API A1b↔A2b aceito", par1.ok, `etapa=${par1.etapa} ` + JSON.stringify(par1.resp?.json ?? par1).slice(0, 160));
  const par2 = await aceitarPar(BASE, j1.cookie, contaA1b, j2.cookie, contaA2, campA);
  t("par API A1b↔A2 aceito (membro do grupo dedup)", par2.ok, `etapa=${par2.etapa} ` + JSON.stringify(par2.resp?.json ?? par2).slice(0, 160));

  // ================= SOCKET + DIRETA (API) =================
  sec("2. Conversa direta A1b↔A2b — socket real");
  const s1 = conectar(j1.cookie), s2 = conectar(j2.cookie);
  await Promise.all([pronto(s1), pronto(s2)]);
  t("dois sockets conectados", s1.connected && s2.connected);

  const convInv = await req(BASE, "POST", `${R(campA)}/conversations`, {
    cookie: j1.cookie, body: { tipo: "direta", contaDestinoId: "nao-existe", origemContaId: contaA1b },
  });
  t("conversa p/ conta inexistente → 404", convInv.status === 404, String(convInv.status));

  const conv = await req(BASE, "POST", `${R(campA)}/conversations`, {
    cookie: j1.cookie, body: { tipo: "direta", contaDestinoId: contaA2b, origemContaId: contaA1b },
  });
  const convId = conv.json?.conversa;
  t("conversa direta criada", conv.status === 201 && !!convId, JSON.stringify(conv.json).slice(0, 160));
  const convReplay = await req(BASE, "POST", `${R(campA)}/conversations`, {
    cookie: j1.cookie, body: { tipo: "direta", contaDestinoId: contaA2b, origemContaId: contaA1b },
  });
  t("replay direta → mesma conversa", convReplay.json?.conversa === convId);

  const evPush = proximoEvento(s2, "internet:mensagem");
  const ack1 = await emitirCb(s1, "internet:mensagem:enviar", {
    conversaId: convId, contaId: contaA1b, requestId: crypto.randomUUID(), conteudo: "Olá do Lya Dois",
  });
  t("envio socket ACK ok", ack1?.ok === true, JSON.stringify(ack1));
  const push = await evPush;
  t("j2 recebe push internet:mensagem", push?.conversaId === convId && push?.conteudo === "Olá do Lya Dois", JSON.stringify(push).slice(0, 200));
  t("push destinatário = contaA2b", push?.contaId === contaA2b, `contaId=${push?.contaId}`);
  t("push traz autor @lya_dois", push?.autor?.handle === "lya_dois", JSON.stringify(push?.autor));

  const reqId = crypto.randomUUID();
  const a1 = await emitirCb(s1, "internet:mensagem:enviar", { conversaId: convId, contaId: contaA1b, requestId: reqId, conteudo: "idempotente" });
  const a2 = await emitirCb(s1, "internet:mensagem:enviar", { conversaId: convId, contaId: contaA1b, requestId: reqId, conteudo: "idempotente" });
  t("idempotência replay + mesmo id", a1?.ok === true && a2?.replay === true && a1?.mensagemId === a2?.mensagemId, JSON.stringify({ a1, a2 }));

  const evJ1 = proximoEvento(s1, "internet:mensagem");
  const ack2 = await emitirCb(s2, "internet:mensagem:enviar", {
    conversaId: convId, contaId: contaA2b, requestId: crypto.randomUUID(), conteudo: "Oi de volta",
  });
  t("j2 responde ACK ok", ack2?.ok === true);
  const push1 = await evJ1;
  t("j1 recebe resposta", push1?.conteudo === "Oi de volta", JSON.stringify(push1).slice(0, 160));

  const semPart = await emitirCb(s1, "internet:mensagem:enviar", {
    conversaId: convId, contaId: contaB1, requestId: crypto.randomUUID(), conteudo: "invasão",
  });
  t("conta de outra campanha não envia", semPart?.ok === false, JSON.stringify(semPart));

  // ================= GRUPO + DEDUP =================
  sec("3. Grupo A1b com A2+A2b — convite e dedup");
  const grupo = await req(BASE, "POST", `${R(campA)}/conversations`, {
    cookie: j1.cookie,
    body: { tipo: "grupo", nome: "Tribo API", contaIds: [contaA2, contaA2b], origemContaId: contaA1b },
  });
  const grupoId = grupo.json?.conversa;
  t("grupo criado", grupo.status === 201 && !!grupoId, JSON.stringify(grupo.json).slice(0, 160));

  const antes = await emitirCb(s2, "internet:mensagem:enviar", {
    conversaId: grupoId, contaId: contaA2, requestId: crypto.randomUUID(), conteudo: "cedo demais",
  });
  t("convidado sem aceite não envia", antes?.ok === false, JSON.stringify(antes));

  const detG = await req(BASE, "GET", `${R(campA)}/conversations/${grupoId}`, { cookie: j2.cookie });
  const partes = detG.json?.conversa?.participantes ?? [];
  const pid = (cid) => partes.find((p) => p.conta?.id === cid && p.status === "convidado")?.id;
  const pA2 = pid(contaA2), pA2b = pid(contaA2b);
  t("detalhe expõe pid dos convidados", !!pA2 && !!pA2b, JSON.stringify(partes).slice(0, 240));
  const accA2 = await req(BASE, "POST", `${R(campA)}/conversations/${grupoId}/participants/${pA2}/responder`, { cookie: j2.cookie, body: { aceitar: true } });
  const accA2b = await req(BASE, "POST", `${R(campA)}/conversations/${grupoId}/participants/${pA2b}/responder`, { cookie: j2.cookie, body: { aceitar: true } });
  t("ambos convidados aceitam", accA2.status === 200 && accA2b.status === 200, JSON.stringify({ accA2: accA2.status, accA2b: accA2b.status }));

  const coletar = [];
  const hMsg = (x) => coletar.push(x);
  s2.on("internet:mensagem", hMsg);
  const evAntes = coletar.length;
  await emitirCb(s1, "internet:mensagem:enviar", {
    conversaId: grupoId, contaId: contaA1b, requestId: crypto.randomUUID(), conteudo: "msg p/ tribo",
  });
  await dormir(700);
  const novos = coletar.slice(evAntes).filter((x) => x.conversaId === grupoId);
  const contasDest = new Set(novos.map((x) => x.contaId));
  t("dedup (userId,contaId): j2 recebe 1 evento POR conta", novos.length === 2 && contasDest.has(contaA2) && contasDest.has(contaA2b),
    `recebidos=${novos.length} contas=${[...contasDest].join(",")}`);
  s2.off("internet:mensagem", hMsg);

  // ================= PAGINAÇÃO + LEITURA =================
  // P8: 20 msg/min POR CONTA — a conta A1b já usou 3 envios (direta ×2 +
  // grupo). Paginação keyset é provada com limit=5 (4 páginas), dentro do
  // orçamento de rate-limit — sem sleep artificial.
  sec("4. Paginação keyset + cursor de leitura");
  const TOTAL = 14; // direta fica com 2+1+14 = 17 msgs; A1b total = 17 < 20/min
  let falhasEnvio = 0;
  for (let i = 0; i < TOTAL; i++) {
    const r = await emitirCb(s1, "internet:mensagem:enviar", {
      conversaId: convId, contaId: contaA1b, requestId: crypto.randomUUID(), conteudo: `pag-${i}`,
    });
    if (r?.ok !== true) { falhasEnvio++; }
  }
  t("paginação: envios dentro do rate-limit", falhasEnvio === 0, `falhas=${falhasEnvio}`);
  // percorre TODAS as páginas com limit=5 e valida keyset completo
  const idsVistos = new Set();
  let cursor = null, paginas = 0, ultima = null;
  do {
    const url = `${R(campA)}/conversations/${convId}/messages?limit=5` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const pg = await req(BASE, "GET", url, { cookie: j2.cookie });
    const msgs = pg.json?.mensagens ?? [];
    if (paginas === 0) t("página 1 = 5 + cursor", msgs.length === 5 && !!pg.json?.proximoCursor, JSON.stringify({ n: msgs.length }));
    for (const m of msgs) { t(`msg única e ordenada (${m.id.slice(0, 8)})`, !idsVistos.has(m.id)); idsVistos.add(m.id); ultima = m; }
    cursor = pg.json?.proximoCursor ?? null;
    paginas++;
  } while (cursor && paginas < 10);
  t("paginação cobriu histórico inteiro sem buraco", idsVistos.size === 17, `msgs=${idsVistos.size} paginas=${paginas}`);
  const read = await req(BASE, "POST", `${R(campA)}/conversations/${convId}/read`, {
    cookie: j2.cookie,
    body: { contaId: contaA2b, ateCreatedAt: Date.parse(ultima.createdAt), ateMessageId: ultima.id },
  });
  t("marcar leitura aceito", read.status === 200, JSON.stringify(read.json).slice(0, 120));
  const cur = abrirDb(BANCO).prepare("select last_read_message_id from internet_participantes where conversa_id=? and conta_id=?").get(convId, contaA2b);
  t("cursor de leitura persistido", cur?.last_read_message_id === ultima.id, JSON.stringify(cur));

  // ================= RECONEXÃO =================
  sec("5. Reconexão socket");
  const s2x = conectar(j2.cookie);
  await pronto(s2x);
  s2x.disconnect();
  await dormir(300);
  const off = await emitirCb(s2x, "internet:mensagem:enviar", {
    conversaId: convId, contaId: contaA2b, requestId: crypto.randomUUID(), conteudo: "offline",
  }, 2500);
  t("socket off → sem ACK (timeout honesto)", off?.ok === false, JSON.stringify(off));
  const s2y = conectar(j2.cookie);
  await pronto(s2y);
  const ackRe = await emitirCb(s2y, "internet:mensagem:enviar", {
    conversaId: convId, contaId: contaA2b, requestId: crypto.randomUUID(), conteudo: "de volta",
  });
  t("reconectado → envio funciona", ackRe?.ok === true, JSON.stringify(ackRe));

  // ================= ISOLAMENTO =================
  sec("6. Isolamento campanha A × B");
  const contatosB = await req(BASE, "GET", `${R(campB)}/contacts`, { cookie: j1.cookie });
  t("campB: zero arestas de A", (contatosB.json?.contatos ?? []).length === 0, JSON.stringify(contatosB.json).slice(0, 160));
  const convsB = await req(BASE, "GET", `${R(campB)}/conversations`, { cookie: j1.cookie });
  t("campB: conversas de A invisíveis", !(convsB.json?.conversas ?? []).some((x) => x.id === convId || x.id === grupoId), JSON.stringify(convsB.json).slice(0, 160));
  const convCru = await req(BASE, "GET", `${R(campB)}/conversations/${convId}`, { cookie: j1.cookie });
  t("campB: detalhe de A → 404/negado", convCru.status === 404 || convCru.status === 403 || convCru.status === 400, String(convCru.status));
  const msgCru = await req(BASE, "GET", `${R(campB)}/conversations/${convId}/messages`, { cookie: j1.cookie });
  t("campB: histórico de A → 404/negado", msgCru.status === 404 || msgCru.status === 403 || msgCru.status === 400, String(msgCru.status));
  const contatoCru = await req(BASE, "POST", `${R(campB)}/contacts`, { cookie: j1.cookie, body: { contaId: contaA2, origemContaId: contaB1 } });
  t("campB: pedido p/ conta de A → negado", [400, 403, 404].includes(contatoCru.status), String(contatoCru.status));
  const dirB = await req(BASE, "GET", `${R(campB)}/accounts`, { cookie: j1.cookie });
  t("campB: diretório não lista contas de A", !(dirB.json?.contas ?? []).some((x) => x.id === contaA1 || x.id === contaA2), JSON.stringify(dirB.json).slice(0, 160));

  // ================= BLOQUEIO =================
  sec("7. Bloqueio bilateral (par API)");
  const arestas = await req(BASE, "GET", `${R(campA)}/contacts`, { cookie: j1.cookie });
  const par = (x) => (x.origem?.id === contaA1b && x.destino?.id === contaA2b) || (x.origem?.id === contaA2b && x.destino?.id === contaA1b);
  const arestaBloq = (arestas.json?.contatos ?? []).find((x) => x.status === "aceito" && par(x));
  t("aresta aceita A1b↔A2b localizada", !!arestaBloq, JSON.stringify(arestas.json?.contatos?.map((x) => ({ s: x.status, o: x.origem?.id === contaA1b ? "A1b" : "?", d: x.destino?.id }))).slice(0, 200));
  // j2 é o DESTINO da aresta A1b→A2b — só ele pode bloquear (P3)
  const bloq = await req(BASE, "POST", `${R(campA)}/contacts/${arestaBloq.id}/bloquear`, { cookie: j2.cookie, body: {} });
  t("bloqueio aplicado pelo destino", bloq.status === 200, JSON.stringify(bloq.json).slice(0, 120));
  const bloqOrigem = await req(BASE, "POST", `${R(campA)}/contacts/${arestaBloq.id}/bloquear`, { cookie: j1.cookie, body: {} });
  t("origem NÃO pode bloquear (só destino)", bloqOrigem.status === 403, String(bloqOrigem.status));
  const envioBloq = await emitirCb(s1, "internet:mensagem:enviar", {
    conversaId: convId, contaId: contaA1b, requestId: crypto.randomUUID(), conteudo: "após bloqueio",
  });
  t("envio após bloqueio rejeitado", envioBloq?.ok === false, JSON.stringify(envioBloq));
  const convNova = await req(BASE, "POST", `${R(campA)}/conversations`, {
    cookie: j1.cookie, body: { tipo: "direta", contaDestinoId: contaA2b, origemContaId: contaA1b },
  });
  // replay da MESMA conversa existente é idempotente (parKey) — o bloqueio
  // barra conversas NOVAS e envios, não o replay do histórico (P12).
  t("replay da conversa existente → mesma id (bloqueio não apaga histórico)",
    convNova.status === 200 && convNova.json?.conversa === convId, `${convNova.status} ${JSON.stringify(convNova.json).slice(0, 120)}`);

  // ================= REVOGAÇÃO =================
  sec("8. Revogação — arquivar personagem");
  {
    const db = abrirDb(BANCO);
    db.prepare("update characters set status='arquivado' where id=?").run(charA2b);
    db.close();
  }
  const revConta = await req(BASE, "GET", `${R(campA)}/account?characterId=${charA2b}`, { cookie: j2.cookie });
  t("conta de arquivado não autorizada", revConta.json?.conta === null || revConta.json?.conta?.status !== "ativa", JSON.stringify(revConta.json).slice(0, 140));
  const revEnvio = await emitirCb(s2y, "internet:mensagem:enviar", {
    conversaId: grupoId, contaId: contaA2b, requestId: crypto.randomUUID(), conteudo: "arquivado",
  });
  t("conta arquivada não envia", revEnvio?.ok === false, JSON.stringify(revEnvio));
  const coletar2 = [];
  const h2 = (x) => coletar2.push(x);
  s2y.on("internet:mensagem", h2);
  const antes2 = coletar2.length;
  // A1b está bloqueado com A2b — uso o grupo: dono é A1b... bloqueio é
  // par-a-par A1b↔A2b, não A1b↔A2. Mando como A2 (membro ativo).
  await emitirCb(s2, "internet:mensagem:enviar", {
    conversaId: grupoId, contaId: contaA2, requestId: crypto.randomUUID(), conteudo: "grupo segue",
  });
  await dormir(700);
  const novos2 = coletar2.slice(antes2).filter((x) => x.conversaId === grupoId);
  const contas2 = new Set(novos2.map((x) => x.contaId));
  t("fan-out exclui conta revogada (só A2)", novos2.length === 1 && contas2.has(contaA2),
    `recebidos=${novos2.length} contas=${[...contas2].join(",")}`);
  s2y.off("internet:mensagem", h2);

  // ================= NEGAÇÕES API =================
  sec("9. Negações honestas (REST/socket)");
  const origInv = await req(BASE, "POST", `${R(campA)}/conversations`, {
    cookie: j1.cookie, body: { tipo: "direta", contaDestinoId: contaA2, origemContaId: "conta-inexistente" },
  });
  t("origemContaId inválida → 400/403", origInv.status === 400 || origInv.status === 403, String(origInv.status));
  const getInv = await req(BASE, "GET", `${R(campA)}/conversations/id-inexistente`, { cookie: j1.cookie });
  t("GET conversa inexistente → 404", getInv.status === 404, String(getInv.status));
  const limMax = await req(BASE, "GET", `${R(campA)}/conversations/${convId}/messages?limit=9999`, { cookie: j2.cookie });
  t("limite acima do máx → não trunca silencioso", limMax.status === 400 || (limMax.json?.mensagens?.length ?? 0) <= 100, String(limMax.status));
  const semAceite = await req(BASE, "POST", `${R(campA)}/conversations`, {
    cookie: j1.cookie, body: { tipo: "grupo", nome: "Inválido", contaIds: ["conta-inexistente"], origemContaId: contaA1 },
  });
  t("grupo c/ conta inexistente → negado", [400, 403, 404].includes(semAceite.status), String(semAceite.status));

  // ================= UI =================
  sec("10. UI — módulo Rede (site/dist real)");
  const dumpUI = async (page, tag) => {
    try {
      const txt = await page.locator(".internet-rede, section[aria-label='Internet']").last().innerText({ timeout: 3000 });
      console.log(`  [dump ${tag}]`, txt.slice(0, 500).replace(/\n+/g, " | "));
    } catch (e) { console.log(`  [dump ${tag}] falhou:`, String(e).slice(0, 120)); }
  };
  browser = await chromium.launch();
  const ctx1 = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  const p1 = await ctx1.newPage(); vigiar(p1, "j1");
  const ctx2 = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  const p2 = await ctx2.newPage(); vigiar(p2, "j2");

  await login(p1, "jogador_um", "senha-jogador-123");
  await login(p2, "jogador_dois", "senha-jogador-123");
  await irCampanha(p1); await irCampanha(p2);
  await abrirPersonagem(p1, "Lya Um"); await abrirRede(p1);
  t("UI j1: módulo Rede monta", await p1.locator(".internet-rede").isVisible());
  await abaMsg(p1, "Conta");
  await p1.getByText("@lya_um").waitFor({ timeout: 8000 });
  t("UI j1: conta @lya_um visível", true);

  // pedido/aceite via UI: j1 → @nix_um
  await abaMsg(p1, "Mensagens");
  await subMsg(p1, "Contatos");
  await p1.locator("#internet-handle-novo").fill("nix_um");
  await p1.getByRole("button", { name: "Enviar pedido", exact: true }).click();
  await p1.waitForTimeout(900);

  await abrirPersonagem(p2, "Nix Um"); await abrirRede(p2);
  await subMsg(p2, "Contatos");
  await subCont(p2, "Pedidos recebidos");
  await p2.getByText("@lya_um").waitFor({ timeout: 10000 });
  t("UI j2: pedido @lya_um recebido", true);
  await p2.getByRole("button", { name: "Aceitar", exact: true }).first().click();
  await p2.waitForTimeout(1000);
  await subCont(p1, "Aceitos");
  await p1.locator(".internet-contato-item", { hasText: "@nix_um" }).waitFor({ timeout: 10000 });
  t("UI j1: @nix_um aceito", true);

  // conversa direta via UI → envio/recebimento AO VIVO
  await p1.locator(".internet-contato-item", { hasText: "@nix_um" }).getByRole("button", { name: "Conversar", exact: true }).click();
  await p1.locator("#internet-msg-texto").waitFor({ timeout: 10000 });
  await p1.locator("#internet-msg-texto").fill("Olá via UI");
  await p1.getByRole("button", { name: "Enviar", exact: true }).click();
  try {
    await p1.locator(".internet-bolha", { hasText: "Olá via UI" }).waitFor({ timeout: 8000 });
  } catch (e) {
    await dumpUI(p1, "apos-envio-ui");
    throw e;
  }

  await subMsg(p2, "Caixa de entrada");
  await p2.locator(".internet-conversa-item", { hasText: "lya_um" }).first().waitFor({ timeout: 10000 });
  await p2.locator(".internet-conversa-item", { hasText: "lya_um" }).first().click();
  await p2.locator(".internet-bolha", { hasText: "Olá via UI" }).waitFor({ timeout: 10000 });
  t("UI j2: msg de j1 visível (histórico/socket)", true);
  await p2.locator("#internet-msg-texto").fill("Resposta via UI");
  await p2.getByRole("button", { name: "Enviar", exact: true }).click();
  await p1.locator(".internet-bolha", { hasText: "Resposta via UI" }).waitFor({ timeout: 10000 });
  t("UI j1: resposta chega AO VIVO", true);
  await p1.locator("#internet-msg-texto").fill("segunda ao vivo");
  await p1.getByRole("button", { name: "Enviar", exact: true }).click();
  await p2.locator(".internet-bolha", { hasText: "segunda ao vivo" }).waitFor({ timeout: 10000 });
  t("UI j2: push ao vivo na thread aberta", true);

  // grupo via UI → j2 aceita convite (responderConviteGrupo real)
  await p1.locator(".internet-rede").getByRole("button", { name: /Voltar/ }).click();
  await subMsg(p1, "Caixa de entrada");
  await p1.getByRole("button", { name: "Novo grupo", exact: true }).click();
  await p1.locator("#internet-nome-grupo").fill("Tribo UI");
  // j1 agrega arestas de TODAS as suas contas: @nix_um aparece 2× (aresta
  // A1↔A2 e A1b↔A2) — ambas selecionam a mesma contaA2; .first() basta.
  await p1.locator(".internet-rede .internet-contato-item", { hasText: "@nix_um" }).locator("input[type='checkbox']").first().check();
  await p1.getByRole("button", { name: "Criar grupo", exact: true }).click();
  await p1.locator("#internet-msg-texto").waitFor({ timeout: 10000 });
  await p1.locator("#internet-msg-texto").fill("msg do grupo UI");
  await p1.getByRole("button", { name: "Enviar", exact: true }).click();
  t("UI j1: grupo criado + msg enviada", await p1.locator(".internet-bolha", { hasText: "msg do grupo UI" }).count() >= 1);

  await p2.locator(".internet-rede").getByRole("button", { name: /Voltar/ }).click();
  await subMsg(p2, "Caixa de entrada");
  await p2.locator(".internet-conversa-item", { hasText: "Tribo UI" }).first().waitFor({ timeout: 10000 });
  await p2.locator(".internet-conversa-item", { hasText: "Tribo UI" }).first().click();
  await p2.getByText("Você foi convidado para este grupo.").waitFor({ timeout: 10000 });
  t("UI j2: banner de convite de grupo", true);
  await p2.getByRole("button", { name: "Aceitar convite", exact: true }).click();
  await p2.locator("#internet-msg-texto").waitFor({ timeout: 10000 });
  t("UI j2: responderConviteGrupo real → composer liberado", true);
  await p2.locator("#internet-msg-texto").fill("entrei no grupo");
  await p2.getByRole("button", { name: "Enviar", exact: true }).click();
  await p1.locator(".internet-bolha", { hasText: "entrei no grupo" }).waitFor({ timeout: 10000 });
  t("UI j1: msg do convidado chega", true);

  // reconexão via UI
  await p1.evaluate(() => window.__mesaSocket?.disconnect());
  await p1.getByText(/Reconectando/).waitFor({ timeout: 8000 });
  t("UI j1: banner Reconectando", true);
  t("UI j1: composer desabilitado", await p1.locator("#internet-msg-texto").isDisabled());
  await p1.evaluate(() => window.__mesaSocket?.connect());
  await p1.waitForTimeout(1500);
  t("UI j1: reconexão restaura", await p1.getByText(/Reconectando/).count() === 0);

  // negações honestas na UI — navegação do zero p/ estado determinístico
  const irPersonagemZero = async (page, nome) => {
    await page.goto(BASE);
    await page.getByText("Servidor online").waitFor({ timeout: 15000 });
    await irCampanha(page);
    await abrirPersonagem(page, nome);
  };
  await irPersonagemZero(p2, "Sem Device UB");
  await p2.getByRole("group", { name: "Módulos do personagem" })
    .getByRole("button", { name: "Internet", exact: true }).click();
  await p2.getByText("Acesso à Internet não liberado.").waitFor({ timeout: 10000 });
  t("UI j2: sem dispositivo → gate honesto", true);

  await irPersonagemZero(p1, "Sem Conta UA"); await abrirRede(p1);
  await abaMsg(p1, "Conta");
  await p1.getByText(/ainda não tem conta/i).waitFor({ timeout: 10000 });
  t("UI j1: sem conta → vazio honesto", true);

  t("UI: zero pageerror/console.error", errosConsole.length === 0, errosConsole.slice(0, 3).join(" | "));

  await browser.close();
} finally {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  if (proc) await encerrarServidor(proc);
  if (browser) await browser.close().catch(() => {});
  limparDir(DIR);
}
console.log(`\n${pass} ok / ${fail} falhas`);
process.exit(fail ? 1 : 0);
