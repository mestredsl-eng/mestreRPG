import { and, eq } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { memberships, characters } from "../db/schema.js";
import type { Router, RequestHandler } from "express";
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
      registrarLeaseHandler(res, liberar);
    }
    next();
  };
}

// ---------- ciclo de vida do lease HTTP ----------
// O lease NÃO é liberado por eventos de socket (finish/close): o que
// conta é o término real da Promise do handler de negócio. O contrato:
//  - requirePapel/requireLeasePersonagem registram {liberar, iniciado}
//    em res.locals[CHAVE_LEASE];
//  - res.end só libera quando o handler final NUNCA iniciou (resposta
//    curta por middleware anterior, ex.: rate limit 429);
//  - uma vez iniciado, o ÚLTIMO handler da rota é envolvido por
//    vincularLeaseAoHandler(): o lease é liberado no settle da Promise
//    retornada — resposta enviada antes do fim do trabalho assíncrono
//    NÃO libera, e desconexão tampouco;
//  - handler síncrono/retorno antecipado libera ao retornar;
//  - uma única aquisição e uma única liberação (flag liberado).

const CHAVE_LEASE = "__leaseCampanhaHandler";

type LeaseReg = { liberar: () => void; iniciado: boolean; liberado: boolean };

function soltarLeaseReg(l: LeaseReg) {
  if (l.liberado) return;
  l.liberado = true;
  l.liberar();
}

function registrarLeaseHandler(res: Response, liberar: () => void) {
  const reg: LeaseReg = { liberar, iniciado: false, liberado: false };
  res.locals[CHAVE_LEASE] = reg;
  // fallback para rotas cujo handler final nunca inicia (middleware
  // posterior responde e encerra, ex.: rate limit): só libera se o
  // handler NÃO iniciou — res.end no meio do handler não libera
  // porque `iniciado` já é true.
  const endOriginal = res.end.bind(res);
  res.end = ((...args: unknown[]) => {
    if (!reg.iniciado) soltarLeaseReg(reg);
    const r = (endOriginal as (...a: unknown[]) => unknown)(...args);
    return r;
  }) as typeof res.end;
}

/**
 * Envolve o ÚLTIMO handler de cada rota do router: quando a rota
 * possui lease registrado (requirePapel/requireLeasePersonagem em
 * método mutante), a liberação acontece no settle real da Promise do
 * handler — nunca antes, mesmo que res.end já tenha disparado.
 * Rotas sem lease passam direto (no-op). Aplicar UMA vez por router,
 * depois de todas as rotas definidas.
 */
export function vincularLeaseAoHandler(router: Router) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const layer of (router as any).stack ?? []) {
    const route = layer?.route;
    const stack = route?.stack;
    if (!Array.isArray(stack) || stack.length === 0) continue;
    const ultimo = stack[stack.length - 1];
    const orig = ultimo.handle as RequestHandler;
    ultimo.handle = function (this: unknown, req: Request, res: Response, next: NextFunction) {
      const reg = res.locals?.[CHAVE_LEASE] as LeaseReg | undefined;
      if (!reg) return orig.apply(this, arguments as never);
      reg.iniciado = true;
      let r: unknown;
      try {
        // eslint-disable-next-line prefer-rest-params
        r = orig.apply(this, arguments as never);
      } catch (e) {
        soltarLeaseReg(reg);
        throw e;
      }
      if (r && typeof (r as Promise<unknown>).then === "function") {
        // settle real da Promise do handler — finally semântico:
        // sucesso, rejeição ou término após res.end todos liberam aqui
        void (r as Promise<unknown>).then(
          () => soltarLeaseReg(reg),
          () => soltarLeaseReg(reg),
        );
        return r;
      }
      // handler síncrono: retornou = terminou
      soltarLeaseReg(reg);
      return r;
    } as RequestHandler;
  }
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
    registrarLeaseHandler(res, liberar);
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
