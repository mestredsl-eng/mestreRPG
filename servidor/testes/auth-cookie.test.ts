import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// auth.ts executa getDb() no topo do módulo — o banco precisa apontar
// para um diretório temporário ANTES do import dinâmico (env lido no
// carregamento de db/index.ts).
const TMP = mkdtempSync(join(tmpdir(), "auth-cookie-"));
process.env.MESTRE_BANCO = join(TMP, "banco", "mestre-rpg.db");
process.env.MESTRE_ARQUIVOS = join(TMP, "arquivos", "campanhas");
process.env.MESTRE_BACKUPS = join(TMP, "backups");
process.env.MESTRE_STATE_DIR = join(TMP, "state");

const { extrairCookie, COOKIE_SESSAO } = await import("../src/middleware/auth.js");

test("extrairCookie preserva valores codificados que contêm '='", () => {
  const token = "abc==";
  const header = `${COOKIE_SESSAO}=${encodeURIComponent(token)}; outro=1`;
  assert.equal(extrairCookie(header, COOKIE_SESSAO), token);
});

test("extrairCookie ignora percent-encoding malformado", () => {
  const header = `${COOKIE_SESSAO}=%E0%A4%A`;
  assert.equal(extrairCookie(header, COOKIE_SESSAO), undefined);
});

test("extrairCookie não confunde nome semelhante com a sessão", () => {
  const header = `prefix_${COOKIE_SESSAO}=forjado; ${COOKIE_SESSAO}=legitimo`;
  assert.equal(extrairCookie(header, COOKIE_SESSAO), "legitimo");
});

test("extrairCookie aceita cabeçalho ausente como cookie ausente", () => {
  assert.equal(extrairCookie(undefined, COOKIE_SESSAO), undefined);
});
