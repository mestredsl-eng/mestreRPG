import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { gravarPapelStatusMembro } from "../src/lib/guildas-guarda.js";

function setup() {
  const sqlite = new Database(":memory:");
  sqlite.exec(\`
    CREATE TABLE guilds (id TEXT PRIMARY KEY, responsible_user_id TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE guild_members (
      id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER
    );
    INSERT INTO guilds (id, responsible_user_id) VALUES ('g1', 'u1');
    INSERT INTO users (id, status) VALUES ('u1', 'ativo'), ('u2', 'ativo');
    INSERT INTO guild_members (id, guild_id, user_id, role, status)
      VALUES ('m1', 'g1', 'u1', 'gm', 'ativo'),
             ('m2', 'g1', 'u2', 'gm', 'ativo');
  \`);
  return { sqlite, db: drizzle(sqlite) };
}

test("duas remoções concorrentes não removem o último GM capaz", async () => {
  const { sqlite, db } = setup();
  try {
    const primeira = await gravarPapelStatusMembro(db, "m1", "g1", "gm", "removido");
    const segunda = await gravarPapelStatusMembro(db, "m2", "g1", "gm", "removido");
    assert.equal(primeira, 1);
    assert.equal(segunda, 0);
    const restante = sqlite.prepare(\`
      SELECT count(*) AS total FROM guild_members gm
      JOIN users u ON u.id = gm.user_id
      WHERE gm.guild_id = 'g1' AND gm.role = 'gm' AND gm.status = 'ativo' AND u.status = 'ativo'
    \`).get() as { total: number };
    assert.equal(restante.total, 1);
  } finally { sqlite.close(); }
});

test("rebaixamento do último GM capaz é recusado mesmo sem responsável", async () => {
  const { sqlite, db } = setup();
  try {
    sqlite.prepare("UPDATE guilds SET responsible_user_id = NULL WHERE id = 'g1'").run();
    sqlite.prepare("UPDATE guild_members SET status = 'removido' WHERE id = 'm2'").run();
    const alterou = await gravarPapelStatusMembro(db, "m1", "g1", "membro", "ativo");
    assert.equal(alterou, 0);
  } finally { sqlite.close(); }
});
