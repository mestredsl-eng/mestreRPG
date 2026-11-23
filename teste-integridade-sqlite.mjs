// #294 — Suíte de invariantes SQLite: FKs, cascatas, ciclo de vida,
// concorrência otimista, exclusão de usuário e reabertura do banco.
// Fixtures 100% sintéticas via teste-base.mjs; INSERTs diretos apenas
// para montar estado que a API ainda não expõe (contas/transações).
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  comDb, encerrarServidor, limparDir, abrirDb, req, criarCenario,
} from "./teste-base.mjs";

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

  // FKs realmente enforced: inserts diretos com pais inexistentes devem falhar
  const w = abrirDb(banco);
  w.pragma("foreign_keys = ON");
  const tentaInsert = (sql, params) => { try { w.prepare(sql).run(...params); return null; } catch (e) { return String(e); } };
  t("FK: characters.campaign_id inexistente rejeitado",
    /FOREIGN KEY/.test(tentaInsert(
      "insert into characters (id,campaign_id,membership_id,name,data,status,created_at,updated_at) values (?,?,?,?,?,?,?,?)",
      [uid(), "camp-inexistente", "memb-inexistente", "x", "{}", "rascunho", agora(), agora()])) ?? "");
  t("FK: character_fields.character_id inexistente rejeitado",
    /FOREIGN KEY/.test(tentaInsert(
      "insert into character_fields (id,character_id,field_key,value,updated_at) values (?,?,?,?,?)",
      [uid(), "char-inexistente", "k", "{}", agora()])) ?? "");
  t("FK: memberships.user_id inexistente rejeitado",
    /FOREIGN KEY/.test(tentaInsert(
      "insert into memberships (id,campaign_id,user_id,role,status,created_at,updated_at) values (?,?,?,?,?,?,?)",
      [uid(), campId, "user-inexistente", "jogador", "ativo", agora(), agora()])) ?? "");
  // negativo real de account_id (FK sem cascade — NO ACTION)
  const txContaRuim = tentaInsert(
    "insert into money_transactions (id,character_id,campaign_id,kind,amount,account_id,created_at) values (?,?,?,?,?,?,?)",
    [uid(), personagemMestre, campId, "ajuste_mestre", 1, "conta-inexistente", agora()]);
  t("FK: money_transactions.account_id inexistente rejeitado (real)", /FOREIGN KEY/.test(txContaRuim ?? ""), txContaRuim ?? "sem erro");
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
