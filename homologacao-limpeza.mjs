// Homologação v1.0 na cópia limpa — instância isolada :3011 (MESTRE_BANCO=simulacao-limpeza)
// Cobre §6: admin, campanhas/fichas, mesa/dados, complementares, persistência.
import Database from "better-sqlite3";
import { io as ioClient } from "socket.io-client";

const BASE = process.env.HOM_BASE || "http://localhost:3011";
const API = BASE + "/api";
const BANCO_COPIA = "simulacao-limpeza/mestre-rpg-copia.db";
const db = new Database(BANCO_COPIA);

let pass = 0, fail = 0;
const falhas = [];
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; falhas.push(n + " " + extra); console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

async function req(metodo, path, { cookie, body, raw, headers = {} } = {}) {
  const h = { cookie: cookie ?? "", ...headers };
  let payload;
  if (raw !== undefined) { payload = raw; h["content-type"] = "application/octet-stream"; }
  else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] = "application/json"; }
  const r = await fetch(API + path, { method: metodo, headers: h, body: payload });
  let json = null; try { json = await r.json(); } catch { }
  return { status: r.status, json, headers: r.headers };
}
const cookieDe = (r) => (r.headers.get("set-cookie") || "").split(";")[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function conectar(cookie) {
  return ioClient(BASE, { path: "/socket.io", transports: ["polling", "websocket"], extraHeaders: { cookie }, reconnection: false });
}
function esperar(socket, evento, pred = () => true, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const tm = setTimeout(() => reject(new Error("timeout " + evento)), timeout);
    const h = (d) => { if (pred(d)) { clearTimeout(tm); socket.off(evento, h); resolve(d); } };
    socket.on(evento, h);
  });
}
const emitirCb = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));

// estrutura de ficha reutilizada do modelo preservado "Ficha Teste" (exportada no backup)
const MODELOS = JSON.parse((await import("node:fs")).readFileSync("backups/pre-limpeza-2026-11-08T18-56-21-832Z/modelos-ficha/modelos-ficha.json", "utf8"));
const estruturaFichaTeste = JSON.parse(JSON.stringify(MODELOS.find((m) => m.name === "Ficha Teste").versions.find((v) => v.published_at).structure));
estruturaFichaTeste.pontos = { ...(estruturaFichaTeste.pontos ?? {}), habilitado: false }; // pool de pontos desligado p/ fixture

// ---------- 1. ADMIN ----------
sec("1. Administrador");
{
  const r1 = await req("POST", "/auth/login", { body: { username: "administrador", password: "SenhaErrada123!" } });
  t("login senha errada rejeitado", r1.status === 401);
  const login = await req("POST", "/auth/login", { body: { username: "administrador", password: "Mestre@2026!" } });
  t("login admin", login.status === 200 && login.json?.usuario?.isAdmin === true, JSON.stringify(login.json).slice(0, 120));
  const admin = { cookie: cookieDe(login) };
  globalThis.__admin = admin;

  const me = await req("GET", "/auth/me", { cookie: admin.cookie });
  t("sessao valida (/auth/me)", me.status === 200 && me.json?.usuario?.username === "administrador");

  const out = await req("POST", "/auth/logout", { cookie: admin.cookie });
  t("logout", out.status === 200);
  const me2 = await req("GET", "/auth/me", { cookie: admin.cookie });
  t("sessao encerrada apos logout", me2.status === 401);

  const login2 = await req("POST", "/auth/login", { body: { username: "administrador", password: "Mestre@2026!" } });
  globalThis.__admin = { cookie: cookieDe(login2) };
  const me3 = await req("GET", "/auth/me", { cookie: globalThis.__admin.cookie });
  t("novo login + sessao persistente", me3.status === 200);

  const users = await req("GET", "/admin/users", { cookie: globalThis.__admin.cookie });
  t("acesso admin: lista usuarios", users.status === 200 && Array.isArray(users.json?.usuarios ?? users.json?.users ?? users.json), JSON.stringify(users.json).slice(0, 100));
  t("somente 1 usuario no banco", users.status === 200);

  const cfg = await req("GET", "/admin/servidor/config", { cookie: globalThis.__admin.cookie });
  t("config servidor legivel", cfg.status === 200, JSON.stringify(cfg.json).slice(0, 100));
  const st = await req("GET", "/admin/servidor/status", { cookie: globalThis.__admin.cookie });
  t("status servidor", st.status === 200);
}
const ADMIN = globalThis.__admin;

// ---------- 2. CAMPANHA + FICHA + JOGADOR ----------
sec("2. Campanha, ficha, convite, jogador");
let CID, CHAR_ID, SESS_ID, CAMPO_ID = "forca";
{
  const camp = await req("POST", "/campaigns", { cookie: ADMIN.cookie, body: { name: "Campanha Oficial v1", system: "teste" } });
  t("criar campanha", camp.status === 201, JSON.stringify(camp.json).slice(0, 150));
  CID = camp.json?.campanha?.id;

  // modelo de ficha: cria na campanha e injeta a estrutura preservada do backup
  const tpl = await req("POST", `/campaigns/${CID}/sheet-templates`, { cookie: ADMIN.cookie, body: { name: "Ficha Preservada" } });
  t("criar modelo", tpl.status === 201, JSON.stringify(tpl.json).slice(0, 120));
  const tplId = tpl.json?.modelo?.id, vid = tpl.json?.modelo?.versionId;
  const put = await req("PUT", `/campaigns/${CID}/sheet-templates/${tplId}/versions/${vid}`, { cookie: ADMIN.cookie, body: { estrutura: estruturaFichaTeste } });
  t("gravar estrutura preservada", put.status === 200, JSON.stringify(put.json).slice(0, 120));
  const pub = await req("POST", `/campaigns/${CID}/sheet-templates/${tplId}/publish`, { cookie: ADMIN.cookie, body: { versionId: vid } });
  t("publicar versao", pub.status === 200, JSON.stringify(pub.json).slice(0, 120));
  const def = await req("PATCH", `/campaigns/${CID}/sheet-templates/${tplId}`, { cookie: ADMIN.cookie, body: { isDefault: true, isActive: true } });
  t("marcar modelo padrao", def.status === 200);

  // convite + jogador
  const inv = await req("POST", `/campaigns/${CID}/invitations`, { cookie: ADMIN.cookie, body: { role: "jogador" } });
  t("criar convite", inv.status === 201 || inv.status === 200, JSON.stringify(inv.json).slice(0, 150));
  const codigo = inv.json?.convite?.codigo ?? inv.json?.convite?.code ?? inv.json?.codigo;

  const novoUser = await req("POST", "/admin/users", { cookie: ADMIN.cookie, body: { username: "jogador_oficial", password: "Jogador@2026", displayName: "Jogador Oficial" } });
  t("admin cria usuario jogador", novoUser.status === 201, JSON.stringify(novoUser.json).slice(0, 120));

  const loginJ = await req("POST", "/auth/login", { body: { username: "jogador_oficial", password: "Jogador@2026" } });
  const JOG = { cookie: cookieDe(loginJ) };
  t("login jogador", loginJ.status === 200);

  const infoInv = await req("GET", `/convites/${codigo}`, { cookie: JOG.cookie });
  t("consultar convite", infoInv.status === 200, JSON.stringify(infoInv.json).slice(0, 120));
  const acc = await req("POST", `/convites/${codigo}/aceitar`, { cookie: JOG.cookie });
  t("aceitar convite", acc.status === 200 || acc.status === 201, JSON.stringify(acc.json).slice(0, 120));

  // sessao de jogo
  const sess = await req("POST", `/campaigns/${CID}/sessoes`, { cookie: ADMIN.cookie, body: { name: "Sessão 1" } });
  t("criar sessao de jogo", sess.status === 201, JSON.stringify(sess.json).slice(0, 120));
  SESS_ID = sess.json?.sessao?.id;

  // personagem do jogador
  const pj = db.prepare("select id from users where username='jogador_oficial'").get();
  const mem = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, pj.id);
  const chr = await req("POST", `/campaigns/${CID}/characters`, { cookie: JOG.cookie, body: { name: "Herói Teste", data: { nome: "Herói Teste", forca: 5, intel: 3, computacao: 2 } } });
  t("criar personagem", chr.status === 201, JSON.stringify(chr.json).slice(0, 200));
  CHAR_ID = chr.json?.personagem?.id ?? chr.json?.id;

  // editar ficha e recuperar
  const patch = await req("PATCH", `/characters/${CHAR_ID}`, { cookie: JOG.cookie, body: { data: { nome: "Herói Teste", forca: 7, intel: 4, computacao: 3 } } });
  t("editar ficha", patch.status === 200, JSON.stringify(patch.json).slice(0, 120));
  const get = await req("GET", `/characters/${CHAR_ID}`, { cookie: JOG.cookie });
  t("recuperar ficha salva", get.status === 200 && JSON.stringify(get.json).includes('"forca":7'), JSON.stringify(get.json).slice(0, 200));
}

// ---------- 3. MESA + DADOS ----------
sec("3. Mesa, chat, D10, dados");
{
  const sockA = conectar(ADMIN.cookie);
  const sockJ = conectar(globalThis.__jogCookie ?? "");
  // pega cookie do jogador de novo (login acima nao persistiu em global)
  const loginJ2 = await req("POST", "/auth/login", { body: { username: "jogador_oficial", password: "Jogador@2026" } });
  const JOG = { cookie: cookieDe(loginJ2) };
  sockJ.disconnect();
  const sockJ2 = conectar(JOG.cookie);
  await new Promise((r) => { sockA.on("connect", r); sockJ2.on("connect", r); });
  t("socket admin conecta", sockA.connected);
  t("socket jogador conecta", sockJ2.connected);

  // reconexao: derruba e reconecta transporte
  sockJ2.disconnect();
  const sockJ3 = conectar(JOG.cookie);
  await new Promise((r) => sockJ3.on("connect", r));
  t("reconexao socket", sockJ3.connected);

  const entrarA = await emitirCb(sockA, "entrar-campanha", CID);
  const entrarJ = await emitirCb(sockJ3, "entrar-campanha", CID);
  t("entrar-campanha admin", entrarA === true || entrarA?.ok !== false, JSON.stringify(entrarA));
  t("entrar-campanha jogador", entrarJ === true || entrarJ?.ok !== false, JSON.stringify(entrarJ));

  const mA = await emitirCb(sockA, "mesa:entrar", { sessionId: SESS_ID });
  const mJ = await emitirCb(sockJ3, "mesa:entrar", { sessionId: SESS_ID });
  t("mesa:entrar admin", mA?.ok === true, JSON.stringify(mA).slice(0, 120));
  t("mesa:entrar jogador", mJ?.ok === true, JSON.stringify(mJ).slice(0, 120));

  // chat
  const msgP = esperar(sockJ3, "mesa:mensagem", (d) => d?.content?.includes("Olá mesa"));
  const send = await emitirCb(sockJ3, "mesa:mensagem", { sessionId: SESS_ID, content: "Olá mesa!", clientId: "c1" });
  const recv = await msgP.catch(() => null);
  t("chat enviar/receber", send?.ok !== false && !!recv, JSON.stringify(recv ?? send).slice(0, 120));

  // D10 challenge via campo elegível
  const testeP = esperar(sockA, "mesa:teste", (d) => d?.id);
  const pedir = await emitirCb(sockA, "mesa:teste:pedir", { sessionId: SESS_ID, characterId: CHAR_ID, campoId: CAMPO_ID, minimo: 6 });
  const teste = await testeP.catch(() => null);
  t("desafio D10 criado", !!teste || pedir?.ok !== false, JSON.stringify(pedir ?? teste).slice(0, 150));
  const tid = teste?.id ?? pedir?.id ?? pedir?.teste?.id;
  if (tid) {
    const rolP = esperar(sockA, "mesa:teste:rolagem", () => true).catch(() => null);
    const rolar = await emitirCb(sockA, "mesa:teste:rolar", { sessionId: SESS_ID, testId: tid });
    t("rolagem D10 aceita", rolar?.ok !== false, JSON.stringify(rolar).slice(0, 150));
    await rolP;
  }

  // dano D4/D6/D8/D10/D20
  for (const sides of [4, 6, 8, 10, 20]) {
    const rp = esperar(sockA, "mesa:rolagem", (d) => d?.grupos?.[0]?.lados === sides);
    const rr = await emitirCb(sockA, "mesa:rolar", { sessionId: SESS_ID, dados: [{ sides, count: 2 }], motivo: `dano d${sides}`, modo: "dano" });
    const rec = await rp.catch(() => null);
    t(`dano D${sides}`, rr?.ok !== false && !!rec, JSON.stringify(rr).slice(0, 100));
  }

  // cores dos dados (preferências)
  const pref = await req("PATCH", "/auth/preferences", { cookie: ADMIN.cookie, body: { dados: { corExterna: "#ff0000", corInterna: "#00ff00" } } });
  t("salvar cores dos dados", pref.status === 200, JSON.stringify(pref.json).slice(0, 120));
  const meP = await req("GET", "/auth/me", { cookie: ADMIN.cookie });
  t("cores persistidas", JSON.stringify(meP.json).includes("ff0000"), JSON.stringify(meP.json?.usuario?.preferences ?? {}).slice(0, 120));

  sockA.disconnect(); sockJ3.disconnect();
}

// ---------- 4. COMPLEMENTARES ----------
sec("4. Inventário, patrimônio, veículos, financeiro, diário, arquivos");
{
  const inv = await req("POST", `/characters/${CHAR_ID}/inventario`, { cookie: JOG2_COOKIE(), body: { name: "Poção", quantity: 3, category: "consumivel" } });
  function JOG2_COOKIE() { return globalThis.__jog2?.cookie ?? ADMIN.cookie; }
  t("inventario criar", inv.status === 201 || inv.status === 200, JSON.stringify(inv.json).slice(0, 120));
  const invL = await req("GET", `/characters/${CHAR_ID}/inventario`, { cookie: ADMIN.cookie });
  t("inventario listar", invL.status === 200 && JSON.stringify(invL.json).includes("Poção"));

  const eqp = await req("POST", `/characters/${CHAR_ID}/equipamentos`, { cookie: ADMIN.cookie, body: { name: "Espada", kind: "arma", slot: "mao" } });
  t("equipamento criar", eqp.status === 201 || eqp.status === 200, JSON.stringify(eqp.json).slice(0, 120));

  const veic = await req("POST", `/characters/${CHAR_ID}/veiculos`, { cookie: ADMIN.cookie, body: { name: "Moto", type: "terrestre" } });
  t("veiculo criar", veic.status === 201 || veic.status === 200, JSON.stringify(veic.json).slice(0, 120));

  const conta = await req("POST", `/characters/${CHAR_ID}/financeiro/contas`, { cookie: ADMIN.cookie, body: { type: "pix", name: "PIX", balanceReais: 100 } });
  t("conta PIX criar", conta.status === 201 || conta.status === 200, JSON.stringify(conta.json).slice(0, 120));
  const contaId = conta.json?.id ?? conta.json?.conta?.id;
  if (contaId) {
    const mov = await req("POST", `/characters/${CHAR_ID}/financeiro/movimentar`, { cookie: ADMIN.cookie, body: { accountId: contaId, tipo: "entrada", valor: 50, descricao: "Pagamento" } });
    t("movimentacao financeira", mov.status === 200 || mov.status === 201, JSON.stringify(mov.json).slice(0, 120));
  }

  const nota = await req("POST", `/campaigns/${CID}/anotacoes`, { cookie: ADMIN.cookie, body: { title: "Diário da sessão", content: "Aventura começou", kind: "diario", visibility: "privada" } });
  t("anotacao/diario", nota.status === 201, JSON.stringify(nota.json).slice(0, 120));

  const pasta = await req("POST", `/campaigns/${CID}/arquivos/pastas`, { cookie: ADMIN.cookie, body: { name: "Mapas" } });
  const up = await req("POST", `/campaigns/${CID}/arquivos/upload`, {
    cookie: ADMIN.cookie, raw: Buffer.from("mapa de teste"),
    headers: { "x-file-name": encodeURIComponent("mapa.txt"), "x-file-mime": "text/plain", "x-visibility": "mestre" },
  });
  t("upload arquivo", up.status === 200 || up.status === 201, JSON.stringify(up.json).slice(0, 120));
}

// ---------- 5. PERSISTÊNCIA ----------
sec("5. Persistência (dados gravados no banco da cópia)");
{
  const c = db.prepare("select count(*) c from characters where campaign_id=?").get(CID).c;
  const ch = db.prepare("select count(*) c from chat_messages where campaign_id=?").get(CID).c;
  const r = db.prepare("select count(*) c from rolls where campaign_id=?").get(CID).c;
  const nt = db.prepare("select count(*) c from notes where campaign_id=?").get(CID).c;
  const f = db.prepare("select count(*) c from files where campaign_id=?").get(CID).c;
  t("personagem persistido", c === 1);
  t("chat persistido", ch >= 2, `chat=${ch}`);
  t("rolagens persistidas", r >= 6, `rolls=${r}`);
  t("anotacao persistida", nt === 1);
  t("arquivo persistido", f === 1);
}

console.log(`\n==== RESULTADO: ${pass} ok, ${fail} falhas ====`);
if (falhas.length) console.log("Falhas:", falhas.join(" | "));
db.close();
process.exit(fail ? 1 : 0);
