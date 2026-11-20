import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import {
  assinarLedgerXp,
  assinarPacoteV2,
  xpSemAssinaturaRaiz,
} from "../src/lib/assinatura-xp.js";
import {
  montarContextoSaneamento,
  sanearPersonagemImportado,
  type ContextoSaneamento,
  type SaneamentoPersonagem,
} from "../src/lib/saneamento-importacao.js";

// Issue #186/C3 — HMAC v2 conjunto XP+Sangue (`__sangue_sig`).
// O marcador é verificado sobre o JSON ORIGINAL antes de qualquer
// saneador mutar os ledgers.

const CHAVE = randomBytes(32);
const CHAVE_ERRADA = randomBytes(32);
const CAMPANHA = "camp-origem-1";
const PID = "11111111-2222-4333-8444-555555555555";

const SANGUE = { saldo: 3, historico: [{ em: "2025-01-01T00:00:00Z", tipo: "ganho", quantidade: 3 }] };
const XP_OK = { saldo: 0, historico: [] };

function ctxSan(chave: Buffer = CHAVE, campanhaIdOrigem: string | null = CAMPANHA): ContextoSaneamento {
  return montarContextoSaneamento(
    { ruleSets: [], ruleDefinitions: [], sheetVersions: [], files: [], campanha: {} },
    new Map(),
    { chaveAssinatura: chave, campanhaIdOrigem },
  );
}

// fingerprint das regras do pacote (coleções vazias → determinístico)
function fp(): string {
  const s = ctxSan().assinatura;
  assert.ok(s);
  return s.regrasFp;
}

function assV2(opts: {
  chave?: Buffer; personagemId?: string; xp?: unknown; sangue?: unknown;
  campanhaIdOrigem?: string | null;
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
    sangueRemovido: false, sangueAutenticado: false, assinaturaConjuntaRejeitada: false,
  };
}

function sanear(data: Record<string, unknown>, ctx = ctxSan(), personagemId = PID) {
  const row = { id: personagemId, data };
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
    assert.equal(rep.assinaturaConjuntaRejeitada, false);
    assert.equal(rep.ledgerXpInvalidado, false);
    assert.deepEqual(d.__sangue, SANGUE);
    assert.deepEqual(d.__xp, XP_OK);
    assert.equal("__sangue_sig" in d, false);
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
    // adultera DEPOIS de assinar — simula pacote editado em trânsito
    (data.__sangue as Record<string, unknown>).saldo = 99;
    const { data: d, rep } = sanear(data);
    assert.equal(rep.assinaturaConjuntaRejeitada, true);
    assert.equal(rep.sangueRemovido, true);
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
    assert.equal(rep.assinaturaConjuntaRejeitada, true);
    assert.equal("__sangue" in d, false);
    assert.deepEqual(d.__xp, { saldo: 0, historico: [] });
  });

  it("chave errada: v2 de outra instalação rejeita conjuntamente", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2({ chave: CHAVE_ERRADA }),
    };
    const { data: d, rep } = sanear(data, ctxSan(CHAVE));
    assert.equal(rep.assinaturaConjuntaRejeitada, true);
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
    assert.equal(rep.assinaturaConjuntaRejeitada, true);
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
    assert.equal(rep.assinaturaConjuntaRejeitada, true);
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
    assert.equal(rep.assinaturaConjuntaRejeitada, false);
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
    assert.equal(rep.assinaturaConjuntaRejeitada, true);
  });

  it("sem chave de instalação: v2 não verifica → rejeição conjunta", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const ctx = montarContextoSaneamento(
      { ruleSets: [], ruleDefinitions: [], sheetVersions: [], files: [], campanha: {} },
      new Map(),
      { chaveAssinatura: null, campanhaIdOrigem: CAMPANHA },
    );
    const { data: d, rep } = sanear(data, ctx);
    assert.equal(rep.assinaturaConjuntaRejeitada, true);
    assert.equal("__sangue" in d, false);
  });
});
