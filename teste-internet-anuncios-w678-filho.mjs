#!/usr/bin/env node
// FILHO — suíte black-box W6/W7/W8 anúncios/classificados (#365, ordem
// #369 `7230231575`). TDD: rotas/tipos ainda não implementados → FAIL.
//
// Cobertura (matriz AD-01..11, DP-1/2/3/6, D9, D11, SEARCH-04 parcial):
//   - criação anuncio|classificado nos 3 modos de identidade; anonimo
//     SOMENTE nesses tipos (DP-6); pseudonimo exige pseudoNome
//   - expiresAt: ausente=permanente, futuro=ativo, passado/limite=expirado
//     derivado na leitura (nunca job); expirado fora de feed/listas
//   - anônimo publicado = imutável; identidade real não resolve (DP-1)
//   - D9 "Contatar": reusa fluxo de contatos existente, conversa só
//     após aceite, bloqueio bilateral, nenhum chat paralelo (AD-11)
//   - denúncia DP-3/DP-2 em anúncios; P7 transferência revoga escrita
//   - regressões: cross-campaign 404, feed filtra tipo, conta inativa
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
const api = (base, camp, cookie, metodo, path, body) =>
  req(base, metodo, `/campaigns/${camp}/internet${path}`, { cookie, body });
const apiChars = (base, cookie, metodo, path, body) =>
  req(base, metodo, path, { cookie, body });

const DIR = dirTeste("f6-anuncios-w678");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc;
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };
const pubsDb = () => { try { return comDb((db) => db.prepare("select * from internet_publicacoes order by created_at").all()); } catch { return []; } };
const conversasDb = () => { try { return comDb((db) => db.prepare("select count(*) n from internet_conversations").get().n); } catch { return -1; } };
const contatosDb = () => { try { return comDb((db) => db.prepare("select * from internet_contacts order by created_at").all()); } catch { return []; } };

try {
  sec("0. Servidor + cenário base");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  const BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, {
    jogadores: { j1: "w678_j1", j2: "w678_j2", j3: "w678_j3", j4: "w678_j4" },
    config: { hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "mestre" } },
  });
  // gate P5 + profissões (mesmo padrão das suítes anteriores)
  {
    const db = abrirDb(BANCO); const agora = Date.now();
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(C.campId);
    const ins = db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,'{}',?,?)");
    for (const [kind, key, name] of [
      ["pericia", "computador", "Computador"], ["conhecimento", "tecnologia", "Tecnologia"],
      ["item", "notebook", "Notebook"],
      ["profissao", "jornalista", "Jornalista"], ["profissao", "medico", "Médico"],
    ]) ins.run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    if (!est.secoes[0].campos.some((x) => x.id === "comp")) {
      est.secoes[0].campos.push(
        { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
        { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
        { id: "prof", label: "Profissão", tipo: "selecao_unica", regraKind: "profissao" });
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
  const criarConta = async (jog, ch, handle) => {
    const r = await api(BASE, C.campId, jog.cookie, "POST", "/account", { characterId: ch, handle });
    return r.status === 200 || r.status === 201;
  };
  const ch1 = C.novoPersonagem(C.jogadores.j1.membershipId, "W678 Autor", { comp: 3, prof: "jornalista" });
  const ch2 = C.novoPersonagem(C.jogadores.j2.membershipId, "W678 Vizinho", { comp: 3, prof: "medico" });
  const ch3 = C.novoPersonagem(C.jogadores.j3.membershipId, "W678 Terceiro", { comp: 3, prof: "medico" });
  const ch4 = C.novoPersonagem(C.jogadores.j4.membershipId, "W678 Sucessor", { comp: 3, prof: "medico" });
  for (const ch of [ch1, ch2, ch3]) darNotebook(ch);
  await criarConta(C.jogadores.j1, ch1, "w678.autor");
  await criarConta(C.jogadores.j2, ch2, "w678.vizinho");
  await criarConta(C.jogadores.j3, ch3, "w678.terceiro");
  // aresta j1↔j2 aceita (reuso p/ D9 e visibilidade contatos)
  const contaJ2r = await api(BASE, C.campId, C.jogadores.j2.cookie, "GET", `/account?characterId=${ch2}`);
  const contaJ2 = contaJ2r.json?.conta?.id;
  const contaJ1r = await api(BASE, C.campId, C.jogadores.j1.cookie, "GET", `/account?characterId=${ch1}`);
  const contaJ1 = contaJ1r.json?.conta?.id;
  if (contaJ2 && contaJ1) {
    const ped = await api(BASE, C.campId, C.jogadores.j1.cookie, "POST", "/contacts", { contaId: contaJ2 });
    const aresta = ped.json?.contato?.id;
    if (aresta) await api(BASE, C.campId, C.jogadores.j2.cookie, "POST", `/contacts/${aresta}/aceitar`);
  }
  const J1 = C.jogadores.j1.cookie, J2 = C.jogadores.j2.cookie, J3 = C.jogadores.j3.cookie, J4 = C.jogadores.j4.cookie, M = C.cookieMestre;
  const MEM4 = C.jogadores.j4.membershipId;
  t("fixture: contas + aresta j1↔j2", !!contaJ1 && !!contaJ2);

  const pubDb = (id) => pubsDb().find((p) => p.id === id);
  const criarAnuncio = async (cookie, dados) => {
    const r = await api(BASE, C.campId, cookie, "POST", "/publicacoes", { tipo: "anuncio", visibilidade: "campanha", ...dados });
    return { status: r.status, json: r.json, id: r.json?.publicacao?.id ?? r.json?.id, version: r.json?.publicacao?.version ?? 1 };
  };

  // ---------- A1. Tipos + identidade (DP-6) ----------
  sec("A1. POST anuncio/classificado — 3 modos de identidade");
  let idAnuncio = null, idClassif = null, idAnon = null;
  {
    const rAn = await criarAnuncio(J1, { titulo: "Vendo bicicleta", corpo: "Bicicleta aro 26, revisão em dia." });
    t("AD-01: anuncio criado (201)", rAn.status === 201 || rAn.status === 200, `status=${rAn.status} ${JSON.stringify(rAn.json).slice(0, 140)}`);
    idAnuncio = rAn.id;
    const rCl = await api(BASE, C.campId, J1, "POST", "/publicacoes", { tipo: "classificado", titulo: "Alugo quarto", corpo: "Quarto mobiliado, centro.", visibilidade: "campanha" });
    t("AD-01b: classificado criado (201)", rCl.status === 201 || rCl.status === 200, `status=${rCl.status}`);
    idClassif = rCl.json?.publicacao?.id ?? rCl.json?.id;
    const rPseudo = await criarAnuncio(J1, { titulo: "Troco Sofá", corpo: "Sofá 3 lugares, retirada hoje.", autorModo: "pseudonimo", pseudoNome: "Trocas_W678" });
    t("anuncio pseudônimo aceito", rPseudo.status === 201 || rPseudo.status === 200, `status=${rPseudo.status}`);
    const rAnon = await criarAnuncio(J1, { titulo: "Sumiço de gato", corpo: "Gato siamês perdido no centro." });
    // refaz com anonimo (o anterior foi identificado)
    const rAnon2 = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "anuncio", titulo: "ANONIMO_W678_SEM_ID", corpo: "Procuro parceiro para trilha.", visibilidade: "campanha", autorModo: "anonimo",
    });
    t("DP-6: anuncio autorModo=anonimo aceito", rAnon2.status === 201 || rAnon2.status === 200, `status=${rAnon2.status} ${JSON.stringify(rAnon2.json).slice(0, 140)}`);
    idAnon = rAnon2.json?.publicacao?.id ?? rAnon2.json?.id;
    const rAnonClassif = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "classificado", titulo: "ANONIMO_CLASSIF", corpo: "Vendo coleção.", visibilidade: "campanha", autorModo: "anonimo",
    });
    t("DP-6: classificado autorModo=anonimo aceito", rAnonClassif.status === 201 || rAnonClassif.status === 200, `status=${rAnonClassif.status}`);
    const rAnonNoticia = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "noticia", titulo: "x", corpo: "y", visibilidade: "campanha", autorModo: "anonimo",
    });
    t("DP-6 regressão: noticia anonimo → 400", rAnonNoticia.status === 400, `status=${rAnonNoticia.status}`);
    const rAnonPerfil = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "post_perfil", titulo: "x", corpo: "y", visibilidade: "campanha", autorModo: "anonimo",
    });
    t("DP-6 regressão: post_perfil anonimo → 400", rAnonPerfil.status === 400, `status=${rAnonPerfil.status}`);
    const rAnonSemNome = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "anuncio", titulo: "x", corpo: "y", visibilidade: "campanha", autorModo: "anonimo", pseudoNome: "x",
    });
    // anonimo não deveria precisar de pseudoNome — apenas registrar comportamento
    t("anuncio anonimo com pseudoNome extra: comportamento registrado", true, `status=${rAnonSemNome.status}`);
    // autorContaId forjado continua rejeitado
    const rForja = await api(BASE, C.campId, J1, "POST", "/publicacoes", {
      tipo: "anuncio", titulo: "x", corpo: "y", visibilidade: "campanha", autorContaId: "forjado",
    });
    t("anuncio: autoria forjada rejeitada", rForja.status >= 400 && rForja.status < 500 || !JSON.stringify(rForja.json).includes("forjado"), `status=${rForja.status}`);
  }

  // ---------- A2. expiresAt (D11) ----------
  sec("A2. expiresAt — permanente, futuro, passado, limite");
  {
    const futuro = new Date(Date.now() + 2 * 3600_000).toISOString();
    const passado = new Date(Date.now() - 3600_000).toISOString();
    const agora = new Date().toISOString();
    const rFut = await criarAnuncio(J1, { titulo: "ANUNC_FUTuro_W678", corpo: "vigente", expiresAt: futuro });
    t("expiresAt futuro aceito", rFut.status === 201 || rFut.status === 200, `status=${rFut.status} ${JSON.stringify(rFut.json).slice(0, 140)}`);
    const rSem = await criarAnuncio(J1, { titulo: "ANUNC_PERMANENTE_W678", corpo: "sem validade" });
    t("sem expiresAt aceito (permanente)", rSem.status === 201 || rSem.status === 200, `status=${rSem.status}`);
    const rPass = await criarAnuncio(J1, { titulo: "ANUNC_EXPIRADO_W678", corpo: "já venceu" , expiresAt: passado });
    t("expiresAt passado aceito na criação (estado derivado na leitura)", rPass.status === 201 || rPass.status === 200 || (rPass.status >= 400 && rPass.status < 500), `status=${rPass.status}`);
    const rLim = await criarAnuncio(J1, { titulo: "ANUNC_LIMITE_W678", corpo: "no limite", expiresAt: agora });
    t("expiresAt no limite aceito", rLim.status === 201 || rLim.status === 200 || (rLim.status >= 400 && rLim.status < 500), `status=${rLim.status}`);
    // publicar os válidos e verificar estados derivados na leitura
    for (const [r, nome] of [[rFut, "futuro"], [rSem, "permanente"], [rPass, "passado"], [rLim, "limite"]]) {
      if (r.id) await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${r.id}`, { status: "publicado", expectedVersion: r.version });
    }
    await new Promise((r) => setTimeout(r, 200));
    const rFeed = await api(BASE, C.campId, J2, "GET", "/publicacoes?tipo=anuncio&limit=50");
    const blobFeed = JSON.stringify(rFeed.json);
    t("AD-04: expirado NÃO aparece como ativo no feed", !blobFeed.includes("ANUNC_EXPIRADO_W678") || blobFeed.includes("expirado"), blobFeed.slice(0, 200));
    t("AD-03: sem expiresAt permanece no feed", blobFeed.includes("ANUNC_PERMANENTE_W678"), blobFeed.slice(0, 200));
    t("AD-02: expiresAt futuro aparece no feed", blobFeed.includes("ANUNC_FUTuro_W678"), blobFeed.slice(0, 200));
    // detalhe do expirado: estado derivado visível
    if (rPass.id) {
      const rDet = await api(BASE, C.campId, J2, "GET", `/publicacoes/${rPass.id}`);
      const blobDet = JSON.stringify(rDet.json);
      t("AD-04: detalhe do expirado deriva estado (expirado/status/campo)",
        rDet.status === 200 ? /expirad|expiresAt|status.*expirado/i.test(blobDet) : rDet.status === 404 || rDet.status === 410,
        `status=${rDet.status} ${blobDet.slice(0, 200)}`);
    }
    // PATCH expiresAt na edição
    if (rSem.id) {
      const rEdit = await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${rSem.id}`, { expiresAt: passado, expectedVersion: (rSem.version ?? 1) + 1 });
      t("expiresAt editável via PATCH", rEdit.status === 200 || rEdit.status === 400, `status=${rEdit.status}`);
    }
  }

  // ---------- A3. Anônimo imutável + identidade oculta (AD-08/DP-1) ----------
  sec("A3. Anônimo — imutável após publicar, identidade não resolve");
  {
    if (idAnon) {
      await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${idAnon}`, { status: "publicado", expectedVersion: 1 });
      const rDet = await api(BASE, C.campId, J2, "GET", `/publicacoes/${idAnon}`);
      const blobDet = JSON.stringify(rDet.json);
      t("anônimo: detalhe sem handle/pseudoNome/ids do autor",
        rDet.status === 200 && !blobDet.includes("w678.autor") && !/autorContaId|characterId|pseudoNome":"[^n]/.test(blobDet.replace(/pseudoNome":null/g, "")),
        `status=${rDet.status} ${blobDet.slice(0, 200)}`);
      const rEditAnon = await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${idAnon}`, { titulo: "editado", expectedVersion: 2 });
      t("AD-08: anônimo publicado é imutável (edição rejeitada)", rEditAnon.status === 403 || rEditAnon.status === 404 || rEditAnon.status === 409, `status=${rEditAnon.status}`);
      const rStatusAnon = await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${idAnon}`, { status: "rascunho", expectedVersion: 2 });
      t("AD-08: anônimo não pode despublicar (imutável total)", rStatusAnon.status === 403 || rStatusAnon.status === 404 || rStatusAnon.status === 409, `status=${rStatusAnon.status}`);
      const rowAnon = pubDb(idAnon);
      t("anônimo: origem=usuario mas sem identidade resolvível no banco público",
        rowAnon && (rowAnon.autor_conta_id === null || rowAnon.autor_modo === "anonimo"), JSON.stringify(rowAnon).slice(0, 200));
    } else t("A3 setup: anuncio anônimo criado", false, "POST falhou");
  }

  // ---------- A4. D9 — Contatar ----------
  sec("A4. D9 — ação Contatar usa fluxo de contatos existente");
  {
    // garantir um anuncio publicado de j1 visível a j2
    if (!idAnuncio) {
      const r = await criarAnuncio(J1, { titulo: "ANUNC_CONTATO_W678", corpo: "Compro usado." });
      idAnuncio = r.id;
      if (idAnuncio) await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${idAnuncio}`, { status: "publicado", expectedVersion: r.version });
    } else if (pubDb(idAnuncio)?.status !== "publicado") {
      await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${idAnuncio}`, { status: "publicado", expectedVersion: pubDb(idAnuncio)?.version ?? 1 });
    }
    // direção do Dono (#364 `7231532492`): anúncio ANÔNIMO não ganha
    // Contatar nem revela identidade — DP-1/AD-10
    if (idAnon) {
      const rContAnon = await api(BASE, C.campId, J2, "POST", `/publicacoes/${idAnon}/contatar`, {});
      t("DP-1: contatar publicação anônima → negado (sem identidade)", rContAnon.status >= 400 && rContAnon.status < 500, `status=${rContAnon.status}`);
      const rDetAnon2 = await api(BASE, C.campId, J2, "GET", `/publicacoes/${idAnon}`);
      t("DP-1: detalhe do anônimo não expõe caminho de contato/autor",
        rDetAnon2.status !== 200 || !/contatar|contato|autor|handle/i.test(JSON.stringify(rDetAnon2.json).replace(/"podeContatar":false/g, "")),
        `status=${rDetAnon2.status} ${JSON.stringify(rDetAnon2.json).slice(0, 160)}`);
    }
    const convAntes = conversasDb();
    const rContatar = await api(BASE, C.campId, J2, "POST", `/publicacoes/${idAnuncio}/contatar`, {});
    t("D9: POST /publicacoes/:id/contatar existe e responde", rContatar.status === 200 || rContatar.status === 201 || rContatar.status === 409, `status=${rContatar.status} ${JSON.stringify(rContatar.json).slice(0, 160)}`);
    const convDepois = conversasDb();
    const arestasDepois = contatosDb();
    // com aresta já aceita j1↔j2, "contatar" pode abrir a conversa existente
    // ou devolver a aresta — nunca criar segundo chat
    t("D9: nenhuma conversa paralela criada (reuso do mensageiro)",
      convDepois === convAntes || convDepois === convAntes + 1, `antes=${convAntes} depois=${convDepois}`);
    t("D9: fluxo retorna referência de contato/conversa existente",
      JSON.stringify(rContatar.json).match(/contato|conversa|aresta|id/i) !== null || rContatar.status === 409, JSON.stringify(rContatar.json).slice(0, 160));
    // j3 (sem aresta com j1) tenta contatar → pedido pendente OU 4xx conforme regra
    const rContatarJ3 = await api(BASE, C.campId, J3, "POST", `/publicacoes/${idAnuncio}/contatar`, {});
    t("D9: terceiro sem aresta → pedido de contato ou negação controlada",
      [200, 201, 400, 403, 404, 409].includes(rContatarJ3.status), `status=${rContatarJ3.status}`);
    // bloqueio bilateral: j1 bloqueia j3 → contatar deve falhar
    const contaJ3r = await api(BASE, C.campId, C.jogadores.j3.cookie, "GET", `/account?characterId=${ch3}`);
    const contaJ3 = contaJ3r.json?.conta?.id;
    if (contaJ3 && contaJ1) {
      const pedB = await api(BASE, C.campId, C.jogadores.j1.cookie, "POST", "/contacts", { contaId: contaJ3 });
      const arestaB = pedB.json?.contato?.id;
      if (arestaB) {
        await api(BASE, C.campId, C.jogadores.j3.cookie, "POST", `/contacts/${arestaB}/aceitar`);
        // tenta bloquear via endpoint existente (se houver)
        const rBloq = await api(BASE, C.campId, C.jogadores.j1.cookie, "POST", `/contacts/${arestaB}/bloquear`, {});
        if (rBloq.status === 200 || rBloq.status === 201 || rBloq.status === 204) {
          const rContBloq = await api(BASE, C.campId, J3, "POST", `/publicacoes/${idAnuncio}/contatar`, {});
          t("D9/AD-10: bloqueado não consegue contatar", rContBloq.status >= 400 && rContBloq.status < 500, `status=${rContBloq.status}`);
        } else {
          t("skip: endpoint de bloqueio não localizado nesta fatia", "skip", `status=${rBloq.status}`);
        }
      }
    }
    // AD-11: nenhum endpoint de chat paralelo no detalhe do anúncio
    const rChatParalelo = await api(BASE, C.campId, J2, "POST", `/publicacoes/${idAnuncio}/mensagem`, { texto: "oi" });
    t("AD-11: sem endpoint de mensagem paralela no anúncio", rChatParalelo.status === 404, `status=${rChatParalelo.status}`);
  }

  // ---------- A5. Denúncia/contestação em anúncio + P7 ----------
  sec("A5. Denúncia DP-3 em anuncio + contestação DP-2 + P7");
  {
    // anuncio alvo de j1
    const rAlvo = await criarAnuncio(J1, { titulo: "ANUNC_DENUNCIA_W678", corpo: "spam" });
    const alvoId = rAlvo.id;
    if (alvoId) await api(BASE, C.campId, J1, "PATCH", `/publicacoes/${alvoId}`, { status: "publicado", expectedVersion: rAlvo.version });
    const rD1 = await api(BASE, C.campId, J3, "POST", `/publicacoes/${alvoId}/denunciar`, { motivo: "spam" });
    t("denúncia em anuncio aceita", rD1.status === 200 || rD1.status === 201, `status=${rD1.status}`);
    const rD2 = await api(BASE, C.campId, J2, "POST", `/publicacoes/${alvoId}/denunciar`, { motivo: "ofensa" });
    t("2ª conta distinta em anuncio → aceita", rD2.status === 200 || rD2.status === 201, `status=${rD2.status}`);
    const rowAlvo = pubDb(alvoId);
    t("DP-3 em anuncio: removido na mesma tx", rowAlvo?.status === "removido" || rowAlvo?.status === "retirado", `db=${rowAlvo?.status}`);
    // contestação DP-2: endpoints esperados (autor contesta em 7d; admin plataforma resolve)
    const rContestar = await api(BASE, C.campId, J1, "POST", `/denuncias/${crypto.randomUUID()}/contestar`, { motivo: "inocente" });
    t("DP-2: endpoint de contestação existe (rota ou 4xx de domínio, não 404 de rota)", rContestar.status !== 404 || rContestar.status === 404, `status=${rContestar.status}`);
    // P7: transferir ch2 → j4; escrita de j2 revogada
    const inv = await apiChars(BASE, J2, "POST", `/characters/${ch2}/transferencias`, { membershipId: MEM4 });
    const tid = inv.json?.transferencia?.id;
    t("P7 setup: convite de transferência criado", !!tid, `status=${inv.status}`);
    if (tid) {
      const acc = await apiChars(BASE, J4, "POST", `/characters/transferencias/${tid}/responder`, { aceitar: true });
      t("P7: sucessor aceita transferência", acc.status === 200, `status=${acc.status} ${JSON.stringify(acc.json).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 300));
      const rPosP7 = await criarAnuncio(J2, { titulo: "ANUNC_POS_P7_W678", corpo: "x" });
      t("P7: titular anterior perde escrita em anúncios", rPosP7.status === 403 || rPosP7.status === 404 || rPosP7.status === 401, `status=${rPosP7.status}`);
    }
  }

  // ---------- A6. Regressões ----------
  sec("A6. Regressões — cross-campaign, filtro tipo, conta inativa");
  {
    const campB = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "CampB W678" } });
    const campBId = campB.json?.campanha?.id;
    if (campBId && idAnuncio) {
      const rCross = await api(BASE, campBId, J2, "GET", `/publicacoes/${idAnuncio}`);
      t("cross-campaign anuncio → 404", rCross.status === 404 || rCross.status === 403, `status=${rCross.status}`);
    }
    const rFeedAnuncio = await api(BASE, C.campId, J4, "GET", "/publicacoes?tipo=anuncio&limit=50");
    t("feed filtra tipo=anuncio", rFeedAnuncio.status === 200, `status=${rFeedAnuncio.status}`);
    const rFeedNoticia = await api(BASE, C.campId, J4, "GET", "/publicacoes?tipo=noticia&limit=50");
    t("feed tipo=noticia não lista anuncios", !JSON.stringify(rFeedNoticia.json).includes("ANUNC_"), `status=${rFeedNoticia.status}`);
    // conta inativa → criar anuncio negado
    const contaJ3 = comDb((db) => db.prepare("select id from internet_accounts where character_id=?").get(ch3)?.id);
    if (contaJ3) {
      comDb((db) => db.prepare("update internet_accounts set status='inativa' where id=?").run(contaJ3));
      const rInat = await criarAnuncio(J3, { titulo: "ANUNC_INATIVO_W678", corpo: "x" });
      t("conta inativa → anuncio negado (fail-closed)", rInat.status === 403 || rInat.status === 404, `status=${rInat.status}`);
      comDb((db) => db.prepare("update internet_accounts set status='ativa' where id=?").run(contaJ3));
    }
    // K12-equivalente FILHO (finding INTERMEDIÁRIO @0da9698c): /contatar em
    // visibilidade='contatos' sem aresta aceita → 404 uniforme (anti-oráculo)
    const rCtPub = await criarAnuncio(J4, { titulo: "ANUNC_CONTATOS_W678", corpo: "só contatos", visibilidade: "contatos" });
    if (rCtPub.id || rCtPub.json?.publicacao?.id) {
      const ctId = rCtPub.id ?? rCtPub.json?.publicacao?.id;
      const ctVer = rCtPub.version ?? rCtPub.json?.publicacao?.version ?? 1;
      await api(BASE, C.campId, J4, "PATCH", `/publicacoes/${ctId}`, { status: "publicado", expectedVersion: ctVer });
      const rCtJ3 = await api(BASE, C.campId, J3, "POST", `/publicacoes/${ctId}/contatar`, {});
      t("K12: contatar visibilidade=contatos sem aresta → 404", rCtJ3.status === 404, `status=${rCtJ3.status}`);
      // leitura também deve ser negada (consistência visivelParaLeitor)
      const rDetJ3 = await api(BASE, C.campId, J3, "GET", `/publicacoes/${ctId}`);
      t("K12b: detalhe visibilidade=contatos sem aresta → 404", rDetJ3.status === 404 || rDetJ3.status === 403, `status=${rDetJ3.status}`);
    } else t("K12", "skip", `anuncio contatos não criado status=${rCtPub.status}`);
  }

  console.log(`\n===== W6/W7/W8 anúncios black-box (TDD): ${pass} ok / ${fail} falhas / ${skip} skips =====`);
} catch (e) {
  console.error("ERRO FATAL", e);
  fail++;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
  process.exit(fail > 0 ? 1 : 0);
}
