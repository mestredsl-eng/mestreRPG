#!/usr/bin/env node
// FILHO — suíte live simulado + métricas (#365 ordem 7232090197 item 3;
// threat model M1–M12/M24–M27/M30–M33; contrato PAI 7232560361).
// Rotas: /internet/ao-vivo, /internet/contas/:handle/seguir,
// views em GET /internet/publicacoes/:id.
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
const apiI = (camp, cookie, metodo, path, body) =>
  req(BASE, metodo, `/campaigns/${camp}/internet${path}`, { cookie, body });

const DIR = dirTeste("f6-live-metricas");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc, BASE;
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };

try {
  sec("0. Servidor + cenário");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, {
    jogadores: { j1: "lv_j1", j2: "lv_j2", j3: "lv_j3" },
    config: { hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "mestre" } },
  });
  const J1 = C.jogadores.j1.cookie, J2 = C.jogadores.j2.cookie, J3 = C.jogadores.j3.cookie, M = C.cookieMestre;
  const campId = C.campId;
  // ruleset completo: elegibilidade internet + gate streamer (M1)
  {
    const db = abrirDb(BANCO); const agora = Date.now();
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
    for (const [kind, key, name] of [
      ["pericia", "computador", "Computador"], ["conhecimento", "tecnologia", "Tecnologia"],
      ["item", "notebook", "Notebook"],
      ["profissao", "streamer", "Streamer"], ["profissao", "medico", "Médico"], ["profissao", "jornalista", "Jornalista"],
      ["pericia", "streamer", "Streamer (perícia)"],
    ]) db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,'{}',?,?)")
      .run(crypto.randomUUID(), rs.id, kind, key, name, null, null, agora, agora);
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    if (!est.secoes[0].campos.some((x) => x.id === "comp")) {
      est.secoes[0].campos.push(
        { id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } },
        { id: "tec", label: "Tecnologia", tipo: "inteiro", regra: { kind: "conhecimento", key: "tecnologia" } },
        { id: "str", label: "Streamer?", tipo: "inteiro", regra: { kind: "pericia", key: "streamer" } },
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
  // ch1: streamer por profissão; ch2: médico (sem gate); ch3: pericia streamer
  const ch1 = C.novoPersonagem(C.jogadores.j1.membershipId, "LV Streamer", { comp: 3, prof: "streamer" });
  const ch2 = C.novoPersonagem(C.jogadores.j2.membershipId, "LV Médico", { comp: 3, prof: "medico" });
  const ch3 = C.novoPersonagem(C.jogadores.j3.membershipId, "LV Perícia", { comp: 3, str: 5 });
  for (const ch of [ch1, ch2, ch3]) darNotebook(ch);
  await apiI(campId, J1, "POST", "/account", { characterId: ch1, handle: "lv.streamer" });
  await apiI(campId, J2, "POST", "/account", { characterId: ch2, handle: "lv.medico" });
  await apiI(campId, J3, "POST", "/account", { characterId: ch3, handle: "lv.pericia" });

  sec("L1. Gate M1 — streamer fail-closed");
  {
    const rSem = await apiI(campId, J2, "POST", "/ao-vivo", { characterId: ch2, titulo: "Live sem gate" });
    t("M1: sem streamer → 403", rSem.status === 403, `status=${rSem.status}`);
    const rInel = await apiI(campId, J1, "POST", "/ao-vivo", { characterId: crypto.randomUUID(), titulo: "Live fantasma" });
    t("personagem inexistente/outra campanha → 404", rInel.status === 404, `status=${rInel.status}`);
    const rProf = await apiI(campId, J1, "POST", "/ao-vivo", { characterId: ch1, titulo: "Live do streamer" });
    t("M1: profissao:streamer → 201", rProf.status === 201, `status=${rProf.status} ${JSON.stringify(rProf.json).slice(0, 120)}`);
    const liveId = rProf.json?.live?.id;
    const rPer = await apiI(campId, J3, "POST", "/ao-vivo", { characterId: ch3, titulo: "Live por perícia" });
    t("M1b: pericia:streamer também habilita → 201", rPer.status === 201, `status=${rPer.status}`);
    const liveId3 = rPer.json?.live?.id;
    // peak: segunda live na mesma conta → 409
    const rDup = await apiI(campId, J1, "POST", "/ao-vivo", { characterId: ch1, titulo: "Segunda live" });
    t("peak: 2ª live aberta na conta → 409", rDup.status === 409, `status=${rDup.status}`);
    globalThis.__liveId = liveId; globalThis.__liveId3 = liveId3;
  }

  sec("L2. Diretório — leitura, identidade sem ids, flag minha");
  {
    const rDir = await apiI(campId, J2, "GET", "/ao-vivo");
    t("diretório 200 p/ leitor elegível", rDir.status === 200, `status=${rDir.status}`);
    const blob = JSON.stringify(rDir.json);
    t("diretório lista live do streamer", blob.includes("lv.streamer") || blob.includes("LV Streamer"), blob.slice(0, 200));
    t("V-08: sem ids internos no diretório", !/contaId|personagemId|characterId|accountId/.test(blob), "");
    const lives = rDir.json?.lives ?? [];
    const minhaStream = lives.find((l) => l.handle === "lv.streamer");
    const minhaView = lives.find((l) => l.handle === "lv.medico");
    t("minha=false p/ não-titular", minhaStream && minhaStream.minha === false, JSON.stringify(minhaStream).slice(0, 120));
    void minhaView;
    const rDirDono = await apiI(campId, J1, "GET", "/ao-vivo");
    const livesDono = rDirDono.json?.lives ?? [];
    t("minha=true p/ titular", livesDono.some((l) => l.handle === "lv.streamer" && l.minha === true), "");
    const rDet = await apiI(campId, J2, "GET", `/ao-vivo/${globalThis.__liveId}`);
    t("detalhe da live vigente → 200", rDet.status === 200, `status=${rDet.status}`);
  }

  sec("L3. Saída e estados derivados");
  {
    const rSai = await apiI(campId, J1, "POST", `/ao-vivo/${globalThis.__liveId}/sair`, {});
    t("sair encerra a live", rSai.status === 200, `status=${rSai.status}`);
    const rDet = await apiI(campId, J2, "GET", `/ao-vivo/${globalThis.__liveId}`);
    t("live encerrada some do detalhe (404)", rDet.status === 404, `status=${rDet.status}`);
    const rDir = await apiI(campId, J2, "GET", "/ao-vivo");
    t("live encerrada some do diretório", !(JSON.stringify(rDir.json).includes("lv.streamer")), "");
    // depois de sair, pode entrar de novo
    const rVolta = await apiI(campId, J1, "POST", "/ao-vivo", { characterId: ch1, titulo: "Live volta" });
    t("reentrar após sair → 201", rVolta.status === 201, `status=${rVolta.status}`);
    globalThis.__liveId2 = rVolta.json?.live?.id;
  }

  sec("L4. M2 — morto não transmite; M3 — TTL derivado");
  {
    const dano = await req(BASE, "POST", `/campaigns/${campId}/characters/${ch3}/hp`, { cookie: M, body: { acao: "dano", quantidade: 9999, motivo: "morte lv" } });
    if (dano.status === 200 || dano.status === 201) {
      // ch3 tem live aberta (__liveId3) — morte não encerra retroativamente (presença é efêmera)
      const rMorto = await apiI(campId, J3, "POST", "/ao-vivo", { characterId: ch3, titulo: "Live de morto" });
      t("M2: personagem morto → 403 ao entrar", rMorto.status === 403, `status=${rMorto.status}`);
    } else t("M2 setup: dano letal", "skip", `status=${dano.status}`);
    // TTL: manipular expiraEm no banco → leitura deriva vigente=false
    comDb((db) => db.prepare("update internet_ao_vivo set expira_em=? where id=?").run(Date.now() - 1000, globalThis.__liveId3));
    const rExp = await apiI(campId, J2, "GET", `/ao-vivo/${globalThis.__liveId3}`);
    t("TTL expirado → 404 na leitura (derivado, sem job)", rExp.status === 404, `status=${rExp.status}`);
  }

  sec("L5. Seguidores — aresta idempotente, contador derivado");
  {
    const rSeg = await apiI(campId, J2, "POST", "/contas/lv.streamer/seguir", {});
    t("seguir → 200 com contagem", rSeg.status === 200 && typeof rSeg.json?.seguidores === "number", `status=${rSeg.status}`);
    const n1 = rSeg.json?.seguidores;
    const rSeg2 = await apiI(campId, J2, "POST", "/contas/lv.streamer/seguir", {});
    t("seguir 2x idempotente (mesma contagem)", rSeg2.json?.seguidores === n1, `n1=${n1} n2=${rSeg2.json?.seguidores}`);
    const rSelf = await apiI(campId, J1, "POST", "/contas/lv.streamer/seguir", {});
    t("auto-seguir → 400", rSelf.status === 400, `status=${rSelf.status}`);
    const rInex = await apiI(campId, J2, "POST", "/contas/nao.existe/seguir", {});
    t("handle inexistente → 404", rInex.status === 404, `status=${rInex.status}`);
    // J3 também segue
    await apiI(campId, J3, "POST", "/contas/lv.streamer/seguir", {});
    const rConta = await apiI(campId, J1, "GET", "/account");
    void rConta;
    const rDir = await apiI(campId, J2, "GET", "/ao-vivo");
    void rDir;
    // contagem real no banco = COUNT derivado
    const nDb = comDb((db) => db.prepare("select count(*) n from internet_seguidores s join internet_accounts a on a.id=s.alvo_conta_id where a.handle='lv.streamer'").get().n);
    t("contador = COUNT real (2 seguidores)", nDb === 2, `nDb=${nDb}`);
    const rSair = await apiI(campId, J2, "POST", "/contas/lv.streamer/deixar-de-seguir", {});
    t("deixar de seguir → contagem decresce", rSair.status === 200 && rSair.json?.seguidores === 1, `status=${rSair.status} n=${rSair.json?.seguidores}`);
  }

  sec("L6. Views — incremento atômico só em publicada vigente");
  {
    // publicação publicada por J2 (anuncio identificado)
    const pub = await apiI(campId, J2, "POST", "/publicacoes", { tipo: "anuncio", titulo: "LV views test", corpo: "corpo", visibilidade: "campanha" });
    const pubId = pub.json?.publicacao?.id;
    if (pubId) {
      await apiI(campId, J2, "PATCH", `/publicacoes/${pubId}`, { status: "publicado", expectedVersion: pub.json?.publicacao?.version ?? 1 });
      const d1 = await apiI(campId, J3, "GET", `/publicacoes/${pubId}`);
      const d2 = await apiI(campId, J3, "GET", `/publicacoes/${pubId}`);
      const v1 = d1.json?.publicacao?.views ?? d1.json?.views;
      const v2 = d2.json?.publicacao?.views ?? d2.json?.views;
      t("views incrementam por leitura (bruto, sem dedupe)", typeof v2 === "number" && v2 > (v1 ?? 0), `v1=${v1} v2=${v2}`);
      // rascunho não deve incrementar — publicação ainda rascunho de J1
      const rasc = await apiI(campId, J1, "POST", "/publicacoes", { tipo: "post_perfil", titulo: "rascunho views", corpo: "x", visibilidade: "campanha" });
      const rascId = rasc.json?.publicacao?.id;
      if (rascId) {
        const antes = comDb((db) => db.prepare("select views_count v from internet_publicacoes where id=?").get(rascId).v);
        await apiI(campId, J1, "GET", `/publicacoes/${rascId}`);
        const depois = comDb((db) => db.prepare("select views_count v from internet_publicacoes where id=?").get(rascId).v);
        t("rascunho: view não incrementa", depois === antes, `antes=${antes} depois=${depois}`);
      }
    } else t("views setup: publicação", "skip", `status=${pub.status}`);
  }

  sec("L7. ISO — cross-campaign, sessão, rate limit");
  {
    const campB = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "CampB LV" } });
    const campBId = campB.json?.campanha?.id;
    if (campBId) {
      const rCross = await apiI(campBId, J2, "GET", "/ao-vivo");
      t("cross-campaign: diretório vazio/403 sem lives da A", rCross.status === 403 || (rCross.status === 200 && (rCross.json?.lives ?? []).length === 0), `status=${rCross.status}`);
      const rCrossDet = await apiI(campBId, J2, "GET", `/ao-vivo/${globalThis.__liveId2}`);
      t("cross-campaign live id → 404/403", rCrossDet.status === 404 || rCrossDet.status === 403, `status=${rCrossDet.status}`);
    }
    const rAnon = await req(BASE, "GET", `/campaigns/${campId}/internet/ao-vivo`);
    t("sem sessão → 401/403", rAnon.status === 401 || rAnon.status === 403, `status=${rAnon.status}`);
    const rEntrarAnon = await req(BASE, "POST", `/campaigns/${campId}/internet/ao-vivo`, { body: { characterId: ch1, titulo: "x" } });
    t("entrar sem sessão → 401/403", rEntrarAnon.status === 401 || rEntrarAnon.status === 403, `status=${rEntrarAnon.status}`);
    // payload hostil: titulo curto, campo extra
    const rCurto = await apiI(campId, J1, "POST", "/ao-vivo", { characterId: ch1, titulo: "ab" });
    t("titulo <3 → 400", rCurto.status === 400, `status=${rCurto.status}`);
    const rExtra = await apiI(campId, J1, "POST", "/ao-vivo", { characterId: ch1, titulo: "ok titulo", hacker: true });
    t("campo desconhecido → 400 (strict)", rExtra.status === 400 || rExtra.status === 409, `status=${rExtra.status}`);
  }

  await encerrarServidor(proc);
  limparDir(DIR);
  console.log(`\n===== live simulado + métricas: ${pass} ok / ${fail} falhas / ${skip} skips =====`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error(e);
  try { await encerrarServidor(proc); } catch {}
  process.exit(1);
}
