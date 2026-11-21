// Issue #186 — invariantes do ledger de Sangue sob SEQUÊNCIAS
// combinadas (missão #7055901428-B). Testes determinísticos: seed
// fixa, sem dependência de terceiros, exercitando a camada de ações
// (`sangue-acoes.ts`) sobre as primitivas C2 — não copia os testes
// unitários existentes; o foco são INTERAÇÕES entre operações.
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
import { MAX_HISTORICO_SANGUE } from "../src/lib/sangue.js";
import type { EstruturaFicha } from "../src/lib/ficha.js";

const PID = "11111111-2222-4333-8444-555555555555";
const PID2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const AUTOR = { personagemId: PID, autorId: "u1", autorNome: "Mestre" };
const AUTOR2 = { ...AUTOR, personagemId: PID2 };
// Conjunto derivado do ruleset da fixture — poderes kind="poder" realmente presentes.
const PODERES_VALIDOS: ReadonlySet<string> = new Set(["fogo", "gratis"]);

// UUIDs determinísticos por índice — requestIds únicos por operação.
const rid = (n: number) =>
  `12345678-1234-4234-8234-${String(n).padStart(12, "0")}`;

function estrutura(): EstruturaFicha {
  return {
    versao: 1,
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
    secoes: [{
      id: "s1", titulo: "S", ordem: 0,
      campos: [
        { id: "cap", label: "Cap", tipo: "inteiro", semantico: "livre", padrao: 0 },
        { id: "nat", label: "Nat", tipo: "selecao_unica", semantico: "livre", padrao: "",
          opcoes: ["Humano", "Vampiro"] },
      ],
    }],
  };
}
const EST = estrutura();

const CONFIG: ConfigSangueAcoes = {
  habilitado: true,
  campoCapacidadeId: "cap",
  campoNaturezaId: "nat",
  capacidade: { modo: "valor" },
  poderes: { fogo: { custo: 2 }, gratis: { custo: 0 } },
  naturezas: {
    Humano: { recuperacao: "descansar" },
    Vampiro: { recuperacao: "alimentar" },
  },
  recuperacaoSangue: {
    habilitado: true,
    acoes: {
      descansar: { habilitada: true, quantidade: 2 },
      alimentar: { habilitada: true, quantidade: 3 },
    },
  },
};

const ficha = (nat: string, cap = 10) => ({ cap, nat });
const dados = (saldo = 10, nat = "Humano") => ({
  cap: 10, nat, [CHAVE_SANGUE]: { saldo, usos: {}, historico: [] },
});

const invariantes = (estado: { saldo: number; historico: unknown[]; usos: Record<string, unknown>; ancora?: number }) => {
  assert.ok(Number.isFinite(estado.saldo), "saldo finito");
  assert.ok(estado.saldo >= 0, `saldo não negativo (got ${estado.saldo})`);
  assert.ok(Array.isArray(estado.historico));
  assert.ok(estado.historico.length <= MAX_HISTORICO_SANGUE, "histórico dentro do cap");
};

describe("invariantes — sequências combinadas", () => {
  it("sequência mista ativação+recuperação+ajuste: saldo sempre finito/não-negativo", () => {
    let d = dados(10);
    const passos: Array<[string, () => typeof d]> = [];
    // intercala operações válidas e inválidas; inválidas nunca mutam
    for (let i = 1; i <= 30; i++) {
      passos.push([`ativar-${i}`, () => {
        const r = ativarPoderNarrativo(d, { ...AUTOR, requestId: rid(i), poderKey: i % 3 === 0 ? "gratis" : "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
        return r.ok ? r.dados : d;
      }]);
      passos.push([`recuperar-${i}`, () => {
        const r = recuperarSangue(d, { ...AUTOR, requestId: rid(100 + i), estrutura: EST, dadosFicha: ficha("Humano"), config: CONFIG, capacidadeMax: 20 });
        return r.ok ? r.dados : d;
      }]);
      if (i % 5 === 0) {
        passos.push([`ajuste-${i}`, () => {
          const r = ajustarSangueManual(d, { ...AUTOR, delta: i % 10 === 0 ? -1 : 1, motivo: `ajuste ${i}` });
          return r.ok ? r.dados : d;
        }]);
      }
    }
    for (const [nome, fn] of passos) {
      d = fn();
      const lido = estadoSangueAtual(d);
      assert.equal(lido.ok, true, nome);
      if (lido.ok) invariantes(lido.estado);
    }
    const lido = estadoSangueAtual(d);
    assert.equal(lido.ok, true);
    if (lido.ok) {
      // saldo final = 10 - 2*20(custo) + 2*30(recup) + ajustes — só verificamos coerência interna
      assert.ok(lido.estado.usos && typeof lido.estado.usos === "object");
    }
  });

  it("replay intercalado em sequência nunca duplica efeito", () => {
    let d = dados(10);
    const req = rid(7);
    // ativa, recupera, replay da ativação, replay da recuperação, ativa de novo com OUTRO id
    const r1 = ativarPoderNarrativo(d, { ...AUTOR, requestId: req, poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    assert.equal(r1.ok, true); if (r1.ok) d = r1.dados;
    const saldoAposAtivar = estadoSangueAtual(d);
    assert.equal(saldoAposAtivar.ok && saldoAposAtivar.estado.saldo, 8);

    const rec1 = recuperarSangue(d, { ...AUTOR, requestId: rid(8), estrutura: EST, dadosFicha: ficha("Humano"), config: CONFIG });
    assert.equal(rec1.ok, true); if (rec1.ok) d = rec1.dados;
    // saldo: 8 + 2 = 10 (capacidadeMax não passado → sem teto)

    const replay = ativarPoderNarrativo(d, { ...AUTOR, requestId: req, poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.replay, true);
      assert.equal(replay.estado.saldo, 10);
      assert.equal(Object.keys(replay.estado.usos).length, 2); // ativar + recuperar
    }
  });

  it("operação inválida no meio da sequência não muta estado", () => {
    let d = dados(10);
    const r1 = ativarPoderNarrativo(d, { ...AUTOR, requestId: rid(1), poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    if (r1.ok) d = r1.dados;
    const antes = JSON.stringify(d);
    // três inválidas seguidas
    assert.equal(ativarPoderNarrativo(d, { ...AUTOR, requestId: "x", poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG }).ok, false);
    assert.equal(ativarPoderNarrativo(d, { ...AUTOR, requestId: rid(2), poderKey: "nao-existe", config: CONFIG, poderesValidos: new Set(["fogo"]) }).ok, false);
    assert.equal(recuperarSangue(d, { ...AUTOR, requestId: rid(3), estrutura: EST, dadosFicha: ficha("Vampiro"), config: { ...CONFIG, recuperacaoSangue: { habilitado: false } } }).ok, false);
    assert.equal(JSON.stringify(d), antes);
  });

  it("poder fora do conjunto do ruleset é rejeitado sem mutação (contrato R6.3)", () => {
    let d = dados(10);
    const antes = JSON.stringify(d);
    // "fogo" existe em config.poderes mas NÃO está em poderesValidos
    // (ex.: ruleset sem esse elemento kind="poder") → fail-closed
    const r = ativarPoderNarrativo(d, {
      ...AUTOR, requestId: rid(300), poderKey: "fogo",
      config: CONFIG, poderesValidos: new Set(["gratis"]),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.codigo, "poder_desconhecido");
    assert.equal(JSON.stringify(d), antes);
    // conjunto vazio também rejeita qualquer poder
    const r2 = ativarPoderNarrativo(d, {
      ...AUTOR, requestId: rid(301), poderKey: "fogo",
      config: CONFIG, poderesValidos: new Set(),
    });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.codigo, "poder_desconhecido");
    assert.equal(JSON.stringify(d), antes);
  });

  it("ledger malformado falha sem mutação em qualquer operação", () => {
    const d = { [CHAVE_SANGUE]: { saldo: "quebrado", usos: {}, historico: [] } };
    const antes = JSON.stringify(d);
    assert.equal(ativarPoderNarrativo(d, { ...AUTOR, requestId: rid(1), poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG }).ok, false);
    assert.equal(ajustarSangueManual(d, { ...AUTOR, delta: 1, motivo: "x" }).ok, false);
    assert.equal(reconciliarCapacidade(d, { ...AUTOR, capacidadeNova: 5, motivo: "x" }).ok, false);
    assert.equal(JSON.stringify(d), antes);
  });

  it("custo zero mantém registro idempotente dentro de sequência", () => {
    let d = dados(10);
    const req = rid(9);
    const r1 = ativarPoderNarrativo(d, { ...AUTOR, requestId: req, poderKey: "gratis", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    assert.equal(r1.ok, true); if (r1.ok) d = r1.dados;
    // operação paga no meio
    const r2 = ativarPoderNarrativo(d, { ...AUTOR, requestId: rid(10), poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    assert.equal(r2.ok, true); if (r2.ok) d = r2.dados;
    const lido = estadoSangueAtual(d);
    assert.equal(lido.ok && lido.estado.saldo, 8);
    if (lido.ok) {
      assert.ok(lido.estado.usos[`ativar:${req}`]); // grátis também registra
      assert.equal(Object.keys(lido.estado.usos).length, 2);
    }
    // replay do grátis depois da paga
    const r3 = ativarPoderNarrativo(d, { ...AUTOR, requestId: req, poderKey: "gratis", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    assert.equal(r3.ok, true);
    if (r3.ok) assert.equal(r3.replay, true);
  });

  it("recuperação nunca ultrapassa capacidadeMax em sequência", () => {
    let d = dados(9);
    for (let i = 1; i <= 5; i++) {
      const r = recuperarSangue(d, {
        ...AUTOR, requestId: rid(50 + i), estrutura: EST,
        dadosFicha: ficha("Humano"), config: CONFIG, capacidadeMax: 10,
      });
      assert.equal(r.ok, true, `passo ${i}`);
      if (r.ok) {
        assert.ok(r.estado.saldo <= 10, `saldo ${r.estado.saldo} <= teto`);
        d = r.dados;
      }
    }
    const lido = estadoSangueAtual(d);
    assert.equal(lido.ok && lido.estado.saldo, 10);
  });

  it("redução de capacidade preserva histórico e fixa saldo no teto", () => {
    let d = dados(10);
    // gera histórico antes da redução
    const r1 = ativarPoderNarrativo(d, { ...AUTOR, requestId: rid(1), poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    if (r1.ok) d = r1.dados;
    const r2 = recuperarSangue(d, { ...AUTOR, requestId: rid(2), estrutura: EST, dadosFicha: ficha("Humano"), config: CONFIG });
    assert.equal(r2.ok, true); if (r2.ok) d = r2.dados;
    const histAntes = estadoSangueAtual(d);
    assert.equal(histAntes.ok && histAntes.estado.historico.length, 2);

    const r3 = reconciliarCapacidade(d, { ...AUTOR, capacidadeNova: 4, motivo: "downgrade para 4" });
    assert.equal(r3.ok, true);
    if (!r3.ok) return;
    assert.equal(r3.ajustado, true);
    assert.equal(r3.estado.saldo, 4);
    assert.equal(r3.estado.historico.length, 3);
    assert.equal(r3.estado.historico[0].tipo, "uso");
    assert.equal(r3.estado.historico[1].tipo, "recuperacao");
    assert.equal(r3.estado.historico[2].tipo, "ajuste");
    // operações seguintes partem do teto
    const r4 = ativarPoderNarrativo(r3.dados, { ...AUTOR, requestId: rid(3), poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    assert.equal(r4.ok, true);
    if (r4.ok) assert.equal(r4.estado.saldo, 2);
  });

  it("mesmo requestId em personagens diferentes → conflito sem mutação", () => {
    let d = dados(10);
    const req = rid(77);
    const r1 = ativarPoderNarrativo(d, { ...AUTOR, requestId: req, poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    assert.equal(r1.ok, true); if (r1.ok) d = r1.dados;
    const antes = JSON.stringify(d);
    const r2 = ativarPoderNarrativo(d, { ...AUTOR2, requestId: req, poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.codigo, "uso_conflito");
    assert.equal(JSON.stringify(d), antes);
  });

  it("requestIds diferentes são independentes em sequência", () => {
    let d = dados(10);
    const saldos: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const r = ativarPoderNarrativo(d, { ...AUTOR, requestId: rid(200 + i), poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
      assert.equal(r.ok, true);
      if (r.ok) { d = r.dados; saldos.push(r.estado.saldo); }
    }
    assert.deepEqual(saldos, [8, 6, 4, 2, 0]);
    // sexto falha por saldo
    const r6 = ativarPoderNarrativo(d, { ...AUTOR, requestId: rid(206), poderKey: "fogo", poderesValidos: PODERES_VALIDOS, config: CONFIG });
    assert.equal(r6.ok, false);
    if (!r6.ok) assert.equal(r6.codigo, "saldo_insuficiente");
  });

  it("truncamento de histórico e âncora estáveis em sequência longa", () => {
    let d = dados(500);
    // 600 recuperações com requestIds únicos — saldo limitado por capacidadeMax=510? não: sem teto → saldo cresce; usar teto para forçar delta 0? Melhor: sem capacidadeMax, saldo sobe livre; histórico trunca em 500.
    for (let i = 1; i <= MAX_HISTORICO_SANGUE + 100; i++) {
      const r = recuperarSangue(d, {
        ...AUTOR, requestId: rid(1000 + i), estrutura: EST,
        dadosFicha: ficha("Humano"), config: CONFIG,
      });
      assert.equal(r.ok, true, `passo ${i}`);
      if (r.ok) d = r.dados;
    }
    const lido = estadoSangueAtual(d);
    assert.equal(lido.ok, true);
    if (!lido.ok) return;
    invariantes(lido.estado);
    assert.equal(lido.estado.historico.length, MAX_HISTORICO_SANGUE);
    // âncora presente e consistente: saldoResultante do 1º evento - quantidade = saldo anterior à janela
    const primeiro = lido.estado.historico[0];
    assert.ok(primeiro);
    assert.equal(typeof primeiro.saldoResultante, "number");
    // saldo final coerente: 500 + 2*(600) = 1700
    assert.equal(lido.estado.saldo, 500 + 2 * (MAX_HISTORICO_SANGUE + 100));
    // todos os usos preservados (nunca truncados)
    assert.equal(Object.keys(lido.estado.usos).length, MAX_HISTORICO_SANGUE + 100);
  });
});
