// Issue #350/#351 — Internet diegética: contas, contatos, conversas,
// mensagens, leitura e fan-out (contrato #349 v3 / arquitetura #360).
// Sobe servidor real com banco DESCARTÁVEL (limpo) e prova via HTTP+socket:
//   - migração aditiva em banco limpo e upgrade a partir do journal
//     truncado em 0038 (v1.1.0) — dados pré-existentes preservados;
//   - conta opt-in: titularidade, gate cumulativo, handle único, sem
//     bypass de mestre sobre personagem alheio;
//   - contatos: aresta dirigida, aceite só pelo destino, bloqueio
//     bilateral de facto, remoção preservando histórico;
//   - conversa direta: exige contato aceito, parKey resolve replay;
//   - mensagens socket: ACK antes do fan-out, idempotência
//     (requestId+payloadHash), uso_conflito, limites P8, fan-out
//     individual `usuario:{userId}` SEM room de conteúdo;
//   - histórico HTTP: keyset cursor, participante ativo, mestre lê
//     somente leitura COM auditoria (P10), ADMIN/sem-papel negado;
//   - revogação: arquivar personagem corta contaAutorizadaPara em
//     socket e HTTP na hora;
//   - cross-campaign: conversa da campanha A é invisível na campanha B;
//   - P9: exportação NÃO contém nenhuma tabela internet_*;
//   - grupo: convite→aceite, dono convida, saída transfere/arquiva (P6);
//   - cursor de leitura monotônico e idempotente.
import crypto from "node:crypto";
import { io as ioClient } from "socket.io-client";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";
import {
  autorizarPrimeiroBootstrap, gravarProvisionamento, lerProvisionamento,
} from "./scripts/estado-externo.mjs";

const REPO = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helper de migrate com pasta de migrations customizada ----------
async function migrarCom(banco, migrationsFolder) {
  const stateDir = join(dirname(banco), "state-externo");
  await new Promise((res, rej) => {
    const p = spawn("node", ["servidor/dist/db/migrate.js"], {
      env: {
        ...process.env,
        MESTRE_BANCO: banco,
        MESTRE_STATE_DIR: stateDir,
        MESTRE_BACKUPS: join(dirname(banco), "backups"),
        MESTRE_MIGRATIONS_FOLDER: migrationsFolder,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => code === 0 ? res() : rej(new Error(`migrate(${migrationsFolder}) falhou (${code}): ${err.slice(-800)}`)));
  });
}

// ---------- socket helpers ----------
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
const emitirCb = (s, ev, p, timeoutMs = 15000) => new Promise((r) => {
  const to = setTimeout(() => r({ ok: false, erro: "timeout_teste" }), timeoutMs);
  s.emit(ev, p, (x) => { clearTimeout(to); r(x); });
});
/** escuta UM evento com timeout (para provar entrega ou ausência). */
function ouvirUmaVez(s, ev, timeoutMs = 4000) {
  return new Promise((res) => {
    const to = setTimeout(() => { s.off(ev, h); res(null); }, timeoutMs);
    const h = (d) => { clearTimeout(to); s.off(ev, h); res(d); };
    s.on(ev, h);
  });
}

const DIR = dirTeste("internet-contas");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const BANCO_UP = join(DIR, "banco-up", "mestre-rpg.db");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;

/** Fixture do gate Internet 1.1.0 (mesmo padrão de teste-internet-e2e):
 *  perícia/conhecimento + dispositivo canônico no patrimônio. */
function fixtureGate(banco, campId) {
  const db = abrirDb(banco);
  const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
  const agora = Date.now();
  const ins = db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?, '{}',?,?)");
  for (const [kind, key, name] of [
    ["pericia", "computador", "Computador"],
    ["conhecimento", "tecnologia", "Tecnologia"],
    ["item", "notebook", "Notebook"],
    ["item", "celular_descartavel", "Celular descartável"],
  ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
  const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
  const est = JSON.parse(ver.structure);
  est.secoes[0].campos.push(
    { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
    { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
  );
  db.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), ver.id);
  db.close();
}
function darDispositivo(banco, characterId) {
  const db = abrirDb(banco);
  db.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), characterId, "Notebook", 1, null, "equipamento", "mochila", "novo", 1.5,
      JSON.stringify({ regra: { kind: "item", key: "notebook" } }), Date.now(), Date.now());
  db.close();
}

try {
  // ================= MIGRAÇÕES =================
  sec("A. Migração — banco limpo e upgrade v1.1.0");

  // A1: banco limpo recebe TODAS as migrations (inclui 0039)
  await prepararBanco(BANCO);
  {
    const db = abrirDb(BANCO);
    const tabelas = new Set(db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name));
    for (const tb of ["internet_accounts", "internet_contacts", "internet_conversations", "internet_participantes", "internet_messages"]) {
      t(`banco limpo tem ${tb}`, tabelas.has(tb));
    }
    db.close();
  }

  // A2: upgrade — banco migrado só até 0038 (v1.1.0) depois recebe 0039
  // sem perder dados. Pasta de migrations truncada no journal.
  {
    const srcMig = join(REPO, "servidor", "migrations");
    const dstMig = join(DIR, "migrations-ate-0038");
    mkdirSync(dstMig, { recursive: true });
    cpSync(srcMig, dstMig, { recursive: true });
    rmSync(join(dstMig, "0039_dapper_rocket_raccoon.sql"), { force: true });
    // remove o snapshot 0039 e a entrada do journal
    const snapDir = join(dstMig, "meta");
    for (const f of ["0039_snapshot.json"]) rmSync(join(snapDir, f), { force: true });
    const journalPath = join(snapDir, "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.entries = journal.entries.filter((e) => !String(e.tag).includes("0039"));
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));

    // provisiona o state dir isolado do banco de upgrade (mesmo fluxo
    // de prepararBanco — P10-B exige bootstrap reconhecido)
    {
      const envEstado = {
        ...process.env,
        MESTRE_STATE_DIR: join(dirname(BANCO_UP), "state-externo"),
        MESTRE_BANCO: BANCO_UP,
        MESTRE_BACKUPS: join(dirname(BANCO_UP), "backups"),
      };
      if (lerProvisionamento(REPO, envEstado).status === "ausente") {
        gravarProvisionamento(REPO, envEstado);
      }
      const auth = autorizarPrimeiroBootstrap(REPO, envEstado);
      if (!auth.autorizado) throw new Error(`bootstrap upgrade negado: ${auth.motivo}`);
    }
    await migrarCom(BANCO_UP, dstMig);
    {
      const db = abrirDb(BANCO_UP);
      const tabelas = new Set(db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name));
      t("banco v1.1.0 NÃO tem internet_messages antes do upgrade",
        !tabelas.has("internet_messages"));
      // semeia um usuário/campanha mínimos para provar preservação
      const uid = crypto.randomUUID();
      const agora = Date.now();
      db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
        .run(uid, "upgrade_user", "Upgrade", "x", agora, agora);
      db.close();
    }
    // agora roda o migrate REAL (com 0039) sobre o banco "velho"
    await migrarCom(BANCO_UP, srcMig);
    {
      const db = abrirDb(BANCO_UP);
      const tabelas = new Set(db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name));
      t("upgrade cria internet_messages", tabelas.has("internet_messages"));
      t("upgrade preserva users", !!db.prepare("select id from users where username='upgrade_user'").get());
      // idempotência: segundo migrate não falha nem duplica
      await migrarCom(BANCO_UP, srcMig);
      t("migrate repetido é idempotente", true);
      db.close();
    }
  }

  // ================= CENÁRIO =================
  sec("B. Cenário — contas diegéticas");
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
  proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  await esperarSaudavel(BASE, proc);

  const C = await criarCenario(BASE, BANCO, { jogadores: { j1: "ic_j1", j2: "ic_j2", j3: "ic_j3" } });
  const campId = C.campId;
  fixtureGate(BANCO, campId);
  const charJ1 = C.novoPersonagem(C.jogadores.j1.membershipId, "Ada Conectada", { comp: 1 });
  const charJ2 = C.novoPersonagem(C.jogadores.j2.membershipId, "Beto Conectado", { comp: 1 });
  const charJ3 = C.novoPersonagem(C.jogadores.j3.membershipId, "Cida Conectada", { comp: 1 });
  const charSemGate = C.novoPersonagem(C.jogadores.j3.membershipId, "Sem Gate", { for: 5 }); // sem perícia
  for (const ch of [charJ1, charJ2, charJ3]) darDispositivo(BANCO, ch);
  darDispositivo(BANCO, charSemGate); // dispositivo sim, perícia não

  const j1 = C.jogadores.j1, j2 = C.jogadores.j2, j3 = C.jogadores.j3;
  const API = (metodo, path, cookie, body) => req(BASE, metodo, `/campaigns/${campId}/internet${path}`, { cookie, body });

  // B1: criação de conta — happy path e negações
  const c1 = await API("POST", "/account", j1.cookie, { characterId: charJ1, handle: "ada.exe", displayName: "Ada" });
  t("j1 cria conta diegética", c1.status === 201 && c1.json?.conta?.handle === "ada.exe", JSON.stringify(c1.json).slice(0, 200));
  const contaJ1 = c1.json?.conta?.id;
  const c2 = await API("POST", "/account", j2.cookie, { characterId: charJ2, handle: "beto.net", displayName: "Beto" });
  t("j2 cria conta diegética", c2.status === 201, JSON.stringify(c2.json).slice(0, 200));
  const contaJ2 = c2.json?.conta?.id;
  const c3 = await API("POST", "/account", j3.cookie, { characterId: charJ3, handle: "cida.io" });
  t("j3 cria conta diegética", c3.status === 201, JSON.stringify(c3.json).slice(0, 200));
  const contaJ3 = c3.json?.conta?.id;

  t("handle duplicado na campanha → 409", (await API("POST", "/account", j2.cookie, { characterId: charJ2, handle: "ADA.EXE" })).status === 409
    || (await API("POST", "/account", j3.cookie, { characterId: charJ3, handle: "ada.exe" })).status === 409);
  t("personagem já com conta → 409", (await API("POST", "/account", j1.cookie, { characterId: charJ1, handle: "ada2" })).status === 409);
  t("personagem de OUTRO usuário → 403", (await API("POST", "/account", j2.cookie, { characterId: charJ1, handle: "invasora" })).status === 403);
  t("personagem inelegível (sem perícia) → 403",
    (await API("POST", "/account", j3.cookie, { characterId: charSemGate, handle: "semgate" })).status === 403);
  t("handle inválido → 400", (await API("POST", "/account", j1.cookie, { characterId: charJ1, handle: "X!" })).status === 400);

  // B2: diretório público mínimo (P11) — handle+displayName, sem usuário real
  const dir = await API("GET", "/accounts", j1.cookie);
  t("diretório lista contas ativas", dir.status === 200 && dir.json?.contas?.length === 3, JSON.stringify(dir.json).slice(0, 200));
  t("diretório não vaza characterId/userId",
    dir.json?.contas?.every((c) => !("characterId" in c) && !("userId" in c)));

  // ================= CONTATOS =================
  sec("C. Contatos — aresta dirigida e aceite");

  // tentativa de conversa ANTES do aceite → negada (P4)
  const convAntes = await API("POST", "/conversations", j1.cookie, { tipo: "direta", contaDestinoId: contaJ2 });
  t("conversa direta exige contato aceito", convAntes.status === 403, JSON.stringify(convAntes.json));

  const ped = await API("POST", "/contacts", j1.cookie, { contaId: contaJ2 });
  t("j1 envia pedido de contato", ped.status === 201 && ped.json?.contato?.status === "pendente", JSON.stringify(ped.json).slice(0, 160));
  const contatoId = ped.json?.contato?.id;
  t("replay do pedido pendente é idempotente", (await API("POST", "/contacts", j1.cookie, { contaId: contaJ2 })).json?.replay === true);
  t("pedido reverso com aresta pendente → 409",
    (await API("POST", "/contacts", j2.cookie, { contaId: contaJ1 })).status === 409);

  const listaJ2 = await API("GET", "/contacts", j2.cookie);
  t("j2 vê o pedido recebido", listaJ2.json?.contatos?.some((c) => c.id === contatoId && c.souOrigem === false && c.status === "pendente"));

  t("quem pede NÃO pode aceitar a própria aresta",
    (await API("POST", `/contacts/${contatoId}/aceitar`, j1.cookie)).status === 403);
  const acc = await API("POST", `/contacts/${contatoId}/aceitar`, j2.cookie);
  t("destino aceita o contato", acc.status === 200 && acc.json?.status === "aceito", JSON.stringify(acc.json));

  // ================= CONVERSA DIRETA =================
  sec("D. Conversa direta — criação, replay e socket");

  const conv = await API("POST", "/conversations", j1.cookie, { tipo: "direta", contaDestinoId: contaJ2 });
  t("conversa direta criada", conv.status === 201 && !!conv.json?.conversa, JSON.stringify(conv.json).slice(0, 200));
  const conversaId = conv.json?.conversa;
  const convReplay = await API("POST", "/conversations", j2.cookie, { tipo: "direta", contaDestinoId: contaJ1 });
  t("parKey resolve criação concorrente/reversa (mesma conversa)",
    convReplay.json?.conversa === conversaId && convReplay.json?.replay === true, JSON.stringify(convReplay.json));

  // sockets dos dois participantes
  const sJ1 = conectar(j1.cookie), sJ2 = conectar(j2.cookie), sJ3 = conectar(j3.cookie), sM = conectar(C.cookieMestre);
  await Promise.all([pronto(sJ1), pronto(sJ2), pronto(sJ3), pronto(sM)]);

  const entrar1 = await emitirCb(sJ1, "internet:conversa-entrar", { conversaId, contaId: contaJ1 });
  t("conversa-entrar valida e devolve cursor (sem conteúdo)",
    entrar1?.ok === true && entrar1?.cursor && !("mensagens" in entrar1), JSON.stringify(entrar1));
  const entrarFalso = await emitirCb(sJ3, "internet:conversa-entrar", { conversaId, contaId: contaJ3 });
  t("não-participante não entra na conversa", entrarFalso?.ok === false, JSON.stringify(entrarFalso));
  const entrarSemConta = await emitirCb(sJ1, "internet:conversa-entrar", { conversaId, contaId: "inexistente" });
  t("conta inexistente → ok:false", entrarSemConta?.ok === false);

  // ================= MENSAGENS =================
  sec("E. Mensagens — ACK, idempotência, fan-out individual");

  const esperaMsgJ2 = ouvirUmaVez(sJ2, "internet:mensagem", 6000);
  const msg1 = await emitirCb(sJ1, "internet:mensagem:enviar", {
    conversaId, contaId: contaJ1, requestId: "req-1", conteudo: "olá, beto!",
  });
  t("envio retorna ACK com mensagemId", msg1?.ok === true && !!msg1?.mensagemId, JSON.stringify(msg1));
  const recebida = await esperaMsgJ2;
  t("destinatário recebe internet:mensagem",
    recebida?.conversaId === conversaId && recebida?.mensagemId === msg1?.mensagemId
    && recebida?.autor?.handle === "ada.exe", JSON.stringify(recebida).slice(0, 240));
  t("payload carrega contaId do DESTINATÁRIO para roteamento",
    recebida?.contaId === contaJ2, `contaId=${recebida?.contaId} esperado=${contaJ2}`);

  // replay: mesmo requestId + mesmo conteúdo → replay:true, sem 2ª gravação
  const replay = await emitirCb(sJ1, "internet:mensagem:enviar", {
    conversaId, contaId: contaJ1, requestId: "req-1", conteudo: "olá, beto!",
  });
  t("replay mesmo requestId+hash → replay:true",
    replay?.ok === true && replay?.replay === true && replay?.mensagemId === msg1?.mensagemId, JSON.stringify(replay));
  const conflito = await emitirCb(sJ1, "internet:mensagem:enviar", {
    conversaId, contaId: contaJ1, requestId: "req-1", conteudo: "conteúdo DIFERENTE",
  });
  t("mesmo requestId hash divergente → uso_conflito",
    conflito?.ok === false && conflito?.erro === "uso_conflito", JSON.stringify(conflito));

  const noDb = abrirDb(BANCO)
    .prepare("select count(*) c from internet_messages where request_id='req-1'").get().c;
  t("replay/conflito não gravaram duplicata", noDb === 1, `linhas=${noDb}`);

  // limites P8: conteúdo > 4000 chars
  const longo = await emitirCb(sJ1, "internet:mensagem:enviar", {
    conversaId, contaId: contaJ1, requestId: "req-longo", conteudo: "x".repeat(4001),
  });
  t("mensagem > 4000 chars rejeitada", longo?.ok === false && longo?.erro === "conteudo_longo", JSON.stringify(longo));

  // rate limit: 20 msg/min por conta — dispara 25 rapidas
  const rajada = [];
  for (let i = 0; i < 25; i++) {
    rajada.push(emitirCb(sJ1, "internet:mensagem:enviar", {
      conversaId, contaId: contaJ1, requestId: `req-rl-${i}`, conteudo: `m${i}`,
    }));
  }
  const rs = await Promise.all(rajada);
  const okCount = rs.filter((r) => r?.ok === true).length;
  const rlCount = rs.filter((r) => r?.erro === "rate_limit").length;
  t("rate limit 20/min por conta (P8)", okCount <= 21 && rlCount >= 3, `ok=${okCount} rl=${rlCount}`);

  // não-participante não envia
  const naoPart = await emitirCb(sJ3, "internet:mensagem:enviar", {
    conversaId, contaId: contaJ3, requestId: "req-x", conteudo: "invasão",
  });
  t("não-participante → nao_participante", naoPart?.ok === false && naoPart?.erro === "nao_participante", JSON.stringify(naoPart));

  // mestre NÃO participa → não recebe conteúdo (P10 é só leitura HTTP)
  const esperaMestre = ouvirUmaVez(sM, "internet:mensagem", 2500);
  await emitirCb(sJ1, "internet:mensagem:enviar", {
    conversaId, contaId: contaJ1, requestId: "req-m", conteudo: "só p/ beto",
  });
  t("mestre não-participante NÃO recebe fan-out de conteúdo", (await esperaMestre) === null);

  // ================= HISTÓRICO HTTP =================
  sec("F. Histórico — keyset, P10 mestre auditado, isolamento");

  const histJ1 = await API("GET", `/conversations/${conversaId}/messages?limit=2`, j1.cookie);
  t("participante lê histórico", histJ1.status === 200 && histJ1.json?.mensagens?.length === 2, JSON.stringify(histJ1.json).slice(0, 200));
  t("paginação keyset retorna cursor", typeof histJ1.json?.proximoCursor === "string");
  const histPag2 = await API("GET", `/conversations/${conversaId}/messages?limit=2&cursor=${encodeURIComponent(histJ1.json.proximoCursor)}`, j1.cookie);
  t("segunda página não repete mensagens", histPag2.json?.mensagens?.every((m) => !histJ1.json.mensagens.some((p) => p.id === m.id)));

  const histMestre = await API("GET", `/conversations/${conversaId}/messages`, C.cookieMestre);
  t("mestre lê conversa alheia (P10 somente leitura)",
    histMestre.status === 200 && histMestre.json?.leituraMestre === true
    && histMestre.json?.mensagens?.length > 0, JSON.stringify(histMestre.json).slice(0, 160));
  const auditoria = abrirDb(BANCO)
    .prepare("select count(*) c from audit_logs where action='internet.leitura_mestre' and campaign_id=?").get(campId).c;
  t("leitura do mestre gerou auditoria (P10)", auditoria >= 1, `audits=${auditoria}`);

  const histJ3 = await API("GET", `/conversations/${conversaId}/messages`, j3.cookie);
  t("não-participante não-mestre → 403", histJ3.status === 403, `status=${histJ3.status}`);

  // GET /conversations/:id — mesmo gate do histórico (P2 revisão):
  // não-vaza composição/cursor para não-participante; mestre lê auditado.
  const detJ1 = await API("GET", `/conversations/${conversaId}`, j1.cookie);
  t("participante lê detalhe da conversa", detJ1.status === 200
    && detJ1.json?.conversa?.participantes?.length === 2, `status=${detJ1.status}`);
  const detJ3 = await API("GET", `/conversations/${conversaId}`, j3.cookie);
  t("não-participante não-mestre → 403 no detalhe", detJ3.status === 403, `status=${detJ3.status}`);
  const auditsAntes = abrirDb(BANCO)
    .prepare("select count(*) c from audit_logs where action='internet.leitura_mestre' and campaign_id=?").get(campId).c;
  const detMestre = await API("GET", `/conversations/${conversaId}`, C.cookieMestre);
  const auditsDepois = abrirDb(BANCO)
    .prepare("select count(*) c from audit_logs where action='internet.leitura_mestre' and campaign_id=?").get(campId).c;
  t("mestre lê detalhe alheio (P10) com auditoria",
    detMestre.status === 200 && auditsDepois === auditsAntes + 1,
    `status=${detMestre.status} audits=${auditsAntes}→${auditsDepois}`);

  // cursor de leitura monotônico
  const ultima = histJ1.json?.mensagens?.at(-1);
  const read1 = await API("POST", `/conversations/${conversaId}/read`, j1.cookie, {
    contaId: contaJ1, ateCreatedAt: Date.parse(ultima.createdAt), ateMessageId: ultima.id,
  });
  t("marcar leitura avança cursor", read1.status === 200 && read1.json?.ok === true, JSON.stringify(read1.json));
  // cursor monotônico: aponta para a PRIMEIRA mensagem real (mais
  // antiga que o cursor já gravado) — deve ser replay, nunca retrocede
  const primeira = histJ1.json?.mensagens?.[0];
  const readVelho = await API("POST", `/conversations/${conversaId}/read`, j1.cookie, {
    contaId: contaJ1, ateCreatedAt: Date.parse(primeira.createdAt), ateMessageId: primeira.id,
  });
  t("cursor nunca retrocede (replay)", readVelho.json?.replay === true, JSON.stringify(readVelho.json));
  const readFalso = await API("POST", `/conversations/${conversaId}/read`, j1.cookie, {
    contaId: contaJ1, ateCreatedAt: Date.now(), ateMessageId: "msg-inexistente",
  });
  t("cursor para mensagem inexistente/de outra conversa → 400",
    readFalso.status === 400, `status=${readFalso.status}`);

  // ================= BLOQUEIO BILATERAL =================
  sec("G. Bloqueio — efeito bilateral de facto (P3)");

  const bloq = await API("POST", `/contacts/${contatoId}/bloquear`, j2.cookie);
  t("destino bloqueia o contato", bloq.status === 200 && bloq.json?.status === "bloqueado", JSON.stringify(bloq.json));
  t("bloquear de novo é replay idempotente", (await API("POST", `/contacts/${contatoId}/bloquear`, j2.cookie)).json?.replay === true);

  const msgBloq = await emitirCb(sJ1, "internet:mensagem:enviar", {
    conversaId, contaId: contaJ1, requestId: "req-b1", conteudo: "ainda aqui?",
  });
  t("envio bloqueado nos DOIS sentidos (origem→destino)",
    msgBloq?.ok === false && msgBloq?.erro === "contato_bloqueado", JSON.stringify(msgBloq));
  const msgBloq2 = await emitirCb(sJ2, "internet:mensagem:enviar", {
    conversaId, contaId: contaJ2, requestId: "req-b2", conteudo: "resposta bloqueada",
  });
  t("envio bloqueado nos DOIS sentidos (destino→origem)",
    msgBloq2?.ok === false && msgBloq2?.erro === "contato_bloqueado", JSON.stringify(msgBloq2));

  // P3: aresta bloqueada só pode ser removida por quem bloqueou (dono
  // da conta DESTINO). A origem tentando remover → 403.
  const delOrigem = await API("DELETE", `/contacts/${contatoId}`, j1.cookie);
  t("origem NÃO remove aresta bloqueada (P3)", delOrigem.status === 403, `status=${delOrigem.status}`);
  const del = await API("DELETE", `/contacts/${contatoId}`, j2.cookie);
  t("bloqueador remove a aresta bloqueada", del.status === 200, `status=${del.status}`);
  const histAposRemocao = await API("GET", `/conversations/${conversaId}/messages`, j1.cookie);
  t("histórico preservado após remoção do contato (P12)", histAposRemocao.json?.mensagens?.length > 0);
  // j1 está no limite P8 (rajada da seção E) — quem prova o envio é j2,
  // cuja cota segue intacta (a tentativa bloqueada não grava mensagem).
  const msgPos = await emitirCb(sJ2, "internet:mensagem:enviar", {
    conversaId, contaId: contaJ2, requestId: "req-b3", conteudo: "volta",
  });
  t("sem aresta bloqueada o envio volta", msgPos?.ok === true, JSON.stringify(msgPos));

  // ================= REVOGAÇÃO =================
  sec("H. Revogação — arquivar personagem corta acesso na hora");

  {
    const db = abrirDb(BANCO);
    db.prepare("update characters set status='arquivado' where id=?").run(charJ3);
    db.close();
  }
  const entrarRevogado = await emitirCb(sJ3, "internet:conversa-entrar", { conversaId, contaId: contaJ3 });
  t("conta de personagem arquivado não entra", entrarRevogado?.ok === false);
  // e o fan-out de uma nova mensagem não vai para o arquivado — j3 nunca
  // foi participante desta conversa, então provamos via conta própria:
  // cria contato+conversa separada seria longo; a prova direta é o gate.
  const contaRevogada = await API("GET", "/accounts", j3.cookie);
  t("conta arquivada some do diretório", !(contaRevogada.json?.contas ?? []).some((c) => c.id === contaJ3));

  // ================= CROSS-CAMPAIGN =================
  sec("I. Cross-campaign — conversa invisível fora da campanha");

  const camp2 = await req(BASE, "POST", "/campaigns", { cookie: C.cookieMestre, body: { name: "Outra Campanha" } });
  const camp2Id = camp2.json?.campanha?.id;
  // j1 vira membro da campanha 2 para isolar o teste no filtro de campanha
  {
    const db = abrirDb(BANCO);
    const agora = Date.now();
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'jogador','ativo',?,?,?)")
      .run(crypto.randomUUID(), camp2Id, j1.id, agora, agora, agora);
    db.close();
  }
  const histCamp2 = await req(BASE, "GET", `/campaigns/${camp2Id}/internet/conversations/${conversaId}/messages`, { cookie: j1.cookie });
  t("conversa da campanha A → 404 na campanha B", histCamp2.status === 404, `status=${histCamp2.status}`);
  const convsCamp2 = await req(BASE, "GET", `/campaigns/${camp2Id}/internet/conversations`, { cookie: j1.cookie });
  t("lista de conversas da campanha B não contém a conversa de A",
    !(convsCamp2.json?.conversas ?? []).some((c) => c.id === conversaId));

  // ================= GRUPO + P6 =================
  sec("J. Grupo — convite, aceite e transferência de dono (P6)");

  // a aresta j1↔j2 foi removida na seção G — recria e aceita de novo
  // para satisfazer o pré-requisito P4 do grupo.
  const ped2 = await API("POST", "/contacts", j1.cookie, { contaId: contaJ2 });
  const contato2Id = ped2.json?.contato?.id;
  t("contato refeito para o grupo", ped2.status === 201, JSON.stringify(ped2.json));
  const acc2 = await API("POST", `/contacts/${contato2Id}/aceitar`, j2.cookie);
  t("contato re-aceito", acc2.status === 200, JSON.stringify(acc2.json));

  // grupo com j1 dono + j2 convidado (contato aceito).
  const grp = await API("POST", "/conversations", j1.cookie, {
    tipo: "grupo", nome: "Operação Echo", origemContaId: contaJ1, contaIds: [contaJ2],
  });
  t("grupo criado com convidado pendente", grp.status === 201 && !!grp.json?.conversa, JSON.stringify(grp.json).slice(0, 200));
  const grupoId = grp.json?.conversa;
  const detGrp = await API("GET", `/conversations/${grupoId}`, j2.cookie);
  const parteJ2 = detGrp.json?.conversa?.participantes?.find((p) => p.conta?.id === contaJ2);
  t("convidado nasce status=convidado", parteJ2?.status === "convidado", JSON.stringify(parteJ2).slice(0, 160));

  // convidado não envia antes de aceitar
  const msgConvidado = await emitirCb(sJ2, "internet:mensagem:enviar", {
    conversaId: grupoId, contaId: contaJ2, requestId: "req-g0", conteudo: "posso falar?",
  });
  t("convidado não envia antes de aceitar", msgConvidado?.ok === false, JSON.stringify(msgConvidado));

  // O endpoint responder usa :pid = id da LINHA internet_participantes,
  // exposto no detalhe da conversa (lacuna F4 #2 — sem ele o convite de
  // grupo era inalcançável via API pública).
  const pid = detGrp.json?.conversa?.participantes?.find((p) => p.conta?.id === contaJ2)?.id;
  t("linha de participante expõe id via API", !!pid);
  const resp = await API("POST", `/conversations/${grupoId}/participants/${pid}/responder`, j2.cookie, { aceitar: true });
  t("convidado aceita → ativo", resp.status === 200 && resp.json?.status === "ativo", JSON.stringify(resp.json));

  // agora envia no grupo — j2 envia porque a cota de j1 segue esgotada
  const msgGrupo = await emitirCb(sJ2, "internet:mensagem:enviar", {
    conversaId: grupoId, contaId: contaJ2, requestId: "req-g1", conteudo: "grupo ativo",
  });
  t("mensagem de grupo enviada", msgGrupo?.ok === true, JSON.stringify(msgGrupo));

  // P6: dono sai → propriedade vai para o único outro ativo (j2)
  const saiDono = await API("POST", `/conversations/${grupoId}/leave`, j1.cookie, { contaId: contaJ1 });
  t("dono sai do grupo", saiDono.status === 200, `status=${saiDono.status}`);
  const detApos = await API("GET", `/conversations/${grupoId}`, j2.cookie);
  const novoDono = detApos.json?.conversa?.participantes?.find((p) => p.conta?.id === contaJ2);
  t("P6: propriedade transferida ao sucessor elegível", novoDono?.papel === "dono", JSON.stringify(novoDono).slice(0, 160));

  // ================= EXPORT P9 =================
  sec("K. Exportação — P9: nenhuma tabela internet_* sai no pacote");
  {
    const exp = await req(BASE, "GET", `/campaigns/${campId}/exportar`, { cookie: C.cookieMestre });
    const estado = exp.json?.estado ?? exp.json;
    const chaves = estado ? Object.keys(estado) : [];
    t("export da campanha existe", exp.status === 200, `status=${exp.status}`);
    t("export NÃO contém internet_messages", !chaves.some((k) => k.startsWith("internet")), chaves.join(",").slice(0, 300));
    t("export NÃO contém accounts/contacts/conversations/participantes",
      !["internetAccounts", "internetContacts", "internetConversations", "internetParticipantes", "internetMessages"].some((k) => chaves.includes(k)));
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
} catch (e) {
  console.error("ERRO FATAL:", e);
  fail++;
} finally {
  for (const s of sockets) { try { s.close(); } catch {} }
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
process.exit(fail === 0 ? 0 : 1);
