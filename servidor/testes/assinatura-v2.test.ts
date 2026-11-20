import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  assinarLedgerXp,
  assinarPacoteV2,
  impressaoDigitalFicha,
  xpSemAssinaturaRaiz,
} from "../src/lib/assinatura-xp.js";
import {
  montarContextoSaneamento,
  sanearPersonagemImportado,
  type ContextoSaneamento,
  type SaneamentoPersonagem,
} from "../src/lib/saneamento-importacao.js";

// Issue #186/C3 — HMAC v2 conjunto XP+Sangue (`__sangue_sig`).
// Payload: {v:2, personagemId, campanhaIdOrigem, xp, sangue, regrasFp,
// fichaFp}. O marcador é verificado sobre o JSON ORIGINAL antes de
// qualquer saneador mutar os ledgers.

const CHAVE = randomBytes(32);
const CHAVE_ERRADA = randomBytes(32);
const CAMPANHA = "camp-origem-1";
const PID = "11111111-2222-4333-8444-555555555555";

const SANGUE = { saldo: 3, historico: [{ em: "2025-01-01T00:00:00Z", tipo: "ganho", quantidade: 3 }] };
const XP_OK = { saldo: 0, historico: [] };
const ESTRUTURA = { secoes: [{ id: "s1", campos: [{ id: "c1", tipo: "inteiro" }] }] };
const ESTRUTURA_ADULTERADA = { secoes: [{ id: "s1", campos: [{ id: "c1", tipo: "decimal" }] }] };
const CONFIG_SANGUE = { habilitado: true, campoCapacidadeId: "c1" };
const CONFIG_SANGUE_ADULTERADO = { habilitado: true, campoCapacidadeId: "c2" };

function dadosPacote(opts: {
  estrutura?: unknown; configSangue?: unknown;
} = {}) {
  return {
    ruleSets: [{
      id: "rs1", isActive: true,
      config: { sangue: opts.configSangue === undefined ? CONFIG_SANGUE : opts.configSangue },
    }],
    ruleDefinitions: [],
    sheetVersions: [{ id: "tv-1", structure: opts.estrutura === undefined ? ESTRUTURA : opts.estrutura }],
    files: [],
    campanha: {},
  };
}

function ctxSan(
  chave: Buffer = CHAVE,
  campanhaIdOrigem: string | null = CAMPANHA,
  dados = dadosPacote(),
): ContextoSaneamento {
  return montarContextoSaneamento(dados, new Map(), { chaveAssinatura: chave, campanhaIdOrigem });
}

function fp(): string {
  const s = ctxSan().assinatura;
  assert.ok(s);
  return s.regrasFp;
}

// fichaFp do lado da assinatura — deve reproduzir o que o saneador
// calcula a partir do pacote (templateVersionId da linha + estrutura
// bruta de tv-1 + config.sangue do ruleset ativo).
function fichaFpDe(o: {
  templateVersionId?: unknown; estrutura?: unknown; configSangue?: unknown;
} = {}): string {
  return impressaoDigitalFicha({
    templateVersionId: o.templateVersionId === undefined ? null : o.templateVersionId,
    estrutura: o.estrutura === undefined ? null : o.estrutura,
    configSangue: o.configSangue === undefined ? CONFIG_SANGUE : o.configSangue,
  });
}
// fichaFp efetivo quando a linha TEM templateVersionId="tv-1"
function fichaFpTv1(): string {
  return impressaoDigitalFicha({
    templateVersionId: "tv-1", estrutura: ESTRUTURA, configSangue: CONFIG_SANGUE,
  });
}

function assV2(opts: {
  chave?: Buffer; personagemId?: string; xp?: unknown; sangue?: unknown;
  campanhaIdOrigem?: string | null; fichaFp?: string;
} = {}): string {
  return assinarPacoteV2(
    {
      chave: opts.chave ?? CHAVE,
      regrasFp: fp(),
      campanhaIdOrigem: opts.campanhaIdOrigem === undefined ? CAMPANHA : opts.campanhaIdOrigem,
    },
    {
      personagemId: opts.personagemId ?? PID,
      xp: opts.xp === undefined ? xpSemAssinaturaRaiz(XP_OK) : opts.xp,
      sangue: opts.sangue === undefined ? SANGUE : opts.sangue,
      fichaFp: opts.fichaFp ?? fichaFpDe(),
    },
  );
}

function repVazio(): SaneamentoPersonagem {
  return {
    personagemId: "", nome: null, eventosXpDescartados: 0, ledgerXpInvalidado: false,
    financiadoRejeitados: 0, seloRemovido: false, bonusAjustado: false,
    pontosHistoricoDescartados: 0, hpHistoricoDescartados: 0, hpCorrigido: false, hpRemovido: false,
    vitalidadeHistoricoDescartados: 0, vitalidadeCorrigida: false, vitalidadeRemovida: false,
    retratoRemovido: false, npcVisivelRemovido: false,
    sangueRemovido: false, sangueAutenticado: false, sangueInvalido: false, motivoSangue: null,
  };
}

function sanear(
  data: Record<string, unknown>,
  ctx = ctxSan(),
  personagemId = PID,
  templateVersionId?: string,
) {
  const row: Record<string, unknown> = { id: personagemId, data };
  if (templateVersionId !== undefined) row.templateVersionId = templateVersionId;
  const rep = repVazio();
  sanearPersonagemImportado(row, ctx, rep);
  return { data: row.data as Record<string, unknown>, rep };
}

describe("assinatura v2 conjunta XP+Sangue (Issue #186/C3)", () => {
  it("roundtrip: v2 válida preserva __sangue e __xp, remove a credencial", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const { data: d, rep } = sanear(data);
    assert.equal(rep.sangueAutenticado, true);
    assert.equal(rep.sangueRemovido, false);
    assert.equal(rep.sangueInvalido, false);
    assert.equal(rep.ledgerXpInvalidado, false);
    assert.deepEqual(d.__sangue, SANGUE);
    assert.deepEqual(d.__xp, XP_OK);
    assert.equal("__sangue_sig" in d, false);
  });

  it("roundtrip com ficha: templateVersionId + estrutura + config.sangue autenticados", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2({ fichaFp: fichaFpTv1() }),
    };
    const { data: d, rep } = sanear(data, ctxSan(), PID, "tv-1");
    assert.equal(rep.sangueAutenticado, true);
    assert.deepEqual(d.__sangue, SANGUE);
  });

  it("roundtrip sem __xp: v2 cobre somente Sangue", () => {
    const data: Record<string, unknown> = {
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2({ xp: null }),
    };
    const { data: d, rep } = sanear(data);
    assert.equal(rep.sangueAutenticado, true);
    assert.deepEqual(d.__sangue, SANGUE);
    assert.equal("__xp" in d, false);
  });

  it("adulteração do Sangue rejeita XP e Sangue conjuntamente", () => {
    const data: Record<string, unknown> = {
      __xp: { saldo: 0, historico: [], sig: "v1.residual" },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    (data.__sangue as Record<string, unknown>).saldo = 99;
    const { data: d, rep } = sanear(data);
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.sangueRemovido, true);
    assert.equal(rep.motivoSangue, "assinatura_invalida");
    // rejeição conjunta: XP zera MESMO com __xp.sig residual — sem fallback v1
    assert.equal(rep.ledgerXpInvalidado, true);
    assert.deepEqual(d.__xp, { saldo: 0, historico: [] });
    assert.equal("__sangue" in d, false);
    assert.equal("__sangue_sig" in d, false);
  });

  it("adulteração do XP rejeita o par (v2 cobre os dois ledgers)", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    (data.__xp as Record<string, unknown>).saldo = 7;
    const { data: d, rep } = sanear(data);
    assert.equal(rep.sangueInvalido, true);
    assert.equal("__sangue" in d, false);
    assert.deepEqual(d.__xp, { saldo: 0, historico: [] });
  });

  it("templateVersionId divergente invalida a v2 (fichaFp)", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2({ fichaFp: fichaFpTv1() }),
    };
    // pacote alterado: personagem revinculado a outra versão após assinar
    const { rep } = sanear(data, ctxSan(), PID, "tv-2");
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "assinatura_invalida");
  });

  it("estrutura publicada adulterada invalida a v2 (fichaFp)", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2({ fichaFp: fichaFpTv1() }),
    };
    const ctxAdulterado = ctxSan(CHAVE, CAMPANHA, dadosPacote({ estrutura: ESTRUTURA_ADULTERADA }));
    const { rep } = sanear(data, ctxAdulterado, PID, "tv-1");
    assert.equal(rep.sangueInvalido, true);
  });

  it("config.sangue adulterada invalida a v2 (fichaFp)", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2({ fichaFp: fichaFpTv1() }),
    };
    const ctxAdulterado = ctxSan(CHAVE, CAMPANHA, dadosPacote({ configSangue: CONFIG_SANGUE_ADULTERADO }));
    const { rep } = sanear(data, ctxAdulterado, PID, "tv-1");
    assert.equal(rep.sangueInvalido, true);
  });

  it("chave errada: v2 de outra instalação rejeita conjuntamente", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2({ chave: CHAVE_ERRADA }),
    };
    const { data: d, rep } = sanear(data, ctxSan(CHAVE));
    assert.equal(rep.sangueInvalido, true);
    assert.equal("__sangue" in d, false);
    assert.deepEqual(d.__xp, { saldo: 0, historico: [] });
  });

  it("campanhaIdOrigem divergente invalida a v2", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2({ campanhaIdOrigem: "outra-campanha" }),
    };
    const { rep } = sanear(data);
    assert.equal(rep.sangueInvalido, true);
  });

  it("prefixo desconhecido (v3.) com __sangue = marcador inválido, sem fallback", () => {
    const data: Record<string, unknown> = {
      __xp: { saldo: 0, historico: [], sig: assinarLedgerXp(
        { chave: CHAVE, regrasFp: fp() }, PID, XP_OK,
      ) },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: "v3." + "ab".repeat(32),
    };
    const { data: d, rep } = sanear(data);
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "prefixo_desconhecido");
    assert.equal(rep.ledgerXpInvalidado, true);
    assert.equal("__sangue" in d, false);
  });

  it("v1 sem Sangue continua compatível", () => {
    const data: Record<string, unknown> = {
      __xp: {
        ...XP_OK,
        sig: assinarLedgerXp({ chave: CHAVE, regrasFp: fp() }, PID, XP_OK),
      },
    };
    const { data: d, rep } = sanear(data);
    assert.equal(rep.ledgerXpInvalidado, false);
    assert.deepEqual(d.__xp, XP_OK);
    assert.equal(rep.sangueRemovido, false);
    assert.equal(rep.sangueAutenticado, false);
  });

  it("v1 com Sangue: XP valida por v1, Sangue descartado e registrado", () => {
    const data: Record<string, unknown> = {
      __xp: {
        ...XP_OK,
        sig: assinarLedgerXp({ chave: CHAVE, regrasFp: fp() }, PID, XP_OK),
      },
      __sangue: structuredClone(SANGUE),
    };
    const { data: d, rep } = sanear(data);
    assert.equal(rep.ledgerXpInvalidado, false);
    assert.deepEqual(d.__xp, XP_OK);
    assert.equal(rep.sangueRemovido, true);
    assert.equal(rep.sangueAutenticado, false);
    assert.equal("__sangue" in d, false);
  });

  it("__sangue sem nenhum marcador é descartado (sem prova própria)", () => {
    const data: Record<string, unknown> = {
      __xp: {
        ...XP_OK,
        sig: assinarLedgerXp({ chave: CHAVE, regrasFp: fp() }, PID, XP_OK),
      },
      __sangue: structuredClone(SANGUE),
    };
    const { data: d, rep } = sanear(data);
    assert.equal(rep.sangueRemovido, true);
    assert.equal(rep.motivoSangue, "sem_assinatura_v2");
    assert.equal("__sangue" in d, false);
  });

  it("marcador órfão (sem __sangue): descartado, XP segue fluxo v1", () => {
    const data: Record<string, unknown> = {
      __xp: {
        ...XP_OK,
        sig: assinarLedgerXp({ chave: CHAVE, regrasFp: fp() }, PID, XP_OK),
      },
      __sangue_sig: assV2({ sangue: null }),
    };
    const { data: d, rep } = sanear(data);
    assert.equal(rep.sangueRemovido, true);
    assert.equal(rep.motivoSangue, "marcador_orfao");
    assert.equal(rep.sangueInvalido, false);
    assert.equal(rep.ledgerXpInvalidado, false);
    assert.deepEqual(d.__xp, XP_OK);
    assert.equal("__sangue_sig" in d, false);
  });

  it("personagemId divergente invalida a v2", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2({ personagemId: "outro-personagem" }),
    };
    const { rep } = sanear(data);
    assert.equal(rep.sangueInvalido, true);
  });

  it("sem chave de instalação: v2 não verifica → rejeição conjunta", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const ctx = montarContextoSaneamento(dadosPacote(), new Map(), {
      chaveAssinatura: null, campanhaIdOrigem: CAMPANHA,
    });
    const { data: d, rep } = sanear(data, ctx);
    assert.equal(rep.sangueInvalido, true);
    assert.equal("__sangue" in d, false);
  });
});
