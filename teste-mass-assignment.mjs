// Mass assignment / campos inesperados — Issue #296 (item 6 da matriz).
// Prova que payloads poluídos não escapam da validação: chaves "__"
// reservadas (__xp/__sangue), campos fora do modelo, colunas de outras
// tabelas (userId/campaignId/isAdmin) e JSON malformado. Tudo com
// readback no banco — nunca confiar na resposta HTTP.
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req, abrirDb,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("mass-assignment");
const BANCO = join(DIR, "mestre-rpg-teste.db");
const PORTA = await portaLivre();
const BASE = `http://127.0.0.1:${PORTA}`;
let proc;

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO);
  const CID = c.campId;
  const j1 = c.jogadores.jogador1;
  // ficha do jogador1 já com ledgers legítimos — injeção não pode tocá-los
  const charJ1 = c.novoPersonagem(j1.membershipId, "Personagem J1", {
    __xp: { saldo: 10, ancora: 0, historico: [] },
    __sangue: { saldo: 2, usos: {}, historico: [] },
  });

  sec("Ficha — data.* com chaves reservadas e fora do modelo");
  {
    const poluido = {
      data: {
        for: 9,
        __xp: { saldo: 99999, historico: [{ tipo: "concessao", quantidade: 99999 }] },
        __sangue: { saldo: 777, usos: {}, historico: [] },
        campo_falso_injetado: "hackeado",
        __proto__: { poluido: true },
      },
    };
    const r = await req(BASE, "PATCH", `/characters/${charJ1}`, { cookie: c.cookieMestre, body: poluido });
    t("mestre PATCH aceito", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    const db = abrirDb(BANCO);
    const row = db.prepare("select data from characters where id=?").get(charJ1);
    db.close();
    const data = JSON.parse(row.data);
    t("campo legítimo 'for' atualizado", data.for === 9, `for=${data.for}`);
    t("__xp injetado descartado (saldo preservado)", data.__xp?.saldo === 10, JSON.stringify(data.__xp).slice(0, 120));
    t("__sangue injetado descartado", data.__sangue?.saldo === 2, JSON.stringify(data.__sangue).slice(0, 120));
    t("campo fora do modelo não persistiu", !("campo_falso_injetado" in data));
    t("__proto__ não virou chave própria", !Object.prototype.hasOwnProperty.call(data, "__proto__") || data.__proto__?.poluido !== true);
  }

  sec("Ficha — jogador injeta ledger na própria ficha");
  {
    const r = await req(BASE, "PATCH", `/characters/${charJ1}`, {
      cookie: j1.cookie,
      body: { data: { __xp: { saldo: 55555 }, __sangue: { saldo: 99 }, for: 9 } },
    });
    t("jogador PATCH processado (200 ou 400 legítimo)", r.status === 200 || r.status === 400, `status=${r.status}`);
    const db = abrirDb(BANCO);
    const row = db.prepare("select data from characters where id=?").get(charJ1);
    db.close();
    const data = JSON.parse(row.data);
    t("__xp do jogador não foi adulterado", data.__xp?.saldo === 10, `saldo=${data.__xp?.saldo}`);
    t("__sangue do jogador não foi adulterado", data.__sangue?.saldo === 2, `saldo=${data.__sangue?.saldo}`);
  }

  sec("Membership — payload poluído no PATCH do mestre");
  {
    const db0 = abrirDb(BANCO);
    const antes = db0.prepare("select user_id, campaign_id, role, status from memberships where id=?").get(j1.membershipId);
    const adminAntes = db0.prepare("select is_admin from users where id=?").get(j1.id).is_admin;
    db0.close();
    const r = await req(BASE, "PATCH", `/campaigns/${CID}/members/${j1.membershipId}`, {
      cookie: c.cookieMestre,
      body: {
        role: "espectador",
        userId: "usuario-invasor", campaignId: "campanha-invasora", id: "membership-falsa",
        isAdmin: true, permissions: { enviarMensagens: false }, status: "ativo",
      },
    });
    t("PATCH membro aceito", r.status === 200, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    const db = abrirDb(BANCO);
    const depois = db.prepare("select id, user_id, campaign_id, role, status, permissions from memberships where user_id=? and campaign_id=?").get(j1.id, CID);
    const adminDepois = db.prepare("select is_admin from users where id=?").get(j1.id).is_admin;
    db.close();
    t("role/status aplicados conforme schema", depois?.role === "espectador" && depois?.status === "ativo", JSON.stringify(depois));
    t("user_id/campaign_id/id não foram trocados", depois?.id === j1.membershipId && depois?.user_id === antes.user_id && depois?.campaign_id === antes.campaign_id);
    t("is_admin do usuário inalterado", adminDepois === adminAntes && adminDepois === 0);
    const perms = typeof depois?.permissions === "string" ? JSON.parse(depois.permissions) : (depois?.permissions ?? {});
    t("permissions mescladas (só chave válida)", perms.enviarMensagens === false, JSON.stringify(perms));
  }

  sec("Admin — PATCH /admin/users com campos estranhos");
  {
    const r = await req(BASE, "PATCH", `/admin/users/${j1.id}`, {
      cookie: c.cookieMestre,
      body: {
        displayName: "Nome Poluido", role: "mestre", campaignId: "x", permissions: { admin: true },
        isAdmin: undefined, password: undefined,
      },
    });
    // isAdmin/password omitidos de propósito: são campos legítimos do schema
    // e têm guardas próprias — aqui provamos que o resto é descartado.
    t("PATCH admin processado", r.status === 200 || r.status === 400, `status=${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
    const db = abrirDb(BANCO);
    const u = db.prepare("select display_name, is_admin, status from users where id=?").get(j1.id);
    db.close();
    t("displayName aplicado", u?.display_name === "Nome Poluido", JSON.stringify(u));
    t("is_admin NÃO escalado pela poluição", u?.is_admin === 0);
  }

  sec("Erro — JSON malformado não vaza stack/detalhe interno");
  {
    const r = await fetch(`${BASE}/api/campaigns/${CID}/members/${j1.membershipId}`, {
      method: "PATCH",
      headers: { cookie: c.cookieMestre, "content-type": "application/json" },
      body: "{quebrado",
    });
    const txt = await r.text();
    t("400 sem stack trace", r.status === 400 && !/at\s+\S+\s+\(|node:internal|servidor\\src|servidor\/src/i.test(txt), txt.slice(0, 120));
  }
} catch (e) {
  fail++;
  console.error("  FALHOU exceção:", e?.message ?? e);
} finally {
  try { if (proc) await encerrarServidor(proc); } finally { if (DIR) limparDir(DIR); }
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
