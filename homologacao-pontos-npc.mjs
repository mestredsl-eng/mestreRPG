// Homologação: pontos selados + bônus individual (__pontos) + NPCs.
// Cobre os 17 cenários do spec: legado sem __pontos, bônus por personagem,
// selo na aprovação, trava de pontos para o jogador, endpoint /pontos,
// reabrir vs devolver, NPC aprovado/selado e permissões.
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

// Este roteiro altera a configuração da campanha e cria personagens/sessões de teste.
// Exija confirmação explícita para evitar execução acidental contra o banco real.
if (process.env.CONFIRMAR_HOMOLOGACAO_PONTOS_NPC !== "SIM") {
  console.error("Execução bloqueada: o teste altera dados persistentes.");
  console.error("Use CONFIRMAR_HOMOLOGACAO_PONTOS_NPC=SIM após conferir BASE_URL e HOMOLOGACAO_DB_PATH.");
  process.exit(2);
}

const BASE = process.env.BASE_URL || "http://localhost:3002";
const CID = "7a1c9c2e-3c7a-4805-9145-d8622d755a36"; // Caçadores & Caças
const VER = "70cd71b0-6a93-4962-8123-2dc11451b02b"; // Caçador Caçados v7 (publicada)
const CAMPO_PONTOS = "533127a9";  // Prontidão — inteiro, custo 1, editável por ambos
const CAMPO_NARR = "f0764f10";    // Nome do perssonagem — texto, editável por jogador
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const DB_PATH = process.env.HOMOLOGACAO_DB_PATH || "banco/mestre-rpg.db";
const db = new Database(DB_PATH);
const sessao = (userId, tag) => {
  const token = `${tag}-` + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, hashToken(token), "hom-pontos", "127.0.0.1", Date.now() + 3600000, Date.now());
  return token;
};
const admin = db.prepare("select id from users where username='administrador'").get();
const jog = db.prepare("select id from users where username='fernandoqc_@hotmail.com'").get();
const tokM = sessao(admin.id, "pontos-m");
const tokJ = sessao(jog.id, "pontos-j");
async function req(m, path, body, token) {
  const r = await fetch(BASE + path, {
    method: m,
    headers: { "content-type": "application/json", cookie: `mestre_rpg_session=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const apiM = (m, p, b) => req(m, p, b, tokM);
const apiJ = (m, p, b) => req(m, p, b, tokJ);
const ficha = async (id, api = apiJ) => (await api("GET", `/api/characters/${id}`)).json;
const bonusDe = async (id) => (await ficha(id)).ficha?.pontosBonus?.bonus;
const poolPrincipal = async (id) => (await ficha(id)).ficha?.pontos?.pools?.find((p) => p.id === "principal");

// Config de pontos controlada: 10 iniciais, sem pools extras.
await apiM("PUT", `/api/campaigns/${CID}/regras/config`, {
  pontos: { habilitado: true, pontosIniciais: 10, pools: [], custos: {} },
  pontosExtras: 0,
});

// ---------- 1) Personagem antigo/novo sem __pontos ----------
const c1 = await apiJ("POST", `/api/campaigns/${CID}/characters`, { name: "PJ Selado", templateVersionId: VER });
ok("criar PJ Selado", c1.status === 201, `status=${c1.status}`);
const id1 = c1.json?.personagem?.id;
let f1 = await ficha(id1);
ok("1. sem __pontos -> bonus 0, não selado", f1.ficha?.pontosBonus?.bonus === 0 && f1.ficha?.pontosBonus?.selado === false,
  `bonus=${f1.ficha?.pontosBonus?.bonus} selado=${f1.ficha?.pontosBonus?.selado}`);
ok("pool principal = 10 pts iniciais", (await poolPrincipal(id1))?.disponiveis === 10);

// ---------- 2) Bônus individual ----------
let r = await apiM("POST", `/api/characters/${id1}/pontos`, { acao: "conceder", quantidade: 5, motivo: "Recompensa de campanha" });
ok("2. mestre concede +5", r.status === 200 && r.json?.pontos?.bonus === 5, `status=${r.status} bonus=${r.json?.pontos?.bonus}`);
ok("pool principal agora 15", (await poolPrincipal(id1))?.disponiveis === 15, `disp=${(await poolPrincipal(id1))?.disponiveis}`);

// Jogador NÃO pode usar o endpoint
r = await apiJ("POST", `/api/characters/${id1}/pontos`, { acao: "conceder", quantidade: 50, motivo: "auto-bônus" });
ok("jogador bloqueado no /pontos", r.status === 403, `status=${r.status}`);

// ---------- 3) Dois personagens, bônus diferentes ----------
const c2 = await apiJ("POST", `/api/campaigns/${CID}/characters`, { name: "PJ Dois", templateVersionId: VER });
const id2 = c2.json?.personagem?.id;
await apiM("POST", `/api/characters/${id2}/pontos`, { acao: "conceder", quantidade: 3, motivo: "Bônus menor" });
ok("3. bônus independentes (5 vs 3)", (await bonusDe(id1)) === 5 && (await bonusDe(id2)) === 3,
  `${await bonusDe(id1)} vs ${await bonusDe(id2)}`);

// ---------- 14/4) NPC nasce aprovado+selado (antecipado p/ reuso) ----------
const npc = await apiM("POST", `/api/campaigns/${CID}/characters`, { name: "NPC Bruto", templateVersionId: VER, isNpc: true });
ok("14. NPC criado", npc.status === 201, `status=${npc.status}`);
const idNpc = npc.json?.personagem?.id;
let fNpc = await ficha(idNpc, apiM);
ok("NPC nasce aprovado", npc.json?.personagem?.status === "aprovada", `status=${npc.json?.personagem?.status}`);
ok("NPC isNpc=true", npc.json?.personagem?.isNpc === true);
ok("NPC nasce com pontos selados", fNpc.ficha?.pontosBonus?.selado === true);

// Jogador não pode nem abrir NPC (não é dono nem mestre)
r = await apiJ("GET", `/api/characters/${idNpc}`);
ok("15. jogador sem acesso ao NPC", r.status === 403, `status=${r.status}`);
r = await apiJ("PATCH", `/api/characters/${idNpc}`, { data: { [CAMPO_NARR]: "invadido" } });
ok("jogador não edita NPC", r.status === 403, `status=${r.status}`);
// Mestre edita NPC livremente
r = await apiM("PATCH", `/api/characters/${idNpc}`, { data: { [CAMPO_NARR]: "Bruto da região", [CAMPO_PONTOS]: 2 } });
ok("16. mestre edita NPC", r.status === 200, `status=${r.status} ${JSON.stringify(r.json?.erro ?? "")}`);

// Jogador não pode criar NPC
r = await apiJ("POST", `/api/campaigns/${CID}/characters`, { name: "NPC fake", templateVersionId: VER, isNpc: true });
ok("jogador não cria NPC", r.status === 403, `status=${r.status}`);

// ---------- 4) Aprovação sela os pontos (PJ Selado) ----------
r = await apiJ("PATCH", `/api/characters/${id1}`, { status: "aguardando_aprovacao" });
ok("jogador envia p/ aprovação", r.status === 200, `status=${r.status}`);
r = await apiM("PATCH", `/api/characters/${id1}`, { status: "aprovada" });
ok("mestre aprova", r.status === 200, `status=${r.status}`);
f1 = await ficha(id1);
ok("4. selo aplicado na aprovação", f1.ficha?.pontosBonus?.selado === true);

// Jogador não altera NADA em ficha aprovada (nem narrativa)
r = await apiJ("PATCH", `/api/characters/${id1}`, { data: { [CAMPO_NARR]: "tentativa" } });
ok("ficha aprovada: jogador não edita campo narrativo", (await ficha(id1)).ficha?.campos?.[CAMPO_NARR] !== "tentativa");
// Nem muda status para contornar
r = await apiJ("PATCH", `/api/characters/${id1}`, { status: "rascunho" });
ok("jogador não tira ficha de aprovada", r.status === 403, `status=${r.status}`);

// ---------- 5/12) Reabrir libera narrativa, pontos seguem selados ----------
r = await apiM("PATCH", `/api/characters/${id1}`, { status: "reaberta" });
ok("mestre reabre ficha aprovada", r.status === 200, `status=${r.status} ${r.json?.erro ?? ""}`);
f1 = await ficha(id1);
ok("12. reaberta mantém selo de pontos", f1.ficha?.pontosBonus?.selado === true);
ok("status reaberta", f1.personagem?.status === "reaberta", `status=${f1.personagem?.status}`);

// Reabrir em ficha NÃO aprovada deve falhar
r = await apiM("PATCH", `/api/characters/${id2}`, { status: "reaberta" });
ok("reabrir ficha não-aprovada rejeitado", r.status === 400, `status=${r.status}`);

// 7) Jogador altera campo narrativo permitido -> OK
r = await apiJ("PATCH", `/api/characters/${id1}`, { data: { [CAMPO_NARR]: "Nome editado pós-reabertura" } });
ok("7. narrativa editável após reabrir", r.status === 200 && (await ficha(id1)).ficha?.campos?.[CAMPO_NARR] === "Nome editado pós-reabertura",
  `status=${r.status}`);

// 5) Jogador altera campo que consome pontos -> 403 selo
const prontAntes = (await ficha(id1)).ficha?.campos?.[CAMPO_PONTOS];
r = await apiJ("PATCH", `/api/characters/${id1}`, { data: { [CAMPO_PONTOS]: 4 } });
ok("5. jogador não altera campo de pontos (selado)", r.status === 403, `status=${r.status} ${r.json?.erro ?? ""}`);
ok("valor de pontos preservado", (await ficha(id1)).ficha?.campos?.[CAMPO_PONTOS] === prontAntes);

// 6) Jogador injeta __pontos direto -> descartado
r = await apiJ("PATCH", `/api/characters/${id1}`, { data: { [CAMPO_NARR]: "ok", __pontos: { bonus: 999, historico: [], selo: null } } });
ok("6. __pontos injetado é descartado", (await bonusDe(id1)) === 5, `bonus=${await bonusDe(id1)}`);

// 8) Mestre altera pontos diretamente na ficha -> OK
r = await apiM("PATCH", `/api/characters/${id1}`, { data: { [CAMPO_PONTOS]: 3 } });
ok("8. mestre altera campo de pontos", r.status === 200 && (await ficha(id1, apiM)).ficha?.campos?.[CAMPO_PONTOS] === 3,
  `status=${r.status} ${r.json?.erro ?? ""}`);

// 9/10/11) Endpoint /pontos: conceder e remover com motivo + histórico
r = await apiM("POST", `/api/characters/${id1}/pontos`, { acao: "conceder", quantidade: 4, motivo: "Bônus de nível" });
ok("9. concede +4", r.status === 200 && r.json?.pontos?.bonus === 9, `bonus=${r.json?.pontos?.bonus}`);
r = await apiM("POST", `/api/characters/${id1}/pontos`, { acao: "remover", quantidade: 2, motivo: "Correção de concessão" });
ok("10. remove -2", r.status === 200 && r.json?.pontos?.bonus === 7, `bonus=${r.json?.pontos?.bonus}`);
const hist = r.json?.pontos?.historico ?? [];
ok("11. histórico registra motivo/autor", hist.some((h) => h.motivo === "Bônus de nível" && h.quantidade === 4) && hist.some((h) => h.motivo === "Correção de concessão" && h.quantidade === -2),
  JSON.stringify(hist.map((h) => h.quantidade)));
// Bônus removido reflete no pool (10 + 7 = 17)
ok("pool reflete bônus pós-remoção", (await poolPrincipal(id1))?.disponiveis === 17, `disp=${(await poolPrincipal(id1))?.disponiveis}`);

// Jogador tenta alterar pontos DEPOIS do bônus — selo continua valendo
r = await apiJ("PATCH", `/api/characters/${id1}`, { data: { [CAMPO_PONTOS]: 5 } });
ok("selado mesmo após reabertura+bônus", r.status === 403, `status=${r.status}`);

// ---------- 13) Devolução de ficha não aprovada ----------
const c3 = await apiJ("POST", `/api/campaigns/${CID}/characters`, { name: "PJ Devolvida", templateVersionId: VER });
const id3 = c3.json?.personagem?.id;
await apiJ("PATCH", `/api/characters/${id3}`, { status: "aguardando_aprovacao" });
r = await apiM("PATCH", `/api/characters/${id3}`, { status: "devolvida" });
ok("13. mestre devolve ficha não-aprovada", r.status === 200 && (await ficha(id3)).personagem?.status === "devolvida",
  `status=${r.status} st=${(await ficha(id3)).personagem?.status}`);
// Devolvida NÃO tem selo — jogador pode editar pontos normalmente
r = await apiJ("PATCH", `/api/characters/${id3}`, { data: { [CAMPO_PONTOS]: 2 } });
ok("devolvida sem selo: pontos editáveis", r.status === 200, `status=${r.status} ${r.json?.erro ?? ""}`);

// ---------- 17) Persistência: novo GET reflete tudo ----------
const f1b = await ficha(id1, apiM);
ok("17. persistência bonus+selado+status", f1b.ficha?.pontosBonus?.bonus === 7 && f1b.ficha?.pontosBonus?.selado === true && f1b.personagem?.status === "reaberta",
  `bonus=${f1b.ficha?.pontosBonus?.bonus} selado=${f1b.ficha?.pontosBonus?.selado} st=${f1b.personagem?.status}`);

// ---------- resumo ----------
const falhas = resultados.filter((x) => !x.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} ok`);
if (falhas.length) { console.log("FALHAS:", falhas.map((f) => f.nome).join(" | ")); process.exit(1); }
