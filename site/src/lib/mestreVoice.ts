export type GeneroVoz = "feminina" | "masculina" | null;

interface FalaPendente {
  texto: string;
  genero: GeneroVoz;
}

const FEMININAS = /female|femin|woman|mulher|maria|luciana|francisca|camila|helena|fernanda|julia/i;
const MASCULINAS = /male|mascul|man|homem|antonio|felipe|daniel|ricardo|thiago|joao|pedro|bruno|gustavo/i;

function escolherVoz(voices: SpeechSynthesisVoice[], genero: GeneroVoz): SpeechSynthesisVoice | undefined {
  const portugues = voices.filter((voice) => /^pt(?:-|$)/i.test(voice.lang));
  const brasileiras = portugues.filter((voice) => /^pt-BR$/i.test(voice.lang));
  const candidatas = brasileiras.length ? brasileiras : portugues;
  if (genero === "feminina") {
    const marcada = candidatas.find((voice) => FEMININAS.test(voice.name));
    if (marcada) return marcada;
  } else if (genero === "masculina") {
    const marcada = candidatas.find((voice) => MASCULINAS.test(voice.name));
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
    const utterance = new SpeechSynthesisUtterance(texto);
    const vozes = sintetizador.getVoices();
    utterance.lang = "pt-BR";
    utterance.rate = 1;
    utterance.pitch = 1;
    const voz = escolherVoz(vozes, fala.genero);
    if (voz) { utterance.voice = voz; utterance.lang = voz.lang || "pt-BR"; }
    const minhaGeracao = geracao;
    ocupada = true;
    const concluir = () => {
      if (minhaGeracao !== geracao || destruida) return;
      ocupada = false;
      proxima();
    };
    utterance.onend = concluir;
    utterance.onerror = concluir;
    sintetizador.speak(utterance);
  };

  const parar = () => {
    geracao += 1;
    fila.length = 0;
    ocupada = false;
    try { sintetizador?.cancel(); } catch { /* no-op */ }
  };

  return {
    get disponivel() { return !!sintetizador; },
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
