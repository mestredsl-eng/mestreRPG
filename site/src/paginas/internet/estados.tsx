// F4 / Issue #352 — estados compartilhados da Internet diegética.
// Espelham o padrão de feedback honesto: loading com aria-busy, erro
// com retry que preserva conteúdo, vazio com CTA diegético (nunca
// jargão de sistema). Não depende dos componentes de estado da cadeia
// #132 (ainda não integrados em main) — implementação local mínima.

import type { ReactNode } from "react";

export function Carregando({ rotulo = "Carregando…" }: { rotulo?: string }) {
  return (
    <p className="internet-msg-carregando" role="status" aria-busy="true">
      <span className="internet-msg-skeleton" aria-hidden="true" />
      {rotulo}
    </p>
  );
}

export function ErroRetry({ mensagem, aoTentar, extra }: {
  mensagem: string;
  aoTentar: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="internet-msg-erro" role="alert">
      <p>{mensagem}</p>
      {extra}
      <button type="button" className="secundario" onClick={aoTentar}>
        Tentar novamente
      </button>
    </div>
  );
}

export function Vazio({ titulo, dica, children }: {
  titulo: string;
  dica?: string;
  children?: ReactNode;
}) {
  return (
    <div className="internet-msg-vazio">
      <p className="internet-msg-vazio-titulo">{titulo}</p>
      {dica && <p className="meta">{dica}</p>}
      {children}
    </div>
  );
}
