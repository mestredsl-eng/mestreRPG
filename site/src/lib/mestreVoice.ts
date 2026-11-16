export type GeneroVoz = "feminina" | "masculina" | null;

interface FalaPendente {
  texto: string;
  genero: GeneroVoz;
}

const FEMININAS = /\b(female|femin|woman|mulher|maria|luciana|francisca|camila|helena|fernanda|julia)\b/i;
const MASCULINAS = /\b(male|mascul|man|homem|antonio|felipe|daniel|ricardo|thiago|joao|pedro|bruno|gustavo)\b/i;

function normalizarNomeVoz(nome: string): string {
  return nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function idiomaPortugues(lang: string): boolean {
  return /^pt(?:[-_]|$)/i.test(lang);
}

function obterVozes(sintetizador: SpeechSynthesis | null): SpeechSynthesisVoice[] {
  try { return sintetizador?.getVoices() ?? []; } catch { return []; }
}

function escolherVoz(voices: SpeechSynthesisVoice[], genero: GeneroVoz): SpeechSynthesisVoice | undefined {
  const portugues = voices.filter((voice) => idiomaPortugues(voice.lang));
  const brasileiras = portugues.filter((voice) => /^pt[-_]BR$/i.test(voice.lang));
  const candidatas = brasileiras.length ? brasileiras : portugues;
  if (genero === "feminina") {
    const marcada = candidatas.find((voice) => FEMININAS.test(normalizarNomeVoz(voice.name)));
    if (marcada) return marcada;
  } else if (genero === "masculina") {
    const marcada = candidatas.find((voice) => MASCULINAS.test(normalizarNomeVoz(voice.name)));
    if (marcada) return marcada;
  }
  return candidatas.find((voice) => voice.default) ?? candidatas[0] ?? voices.find((voice) => voice.default) ?? voices[0];
}

function limparTexto(texto: string): string {
  return texto.replace(/https?:\/\/\S+/gi, " link ").replace(/[*_~#]/g, "").replace(/\s+/g, " ").trim().slice(0, 4000);
}

/** Fila local por navegador: nenhum texto/áudio é enviado ao servidor. */
export function criarFilaMestreVoice() {
  const sintetizador = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  let ativada = false;
  let ocupada = false;
  let destruida = false;
  let geracao = 0;
  const fila: FalaPendente[] = [];

  const proxima = () => {
    if (!sintetizador || !ativada || ocupada || destruida || fila.length === 0) return;
    const fala = fila.shift()!;
    const texto = limparTexto(fala.texto);
    if (!texto) { proxima(); return; }

    let utterance: SpeechSynthesisUtterance;
    try {
      utterance = new SpeechSynthesisUtterance(texto);
    } catch {
      proxima();
      return;
    }

    const vozes = obterVozes(sintetizador);
    utterance.lang = "pt-BR";
    utterance.rate = 1;
    utterance.pitch = 1;
    const voz = escolherVoz(vozes, fala.genero);
    if (voz) { utterance.voice = voz; utterance.lang = voz.lang || "pt-BR"; }

    const minhaGeracao = geracao;
    let concluida = false;
    ocupada = true;
    const concluir = () => {
      if (concluida) return;
      concluida = true;
      if (minhaGeracao !== geracao || destruida) return;
      ocupada = false;
      proxima();
    };
    utterance.onend = concluir;
    utterance.onerror = concluir;
    try {
      sintetizador.speak(utterance);
    } catch {
      // Uma falha síncrona não pode deixar a fila permanentemente ocupada.
      concluir();
    }
  };

  const parar = () => {
    geracao += 1;
    fila.length = 0;
    ocupada = false;
    try { sintetizador?.cancel(); } catch { /* no-op */ }
  };

  return {
    get disponivel() { return !!sintetizador; },
    /** null significa que o navegador ainda não carregou/listou as vozes. */
    get temVozEmPortugues(): boolean | null {
      if (!sintetizador) return false;
      const vozes = obterVozes(sintetizador);
      if (vozes.length === 0) return null;
      return vozes.some((voz) => idiomaPortugues(voz.lang));
    },
    get ativa() { return ativada && !destruida; },
    ativar(): boolean {
      if (!sintetizador || destruida) return false;
      ativada = true;
      try { sintetizador.resume(); } catch { /* pode não estar disponível */ }
      proxima();
      return true;
    },
    enfileirar(texto: string, genero: GeneroVoz = null): void {
      if (!sintetizador || destruida) return;
      const limpo = limparTexto(texto);
      if (!limpo) return;
      if (fila.length >= 40) fila.shift();
      fila.push({ texto: limpo, genero });
      proxima();
    },
    parar,
    destruir(): void {
      parar();
      ativada = false;
      destruida = true;
    },
  };
}
