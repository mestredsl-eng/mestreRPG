// Identidade do banco (L4) — Issue #380.
//
// Âncora: `instalacaoIdBanco` persistido em server_settings (viaja com
// backup/restore por ser dado; sem migration). Chave reservada
// `protocolo.instalacaoIdBanco` — só os módulos do protocolo a alteram;
// a API de settings do admin usa chaves fixas e não a alcança.
//
// Ordem canônica de gravação (spec §Recuperação de crash):
//   INTENÇÃO → linha SQLite → recibo externo → consumo da intenção.
// Sem intenção válida, transição de identidade NÃO é autorizada
// (fail-closed). O uuid é fixado na intenção e nunca regenerado.
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { RAIZ } from "../db/index.js";

export const CHAVE_INSTALACAO_ID_BANCO = "protocolo.instalacaoIdBanco";
const PROTOCOLO_ID_BANCO = 1;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function instalacaoIdBancoValido(v: unknown): v is string {
  return typeof v === "string" && RE_UUID.test(v);
}

/** Lê a linha de identidade. Aceita JSON {id,...} ou string crua. */
export function lerInstalacaoIdBanco(sqlite: Database.Database): string | null {
  const tem = sqlite
    .prepare("select name from sqlite_master where type='table' and name='server_settings'")
    .get();
  if (!tem) return null;
  const row = sqlite
    .prepare("select value from server_settings where key=?")
    .get(CHAVE_INSTALACAO_ID_BANCO) as { value?: unknown } | undefined;
  if (!row?.value) return null;
  let valor: unknown = row.value;
  if (typeof valor === "string") {
    try { valor = JSON.parse(valor); } catch { /* string crua */ }
  }
  if (valor && typeof valor === "object") {
    const id = (valor as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return typeof valor === "string" ? valor : null;
}

/** Grava a linha de identidade preservando `criadoEm` de uma linha
 *  bem-formada preexistente (clone de instalação adotada). */
export function gravarInstalacaoIdBanco(sqlite: Database.Database, id: string): void {
  const row = sqlite
    .prepare("select value from server_settings where key=?")
    .get(CHAVE_INSTALACAO_ID_BANCO) as { value?: unknown } | undefined;
  let criadoEm: string | undefined;
  try {
    const v = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value;
    if (v && typeof v === "object" && typeof (v as { criadoEm?: unknown }).criadoEm === "string") {
      criadoEm = (v as { criadoEm: string }).criadoEm;
    }
  } catch { /* valor legado */ }
  const valor = JSON.stringify({
    id,
    criadoEm: criadoEm ?? new Date().toISOString(),
    versaoProtocolo: PROTOCOLO_ID_BANCO,
  });
  sqlite
    .prepare(
      `insert into server_settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value=excluded.value, updated_at=excluded.updated_at`,
    )
    .run(CHAVE_INSTALACAO_ID_BANCO, valor, Date.now());
}

// ---------- estado externo (scripts/estado-externo.mjs, JS) ----------
export interface EstadoExternoMod {
  dirEstado(repoDir: string, env?: NodeJS.ProcessEnv): string;
  caminhoCanonico(repoDir: string): string;
  lerReciboInstalacao(repoDir: string, env?: NodeJS.ProcessEnv): { status: string; dados?: Record<string, unknown> };
  lerIntencaoVinculacao(repoDir: string, env?: NodeJS.ProcessEnv): { status: string; dados?: Record<string, unknown> };
  gravarIntencaoVinculacao(repoDir: string, dados: Record<string, unknown>, env?: NodeJS.ProcessEnv): unknown;
  consumirIntencaoVinculacao(repoDir: string, env?: NodeJS.ProcessEnv): void;
  atualizarReciboInstalacao(repoDir: string, env: NodeJS.ProcessEnv | undefined, patch: Record<string, unknown>): { atualizado: boolean; motivo?: string };
  sha256ReciboInstalacao(repoDir: string, env?: NodeJS.ProcessEnv): string | null;
}

export async function carregarEstadoExterno(): Promise<EstadoExternoMod | null> {
  try {
    const href = new URL("../../../scripts/estado-externo.mjs", import.meta.url).href;
    return (await import(href)) as EstadoExternoMod;
  } catch {
    return null;
  }
}

export function sha256Texto(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Fases do vínculo — o chamador orquestra a ordem canônica:
 *  preparar → gravarIdNoBanco → (recibo) → concluir. */
export function prepararIntencao(opts: {
  estado: EstadoExternoMod;
  tipo: "vinculacao-inicial" | "reatribuicao-restore";
  idFixo: string;
  env?: NodeJS.ProcessEnv;
  repoDir?: string;
}): { intencaoId: string; reutilizada: boolean } {
  const repoDir = opts.repoDir ?? RAIZ;
  const env = opts.env ?? process.env;
  const existente = opts.estado.lerIntencaoVinculacao(repoDir, env);
  if (existente.status === "ok") {
    const id = (existente.dados as { instalacaoIdBanco?: unknown })?.instalacaoIdBanco;
    if (id === opts.idFixo) return { intencaoId: String(id), reutilizada: true };
    // Intenção pendente com id divergente: não sobrescrever — a
    // recuperação decide (B4/B5 bloqueiam). Fail-closed.
    throw new Error(`intenção de vínculo pendente com id divergente (${String(id)})`);
  }
  if (existente.status !== "ausente") {
    throw new Error(`intenção de vínculo ilegível (${existente.status})`);
  }
  const reciboSha = opts.estado.sha256ReciboInstalacao(repoDir, env);
  opts.estado.gravarIntencaoVinculacao(repoDir, {
    protocolo: "identidade-vinculacao",
    versao: 1,
    instalacaoIdBanco: opts.idFixo,
    tipo: opts.tipo,
    vinculo: {
      repoCanon: opts.estado.caminhoCanonico(repoDir),
      reciboSha256NaCriacao: reciboSha,
    },
    criadoEm: new Date().toISOString(),
  }, env);
  return { intencaoId: opts.idFixo, reutilizada: false };
}

export function concluirIntencao(opts: {
  estado: EstadoExternoMod;
  env?: NodeJS.ProcessEnv;
  repoDir?: string;
}): void {
  opts.estado.consumirIntencaoVinculacao(opts.repoDir ?? RAIZ, opts.env ?? process.env);
}

/** Recuperação de intenção pendente (matriz B do spec) — executada no
 *  boot antes de qualquer nova transição. Retorno:
 *  { status:"nenhuma" } | { status:"recuperada", idBanco } |
 *  { status:"incompleta", idBanco } — fase do recibo ainda não ocorreu;
 *  intenção preservada para o vínculo do bootstrap concluir |
 *  { status:"bloqueada", motivo, detalhe? }.
 *
 *  `referenciaSchema` = hash da assinatura estrutural de REFERENCIA(k)
 *  do candidato (v.assinaturaSchema do reconhecedor) — exigido pelo
 *  ramo B3 da "intenção válida" fase-aware (Adendo A1). */
export function recuperarIntencaoPendente(opts: {
  estado: EstadoExternoMod;
  sqlite: Database.Database;
  env?: NodeJS.ProcessEnv;
  repoDir?: string;
  referenciaSchema?: string;
}): { status: "nenhuma" | "recuperada" | "incompleta" | "bloqueada"; idBanco?: string; motivo?: string; detalhe?: string } {
  const repoDir = opts.repoDir ?? RAIZ;
  const env = opts.env ?? process.env;
  const intencao = opts.estado.lerIntencaoVinculacao(repoDir, env);
  if (intencao.status === "ausente") return { status: "nenhuma" };
  if (intencao.status !== "ok") {
    return { status: "bloqueada", motivo: "identidade-nao-atada", detalhe: `intenção ${intencao.status}` };
  }
  const dados = intencao.dados as {
    instalacaoIdBanco?: unknown;
    tipo?: unknown;
    vinculo?: { repoCanon?: unknown; reciboSha256NaCriacao?: unknown };
  };
  const idIntencao = dados.instalacaoIdBanco;
  if (!instalacaoIdBancoValido(idIntencao)) {
    return { status: "bloqueada", motivo: "identidade-nao-atada", detalhe: "intenção sem uuid válido" };
  }
  // repoCanon/instalacaoId da intenção já foram validados por
  // lerIntencaoVinculacao (status "divergente" ⇒ bloqueio acima).
  const recibo = opts.estado.lerReciboInstalacao(repoDir, env);
  const dbId = lerInstalacaoIdBanco(opts.sqlite);
  const recId = recibo.status === "ok"
    ? (typeof recibo.dados?.instalacaoIdBanco === "string" ? recibo.dados.instalacaoIdBanco : null)
    : null;

  // B4/B5: divergências duras bloqueiam antes de qualquer mutação.
  if (instalacaoIdBancoValido(dbId) && dbId !== idIntencao) {
    return { status: "bloqueada", motivo: "identidade-nao-atada", detalhe: "banco diverge do id fixado na intenção (B4)" };
  }
  if (recibo.status === "ok" && recId && recId !== idIntencao) {
    return { status: "bloqueada", motivo: "identidade-nao-atada", detalhe: "recibo diverge do id fixado na intenção (B5)" };
  }

  // "Intenção válida" é fase-aware (Adendo A1):
  //   válida ⇔ repoCanon confere (garantido acima) ∧
  //     ( reciboSha256NaCriacao == sha256(recibo atual)              // B1/B2
  //     ∨ (recibo.id == intencao.id ∧ recibo.assinaturaSchema
  //        == REFERENCIA(k)) )                                       // B3
  // Sem um dos dois ramos a intenção não prova autoridade → B5.
  const vinculo = dados.vinculo;
  const temAncora = !!vinculo && "reciboSha256NaCriacao" in vinculo;
  const shaNaCriacao = (vinculo?.reciboSha256NaCriacao ?? null) as string | null;
  const shaAtual = opts.estado.sha256ReciboInstalacao(repoDir, env);
  const bytesConferem = temAncora && shaNaCriacao === shaAtual;
  const recAssin = recibo.status === "ok" ? recibo.dados?.assinaturaSchema : undefined;
  const b3Converge = recId === idIntencao
    && typeof recAssin === "string"
    && typeof opts.referenciaSchema === "string"
    && recAssin === opts.referenciaSchema;
  if (!bytesConferem && !b3Converge) {
    return {
      status: "bloqueada",
      motivo: "identidade-nao-atada",
      detalhe: "intenção não confere com o recibo vigente (âncora sha ausente/divergente e estado convergido não demonstrado)",
    };
  }

  // B1/B2: convergir — gravar id fixado se ausente/malformado.
  if (!instalacaoIdBancoValido(dbId)) {
    gravarInstalacaoIdBanco(opts.sqlite, idIntencao);
  }

  if (recibo.status === "ok" && !recId) {
    // Recibo legado sem id: completar atomicamente com id + schema de
    // referência (mantém o ramo B3 alcançável se houver crash aqui).
    // Retorno verificado: falha NÃO consome a intenção — sem o recibo
    // concluído não há prova de convergência (anti-autobloqueio).
    const upd = opts.estado.atualizarReciboInstalacao(repoDir, env, {
      instalacaoIdBanco: idIntencao,
      ...(typeof opts.referenciaSchema === "string"
        ? { assinaturaSchema: opts.referenciaSchema }
        : {}),
    });
    if (!upd.atualizado) {
      return {
        status: "bloqueada",
        motivo: "identidade-nao-atada",
        detalhe: `recibo não atualizado (${upd.motivo ?? "sem motivo"}) — intenção preservada para nova tentativa`,
      };
    }
    opts.estado.consumirIntencaoVinculacao(repoDir, env);
    return { status: "recuperada", idBanco: idIntencao };
  }

  if (recibo.status === "ausente") {
    // Fase "recibo externo" ainda não ocorreu (crash antes do recibo):
    // o id já está gravado; a intenção PERMANECE single-slot — o vínculo
    // do bootstrap (ou a próxima recuperação) conclui a fase do recibo.
    // Consumir aqui deixaria dbId sem prova de vínculo (janela B6).
    return { status: "incompleta", idBanco: idIntencao };
  }

  if (recibo.status !== "ok") {
    // corrompido/incompativel/divergente: a fase do recibo não conclui
    // por este caminho — quarentena é domínio do operador. Fail-closed.
    return {
      status: "bloqueada",
      motivo: "identidade-nao-atada",
      detalhe: `recibo ${recibo.status} — fase do recibo não conclui sem intervenção`,
    };
  }

  // B3: convergido — consumir intenção (idempotente).
  opts.estado.consumirIntencaoVinculacao(repoDir, env);
  return { status: "recuperada", idBanco: idIntencao };
}
