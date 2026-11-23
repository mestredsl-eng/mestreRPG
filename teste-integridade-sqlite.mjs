// #294 — Suíte de invariantes SQLite: FKs, cascatas, ciclo de vida,
// concorrência otimista, exclusão de usuário e reabertura do banco.
// Fixtures 100% sintéticas via teste-base.mjs; INSERTs diretos apenas
// para montar estado que a API ainda não expõe (contas/transações).
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  comDb, encerrarServidor, limparDir, abrirDb, req, criarCenario,
} from "./teste-base.mjs";
import { readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hashSenha } from "./servidor/dist/lib/password.js";
import { sessao } from "./teste-base.mjs";

let pass = 0, fail = 0;
const falhas = [];
function t(nome, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok ${nome}`); }
  else { fail++; falhas.push(nome); console.log(`  FALHOU ${nome} ${extra}`); }
}
const agora = () => Date.now();
const uid = () => crypto.randomUUID();

const dir = dirTeste("integridade294");
const banco = dir + "/teste.db";
const arquivos = dir + "/arquivos";
const backups = dir + "/backups";

await prepararBanco(banco);
const porta = await portaLivre();
const base = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco, arquivos, backups });
try {
  await esperarSaudavel(base, proc);
  const c = await criarCenario(base, banco, { jogadores: { j1: "jogador_1", j2: "jogador_2" } });
  const { cookieMestre, campId, jogadores, adminId, novoPersonagem, personagemMestre } = c;
  const cookieJ1 = jogadores.j1.cookie;

  // templateVersionId do modelo default publicado
  const templateVersionId = comDb(banco, (db) =>
    db.prepare(`select sv.id from sheet_versions sv
      join sheet_templates st on st.current_version_id = sv.id
      where st.campaign_id=? and st.is_default=1`).get(campId).id);

  console.log("\n== A — fundação SQLite ==");
  const fund = comDb(banco, (db) => ({
    jm: db.pragma("journal_mode", { simple: true }),
    ic: db.pragma("integrity_check", { simple: true }),
    fk: db.pragma("foreign_key_check"),
  }));
  t("journal_mode = wal", fund.jm === "wal", fund.jm);
  t("integrity_check = ok", fund.ic === "ok", fund.ic);
  t("foreign_key_check sem violações", fund.fk.length === 0);

  // PRAGMA foreign_keys é POR CONEXÃO, mas o driver better-sqlite3 o
  // liga por padrão em TODA conexão nova (verificado: conexão crua de
  // arquivo retorna 1). Somam-se a isso o PRAGMA explícito do servidor
  // em criarBanco (servidor/src/db/index.ts:21-22). Abaixo provamos a
  // semântica: COM o pragma ligado, o SQLite rejeita inserts órfãos.
  const pragmaCru = comDb(banco, (db) => db.pragma("foreign_keys", { simple: true }));
  t("conexão crua já nasce com foreign_keys=1 (default do driver + criarBanco explícito)",
    pragmaCru === 1, `pragma=${pragmaCru}`);

  // FKs realmente enforced COM pragma ligado: inserts diretos com pais
  // inexistentes devem falhar — um FK por assert para identificar qual rejeitou.
  const w = abrirDb(banco);
  w.pragma("foreign_keys = ON");
  const tentaInsert = (sql, params) => { try { w.prepare(sql).run(...params); return null; } catch (e) { return String(e); } };
  t("FK: characters.campaign_id inexistente rejeitado (pragma ON)",
    /FOREIGN KEY/.test(tentaInsert(
      "insert into characters (id,campaign_id,membership_id,name,data,status,created_at,updated_at) values (?,?,?,?,?,?,?,?)",
      [uid(), "camp-inexistente", c.membMestre, "x", "{}", "rascunho", agora(), agora()])) ?? "");
  t("FK: characters.membership_id inexistente rejeitado (pragma ON)",
    /FOREIGN KEY/.test(tentaInsert(
      "insert into characters (id,campaign_id,membership_id,name,data,status,created_at,updated_at) values (?,?,?,?,?,?,?,?)",
      [uid(), campId, "memb-inexistente", "x", "{}", "rascunho", agora(), agora()])) ?? "");
  t("FK: character_fields.character_id inexistente rejeitado (pragma ON)",
    /FOREIGN KEY/.test(tentaInsert(
      "insert into character_fields (id,character_id,field_key,value,updated_at) values (?,?,?,?,?)",
      [uid(), "char-inexistente", "k", "{}", agora()])) ?? "");
  t("FK: memberships.user_id inexistente rejeitado (pragma ON)",
    /FOREIGN KEY/.test(tentaInsert(
      "insert into memberships (id,campaign_id,user_id,role,status,created_at,updated_at) values (?,?,?,?,?,?,?)",
      [uid(), campId, "user-inexistente", "jogador", "ativo", agora(), agora()])) ?? "");
  // negativo real de account_id (FK sem cascade — NO ACTION)
  const txContaRuim = tentaInsert(
    "insert into money_transactions (id,character_id,campaign_id,kind,amount,account_id,created_at) values (?,?,?,?,?,?,?)",
    [uid(), personagemMestre, campId, "ajuste_mestre", 1, "conta-inexistente", agora()]);
  t("FK: money_transactions.account_id inexistente rejeitado (pragma ON)", /FOREIGN KEY/.test(txContaRuim ?? ""), txContaRuim ?? "sem erro");
  // conexão `w` segue aberta para os INSERTs de fixture da seção B

  console.log("\n== B — ciclo de vida do personagem (API + cascata) ==");
  // Personagem criado via API pelo jogador 1
  const criado = await req(base, "POST", `/campaigns/${campId}/characters`, {
    cookie: cookieJ1,
    body: { name: "Herói API", templateVersionId, data: { for: 5 } },
  });
  t("POST /characters cria personagem (jogador)", criado.status === 200 || criado.status === 201, `status=${criado.status} ${JSON.stringify(criado.json)?.slice(0, 120)}`);
  const charApi = criado.json?.personagem?.id ?? criado.json?.id;
  const charB = novoPersonagem(jogadores.j2.membershipId, "Alvo Cascata");

  // Filhas diretas para provar cascata no delete
  w.prepare("insert into character_fields (id,character_id,field_key,value,updated_at) values (?,?,?,?,?)")
    .run(uid(), charApi, "campo_extra", "{}", agora());
  w.prepare("insert into inventory_entries (id,character_id,name,quantity,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
    .run(uid(), charApi, "Item teste", 1, "{}", agora(), agora());
  w.prepare("insert into vehicles (id,character_id,campaign_id,name,data,created_at,updated_at) values (?,?,?,?,?,?,?)")
    .run(uid(), charApi, campId, "Carro", "{}", agora(), agora());
  // Conta + transação de B apontando contrapartida para A (NÃO pode ser do próprio A,
  // senão o delete bloqueia por historico_financeiro)
  const contaB = uid(), txB = uid();
  w.prepare("insert into financial_accounts (id,character_id,campaign_id,type,name,balance_cents,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(contaB, charB, campId, "especie", "Carteira", 0, "{}", agora(), agora());
  w.prepare("insert into money_transactions (id,character_id,campaign_id,kind,amount,account_id,counterparty_character_id,created_at) values (?,?,?,?,?,?,?,?)")
    .run(txB, charB, campId, "transferencia", 10, contaB, charApi, agora());

  // Bloqueios de exclusão por histórico financeiro (política fail-closed):
  // C = conta do personagem referenciada por tx de TERCEIRO → conta_referenciada
  // D = personagem com tx PRÓPRIA → historico_financeiro
  const charC = novoPersonagem(jogadores.j1.membershipId, "Com Conta Referenciada");
  const charD = novoPersonagem(jogadores.j1.membershipId, "Com Historico Proprio");
  const contaC = uid(), txC = uid(), txD = uid();
  w.prepare("insert into financial_accounts (id,character_id,campaign_id,type,name,balance_cents,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(contaC, charC, campId, "banco", "Conta C", 0, "{}", agora(), agora());
  w.prepare("insert into money_transactions (id,character_id,campaign_id,kind,amount,account_id,created_at) values (?,?,?,?,?,?,?)")
    .run(txC, charB, campId, "transferencia", 5, contaC, agora());
  w.prepare("insert into money_transactions (id,character_id,campaign_id,kind,amount,created_at) values (?,?,?,?,?,?)")
    .run(txD, charD, campId, "ajuste_mestre", 1, agora());

  // Concorrência: PATCHes paralelos nunca corrompem — todo mundo 200
  // (serialização WAL) ou 409; o valor final é um dos enviados.
  const [p1, p2] = await Promise.all([
    req(base, "PATCH", `/campaigns/${campId}/characters/${charApi}`, { cookie: cookieJ1, body: { data: { for: 6 } } }),
    req(base, "PATCH", `/campaigns/${campId}/characters/${charApi}`, { cookie: cookieJ1, body: { data: { for: 7 } } }),
  ]);
  const statusesPar = [p1.status, p2.status];
  t("PATCHes paralelos: nenhum 5xx nem escrita parcial",
    statusesPar.every((s) => s === 200 || s === 409) && statusesPar.includes(200),
    `status=${statusesPar.join(",")}`);
  const depois = comDb(banco, (db) => JSON.parse(db.prepare("select data from characters where id=?").get(charApi).data));
  t("valor persistido é um dos enviados (sem lost update/corrupção)",
    depois.for === 6 || depois.for === 7, `db.for=${depois.for}`);

  // Concorrência otimista determinística (BUG_0002): campo com nível
  // financiado por XP exige baseUpdatedAt do snapshot carregado.
  // Marcador __xp.financiado é o mesmo gravado por lib/progressao.ts.
  const wXp = abrirDb(banco);
  const dadosXp = JSON.parse(comDb(banco, (db) => db.prepare("select data from characters where id=?").get(charApi).data));
  dadosXp.__xp = { financiado: { for: { 7: true } } };
  wXp.prepare("update characters set data=? where id=?").run(JSON.stringify(dadosXp), charApi);
  wXp.close();
  const patchSemToken = await req(base, "PATCH", `/campaigns/${campId}/characters/${charApi}`, {
    cookie: cookieJ1, body: { data: { for: 9 } },
  });
  t("PATCH em campo financiado por XP sem baseUpdatedAt → 409",
    patchSemToken.status === 409, `status=${patchSemToken.status}`);
  const patchTokenVelho = await req(base, "PATCH", `/campaigns/${campId}/characters/${charApi}`, {
    cookie: cookieJ1, body: { data: { for: 9 }, baseUpdatedAt: "2000-01-01T00:00:00.000Z" },
  });
  t("PATCH com baseUpdatedAt velho → 409",
    patchTokenVelho.status === 409, `status=${patchTokenVelho.status}`);
  const fichaAtual = await req(base, "GET", `/campaigns/${campId}/characters/${charApi}`, { cookie: cookieJ1 });
  const isoAtual = fichaAtual.json?.personagem?.updatedAt;
  const patchComToken = await req(base, "PATCH", `/campaigns/${campId}/characters/${charApi}`, {
    cookie: cookieJ1, body: { data: { for: 9 }, baseUpdatedAt: isoAtual },
  });
  t("PATCH com baseUpdatedAt correto → 200 (token libera)",
    patchComToken.status === 200, `status=${patchComToken.status} updatedAt=${isoAtual}`);

  // Delete pelo mestre → cascata remove filhas; contraparte de B é desvinculada
  const del = await req(base, "DELETE", `/campaigns/${campId}/characters/${charApi}`, { cookie: cookieMestre });
  t("DELETE personagem (mestre) → 200", del.status === 200, `status=${del.status} ${JSON.stringify(del.json)?.slice(0, 100)}`);
  const pos = comDb(banco, (db) => ({
    char: db.prepare("select count(*) n from characters where id=?").get(charApi).n,
    fields: db.prepare("select count(*) n from character_fields where character_id=?").get(charApi).n,
    inv: db.prepare("select count(*) n from inventory_entries where character_id=?").get(charApi).n,
    veic: db.prepare("select count(*) n from vehicles where character_id=?").get(charApi).n,
    txB: db.prepare("select counterparty_character_id cp from money_transactions where id=?").get(txB),
    contaB: db.prepare("select count(*) n from financial_accounts where id=?").get(contaB).n,
  }));
  t("cascata: characters removido", pos.char === 0);
  t("cascata: character_fields removidos", pos.fields === 0);
  t("cascata: inventory_entries removidos", pos.inv === 0);
  t("cascata: vehicles removidos", pos.veic === 0);
  t("contraparte preservada: tx de B mantida com counterparty=NULL",
    pos.txB && pos.txB.cp === null && pos.contaB === 1);
  t("integrity_check ok após delete em cascata", comDb(banco, (db) => db.pragma("integrity_check", { simple: true })) === "ok");
  const del2 = await req(base, "DELETE", `/campaigns/${campId}/characters/${charApi}`, { cookie: cookieMestre });
  t("DELETE repetido → 404", del2.status === 404, `status=${del2.status}`);

  // Conta do personagem referenciada por tx de terceiro → bloqueio limpo
  const delC = await req(base, "DELETE", `/campaigns/${campId}/characters/${charC}`, { cookie: cookieMestre });
  t("DELETE personagem com conta referenciada por terceiro → 409 conta_referenciada",
    delC.status === 409 && delC.json?.codigo === "conta_referenciada",
    `status=${delC.status} codigo=${delC.json?.codigo}`);
  const intactoC = comDb(banco, (db) => ({
    char: db.prepare("select count(*) n from characters where id=?").get(charC).n,
    conta: db.prepare("select count(*) n from financial_accounts where id=?").get(contaC).n,
    tx: db.prepare("select count(*) n from money_transactions where id=?").get(txC).n,
  }));
  t("após 409 conta_referenciada nada foi apagado (char+conta+tx intactos)",
    intactoC.char === 1 && intactoC.conta === 1 && intactoC.tx === 1);

  // Personagem com transação financeira própria → bloqueio limpo
  const delD = await req(base, "DELETE", `/campaigns/${campId}/characters/${charD}`, { cookie: cookieMestre });
  t("DELETE personagem com histórico financeiro próprio → 409 historico_financeiro",
    delD.status === 409 && delD.json?.codigo === "historico_financeiro",
    `status=${delD.status} codigo=${delD.json?.codigo}`);
  t("após 409 historico_financeiro personagem permanece",
    comDb(banco, (db) => db.prepare("select count(*) n from characters where id=?").get(charD).n) === 1);
  w.close();

  console.log("\n== C — exclusão de usuário (política e FK) ==");
  // Dono de campanha não pode ser excluído (FK NO ACTION → 409 limpo)
  const j2 = jogadores.j2;
  const charJ2 = novoPersonagem(j2.membershipId, "Personagem do J2");
  const w3 = abrirDb(banco);
  w3.prepare("update campaigns set owner_id=? where id=?").run(j2.id, campId);
  const delDono = await req(base, "DELETE", `/admin/users/${j2.id}`, { cookie: cookieMestre });
  t("DELETE usuário dono de campanha → 409 (FK fail-closed, não 500)",
    delDono.status === 409, `status=${delDono.status} ${JSON.stringify(delDono.json)?.slice(0, 120)}`);
  const intacto = comDb(banco, (db) => ({
    user: db.prepare("select count(*) n from users where id=?").get(j2.id).n,
    camp: db.prepare("select count(*) n from campaigns where id=?").get(campId).n,
    char: db.prepare("select count(*) n from characters where id=?").get(charJ2).n,
  }));
  t("após 409 nada foi apagado (user+campanha+personagem intactos)",
    intacto.user === 1 && intacto.camp === 1 && intacto.char === 1);
  w3.prepare("update campaigns set owner_id=? where id=?").run(adminId, campId);
  w3.close();

  // Usuário comum com personagem: memberships/characters têm cascade no user_id?
  // memberships.user_id cascade → membership some → characters.membership_id cascade → personagem some.
  const delJ2 = await req(base, "DELETE", `/admin/users/${j2.id}`, { cookie: cookieMestre });
  t("DELETE usuário comum → 200", delJ2.status === 200, `status=${delJ2.status}`);
  const posJ2 = comDb(banco, (db) => ({
    user: db.prepare("select count(*) n from users where id=?").get(j2.id).n,
    memb: db.prepare("select count(*) n from memberships where user_id=?").get(j2.id).n,
    char: db.prepare("select count(*) n from characters where id=?").get(charJ2).n,
    sess: db.prepare("select count(*) n from auth_sessions where user_id=?").get(j2.id).n,
  }));
  t("user+sessões+membership removidos", posJ2.user === 0 && posJ2.memb === 0 && posJ2.sess === 0);
  // REGISTRO DE COMPORTAMENTO: personagem do jogador removido em cascata junto
  // com a conta — a campanha perde o personagem. Documentado como achado #294
  // (política de retenção a decidir: personagem pertence à campanha ou à conta?).
  t("comportamento observado: personagem do usuário excluído em cascata (achado p/ política)",
    posJ2.char === 0, `char=${posJ2.char}`);
  t("campanha e personagem do mestre preservados",
    comDb(banco, (db) => db.prepare("select count(*) n from campaigns where id=?").get(campId).n) === 1 &&
    comDb(banco, (db) => db.prepare("select count(*) n from characters where id=?").get(personagemMestre).n) === 1);

  const delSelf = await req(base, "DELETE", `/admin/users/${adminId}`, { cookie: cookieMestre });
  t("DELETE própria conta → 400", delSelf.status === 400, `status=${delSelf.status}`);
  const delInex = await req(base, "DELETE", `/admin/users/usuario-inexistente`, { cookie: cookieMestre });
  t("DELETE usuário inexistente → 404", delInex.status === 404, `status=${delInex.status}`);

  console.log("\n== D — invariantes estruturais (varredura) ==");
  const inv = comDb(banco, (db) => {
    const q = (sql) => db.prepare(sql).get();
    return {
      campanhaSemMestre: q(`select count(*) n from campaigns c
        where not exists (select 1 from memberships m
          where m.campaign_id=c.id and m.role='mestre' and m.status='ativo')`).n,
      charCampErrado: q(`select count(*) n from characters ch
        join memberships m on m.id=ch.membership_id
        where m.campaign_id<>ch.campaign_id`).n,
      tplVersaoOrfa: q(`select count(*) n from sheet_templates st
        where st.current_version_id is not null
          and not exists (select 1 from sheet_versions sv where sv.id=st.current_version_id)`).n,
      charVersaoOrfa: q(`select count(*) n from characters ch
        where ch.template_version_id is not null
          and not exists (select 1 from sheet_versions sv where sv.id=ch.template_version_id)`).n,
      txCampErrada: q(`select count(*) n from money_transactions mt
        join characters ch on ch.id=mt.character_id
        where ch.campaign_id<>mt.campaign_id`).n,
      membDuplicada: q(`select count(*) n from (
          select campaign_id,user_id,count(*) n from memberships
          where status='ativo' group by 1,2 having n>1)`).n,
    };
  });
  t("toda campanha tem ≥1 mestre ativo (invariante anti-órfão)", inv.campanhaSemMestre === 0, `n=${inv.campanhaSemMestre}`);
  t("nenhum personagem vinculado a membership de outra campanha", inv.charCampErrado === 0);
  t("nenhum template aponta versão inexistente", inv.tplVersaoOrfa === 0);
  t("nenhum personagem aponta versão de ficha inexistente", inv.charVersaoOrfa === 0);
  t("nenhuma transação financeira com campanha divergente do personagem", inv.txCampErrada === 0);
  t("nenhuma membership duplicada ativa (mesma campanha+usuário)", inv.membDuplicada === 0);

  console.log("\n== F — fault injection multi-tabela (triggers na fixture descartável) ==");
  // Prova de atomicidade conforme matriz do Dono (7095005053): triggers
  // BEFORE INSERT/UPDATE abortam a SEGUNDA escrita de cada caminho.
  // Nenhuma alteração de produção — triggers vivem só neste banco de teste
  // e são derrubadas ao fim de cada cenário. Os asserts registram o
  // comportamento OBSERVADO (defeito documentado), não o ideal.
  const wf = abrirDb(banco);
  const dispara = (nome, sqlTrigger) => wf.exec(`DROP TRIGGER IF EXISTS ${nome};\n${sqlTrigger}`);
  const derruba = (nome) => wf.exec(`DROP TRIGGER IF EXISTS ${nome}`);
  const conta = (sqlQ, ...p) => wf.prepare(sqlQ).get(...p).n;

  // ---- F1: POST /campaigns — campaigns + memberships sem transação ----
  dispara("f1_memb", `CREATE TRIGGER f1_memb BEFORE INSERT ON memberships
    WHEN NEW.campaign_id IN (SELECT id FROM campaigns WHERE name='F1-INJETADO')
    BEGIN SELECT RAISE(ABORT,'F1_INJETADO'); END`);
  const rF1 = await req(base, "POST", "/campaigns", { cookie: cookieMestre, body: { name: "F1-INJETADO" } });
  derruba("f1_memb");
  const orfF1 = {
    camp: conta("select count(*) n from campaigns where name='F1-INJETADO'"),
    memb: conta(`select count(*) n from memberships m join campaigns c on c.id=m.campaign_id where c.name='F1-INJETADO'`),
  };
  t("F1: falha no insert de membership → API responde erro controlado (não 2xx)",
    rF1.status >= 400, `status=${rF1.status}`);
  t("F1 observado: campanha persistiu SEM membership (órfão irrecuperável — defeito documentado)",
    orfF1.camp === 1 && orfF1.memb === 0, JSON.stringify(orfF1));
  wf.prepare("delete from campaigns where name='F1-INJETADO'").run(); // limpeza do órfão

  // ---- F2a: criação de modelo — template + version + currentVersionId ----
  dispara("f2a_ver", `CREATE TRIGGER f2a_ver BEFORE INSERT ON sheet_versions
    WHEN NEW.template_id IN (SELECT id FROM sheet_templates WHERE name='F2A-TPL')
    BEGIN SELECT RAISE(ABORT,'F2A'); END`);
  const rF2a = await req(base, "POST", `/campaigns/${campId}/sheet-templates`, { cookie: cookieMestre, body: { name: "F2A-TPL" } });
  derruba("f2a_ver");
  const orfF2a = {
    tpl: conta("select count(*) n from sheet_templates where name='F2A-TPL'"),
    ver: conta(`select count(*) n from sheet_versions sv join sheet_templates st on st.id=sv.template_id where st.name='F2A-TPL'`),
    cur: wf.prepare("select current_version_id from sheet_templates where name='F2A-TPL'").get()?.current_version_id ?? null,
  };
  t("F2a: falha no insert de versão → API responde erro", rF2a.status >= 400, `status=${rF2a.status}`);
  t("F2a observado: template órfão sem versão/currentVersionId (defeito documentado)",
    orfF2a.tpl === 1 && orfF2a.ver === 0 && orfF2a.cur === null, JSON.stringify(orfF2a));
  wf.prepare("delete from sheet_templates where name='F2A-TPL'").run();

  // ---- F2b: nova versão — version insert ok, currentVersionId update aborta ----
  const tplB = await req(base, "POST", `/campaigns/${campId}/sheet-templates`, { cookie: cookieMestre, body: { name: "F2B-TPL" } });
  const tplBId = tplB.json?.modelo?.id;
  const curB0 = wf.prepare("select current_version_id from sheet_templates where id=?").get(tplBId)?.current_version_id;
  dispara("f2b_cur", `CREATE TRIGGER f2b_cur BEFORE UPDATE OF current_version_id ON sheet_templates
    WHEN NEW.id='${tplBId}' BEGIN SELECT RAISE(ABORT,'F2B'); END`);
  const rF2b = await req(base, "POST", `/campaigns/${campId}/sheet-templates/${tplBId}/versions`, { cookie: cookieMestre, body: {} });
  derruba("f2b_cur");
  const orfF2b = {
    vers: conta("select count(*) n from sheet_versions where template_id=?", tplBId),
    cur: wf.prepare("select current_version_id from sheet_templates where id=?").get(tplBId)?.current_version_id,
  };
  t("F2b: falha no update de currentVersionId → API responde erro", rF2b.status >= 400, `status=${rF2b.status}`);
  t("F2b observado: versão órfã criada e currentVersionId NÃO avançou (defeito documentado)",
    orfF2b.vers === 2 && orfF2b.cur === curB0, JSON.stringify({ ...orfF2b, curB0 }));

  // ---- F2c: publish — publishedAt grava, currentVersionId aborta ----
  const tplC = await req(base, "POST", `/campaigns/${campId}/sheet-templates`, { cookie: cookieMestre, body: { name: "F2C-TPL" } });
  const tplCId = tplC.json?.modelo?.id;
  const v1C = tplC.json?.modelo?.versionId;
  const v2C = (await req(base, "POST", `/campaigns/${campId}/sheet-templates/${tplCId}/versions`, { cookie: cookieMestre, body: {} })).json?.versionId;
  dispara("f2c_cur", `CREATE TRIGGER f2c_cur BEFORE UPDATE ON sheet_templates
    WHEN NEW.id='${tplCId}' AND NEW.current_version_id<>OLD.current_version_id
    BEGIN SELECT RAISE(ABORT,'F2C'); END`);
  const rF2c = await req(base, "POST", `/campaigns/${campId}/sheet-templates/${tplCId}/publish`, { cookie: cookieMestre, body: { versionId: v1C } });
  derruba("f2c_cur");
  const pubC = {
    v1pub: wf.prepare("select published_at from sheet_versions where id=?").get(v1C)?.published_at ?? null,
    cur: wf.prepare("select current_version_id from sheet_templates where id=?").get(tplCId)?.current_version_id,
  };
  t("F2c: falha no publish → API responde erro", rF2c.status >= 400, `status=${rF2c.status}`);
  t("F2c observado: v1 ficou publishedAt mas currentVersionId seguiu v2 (inconsistência documentada)",
    pubC.v1pub !== null && pubC.cur === v2C, JSON.stringify({ ...pubC, v1C, v2C }));

  // ---- F4a: troca de modelo padrão — limpar default + set default sem tx ----
  // PATCH isDefault:true faz UPDATE is_default=0 nos demais e depois UPDATE
  // is_default=1 no alvo. Injetar falha no SEGUNDO update deve deixar o
  // default anterior intacto; sem tx, o primeiro update já commitou.
  const tplD1 = (await req(base, "POST", `/campaigns/${campId}/sheet-templates`, { cookie: cookieMestre, body: { name: "F4-D1" } })).json?.modelo?.id;
  const tplD2 = (await req(base, "POST", `/campaigns/${campId}/sheet-templates`, { cookie: cookieMestre, body: { name: "F4-D2" } })).json?.modelo?.id;
  await req(base, "PATCH", `/campaigns/${campId}/sheet-templates/${tplD1}`, { cookie: cookieMestre, body: { isDefault: true } });
  const defaultsAntes = conta("select count(*) n from sheet_templates where campaign_id=? and is_default=1", campId);
  dispara("f4_def", `CREATE TRIGGER f4_def BEFORE UPDATE ON sheet_templates
    WHEN NEW.id='${tplD2}' AND NEW.is_default=1
    BEGIN SELECT RAISE(ABORT,'F4'); END`);
  const rF4a = await req(base, "PATCH", `/campaigns/${campId}/sheet-templates/${tplD2}`, { cookie: cookieMestre, body: { isDefault: true } });
  derruba("f4_def");
  const defaultsDepois = {
    total: conta("select count(*) n from sheet_templates where campaign_id=? and is_default=1", campId),
    d1: wf.prepare("select is_default from sheet_templates where id=?").get(tplD1)?.is_default,
    d2: wf.prepare("select is_default from sheet_templates where id=?").get(tplD2)?.is_default,
  };
  t("F4a: falha no 2º update de default → API responde erro", rF4a.status >= 400, `status=${rF4a.status}`);
  t("F4a observado: ZERO defaults após falha (default anterior perdido — defeito documentado)",
    defaultsDepois.total === 0, JSON.stringify({ antes: defaultsAntes, ...defaultsDepois }));
  // restaura default de D1 para os próximos cenários
  wf.prepare("update sheet_templates set is_default=1 where id=?").run(tplD1);

  // ---- F4b: duas trocas de default concorrentes → exatamente um vencedor ----
  const tplE1 = (await req(base, "POST", `/campaigns/${campId}/sheet-templates`, { cookie: cookieMestre, body: { name: "F4-E1" } })).json?.modelo?.id;
  const tplE2 = (await req(base, "POST", `/campaigns/${campId}/sheet-templates`, { cookie: cookieMestre, body: { name: "F4-E2" } })).json?.modelo?.id;
  const [e1, e2] = await Promise.all([
    req(base, "PATCH", `/campaigns/${campId}/sheet-templates/${tplE1}`, { cookie: cookieMestre, body: { isDefault: true } }),
    req(base, "PATCH", `/campaigns/${campId}/sheet-templates/${tplE2}`, { cookie: cookieMestre, body: { isDefault: true } }),
  ]);
  const defaultsF4b = conta("select count(*) n from sheet_templates where campaign_id=? and is_default=1", campId);
  t("F4b: defaults concorrentes → exatamente 1 is_default=1 ao final",
    defaultsF4b === 1, `e1=${e1.status} e2=${e2.status} defaults=${defaultsF4b}`);

  // ---- F5: PUT de estrutura vs publicação (TOCTOU) — SEM SEAM, documentado ----
  // O handler faz SELECT+check de publishedAt e UPDATE em sequência síncrona;
  // não há hook NODE_ENV=test para pausar entre eles. Prova determinística
  // fica BLOCKED até seam de teste ou correção (UPDATE condicional
  // publishedAt IS NULL). Registrado como pendente, não como cobertura.
  console.log("  .. F5 BLOCKED: PUT×publish TOCTOU exige seam de pausa entre check e update — sem hook de teste em produção");

  // ---- F3: upload + vínculo a anotação — files ok, note_attachments aborta ----
  const notaF3 = await req(base, "POST", `/campaigns/${campId}/anotacoes`, {
    cookie: cookieMestre, body: { title: "Nota F3", kind: "diario", visibility: "privada" },
  });
  const noteF3 = notaF3.json?.id;
  dispara("f3_anx", `CREATE TRIGGER f3_anx BEFORE INSERT ON note_attachments
    WHEN NEW.note_id='${noteF3}' BEGIN SELECT RAISE(ABORT,'F3'); END`);
  const bufF3 = Buffer.from("conteudo fault-injection f3");
  const upF3 = await fetch(`${base}/api/campaigns/${campId}/arquivos/upload`, {
    method: "POST",
    headers: { cookie: cookieMestre, "x-file-name": "f3.txt", "x-note-id": noteF3, "content-type": "application/octet-stream" },
    body: bufF3,
  });
  const stF3 = upF3.status;
  derruba("f3_anx");
  const fileRowF3 = wf.prepare("select id, storage_name from files where campaign_id=? order by created_at desc limit 1").get(campId);
  const anxF3 = conta("select count(*) n from note_attachments where note_id=?", noteF3);
  const fisicoF3 = fileRowF3 ? existsSync(join(arquivos, campId, fileRowF3.storage_name)) : false;
  t("F3: falha no vínculo à anotação → API responde erro (não 201)", stF3 !== 201, `status=${stF3}`);
  t("F3 observado: files+arquivo físico órfãos sem note_attachments (defeito documentado)",
    !!fileRowF3 && anxF3 === 0 && fisicoF3,
    `file=${fileRowF3?.id} anx=${anxF3} fisico=${fisicoF3}`);
  // caminho feliz após remover o trigger: novo upload vincula corretamente
  const upOk = await fetch(`${base}/api/campaigns/${campId}/arquivos/upload`, {
    method: "POST",
    headers: { cookie: cookieMestre, "x-file-name": "f3-ok.txt", "x-note-id": noteF3, "content-type": "application/octet-stream" },
    body: Buffer.from("conteudo feliz"),
  });
  t("F3 caminho feliz pós-trigger: upload vinculado → 201", upOk.status === 201, `status=${upOk.status}`);
  // limpeza dos órfãos F3 (files row + físico)
  if (fileRowF3) {
    wf.prepare("delete from files where id=?").run(fileRowF3.id);
    try { rmSync(join(arquivos, campId, fileRowF3.storage_name), { force: true }); } catch { }
  }
  wf.close();

  // ---- F6: autorização cross-campaign em sheet-templates (achado Dono 7099324006) ----
  // requirePapel("mestre") prova mestria do campaignId do CAMINHO, não do
  // templateId do recurso. PUT .../versions/:versionId e POST .../publish
  // selecionam a versão só por versionId+templateId — sem escopo
  // campaign_id no template pai (modelos.ts). Ataque: mestre da campanha B
  // (membro SOMENTE de B) usa IDs de template/versão da campanha A na rota
  // de B. Contrato exigido pós-correção: 404 + recurso de A intacto.
  const wF6 = abrirDb(banco);
  const uidB = uid(), agoraF6 = agora();
  wF6.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
    .run(uidB, "mestre_b_f6", "Mestre B F6", await hashSenha("senha-jogador-123"), agoraF6, agoraF6);
  const camp2 = await req(base, "POST", "/campaigns", { cookie: cookieMestre, body: { name: "Campanha F6 B" } });
  const camp2Id = camp2.json?.campanha?.id;
  wF6.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'mestre','ativo',?,?,?)")
    .run(uid(), camp2Id, uidB, agoraF6, agoraF6, agoraF6);
  wF6.close();
  const cookieMestreB = sessao(banco, uidB);

  // template + versão de RASCUNHO na campanha A (o default publicado não serve:
  // PUT em versão publicada retorna 409 por imutabilidade, não por escopo)
  const tplA6 = comDb(banco, (db) =>
    db.prepare("select id from sheet_templates where campaign_id=? and is_default=1").get(campId).id);
  const verA6 = (await req(base, "POST", `/campaigns/${campId}/sheet-templates/${tplA6}/versions`, { cookie: cookieMestre, body: {} })).json?.versionId;
  const estruturaA6Antes = JSON.stringify(comDb(banco, (db) =>
    db.prepare("select structure from sheet_versions where id=?").get(verA6).structure));
  const curA6Antes = comDb(banco, (db) =>
    db.prepare("select current_version_id from sheet_templates where id=?").get(tplA6).current_version_id);

  // ATAQUE 1 — PUT de estrutura usando a rota da campanha B sobre recurso de A
  const atkPut = await req(base, "PUT", `/campaigns/${camp2Id}/sheet-templates/${tplA6}/versions/${verA6}`, {
    cookie: cookieMestreB,
    // estrutura DIFERENTE da atual (a versão draft herda a estrutura vazia
    // do template default tplD1 — payload vazio seria idêntico e o assert
    // de mutação não observaria nada)
    body: { estrutura: { secoes: [{ id: "sF6", titulo: "SecaoF6", ordem: 0, campos: [{ id: "f6", label: "F6", tipo: "inteiro", semantico: "atributo" }] }], pontos: { habilitado: false } } },
  });
  // ATAQUE 2 — publish usando a rota da campanha B sobre recurso de A
  const atkPub = await req(base, "POST", `/campaigns/${camp2Id}/sheet-templates/${tplA6}/publish`, {
    cookie: cookieMestreB, body: { versionId: verA6 },
  });

  const estruturaA6Depois = JSON.stringify(comDb(banco, (db) =>
    db.prepare("select structure from sheet_versions where id=?").get(verA6).structure));
  const curA6Depois = comDb(banco, (db) =>
    db.prepare("select current_version_id from sheet_templates where id=?").get(tplA6).current_version_id);
  const pubA6 = comDb(banco, (db) =>
    db.prepare("select published_at from sheet_versions where id=?").get(verA6).published_at ?? null);

  t("F6 PUT cross-campaign: API respondeu (status registrado)", [200, 201, 400, 403, 404].includes(atkPut.status), `status=${atkPut.status}`);
  t("F6 publish cross-campaign: API respondeu (status registrado)", [200, 201, 400, 403, 404].includes(atkPub.status), `status=${atkPub.status}`);
  t("F6 observado: mestre de B mutou estrutura de versão de A via rota de B (defeito documentado — contrato exige 404)",
    atkPut.status === 200 && estruturaA6Depois !== estruturaA6Antes,
    `put=${atkPut.status} estruturaMudou=${estruturaA6Depois !== estruturaA6Antes}`);
  t("F6 observado: publish de A via rota de B gravou publishedAt/currentVersionId (defeito documentado)",
    atkPub.status === 200 && !!pubA6 && curA6Depois === verA6,
    `pub=${atkPub.status} publishedAt=${pubA6} cur=${curA6Depois===verA6}`);

  // controle positivo: mestre B opera template da PRÓPRIA campanha B
  const tplB6 = (await req(base, "POST", `/campaigns/${camp2Id}/sheet-templates`, { cookie: cookieMestreB, body: { name: "F6-Own" } })).json?.modelo?.id;
  const verB6 = (await req(base, "POST", `/campaigns/${camp2Id}/sheet-templates/${tplB6}/versions`, { cookie: cookieMestreB, body: {} })).json?.versionId;
  const okB6 = await req(base, "PUT", `/campaigns/${camp2Id}/sheet-templates/${tplB6}/versions/${verB6}`, {
    cookie: cookieMestreB, body: { estrutura: { secoes: [], pontos: { habilitado: false } } },
  });
  t("F6 controle: mestre B edita rascunho da própria campanha → 200", okB6.status === 200, `status=${okB6.status}`);

  // F3b (nota, sem teste executável): storage_name = `${uuid}.${ext}` é
  // gerado por upload — colisão com arquivo preexistente não é forçável
  // via API. A exigência `wx`/prova de posse é contrato do patch futuro
  // de compensação (Dono 7099324006), não defeito observável hoje.

  console.log("\n== E — reabertura do banco ==");
  const antes = comDb(banco, (db) => ({
    users: db.prepare("select count(*) n from users").get().n,
    chars: db.prepare("select count(*) n from characters").get().n,
    tx: db.prepare("select count(*) n from money_transactions").get().n,
  }));
  await encerrarServidor(proc);
  // Reabre conexão nova sobre o mesmo arquivo (simula restart)
  const w2 = abrirDb(banco);
  const reaberto = {
    ic: w2.pragma("integrity_check", { simple: true }),
    jm: w2.pragma("journal_mode", { simple: true }),
    users: w2.prepare("select count(*) n from users").get().n,
    chars: w2.prepare("select count(*) n from characters").get().n,
    tx: w2.prepare("select count(*) n from money_transactions").get().n,
  };
  w2.close();
  t("integrity_check ok após reabrir o arquivo", reaberto.ic === "ok", reaberto.ic);
  t("journal_mode wal persistido", reaberto.jm === "wal", reaberto.jm);
  t("contagens estáveis após restart (users/chars/tx)",
    reaberto.users === antes.users && reaberto.chars === antes.chars && reaberto.tx === antes.tx,
    `${JSON.stringify(antes)} → ${JSON.stringify(reaberto)}`);

} finally {
  try { await encerrarServidor(proc); } catch { }
  limparDir(dir);
}

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail) { console.log("Falhas:", falhas.join(" | ")); process.exit(1); }
