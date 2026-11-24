import assert from "node:assert/strict";
import test from "node:test";
import { extrairCookie, COOKIE_SESSAO } from "../src/middleware/auth.js";

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
