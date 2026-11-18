import assert from "node:assert/strict";
import { criarFilaMestreVoice } from "../src/lib/mestreVoice.js";

type EstadoVoz = {
  utterances: SpeechSynthesisUtterance[];
  cancelamentos: number;
  concluir(indice: number, tipo?: "end" | "error"): void;
};

function criarAmbiente(vozes: SpeechSynthesisVoice[]) {
  const estado: EstadoVoz = {
    utterances: [],
    cancelamentos: 0,
    concluir(indice, tipo = "end") {
      const fala = estado.utterances[indice];
      assert.ok(fala, `fala ${indice} existe`);
      if (tipo === "error") fala.onerror?.call(fala, undefined as unknown as SpeechSynthesisErrorEvent);
      else fala.onend?.call(fala, undefined as unknown as SpeechSynthesisEvent);
    },
  };
  const sintetizador = {
    getVoices: () => vozes,
    speak: (fala: SpeechSynthesisUtterance) => { estado.utterances.push(fala); },
    cancel: () => { estado.cancelamentos += 1; },
    resume: () => undefined,
  } as unknown as SpeechSynthesis;

  class UtteranceMock {
    voice: SpeechSynthesisVoice | null = null;
    lang = "";
    rate = 1;
    pitch = 1;
    onend: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisEvent) => unknown) | null = null;
    onerror: ((this: SpeechSynthesisUtterance, ev: SpeechSynthesisErrorEvent) => unknown) | null = null;
    constructor(public text: string) {}
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { speechSynthesis: sintetizador },
  });
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: UtteranceMock,
  });
  return estado;
}

function voz(name: string, lang = "pt-BR", isDefault = false): SpeechSynthesisVoice {
  return {
    name, lang, default: isDefault, localService: true, voiceURI: name,
  } as SpeechSynthesisVoice;
}

const descritores = {
  window: Object.getOwnPropertyDescriptor(globalThis, "window"),
  utterance: Object.getOwnPropertyDescriptor(globalThis, "SpeechSynthesisUtterance"),
};

try {
  console.log("== Mestre Voice: fila e seleção local ==");

  const ambiente = criarAmbiente([
    voz("Microsoft Júlia Desktop"),
    voz("Microsoft João Desktop"),
    voz("Microsoft Maria Desktop", "pt-BR", true),
  ]);
  const fila = criarFilaMestreVoice();

  assert.equal(fila.disponivel, true, "SpeechSynthesis disponível");
  assert.equal(fila.temVozEmPortugues, true, "detecta voz em português");
  fila.enfileirar("Olá **mundo** https://exemplo.com", "feminina");
  fila.enfileirar("Agora é a vez dele", "masculina");
  assert.equal(ambiente.utterances.length, 0, "não inicia antes da ativação explícita");

  assert.equal(fila.ativar(), true, "ativação permitida após interação do usuário");
  assert.equal(ambiente.utterances.length, 1, "somente a primeira fala inicia");
  assert.equal(ambiente.utterances[0].voice?.name, "Microsoft Júlia Desktop", "seleciona voz feminina mesmo com acento");
  assert.equal(ambiente.utterances[0].text, "Olá mundo link", "limpa formatação e URLs");
  assert.equal(ambiente.utterances[0].lang, "pt-BR", "mantém idioma brasileiro");
  ambiente.concluir(0);
  assert.equal(ambiente.utterances.length, 2, "próxima fala aguarda o término da anterior");
  assert.equal(ambiente.utterances[1].voice?.name, "Microsoft João Desktop", "seleciona voz masculina mesmo com acento");
  ambiente.concluir(1, "error");
  assert.equal(ambiente.utterances.length, 2, "erro de uma fala libera a fila sem duplicar a próxima");
  fila.destruir();
  assert.equal(fila.ativa, false, "destruição desativa a fila");

  console.log("OK: ativação explícita, fila sequencial, limpeza de texto e seleção por gênero/acentos");

  const semPortugues = criarAmbiente([voz("Samantha", "en-US", true)]);
  const filaSemPortugues = criarFilaMestreVoice();
  assert.equal(filaSemPortugues.temVozEmPortugues, false, "identifica ausência de voz em português");
  filaSemPortugues.ativar();
  filaSemPortugues.enfileirar("Mensagem em português", "feminina");
  assert.equal(semPortugues.utterances[0].voice?.name, "Samantha", "fallback para voz padrão disponível");
  assert.equal(semPortugues.utterances[0].lang, "en-US", "usa idioma real da voz de fallback");
  filaSemPortugues.parar();
  assert.equal(semPortugues.cancelamentos, 1, "Parar cancela a fala atual");
  semPortugues.concluir(0);
  assert.equal(semPortugues.utterances.length, 1, "callback tardio não reinicia fala após Parar");
  filaSemPortugues.destruir();

  console.log("OK: aviso detectável para ausência de português, fallback e cancelamento");

  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Reflect.deleteProperty(globalThis, "window");
  const semApi = criarFilaMestreVoice();
  assert.equal(semApi.disponivel, false, "navegador sem SpeechSynthesis permanece suportado");
  assert.equal(semApi.ativar(), false, "não ativa sem API");
  semApi.destruir();
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);

  console.log("OK: fallback progressivo quando SpeechSynthesis não existe");
  console.log("Mestre Voice: 19 verificações aprovadas");

  // Simula setup → cleanup → setup de efeitos do React StrictMode em dev:
  // uma fila destruída não pode ser reutilizada, mas o ciclo seguinte cria
  // outra instância funcional.
  const strictPrimeira = criarFilaMestreVoice();
  assert.equal(strictPrimeira.disponivel, true, "primeiro setup cria fila disponível");
  strictPrimeira.destruir();
  assert.equal(strictPrimeira.ativar(), false, "fila do primeiro setup não pode ser reutilizada após cleanup");
  const strictSegunda = criarFilaMestreVoice();
  assert.equal(strictSegunda.disponivel, true, "segundo setup cria nova fila disponível");
  assert.equal(strictSegunda.ativar(), true, "fila do segundo setup pode ser ativada");
  strictSegunda.destruir();
  console.log("OK: ciclo setup/cleanup/setup do StrictMode recria uma fila funcional");

} finally {
  if (descritores.window) Object.defineProperty(globalThis, "window", descritores.window);
  else Reflect.deleteProperty(globalThis, "window");
  if (descritores.utterance) Object.defineProperty(globalThis, "SpeechSynthesisUtterance", descritores.utterance);
  else Reflect.deleteProperty(globalThis, "SpeechSynthesisUtterance");
}
