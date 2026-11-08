// Limpeza de lancamento v1.0 — remove dados de teste preservando admin, modelos e configs.
// Uso: node limpeza-lancamento.mjs <caminho-banco.db> --aplicar
// O banco definitivo (banco/mestre-rpg.db) exige adicionalmente --definitivo.
import Database from "better-sqlite3";

const caminho = process.argv[2];
if (!caminho) { console.error("uso: node limpeza-lancamento.mjs <banco.db> --aplicar"); process.exit(1); }

const ADMIN_MANTER = "administrador"; // conta preservada (decisao do usuario)
// Guarda: sem --aplicar nada acontece; o banco definitivo exige --definitivo.
const ehDefinitivo = caminho.replace(/\\/g, "/").endsWith("banco/mestre-rpg.db");
if (!process.argv.includes("--aplicar") || (ehDefinitivo && !process.argv.includes("--definitivo"))) {
  console.error("Abortado. Uso: node limpeza-lancamento.mjs <copia.db> --aplicar  |  banco/mestre-rpg.db --aplicar --definitivo");
  process.exit(2);
}
const db = new Database(caminho);
db.pragma("busy_timeout = 15000");
db.pragma("foreign_keys = ON");

const cont = (sql, ...p) => db.prepare(sql).get(...p).c;
const snap = () => ({
  users: cont("select count(*) c from users"),
  campaigns: cont("select count(*) c from campaigns"),
  characters: cont("select count(*) c from characters"),
  sheet_templates: cont("select count(*) c from sheet_templates"),
  sheet_versions: cont("select count(*) c from sheet_versions"),
  server_settings: cont("select count(*) c from server_settings"),
  audit_logs: cont("select count(*) c from audit_logs"),
});

console.log("ANTES:", JSON.stringify(snap()));

const tx = db.transaction(() => {
  const adminId = db.prepare("select id from users where username=?").get(ADMIN_MANTER)?.id;
  if (!adminId) throw new Error(`admin '${ADMIN_MANTER}' nao encontrado`);

  // 1. audit_logs: remove os ligados a campanhas (todas serao removidas) e a usuarios removidos
  const idsRemover = db.prepare("select id from users where username<>?").all(ADMIN_MANTER).map(r => r.id);
  const ph = idsRemover.map(() => "?").join(",");
  const auditCamp = db.prepare("select count(*) c from audit_logs where campaign_id is not null").get().c;
  const auditUsers = db.prepare(`select count(*) c from audit_logs where actor_id in (${ph})`).get(...idsRemover).c;
  db.prepare("delete from audit_logs where campaign_id is not null").run();
  db.prepare(`delete from audit_logs where actor_id in (${ph})`).run(...idsRemover);
  console.log(`audit_logs removidos: ${auditCamp}+${auditUsers} (restam os globais do admin)`);

  // 2. sheet_templates ANTES das campanhas: campaign_id e NO ACTION (nao cascateia).
  //    Desvincula da campanha e reatribui dono ao admin mantido (owner_id NO ACTION).
  const tplAdmin = db.prepare("select count(*) c from sheet_templates where owner_id<>?").get(adminId).c;
  db.prepare("update sheet_templates set campaign_id=null, owner_id=?").run(adminId);
  console.log(`sheet_templates desvinculados: ${cont("select count(*) c from sheet_templates")} (${tplAdmin} reatribuídos)`);

  // 3. campanhas: CASCADE resolve memberships, characters, sessions, files, etc.
  const nCamp = cont("select count(*) c from campaigns");
  db.prepare("delete from campaigns").run();
  console.log(`campaigns removidas: ${nCamp}`);

  // 4. sessoes antigas: remove todas (forca novo login; credenciais preservadas)
  const nSess = cont("select count(*) c from auth_sessions");
  db.prepare("delete from auth_sessions").run();
  console.log(`auth_sessions removidas: ${nSess}`);

  // 5. usuarios: mantem apenas o admin
  db.prepare(`delete from users where username<>?`).run(ADMIN_MANTER);
  console.log(`usuarios removidos: ${idsRemover.length}`);
});

try {
  tx();
} catch (e) {
  console.error("FALHOU (rollback):", e.message);
  process.exit(1);
}

const depois = snap();
console.log("DEPOIS:", JSON.stringify(depois));
console.log("integrity:", db.pragma("integrity_check", { simple: true }));
const fk = db.pragma("foreign_key_check");
console.log("fk_check violacoes:", fk.length, fk.slice(0, 5));

// orfaos: users restantes e suas sessoes
console.log("usuarios restantes:", db.prepare("select username,is_admin from users").all());
console.log("auth_sessions restantes:", cont("select count(*) c from auth_sessions"));
console.log("tabelas zeradas:", ["campaigns","characters","memberships","invitations","sessions","chat_messages","tests","rolls","turns","notes","files","folders","snapshots","money_transactions","financial_accounts","inventory_entries","equipment_entries","vehicles","item_templates","rule_sets","rule_definitions","backups","note_attachments","character_fields"].filter(t => cont(`select count(*) c from ${t}`) === 0).length, "/24");

db.close();
