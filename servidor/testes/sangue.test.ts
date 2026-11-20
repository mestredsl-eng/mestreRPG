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
    // com campoId mas sem coeficiente → ainda sem bônus
    const cfgSemCoef: ConfigSangue = { ...cfg, capacidade: { bonusQualidade: { campoId: "qual" } } };
    assert.equal(resolverCapacidadeSangue(e, dados, cfgSemCoef).capacidade, 5);
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
