import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAVE_SANGUE,
  ajustarSangueManual,
  ativarPoderNarrativo,
  estadoSangueAtual,
  reconciliarCapacidade,
  recuperarSangue,
  type ConfigSangueAcoes,
} from "../src/lib/sangue-acoes.js";
import type { EstruturaFicha } from "../src/lib/ficha.js";

// ---------- fixtures ----------

const PID = "11111111-2222-4333-8444-555555555555";
const PID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const REQ1 = "12345678-1234-4234-8234-123456789abc";
const REQ2 = "12345678-1234-4234-8234-abcdefabcdef";
const REQ3 = "12345678-1234-4234-8234-000000000001";
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
          { id: "cap", label: "Capacidade", tipo: "inteiro", semantico: "livre", padrao: 0 },
          {
            id: "nat",
            label: "Natureza",
            tipo: "selecao_unica",
            semantico: "livre",
            padrao: "",
            opcoes: ["Humano", "Vampiro", "Lobisomem", "Desconhecida-X"],
          },
        ],
      },
    ],
  };
}

const CONFIG: ConfigSangueAcoes = {
  habilitado: true,
  campoCapacidadeId: "cap",
  campoNaturezaId: "nat",
  capacidade: { modo: "valor" },
  poderes: {
    fogo: { custo: 2 },
    gratis: { custo: 0 },
    sem_custo: {}, // entrada sem custo → gratuito
  },
  naturezas: {
    Humano: { metaHumanoComPoder: true, recuperacao: "descansar" },
    Vampiro: { recuperacao: "alimentar" },
    Lobisomem: { metaHumanoComPoder: false }, // sem ação mapeada
    "Desconhecida-X": { recuperacao: "dormir" }, // fora do catálogo → sem ação
  },
  recuperacaoSangue: {
    habilitado: true,
    acoes: {
      descansar: { habilitada: true, quantidade: 2 },
      alimentar: { habilitada: true, quantidade: 3 },
    },
  },
};

const dadosCom = (saldo = 10) => ({
  cap: 10,
  nat: "Humano",
  [CHAVE_SANGUE]: { saldo, usos: {}, historico: [] },
});
const dadosFicha = { cap: 10, nat: "Humano" };
const PODERES_VALIDOS = new Set(["fogo", "gratis", "sem_custo"]);

// ---------- ativação narrativa ----------

describe("ativarPoderNarrativo", () => {
  it("poder com custo positivo debita uma vez", () => {
    const r = ativarPoderNarrativo(dadosCom(), {
      ...AUTOR, requestId: REQ1, poderKey: "fogo", config: CONFIG, poderesValidos: PODERES_VALIDOS,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.estado.saldo, 8);
    assert.equal(r.replay, false);
    assert.ok(r.estado.usos[`ativar:${REQ1}`]);
  });

  it("custo ausente e zero → gratuito com registro idempotente", () => {
    for (const [key, req] of [["gratis", REQ1], ["sem_custo", REQ2]] as const) {
      const r = ativarPoderNarrativo(dadosCom(10), {
        ...AUTOR, requestId: req, poderKey: key, config: CONFIG, poderesValidos: PODERES_VALIDOS,
      });
      assert.equal(r.ok, true, key);
      if (r.ok) assert.equal(r.estado.saldo, 10, key);
    }
  });

  it("poderKey fora do conjunto válido → poder_desconhecido", () => {
    const r = ativarPoderNarrativo(dadosCom(), {
      ...AUTOR, requestId: REQ1, poderKey: "inexistente", config: CONFIG, poderesValidos: PODERES_VALIDOS,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "poder_desconhecido");
  });

  it("custo negativo/não finito na config → custo_invalido, estado intacto", () => {
    const cfgRuim: ConfigSangueAcoes = {
      ...CONFIG,
      poderes: { fogo: { custo: -1 }, gratis: { custo: NaN } },
    };
    for (const key of ["fogo", "gratis"]) {
      const r = ativarPoderNarrativo(dadosCom(), {
        ...AUTOR, requestId: REQ1, poderKey: key, config: cfgRuim, poderesValidos: PODERES_VALIDOS,
      });
      assert.equal(r.ok, false, key);
      if (!r.ok) assert.equal(r.codigo, "custo_invalido");
    }
  });

  it("config ausente ou habilitado:false → recurso_desabilitado (custo positivo e ausente)", () => {
    const casos: Array<ConfigSangueAcoes | null | undefined> = [
      null,
      undefined,
      { ...CONFIG, habilitado: false },
      // desabilitado com custo configurado E sem custo — ambos cortados
      { ...CONFIG, habilitado: false, poderes: { fogo: { custo: 2 } } },
      { ...CONFIG, habilitado: false, poderes: {} },
    ];
    for (const config of casos) {
      for (const poderKey of ["fogo", "gratis"]) {
        const dados = dadosCom(10);
        const antes = JSON.stringify(dados);
        const r = ativarPoderNarrativo(dados, {
          ...AUTOR, requestId: REQ1, poderKey, config, poderesValidos: PODERES_VALIDOS,
        });
        assert.equal(r.ok, false, `${poderKey} cfg=${JSON.stringify(config?.habilitado)}`);
        if (!r.ok) assert.equal(r.codigo, "recurso_desabilitado");
        assert.equal(JSON.stringify(dados), antes, "ledger intacto");
      }
    }
  });

  it("poderesValidos ausente/vazio → poder_desconhecido (fail-closed)", () => {
    const dados = dadosCom();
    const antes = JSON.stringify(dados);
    // conjunto vazio: nenhuma chave é válida
    const r1 = ativarPoderNarrativo(dados, {
      ...AUTOR, requestId: REQ1, poderKey: "fogo", config: CONFIG, poderesValidos: new Set(),
    });
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.codigo, "poder_desconhecido");
    // parâmetro omitido por caller JS não-tipado → mesmo fail-closed
    const r2 = ativarPoderNarrativo(dados, {
      ...AUTOR, requestId: REQ1, poderKey: "fogo", config: CONFIG,
      poderesValidos: undefined as unknown as ReadonlySet<string>,
    });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.codigo, "poder_desconhecido");
    assert.equal(JSON.stringify(dados), antes);
  });

  it("requestId repetido → replay sem segundo débito", () => {
    let dados = dadosCom();
    const p = { ...AUTOR, requestId: REQ1, poderKey: "fogo", config: CONFIG, poderesValidos: PODERES_VALIDOS };
    const r1 = ativarPoderNarrativo(dados, p);
    if (r1.ok) dados = r1.dados;
    const r2 = ativarPoderNarrativo(dados, p);
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.replay, true);
      assert.equal(r2.estado.saldo, 8);
      assert.equal(Object.keys(r2.estado.usos).length, 1);
    }
  });

  it("mesmo requestId com outro poderKey → uso_conflito sem mutação", () => {
    const primeiro = ativarPoderNarrativo(dadosCom(), {
      ...AUTOR, requestId: REQ2, poderKey: "fogo", config: CONFIG, poderesValidos: PODERES_VALIDOS,
    });
    assert.equal(primeiro.ok, true);
    if (!primeiro.ok) return;

    // Mesmo Poder e requestId conserva o replay, sem novo débito.
    const replay = ativarPoderNarrativo(primeiro.dados, {
      ...AUTOR, requestId: REQ2, poderKey: "fogo", config: CONFIG, poderesValidos: PODERES_VALIDOS,
    });
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.replay, true);
      assert.equal(replay.estado.saldo, 8);
    }

    // Reutilizar a intenção para outro Poder não pode ser replay
    // silencioso nem aplicar o custo diferente.
    const antesConflito = JSON.stringify(primeiro.dados);
    const conflito = ativarPoderNarrativo(primeiro.dados, {
      ...AUTOR, requestId: REQ2, poderKey: "gratis", config: CONFIG, poderesValidos: PODERES_VALIDOS,
    });
    assert.equal(conflito.ok, false);
    if (!conflito.ok) assert.equal(conflito.codigo, "uso_conflito");
    assert.equal(JSON.stringify(primeiro.dados), antesConflito);
    const estadoFinal = estadoSangueAtual(primeiro.dados);
    assert.equal(estadoFinal.ok, true);
    if (estadoFinal.ok) {
      assert.equal(estadoFinal.estado.saldo, 8);
      assert.equal(Object.keys(estadoFinal.estado.usos).length, 1);
      assert.equal(estadoFinal.estado.historico.length, 1);
    }
  });

  it("saldo insuficiente → erro sem mutação", () => {
    const dados = dadosCom(1);
    const antes = JSON.stringify(dados);
    const r = ativarPoderNarrativo(dados, {
      ...AUTOR, requestId: REQ1, poderKey: "fogo", config: CONFIG, poderesValidos: PODERES_VALIDOS,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "saldo_insuficiente");
    assert.equal(JSON.stringify(dados), antes);
  });

  it("requestId inválido → uso_invalido", () => {
    const r = ativarPoderNarrativo(dadosCom(), {
      ...AUTOR, requestId: "nao-uuid", poderKey: "fogo", config: CONFIG, poderesValidos: PODERES_VALIDOS,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "uso_invalido");
  });
});

// ---------- recuperação por natureza ----------

describe("recuperarSangue", () => {
  const paramsBase = {
    ...AUTOR, requestId: REQ1, estrutura: estruturaBase(), dadosFicha, config: CONFIG,
  };

  it("Humano → descansar (quantidade configurada)", () => {
    const r = recuperarSangue(dadosCom(5), paramsBase);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.estado.saldo, 7); // +2
    assert.ok(r.estado.usos[`recuperar:${REQ1}`]);
  });

  it("capacidade não resolvida → recusa sem registrar recuperação", () => {
    const dados = dadosCom(5);
    const antes = JSON.stringify(dados);
    const r = recuperarSangue(dados, {
      ...paramsBase,
      config: { ...CONFIG, campoCapacidadeId: "campo_inexistente" },
      capacidadeMax: null,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "capacidade_indisponivel");
    assert.equal(JSON.stringify(dados), antes, "saldo e ledger permanecem intactos");
  });

  it("capacidade real prevalece sobre dica de teto divergente do chamador", () => {
    const r = recuperarSangue(dadosCom(9), { ...paramsBase, capacidadeMax: 999 });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.estado.saldo, 10);
  });

  it("Vampiro → alimentar", () => {
    const r = recuperarSangue(
      { ...dadosCom(5), nat: "Vampiro" },
      { ...paramsBase, dadosFicha: { ...dadosFicha, nat: "Vampiro" }, requestId: REQ2 },
    );
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.estado.saldo, 8); // +3
  });

  it("natureza sem ação mapeada → natureza_sem_acao", () => {
    const r = recuperarSangue(
      { ...dadosCom(5), nat: "Lobisomem" },
      { ...paramsBase, dadosFicha: { ...dadosFicha, nat: "Lobisomem" } },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "natureza_sem_acao");
  });

  it("rótulo com ação fora do catálogo → natureza_sem_acao", () => {
    const r = recuperarSangue(
      { ...dadosCom(5), nat: "Desconhecida-X" },
      { ...paramsBase, dadosFicha: { ...dadosFicha, nat: "Desconhecida-X" } },
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "natureza_sem_acao");
  });

  it("recurso global desligado → recurso_desabilitado", () => {
    const r = recuperarSangue(dadosCom(5), {
      ...paramsBase, config: { ...CONFIG, habilitado: false },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "recurso_desabilitado");
  });

  it("flag de recuperação desligada → acao_desabilitada", () => {
    const r = recuperarSangue(dadosCom(5), {
      ...paramsBase,
      config: { ...CONFIG, recuperacaoSangue: { habilitado: false, acoes: CONFIG.recuperacaoSangue!.acoes } },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "acao_desabilitada");
  });

  it("ação ausente ou desligada → acao_desabilitada", () => {
    for (const [nome, rec] of [
      ["sem acoes", { habilitado: true }],
      ["descansar desligada", { habilitado: true, acoes: { descansar: { habilitada: false, quantidade: 2 } } }],
      ["só alimentar", { habilitado: true, acoes: { alimentar: { habilitada: true, quantidade: 3 } } }],
    ] as const) {
      const r = recuperarSangue(dadosCom(5), {
        ...paramsBase,
        config: { ...CONFIG, recuperacaoSangue: rec },
      });
      assert.equal(r.ok, false, nome);
      if (!r.ok) assert.equal(r.codigo, "acao_desabilitada", nome);
    }
  });

  it("ação habilitada com quantidade inválida → quantidade_invalida", () => {
    for (const q of [0, -1, NaN, Infinity]) {
      const r = recuperarSangue(dadosCom(5), {
        ...paramsBase,
        config: {
          ...CONFIG,
          recuperacaoSangue: { habilitado: true, acoes: { descansar: { habilitada: true, quantidade: q } } },
        },
      });
      assert.equal(r.ok, false, `q=${q}`);
      if (!r.ok) assert.equal(r.codigo, "quantidade_invalida");
    }
  });



  it("replay do mesmo requestId não credita de novo", () => {
    let dados = dadosCom(5);
    const p = { ...paramsBase };
    const r1 = recuperarSangue(dados, p);
    if (r1.ok) dados = r1.dados;
    const r2 = recuperarSangue(dados, p);
    assert.equal(r2.ok, true);
    if (r2.ok) {
      assert.equal(r2.replay, true);
      assert.equal(r2.estado.saldo, 7);
    }
  });
});

// ---------- ajuste manual ----------

describe("ajustarSangueManual", () => {
  it("ajuste positivo e negativo com motivo", () => {
    const r1 = ajustarSangueManual(dadosCom(5), { ...AUTOR, delta: 3, motivo: "recompensa", requestId: REQ1 });
    assert.equal(r1.ok, true);
    if (r1.ok) assert.equal(r1.estado.saldo, 8);
    const r2 = ajustarSangueManual(dadosCom(5), { ...AUTOR, delta: -2, motivo: "penalidade", requestId: REQ2 });
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.estado.saldo, 3);
  });

  it("sem motivo, delta 0 ou requestId inválido → rejeitado", () => {
    assert.equal(ajustarSangueManual(dadosCom(5), { ...AUTOR, delta: 1, requestId: REQ1 }).ok, false);
    assert.equal(ajustarSangueManual(dadosCom(5), { ...AUTOR, delta: 0, motivo: "x", requestId: REQ1 }).ok, false);
    assert.equal(ajustarSangueManual(dadosCom(5), { ...AUTOR, delta: 1, motivo: "x", requestId: "nao-uuid" }).ok, false);
  });

  it("P2 R6.3 — retry mesmo requestId → replay sem novo delta", () => {
    const dados = dadosCom(5);
    const r1 = ajustarSangueManual(dados, { ...AUTOR, delta: 2, motivo: "recompensa", requestId: REQ1 });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    assert.equal(r1.replay, false);
    assert.equal(r1.estado.saldo, 7);
    // ACK perdido + retry: mesmo requestId E payload → replay
    const r2 = ajustarSangueManual(r1.dados, { ...AUTOR, delta: 2, motivo: "recompensa", requestId: REQ1 });
    assert.equal(r2.ok, true);
    if (!r2.ok) return;
    assert.equal(r2.replay, true);
    assert.equal(r2.estado.saldo, 7);
    assert.equal(Object.keys(r2.estado.usos).filter((k) => k.startsWith("ajustar:")).length, 1);
  });

  it("P2 R6.3 — requestId reaproveitado com payload divergente → uso_conflito", () => {
    const dados = dadosCom(5);
    const r1 = ajustarSangueManual(dados, { ...AUTOR, delta: 2, motivo: "recompensa", requestId: REQ1 });
    assert.equal(r1.ok, true);
    if (!r1.ok) return;
    const rDelta = ajustarSangueManual(r1.dados, { ...AUTOR, delta: 3, motivo: "recompensa", requestId: REQ1 });
    assert.equal(rDelta.ok, false);
    if (!rDelta.ok) assert.equal(rDelta.codigo, "uso_conflito");
    const rMotivo = ajustarSangueManual(r1.dados, { ...AUTOR, delta: 2, motivo: "outro", requestId: REQ1 });
    assert.equal(rMotivo.ok, false);
    if (!rMotivo.ok) assert.equal(rMotivo.codigo, "uso_conflito");
    // estado permanece o do primeiro ajuste
    const r3 = ajustarSangueManual(r1.dados, { ...AUTOR, delta: 2, motivo: "recompensa", requestId: REQ1 });
    assert.equal(r3.ok, true);
    if (r3.ok) assert.equal(r3.estado.saldo, 7);
  });
});

// ---------- reconciliação de capacidade ----------

describe("reconciliarCapacidade", () => {
  it("saldo acima do novo teto → ajuste auditável até o teto", () => {
    const r = reconciliarCapacidade(dadosCom(10), {
      ...AUTOR, capacidadeNova: 6, motivo: "Capacidade reduzida de 10 para 6",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.ajustado, true);
    assert.equal(r.estado.saldo, 6);
    assert.equal(r.estado.historico.at(-1)?.tipo, "ajuste");
  });

  it("capacidade ausente/inválida ou saldo no teto → no-op", () => {
    for (const cap of [undefined, null, NaN, -1]) {
      const r = reconciliarCapacidade(dadosCom(5), { ...AUTOR, capacidadeNova: cap });
      assert.equal(r.ok, true, `cap=${cap}`);
      if (r.ok) assert.equal(r.ajustado, false);
    }
    const r2 = reconciliarCapacidade(dadosCom(5), { ...AUTOR, capacidadeNova: 8 });
    assert.equal(r2.ok, true);
    if (r2.ok) assert.equal(r2.ajustado, false);
  });

  it("acima do teto sem motivo → fail-closed", () => {
    const r = reconciliarCapacidade(dadosCom(10), { ...AUTOR, capacidadeNova: 4 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "quantidade_invalida");
  });
});

// ---------- utilidade / fail-closed ----------

describe("estadoSangueAtual", () => {
  it("ledger válido → estado; malformado → sangue_invalido", () => {
    const ok = estadoSangueAtual(dadosCom(5));
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.estado.saldo, 5);
    const ruim = estadoSangueAtual({ [CHAVE_SANGUE]: { saldo: "x", usos: {}, historico: [] } });
    assert.equal(ruim.ok, false);
    if (!ruim.ok) assert.equal(ruim.codigo, "sangue_invalido");
  });
});
