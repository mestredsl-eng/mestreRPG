import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAVE_SANGUE,
  LIMITE_USOS_AVISO,
  MAX_HISTORICO_SANGUE,
  gravarCacheCapacidade,
  lerSangue,
  registrarAjusteSangue,
  registrarAtivacaoSangue,
  registrarRecuperacaoSangue,
  registrarUsoD10,
  reconciliarCapacidadeSangue,
  resolverCapacidadeSangue,
  resolverNaturezaSangue,
  resolverSanguePersonagem,
  usoSangueValido,
  usosSangueValidos,
  validarVinculosSangue,
  type ConfigSangue,
  type EstadoSangue,
} from "../src/lib/sangue.js";
import type { EstruturaFicha } from "../src/lib/ficha.js";

// ---------- fixtures ----------

const PID = "11111111-2222-4333-8444-555555555555";
const PID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TEST1 = "99999999-8888-4777-8666-555555555555";
const TEST2 = "99999999-8888-4777-8666-666666666666";
const REQ1 = "12345678-1234-4234-8234-123456789abc";
const REQ2 = "12345678-1234-4234-8234-abcdefabcdef";
const AUTOR = { personagemId: PID, autorId: "user-1", autorNome: "Mestre" };

function estruturaBase(): EstruturaFicha {
  return {
    versao: 1,
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    secoes: [
      {
        id: "s1",
        titulo: "Sangue",
        ordem: 0,
        campos: [
          { id: "cap", label: "Pontos de Sangue", tipo: "inteiro", semantico: "livre", padrao: 0 },
          {
            id: "nat",
            label: "Raça",
            tipo: "selecao_unica",
            semantico: "livre",
            padrao: "",
            opcoes: ["Humano", "Vampiro", "Lobisomem", "Animal"],
          },
          {
            id: "qual",
            label: "Qualidades",
            tipo: "selecao_nivel",
            semantico: "vantagem",
            padrao: [],
          },
        ],
      },
    ],
  } as EstruturaFicha;
}

function estruturaSemCapacidade(): EstruturaFicha {
  const e = estruturaBase();
  e.secoes[0].campos = e.secoes[0].campos.filter((c) => c.id !== "cap");
  return e;
}

function configBase(): ConfigSangue {
  return {
    habilitado: true,
    campoCapacidadeId: "cap",
    campoNaturezaId: "nat",
    naturezas: {
      Humano: { metaHumanoComPoder: true, recuperacao: "descansar" },
      Vampiro: { metaHumanoComPoder: false, recuperacao: "alimentar-se" },
      Lobisomem: { metaHumanoComPoder: false },
      Animal: { metaHumanoComPoder: false },
    },
    recuperacaoSangue: { habilitado: true },
  };
}

function dadosCom(cap = 5, nat = "Humano"): Record<string, unknown> {
  return { cap, nat };
}

// ---------- validação de schema de usos ----------

describe("usoSangueValido — contrato discriminado por prefixo", () => {
  it("d10: exige testId igual ao sufixo e personagemId UUID", () => {
    const u = { tipo: "uso", em: new Date().toISOString(), personagemId: PID, testId: TEST1 };
    assert.equal(usoSangueValido(`d10:${TEST1}`, u), true);
    assert.equal(usoSangueValido(`d10:${TEST2}`, u), false); // testId divergente
    assert.equal(usoSangueValido(`d10:${TEST1}`, { ...u, tipo: "recuperacao" }), false);
    assert.equal(usoSangueValido("d10:nao-uuid", u), false);
    assert.equal(usoSangueValido(`d10:${TEST1}`, { ...u, personagemId: "x" }), false);
    assert.equal(usoSangueValido(`d10:${TEST1}`, { ...u, em: "data-ruim" }), false);
  });

  it("ativar: exige requestId UUID e poderKey", () => {
    const u = { tipo: "uso", em: new Date().toISOString(), personagemId: PID, requestId: REQ1, poderKey: "magia" };
    assert.equal(usoSangueValido(`ativar:${REQ1}`, u), true);
    assert.equal(usoSangueValido(`ativar:${REQ1}`, { ...u, requestId: undefined }), false);
    assert.equal(usoSangueValido(`ativar:${REQ1}`, { ...u, poderKey: "" }), false);
    assert.equal(usoSangueValido(`ativar:${REQ2}`, u), false); // sufixo ≠ requestId não é exigido pelo schema? — sufixo é o requestId
  });

  it("recuperar: exige quantidade positiva", () => {
    const u = { tipo: "recuperacao", em: new Date().toISOString(), personagemId: PID, quantidade: 2 };
    assert.equal(usoSangueValido(`recuperar:${REQ1}`, u), true);
    assert.equal(usoSangueValido(`recuperar:${REQ1}`, { ...u, quantidade: 0 }), false);
    assert.equal(usoSangueValido(`recuperar:${REQ1}`, { ...u, quantidade: -1 }), false);
    assert.equal(usoSangueValido(`recuperar:${REQ1}`, { ...u, tipo: "uso" }), false);
  });

  it("ajustar: exige requestId UUID = sufixo e delta finito ≠ 0", () => {
    const u = { tipo: "uso", em: new Date().toISOString(), personagemId: PID, requestId: REQ1, delta: 2, motivo: "x" };
    assert.equal(usoSangueValido(`ajustar:${REQ1}`, u), true);
    assert.equal(usoSangueValido(`ajustar:${REQ1}`, { ...u, requestId: undefined }), false);
    assert.equal(usoSangueValido(`ajustar:${REQ1}`, { ...u, delta: 0 }), false);
    assert.equal(usoSangueValido(`ajustar:${REQ1}`, { ...u, delta: Number.NaN }), false);
    assert.equal(usoSangueValido(`ajustar:${REQ1}`, { ...u, tipo: "recuperacao" }), false);
    assert.equal(usoSangueValido(`ajustar:${REQ1}`, { ...u, motivo: 42 }), false);
  });

  it("prefixo desconhecido ou chave malformada → inválido", () => {
    assert.equal(usoSangueValido("ajustar:abc", {}), false);
    assert.equal(usoSangueValido("d10:", {}), false);
    assert.equal(usoSangueValido("D10:" + TEST1, { tipo: "uso", em: "2026-01-01", personagemId: PID, testId: TEST1 }), false);
  });
});

// ---------- leitura fail-closed ----------

describe("lerSangue — fail-closed", () => {
  it("personagem sem __sangue → estado vazio válido", () => {
    const r = lerSangue({});
    assert.equal(r.valido, true);
    assert.equal(r.estado.saldo, 0);
    assert.deepEqual(r.estado.usos, {});
  });

  it("saldo negativo ou não numérico → inválido", () => {
    assert.equal(lerSangue({ [CHAVE_SANGUE]: { saldo: -1, usos: {}, historico: [] } }).valido, false);
    assert.equal(lerSangue({ [CHAVE_SANGUE]: { saldo: "muito", usos: {}, historico: [] } }).valido, false);
    assert.equal(lerSangue({ [CHAVE_SANGUE]: "lixo" }).valido, false);
  });

  it("usos malformado → ledger inteiro rejeitado", () => {
    const usos = {
      [`d10:${TEST1}`]: { tipo: "uso", em: new Date().toISOString(), personagemId: PID, testId: TEST1 },
      quebrado: { tipo: "uso" },
    };
    const r = lerSangue({ [CHAVE_SANGUE]: { saldo: 3, usos, historico: [] } });
    assert.equal(r.valido, false);
    assert.equal(r.motivo, "usos_invalidos");
    assert.equal(usosSangueValidos(usos), false);
  });

  it("mutação sobre ledger inválido → sangue_invalido, sem escrita", () => {
    const dados = {
      [CHAVE_SANGUE]: { saldo: 2, usos: { ruim: {} }, historico: [] },
    };
    const r = registrarAjusteSangue(dados, { ...AUTOR, delta: 1, motivo: "x" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "sangue_invalido");
  });
});

// ---------- operações e idempotência ----------

describe("operações de ledger", () => {
  it("registrarUsoD10 debita custo e registra uso d10:", () => {
    const r = registrarUsoD10({ [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } }, {
      ...AUTOR, testId: TEST1, custo: 1,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.estado.saldo, 4);
    assert.ok(r.estado.usos[`d10:${TEST1}`]);
    assert.equal(r.estado.historico.at(-1)?.tipo, "uso");
    assert.equal(r.estado.historico.at(-1)?.usoId, `d10:${TEST1}`);
  });

  it("replay do mesmo usoId → jaRegistrado, saldo inalterado", () => {
    let dados: Record<string, unknown> = { [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } };
    const p = { ...AUTOR, testId: TEST1, custo: 1 };
    const r1 = registrarUsoD10(dados, p);
    assert.equal(r1.ok, true);
    if (r1.ok) dados = r1.dados;
    const r2 = registrarUsoD10(dados, p);
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.jaRegistrado, true);
      assert.equal(r2.estado.saldo, 4); // não debitou de novo
    }
  });

  it("mesmo usoId com personagemId divergente → uso_conflito", () => {
    let dados: Record<string, unknown> = { [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } };
    const r1 = registrarUsoD10(dados, { ...AUTOR, testId: TEST1, custo: 1 });
    if (r1.ok) dados = r1.dados;
    const r2 = registrarUsoD10(dados, { ...AUTOR, personagemId: PID2, testId: TEST1, custo: 1 });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.codigo, "uso_conflito");
  });

  it("saldo insuficiente → recusa sem mutação", () => {
    const dados = { [CHAVE_SANGUE]: { saldo: 1, usos: {}, historico: [] } };
    const r = registrarUsoD10(dados, { ...AUTOR, testId: TEST1, custo: 2 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "saldo_insuficiente");
  });

  // ---------- custo zero / gratuito (decisão #7055515759) ----------

  it("D10 custo 0: saldo inalterado, uso d10: persistido", () => {
    const r = registrarUsoD10({ [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } }, {
      ...AUTOR, testId: TEST1, custo: 0,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.estado.saldo, 5);
    assert.ok(r.estado.usos[`d10:${TEST1}`]);
    assert.equal(r.estado.historico.at(-1)?.quantidade, 0);
    assert.equal(r.estado.historico.at(-1)?.usoId, `d10:${TEST1}`);
  });

  it("D10 custo 0: replay não duplica uso nem evento", () => {
    let dados: Record<string, unknown> = { [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } };
    const p = { ...AUTOR, testId: TEST1, custo: 0 };
    const r1 = registrarUsoD10(dados, p);
    assert.equal(r1.ok, true);
    if (r1.ok) dados = r1.dados;
    const histAntes = r1.ok ? r1.estado.historico.length : -1;
    const r2 = registrarUsoD10(dados, p);
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.jaRegistrado, true);
      assert.equal(r2.estado.saldo, 5);
      assert.equal(r2.estado.historico.length, histAntes);
      assert.equal(Object.keys(r2.estado.usos).length, 1);
    }
  });

  it("D10 custo 0: chamadas seriadas no mesmo dados → um único uso lógico", () => {
    // Serialização real é da tx SQLite do chamador; aqui simulamos a
    // sequência estrita: duas invocações sobre o estado retornado.
    let dados: Record<string, unknown> = { [CHAVE_SANGUE]: { saldo: 7, usos: {}, historico: [] } };
    const p = { ...AUTOR, testId: TEST1, custo: 0 };
    const r1 = registrarUsoD10(dados, p);
    if (r1.ok) dados = r1.dados;
    const r2 = registrarUsoD10(dados, p);
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.jaRegistrado, true);
      assert.equal(r2.estado.saldo, 7);
      assert.equal(Object.keys(r2.estado.usos).length, 1);
      assert.equal(r2.estado.historico.filter((e) => e.usoId === `d10:${TEST1}`).length, 1);
    }
  });

  it("D10 custo negativo/NaN/±Infinity → rejeitado, estado imutável", () => {
    const dados = { [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } };
    const antes = JSON.stringify(dados);
    for (const custo of [-1, NaN, Infinity, -Infinity]) {
      const r = registrarUsoD10(dados, { ...AUTOR, testId: TEST1, custo });
      assert.equal(r.ok, false, `custo=${custo}`);
      if (!r.ok) assert.equal(r.codigo, "quantidade_invalida");
    }
    assert.equal(JSON.stringify(dados), antes);
  });

  it("D10 custo 0: mesmo testId em outro personagem → uso_conflito", () => {
    let dados: Record<string, unknown> = { [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } };
    const r1 = registrarUsoD10(dados, { ...AUTOR, testId: TEST1, custo: 0 });
    if (r1.ok) dados = r1.dados;
    const r2 = registrarUsoD10(dados, { ...AUTOR, personagemId: PID2, testId: TEST1, custo: 0 });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.codigo, "uso_conflito");
  });

  it("D10 custo 0: testIds diferentes → operações independentes", () => {
    let dados: Record<string, unknown> = { [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } };
    const r1 = registrarUsoD10(dados, { ...AUTOR, testId: TEST1, custo: 0 });
    if (r1.ok) dados = r1.dados;
    const r2 = registrarUsoD10(dados, { ...AUTOR, testId: TEST2, custo: 0 });
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.jaRegistrado, undefined);
      assert.equal(Object.keys(r2.estado.usos).length, 2);
      assert.equal(r2.estado.saldo, 5);
    }
  });

  it("D10 custo 0: ledger malformado → fail-closed", () => {
    const r = registrarUsoD10({ [CHAVE_SANGUE]: { saldo: "x", usos: {}, historico: [] } }, {
      ...AUTOR, testId: TEST1, custo: 0,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "sangue_invalido");
  });

  it("ativar exige requestId UUID; replay não duplica", () => {
    let dados: Record<string, unknown> = { [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } };
    const sem = registrarAtivacaoSangue(dados, { ...AUTOR, poderKey: "magia", custo: 1, requestId: "nao-uuid" });
    assert.equal(sem.ok, false);
    const p = { ...AUTOR, poderKey: "magia", custo: 1, requestId: REQ1 };
    const r1 = registrarAtivacaoSangue(dados, p);
    assert.equal(r1.ok, true);
    if (r1.ok) dados = r1.dados;
    const r2 = registrarAtivacaoSangue(dados, p);
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.jaRegistrado, true);
      assert.equal(r2.estado.saldo, 4);
      assert.equal(Object.keys(r2.estado.usos).length, 1);
    }
  });

  it("ativar: mesmo requestId com poderKey divergente → uso_conflito (P2 R6.4)", () => {
    let dados: Record<string, unknown> = { [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } };
    const p = { ...AUTOR, poderKey: "magia", custo: 1, requestId: REQ1 };
    const r1 = registrarAtivacaoSangue(dados, p);
    assert.equal(r1.ok, true);
    if (r1.ok) dados = r1.dados;
    const antes = JSON.stringify(dados);
    // mesmo UUID + mesmo poder → replay (já coberto acima); aqui:
    // mesmo UUID + OUTRO poder → conflito estável, zero mutação.
    const divergente = registrarAtivacaoSangue(dados, { ...p, poderKey: "fogo" });
    assert.equal(divergente.ok, false);
    if (!divergente.ok) assert.equal(divergente.codigo, "uso_conflito");
    assert.equal(JSON.stringify(dados), antes);
    // requestId novo com outro poder → operação independente normal
    const novo = registrarAtivacaoSangue(dados, { ...p, poderKey: "fogo", requestId: REQ2 });
    assert.equal(novo.ok, true);
    if (novo.ok) {
      assert.equal(novo.estado.saldo, 3);
      assert.equal(Object.keys(novo.estado.usos).length, 2);
    }
  });

  it("ativar com custo 0 registra uso sem mover saldo", () => {
    const dados = { [CHAVE_SANGUE]: { saldo: 3, usos: {}, historico: [] } };
    const r = registrarAtivacaoSangue(dados, { ...AUTOR, poderKey: "gratuito", custo: 0, requestId: REQ2 });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.estado.saldo, 3);
      assert.ok(r.estado.usos[`ativar:${REQ2}`]);
    }
  });

  it("recuperar respeita flag habilitada e capacidade máxima", () => {
    let dados: Record<string, unknown> = {
      [CHAVE_SANGUE]: { saldo: 4, capacidade: 5, usos: {}, historico: [] },
    };
    const off = registrarRecuperacaoSangue(dados, { ...AUTOR, requestId: REQ1, quantidade: 2, habilitada: false });
    assert.equal(off.ok, false);
    if (!off.ok) assert.equal(off.codigo, "recuperacao_desabilitada");

    const r = registrarRecuperacaoSangue(dados, {
      ...AUTOR, requestId: REQ1, quantidade: 3, habilitada: true, capacidadeMax: 5,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      // capacidade 5, saldo 4 → só +1 cabe
      assert.equal(r.estado.saldo, 5);
      dados = r.dados;
    }
    // replay do mesmo requestId → nada muda
    const r2 = registrarRecuperacaoSangue(dados, {
      ...AUTOR, requestId: REQ1, quantidade: 3, habilitada: true, capacidadeMax: 5,
    });
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.jaRegistrado, true);
  });

  it("ajuste exige motivo e nunca cria entrada em usos", () => {
    const dados = { [CHAVE_SANGUE]: { saldo: 3, usos: {}, historico: [] } };
    const sem = registrarAjusteSangue(dados, { ...AUTOR, delta: 1 });
    assert.equal(sem.ok, false);
    const r = registrarAjusteSangue(dados, { ...AUTOR, delta: -1, motivo: "correção" });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.estado.saldo, 2);
      assert.equal(r.estado.historico.at(-1)?.tipo, "ajuste");
      assert.equal(Object.keys(r.estado.usos).length, 0);
    }
  });

  it("ajuste com requestId → dedup durável ajustar:<uuid> no ledger", () => {
    const dados = { [CHAVE_SANGUE]: { saldo: 3, usos: {}, historico: [] } };
    const r1 = registrarAjusteSangue(dados, { ...AUTOR, delta: 2, motivo: "bônus", requestId: REQ1 });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    assert.equal(r1.jaRegistrado, undefined);
    assert.equal(r1.estado.saldo, 5);
    const chave = `ajustar:${REQ1.toLowerCase()}`;
    assert.ok(r1.estado.usos[chave]);
    assert.equal(r1.estado.usos[chave].delta, 2);
    // replay: mesmo requestId + payload → jaRegistrado, sem novo delta
    const r2 = registrarAjusteSangue(r1.dados, { ...AUTOR, delta: 2, motivo: "bônus", requestId: REQ1 });
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.jaRegistrado, true);
      assert.equal(r2.estado.saldo, 5);
    }
    // conflito: mesmo requestId, delta divergente → uso_conflito
    const r3 = registrarAjusteSangue(r1.dados, { ...AUTOR, delta: 3, motivo: "bônus", requestId: REQ1 });
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.equal(r3.codigo, "uso_conflito");
    // conflito: mesmo requestId, motivo divergente → uso_conflito
    const r4 = registrarAjusteSangue(r1.dados, { ...AUTOR, delta: 2, motivo: "outro", requestId: REQ1 });
    assert.equal(r4.ok, false);
    if (!r4.ok) assert.equal(r4.codigo, "uso_conflito");
    // requestId inválido → uso_invalido antes de tocar o ledger
    const r5 = registrarAjusteSangue(r1.dados, { ...AUTOR, delta: 1, motivo: "x", requestId: "abc" });
    assert.equal(r5.ok, false);
    if (!r5.ok) assert.equal(r5.codigo, "uso_invalido");
  });
});

// ---------- crescimento e truncamento ----------

describe("usos durável e histórico limitado", () => {
  it(`mais de ${LIMITE_USOS_AVISO} usos não trunca o ledger`, () => {
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (m: unknown) => avisos.push(String(m));
    try {
      let dados: Record<string, unknown> = { [CHAVE_SANGUE]: { saldo: 100000, usos: {}, historico: [] } };
      const total = LIMITE_USOS_AVISO + 10;
      for (let i = 0; i < total; i++) {
        // requestIds únicos por iteração
        const rid = `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`;
        const r = registrarAtivacaoSangue(dados, { ...AUTOR, poderKey: "p", custo: 0, requestId: rid });
        assert.equal(r.ok, true);
        if (r.ok) dados = r.dados;
      }
      const lido = lerSangue(dados);
      assert.equal(lido.valido, true);
      assert.equal(Object.keys(lido.estado.usos).length, total);
      assert.ok(avisos.some((a) => a.includes("5000")));
      // replay do primeiro uso continua deduplicando
      const rid0 = `12345678-1234-4234-8234-${String(0).padStart(12, "0")}`;
      const replay = registrarAtivacaoSangue(dados, { ...AUTOR, poderKey: "p", custo: 0, requestId: rid0 });
      assert.equal(replay.ok, true);
      if (replay.ok) assert.equal(replay.jaRegistrado, true);
    } finally {
      console.warn = original;
    }
  });

  it(`histórico trunca em ${MAX_HISTORICO_SANGUE} com âncora`, () => {
    let dados: Record<string, unknown> = { [CHAVE_SANGUE]: { saldo: 10000, usos: {}, historico: [] } };
    for (let i = 0; i < MAX_HISTORICO_SANGUE + 5; i++) {
      const rid = `12345678-1234-4234-8234-${String(i).padStart(12, "0")}`;
      const r = registrarAtivacaoSangue(dados, { ...AUTOR, poderKey: "p", custo: 0, requestId: rid });
      assert.equal(r.ok, true);
      if (r.ok) dados = r.dados;
    }
    const lido = lerSangue(dados);
    assert.equal(lido.valido, true);
    assert.equal(lido.estado.historico.length, MAX_HISTORICO_SANGUE);
    assert.equal(typeof lido.estado.ancora, "number");
    // âncora = saldo anterior ao primeiro evento retido
    const primeiro = lido.estado.historico[0];
    assert.equal(lido.estado.ancora, primeiro.saldoResultante - primeiro.quantidade);
  });
});

// ---------- C4: capacidade e natureza por versão ----------

describe("resolverCapacidadeSangue — por versão da ficha", () => {
  const cfg = configBase();

  it("capacidade vem do campo da estrutura; duas versões independentes", () => {
    const e1 = estruturaBase();
    const e2 = estruturaBase();
    // "versão 2": campo cap passou a ser selecao_nivel com outro significado
    e2.secoes[0].campos[0] = { ...e2.secoes[0].campos[0], tipo: "selecao_nivel" };
    const d1 = dadosCom(5);
    const d2 = { cap: [{ key: "pontos_sangue", nivel: 3 }] };
    const r1 = resolverCapacidadeSangue(e1, d1, cfg);
    const r2 = resolverCapacidadeSangue(e2, d2, { ...cfg, capacidade: { modo: "somaNiveis" } });
    assert.equal(r1.disponivel, true);
    assert.equal(r1.capacidade, 5);
    assert.equal(r2.disponivel, true);
    assert.equal(r2.capacidade, 3); // independente da versão 1
  });

  it("config ausente/desabilitada → indisponível", () => {
    const e = estruturaBase();
    assert.equal(resolverCapacidadeSangue(e, dadosCom(5), null).disponivel, false);
    assert.equal(resolverCapacidadeSangue(e, dadosCom(5), { habilitado: false }).disponivel, false);
    assert.equal(resolverCapacidadeSangue(e, dadosCom(5), {}).disponivel, false);
  });

  it("campo inexistente na versão → fail-closed sem zerar saldo", () => {
    const e = estruturaSemCapacidade();
    const dados = { ...dadosCom(5), [CHAVE_SANGUE]: { saldo: 4, usos: {}, historico: [] } };
    const r = resolverCapacidadeSangue(e, dados, cfg);
    assert.equal(r.disponivel, false);
    assert.equal(r.motivo, "campo_inexistente");
    // saldo permanece intacto — ausência de capacidade não autoriza zerar
    assert.equal(lerSangue(dados).estado.saldo, 4);
  });

  it("valor inválido para o modo → indisponível", () => {
    const e = estruturaBase();
    // campo inteiro com texto não numérico
    assert.equal(resolverCapacidadeSangue(e, { cap: "abc", nat: "Humano" }, cfg).disponivel, false);
    // modo mapa sem entrada para o rótulo
    const eMapa = estruturaBase();
    eMapa.secoes[0].campos[0] = { ...eMapa.secoes[0].campos[0], tipo: "selecao_unica", opcoes: ["Fraco", "Forte"] };
    const cfgMapa: ConfigSangue = { ...cfg, capacidade: { modo: "mapa", mapa: { Forte: 10 } } };
    assert.equal(resolverCapacidadeSangue(eMapa, { cap: "Fraco", nat: "Humano" }, cfgMapa).disponivel, false);
    assert.equal(resolverCapacidadeSangue(eMapa, { cap: "Forte", nat: "Humano" }, cfgMapa).capacidade, 10);
  });

  it("bônus de qualidade só aplica com coeficiente configurado (D3 pendente)", () => {
    const e = estruturaBase();
    const dados = { cap: 5, nat: "Humano", qual: [{ key: "chacra", nivel: 3 }] };
    // sem bonusQualidade → capacidade = base
    assert.equal(resolverCapacidadeSangue(e, dados, cfg).capacidade, 5);
    // com coeficiente configurado → aplica somaNiveis × coef
    const cfgCom: ConfigSangue = {
      ...cfg,
      capacidade: { bonusQualidade: { campoId: "qual", coeficiente: 1, modo: "somaNiveis" } },
    };
    assert.equal(resolverCapacidadeSangue(e, dados, cfgCom).capacidade, 8);
  });

  it("redução de capacidade não zera saldo", () => {
    const dados = {
      cap: 2, // capacidade caiu de 5 para 2
      nat: "Humano",
      [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] },
    };
    const r = resolverCapacidadeSangue(estruturaBase(), dados, configBase());
    assert.equal(r.capacidade, 2);
    // saldo preservado — decisão D4 pendente; nenhum clamp automático
    assert.equal(lerSangue(dados).estado.saldo, 5);
    // cache reflete a nova capacidade sem tocar saldo
    const comCache = gravarCacheCapacidade(dados, r.capacidade);
    const lido = lerSangue(comCache);
    assert.equal(lido.estado.capacidade, 2);
    assert.equal(lido.estado.saldo, 5);
  });
});

describe("resolverNaturezaSangue — fail-closed", () => {
  const cfg = configBase();
  const e = estruturaBase();

  it("Humano mapeado → metaHumanoComPoder true", () => {
    const r = resolverNaturezaSangue(e, dadosCom(5, "Humano"), cfg);
    assert.equal(r.disponivel, true);
    assert.equal(r.rotulo, "Humano");
    assert.equal(r.metaHumanoComPoder, true);
    assert.equal(r.natureza?.recuperacao, "descansar");
  });

  it("Vampiro mapeado → não é meta humano; recuperação própria", () => {
    const r = resolverNaturezaSangue(e, dadosCom(5, "Vampiro"), cfg);
    assert.equal(r.metaHumanoComPoder, false);
    assert.equal(r.natureza?.recuperacao, "alimentar-se");
  });

  it("natureza ausente/desconhecida → NUNCA meta humano", () => {
    assert.equal(resolverNaturezaSangue(e, { cap: 5, nat: "" }, cfg).metaHumanoComPoder, false);
    const desc = resolverNaturezaSangue(e, { cap: 5, nat: "Extra-Terrestre" }, cfg);
    assert.equal(desc.disponivel, true);
    assert.equal(desc.motivo, "natureza_desconhecida");
    assert.equal(desc.metaHumanoComPoder, false);
    assert.equal(desc.natureza, null);
  });

  it("campo inexistente → indisponível", () => {
    const r = resolverNaturezaSangue(estruturaSemCapacidade(), dadosCom(5, "Humano"), {
      ...cfg, campoNaturezaId: "cap", // aponta para campo removido? cap existe... usar id inexistente
      campoNaturezaId: "inexistente",
    });
    assert.equal(r.disponivel, false);
    assert.equal(r.motivo, "campo_inexistente");
  });
});

describe("resolverSanguePersonagem + validarVinculosSangue", () => {
  it("utilizavel = capacidade resolvível; natureza não bloqueia", () => {
    const e = estruturaBase();
    const dados = { cap: 5 }; // sem natureza
    const r = resolverSanguePersonagem(e, dados, configBase());
    assert.equal(r.utilizavel, true);
    assert.equal(r.capacidade.capacidade, 5);
    assert.equal(r.natureza.metaHumanoComPoder, false);
  });

  it("validarVinculosSangue aponta IDs inexistentes", () => {
    const e = estruturaBase();
    assert.deepEqual(validarVinculosSangue(configBase(), e), []);
    const erros = validarVinculosSangue(
      { ...configBase(), campoCapacidadeId: "xxx", campoNaturezaId: "yyy" },
      e,
    );
    assert.equal(erros.length, 2);
  });
});

// ---------- regressões da revisão PR #194 (R1/R2/R3) ----------

describe("regressão R1 — recuperação no teto mantém idempotência", () => {
  const teto = { saldo: 5, usos: {}, historico: [] };

  it("usoId recuperar:<uuid> é gravado mesmo com delta efetivo 0", () => {
    const r = registrarRecuperacaoSangue({ [CHAVE_SANGUE]: teto }, {
      ...AUTOR, requestId: REQ1, quantidade: 2, habilitada: true, capacidadeMax: 5,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.estado.saldo, 5);
    const uso = r.estado.usos[`recuperar:${REQ1}`];
    assert.ok(uso, "ledger deve registrar a operação mesmo sem crédito");
    assert.equal(uso.tipo, "recuperacao");
    assert.equal(uso.quantidade, 2);
    // o efeito real (0) fica visível no histórico de exibição
    assert.equal(r.estado.historico.at(-1)?.quantidade, 0);
  });

  it("retry do mesmo requestId após liberar capacidade não credita de novo", () => {
    let dados: Record<string, unknown> = { [CHAVE_SANGUE]: teto };
    const p = { ...AUTOR, requestId: REQ1, quantidade: 2, habilitada: true, capacidadeMax: 5 };
    const r1 = registrarRecuperacaoSangue(dados, p);
    assert.equal(r1.ok, true);
    if (r1.ok) dados = r1.dados;
    // gasta 3 → saldo 2 (espaço liberado)
    const gasto = registrarUsoD10(dados, { ...AUTOR, testId: TEST1, custo: 3 });
    assert.equal(gasto.ok, true);
    if (gasto.ok) dados = gasto.dados;
    const r2 = registrarRecuperacaoSangue(dados, p);
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.jaRegistrado, true);
      assert.equal(r2.estado.saldo, 2, "retry não pode creditar novamente");
    }
  });
});

describe("regressão R2 — âncora histórica zero é persistida", () => {
  function dadosComHistorico(quantidadeAncora: number): Record<string, unknown> {
    // 505 eventos; após um append, slice(-500) retém a partir do
    // índice 6 — cujo primeiro evento tem origem = quantidadeAncora
    // menos o próprio delta. Montamos para que origem === 0.
    const evs: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 505; i++) {
      const ehRetidoInicial = i === 7; // vira historico[0] após slice
      evs.push({
        em: new Date().toISOString(),
        tipo: "ajuste",
        quantidade: ehRetidoInicial ? quantidadeAncora : 1,
        motivo: null,
        autorId: null,
        autorNome: null,
        saldoResultante: ehRetidoInicial ? quantidadeAncora : i,
      });
    }
    return { [CHAVE_SANGUE]: { saldo: 100, usos: {}, historico: evs } };
  }

  it("primeiro evento retido com origem 0 → ancora === 0 explícita", () => {
    const r = registrarAjusteSangue(dadosComHistorico(7), { ...AUTOR, delta: 0.5, motivo: "x" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.estado.historico.length, MAX_HISTORICO_SANGUE);
    const primeiro = r.estado.historico[0];
    assert.equal(primeiro.saldoResultante - primeiro.quantidade, 0);
    assert.equal(r.estado.ancora, 0, "âncora zero não pode ser omitida");
  });

  it("truncamento progressivo atualiza a âncora", () => {
    let dados = dadosComHistorico(7);
    const r1 = registrarAjusteSangue(dados, { ...AUTOR, delta: 0.5, motivo: "x" });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    assert.equal(r1.estado.ancora, 0);
    // novo ciclo de truncamento: a âncora avança para a nova origem
    const evs = r1.estado.historico;
    const dados2: Record<string, unknown> = {
      [CHAVE_SANGUE]: {
        saldo: r1.estado.saldo,
        usos: r1.estado.usos,
        historico: [...evs, ...evs.map((e) => ({ ...e }))],
      },
    };
    const r2 = registrarAjusteSangue(dados2, { ...AUTOR, delta: 0.5, motivo: "y" });
    assert.equal(r2.ok, true);
    if (!r2.ok) return;
    assert.equal(r2.estado.historico.length, MAX_HISTORICO_SANGUE);
    const p = r2.estado.historico[0];
    assert.equal(r2.estado.ancora, p.saldoResultante - p.quantidade);
    assert.equal(typeof r2.estado.ancora, "number");
  });
});

describe("regressão R3 — bônus de qualidade fail-closed", () => {
  const e = estruturaBase();
  const dados = { cap: 5, nat: "Humano", qual: [{ key: "chacra", nivel: 2 }] };

  function cfgComBônus(bq: NonNullable<NonNullable<ConfigSangue["capacidade"]>["bonusQualidade"]>): ConfigSangue {
    return { ...configBase(), capacidade: { bonusQualidade: bq } };
  }

  it("coeficiente negativo, NaN ou Infinity → config_invalida", () => {
    for (const coeficiente of [-5, NaN, Infinity, -0.1]) {
      const r = resolverCapacidadeSangue(e, dados, cfgComBônus({ campoId: "qual", coeficiente, modo: "somaNiveis" }));
      assert.equal(r.disponivel, false, `coeficiente ${coeficiente} não pode ser aceito`);
      assert.equal(r.motivo, "config_invalida");
    }
  });

  it("campoId de bônus inexistente → campo_inexistente", () => {
    const r = resolverCapacidadeSangue(e, dados, cfgComBônus({ campoId: "fantasma", coeficiente: 1 }));
    assert.equal(r.disponivel, false);
    assert.equal(r.motivo, "campo_inexistente");
  });

  it("configuração parcial (campoId sem coeficiente ou vice-versa) → config_invalida", () => {
    assert.equal(
      resolverCapacidadeSangue(e, dados, cfgComBônus({ campoId: "qual" })).motivo,
      "config_invalida",
    );
    assert.equal(
      resolverCapacidadeSangue(e, dados, cfgComBônus({ coeficiente: 1 })).motivo,
      "config_invalida",
    );
  });

  it("modo mapa sem mapa → config_invalida", () => {
    const campoUnico = estruturaBase();
    campoUnico.secoes[0].campos.push({
      id: "bonus_sel", label: "Bônus", tipo: "selecao_unica", semantico: "vantagem", padrao: "", opcoes: ["A"],
    } as EstruturaFicha["secoes"][number]["campos"][number]);
    const r = resolverCapacidadeSangue(
      campoUnico,
      { ...dados, bonus_sel: "A" },
      cfgComBônus({ campoId: "bonus_sel", coeficiente: 1, modo: "mapa" }),
    );
    assert.equal(r.disponivel, false);
    assert.equal(r.motivo, "config_invalida");
  });

  it("capacidade final negativa (mapa com valor negativo) → valor_invalido", () => {
    const eMapa = estruturaBase();
    eMapa.secoes[0].campos[0] = {
      ...eMapa.secoes[0].campos[0], tipo: "selecao_unica", opcoes: ["Ruim"],
    };
    const cfg: ConfigSangue = {
      ...configBase(),
      capacidade: { modo: "mapa", mapa: { Ruim: -10 } },
    };
    const r = resolverCapacidadeSangue(eMapa, { cap: "Ruim", nat: "Humano" }, cfg);
    assert.equal(r.disponivel, false);
    assert.equal(r.motivo, "valor_invalido");
  });

  it("validarVinculosSangue rejeita coeficiente inválido e campoId ausente", () => {
    const base = configBase();
    assert.ok(
      validarVinculosSangue(cfgComBônus({ campoId: "qual", coeficiente: -1 }), e).length > 0,
    );
    assert.ok(
      validarVinculosSangue(cfgComBônus({ campoId: "qual" }), e).length > 0,
    );
    assert.ok(
      validarVinculosSangue(cfgComBônus({ campoId: "fantasma", coeficiente: 1 }), e).length > 0,
    );
    assert.deepEqual(validarVinculosSangue(cfgComBônus({ campoId: "qual", coeficiente: 1 }), e), []);
    assert.ok(base);
  });
});

describe("robustez numérica — entradas não finitas e listas parciais", () => {
  it("débitos decimais sucessivos chegam exatamente a zero", () => {
    let dados: Record<string, unknown> = {
      [CHAVE_SANGUE]: { saldo: 0.3, usos: {}, historico: [] },
    };
    const primeiro = registrarAjusteSangue(dados, {
      ...AUTOR, delta: -0.2, motivo: "gasto decimal 1",
    });
    assert.equal(primeiro.ok, true);
    if (!primeiro.ok) return;
    assert.equal(primeiro.estado.saldo, 0.1);
    dados = primeiro.dados;

    const segundo = registrarAjusteSangue(dados, {
      ...AUTOR, delta: -0.1, motivo: "gasto decimal 2",
    });
    assert.equal(segundo.ok, true, "0,1 restante deve cobrir custo 0,1");
    if (segundo.ok) {
      assert.equal(segundo.estado.saldo, 0);
      assert.equal(segundo.estado.historico.at(-1)?.saldoResultante, 0);
    }
  });

  it("débito corrige saldo legado contaminado pela aritmética binária", () => {
    const dados: Record<string, unknown> = {
      [CHAVE_SANGUE]: { saldo: 0.09999999999999998, usos: {}, historico: [] },
    };
    const r = registrarAjusteSangue(dados, {
      ...AUTOR, delta: -0.1, motivo: "corrigir resíduo legado",
    });
    assert.equal(r.ok, true, "saldo legado deve ser normalizado para 0,1 antes da comparação");
    if (r.ok) assert.equal(r.estado.saldo, 0);
  });

  it("preserva valores seguros com 16 algarismos significativos", () => {
    const saldo = 1234567890123456;
    const dados: Record<string, unknown> = {
      [CHAVE_SANGUE]: { saldo, usos: {}, historico: [] },
    };
    const r = registrarAjusteSangue(dados, {
      ...AUTOR, delta: -1, motivo: "preservar precisão válida",
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.estado.saldo, 1234567890123455);
  });

  it("crédito decimal respeita o teto sem ultrapassá-lo", () => {
    const dados: Record<string, unknown> = {
      [CHAVE_SANGUE]: { saldo: 0.2, usos: {}, historico: [] },
    };
    const r = registrarRecuperacaoSangue(dados, {
      ...AUTOR, requestId: REQ1, quantidade: 0.2, habilitada: true, capacidadeMax: 0.3,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.estado.saldo, 0.3);
  });

  it("quantidade NaN/Infinity/negativa/zero recusada nas três operações", () => {
    const dados = { [CHAVE_SANGUE]: { saldo: 5, usos: {}, historico: [] } };
    for (const q of [NaN, Infinity, -1, 0]) {
      assert.equal(
        registrarRecuperacaoSangue(dados, { ...AUTOR, requestId: REQ1, quantidade: q, habilitada: true }).ok,
        false,
        `recuperar quantidade ${q}`,
      );
    }
    assert.equal(registrarUsoD10(dados, { ...AUTOR, testId: TEST1, custo: NaN }).ok, false);
    assert.equal(registrarUsoD10(dados, { ...AUTOR, testId: TEST1, custo: Infinity }).ok, false);
    assert.equal(
      registrarAtivacaoSangue(dados, { ...AUTOR, poderKey: "p", custo: NaN, requestId: REQ2 }).ok,
      false,
    );
  });

  it("saldo/capacidade não finitos ou negativos no ledger → inválido", () => {
    assert.equal(lerSangue({ [CHAVE_SANGUE]: { saldo: NaN, usos: {}, historico: [] } }).valido, false);
    assert.equal(lerSangue({ [CHAVE_SANGUE]: { saldo: 1, capacidade: Infinity, usos: {}, historico: [] } }).valido, false);
    assert.equal(lerSangue({ [CHAVE_SANGUE]: { saldo: 1, capacidade: -2, usos: {}, historico: [] } }).valido, false);
  });

  it("somaNiveis tolera itens parcialmente malformados (comportamento documentado)", () => {
    const e = estruturaBase();
    e.secoes[0].campos[0] = { ...e.secoes[0].campos[0], tipo: "selecao_nivel" };
    const cfg: ConfigSangue = { ...configBase(), capacidade: { modo: "somaNiveis" } };
    const r = resolverCapacidadeSangue(e, {
      cap: [{ key: "a", nivel: 2 }, "lixo", { key: "b" }, null, { key: "c", nivel: "x" }],
      nat: "Humano",
    }, cfg);
    // soma apenas os itens bem-formados — decisão de endurecer fica
    // registrada para revisão; itens inválidos não são silenciosamente
    // somados como nível.
    assert.equal(r.disponivel, true);
    assert.equal(r.capacidade, 2);
  });
});

// ---------- reconciliação de capacidade reduzida (decisão #7055515759) ----------

describe("reconciliarCapacidadeSangue", () => {
  const dadosCom = (saldo: number, historico: unknown[] = []) => ({
    [CHAVE_SANGUE]: { saldo, usos: {}, historico },
  });

  it("capacidade ausente/inválida → no-op, dados intactos", () => {
    const dados = dadosCom(8);
    const antes = JSON.stringify(dados);
    for (const cap of [undefined, null, NaN, Infinity, -Infinity, -1]) {
      const r = reconciliarCapacidadeSangue(dados, { ...AUTOR, capacidadeNova: cap });
      assert.equal(r.ok, true, `cap=${cap}`);
      if (r.ok) {
        assert.equal(r.ajustado, false);
        assert.equal(r.estado.saldo, 8);
      }
    }
    assert.equal(JSON.stringify(dados), antes);
  });

  it("saldo dentro do teto → no-op", () => {
    for (const cap of [8, 10]) {
      const r = reconciliarCapacidadeSangue(dadosCom(8), { ...AUTOR, capacidadeNova: cap });
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.ajustado, false);
    }
  });

  it("capacidade abaixo do saldo → ajuste negativo auditável até o teto", () => {
    let dados: Record<string, unknown> = dadosCom(10);
    const r = reconciliarCapacidadeSangue(dados, {
      ...AUTOR, capacidadeNova: 6, motivo: "Capacidade reduzida de 10 para 6",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ajustado, true);
    assert.equal(r.estado.saldo, 6);
    const ev = r.estado.historico.at(-1);
    assert.equal(ev?.tipo, "ajuste");
    assert.equal(ev?.quantidade, -4);
    assert.equal(ev?.saldoResultante, 6);
    assert.equal(ev?.motivo, "Capacidade reduzida de 10 para 6");
    assert.equal(r.estado.capacidade, 6); // cache atualizado
    dados = r.dados;
    // histórico anterior preservado (append-only)
    assert.equal(r.estado.historico.length, 1);
  });

  it("ajuste preserva histórico existente — nunca apaga", () => {
    const hist = [{ em: new Date().toISOString(), tipo: "uso", quantidade: -2, motivo: null, autorId: "u", autorNome: "M", saldoResultante: 8 }];
    const r = reconciliarCapacidadeSangue(dadosCom(8, hist), {
      ...AUTOR, capacidadeNova: 3, motivo: "downgrade",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.estado.saldo, 3);
    assert.equal(r.estado.historico.length, 2);
    assert.equal(r.estado.historico[0].tipo, "uso"); // evento antigo intacto
    assert.equal(r.estado.historico[1].tipo, "ajuste");
  });

  it("saldo acima do teto sem motivo → recusa fail-closed", () => {
    const r = reconciliarCapacidadeSangue(dadosCom(10), { ...AUTOR, capacidadeNova: 4 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "quantidade_invalida");
  });

  it("capacidade 0 com saldo positivo → ajuste até zero auditável", () => {
    const r = reconciliarCapacidadeSangue(dadosCom(5), {
      ...AUTOR, capacidadeNova: 0, motivo: "capacidade zerada",
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.ajustado, true);
      assert.equal(r.estado.saldo, 0);
    }
  });

  it("ledger malformado → sangue_invalido mesmo com capacidade válida", () => {
    const r = reconciliarCapacidadeSangue(
      { [CHAVE_SANGUE]: { saldo: "x", usos: {}, historico: [] } },
      { ...AUTOR, capacidadeNova: 1 },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "sangue_invalido");
  });
});
