import assert from "node:assert/strict";
import { inferirGeneroVozDaFicha } from "../src/lib/voz.js";

const estrutura = {
  versao: 1,
  secoes: [{
    id: "identidade", titulo: "Identidade", ordem: 0,
    campos: [
      { id: "genero", label: "Gênero", tipo: "selecao_unica", semantico: "livre", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos", opcoes: ["Feminino", "Masculino"] },
      { id: "nome", label: "Nome", tipo: "texto", semantico: "livre", obrigatorio: false, repetivel: false, visibilidade: "todos", editavelPor: "ambos" },
      { id: "sexo_privado", label: "Sexo", tipo: "texto", semantico: "livre", obrigatorio: false, repetivel: false, visibilidade: "mestre", editavelPor: "mestre" }
    ]
  }],
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} }
};
assert.equal(inferirGeneroVozDaFicha(estrutura, { genero: "Feminino" }), "feminina");
assert.equal(inferirGeneroVozDaFicha(estrutura, { genero: "Masculino" }), "masculina");
assert.equal(inferirGeneroVozDaFicha(estrutura, { nome: "Maria" }), null);
assert.equal(inferirGeneroVozDaFicha(estrutura, { sexo_privado: "Feminino" }), null);
assert.equal(inferirGeneroVozDaFicha(estrutura, { genero: "outro" }), null);
assert.equal(inferirGeneroVozDaFicha({}, { genero: "Feminino" }), null);
console.log("Mestre Voice: 6 verificações aprovadas");
