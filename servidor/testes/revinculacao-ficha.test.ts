/**
 * C7/R1.3 — pré-validação de revinculação de ficha (Issue #186).
 * Helper puro: classifica cada chave de characters.data, valida
 * campos contra a estrutura destino e preserva ledgers reservados.
 * Não persiste nada — é apenas a PRÉVIA.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAVES_RESERVADAS_REVINCULACAO,
  preverRevinculacaoFicha,
  SUFIXO_SALDO_CARTEIRA,
} from "../src/lib/revinculacao-ficha.js";
import type { EstruturaFicha } from "../src/lib/ficha.js";

// ---------- fixtures ----------

function estruturaBase(): EstruturaFicha {
  return {
    versao: 1,
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    secoes: [
      {
        id: "s1",
        titulo: "Principal",
        ordem: 0,
        campos: [
          { id: "nome", label: "Nome", tipo: "texto", semantico: "livre", padrao: "" },
          { id: "forca", label: "Força", tipo: "inteiro", semantico: "atributo", padrao: 1, minimo: 1, maximo: 10 },
          {
            id: "raca",
            label: "Raça",
            tipo: "selecao_unica",
            semantico: "livre",
            padrao: "",
            opcoes: ["Humano", "Vampiro"],
          },
          {
            id: "dotes",
            label: "Dotes",
            tipo: "selecao_nivel",
            semantico: "talento",
            padrao: [],
          },
          {
            id: "dinheiro",
            label: "Dinheiro",
            tipo: "tabela",
            semantico: "moeda",
            padrao: [],
            carteira: { saldoEditavelPor: "mestre" },
            colunas: [
              { key: "tipo", label: "Tipo", tipo: "selecao", opcoes: ["entrada", "saida"] },
              { key: "valor", label: "Valor", tipo: "moeda" },
            ],
          },
        ],
      },
    ],
  } as EstruturaFicha;
}

function dadosBase(): Record<string, unknown> {
  return {
    nome: "Kael",
    forca: 5,
    raca: "Humano",
    dotes: [{ key: "luta", nivel: 2 }],
    dinheiro: [{ tipo: "entrada", valor: 100 }],
    "dinheiro::saldo": 50,
  };
}

function dadosComReservados(): Record<string, unknown> {
  return {
    ...dadosBase(),
    __xp: { saldo: 120, historico: [{ tipo: "concessao" }], financiado: { forca: [1, 2] } },
    __sangue: { saldo: 3, usos: { "d10:abc": { tipo: "uso" } }, historico: [], capacidade: 5 },
    __hp: { atual: 10, maximo: 20, historico: [] },
    __vitalidade: { nivel: 2, historico: [] },
    __pontos: { selo: 4, bonus: 1, historico: [] },
    __retrato: { arquivo: "retrato/kael.png", mime: "image/png" },
    __npcVisivel: { visivel: true },
    __arquivamento: { statusAnterior: "aprovada", em: "2026-01-01" },
  };
}

function snapshot<T>(v: T): T {
  return structuredClone(v);
}

// ---------- 1. ficha compatível ----------

describe("prévia compatível", () => {
  it("estrutura idêntica → prévia ok, sem mutar entrada", () => {
    const origem = estruturaBase();
    const destino = estruturaBase();
    const dados = dadosComReservados();
    const antes = snapshot(dados);

    const r = preverRevinculacaoFicha(origem, destino, dados);
    assert.equal(r.ok, true, JSON.stringify(r.incompatibilidades));
    assert.deepEqual(r.dados?.nome, "Kael");
    assert.deepEqual(r.dados?.forca, 5);
    assert.deepEqual(r.dados?.["dinheiro::saldo"], 50);
    // entrada intacta
    assert.deepEqual(dados, antes);
  });
});

// ---------- 2. campo ausente no destino ----------

describe("campo ausente na estrutura destino", () => {
  it("campo da origem sem correspondente → falha com relatório", () => {
    const origem = estruturaBase();
    const destino = estruturaBase();
    destino.secoes[0].campos = destino.secoes[0].campos.filter((c) => c.id !== "dotes");
    const dados = { ...dadosBase(), dotes: [{ key: "luta", nivel: 2 }] };

    const r = preverRevinculacaoFicha(origem, destino, dados);
    assert.equal(r.ok, false);
    const inc = r.incompatibilidades.find((i) => i.chave === "dotes");
    assert.equal(inc?.motivo, "campo_ausente_na_estrutura_destino");
    assert.equal(r.dados, undefined, "prévia falha não devolve dados");
  });
});

// ---------- 3. mesmo ID, tipo/valor incompatível ----------

describe("mesmo ID com valor incompatível", () => {
  it("inteiro recebe texto → valor_invalido", () => {
    const r = preverRevinculacaoFicha(estruturaBase(), estruturaBase(), {
      ...dadosBase(),
      forca: "muito forte",
    });
    assert.equal(r.ok, false);
    assert.ok(r.incompatibilidades.some((i) => i.chave === "forca" && i.motivo === "valor_invalido"));
  });

  it("selecao_unica com opção inexistente no destino → valor_invalido", () => {
    const origem = estruturaBase();
    const destino = estruturaBase();
    // destino restringe Raça a outro conjunto de opções
    destino.secoes[0].campos = destino.secoes[0].campos.map((c) =>
      c.id === "raca" ? { ...c, opcoes: ["Elfo", "Anão"] } : c,
    );
    const r = preverRevinculacaoFicha(origem, destino, dadosBase());
    assert.equal(r.ok, false);
    assert.ok(r.incompatibilidades.some((i) => i.chave === "raca" && i.motivo === "valor_invalido"));
  });

  it("selecao_nivel com nível fora de 1..5 → valor_invalido", () => {
    const r = preverRevinculacaoFicha(estruturaBase(), estruturaBase(), {
      ...dadosBase(),
      dotes: [{ key: "luta", nivel: 9 }],
    });
    assert.equal(r.ok, false);
    assert.ok(r.incompatibilidades.some((i) => i.chave === "dotes" && i.motivo === "valor_invalido"));
  });
});

// ---------- 4. múltiplas incompatibilidades ----------

describe("relatório completo", () => {
  it("todas as incompatibilidades são reportadas numa única prévia", () => {
    const origem = estruturaBase();
    const destino = estruturaBase();
    destino.secoes[0].campos = destino.secoes[0].campos.filter((c) => c.id !== "raca");
    const dados = {
      ...dadosBase(),
      forca: "abc",          // valor inválido
      chaveEstranha: 1,      // não classificada
      "__misteriosa": {},    // reservada desconhecida
    };
    const r = preverRevinculacaoFicha(origem, destino, dados);
    assert.equal(r.ok, false);
    const motivos = r.incompatibilidades.map((i) => `${i.chave}:${i.motivo}`).sort();
    assert.deepEqual(motivos, [
      "__misteriosa:chave_reservada_desconhecida",
      "chaveEstranha:chave_nao_classificada",
      "forca:valor_invalido",
      "raca:campo_ausente_na_estrutura_destino",
    ]);
  });
});

// ---------- 5. carteira e ::saldo ----------

describe("carteira e saldo sintético", () => {
  it("campo carteira + <id>::saldo compatíveis → saldo preservado", () => {
    const r = preverRevinculacaoFicha(estruturaBase(), estruturaBase(), dadosBase());
    assert.equal(r.ok, true, JSON.stringify(r.incompatibilidades));
    assert.deepEqual(r.dados?.dinheiro, [{ tipo: "entrada", valor: 100 }]);
    assert.equal(r.dados?.[`dinheiro${SUFIXO_SALDO_CARTEIRA}`], 50);
  });

  it("::saldo de campo que não é carteira na origem → bloqueia", () => {
    const origem = estruturaBase();
    // "forca" é inteiro, não carteira — saldo órfão é inválido
    const r = preverRevinculacaoFicha(origem, estruturaBase(), {
      ...dadosBase(),
      "forca::saldo": 10,
    });
    assert.equal(r.ok, false);
    assert.ok(r.incompatibilidades.some((i) => i.chave === "forca::saldo" && i.motivo === "saldo_sem_campo_carteira"));
  });

  it("::saldo cujo campo some no destino → incompatibilidade", () => {
    const origem = estruturaBase();
    const destino = estruturaBase();
    destino.secoes[0].campos = destino.secoes[0].campos.map((c) =>
      c.id === "dinheiro" ? { ...c, carteira: undefined } : c,
    );
    const r = preverRevinculacaoFicha(origem, destino, dadosBase());
    assert.equal(r.ok, false);
    assert.ok(
      r.incompatibilidades.some(
        (i) => i.chave === `dinheiro${SUFIXO_SALDO_CARTEIRA}` && i.motivo === "campo_ausente_na_estrutura_destino",
      ),
    );
  });
});

// ---------- 6/10. ledgers reservados preservados verbatim ----------

describe("ledgers e metadados reservados", () => {
  it("todas as chaves reservadas confirmadas são preservadas sem alteração", () => {
    const dados = dadosComReservados();
    const r = preverRevinculacaoFicha(estruturaBase(), estruturaBase(), dados);
    assert.equal(r.ok, true, JSON.stringify(r.incompatibilidades));
    for (const chave of CHAVES_RESERVADAS_REVINCULACAO) {
      assert.deepEqual(r.dados?.[chave], dados[chave], `chave ${chave} deve ser preservada`);
      // cópia independente — mutar a saída não afeta a entrada
      assert.notEqual(r.dados?.[chave], dados[chave]);
    }
  });

  it("retrato e pontos selados vivem DENTRO de data como __retrato/__pontos", () => {
    // Prova documental: schema.ts characters.data é um único JSON e
    // templateVersionId é coluna separada — logo retrato e selo de
    // pontos NÃO são colunas; são chaves reservadas em data
    // (personagens.ts CHAVE_RETRATO, pontos.ts CHAVE_PONTOS).
    // O helper as preserva como qualquer outro ledger.
    const dados = dadosComReservados();
    const seloOriginal = structuredClone(dados.__pontos);
    const retratoOriginal = structuredClone(dados.__retrato);
    const r = preverRevinculacaoFicha(estruturaBase(), estruturaBase(), dados);
    assert.equal(r.ok, true);
    assert.deepEqual(r.dados?.__pontos, seloOriginal);
    assert.deepEqual(r.dados?.__retrato, retratoOriginal);
  });
});

// ---------- 7. chaves desconhecidas bloqueiam ----------

describe("chaves não classificadas", () => {
  it("__desconhecida e chave arbitrária → bloqueio, nunca descarte", () => {
    const r = preverRevinculacaoFicha(estruturaBase(), estruturaBase(), {
      ...dadosBase(),
      __invasor: { qualquer: "coisa" },
      lixoAleatorio: 42,
    });
    assert.equal(r.ok, false);
    assert.ok(r.incompatibilidades.some((i) => i.chave === "__invasor" && i.motivo === "chave_reservada_desconhecida"));
    assert.ok(r.incompatibilidades.some((i) => i.chave === "lixoAleatorio" && i.motivo === "chave_nao_classificada"));
  });
});

// ---------- 8. valores que validarFicha descartaria ----------

describe("nada desaparece silenciosamente", () => {
  it("campo calculado no destino com valor → incompatibilidade", () => {
    const destino = estruturaBase();
    destino.secoes[0].campos.push({
      id: "total",
      label: "Total",
      tipo: "calculado",
      semantico: "livre",
      padrao: 0,
      formula: "forca*2",
    } as EstruturaFicha["secoes"][number]["campos"][number]);
    // origem também tem "total" como campo comum — o valor não pode
    // ser carregado para um campo calculado
    const origem = estruturaBase();
    origem.secoes[0].campos.push({
      id: "total",
      label: "Total",
      tipo: "inteiro",
      semantico: "livre",
      padrao: 0,
    } as EstruturaFicha["secoes"][number]["campos"][number]);
    const r = preverRevinculacaoFicha(origem, destino, { ...dadosBase(), total: 10 });
    assert.equal(r.ok, false);
    assert.ok(r.incompatibilidades.some((i) => i.chave === "total" && i.motivo === "campo_calculado_com_valor"));
  });

  it("campo do destino ausente nos dados → não é inventado (sem defaults)", () => {
    const parcial = { nome: "Kael" }; // forca/raca/dotes/dinheiro ausentes
    const r = preverRevinculacaoFicha(estruturaBase(), estruturaBase(), parcial);
    assert.equal(r.ok, true);
    assert.equal(r.dados?.nome, "Kael");
    assert.equal("forca" in (r.dados ?? {}), false, "default não pode ser aplicado");
    assert.equal("raca" in (r.dados ?? {}), false);
  });
});

// ---------- 9. ficha vazia / estrutura sem campos ----------

describe("casos degenerados", () => {
  it("data vazia → prévia ok sem inventar nada", () => {
    const r = preverRevinculacaoFicha(estruturaBase(), estruturaBase(), {});
    assert.equal(r.ok, true);
    assert.deepEqual(r.dados, {});
  });

  it("estrutura destino sem campos + data só com reservadas → ok", () => {
    const vazia = {
      versao: 1,
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
      secoes: [],
    } as EstruturaFicha;
    const r = preverRevinculacaoFicha(estruturaBase(), vazia, {
      __xp: { saldo: 1 },
      __sangue: { saldo: 2 },
    });
    assert.equal(r.ok, true, JSON.stringify(r.incompatibilidades));
    assert.deepEqual(r.dados?.__xp, { saldo: 1 });
    assert.deepEqual(r.dados?.__sangue, { saldo: 2 });
  });

  it("estrutura destino sem campos + campo de dados → falha", () => {
    const vazia = {
      versao: 1,
      pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
      secoes: [],
    } as EstruturaFicha;
    const r = preverRevinculacaoFicha(estruturaBase(), vazia, { nome: "Kael" });
    assert.equal(r.ok, false);
    // "nome" é campo da origem mas não do destino → campo ausente
    assert.ok(r.incompatibilidades.some((i) => i.motivo === "campo_ausente_na_estrutura_destino"));
  });

  it("data não-objeto → falha explícita", () => {
    const r = preverRevinculacaoFicha(
      estruturaBase(),
      estruturaBase(),
      null as unknown as Record<string, unknown>,
    );
    assert.equal(r.ok, false);
    assert.equal(r.incompatibilidades[0]?.motivo, "dados_invalidos");
  });
});
