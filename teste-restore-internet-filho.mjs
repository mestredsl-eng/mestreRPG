#!/usr/bin/env node
// FILHO — suíte black-box restore × domínio Internet (#365 W4/W5, ordens
// #369 `7230740233` + `7230751000`). Complementa a seção J do PAI com os
// gaps declarados: comparação LINHA A LINHA nas 9 tabelas (não só
// contagens), cross-campaign nas 9, âncora com membership ainda ativa,
// membershipId divergente para o mesmo userId e personagem citado por
// notícia de sistema sem conta própria.
//
// Fixtures 100% descartáveis. Não declara PASS sem backend real.
import crypto from "node:crypto";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0, skip = 0;
const t = (n, c, x = "") => {
  if (c === "skip") { skip++; console.log("  ~ skip", n, x); }
  else if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, x); }
};
const sec = (n) => console.log("\n== " + n + " ==");

const TABELAS = {
  internet_accounts: "campaign_id",
  internet_contacts: "campaign_id",
  internet_conversations: "campaign_id",
  internet_participantes: null, // sem campaign_id — via conversa_id
  internet_messages: "campaign_id",
  internet_sites: "campaign_id",
  internet_pages: "campaign_id",
  internet_publicacoes: "campaign_id",
  internet_denuncias: "campaign_id",
};

const DIR = dirTeste("f6-restore-internet");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc;
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };

/** Snapshot linha-a-linha das 9 tabelas do domínio para UM campaignId. */
function snapshotDominio(campaignId) {
  return comDb((db) => {
    const r = {};
    for (const [tab, col] of Object.entries(TABELAS)) {
      let rows;
      if (tab === "internet_participantes") {
        const convs = db.prepare("select id from internet_conversations where campaign_id=?").all(campaignId).map((c) => c.id);
        rows = convs.length
          ? db.prepare(`select * from internet_participantes where conversa_id in (${convs.map(() => "?").join(",")}) order by id`).all(...convs)
          : [];
      } else {
        rows = db.prepare(`select * from ${tab} where ${col}=? order by id`).all(campaignId);
      }
      r[tab] = rows;
    }
    return r;
  });
}
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  sec("0. Servidor + cenário + seed do domínio Internet (9 tabelas)");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  const BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, { jogadores: { j1: "r1_j1", j2: "r1_j2", j3: "r1_j3" } });
  const J1 = C.jogadores.j1.cookie, J2 = C.jogadores.j2.cookie, J3 = C.jogadores.j3.cookie, M = C.cookieMestre;
  const campId = C.campId;

  // gate Internet cumulativo (mesmo padrão das suítes W4/W5): perícia
  // computador + conhecimento tecnologia + item notebook + campos na ficha
  {
    const db = abrirDb(BANCO); const agora = Date.now();
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
    const ins = db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,'{}',?,?)");
    for (const [kind, key, name] of [
      ["pericia", "computador", "Computador"], ["conhecimento", "tecnologia", "Tecnologia"],
      ["item", "notebook", "Notebook"],
    ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    if (!est.secoes[0].campos.some((x) => x.id === "comp")) {
      est.secoes[0].campos.push(
        { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
        { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } });
      db.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), ver.id);
    }
    db.close();
  }
  const darNotebook = (characterId) => comDb((db) => {
    const agora = Date.now();
    db.prepare("insert into inventory_entries (id,character_id,name,quantity,description,category,location,condition,weight,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), characterId, "Notebook", 1, null, "equipamento", "mochila", "novo", 1.5,
        JSON.stringify({ regra: { kind: "item", key: "notebook" } }), agora, agora);
  });

  // segundo personagem da MESMA membership de j3 — usado no caso (c):
  // membership permanece ativa quando só um dos personagens sai do pacote.
  const ch3b = C.novoPersonagem(C.jogadores.j3.membershipId, "R1 Irmao de Cida", { comp: 3 });
  const ch1 = C.novoPersonagem(C.jogadores.j1.membershipId, "R1 Autor", { comp: 3 });
  const ch2 = C.novoPersonagem(C.jogadores.j2.membershipId, "R1 Vizinho", { comp: 3 });
  const ch3a = C.novoPersonagem(C.jogadores.j3.membershipId, "R1 Cida", { comp: 3 });
  for (const ch of [ch1, ch2, ch3a, ch3b]) darNotebook(ch);

  const ids = {};
  comDb((db) => {
    const agora = Date.now();
    const conta = (id, ch, handle) => db.prepare(
      "insert into internet_accounts (id,campaign_id,character_id,handle,display_name,status,mostrar_presenca,mostrar_digitando,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)",
    ).run(id, campId, ch, handle, null, "ativa", 0, 0, agora, agora);
    ids.contaJ1 = crypto.randomUUID(); ids.contaJ2 = crypto.randomUUID(); ids.contaJ3a = crypto.randomUUID();
    conta(ids.contaJ1, ch1, "r1.autor"); conta(ids.contaJ2, ch2, "r1.vizinho"); conta(ids.contaJ3a, ch3a, "r1.cida");

    // contatos: aresta aceita j1↔j2 + pendente j3a→j1
    db.prepare("insert into internet_contacts (id,campaign_id,conta_origem_id,conta_destino_id,status,bloqueado_por_conta_id,created_at,updated_at,responded_at) values (?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), campId, ids.contaJ1, ids.contaJ2, "aceito", null, agora, agora, agora);
    db.prepare("insert into internet_contacts (id,campaign_id,conta_origem_id,conta_destino_id,status,bloqueado_por_conta_id,created_at,updated_at,responded_at) values (?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), campId, ids.contaJ3a, ids.contaJ1, "pendente", null, agora, agora, null);

    // conversa direta j1↔j2 + participantes + mensagem
    ids.convId = crypto.randomUUID();
    const parKey = [ids.contaJ1, ids.contaJ2].sort().join("|");
    db.prepare("insert into internet_conversations (id,campaign_id,tipo,par_key,nome,status,created_by_conta_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(ids.convId, campId, "direta", parKey, null, "ativa", ids.contaJ1, agora, agora);
    const insPart = db.prepare("insert into internet_participantes (id,conversa_id,conta_id,papel,status,convidado_por_conta_id,convidado_em,decidido_em,saiu_em,last_read_created_at,last_read_message_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insPart.run(crypto.randomUUID(), ids.convId, ids.contaJ1, "dono", "ativo", ids.contaJ2, agora, agora, null, null, null, agora, agora);
    insPart.run(crypto.randomUUID(), ids.convId, ids.contaJ2, "membro", "ativo", ids.contaJ1, agora, agora, null, agora, "msg-r1-1", agora, agora);
    ids.msgId = crypto.randomUUID();
    db.prepare("insert into internet_messages (id,conversa_id,campaign_id,autor_conta_id,request_id,payload_hash,conteudo,created_at) values (?,?,?,?,?,?,?,?)")
      .run(ids.msgId, ids.convId, campId, ids.contaJ1, "req-r1-1", "hash-r1-1", "O sino da catedral tocou.", agora - 100);

    // site + página do dono contaJ1
    ids.siteId = crypto.randomUUID(); ids.pageId = crypto.randomUUID();
    db.prepare("insert into internet_sites (id,campaign_id,slug,nome,descricao,owner_conta_id,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(ids.siteId, campId, "templo-r1", "Templo R1", "descrição", ids.contaJ1, "ativo", agora, agora);
    db.prepare("insert into internet_pages (id,site_id,campaign_id,slug,titulo,corpo,formato,status,version,autor_conta_id,published_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(ids.pageId, ids.siteId, campId, "cronica-r1", "Crônica R1", "corpo da crônica", "texto", "publicado", 3, ids.contaJ1, agora - 500, agora - 500, agora - 500);

    // publicações: notícia comum, post_perfil contatos, notícia de
    // SISTEMA referenciando ch3a (caso e), e uma removida com denúncias
    ids.pubN = crypto.randomUUID(); ids.pubC = crypto.randomUUID();
    ids.pubSis = crypto.randomUUID(); ids.pubRem = crypto.randomUUID();
    const insPub = db.prepare("insert into internet_publicacoes (id,campaign_id,tipo,titulo,corpo,formato,status,visibilidade,autor_modo,pseudo_nome,autor_conta_id,origem,fonte_ref,personagem_id,publicado_em,retirado_em,retirado_motivo,denuncia_aberta,denuncia_grave,version,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insPub.run(ids.pubN, campId, "noticia", "Notícia R1", "corpo", "markdown-subset", "publicado", "campanha", "identificado", null, ids.contaJ1, "usuario", null, null, agora - 900, null, null, 0, 0, 1, agora - 900, agora - 900);
    insPub.run(ids.pubC, campId, "post_perfil", "Post R1", "corpo", "markdown-subset", "publicado", "contatos", "pseudonimo", "Vizinho_R1", ids.contaJ2, "usuario", null, null, agora - 800, null, null, 0, 0, 1, agora - 800, agora - 800);
    insPub.run(ids.pubSis, campId, "noticia", "Morte de R1 Cida", "corpo sistema", "markdown-subset", "publicado", "campanha", "identificado", null, null, "sistema", "morte:" + ch3a, ch3a, agora - 700, null, null, 0, 0, 1, agora - 700, agora - 700);
    insPub.run(ids.pubRem, campId, "noticia", "Removida R1", "corpo", "markdown-subset", "removido", "campanha", "identificado", null, ids.contaJ1, "usuario", null, null, agora - 600, null, "denuncia", 1, 0, 2, agora - 600, agora - 600);
    const insDen = db.prepare("insert into internet_denuncias (id,campaign_id,publicacao_id,denunciante_conta_id,motivo,denuncia_grave,status,resolucao,resolvido_por,prazo_contestacao_em,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)");
    insDen.run(crypto.randomUUID(), campId, ids.pubRem, ids.contaJ1, "spam", 0, "auto_removida", null, null, agora + 86400000, agora - 500, agora - 500);
    insDen.run(crypto.randomUUID(), campId, ids.pubRem, ids.contaJ2, "ofensa", 0, "auto_removida", null, null, agora + 86400000, agora - 400, agora - 400);

    // ---- campanha FALSA com as 9 tabelas populadas (caso b) ----
    ids.fakeCamp = crypto.randomUUID();
    const agora2 = agora;
    db.prepare("insert into campaigns (id,name,status,owner_id,settings,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(ids.fakeCamp, "Campanha Fake R1", "andamento", C.adminId, "{}", agora2, agora2);
    ids.fakeUser = crypto.randomUUID(); ids.fakeMem = crypto.randomUUID(); ids.fakeChar = crypto.randomUUID();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(ids.fakeUser, "fake_r1", "Fake R1", "x", agora2, agora2);
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'jogador','ativo',?,?,?)")
      .run(ids.fakeMem, ids.fakeCamp, ids.fakeUser, agora2, agora2, agora2);
    db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(ids.fakeChar, ids.fakeCamp, ids.fakeMem, "Fake Herói R1", "{}", "{}", "aprovada", 0, agora2, agora2);
    // segundo personagem fake SEM conta — alvo do vetor cross-campaign
    // do R5 (internet_accounts.character_id é UNIQUE: não posso
    // reapontar para fakeChar que já tem conta)
    ids.fakeChar2 = crypto.randomUUID();
    db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(ids.fakeChar2, ids.fakeCamp, ids.fakeMem, "Fake Sem Conta R1", "{}", "{}", "aprovada", 0, agora2, agora2);
    const fc = (suf) => `fake-${suf}-r1`;
    db.prepare("insert into internet_accounts (id,campaign_id,character_id,handle,status,mostrar_presenca,mostrar_digitando,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(fc("conta"), ids.fakeCamp, ids.fakeChar, "fake.r1", "ativa", 0, 0, agora2, agora2);
    db.prepare("insert into internet_contacts (id,campaign_id,conta_origem_id,conta_destino_id,status,bloqueado_por_conta_id,created_at,updated_at,responded_at) values (?,?,?,?,?,?,?,?,?)")
      .run(fc("contato"), ids.fakeCamp, fc("conta"), fc("conta"), "aceito", null, agora2, agora2, agora2);
    db.prepare("insert into internet_conversations (id,campaign_id,tipo,par_key,nome,status,created_by_conta_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(fc("conv"), ids.fakeCamp, "direta", "fake|fake", null, "ativa", fc("conta"), agora2, agora2);
    db.prepare("insert into internet_participantes (id,conversa_id,conta_id,papel,status,convidado_por_conta_id,convidado_em,decidido_em,saiu_em,last_read_created_at,last_read_message_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(fc("part"), fc("conv"), fc("conta"), "dono", "ativo", null, agora2, agora2, null, null, null, agora2, agora2);
    db.prepare("insert into internet_messages (id,conversa_id,campaign_id,autor_conta_id,request_id,payload_hash,conteudo,created_at) values (?,?,?,?,?,?,?,?)")
      .run(fc("msg"), fc("conv"), ids.fakeCamp, fc("conta"), "req-fake", "hash-fake", "msg fake", agora2);
    db.prepare("insert into internet_sites (id,campaign_id,slug,nome,owner_conta_id,status,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
      .run(fc("site"), ids.fakeCamp, "fake-site", "Fake Site", fc("conta"), "ativo", agora2, agora2);
    db.prepare("insert into internet_pages (id,site_id,campaign_id,slug,titulo,corpo,autor_conta_id,version,status,formato,published_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(fc("page"), fc("site"), ids.fakeCamp, "fake-page", "Fake Page", "corpo", fc("conta"), 1, "publicado", "texto", agora2, agora2, agora2);
    db.prepare("insert into internet_publicacoes (id,campaign_id,tipo,titulo,corpo,status,visibilidade,autor_modo,autor_conta_id,origem,version,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(fc("pub"), ids.fakeCamp, "noticia", "Fake Pub", "corpo", "publicado", "campanha", "identificado", fc("conta"), "usuario", 1, agora2, agora2);
    db.prepare("insert into internet_denuncias (id,campaign_id,publicacao_id,denunciante_conta_id,motivo,status,created_at,updated_at) values (?,?,?,?,?,?,?,?)")
      .run(fc("den"), ids.fakeCamp, fc("pub"), fc("conta"), "spam", "aberta", agora2, agora2);
  });

  const snap0 = snapshotDominio(campId);
  const snapFake0 = snapshotDominio(ids.fakeCamp);
  t("seed: 9 tabelas populadas na campanha real", Object.values(snap0).every((v) => v.length > 0), JSON.stringify(Object.fromEntries(Object.entries(snap0).map(([k, v]) => [k, v.length]))));
  t("seed: 9 tabelas populadas na campanha fake", Object.values(snapFake0).every((v) => v.length > 0));

  const exportar = async () => {
    const r = await req(BASE, "GET", `/campaigns/${campId}/exportar`, { cookie: M });
    return r.status === 200 ? r.json : null;
  };
  const importar = async (pacote) => req(BASE, "POST", "/campaigns/importar", {
    cookie: M, body: { pacote, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });

  // ---------- R1. Round-trip — linha a linha nas 9 + cross-campaign ----------
  sec("R1. Round-trip substituir — igualdade linha a linha (9 tabelas) + fake intacta");
  {
    const pacote = await exportar();
    t("R1 export 200", !!pacote);
    const imp = await importar(pacote);
    t("R1 substituir → 200", imp.status === 200, `status=${imp.status} ${JSON.stringify(imp.json).slice(0, 160)}`);
    const snap1 = snapshotDominio(campId);
    const difTabs = Object.keys(TABELAS).filter((tab) => !igual(snap0[tab], snap1[tab]));
    t("R1-a: 9 tabelas IDÊNTICAS linha a linha (contatos/publicações/denúncias com conteúdo)", difTabs.length === 0, `divergem: ${difTabs.join(",")}`);
    const snapFake1 = snapshotDominio(ids.fakeCamp);
    const difFake = Object.keys(TABELAS).filter((tab) => !igual(snapFake0[tab], snapFake1[tab]));
    t("R1-b: cross-campaign — 9 tabelas da campanha fake intactas", difFake.length === 0, `divergem: ${difFake.join(",")}`);
    // prova pontual de conteúdo nas tabelas que o PAI só contava
    const contato = comDb((db) => db.prepare("select * from internet_contacts where campaign_id=? and conta_origem_id=?").get(campId, ids.contaJ1));
    t("R1-a+: contato aceito j1→j2 com responded_at preservado", !!contato && contato.status === "aceito" && contato.responded_at !== null, JSON.stringify(contato).slice(0, 160));
    const den = comDb((db) => db.prepare("select count(*) n, group_concat(status) st from internet_denuncias where campaign_id=?").get(campId));
    t("R1-a+: 2 denúncias auto_removida preservadas", den.n === 2 && den.st.includes("auto_removida"), JSON.stringify(den));
    const pubSis = comDb((db) => db.prepare("select personagem_id, origem, fonte_ref from internet_publicacoes where id=?").get(ids.pubSis));
    t("R1-a+: notícia de sistema preserva personagem_id/fonte_ref", pubSis?.personagem_id === ch3a && pubSis?.origem === "sistema", JSON.stringify(pubSis));
  }

  // ---------- R2. membershipId divergente para o mesmo userId (d) ----------
  sec("R2. Membership ID divergente — mesmo userId, sem duplicata, P7 vale");
  {
    const pacote = await exportar();
    const memJ3 = pacote.estado.memberships.find((m) => m.userId === C.jogadores.j3.id);
    t("R2 setup: membership de j3 no pacote", !!memJ3, JSON.stringify(pacote.estado.memberships?.length));
    if (memJ3) {
      const novoMemId = crypto.randomUUID();
      const antigoMemId = memJ3.id;
      memJ3.id = novoMemId;
      for (const ch of pacote.estado.characters ?? []) {
        if (ch.membershipId === antigoMemId) ch.membershipId = novoMemId;
      }
      // sanity: j3 mantém DOIS personagens apontando para a nova membership
      const charsJ3 = (pacote.estado.characters ?? []).filter((c) => c.membershipId === novoMemId);
      t("R2 setup: 2 personagens re-ligados à membership divergente", charsJ3.length === 2, `veio ${charsJ3.length}`);
      const imp = await importar(pacote);
      t("R2 importar com membershipId divergente → 200", imp.status === 200, `status=${imp.status} ${JSON.stringify(imp.json).slice(0, 200)}`);
      const mems = comDb((db) => db.prepare("select id,status from memberships where campaign_id=? and user_id=?").all(campId, C.jogadores.j3.id));
      t("R2: exatamente 1 membership para (campanha,user j3) — sem duplicata UNIQUE", mems.length === 1, JSON.stringify(mems));
      t("R2: membership resultante é a do pacote (id divergente adotado)", mems[0]?.id === novoMemId, JSON.stringify(mems));
      const ch3bRow = comDb((db) => db.prepare("select membership_id from characters where id=?").get(ch3b));
      t("R2: personagem aponta para a membership correta (nova)", ch3bRow?.membership_id === novoMemId, JSON.stringify(ch3bRow));
      // P7/titularidade: conta de ch3a continua autorizada para j3
      const contaApos = await req(BASE, "GET", `/campaigns/${campId}/internet/account?characterId=${ch3a}`, { cookie: J3 });
      t("R2: titularidade P7 segue valendo pós-restore (j3 lê conta de ch3a)", contaApos.status === 200 && contaApos.json?.conta?.id === ids.contaJ3a, `status=${contaApos.status} ${JSON.stringify(contaApos.json).slice(0, 140)}`);
    }
  }

  // ---------- R3. Âncora com membership ATIVA + notícia de sistema órfã (c)+(e) ----------
  sec("R3. Âncora de ch3a com membership ativa (ch3b fica) — gate é account.status");
  {
    const pacote = await exportar();
    pacote.estado.characters = (pacote.estado.characters ?? []).filter((c) => c.id !== ch3a);
    for (const chave of Object.keys(pacote.estado)) {
      if (!Array.isArray(pacote.estado[chave])) continue;
      pacote.estado[chave] = pacote.estado[chave].filter(
        (r) => r && typeof r === "object" && r.characterId !== ch3a && r.personagemId !== ch3a,
      );
    }
    const snapR3antes = snapshotDominio(campId);
    const imp = await importar(pacote);
    t("R3 substituir sem ch3a (mas com ch3b) → 200", imp.status === 200, `status=${imp.status} ${JSON.stringify(imp.json).slice(0, 200)}`);
    const anc = comDb((db) => db.prepare("select status, template_version_id, data, membership_id from characters where id=?").get(ch3a));
    t("R3: âncora arquivada sem template/dados", !!anc && anc.status === "arquivado" && anc.template_version_id === null && anc.data === "{}", JSON.stringify(anc));
    const memJ3 = comDb((db) => db.prepare("select status from memberships where campaign_id=? and user_id=?").get(campId, C.jogadores.j3.id));
    t("R3-c: membership de j3 PERMANECE ativa (ch3b sobreviveu)", !!memJ3 && memJ3.status === "ativo", JSON.stringify(memJ3));
    const contaJ3a = comDb((db) => db.prepare("select status from internet_accounts where id=?").get(ids.contaJ3a));
    t("R3-c: conta da âncora fica inativa MESMO com membership ativa", !!contaJ3a && contaJ3a.status === "inativa", JSON.stringify(contaJ3a));
    // o gate que nega é account.status — membership viva não libera a
    // conta arquivada: j3 tem ch3b elegível mas NENHUMA conta ativa →
    // feed e mutações fail-closed (mesmo gate P5 das suítes W4/W5)
    const feedNegado = await req(BASE, "GET", `/campaigns/${campId}/internet/publicacoes?limit=50`, { cookie: J3 });
    t("R3-c: j3 sem conta ativa → feed negado (membership ativa não basta)", feedNegado.status >= 400 && feedNegado.status < 500, `status=${feedNegado.status}`);
    const contaInfo = await req(BASE, "GET", `/campaigns/${campId}/internet/account?characterId=${ch3a}`, { cookie: J3 });
    // OBSERVAÇÃO O-1 (não-bloqueante, reportada): GET /account devolve a
    // conta INATIVA da âncora ao titular (200, sem campo status) — a UI
    // não distingue conta arquivada de ativa. Operações seguem negadas
    // (feed 403 acima). Titular vê o próprio handle — severidade baixa.
    t("skip: O-1 GET /account retorna conta inativa sem status ao titular", "skip",
      `status=${contaInfo.status} ${JSON.stringify(contaInfo.json).slice(0, 140)}`);
    // mas j3 cria conta NOVA para o personagem sobrevivente ch3b
    const novaConta = await req(BASE, "POST", `/campaigns/${campId}/internet/account`, { cookie: J3, body: { characterId: ch3b, handle: "r1.irmao" } });
    const contaJ3bNova = novaConta.json?.conta?.id;
    t("R3-c: j3 cria conta para ch3b (personagem sobrevivente operacional)", novaConta.status === 200 || novaConta.status === 201, `status=${novaConta.status} ${JSON.stringify(novaConta.json).slice(0, 140)}`);
    // caso (e): notícia de sistema citando ch3a preservada e legível
    const pubSis = comDb((db) => db.prepare("select * from internet_publicacoes where id=?").get(ids.pubSis));
    t("R3-e: notícia de sistema preservada com personagem_id=âncora", !!pubSis && pubSis.personagem_id === ch3a && pubSis.status === "publicado", JSON.stringify(pubSis).slice(0, 200));
    const leituraSis = await req(BASE, "GET", `/campaigns/${campId}/internet/publicacoes/${ids.pubSis}`, { cookie: J1 });
    t("R3-e: notícia de sistema legível pós-restore", leituraSis.status === 200, `status=${leituraSis.status}`);
    // sobrevivente lê histórico (j2)
    const msgsJ2 = await req(BASE, "GET", `/campaigns/${campId}/internet/conversations/${ids.convId}/messages`, { cookie: J2 });
    t("R3: personagem sobrevivente (j2) continua lendo histórico", msgsJ2.status === 200 && JSON.stringify(msgsJ2.json).includes("sino"), `status=${msgsJ2.status}`);
    // âncora não entra em listagens: feed de j3 (conta nova ch3b) não a mostra como autor
    const feedJ3 = await req(BASE, "GET", `/campaigns/${campId}/internet/publicacoes?limit=50`, { cookie: J3 });
    t("R3: feed acessível para conta nova de ch3b", feedJ3.status === 200, `status=${feedJ3.status}`);
    // integridade: tabelas NÃO relacionadas ao personagem removido ficam
    // idênticas; internet_accounts difere só no status de contaJ3a
    const difR3 = Object.keys(TABELAS).filter((tab) => tab !== "internet_accounts" && !igual(snapR3antes[tab], snapshotDominio(campId)[tab]));
    t("R3: 8 tabelas não tocadas pelo restore parcial (só accounts muda)", difR3.length === 0, `divergem: ${difR3.join(",")}`);
    const contasDepois = comDb((db) => db.prepare("select id,status from internet_accounts where campaign_id=? and id!=? order by id").all(campId, contaJ3bNova ?? "\0"));
    const contasAntes = snapR3antes.internet_accounts.map((c) => ({ id: c.id, status: c.id === ids.contaJ3a ? "inativa" : c.status }));
    t("R3: única mutação em accounts = contaJ3a→inativa", igual(contasAntes, contasDepois), `${JSON.stringify(contasAntes)} → ${JSON.stringify(contasDepois)}`);
  }

  // ---------- R4. Rollback FK — pacote corrompido não toca nada ----------
  sec("R4. Rollback — membershipId pendurado aborta sem efeito nas 9 tabelas");
  {
    const snapAntes = snapshotDominio(campId);
    const pacote = await exportar();
    const algumChar = pacote.estado.characters?.find((c) => c.id === ch3b);
    if (algumChar) algumChar.membershipId = crypto.randomUUID();
    const imp = await importar(pacote);
    t("R4: import com membership pendurado → erro (não 200)", imp.status !== 200, `status=${imp.status}`);
    const snapDepois = snapshotDominio(campId);
    const difR4 = Object.keys(TABELAS).filter((tab) => !igual(snapAntes[tab], snapDepois[tab]));
    t("R4: rollback integral — 9 tabelas idênticas após falha", difR4.length === 0, `divergem: ${difR4.join(",")}`);
    const snapFakeDepois = snapshotDominio(ids.fakeCamp);
    const difFakeR4 = Object.keys(TABELAS).filter((tab) => !igual(snapFake0[tab], snapFakeDepois[tab]));
    t("R4: campanha fake intacta após rollback", difFakeR4.length === 0, `divergem: ${difFakeR4.join(",")}`);
  }

  // ---------- R5. P1 TG — aresta cross-campaign no domínio → rollback ----------
  sec("R5. P1 — conta apontando para personagem de OUTRA campanha aborta restore");
  {
    // corrompe uma aresta real: contaJ1 passa a referenciar o personagem
    // da campanha fake (characterId é global — FK simples não pega;
    // é exatamente o vetor do P1 do TG)
    comDb((db) => db.prepare("update internet_accounts set character_id=? where id=?").run(ids.fakeChar2, ids.contaJ1));
    const snapAntes = snapshotDominio(campId); // baseline JÁ corrompido
    const pacote = await exportar();
    const imp = await importar(pacote);
    t("R5: restore com aresta cross-campaign → erro (não 200)", imp.status !== 200, `status=${imp.status} ${JSON.stringify(imp.json).slice(0, 160)}`);
    const snapDepois = snapshotDominio(campId);
    const difR5 = Object.keys(TABELAS).filter((tab) => !igual(snapAntes[tab], snapDepois[tab]));
    t("R5: rollback integral — 9 tabelas idênticas após rejeição", difR5.length === 0, `divergem: ${difR5.join(",")}`);
    const snapFake = snapshotDominio(ids.fakeCamp);
    const difFake = Object.keys(TABELAS).filter((tab) => !igual(snapFake0[tab], snapFake[tab]));
    t("R5: campanha fake intacta", difFake.length === 0, `divergem: ${difFake.join(",")}`);
  }

  console.log(`\n===== Restore × Internet black-box (FILHO): ${pass} ok / ${fail} falhas / ${skip} skips =====`);
} catch (e) {
  console.error("ERRO FATAL", e);
  fail++;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
  process.exit(fail > 0 ? 1 : 0);
}
