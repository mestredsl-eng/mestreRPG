import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { characters, sessions, sheetVersions } from "../db/schema.js";
import { carregarRegras, type RegrasCampanha } from "./regras.js";
import { campoVisivelPara, estruturaFichaSchema, type EstruturaFicha, type Visibilidade } from "./ficha.js";
import { vidaParaFicha } from "./vida.js";
import type { PapelVtt, TokenVtt, VttState } from "./vtt.js";

// ---------- Vida (HP/condição) nos tokens da Mesa Virtual ----------
// O estado NUNCA é persistido em vtt_state: é derivado por destinatário
// a cada emissão, depois do filtro canônico de visibilidade — token que
// o cliente não recebe nunca carrega vida no payload.

export interface VidaToken {
  hp: { atual: number; maximo: number } | null;
  vitalidade: { nivel: number; nome: string } | null;
}

interface PersonagemVida {
  membershipId: string; data: Record<string, unknown>; isNpc: boolean;
  templateVersionId: string | null; overrides: Record<string, unknown>;
}

export interface CtxVida {
  campaignId: string;
  regras: RegrasCampanha;
  compartilhada: boolean;
  chars: Map<string, PersonagemVida>;
  estruturas: Map<string, EstruturaFicha>;
}

type CharRow = typeof characters.$inferSelect;

/** Carrega personagens vinculados aos tokens + regras + estruturas (1x por emissão). */
export async function prepararVidaVtt(sessionId: string, tokens: TokenVtt[]): Promise<CtxVida | null> {
  const pids = [...new Set(tokens.map((t) => t.personagemId).filter((p): p is string => !!p))];
  // HP manual também obedece a vidaCompartilhada. Mesmo sem fichas
  // vinculadas, precisamos carregar a configuração da campanha para não
  // expor HP de NPCs/tokens sem personagem quando o compartilhamento está OFF.
  const temHpManual = tokens.some((t) => !t.personagemId && !!t.hpManual);
  if (!pids.length && !temHpManual) return null;
  const db = getDb();
  const [sess] = await db.select({ campaignId: sessions.campaignId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!sess) return null;
  const regras = await carregarRegras(sess.campaignId);
  const rows = pids.length
    ? await db.select().from(characters)
      .where(and(eq(characters.campaignId, sess.campaignId), inArray(characters.id, pids)))
    : [];
  const versionIds = [...new Set(rows.map((r) => r.templateVersionId).filter((v): v is string => !!v))];
  const estruturas = new Map<string, EstruturaFicha>();
  if (versionIds.length) {
    const vers = await db.select().from(sheetVersions).where(inArray(sheetVersions.id, versionIds));
    for (const v of vers) {
      const parse = estruturaFichaSchema.safeParse(v.structure);
      if (parse.success) estruturas.set(v.id, parse.data);
    }
  }
  const chars = new Map<string, PersonagemVida>();
  for (const r of rows as CharRow[]) {
    chars.set(r.id, {
      membershipId: r.membershipId, data: (r.data ?? {}) as Record<string, unknown>,
      isNpc: !!r.isNpc, templateVersionId: r.templateVersionId,
      overrides: (r.overrides ?? {}) as Record<string, unknown>,
    });
  }
  return {
    campaignId: sess.campaignId, regras,
    compartilhada: regras.config.vtt?.vidaCompartilhada === true,
    chars, estruturas,
  };
}

function vidaParaPersonagem(
  ctx: CtxVida, p: PersonagemVida, papel: PapelVtt, userId: string,
  membershipId: string | undefined, ehDono: boolean
): VidaToken | null {
  if (!p.templateVersionId) return null;
  const estrutura = ctx.estruturas.get(p.templateVersionId);
  if (!estrutura) return null;
  const ehMestre = papel === "mestre";
  const dados = p.data;
  // ehDono efetivo = membership do personagem pertence ao leitor (mesma
  // regra da ficha); token.userId direto sem ficha não gera vida.
  const dono = ehDono;
  if (!ehMestre && !dono && !ctx.compartilhada) return null;
  let campos: Record<string, unknown> | undefined;
  let estruturaFiltrada: EstruturaFicha | undefined;
  const visaoFiltrada = !ehMestre && !dono;
  if (visaoFiltrada) {
    const overrides = p.overrides as Record<string, { visibilidade?: Visibilidade; destinatarios?: string[] } | undefined>;
    const camposVis: Record<string, unknown> = {};
    const estFiltrada: EstruturaFicha = { ...estrutura, secoes: [] };
    const visMap = new Map<string, typeof estrutura.secoes[number]["campos"]>();
    for (const secao of estrutura.secoes) {
      visMap.set(secao.id, secao.campos.filter((c) =>
        campoVisivelPara(c, overrides[c.id], false, false, userId, membershipId)));
    }
    const temFilho = (id: string) => estrutura.secoes.some((s) => s.parentId === id && (visMap.get(s.id)?.length ?? 0) > 0);
    for (const secao of estrutura.secoes) {
      const vis = visMap.get(secao.id) ?? [];
      if (!vis.length && !temFilho(secao.id)) continue;
      estFiltrada.secoes.push({ ...secao, campos: vis });
      for (const c of vis) {
        if (c.tipo === "calculado") continue;
        camposVis[c.id] = dados[c.id] ?? c.padrao ?? null;
      }
    }
    campos = camposVis;
    estruturaFiltrada = estFiltrada;
  }
  const vida = vidaParaFicha({
    isNpc: p.isNpc, ehMestre, ehDono: dono, visaoFiltrada,
    dados, campos, estrutura, estruturaFiltrada, regras: ctx.regras,
  });
  if (!vida) return null;
  const hp = vida.hp ? { atual: vida.hp.atual, maximo: vida.hp.maximo } : null;
  const vit = vida.vitalidade ? { nivel: vida.vitalidade.nivel, nome: vida.vitalidade.nome } : null;
  if (!hp && !vit) return null;
  return { hp, vitalidade: vit };
}

/**
 * Anexa `vida` aos tokens do estado JÁ FILTRADO para o destinatário.
 * Nunca muta a entrada; tokens sem vínculo ou sem vida retornam null.
 */
export function vidaNoEstado(
  ctx: CtxVida | null, vtt: VttState, papel: PapelVtt, userId: string,
  membershipId: string | undefined, donos: Map<string, string | null>
): VttState {
  // ehDono por token: `donos` (dono efetivo resolvido no servidor via
  // membership ativa do personagem) — equivale à regra da ficha.
  // efetivo do token) — equivale à membership do personagem, pois
  // donosDosTokens resolve personagemId→userId por membership ativa.
  return {
    ...vtt,
    tokens: vtt.tokens.map((tk) => {
      // hpManual é interno: NUNCA sai no payload — só vira vida.hp quando
      // o token sobreviveu ao filtro canônico e não tem ficha vinculada.
      const { hpManual, ...resto } = tk;
      if (!tk.personagemId) {
        // F14: HP manual segue a mesma política global da vida derivada
        // de ficha. Com compartilhamento OFF, só o mestre recebe o valor.
        const podeVerHpManual = papel === "mestre" || ctx?.compartilhada === true;
        return {
          ...resto,
          vida: hpManual && podeVerHpManual
            ? { hp: { atual: hpManual.atual, maximo: hpManual.maximo }, vitalidade: null }
            : null,
        };
      }
      if (!ctx) return { ...resto, vida: null };
      const p = ctx.chars.get(tk.personagemId);
      if (!p) return { ...resto, vida: null };
      const ehDono = donos.get(tk.id) === userId;
      const vida = vidaParaPersonagem(ctx, p, papel, userId, membershipId, ehDono);
      return { ...resto, vida };
    }),
  };
}
