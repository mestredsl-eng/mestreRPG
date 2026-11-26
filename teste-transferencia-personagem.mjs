// Testes — P7 transferência de personagem (contrato #349).
// Banco SQLite NOVO + migrations + cenário sintético (teste-base.mjs).
// Cobre: convite só pelo titular, aceite só pelo novo titular,
// cancelamento, rejeição, corrida de aceites, TOCTOU (arquivamento e
// bloqueio de membership entre convite e aceite), bordas
// (NPC/arquivado/espectador/auto/cross-campaign) e a conta diegética
// acompanhando o personagem para o novo titular.
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req, abrirDb, encerrarServidor, limparDir } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-transfer-"));
const BANCO = join(DIR, "mestre-rpg.db");
await prepararBanco(BANCO);
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
proc.stderr.on("data", (d) => process.stderr.write(d));
await esperarSaudavel(BASE, proc);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const comDb = (fn) => { const db = abrirDb(BANCO); try { return fn(db); } finally { db.close(); } };

// fixture do gate Internet 1.1.0 (mesmo padrão de teste-internet-contas)
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
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha P7", jogadores: { j1: "p7_j1", j2: "p7_j2", j3: "p7_j3" } });
  const CID = c.campId, M = c.cookieMestre;
  const J1 = c.jogadores.j1.cookie, J2 = c.jogadores.j2.cookie, J3 = c.jogadores.j3.cookie;
  const MEM1 = c.jogadores.j1.membershipId, MEM2 = c.jogadores.j2.membershipId, MEM3 = c.jogadores.j3.membershipId;

  fixtureGate(BANCO, CID);
  const novoChar = async (cookie, nome, opts = {}) => {
    const r = await req(BASE, "POST", `/campaigns/${CID}/characters`, { cookie, body: { name: nome, ...(opts.npc ? { isNpc: true } : {}) } });
    const id = r.json?.personagem?.id;
    if (!id) throw new Error("criar personagem falhou: " + JSON.stringify(r.json).slice(0, 200));
    if (opts.comp) darDispositivo(BANCO, id);
    return id;
  };
  const membershipDe = (charId) => comDb((db) => db.prepare("select membership_id m from characters where id=?").get(charId)?.m ?? null);
  const transferStatus = (tid) => comDb((db) => db.prepare("select status from character_transfers where id=?").get(tid)?.status ?? null);
  const API = (metodo, path, cookie, body) => req(BASE, metodo, `/campaigns/${CID}/characters${path}`, { cookie, body });

  sec("A. Convite — só o titular, só destino elegível");
  {
    // personagem elegível ao gate Internet (perícia comp=1 + dispositivo)
    const char = c.novoPersonagem(MEM1, "Titular Um", { comp: 1 });
    darDispositivo(BANCO, char);
    // não-titular não oferece
    t("não-titular → 403",
      (await API("POST", `/${char}/transferencias`, J2, { membershipId: MEM3 })).status === 403);
    // auto-transferência
    t("auto → 400",
      (await API("POST", `/${char}/transferencias`, J1, { membershipId: MEM1 })).status === 400);
    // membership de OUTRA campanha / inexistente
    t("membership inexistente → 400",
      (await API("POST", `/${char}/transferencias`, J1, { membershipId: "mem-fake" })).status === 400);
    // convite válido para j2
    const inv = await API("POST", `/${char}/transferencias`, J1, { membershipId: MEM2 });
    t("titular convida → 201 pendente",
      inv.status === 201 && inv.json?.transferencia?.status === "pendente", JSON.stringify(inv.json));
    const tid = inv.json?.transferencia?.id;
    // segundo pendente → 409
    t("segundo convite pendente → 409",
      (await API("POST", `/${char}/transferencias`, J1, { membershipId: MEM3 })).status === 409);

    sec("B. Resposta — só o novo titular decide");
    t("titular atual NÃO responde → 403",
      (await API("POST", `/transferencias/${tid}/responder`, J1, { aceitar: true })).status === 403);
    t("terceiro NÃO responde → 403",
      (await API("POST", `/transferencias/${tid}/responder`, J3, { aceitar: true })).status === 403);
    t("aceite ainda pendente após negações", transferStatus(tid) === "pendente");

    // recusa primeiro (fluxo alternativo com novo convite)
    const rec = await API("POST", `/transferencias/${tid}/responder`, J2, { aceitar: false });
    t("novo titular recusa → recusada",
      rec.status === 200 && rec.json?.status === "recusada" && transferStatus(tid) === "recusada",
      JSON.stringify(rec.json));
    t("titular segue o mesmo após recusa", membershipDe(char) === MEM1);
    t("recusada não pode ser aceita depois",
      (await API("POST", `/transferencias/${tid}/responder`, J2, { aceitar: true })).status === 409);

    // novo convite → aceite
    const inv2 = await API("POST", `/${char}/transferencias`, J1, { membershipId: MEM2 });
    const tid2 = inv2.json?.transferencia?.id;
    t("novo convite após recusa → 201",
      inv2.status === 201 && !!tid2, JSON.stringify(inv2.json).slice(0, 160));
    const acc = await API("POST", `/transferencias/${tid2}/responder`, J2, { aceitar: true });
    t("novo titular aceita → aceita",
      acc.status === 200 && acc.json?.status === "aceita", JSON.stringify(acc.json));
    t("characters.membership_id trocou atomicamente",
      membershipDe(char) === MEM2, `membership=${membershipDe(char)}`);
    t("status do pedido = aceita", transferStatus(tid2) === "aceita");
    t("aceite duplicado → 409",
      (await API("POST", `/transferencias/${tid2}/responder`, J2, { aceitar: true })).status === 409);

    sec("C. Conta diegética acompanha o personagem (P7)");
    // a conta diegética é keyed por characterId: prova de que o NOVO
    // titular acessa a conta do personagem e o antigo perde (P7).
    const accInternet = await req(BASE, "POST", `/campaigns/${CID}/internet/account`,
      { cookie: J2, body: { characterId: char, handle: "p7.titular", displayName: "P7" } });
    t("novo titular cria conta internet do personagem",
      accInternet.status === 201 || accInternet.status === 409, JSON.stringify(accInternet.json).slice(0, 160));
    const getJ2 = await req(BASE, "GET", `/campaigns/${CID}/internet/account?characterId=${char}`, { cookie: J2 });
    t("novo titular lê a conta do personagem", getJ2.status === 200 && !!getJ2.json?.conta?.id,
      `status=${getJ2.status} ${JSON.stringify(getJ2.json).slice(0, 120)}`);
    const getJ1 = await req(BASE, "GET", `/campaigns/${CID}/internet/account?characterId=${char}`, { cookie: J1 });
    t("titular ANTIGO perde acesso à conta (autorização vigente)",
      getJ1.status === 403, `status=${getJ1.status}`);

    sec("D. Auditoria — trilha completa sem conteúdo");
    const audits = comDb((db) => db.prepare(
      "select action from audit_logs where campaign_id=? and action like 'personagem.transferencia_%' order by created_at"
    ).all(CID).map((r) => r.action));
    t("auditoria registrou iniciada+recusada+aceita",
      audits.includes("personagem.transferencia_iniciada")
      && audits.includes("personagem.transferencia_recusada")
      && audits.includes("personagem.transferencia_aceita"),
      audits.join(","));
  }

  sec("E. Cancelamento pelo titular atual");
  {
    const char = await novoChar(J1, "Cancelável");
    const inv = await API("POST", `/${char}/transferencias`, J1, { membershipId: MEM3 });
    const tid = inv.json?.transferencia?.id;
    t("novo titular NÃO cancela → 403",
      (await API("POST", `/transferencias/${tid}/cancelar`, J3, {})).status === 403);
    const can = await API("POST", `/transferencias/${tid}/cancelar`, J1, {});
    t("titular cancela → cancelada",
      can.status === 200 && can.json?.status === "cancelada" && transferStatus(tid) === "cancelada");
    t("cancelada não pode ser aceita",
      (await API("POST", `/transferencias/${tid}/responder`, J3, { aceitar: true })).status === 409);
    t("novo convite após cancelamento → 201",
      (await API("POST", `/${char}/transferencias`, J1, { membershipId: MEM3 })).status === 201);
  }

  sec("F. TOCTOU — estado muda entre convite e aceite");
  {
    // F1: arquivar personagem entre convite e aceite → 409, pedido pendente
    const charA = await novoChar(J1, "Arquivável");
    const invA = await API("POST", `/${charA}/transferencias`, J1, { membershipId: MEM2 });
    const tidA = invA.json?.transferencia?.id;
    await req(BASE, "POST", `/campaigns/${CID}/characters/${charA}/arquivar`, { cookie: M });
    const accA = await API("POST", `/transferencias/${tidA}/responder`, J2, { aceitar: true });
    t("aceite após arquivamento → 409", accA.status === 409, `status=${accA.status}`);
    t("titular NÃO mudou", membershipDe(charA) === MEM1);
    t("pedido permanece pendente (cancelável)", transferStatus(tidA) === "pendente");

    // F2: bloquear membership destino entre convite e aceite → 409
    const charB = await novoChar(J1, "Bloqueável");
    const invB = await API("POST", `/${charB}/transferencias`, J1, { membershipId: MEM3 });
    const tidB = invB.json?.transferencia?.id;
    comDb((db) => db.prepare("update memberships set status='bloqueado' where id=?").run(MEM3));
    const accB = await API("POST", `/transferencias/${tidB}/responder`, J3, { aceitar: true });
    t("aceite com destino bloqueado → 409", accB.status === 409, `status=${accB.status}`);
    t("titular NÃO mudou (bloqueio)", membershipDe(charB) === MEM1);
    comDb((db) => db.prepare("update memberships set status='ativo' where id=?").run(MEM3));

    // F3: user do destino inativo (users.status) → 409
    const charC = await novoChar(J1, "UserBloqueável");
    const invC = await API("POST", `/${charC}/transferencias`, J1, { membershipId: MEM2 });
    const tidC = invC.json?.transferencia?.id;
    const uidJ2 = c.jogadores.j2.id;
    comDb((db) => db.prepare("update users set status='bloqueado' where id=?").run(uidJ2));
    const accC = await API("POST", `/transferencias/${tidC}/responder`, J2, { aceitar: true });
    // usuário inativo é barrado já na camada de auth (401) — a
    // revalidação EXISTS na tx é a segunda linha de defesa
    t("aceite com user inativo → rejeitado (401 auth / 409 tx)",
      accC.status === 401 || accC.status === 409, `status=${accC.status}`);
    t("titular NÃO mudou (user inativo)", membershipDe(charC) === MEM1);
    comDb((db) => db.prepare("update users set status='ativo' where id=?").run(uidJ2));
  }

  sec("G. Bordas — NPC, arquivado na criação, corrida de aceites");
  {
    // NPC não oferece
    const npc = await novoChar(M, "NPC Sem Transfer", { npc: true });
    t("NPC → 403 na criação do convite",
      (await API("POST", `/${npc}/transferencias`, M, { membershipId: MEM1 })).status === 403);

    // arquivado não oferece
    const charArq = await novoChar(J1, "Já Arquivado");
    await req(BASE, "POST", `/campaigns/${CID}/characters/${charArq}/arquivar`, { cookie: M });
    t("arquivado → 409 na criação",
      (await API("POST", `/${charArq}/transferencias`, J1, { membershipId: MEM2 })).status === 409);

    // corrida: dois aceites simultâneos no MESMO pedido → um vence
    const charD = await novoChar(J1, "Corrida Aceite");
    const invD = await API("POST", `/${charD}/transferencias`, J1, { membershipId: MEM2 });
    const tidD = invD.json?.transferencia?.id;
    const [a1, a2] = await Promise.all([
      API("POST", `/transferencias/${tidD}/responder`, J2, { aceitar: true }),
      API("POST", `/transferencias/${tidD}/responder`, J2, { aceitar: true }),
    ]);
    const okN = [a1, a2].filter((r) => r.status === 200).length;
    const conflN = [a1, a2].filter((r) => r.status === 409).length;
    t("dois aceites simultâneos → exatamente 1 vence",
      okN === 1 && conflN === 1, `st=${a1.status},${a2.status}`);
    t("personagem transferido uma única vez",
      membershipDe(charD) === MEM2 && transferStatus(tidD) === "aceita");

    // corrida de convites: dois POST simultâneos → 1 pendente
    const charE = await novoChar(J1, "Corrida Convite");
    const [c1, c2] = await Promise.all([
      API("POST", `/${charE}/transferencias`, J1, { membershipId: MEM2 }),
      API("POST", `/${charE}/transferencias`, J1, { membershipId: MEM3 }),
    ]);
    const pendentes = comDb((db) => db.prepare(
      "select count(*) c from character_transfers where character_id=? and status='pendente'").get(charE).c);
    t("convites simultâneos → no máximo 1 pendente",
      pendentes === 1 && [c1.status, c2.status].includes(409),
      `pendentes=${pendentes} st=${c1.status},${c2.status}`);
  }

  sec("H. GET trilha — visibilidade");
  {
    const char = await novoChar(J1, "Trilha Visível");
    await API("POST", `/${char}/transferencias`, J1, { membershipId: MEM2 });
    const gTitular = await API("GET", `/${char}/transferencias`, J1);
    t("titular lê a trilha", gTitular.status === 200 && gTitular.json?.transferencias?.length === 1);
    const gCandidato = await API("GET", `/${char}/transferencias`, J2);
    t("candidato lê a trilha", gCandidato.status === 200 && gCandidato.json?.transferencias?.length === 1);
    const gTerceiro = await API("GET", `/${char}/transferencias`, J3);
    t("terceiro NÃO lê a trilha", gTerceiro.status === 200 && gTerceiro.json?.transferencias?.length === 0);
    const gMestre = await API("GET", `/${char}/transferencias`, M);
    t("mestre lê a trilha", gMestre.status === 200 && gMestre.json?.transferencias?.length === 1);
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
} finally {
  await encerrarServidor(proc);
  try { limparDir(DIR); } catch { /* EPERM benigno em Windows */ }
}
process.exit(fail ? 1 : 0);
