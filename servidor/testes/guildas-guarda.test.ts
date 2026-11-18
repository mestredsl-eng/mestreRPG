import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { gravarPapelStatusMembro } from "../src/lib/guildas-guarda.js";

// responsible_user_id = 'u3': nenhum dos dois GMs (m1→u1, m2→u2) é o
// responsável — assim a proteção do último GM é exercida sozinha, sem
// contradição com a regra que protege o responsável atual.
function setup() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE guilds (id TEXT PRIMARY KEY, responsible_user_id TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE guild_members (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER
    );
    INSERT INTO guilds (id, responsible_user_id) VALUES ('g1', 'u3');
    INSERT INTO users (id, status) VALUES ('u1', 'ativo'), ('u2', 'ativo'), ('u3', 'ativo');
    INSERT INTO guild_members (id, guild_id, user_id, role, status)
      VALUES ('m1', 'g1', 'u1', 'gm', 'ativo'),
             ('m2', 'g1', 'u2', 'gm', 'ativo');
  `);
  return { sqlite, db: drizzle(sqlite) };
}

function contarGmCapazes(sqlite: Database.Database): number {
  const row = sqlite.prepare(`
    SELECT count(*) AS total FROM guild_members gm
    JOIN users u ON u.id = gm.user_id
    WHERE gm.guild_id = 'g1' AND gm.role = 'gm' AND gm.status = 'ativo' AND u.status = 'ativo'
  `).get() as { total: number };
  return row.total;
}

test("duas remoções concorrentes não removem o último GM capaz", async () => {
  const { sqlite, db } = setup();
  try {
    const primeira = await gravarPapelStatusMembro(db, "m1", "g1", "gm", "removido");
    const segunda = await gravarPapelStatusMembro(db, "m2", "g1", "gm", "removido");
    assert.equal(primeira, 1);
    assert.equal(segunda, 0);
    assert.equal(contarGmCapazes(sqlite), 1);
  } finally { sqlite.close(); }
});

test("remoção e rebaixamento combinados não deixam a guilda sem GM", async () => {
  const { sqlite, db } = setup();
  try {
    // rebaixa m1 para membro comum — permitido (ainda resta m2 como GM)
    const rebaixamento = await gravarPapelStatusMembro(db, "m1", "g1", "membro", "ativo");
    assert.equal(rebaixamento, 1);
    // agora m2 é o único GM capaz: removê-lo tem que ser bloqueado
    const remocao = await gravarPapelStatusMembro(db, "m2", "g1", "gm", "removido");
    assert.equal(remocao, 0);
    assert.equal(contarGmCapazes(sqlite), 1);
  } finally { sqlite.close(); }
});

test("proteção do último GM é independente de quem é o responsável", async () => {
  const { sqlite, db } = setup();
  try {
    // m2 passa a ser o responsável: a regra do responsável passa a
    // proteger m2, mas a guarda do último GM continua valendo para m1.
    sqlite.prepare("UPDATE guilds SET responsible_user_id = 'u2' WHERE id = 'g1'").run();
    const remocaoM1 = await gravarPapelStatusMembro(db, "m1", "g1", "gm", "removido");
    assert.equal(remocaoM1, 1);
    // m2 é o último GM capaz E o responsável — bloqueado pelas duas regras
    const remocaoM2 = await gravarPapelStatusMembro(db, "m2", "g1", "gm", "removido");
    assert.equal(remocaoM2, 0);
    assert.equal(contarGmCapazes(sqlite), 1);
  } finally { sqlite.close(); }
});

test("GM de conta bloqueada pode ser removido — ela nunca foi capaz", async () => {
  const { sqlite, db } = setup();
  try {
    // u2 (dona de m2) fica com a conta bloqueada: m2 não é GM capaz.
    // Removê-la não pode ser bloqueado pela guarda do último capaz.
    sqlite.prepare("UPDATE users SET status = 'bloqueado' WHERE id = 'u2'").run();
    const remocao = await gravarPapelStatusMembro(db, "m2", "g1", "gm", "removido");
    assert.equal(remocao, 1);
    // m1 segue como único GM capaz — agora sim a guarda protege.
    const segunda = await gravarPapelStatusMembro(db, "m1", "g1", "gm", "removido");
    assert.equal(segunda, 0);
    assert.equal(contarGmCapazes(sqlite), 1);
  } finally { sqlite.close(); }
});

test("rebaixamento do último GM capaz é recusado mesmo sem responsável", async () => {
  const { sqlite, db } = setup();
  try {
    sqlite.prepare("UPDATE guilds SET responsible_user_id = NULL WHERE id = 'g1'").run();
    sqlite.prepare("UPDATE guild_members SET status = 'removido' WHERE id = 'm2'").run();
    const alterou = await gravarPapelStatusMembro(db, "m1", "g1", "membro", "ativo");
    assert.equal(alterou, 0);
    assert.equal(contarGmCapazes(sqlite), 1);
  } finally { sqlite.close(); }
});
