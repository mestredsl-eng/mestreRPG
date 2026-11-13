import { and, eq } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { memberships, characters } from "../db/schema.js";
import { adquirirOperacaoCampanha } from "./io.js";

export type PapelCampanha = "mestre" | "jogador" | "espectador";
export type StatusMembro = "pendente" | "ativo" | "bloqueado" | "removido";

export interface MembershipInfo {
  id: string;
  campaignId: string;
  userId: string;
  role: PapelCampanha;
  status: StatusMembro;
  permissions: unknown;
}

const db = getDb();

export async function getMembership(
  campaignId: string,
  userId: string
): Promise<MembershipInfo | null> {
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.campaignId, campaignId), eq(memberships.userId, userId)))
    .limit(1);
  if (!m) return null;
  return {
    id: m.id,
    campaignId: m.campaignId,
    userId: m.userId,
    role: m.role as PapelCampanha,
    status: m.status as StatusMembro,
    permissions: m.permissions,
  };
}

/**
 * Middleware: exige que o usuário autenticado seja membro ativo da campanha
 * com um dos papéis informados. Admin global NÃO tem acesso automático
 * (spec §4: ser admin não torna mestre de todas as campanhas).
 *
 * `comLease` (padrão true em requirePapel): métodos mutantes seguram um
 * lease de operação da campanha — a restauração drena estes leases antes
 * de capturar o estado. A liberação acontece quando a RESPOSTA é
 * efetivamente escrita (res.end — cobre json/send/status/sendFile etc.),
 * NÃO em `close`: uma desconexão do cliente não libera o lease enquanto
 * o handler assíncrono ainda executa. Rotas que coordenam a própria
 * barreira usam requirePapelAuth (sem lease) para não deadlockar.
 */
export function requirePapel(...papeis: PapelCampanha[]) {
  return requirePapelInterno(papeis, true);
}

/** Variante SEM lease: somente autenticação/autorização de papel.
 *  Reservada a rotas que adquirem a barreira de restauração elas mesmas. */
export function requirePapelAuth(...papeis: PapelCampanha[]) {
  return requirePapelInterno(papeis, false);
}

function requirePapelInterno(papeis: PapelCampanha[], comLease: boolean) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const usuario = req.usuario;
    const campaignId = req.params.campaignId ?? req.params.id;
    if (!usuario || !campaignId) {
      res.status(401).json({ erro: "Não autenticado" });
      return;
    }
    const m = await getMembership(campaignId, usuario.id);
    if (!m || m.status !== "ativo" || !papeis.includes(m.role)) {
      res.status(403).json({ erro: "Sem permissão nesta campanha" });
      return;
    }
    req.membership = m;
    const mutante = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (comLease && mutante) {
      const liberar = adquirirOperacaoCampanha(campaignId);
      if (!liberar) {
        res.status(409).json({ erro: "Campanha em restauração — tente novamente em instantes" });
        return;
      }
      soltarAoFinalizar(res, liberar);
    }
    next();
  };
}

/** Libera o lease quando a resposta é efetivamente escrita (res.end).
 *  `close` propositalmente NÃO libera: o handler pode continuar
 *  gravando após a queda do socket; se ele nunca responder, o lease
 *  permanece (fail-closed). */
function soltarAoFinalizar(res: Response, liberar: () => void) {
  let solto = false;
  const soltar = () => {
    if (solto) return;
    solto = true;
    liberar();
  };
  const endOriginal = res.end.bind(res);
  res.end = ((...args: unknown[]) => {
    const r = (endOriginal as (...a: unknown[]) => unknown)(...args);
    soltar();
    return r;
  }) as typeof res.end;
}

/**
 * Lease para rotas cujo escopo é o PERSONAGEM (:characterId), sem
 * :campaignId na rota — ex.: /api/characters/:characterId e o router
 * de patrimônio. Personagens, inventário, equipamentos, veículos e
 * finanças fazem parte do estado exportado/restaurado: mutações
 * precisam drenar com a barreira. A campanha é resolvida pelo
 * personagem; sem personagem/campanha resolvível, segue sem lease
 * (o handler responde 404/403). Não substitui a autorização — apenas
 * serializa a mutação com a restauração.
 */
export function requireLeasePersonagem() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) { next(); return; }
    let campaignId = req.params.campaignId as string | undefined;
    if (!campaignId && req.params.characterId) {
      const [c] = await db
        .select({ campaignId: characters.campaignId })
        .from(characters)
        .where(eq(characters.id, req.params.characterId))
        .limit(1);
      campaignId = c?.campaignId;
    }
    if (!campaignId) { next(); return; }
    const liberar = adquirirOperacaoCampanha(campaignId);
    if (!liberar) {
      res.status(409).json({ erro: "Campanha em restauração — tente novamente em instantes" });
      return;
    }
    soltarAoFinalizar(res, liberar);
    next();
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      membership?: MembershipInfo;
    }
  }
}

// ---- Permissões individuais do membro (Etapa 13 — modo espectador) ----

export interface PermissoesMembro {
  /** Espectador pode enviar mensagens no chat (padrão: não). */
  enviarMensagens?: boolean;
  /** Espectador pode ver a biblioteca de arquivos (padrão: sim, se a campanha permitir). */
  verBiblioteca?: boolean;
  /** Espectador pode consultar o histórico detalhado de sessões (padrão: sim). */
  verHistorico?: boolean;
}

export const permissoesMembroSchema = z.object({
  enviarMensagens: z.boolean().optional(),
  verBiblioteca: z.boolean().optional(),
  verHistorico: z.boolean().optional(),
}).strict();

/** Lê as permissões do membro de forma segura (JSON arbitrário → objeto tipado). */
export function permissoesDe(m: { permissions: unknown } | null | undefined): PermissoesMembro {
  const p = m?.permissions;
  if (!p || typeof p !== "object" || Array.isArray(p)) return {};
  return p as PermissoesMembro;
}

/** Conta mestres ativos de uma campanha (para impedir campanha sem responsável). */
export async function contarMestres(campaignId: string): Promise<number> {
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.campaignId, campaignId),
        eq(memberships.role, "mestre"),
        eq(memberships.status, "ativo")
      )
    );
  return rows.length;
}
