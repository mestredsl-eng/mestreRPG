// Coordenação de encerramento gracioso — o handler real é registrado pelo index.ts.
type Handler = () => void | Promise<void>;

let handler: Handler | null = null;
let solicitado = false;

export function registrarDesligamento(fn: Handler) {
  handler = fn;
}

/** Solicita encerramento uma única vez; executa o handler no próximo tick (após a resposta HTTP). */
export function solicitarDesligamento(): boolean {
  if (solicitado || !handler) return false;
  solicitado = true;
  setImmediate(() => {
    Promise.resolve(handler!()).catch((e) => console.error("[desligamento] falha:", e));
  });
  return true;
}

export function encerramentoSolicitado(): boolean {
  return solicitado;
}
