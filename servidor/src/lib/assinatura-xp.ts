/**
 * Autenticidade do ledger XP na exportação/importação (Issue #162/B1-B2).
 *
 * O pacote JSON é controlado por quem o envia: âncora, eventos, saldos,
 * financiamentos e até as regras que acompanham a compra podem ser
 * fabricados em conjunto. Nenhuma validação interna do pacote pode
 * distingui-los de dados legítimos — o pacote não pode ser sua própria
 * autoridade.
 *
 * Solução: o servidor assina cada `__xp` no momento da exportação com
 * HMAC-SHA256 usando uma chave de instalação guardada em
 * `server_settings` (tabela NÃO incluída no EstadoCampanha exportado).
 * A assinatura cobre personagem, ledger integral (saldo, histórico,
 * âncora, financiado) e a impressão digital das regras do pacote —
 * adulterar qualquer um deles invalida a prova.
 *
 * Na importação externa, ledger sem assinatura válida é fail-closed:
 * saldo zerado, histórico e financiamentos descartados. Instalações
 * sem a mesma chave (outro servidor, chave rotacionada, pacote
 * editado) não conseguem forjar proveniência.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { serverSettings } from "../db/schema.js";
import type { Db } from "../db/index.js";

const CHAVE_CONFIG = "exportacao.chave.xp";

/** JSON canônico determinístico: chaves ordenadas, Date→ISO, undefined omitido. */
export function jsonCanonico(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((i) => jsonCanonico(i ?? null)).join(",")}]`;
  if (t === "object") {
    const o = v as Record<string, unknown>;
    const partes = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jsonCanonico(o[k])}`);
    return `{${partes.join(",")}}`;
  }
  return "null";
}

/** Impressão digital das regras do pacote (ruleSets + ruleDefinitions).
 *  Ordem das linhas é irrelevante; qualquer byte alterado muda o hash. */
export function impressaoDigitalRegras(
  ruleSets: readonly unknown[] | undefined,
  ruleDefinitions: readonly unknown[] | undefined,
): string {
  const norm = (rows: readonly unknown[] | undefined) =>
    (rows ?? []).map((r) => jsonCanonico(r)).sort();
  return createHash("sha256")
    .update(jsonCanonico({ ruleSets: norm(ruleSets), ruleDefinitions: norm(ruleDefinitions) }))
    .digest("hex");
}

/** Chave HMAC da instalação: get-or-create em server_settings.
 *  Nunca exportada (server_settings não faz parte do EstadoCampanha). */
export async function obterChaveAssinatura(db: Db): Promise<Buffer> {
  const row = await db.select().from(serverSettings).where(eq(serverSettings.key, CHAVE_CONFIG)).get();
  const existente = typeof row?.value === "string" ? row.value : null;
  if (existente && /^[0-9a-f]{64}$/.test(existente)) return Buffer.from(existente, "hex");
  const nova = randomBytes(32).toString("hex");
  try {
    db.insert(serverSettings).values({ key: CHAVE_CONFIG, value: nova, updatedAt: new Date() }).run();
  } catch {
    // corrida: outra instância criou primeiro — relê
  }
  const relida = await db.select().from(serverSettings).where(eq(serverSettings.key, CHAVE_CONFIG)).get();
  const valor = typeof relida?.value === "string" ? relida.value : nova;
  return Buffer.from(valor, "hex");
}

export interface ContextoAssinatura {
  chave: Buffer;
  regrasFp: string;
  /** Issue #186/C3: campanha de origem do pacote (envelope
   *  `pacote.campanhaId`) — CONTEXTO obrigatório de proveniência
   *  (validação da cadeia personagem→versão→template→campanha), mas
   *  NÃO faz parte do payload canônico assinado. */
  campanhaIdOrigem?: string | null;
}

function payloadAssinatura(
  ctx: ContextoAssinatura,
  personagemId: string,
  xpSemAssinatura: unknown,
): string {
  // personagemId é UUID globalmente único — vincula o ledger ao
  // personagem exato. O id da campanha NÃO entra: o formato do pacote
  // não o carrega dentro de `estado` (estado.campanha omite `id`) e o
  // modo "nova" remapeia identificadores — nenhuma fonte interna é
  // estável entre exportação e importação.
  return jsonCanonico({
    v: 1,
    personagemId,
    xp: xpSemAssinatura,
    regras: ctx.regrasFp,
  });
}

/** Assina o ledger de um personagem. Retorna "v1.<hmac-hex>". */
export function assinarLedgerXp(
  ctx: ContextoAssinatura,
  personagemId: string,
  xpSemAssinatura: unknown,
): string {
  return `v1.${createHmac("sha256", ctx.chave).update(payloadAssinatura(ctx, personagemId, xpSemAssinatura)).digest("hex")}`;
}

/** Verifica a assinatura recebida no pacote. Qualquer divergência —
 *  evento, saldo, âncora, financiado, regras ou identidade — reprova. */
export function verificarLedgerXp(
  ctx: ContextoAssinatura,
  personagemId: string,
  xpComAssinatura: Record<string, unknown>,
): boolean {
  const sig = xpComAssinatura.sig;
  if (typeof sig !== "string" || !sig.startsWith("v1.")) return false;
  const { sig: _s, ...xpSem } = xpComAssinatura;
  const esperado = assinarLedgerXp(ctx, personagemId, xpSem);
  const a = Buffer.from(sig);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Projeção do ledger XP para assinatura: remove SOMENTE a propriedade
 *  `sig` de nível raiz — campos `sig` legítimos aninhados permanecem
 *  autenticados. `undefined`/ausente → null canônico. */
export function xpSemAssinaturaRaiz(xp: unknown): unknown {
  if (xp === undefined) return null;
  if (!xp || typeof xp !== "object" || Array.isArray(xp)) return xp;
  const { sig: _s, ...resto } = xp as Record<string, unknown>;
  return resto;
}

/** Impressão digital da ficha para o payload v2 (Issue #186/C3):
 *  templateVersionId + estrutura publicada EXATA da versão +
 *  `config.sangue` do ruleset ativo. Adultrar qualquer um invalida a
 *  assinatura conjunta. */
export function impressaoDigitalFicha(p: {
  templateVersionId: unknown;
  estrutura: unknown;
  configSangue: unknown;
}): string {
  return createHash("sha256")
    .update(jsonCanonico({
      templateVersionId: p.templateVersionId ?? null,
      estrutura: p.estrutura ?? null,
      configSangue: p.configSangue ?? null,
    }))
    .digest("hex");
}

function payloadAssinaturaV2(
  ctx: ContextoAssinatura,
  p: { personagemId: string; xp: unknown; sangue: unknown; fichaFp: string },
): string {
  return jsonCanonico({
    v: 2,
    personagemId: p.personagemId,
    xp: p.xp ?? null,
    sangue: p.sangue ?? null,
    regrasFp: ctx.regrasFp,
    fichaFp: p.fichaFp,
  });
}

/** Assinatura conjunta XP+Sangue (Issue #186/C3). Retorna "v2.<hmac-hex>".
 *  `xp`/`sangue` são os VALORES dos ledgers já projetados (xp sem `sig`
 *  raiz); `data.__sangue_sig` é propriedade irmã e nunca entra no payload. */
export function assinarPacoteV2(
  ctx: ContextoAssinatura,
  p: { personagemId: string; xp: unknown; sangue: unknown; fichaFp: string },
): string {
  return `v2.${createHmac("sha256", ctx.chave).update(payloadAssinaturaV2(ctx, p)).digest("hex")}`;
}

/** Verifica `data.__sangue_sig` contra o snapshot original dos ledgers.
 *  Qualquer divergência — xp, sangue, regras, personagem, campanha de
 *  origem ou chave — reprova. Não faz fallback para v1. */
export function verificarAssinaturaV2(
  ctx: ContextoAssinatura,
  personagemId: string,
  sig: unknown,
  xpSemAssinatura: unknown,
  sangue: unknown,
  fichaFp: string,
): boolean {
  if (typeof sig !== "string" || !sig.startsWith("v2.")) return false;
  if (!ctx.campanhaIdOrigem) return false;
  const esperado = assinarPacoteV2(ctx, { personagemId, xp: xpSemAssinatura, sangue, fichaFp });
  const a = Buffer.from(sig);
  const b = Buffer.from(esperado);
  return a.length === b.length && timingSafeEqual(a, b);
}
