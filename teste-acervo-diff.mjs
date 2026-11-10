// Regressão do diff do acervo: itens novos no arquivo não podem mascarar itens existentes ausentes.
// Executar após npm run build: node teste-acervo-diff.mjs
import assert from "node:assert/strict";
import { diffLivro } from "./servidor/dist/lib/biblioteca.js";

const existente = { id: "livro-1", titulo: "Livro teste", descricao: null, autor: null, sistema: null, edicao: null, tipo: "livro", versao: 1 };
const itensDb = [
  { id: "1", kind: "atributo", key: "forca", name: "Força", category: null, parentKey: null, definition: {}, ordem: 0 },
  { id: "2", kind: "habilidade", key: "antiga", name: "Antiga", category: null, parentKey: null, definition: {}, ordem: 1 },
  { id: "3", kind: "talento", key: "outro", name: "Outro", category: null, parentKey: null, definition: {}, ordem: 2 },
];
const livro = { titulo: "Livro teste", tipo: "livro", itens: [
  { kind: "atributo", key: "forca", name: "Força", definition: {}, ordem: 0 },
  { kind: "habilidade", key: "nova", name: "Nova", definition: {}, ordem: 1 },
] };
const resultado = diffLivro(livro, existente, itensDb);
assert.equal(resultado.itensNovos.length, 1);
assert.equal(resultado.itensIdenticos, 1);
assert.equal(resultado.itensAusentesPreservados, 2);
const semNovos = diffLivro({ ...livro, itens: [livro.itens[0]] }, existente, itensDb);
assert.equal(semNovos.itensAusentesPreservados, 2);
console.log("2/2 testes do diff do acervo passaram.");
