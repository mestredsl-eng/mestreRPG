import { Router } from "express";
import { and, eq, ne } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { characters, memberships, sheetVersions, users } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import { carregarRegrasSincrono, configRegrasSchema, type RegrasCampanha } from "../lib/regras.js";
import { estruturaFichaSchema, type EstruturaFicha } from "../lib/ficha.js";
import { defeitosDaFicha, type DefeitoPainel } from "../lib/defeitos.js";

const db = getDb();
export const defeitosRouter = Router({ mergeParams: true });
defeitosRouter.use(requireAuth);

const ESTRUTURA_VAZIA: EstruturaFicha = {
  versao: 1,
  secoes: [],
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
};

/**
 * GET /api/campaigns/:campaignId/defeitos — painel do mestre na Mesa.
 * Lista os personagens ativos da campanha com os defeitos registrados
 * em suas fichas (nível + descrição do nível), resolvidos pela
 * biblioteca da campanha. Jogadores recebem 403 — a visão coletiva
 * é ferramenta administrativa e nunca vaza para o jogador.
 */
defeitosRouter.get("/", requirePapel("mestre"), async (req, res) => {
  const campaignId = req.params.campaignId;

  const rows = await db
    .select({ personagem: characters, user: users, membership: memberships })
    .from(characters)
    .innerJoin(memberships, eq(characters.membershipId, memberships.id))
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(and(eq(characters.campaignId, campaignId), ne(characters.status, "arquivado")))
    .orderBy(characters.name);

  // GET é consulta pura: NUNCA cria ruleset. Campanha sem ruleset ativo
  // devolve o painel com regras vazias (nenhum defeito resolvível) em
  // vez de materializar a biblioteca padrão como efeito colateral.
  const regras: RegrasCampanha = carregarRegrasSincrono(db, campaignId) ?? {
    ruleSetId: null,
    config: configRegrasSchema.parse({}),
    elementos: new Map(),
    porKind: new Map(),
  };

  // estruturas por templateVersionId — personagens costumam dividir a
  // mesma versão publicada, então o cache evita releituras repetidas
  const estruturas = new Map<string, EstruturaFicha>();
  const estruturaDe = async (versionId: string | null): Promise<EstruturaFicha> => {
    if (!versionId) return ESTRUTURA_VAZIA;
    const cache = estruturas.get(versionId);
    if (cache) return cache;
    const [v] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, versionId)).limit(1);
    const parse = v ? estruturaFichaSchema.safeParse(v.structure) : null;
    const estrutura = parse?.success ? parse.data : ESTRUTURA_VAZIA;
    estruturas.set(versionId, estrutura);
    return estrutura;
  };

  const lista = [];
  for (const r of rows) {
    const estrutura = await estruturaDe(r.personagem.templateVersionId);
    const dados = (r.personagem.data && typeof r.personagem.data === "object"
      ? r.personagem.data
      : {}) as Record<string, unknown>;
    const defeitos: DefeitoPainel[] = defeitosDaFicha(estrutura, dados, regras);
    lista.push({
      id: r.personagem.id,
      nome: r.personagem.name,
      jogador: r.user.displayName || r.user.username,
      ehNpc: !!r.personagem.isNpc,
      defeitos,
    });
  }

  res.json({ personagens: lista });
});
