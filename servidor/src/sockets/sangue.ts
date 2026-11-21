// Issue #186 R6.3 — runtime Socket.IO das ações de Sangue.
// Transforma a camada pura `lib/sangue-acoes.ts` (#224) em ações reais:
// ativação narrativa de Poder fora do D10, recuperação por natureza,
// ajuste manual do mestre e reconciliação de capacidade reduzida.
//
// Contrato do runtime (camada pura não confia no cliente):
//  - TODO o contexto é carregado e revalidado no servidor: personagem,
//    campanha, membership/papel, dono da ficha, ficha/estrutura da
//    versão vinculada, ruleset/config e ledger atual;
//  - mutação dentro de UMA transação SQLite síncrona — characters.data
//    gravado uma única vez; qualquer falha faz rollback integral;
//  - emissões realtime SOMENTE após o commit, pelo canal de campanha
//    já existente (`personagens:atualizados`);
//  - custo/quantidade/capacidade/natureza NUNCA vêm do cliente.

import type { Server as SocketIOServer, Socket } from "socket.io";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { characters, memberships, sheetVersions } from "../db/schema.js";
import { estruturaFichaSchema, type EstruturaFicha } from "../lib/ficha.js";
import {
  barreiraRestauracaoAtiva,
  emitirCampanha,
  pausaTesteEmit,
  opCampanhaALS,
  leaseOperacaoALS,
  liberarLeasesALS,
} from "../lib/io.js";
import { carregarRegrasSincrono, extrairEscolhas } from "../lib/regras.js";
import { agendarAutosave } from "../lib/autosave.js";
import { resolverCapacidadeSangue, lerSangue } from "../lib/sangue.js";
import {
  ativarPoderNarrativo,
  recuperarSangue,
  ajustarSangueManual,
  reconciliarCapacidade,
  type ConfigSangueAcoes,
  type ResultadoAcaoSangue,
} from "../lib/sangue-acoes.js";
import { criarLimitadorSocket } from "../lib/socket-rate-limit.js";

const db = getDb();

type Usuario = { id: string; username: string; displayName?: string | null };
type Papel = "mestre" | "jogador" | "espectador";

// ---------- rate limit local (não edita a tabela compartilhada da mesa) ----------

interface AcaoLimitada { nome: string; capacidade: number; porSegundo: number }
const ACOES_SANGUE = {
  ativar: { nome: "sangue-ativar", capacidade: 30, porSegundo: 5 },
  recuperar: { nome: "sangue-recuperar", capacidade: 30, porSegundo: 5 },
  ajustar: { nome: "sangue-ajustar", capacidade: 30, porSegundo: 5 },
  reconciliar: { nome: "sangue-reconciliar", capacidade: 20, porSegundo: 3 },
} as const satisfies Record<string, AcaoLimitada>;
type AcaoSangueLimitada = keyof typeof ACOES_SANGUE;
const limitadores = new Map<AcaoSangueLimitada, ReturnType<typeof criarLimitadorSocket>>();
function limitador(acao: AcaoSangueLimitada) {
  let l = limitadores.get(acao);
  if (!l) {
    l = criarLimitadorSocket({ ...ACOES_SANGUE[acao] });
    limitadores.set(acao, l);
  }
  return l;
}
function consumirOuRecusar(socket: Socket, acao: AcaoSangueLimitada, cb?: (r: Ack) => void): boolean {
  const u = socket.data.usuario as Usuario | undefined;
  if (!u) return true;
  const r = limitador(acao).consumir(`${ACOES_SANGUE[acao].nome}:${u.id}`);
  if (r.permitido) return true;
  cb?.({ ok: false, codigo: "RATE_LIMITED", erro: "Muitas ações em pouco tempo", retryAfterMs: r.retryAfterMs } as Ack);
  return false;
}

// ---------- ACK ----------

type AckOk = {
  ok: true;
  replay: boolean;
  ajustado?: boolean;
  estado: { saldo: number; capacidade?: number };
};
type AckErro = { ok: false; codigo: string; erro: string; saldo?: number };
type Ack = AckOk | AckErro;

const MENSAGENS: Record<string, string> = {
  recurso_desabilitado: "Pontos de Sangue desabilitados nesta campanha",
  sangue_invalido: "Ledger de Sangue inválido — reconciliação necessária",
  saldo_insuficiente: "Saldo de Sangue insuficiente",
  uso_invalido: "Requisição inválida",
  uso_conflito: "Conflito de idempotência no ledger",
  quantidade_invalida: "Quantidade inválida",
  recuperacao_desabilitada: "Recuperação desabilitada nesta campanha",
  poder_desconhecido: "Poder não existe nas regras da campanha",
  poder_nao_adquirido: "Personagem não possui este Poder na ficha",
  custo_invalido: "Custo de Sangue inválido na configuração",
  natureza_indisponivel: "Natureza do personagem indisponível",
  natureza_sem_acao: "Natureza sem ação de recuperação mapeada",
  acao_desabilitada: "Ação de recuperação desabilitada",
  capacidade_excedida: "Ajuste ultrapassaria a capacidade de Sangue",
  config_invalida: "Configuração de regras inválida — operação recusada",
  erro_interno: "Falha interna — operação não aplicada",
  sem_permissao: "Sem permissão para esta ação",
  nao_encontrado: "Personagem não encontrado",
  arquivado: "Personagem arquivado — somente leitura",
  sem_ficha: "Personagem sem ficha configurada",
};

function ackErro(codigo: string, saldo?: number): AckErro {
  return {
    ok: false,
    codigo,
    erro: MENSAGENS[codigo] ?? `Ação recusada (${codigo})`,
    ...(saldo !== undefined ? { saldo } : {}),
  };
}
function ackOk(r: ResultadoAcaoSangue, ajustado?: boolean): Ack {
  if (!r.ok) return ackErro(r.codigo, r.saldo);
  return {
    ok: true,
    replay: r.replay,
    ...(ajustado !== undefined ? { ajustado } : {}),
    estado: {
      saldo: r.estado.saldo,
      ...(r.estado.capacidade !== undefined ? { capacidade: r.estado.capacidade } : {}),
    },
  };
}

// ---------- contexto ----------

interface PersonagemCtx {
  personagem: typeof characters.$inferSelect;
  estrutura: EstruturaFicha;
  usuario: Usuario;
  papel: Papel;
  ehDono: boolean;
  donoAtivo: boolean;
}

async function carregarPreTx(
  socket: Socket,
  characterId: string,
): Promise<PersonagemCtx | { erro: string }> {
  const usuario = socket.data.usuario as Usuario | undefined;
  if (!usuario) return { erro: "Não autenticado" };
  const [personagem] = await db.select().from(characters).where(eq(characters.id, characterId)).limit(1);
  if (!personagem) return { erro: "nao_encontrado" };
  if (barreiraRestauracaoAtiva(personagem.campaignId)) return { erro: "Campanha em restauração" };
  const [m] = await db.select().from(memberships)
    .where(and(
      eq(memberships.campaignId, personagem.campaignId),
      eq(memberships.userId, usuario.id),
      eq(memberships.status, "ativo"),
    )).limit(1);
  if (!m) return { erro: "sem_permissao" };
  // lease da operação inteira (ALS): cobre tx + emissões; falha se a
  // barreira de restauração já existe.
  if (opCampanhaALS.getStore() && !leaseOperacaoALS(personagem.campaignId)) {
    return { erro: "Campanha em restauração" };
  }
  const [dono] = await db.select({ userId: memberships.userId, status: memberships.status, campaignId: memberships.campaignId })
    .from(memberships).where(eq(memberships.id, personagem.membershipId)).limit(1);
  const estrutura = personagem.templateVersionId
    ? await (async () => {
        const [v] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, personagem.templateVersionId!)).limit(1);
        if (!v) return null;
        const parse = estruturaFichaSchema.safeParse(v.structure);
        return parse.success ? parse.data : null;
      })()
    : null;
  if (!estrutura) return { erro: "sem_ficha" };
  return {
    personagem,
    estrutura,
    usuario,
    papel: m.role as Papel,
    ehDono: dono?.userId === usuario.id,
    donoAtivo: dono?.status === "ativo" && dono?.campaignId === personagem.campaignId,
  };
}

// ---------- handler ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Acao = "ativar" | "recuperar" | "ajustar" | "reconciliar";

/** Resultado da camada pura OU erro de autorização do runtime
 *  (sem_permissao/capacidade_excedida não fazem parte do union da
 *  camada — o transporte responde com o mesmo ACK estável). */
type ResultadoDominio =
  | ResultadoAcaoSangue
  | { ok: false; codigo: string; saldo?: number };

function socketSangue(io: SocketIOServer) {
  io.on("connection", (socket) => {
    const on = (evento: string, handler: (...args: never[]) => unknown) => {
      socket.on(evento, (...args: unknown[]) => {
        void opCampanhaALS.run({ ops: new Map() }, async () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (handler as (...a: any[]) => unknown)(...(args as any[]));
          } finally {
            liberarLeasesALS();
          }
        });
      });
    };

    /** Núcleo comum: pré-carga → transação síncrona → ACK + emissões
     *  pós-commit. `executar` recebe dados/regras FRESCOS da tx e
     *  devolve o ResultadoAcaoSangue da camada pura. */
    async function executarAcao(
      acao: Acao,
      payload: Record<string, unknown>,
      cb: ((r: Ack) => void) | undefined,
      executar: (args: {
        dados: Record<string, unknown>;
        ctx: PersonagemCtx & { personagem: typeof characters.$inferSelect };
        config: ConfigSangueAcoes | null | undefined;
        regras: NonNullable<ReturnType<typeof carregarRegrasSincrono>>;
        autor: { id: string; nome: string };
        /** Contexto com papel/dono REVALIDADOS dentro da tx — nunca
         *  o snapshot da pré-carga. */
        papelTx: Papel;
        ehDonoTx: boolean;
        donoAtivoTx: boolean;
      }) => ResultadoDominio,
    ) {
      const characterId = typeof payload?.characterId === "string" ? payload.characterId : "";
      if (!characterId) { cb?.(ackErro("uso_invalido")); return; }
      const ctx = await carregarPreTx(socket, characterId);
      if ("erro" in ctx) {
        cb?.(ctx.erro === "nao_encontrado" ? ackErro("nao_encontrado")
          : ctx.erro === "sem_ficha" ? ackErro("sem_ficha")
          : ctx.erro === "sem_permissao" ? ackErro("sem_permissao")
          : ackErro("recurso_desabilitado"));
        return;
      }
      const { personagem } = ctx;
      const autorNome = (socket.data.usuario as Usuario | undefined)?.displayName
        ?? (socket.data.usuario as Usuario | undefined)?.username ?? "?";
      const agora = new Date();

      type TxRes =
        | { tipo: "ok"; ack: Ack }
        | { tipo: "falha"; ack: AckErro };

      let txRes: TxRes;
      try {
        txRes = db.transaction((tx): TxRes => {
          // Releitura fresca dentro da tx — personagem, papel e dono
          // nunca vêm do snapshot da pré-carga.
          const [atual] = tx.select().from(characters).where(eq(characters.id, personagem.id)).limit(1).all();
          if (!atual || atual.campaignId !== personagem.campaignId) {
            return { tipo: "falha", ack: ackErro("nao_encontrado") };
          }
          if (atual.status === "arquivado") {
            return { tipo: "falha", ack: ackErro("arquivado") };
          }
          const [mv] = tx.select().from(memberships)
            .where(and(
              eq(memberships.campaignId, atual.campaignId),
              eq(memberships.userId, ctx.usuario.id),
              eq(memberships.status, "ativo"),
            )).limit(1).all();
          if (!mv) return { tipo: "falha", ack: ackErro("sem_permissao") };
          const [dono] = tx.select({ userId: memberships.userId, status: memberships.status, campaignId: memberships.campaignId })
            .from(memberships).where(eq(memberships.id, atual.membershipId)).limit(1).all();
          const papelTx = mv.role as Papel;
          const ehDonoTx = dono?.userId === ctx.usuario.id && dono?.status === "ativo" && dono.campaignId === atual.campaignId;

          // Regras FRESCAS da transação — config.sangue vigente.
          // Config que viola o schema (ex.: custo negativo injetado
          // direto no banco) aborta aqui de forma fail-closed.
          let regrasTx: ReturnType<typeof carregarRegrasSincrono>;
          try {
            regrasTx = carregarRegrasSincrono(tx, atual.campaignId);
          } catch {
            return { tipo: "falha", ack: ackErro("config_invalida") };
          }
          if (!regrasTx) return { tipo: "falha", ack: ackErro("recurso_desabilitado") };
          const config = regrasTx.config.sangue as ConfigSangueAcoes | null | undefined;

          const dados = (atual.data ?? {}) as Record<string, unknown>;
          const ctxTx = {
            ...ctx,
            personagem: atual,
            papel: papelTx,
            ehDono: ehDonoTx,
            donoAtivo: dono?.status === "ativo" && dono.campaignId === atual.campaignId,
          };
          const r = executar({
            dados,
            ctx: ctxTx,
            config,
            regras: regrasTx,
            autor: { id: ctx.usuario.id, nome: autorNome },
            papelTx,
            ehDonoTx,
            donoAtivoTx: ctxTx.donoAtivo,
          });
          if (!r.ok) return { tipo: "falha", ack: ackErro(r.codigo, r.saldo) };
          // personagens.data gravado UMA única vez por operação.
          tx.update(characters).set({ data: r.dados, updatedAt: agora }).where(eq(characters.id, atual.id)).run();
          const ajustado = acao === "reconciliar" && "ajustado" in r ? r.ajustado : undefined;
          return { tipo: "ok", ack: ackOk(r as ResultadoAcaoSangue, ajustado) };
        });
      } catch {
        // Falha SQLite/inesperada dentro da tx → rollback integral,
        // nenhum ACK de sucesso, nenhuma emissão.
        cb?.(ackErro("erro_interno"));
        return;
      }

      if (txRes.tipo === "falha") { cb?.(txRes.ack); return; }
      // ---------- pós-commit: somente agora o estado é durável ----------
      await pausaTesteEmit(JSON.stringify({ acao, characterId: personagem.id, fase: "pos-write" }));
      agendarAutosave(personagem.campaignId);
      emitirCampanha(personagem.campaignId, "personagens:atualizados", { characterId: personagem.id });
      cb?.(txRes.ack);
    }

    /** Dono da ficha (não espectador) — ativação/recuperação nunca
     *  podem ser feitas pelo mestre "no lugar do jogador". Usa o
     *  contexto REVALIDADO dentro da tx (papelTx/ehDonoTx). */
    const exigirDonoTx = (papelTx: Papel, ehDonoTx: boolean, donoAtivoTx: boolean): string | null => {
      if (papelTx === "espectador" || !ehDonoTx || !donoAtivoTx) return "sem_permissao";
      return null;
    };

    /** `sangue:ativar` {characterId, poderKey, requestId, motivo?}
     *  Ativação narrativa de Poder fora do D10 — custo vem só da
     *  config do ruleset; `ativar:<requestId>` idempotente. */
    on("sangue:ativar", (payload: Record<string, unknown>, cb?: (r: Ack) => void) => {
      if (!consumirOuRecusar(socket, "ativar", cb)) return;
      const poderKey = typeof payload?.poderKey === "string" ? payload.poderKey.trim() : "";
      const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
      if (!poderKey || poderKey.length > 80 || !UUID_RE.test(requestId)) {
        cb?.(ackErro("uso_invalido")); return;
      }
      return executarAcao("ativar", payload, cb, ({ dados, ctx: c2, config, regras, autor, papelTx, ehDonoTx, donoAtivoTx }) => {
        const neg = exigirDonoTx(papelTx, ehDonoTx, donoAtivoTx);
        if (neg) return { ok: false as const, codigo: neg };
        // Recurso desabilitado corta antes de custo/ledger — ruleset
        // carregado ≠ Sangue habilitado (P1 coordenação #7056711233).
        if (config?.habilitado !== true) {
          return { ok: false as const, codigo: "recurso_desabilitado" };
        }
        const poderesValidos = new Set((regras.porKind.get("poder") ?? []).map((e) => e.key));
        if (!poderesValidos.has(poderKey)) {
          return { ok: false as const, codigo: "poder_desconhecido" };
        }
        // O Poder precisa existir no ruleset E estar na ficha atual
        // do personagem (revalidado aqui, dentro da tx).
        const possui = extrairEscolhas(c2.estrutura, dados, regras).some(
          (e) => e.elemento?.kind === "poder" && e.elemento.key === poderKey && e.selecionado && e.level >= 1,
        );
        if (!possui) return { ok: false as const, codigo: "poder_nao_adquirido" };
        return ativarPoderNarrativo(dados, {
          personagemId: c2.personagem.id,
          autorId: autor.id,
          autorNome: autor.nome,
          motivo: typeof payload?.motivo === "string" ? payload.motivo : null,
          poderKey,
          requestId,
          config,
          poderesValidos,
        });
      });
    });

    /** `sangue:recuperar` {characterId, requestId, motivo?}
     *  Recuperação contextual: o servidor deriva natureza → ação
     *  (Descansar/Alimentar-se) → quantidade/habilitação da config.
     *  O cliente nunca envia ação, quantidade ou capacidade. */
    on("sangue:recuperar", (payload: Record<string, unknown>, cb?: (r: Ack) => void) => {
      if (!consumirOuRecusar(socket, "recuperar", cb)) return;
      const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
      if (!UUID_RE.test(requestId)) { cb?.(ackErro("uso_invalido")); return; }
      return executarAcao("recuperar", payload, cb, ({ dados, ctx: c2, config, autor, papelTx, ehDonoTx, donoAtivoTx }) => {
        const neg = exigirDonoTx(papelTx, ehDonoTx, donoAtivoTx);
        if (neg) return { ok: false as const, codigo: neg };
        const cap = resolverCapacidadeSangue(c2.estrutura, dados, config ?? undefined);
        return recuperarSangue(dados, {
          personagemId: c2.personagem.id,
          autorId: autor.id,
          autorNome: autor.nome,
          motivo: typeof payload?.motivo === "string" ? payload.motivo : null,
          requestId,
          estrutura: c2.estrutura,
          dadosFicha: dados,
          config,
          capacidadeMax: cap.disponivel ? cap.capacidade : null,
        });
      });
    });

    /** `sangue:ajustar` {characterId, delta, motivo}
     *  Ajuste manual — SOMENTE mestre ativo da campanha; delta finito
     *  ≠ 0 e motivo obrigatório (a primitiva impõe ambos). Ajuste
     *  positivo nunca ultrapassa a capacidade resolvida do servidor. */
    on("sangue:ajustar", (payload: Record<string, unknown>, cb?: (r: Ack) => void) => {
      if (!consumirOuRecusar(socket, "ajustar", cb)) return;
      const delta = typeof payload?.delta === "number" ? payload.delta : NaN;
      const motivo = typeof payload?.motivo === "string" ? payload.motivo : "";
      if (!Number.isFinite(delta) || delta === 0 || !motivo.trim()) {
        cb?.(ackErro("quantidade_invalida")); return;
      }
      return executarAcao("ajustar", payload, cb, ({ dados, ctx: c2, config, autor, papelTx }) => {
        if (papelTx !== "mestre") return { ok: false as const, codigo: "sem_permissao" };
        // Ajuste positivo exige capacidade resolvida — nunca acima
        // do teto válido. Negativo só reduz (o primitivo rejeita
        // saldo < 0).
        if (delta > 0) {
          const cap = resolverCapacidadeSangue(c2.estrutura, dados, config ?? undefined);
          const saldo = lerSangue(dados).estado.saldo;
          if (!cap.disponivel || cap.capacidade === null || saldo + delta > cap.capacidade) {
            return { ok: false as const, codigo: "capacidade_excedida", saldo };
          }
        }
        return ajustarSangueManual(dados, {
          personagemId: c2.personagem.id,
          autorId: autor.id,
          autorNome: autor.nome,
          motivo,
          delta,
        });
      });
    });

    /** `sangue:reconciliar-capacidade` {characterId, motivo}
     *  Reconciliação explícita e auditável após redução de capacidade
     *  — SOMENTE mestre; motivo obrigatório; ajuste negativo exato
     *  até o novo teto; nunca apaga histórico nem trunca `usos`. */
    on("sangue:reconciliar-capacidade", (payload: Record<string, unknown>, cb?: (r: Ack) => void) => {
      if (!consumirOuRecusar(socket, "reconciliar", cb)) return;
      const motivo = typeof payload?.motivo === "string" ? payload.motivo : "";
      if (!motivo.trim()) { cb?.(ackErro("quantidade_invalida")); return; }
      return executarAcao("reconciliar", payload, cb, ({ dados, ctx: c2, config, autor, papelTx }) => {
        if (papelTx !== "mestre") return { ok: false as const, codigo: "sem_permissao" };
        const cap = resolverCapacidadeSangue(c2.estrutura, dados, config ?? undefined);
        return reconciliarCapacidade(dados, {
          personagemId: c2.personagem.id,
          autorId: autor.id,
          autorNome: autor.nome,
          motivo,
          capacidadeNova: cap.disponivel ? cap.capacidade : null,
        });
      });
    });
  });
}

export function registrarSangue(io: SocketIOServer) {
  socketSangue(io);
}
