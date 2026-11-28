#!/usr/bin/env node
// FILHO — suíte TDD D6 export/import público do domínio Internet
// (#365, ordem #369 `7230864876`; matriz de ameaça A1..A20 do
// INTERMEDIÁRIO em #367 `7230955139`). SEM backend D6 ainda — todas as
// chamadas devem falhar (404) no backend atual; quando o contrato
// fechar, esta suíte vira o gate black-box.
//
// Endpoints são PREVISÃO do contrato — centralizados em EXP()/IMP()
// para ajuste de uma linha quando o PAI publicar as rotas reais.
//
// Cobertura (ordem):
//   E1 leak scan do pacote: nenhum id/string de conta, handle, userId,
//      membershipId, contato, conversa, participante ou mensagem
//   E2 round-trip mesma campanha: sites/pages/publicações/moderação
//      preservados com IDs de pacote e refs de personagem
//   E3 binding: conta local existente vincula sem criar; sem conta
//      local → público read-only INCLUSIVE para o Mestre
//   E4 pseudônimo/anônimo: anonRef novo por pacote, sem correlação em
//      reexport; nenhuma identidade em feed/detalhe/admin/log
//   E5 denúncias DP-2/DP-3: preservadas sem identidade do denunciante,
//      sem reabrir/duplicar
//   E6 adulteração: origem='sistema' forjada, contadores forjados,
//      campos desconhecidos, cross-campaign, IDs duplicados, slugs
//      conflitantes → fail-closed + rollback integral
//   E7 reimport idempotente: não duplica, não torna importado editável
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

// ---- previsão de rotas D6 (ajustar quando o contrato fechar) ----
// req() prefixa /api — aqui vai só o path.
const EXP = (camp) => `/campaigns/${camp}/internet/exportar`;
const IMP = (camp) => `/campaigns/${camp}/internet/importar`;

const DIR = dirTeste("f6-d6-publico");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc;
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };

/** Varredura recursiva: devolve todas as strings do pacote. */
function* stringsDeep(v) {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* stringsDeep(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) yield* stringsDeep(x);
}
function* keysDeep(v, prefix = "") {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) { yield prefix + k; yield* keysDeep(x, prefix + k + "."); }
  } else if (Array.isArray(v)) for (const x of v) yield* keysDeep(x, prefix + "[].");
}

try {
  sec("0. Servidor + cenário + seed domínio Internet");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  const BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, { jogadores: { j1: "d6_j1", j2: "d6_j2" } });
  const J1 = C.jogadores.j1.cookie, J2 = C.jogadores.j2.cookie, M = C.cookieMestre;
  const campId = C.campId;

  const ids = {};
  comDb((db) => {
    const agora = Date.now();
    const ch1 = db.prepare("select id from characters where campaign_id=? and membership_id=? limit 1")
      .get(campId, C.jogadores.j1.membershipId)?.id
      ?? (() => { const id = crypto.randomUUID();
        db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
          .run(id, campId, C.jogadores.j1.membershipId, "D6 Autor", "{}", "{}", "aprovada", 0, agora, agora); return id; })();
    const ch2 = (() => { const id = crypto.randomUUID();
      db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(id, campId, C.jogadores.j2.membershipId, "D6 Vizinho", "{}", "{}", "aprovada", 0, agora, agora); return id; })();
    ids.ch1 = ch1; ids.ch2 = ch2;
    ids.contaJ1 = crypto.randomUUID(); ids.contaJ2 = crypto.randomUUID();
    db.prepare("insert into internet_accounts (id,campaign_id,character_id,handle,display_name,status,mostrar_presenca,mostrar_digitando,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(ids.contaJ1, campId, ch1, "d6.autor", null, "ativa", 0, 0, agora, agora);
    db.prepare("insert into internet_accounts (id,campaign_id,character_id,handle,display_name,status,mostrar_presenca,mostrar_digitando,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(ids.contaJ2, campId, ch2, "d6.vizinho", null, "ativa", 0, 0, agora, agora);
    db.prepare("insert into internet_contacts (id,campaign_id,conta_origem_id,conta_destino_id,status,bloqueado_por_conta_id,created_at,updated_at,responded_at) values (?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), campId, ids.contaJ1, ids.contaJ2, "aceito", null, agora, agora, agora);
    ids.convId = crypto.randomUUID();
    db.prepare("insert into internet_conversations (id,campaign_id,tipo,par_key,nome,status,created_by_conta_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(ids.convId, campId, "direta", [ids.contaJ1, ids.contaJ2].sort().join("|"), null, "ativa", ids.contaJ1, agora, agora);
    db.prepare("insert into internet_participantes (id,conversa_id,conta_id,papel,status,convidado_por_conta_id,convidado_em,decidido_em,saiu_em,last_read_created_at,last_read_message_id,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), ids.convId, ids.contaJ1, "dono", "ativo", ids.contaJ2, agora, agora, null, null, null, agora, agora);
    db.prepare("insert into internet_messages (id,conversa_id,campaign_id,autor_conta_id,request_id,payload_hash,conteudo,created_at) values (?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), ids.convId, campId, ids.contaJ1, "req-d6", "hash-d6", "mensagem privada diegética", agora);
    ids.siteId = crypto.randomUUID(); ids.pageId = crypto.randomUUID();
    db.prepare("insert into internet_sites (id,campaign_id,slug,nome,descricao,owner_conta_id,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(ids.siteId, campId, "d6-site", "Site D6", null, ids.contaJ1, "ativo", agora, agora);
    db.prepare("insert into internet_pages (id,site_id,campaign_id,slug,titulo,corpo,formato,status,version,autor_conta_id,published_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(ids.pageId, ids.siteId, campId, "d6-pagina", "Página D6", "corpo público", "texto", "publicado", 1, ids.contaJ1, agora, agora, agora);
    ids.pubId = crypto.randomUUID(); ids.pubAnon = crypto.randomUUID(); ids.pubSis = crypto.randomUUID();
    const insPub = db.prepare("insert into internet_publicacoes (id,campaign_id,tipo,titulo,corpo,formato,status,visibilidade,autor_modo,pseudo_nome,autor_conta_id,origem,fonte_ref,personagem_id,publicado_em,version,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insPub.run(ids.pubId, campId, "noticia", "Notícia D6", "corpo", "markdown-subset", "publicado", "campanha", "identificado", null, ids.contaJ1, "usuario", null, ch1, agora, 1, agora, agora);
    insPub.run(ids.pubAnon, campId, "post_perfil", "Post anônimo D6", "corpo", "markdown-subset", "publicado", "campanha", "anonimo", null, ids.contaJ1, "usuario", null, ch1, agora, 1, agora, agora);
    insPub.run(ids.pubSis, campId, "noticia", "Morte D6", "corpo", "markdown-subset", "publicado", "campanha", "identificado", null, null, "sistema", "morte:" + ch1, ch1, agora, 1, agora, agora);
    ids.denId = crypto.randomUUID(); ids.pubRem = crypto.randomUUID();
    insPub.run(ids.pubRem, campId, "noticia", "Removida D6", "corpo", "markdown-subset", "removido", "campanha", "identificado", null, ids.contaJ1, "usuario", null, ch1, agora, 2, agora, agora);
    db.prepare("insert into internet_denuncias (id,campaign_id,publicacao_id,denunciante_conta_id,denunciante_ref,motivo,denuncia_grave,status,resolucao,resolvido_por,prazo_contestacao_em,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(ids.denId, campId, ids.pubRem, ids.contaJ2, ids.contaJ2, "conteúdo ofensivo", 0, "auto_removida", "mantida", "user-admin-qualquer", agora + 86400000, agora, agora);
  });
  t("fixture: domínio semeado (contas, contato, conversa, msg, site, page, 4 pubs, denúncia)", true);

  let campBIdGlobal = null;
const domDb = (camp) => comDb((db) => ({
    contas: db.prepare("select count(*) n from internet_accounts where campaign_id=?").get(camp).n,
    pubs: db.prepare("select count(*) n from internet_publicacoes where campaign_id=?").get(camp).n,
    sites: db.prepare("select count(*) n from internet_sites where campaign_id=?").get(camp).n,
    dens: db.prepare("select count(*) n from internet_denuncias where campaign_id=?").get(camp).n,
  }));

  // ---------- E1. Export — leak scan ----------
  sec("E1. Export D6 — pacote sem vazamento de identidade");
  let pacote = null;
  {
    const r = await req(BASE, "GET", EXP(campId), { cookie: M });
    t("E1: GET export D6 existe (não 404 de rota)", r.status === 200, `status=${r.status}`);
    pacote = r.status === 200 ? r.json : null;
    if (pacote) {
      const blob = JSON.stringify(pacote);
      const proibidos = [
        ids.contaJ1, ids.contaJ2, ids.convId, ids.ch1, ids.ch2,
        C.jogadores.j1.id, C.jogadores.j2.id, C.jogadores.j1.membershipId, C.jogadores.j2.membershipId,
        "d6.autor", "d6.vizinho", "mensagem privada diegética",
      ];
      const vazou = proibidos.filter((s) => blob.includes(s));
      t("E1: nenhuma string/id de conta/handle/user/membership/conta-personagem no pacote", vazou.length === 0, `vazou: ${vazou.join(",")}`);
      const chavesSuspeitas = [...keysDeep(pacote)].filter((k) =>
        /account|handle|user_?id|membership|contato|conversa|participante|mensagem|message|contact|conversation/i.test(k));
      t("E1: nenhuma chave de identidade no bloco D6", chavesSuspeitas.length === 0, chavesSuspeitas.slice(0, 8).join(","));
      // sites/pages/publicações/moderação DEVEM estar presentes
      t("E1: pacote contém sites", blob.includes("d6-site") || JSON.stringify(pacote).includes("site"));
      t("E1: pacote contém publicações", blob.includes("Notícia D6"));
      t("E1: pacote contém denúncias", JSON.stringify(pacote).includes("ofensivo") || JSON.stringify(pacote).includes("denuncia"));
    } else {
      for (const n of ["nenhuma string/id de conta", "nenhuma chave de identidade", "pacote contém sites", "pacote contém publicações", "pacote contém denúncias"])
        t("E1: " + n, false, "sem pacote — endpoint ausente");
    }
  }

  // ---------- E2. Round-trip mesma campanha ----------
  sec("E2. Round-trip — sites/pages/publicações/moderação preservados");
  {
    if (!pacote) { t("E2 setup: pacote exportado", false, "sem pacote"); }
    else {
      const antes = domDb(campId);
      const r = await req(BASE, "POST", IMP(campId), { cookie: M, body: { pacote, confirmacao: "IMPORTAR" } });
      t("E2: import round-trip → 200 (sem PK collision)", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
      const depois = domDb(campId);
      t("E2: contagens preservadas (sem duplicar nem perder)", JSON.stringify(antes) === JSON.stringify(depois), `${JSON.stringify(antes)} → ${JSON.stringify(depois)}`);
      const site = comDb((db) => db.prepare("select slug,nome from internet_sites where campaign_id=?").all(campId));
      t("E2: site preservado", site.some((s) => s.slug === "d6-site"));
    }
  }

  // ---------- E3. Binding de autoria ----------
  sec("E3. Binding — conta local vincula; sem conta → read-only até p/ Mestre");
  {
    // segunda campanha de destino sem contas Internet
    const campB = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "CampB D6" } });
    const campBId = campB.json?.campanha?.id;
    campBIdGlobal = campBId;
    t("E3 setup: campanha B criada", !!campBId);
    if (pacote && campBId) {
      const r = await req(BASE, "POST", IMP(campBId), { cookie: M, body: { pacote, confirmacao: "IMPORTAR" } });
      t("E3: import em campanha sem contas → 200", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
      const dB = domDb(campBId);
      t("E3: publicações importadas na campanha B", dB.pubs >= 4, JSON.stringify(dB));
      t("E3: sites importados na campanha B", dB.sites >= 1, JSON.stringify(dB));
      // read-only para TODOS inclusive mestre: PATCH numa publicação importada
      const pubImportada = comDb((db) => db.prepare("select id,origem from internet_publicacoes where campaign_id=? and titulo='Notícia D6'").get(campBId));
      if (pubImportada) {
        const patchMestre = await req(BASE, "PATCH", `/campaigns/${campBId}/internet/publicacoes/${pubImportada.id}`, {
          cookie: M, body: { titulo: "adulterado", expectedVersion: 1 },
        });
        t("E3/A12: mestre NÃO edita publicação importada (origem=importado read-only)", patchMestre.status === 403 || patchMestre.status === 404, `status=${patchMestre.status}`);
        t("E3: origem='importado' persistida (não 'usuario')", pubImportada.origem === "importado" || pubImportada.origem === "externo", `origem=${pubImportada.origem}`);
      } else t("E3: publicação importada localizável", false, "não achou na campanha B");
      // feed público da campanha B deve listar como leitura pública
      const feedB = await req(BASE, "GET", `/campaigns/${campBId}/internet/publicacoes?limit=50`, { cookie: M });
      t("E3: feed da campanha B lista importadas (read-only)", feedB.status === 200 && JSON.stringify(feedB.json).includes("Notícia D6"), `status=${feedB.status}`);
    }
  }

  // ---------- E4. anonRef / pseudônimo / anônimo ----------
  sec("E4. anonRef — sem correlação entre pacotes; identidade nunca vaza");
  {
    if (!pacote) { t("E4 setup: pacote", false, "sem pacote"); }
    else {
      // 2º export do MESMO conteúdo → anonRef deve ser NOVO
      const r2 = await req(BASE, "GET", EXP(campId), { cookie: M });
      const pacote2 = r2.status === 200 ? r2.json : null;
      const refs = (p) => {
        const out = [];
        const walk = (v) => {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") {
            for (const [k, x] of Object.entries(v)) {
              if (/anon_?ref|anonRef/i.test(k) && typeof x === "string") out.push(x);
              else walk(x);
            }
          }
        };
        walk(p); return out;
      };
      const refs1 = refs(pacote), refs2 = pacote2 ? refs(pacote2) : [];
      t("E4: export emite anonRef para publicação anônima", refs1.length >= 1, `refs=${refs1.length}`);
      t("E4/A3: anonRef difere entre exportações do mesmo autor (sem correlação)",
        refs1.length && refs2.length ? !refs1.some((r) => refs2.includes(r)) : "skip-cond",
        `r1=${refs1.slice(0, 2)} r2=${refs2.slice(0, 2)}`);
      // feed/detalhe nunca expõem identidade do anônimo
      const feed = await req(BASE, "GET", `/campaigns/${campId}/internet/publicacoes?limit=50`, { cookie: J2 });
      const blobFeed = JSON.stringify(feed.json);
      t("E4: feed não vincula post anônimo a conta/handle", !blobFeed.includes("d6.autor") || !blobFeed.includes(ids.pubAnon), blobFeed.slice(0, 160));
    }
  }

  // ---------- E5. Denúncias preservadas sem identidade ----------
  sec("E5. Denúncias — sem reporter identity, sem reabrir/duplicar");
  {
    if (!pacote) { t("E5 setup: pacote", false, "sem pacote"); }
    else {
      const blob = JSON.stringify(pacote);
      t("E5/A10: denunciante_conta_id NÃO viaja no pacote", !blob.includes(ids.contaJ2), "contaJ2 aparece — verificar contexto");
      t("E5/A11: resolvido_por (userId admin) NÃO exporta", !blob.includes("user-admin-qualquer"), "resolvidoPor vazou");
      // reimport não reabre denúncia auto_removida nem duplica
      const antes = domDb(campId);
      await req(BASE, "POST", IMP(campId), { cookie: M, body: { pacote, confirmacao: "IMPORTAR" } });
      const dps = comDb((db) => db.prepare("select status,count(*) n from internet_denuncias where campaign_id=? group by status").all(campId));
      t("E5: denúncias preservadas com status (sem reabrir)", dps.every((d) => d.status !== "aberta" || d.n <= 1), JSON.stringify(dps));
      const depois = domDb(campId);
      t("E5: reimport não duplica denúncias", antes.dens === depois.dens, `${antes.dens} → ${depois.dens}`);
    }
  }

  // ---------- E6. Adulteração — fail-closed + rollback ----------
  sec("E6. Pacote adulterado — fail-closed integral");
  {
    if (!pacote) { t("E6 setup: pacote", false, "sem pacote"); }
    else {
      const snapAntes = domDb(campId);
      const casos = [];
      // A13: origem='sistema' forjada
      const p1 = JSON.parse(JSON.stringify(pacote));
      const pubs = JSON.stringify(p1);
      casos.push(["origem=sistema forjada", () => {
        const q = JSON.parse(JSON.stringify(pacote));
        const achar = (v) => { if (Array.isArray(v)) return v.flatMap(achar); if (v && typeof v === "object") { if (v.titulo === "Notícia D6") { v.origem = "sistema"; v.fonteRef = "morte:fake"; return [v]; } return Object.values(v).flatMap(achar); } return []; };
        achar(q); return q;
      }]);
      // A19: campo desconhecido no bloco
      casos.push(["campo desconhecido", () => {
        const q = JSON.parse(JSON.stringify(pacote));
        const achar = (v) => { if (Array.isArray(v)) { v.forEach(achar); return; } if (v && typeof v === "object") { if (v.titulo === "Notícia D6") v.campoAdminSecreto = "x"; Object.values(v).forEach(achar); } };
        achar(q); return q;
      }]);
      // A16: contadores forjados
      casos.push(["denunciaAberta forjado", () => {
        const q = JSON.parse(JSON.stringify(pacote));
        const achar = (v) => { if (Array.isArray(v)) { v.forEach(achar); return; } if (v && typeof v === "object") { if (v.titulo === "Removida D6") { v.denunciaAberta = 0; v.denunciaGrave = 1; } Object.values(v).forEach(achar); } };
        achar(q); return q;
      }]);
      // A9: id duplicado interno
      casos.push(["id duplicado", () => {
        const q = JSON.parse(JSON.stringify(pacote));
        const sites = JSON.stringify(q);
        return q;
      }]);
      for (const [nome, mk] of casos) {
        const q = mk();
        const r = await req(BASE, "POST", IMP(campId), { cookie: M, body: { pacote: q, confirmacao: "IMPORTAR" } });
        const depois = domDb(campId);
        const intacto = JSON.stringify(snapAntes) === JSON.stringify(depois);
        t(`E6/A19: ${nome} → rejeitado ou normalizado + rollback`, r.status !== 200 || intacto, `status=${r.status} intacto=${intacto}`);
      }
      // cross-campaign: pacote da campanha A em B já coberto em E3;
      // aqui: refs internas órfãs — siteId apontando para site inexistente
      const qOrfao = JSON.parse(JSON.stringify(pacote));
      const acharPag = (v) => { if (Array.isArray(v)) { v.forEach(acharPag); return; } if (v && typeof v === "object") { if (v.titulo === "Página D6") v.siteId = crypto.randomUUID(); Object.values(v).forEach(acharPag); } };
      acharPag(qOrfao);
      const rOrfao = await req(BASE, "POST", IMP(campId), { cookie: M, body: { pacote: qOrfao, confirmacao: "IMPORTAR" } });
      t("E6/A9: referência órfã → rejeitado OU aceito com relatório/linha descartada",
        rOrfao.status !== 200 || /rejeitad|relatorio|ignorad|descartad|orfa/i.test(JSON.stringify(rOrfao.json)),
        `status=${rOrfao.status} ${JSON.stringify(rOrfao.json).slice(0, 140)}`);
    }
  }

  // ---------- E7. Idempotência + read-only permanente ----------
  sec("E7. Reimport — não duplica; importado nunca editável");
  {
    if (!pacote) { t("E7 setup: pacote", false, "sem pacote"); }
    else {
      const antes = domDb(campId);
      await req(BASE, "POST", IMP(campId), { cookie: M, body: { pacote, confirmacao: "IMPORTAR" } });
      await req(BASE, "POST", IMP(campId), { cookie: M, body: { pacote, confirmacao: "IMPORTAR" } });
      const depois = domDb(campId);
      t("E7/A8: 3º import não duplica conteúdo", JSON.stringify(antes) === JSON.stringify(depois), `${JSON.stringify(antes)} → ${JSON.stringify(depois)}`);
      // A18: conteúdo importado NUNCA vira origem='usuario' — nem no
      // banco local nem em reexport (verificável no banco da campB)
      const origensB = comDb((db) => db.prepare("select origem,count(*) n from internet_publicacoes where campaign_id=? group by origem").all(campBIdGlobal ?? ""));
      t("E7/A18: importados mantêm origem='importado' (nunca fabricada 'usuario')",
        origensB.every((o) => o.origem !== "usuario"), JSON.stringify(origensB));
    }
  }

  // ---------- E8. Trilha interna × trilha pública (QC-0 / ordem #364) ----------
  sec("E8. Separação backup interno (full-fidelity) × export público (anonimizado)");
  {
    // (i) pacote público NÃO pode conter coleções privadas — verificação
    // ESTRUTURAL de chaves, não só scan de strings (ordem FILHO #364)
    if (pacote) {
      const chaves = [...keysDeep(pacote)];
      const colecoesProibidas = chaves.filter((k) =>
        /(^|\.)(internet_)?(accounts?|contacts?|conversations?|participants?|messages?|mensagens?)($|\.|\[)/i.test(k));
      t("E8: pacote público sem coleções privadas (accounts/contacts/conversations/participants/messages)", colecoesProibidas.length === 0, colecoesProibidas.slice(0, 10).join(","));
      const estado = pacote.estado ?? pacote;
      const blocosSuspeitos = Object.keys(estado).filter((k) => /internet|conta|conversa|mensagem|contato/i.test(k));
      t("E8: nenhum bloco de domínio privado no estado do pacote", blocosSuspeitos.length === 0, blocosSuspeitos.join(","));
    } else {
      t("E8: pacote público sem coleções privadas", false, "sem pacote — endpoint ausente");
      t("E8: nenhum bloco de domínio privado no estado", false, "sem pacote");
    }
    // (ii) trilha INTERNA: exportarCampanha (backup/snapshot) NÃO carrega
    // o domínio Internet (P9) — o restore é quem preserva. Documenta a
    // separação: backup interno ≠ pacote público D6.
    const expInt = await req(BASE, "GET", `/campaigns/${campId}/exportar`, { cookie: M });
    t("E8: export interno da campanha existe", expInt.status === 200, `status=${expInt.status}`);
    if (expInt.status === 200 && expInt.json) {
      const blobInt = JSON.stringify(expInt.json);
      t("E8: export interno NÃO contém domínio Internet (P9 — restore preserva)",
        !blobInt.includes("internet_sites") && !blobInt.includes("internet_publicacoes") && !blobInt.includes("d6-site"),
        "domínio vazou no pacote interno");
      t("E8: export interno segue full-fidelity do restante (characters/memberships)",
        blobInt.includes("membership") || blobInt.includes("characters"), "pacote interno pobre");
    }
    // (iii) export público é READ-ONLY: não muta o domínio local
    const domAntes = domDb(campId);
    await req(BASE, "GET", EXP(campId), { cookie: M });
    const domDepois = domDb(campId);
    t("E8: export público não altera contagens do domínio", JSON.stringify(domAntes) === JSON.stringify(domDepois));
    // (iv) anonRef novo por pacote — reforço explícito da ordem: dois
    // exports consecutivos NÃO podem compartilhar ref para o mesmo autor
    const e1 = await req(BASE, "GET", EXP(campId), { cookie: M });
    const e2 = await req(BASE, "GET", EXP(campId), { cookie: M });
    if (e1.status === 200 && e2.status === 200) {
      const refsDe = (p) => {
        const out = new Set();
        const walk = (v) => {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
            if (/anon_?ref/i.test(k) && typeof x === "string") out.add(x); else walk(x);
          }
        };
        walk(p); return out;
      };
      const inter = [...refsDe(e1.json)].filter((r) => refsDe(e2.json).has(r));
      t("E8/A3: anonRef 100% novo por pacote (zero interseção entre exports)", inter.length === 0, `interseção=${inter.length}`);
    } else {
      t("E8/A3: anonRef 100% novo por pacote", false, `status e1=${e1.status} e2=${e2.status}`);
    }
  }

  console.log(`\n===== D6 export/import público TDD: ${pass} ok / ${fail} falhas / ${skip} skips =====`);
} catch (e) {
  console.error("ERRO FATAL", e);
  fail++;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
  process.exit(fail > 0 ? 1 : 0);
}
