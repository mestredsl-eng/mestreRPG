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
// Payload canônico: {v:2, personagemId, xp, sangue, regrasFp, fichaFp}.
// A cadeia personagem→sheetVersion publicada→sheetTemplate→campanha de
// origem precisa estar íntegra no pacote; qualquer elo quebrado falha
// fechado antes mesmo do HMAC.

const CHAVE = randomBytes(32);
const CHAVE_ERRADA = randomBytes(32);
const CAMPANHA = "camp-origem-1";
const PID = "11111111-2222-4333-8444-555555555555";
const TV1 = "tv-1";

const SANGUE = { saldo: 3, historico: [{ em: "2025-01-01T00:00:00Z", tipo: "ganho", quantidade: 3 }] };
const XP_OK = { saldo: 0, historico: [] };
const ESTRUTURA = { secoes: [{ id: "s1", campos: [{ id: "c1", tipo: "inteiro" }] }] };
const ESTRUTURA_ADULTERADA = { secoes: [{ id: "s1", campos: [{ id: "c1", tipo: "decimal" }] }] };
const CONFIG_SANGUE = { habilitado: true, campoCapacidadeId: "c1" };
const CONFIG_SANGUE_ADULTERADO = { habilitado: true, campoCapacidadeId: "c2" };

function dadosPacote(opts: {
  estrutura?: unknown; configSangue?: unknown;
  sheetTemplates?: { id?: string; campaignId?: unknown }[];
  sheetVersions?: { id?: string; templateId?: unknown; structure?: unknown; publishedAt?: unknown }[];
  ruleSets?: { id?: string; campaignId?: unknown; config?: unknown; isActive?: boolean }[];
} = {}) {
  return {
    ruleSets: opts.ruleSets ?? [{
      id: "rs1", campaignId: CAMPANHA, isActive: true,
      config: { sangue: opts.configSangue === undefined ? CONFIG_SANGUE : opts.configSangue },
    }],
    ruleDefinitions: [],
    sheetVersions: opts.sheetVersions ?? [{
      id: TV1, templateId: "tpl-1",
      structure: opts.estrutura === undefined ? ESTRUTURA : opts.estrutura,
      publishedAt: 1,
    }],
    sheetTemplates: opts.sheetTemplates ?? [{ id: "tpl-1", campaignId: CAMPANHA }],
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

// fichaFp do lado da assinatura — reproduz o que o saneador calcula do
// pacote: templateVersionId da linha + estrutura bruta da versão +
// config.sangue do ruleset ativo único.
function fichaFpDe(o: {
  templateVersionId?: unknown; estrutura?: unknown; configSangue?: unknown;
} = {}): string {
  return impressaoDigitalFicha({
    templateVersionId: o.templateVersionId === undefined ? TV1 : o.templateVersionId,
    estrutura: o.estrutura === undefined ? ESTRUTURA : o.estrutura,
    configSangue: o.configSangue === undefined ? CONFIG_SANGUE : o.configSangue,
  });
}

function assV2(opts: {
  chave?: Buffer; personagemId?: string; xp?: unknown; sangue?: unknown;
  fichaFp?: string;
} = {}): string {
  return assinarPacoteV2(
    { chave: opts.chave ?? CHAVE, regrasFp: fp(), campanhaIdOrigem: CAMPANHA },
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
  templateVersionId: string | null = TV1,
) {
  const row: Record<string, unknown> = { id: personagemId, data };
  if (templateVersionId !== null) row.templateVersionId = templateVersionId;
  const rep = repVazio();
  sanearPersonagemImportado(row, ctx, rep);
  return { data: row.data as Record<string, unknown>, rep };
}

describe("assinatura v2 conjunta XP+Sangue (Issue #186/C3)", () => {
  it("reescrita coerente de campanha no envelope, template e ruleset invalida a HMAC v2", () => {
    const assinaturaOriginal = assV2();
    const campanhaAdulterada = "camp-origem-forjada";
    const dadosAdulterados = dadosPacote({
      ruleSets: [{
        id: "rs1", campaignId: campanhaAdulterada, isActive: true,
        config: { sangue: CONFIG_SANGUE },
      }],
      sheetTemplates: [{ id: "tpl-1", campaignId: campanhaAdulterada }],
    });
    // A cadeia local continua coerente com o envelope adulterado. A
    // rejeição precisa vir da impressão digital das regras, que inclui
    // o campaignId persistido no ruleset e está coberta pela v2.
    const ctxAdulterado = ctxSan(CHAVE, campanhaAdulterada, dadosAdulterados);
    const { data, rep } = sanear({
      __xp: structuredClone(XP_OK),
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assinaturaOriginal,
    }, ctxAdulterado);

    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "assinatura_invalida");
    assert.equal(rep.ledgerXpInvalidado, true);
    assert.deepEqual(data.__xp, { saldo: 0, historico: [] });
    assert.equal("__sangue" in data, false);
  });

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

  it("assinatura truncada/corrompida rejeita conjuntamente", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2().slice(0, -4) + "0000",
    };
    const { rep } = sanear(data);
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "assinatura_invalida");
  });

  it("templateVersionId divergente → cadeia incompleta, rejeição conjunta", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const { rep } = sanear(data, ctxSan(), PID, "tv-inexistente");
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "contexto_incompleto");
  });

  it("personagem sem templateVersionId → contexto incompleto", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const { rep } = sanear(data, ctxSan(), PID, null);
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "contexto_incompleto");
  });

  it("estrutura publicada adulterada invalida a v2 (fichaFp)", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const ctxAdulterado = ctxSan(CHAVE, CAMPANHA, dadosPacote({ estrutura: ESTRUTURA_ADULTERADA }));
    const { rep } = sanear(data, ctxAdulterado);
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "assinatura_invalida");
  });

  it("config.sangue adulterada invalida a v2 (fichaFp)", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const ctxAdulterado = ctxSan(CHAVE, CAMPANHA, dadosPacote({ configSangue: CONFIG_SANGUE_ADULTERADO }));
    const { rep } = sanear(data, ctxAdulterado);
    assert.equal(rep.sangueInvalido, true);
  });

  it("sheetTemplate de OUTRA campanha quebra a cadeia → contexto incompleto", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const ctxOutro = ctxSan(CHAVE, CAMPANHA, dadosPacote({
      sheetTemplates: [{ id: "tpl-1", campaignId: "camp-invasora" }],
    }));
    const { rep } = sanear(data, ctxOutro);
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "contexto_incompleto");
  });

  it("sheetVersion não publicada (publishedAt nulo) → contexto incompleto", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const ctxRascunho = ctxSan(CHAVE, CAMPANHA, dadosPacote({
      sheetVersions: [{ id: TV1, templateId: "tpl-1", structure: ESTRUTURA, publishedAt: null }],
    }));
    const { rep } = sanear(data, ctxRascunho);
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "contexto_incompleto");
  });

  it("dois rulesets ativos → pacote inelegível, rejeição conjunta", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const ctx2 = ctxSan(CHAVE, CAMPANHA, dadosPacote({
      ruleSets: [
        { id: "rs1", isActive: true, config: { sangue: CONFIG_SANGUE } },
        { id: "rs2", isActive: true, config: { sangue: CONFIG_SANGUE } },
      ],
    }));
    const { rep } = sanear(data, ctx2);
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "contexto_incompleto");
  });

  it("config.sangue ausente → pacote inelegível", () => {
    const data: Record<string, unknown> = {
      __xp: { ...XP_OK },
      __sangue: structuredClone(SANGUE),
      __sangue_sig: assV2(),
    };
    const ctxSem = ctxSan(CHAVE, CAMPANHA, dadosPacote({
      ruleSets: [{ id: "rs1", isActive: true, config: {} }],
    }));
    const { rep } = sanear(data, ctxSem);
    assert.equal(rep.sangueInvalido, true);
    assert.equal(rep.motivoSangue, "contexto_incompleto");
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
