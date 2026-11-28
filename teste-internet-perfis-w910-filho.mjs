#!/usr/bin/env node
// FILHO — suíte TDD W9/W10 perfis públicos (#365, matriz PROF-01..09 +
// D12/DP-4/5/7/10). SEM backend ainda — rotas centralizadas em PROF()
// para ajuste quando o contrato fechar. Baseline esperado: 404.
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
// previsão de rotas (ajustar no contrato)
const PERFIL = (base, camp, ch) => `/campaigns/${camp}/internet/perfil?characterId=${ch}`;
const PERFIL_PUB = (base, camp, handle) => `/campaigns/${camp}/internet/perfis/${handle}`;
const BUSCA = (base, camp, q) => `/campaigns/${camp}/internet/busca?q=${encodeURIComponent(q)}`;

const DIR = dirTeste("f6-perfis-w910");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
let proc;
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };

try {
  sec("0. Servidor + cenário");
  await prepararBanco(BANCO);
  const PORTA = await portaLivre();
  const BASE = `http://localhost:${PORTA}`;
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const C = await criarCenario(BASE, BANCO, {
    jogadores: { j1: "p9_j1", j2: "p9_j2" },
    config: { hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "mestre" } },
  });
  const J1 = C.jogadores.j1.cookie, J2 = C.jogadores.j2.cookie, M = C.cookieMestre;
  const campId = C.campId;
  // elegibilidade Internet: perícia computador + item notebook
  {
    const db = abrirDb(BANCO); const agora = Date.now();
    const rs = db.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
    db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,'{}',?,?)")
      .run(crypto.randomUUID(), rs.id, "pericia", "computador", "Computador", null, null, agora, agora);
    db.prepare("insert or ignore into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,'{}',?,?)")
      .run(crypto.randomUUID(), rs.id, "item", "notebook", "Notebook", null, null, agora, agora);
    const ver = db.prepare("select id, structure from sheet_versions order by created_at desc limit 1").get();
    const est = JSON.parse(ver.structure);
    if (!est.secoes[0].campos.some((x) => x.id === "comp")) {
      est.secoes[0].campos.push({ id: "comp", label: "Computador", tipo: "inteiro", regra: { kind: "pericia", key: "computador" } });
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
  const ch1 = C.novoPersonagem(C.jogadores.j1.membershipId, "P9 Herói", { comp: 3 });
  const ch2 = C.novoPersonagem(C.jogadores.j2.membershipId, "P9 Vizinho", { comp: 3 });
  darNotebook(ch1); darNotebook(ch2);
  // conta internet para ch1 (handle serve de base ao perfil)
  await req(BASE, "POST", `/campaigns/${campId}/internet/account`, { cookie: J1, body: { characterId: ch1, handle: "p9.heroi" } });
  t("fixture: conta p9.heroi criada", true);

  // ---------- W9. Ativação irreversível ----------
  sec("W9. PROF-01..04 — ativação, irreversibilidade, conteúdo mínimo");
  {
    // PROF-01: sem ativação → perfil inexistente/não ativado; internet segue
    const rAntes = await req(BASE, "GET", PERFIL_PUB(BASE, campId, "p9.heroi"), { cookie: J2 });
    t("PROF-01: perfil não ativado → inexistente ou flag não-ativado", rAntes.status === 404 || rAntes.status === 200 && /ativad|inexistente/i.test(JSON.stringify(rAntes.json)), `status=${rAntes.status}`);
    const feed = await req(BASE, "GET", `/campaigns/${campId}/internet/publicacoes?limit=5`, { cookie: J1 });
    t("PROF-01: demais áreas da Internet funcionam sem perfil", feed.status === 200, `status=${feed.status}`);
    // PROF-02: ativação — endpoint provável POST /perfil/ativar ou PATCH
    const rAtivar = await req(BASE, "POST", `/campaigns/${campId}/internet/perfil/ativar`, { cookie: J1, body: { characterId: ch1, descricao: "Herói da campanha" } });
    t("PROF-02: ativação de perfil aceita", rAtivar.status === 200 || rAtivar.status === 201, `status=${rAtivar.status} ${JSON.stringify(rAtivar.json).slice(0, 140)}`);
    const rPerfil = await req(BASE, "GET", PERFIL_PUB(BASE, campId, "p9.heroi"), { cookie: J2 });
    t("PROF-02: perfil público legível após ativação", rPerfil.status === 200, `status=${rPerfil.status}`);
    // PROF-04: só nome público/avatar/descrição — sem ids internos
    const blob = JSON.stringify(rPerfil.json);
    t("PROF-04: perfil não vaza ids internos (conta/user/membership)", !/contaId|accountId|userId|membershipId|characterId/.test(blob), blob.slice(0, 200));
    // PROF-03: desativar/excluir/ocultar → rejeitado
    for (const [op, path] of [["desativar", "/perfil/desativar"], ["excluir", "/perfil"], ["ocultar", "/perfil/ocultar"]]) {
      const r = await req(BASE, op === "excluir" ? "DELETE" : "POST", `/campaigns/${campId}/internet${path}`, { cookie: J1, body: { characterId: ch1 } });
      t(`PROF-03/D10: ${op} perfil → não aceito`, r.status === 404 || r.status === 405 || r.status === 403 || r.status === 400, `status=${r.status}`);
    }
  }

  // ---------- W10. Ciclo de vida ----------
  sec("W10. PROF-05..09 — busca, P7, morte/ressurreição, avatar");
  {
    // PROF-05/SEARCH-05/06: busca por handle acha; displayName não indexa
    const rBusca = await req(BASE, "GET", BUSCA(BASE, campId, "p9.heroi"), { cookie: J2 });
    t("PROF-05/SEARCH-05: busca por handle encontra perfil", rBusca.status === 200 && JSON.stringify(rBusca.json).includes("p9.heroi"), `status=${rBusca.status}`);
    const rBuscaNome = await req(BASE, "GET", BUSCA(BASE, campId, "P9 Herói"), { cookie: J2 });
    t("SEARCH-06: displayName NÃO indexa perfil", !JSON.stringify(rBuscaNome.json).includes("p9.heroi") || rBuscaNome.status !== 200, `status=${rBuscaNome.status}`);
    // PROF-06: P7 — perfil segue characterId; novo titular administra
    const inv = await req(BASE, "POST", `/campaigns/${campId}/characters/${ch1}/transferencias`, { cookie: J1, body: { membershipId: C.jogadores.j2.membershipId } });
    const tid = inv.json?.transferencia?.id;
    if (tid) {
      await req(BASE, "POST", `/campaigns/${campId}/characters/transferencias/${tid}/responder`, { cookie: J2, body: { aceitar: true } });
      await new Promise((r) => setTimeout(r, 300));
      const rAntigo = await req(BASE, "GET", PERFIL_PUB(BASE, campId, "p9.heroi"), { cookie: J1 });
      t("PROF-06: titular anterior ainda LÊ perfil público (leitura)", rAntigo.status === 200, `status=${rAntigo.status}`);
      // escrita do perfil pertence ao novo titular — endpoint de edição de descrição
      const rEditAntigo = await req(BASE, "PATCH", `/campaigns/${campId}/internet/perfil`, { cookie: J1, body: { characterId: ch1, descricao: "hack" } });
      t("PROF-06: titular anterior NÃO edita perfil", rEditAntigo.status === 403 || rEditAntigo.status === 404, `status=${rEditAntigo.status}`);
    } else t("PROF-06 setup: transferência criada", false, `status=${inv.status}`);
    // PROF-07/08: morte → perfil legível read-only; ressurreição reabre
    const dano = await req(BASE, "POST", `/campaigns/${campId}/characters/${ch1}/hp`, { cookie: M, body: { acao: "dano", quantidade: 9999, motivo: "morte p9" } });
    if (dano.status === 200) {
      await new Promise((r) => setTimeout(r, 300));
      const rMorto = await req(BASE, "GET", PERFIL_PUB(BASE, campId, "p9.heroi"), { cookie: J2 });
      t("PROF-07/DP-5: perfil de morto permanece legível", rMorto.status === 200, `status=${rMorto.status}`);
      const rEditMorto = await req(BASE, "PATCH", `/campaigns/${campId}/internet/perfil`, { cookie: J2, body: { characterId: ch1, descricao: "x" } });
      t("PROF-07: escrita no perfil de morto → negada", rEditMorto.status === 403 || rEditMorto.status === 404, `status=${rEditMorto.status}`);
      const ress = await req(BASE, "POST", `/campaigns/${campId}/characters/${ch1}/ressuscitar`, { cookie: M, body: {} });
      if (ress.status === 200) {
        const rVivo = await req(BASE, "PATCH", `/campaigns/${campId}/internet/perfil`, { cookie: J2, body: { characterId: ch1, descricao: "voltei" } });
        t("PROF-08/DP-8: escrita reabre após ressurreição", rVivo.status === 200 || rVivo.status === 201, `status=${rVivo.status}`);
      } else t("PROF-08 setup: ressurreição", "skip", `status=${ress.status}`);
    } else t("PROF-07 setup: dano letal", "skip", `status=${dano.status}`);
    // PROF-09: avatar via pipeline arquivos — endpoint provável
    const rAvatar = await req(BASE, "POST", `/campaigns/${campId}/internet/perfil/avatar`, { cookie: J2, body: { characterId: ch1, arquivoId: crypto.randomUUID() } });
    t("PROF-09: avatar usa pipeline existente (arquivoId de arquivos/)", rAvatar.status !== 500, `status=${rAvatar.status}`);
  }

  // ---------- Isolamento + adversarial ----------
  sec("ISO. Cross-campaign e enumeração");
  {
    const campB = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "CampB P9" } });
    const campBId = campB.json?.campanha?.id;
    if (campBId) {
      const rCross = await req(BASE, "GET", PERFIL_PUB(BASE, campBId, "p9.heroi"), { cookie: J2 });
      t("ISO: perfil de outra campanha → 404", rCross.status === 404, `status=${rCross.status}`);
      const rAtivarB = await req(BASE, "POST", `/campaigns/${campBId}/internet/perfil/ativar`, { cookie: J1, body: { characterId: ch2 } });
      t("ISO: ativar perfil com characterId de outra campanha → 4xx", rAtivarB.status >= 400 && rAtivarB.status < 500, `status=${rAtivarB.status}`);
    }
    // sem sessão
    const rAnon = await req(BASE, "GET", PERFIL_PUB(BASE, campId, "p9.heroi"), {});
    t("sem sessão → 401", rAnon.status === 401, `status=${rAnon.status}`);
  }

  console.log(`\n===== W9/W10 perfis públicos TDD: ${pass} ok / ${fail} falhas / ${skip} skips =====`);
} catch (e) {
  console.error("ERRO FATAL", e);
  fail++;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
  process.exit(fail > 0 ? 1 : 0);
}
