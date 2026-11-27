// Morte de personagem — chave reservada `__morte` em characters.data
// (contrato Internet pública v2.6 + DP-8/DP-9, #365).
//
// `__morte` é array de epochs server-managed:
//   { em: ISO, causa?: string|null, revertidaEm?: ISO|null }
//
// `avaliarMorte` é o ÚNICO avaliador — todo caminho de escrita de `__hp`
// (rota de HP, criação, importação saneada) passa por ele. Regras:
//   - hp ≤ 0 e última epoch revertida (ou sem epochs) ⇒ nova epoch;
//   - hp ≤ 0 e epoch vigente (sem revertidaEm) ⇒ dedup, nada muda;
//   - hp > 0 ⇒ nada (ressurreição NÃO é aqui — é ação mestre auditada
//     que marca revertidaEm, DP-8; a notícia permanece publicada);
//   - dedup por (personagemId, ocorrencia.em): reprocessar a mesma
//     ocorrência (retry/import) não duplica epoch nem notícia.
//
// A notícia automática (internet_publicacoes origem='sistema') é
// inserida por quem chama avaliarMorte na MESMA tx — este módulo só
// decide o estado; a persistência da notícia fica na rota/lib de
// publicações para manter lib/ sem dependência de schema.

export const CHAVE_MORTE = "__morte";

export interface EpochMorte {
  em: string;                 // ISO do evento de morte
  causa?: string | null;
  revertidaEm?: string | null;
}

const strOuNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

/** Lê `__morte` dos dados do personagem (tolera formato inválido). */
export function lerMortes(dados: Record<string, unknown>): EpochMorte[] {
  const bruto = dados[CHAVE_MORTE];
  if (!Array.isArray(bruto)) return [];
  const out: EpochMorte[] = [];
  for (const item of bruto) {
    if (!item || typeof item !== "object") continue;
    const em = strOuNull((item as Record<string, unknown>).em);
    if (!em) continue;
    const causa = strOuNull((item as Record<string, unknown>).causa);
    const revertidaEm = strOuNull((item as Record<string, unknown>).revertidaEm);
    out.push({ em, causa, revertidaEm });
  }
  return out;
}

/** Última epoch sem reversão = morte vigente. */
export function morteVigente(dados: Record<string, unknown>): EpochMorte | null {
  const mortes = lerMortes(dados);
  for (let i = mortes.length - 1; i >= 0; i--) {
    if (!mortes[i].revertidaEm) return mortes[i];
  }
  return null;
}

export interface ResultadoMorte {
  /** Novos dados do personagem (com `__morte` atualizado). */
  dados: Record<string, unknown>;
  /** Epoch recém-criada — não-null somente quando houve morte nova. */
  morteNova: EpochMorte | null;
  /** true quando a epoch nova exige publicação da notícia de sistema. */
  primeiraMorte: boolean;
}

/**
 * Avalia morte a partir do HP resultante de uma escrita. `em` deve ser o
 * MESMO instante gravado no evento de HP (dedup estável em retry).
 * `causa` é texto livre curto do mestre (motivo do dano letal).
 */
export function avaliarMorte(
  dados: Record<string, unknown>,
  opts: { hpAtual: number | null; em: string; causa?: string | null },
): ResultadoMorte {
  const mortes = lerMortes(dados);
  const vigente = morteVigente(dados);
  if (opts.hpAtual === null || opts.hpAtual > 0) {
    return { dados, morteNova: null, primeiraMorte: false };
  }
  // Já morto (epoch vigente) — dedup: não empilha epoch nem notícia.
  if (vigente) return { dados, morteNova: null, primeiraMorte: false };
  // Mesma ocorrência reprocessada (mesmo `em`) — dedup por em.
  if (mortes.some((m) => m.em === opts.em)) {
    return { dados, morteNova: null, primeiraMorte: false };
  }
  const epoch: EpochMorte = {
    em: opts.em,
    causa: strOuNull(opts.causa) ?? null,
    revertidaEm: null,
  };
  const novasMortes = [...mortes, epoch];
  // primeiraMorte = não havia NENHUMA epoch anterior — a notícia de
  // sistema só sai na primeira morte da ficha (mortes subsequentes após
  // ressurreição são eventos do mestre, não notícia automática — DP-8
  // trata ressurreição como auditada; nova morte real pode gerar nova
  // notícia: ver abaixo).
  const primeiraMorte = mortes.length === 0;
  return {
    dados: { ...dados, [CHAVE_MORTE]: novasMortes },
    morteNova: epoch,
    primeiraMorte,
  };
}

/**
 * Marca `revertidaEm` na epoch vigente (ressurreição — DP-8). Nunca
 * remove a epoch nem a notícia associada. Retorna null se não havia
 * morte vigente.
 */
export function reverterMorte(
  dados: Record<string, unknown>,
  em: string,
): { dados: Record<string, unknown>; revertida: EpochMorte | null } {
  const mortes = lerMortes(dados);
  const idx = mortes.map((m, i) => ({ m, i })).reverse()
    .find(({ m }) => !m.revertidaEm)?.i;
  if (idx === undefined) return { dados, revertida: null };
  const novas = mortes.map((m, i) =>
    i === idx ? { ...m, revertidaEm: em } : m);
  return { dados: { ...dados, [CHAVE_MORTE]: novas }, revertida: novas[idx] };
}

/** Texto da notícia automática de morte (template server-side, §5 do
 *  contrato): nunca vem do cliente; causa só entra se preenchida. */
export function noticiaMorteTexto(nomePersonagem: string, causa: string | null) {
  const titulo = `Morte de ${nomePersonagem}`;
  const corpo = causa
    ? `${nomePersonagem} morreu. ${causa}`
    : `${nomePersonagem} morreu.`;
  return { titulo, corpo };
}
