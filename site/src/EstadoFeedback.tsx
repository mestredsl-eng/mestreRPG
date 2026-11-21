import type { ReactNode } from "react";
import IconeInterface from "./IconeInterface";
import "./estado-feedback.css";

// Issue #239 — feedback acessível de carregamento e erro nas listas.
// Texto sempre visível/anunciado; ícone decorativo aria-hidden;
// retry só existe quando a página já possui recarga segura (GET
// idempotente) — o botão apenas reexecuta essa função, sem mutation.

export function EstadoCarregando({ children = "Carregando…" }: { children?: ReactNode }) {
  return (
    <div className="estado-feedback estado-feedback-carregando" role="status">
      <span className="estado-feedback-icone" aria-hidden="true" />
      <p className="estado-feedback-texto">{children}</p>
    </div>
  );
}

export function EstadoErro({ children, aoTentarNovamente }: { children: ReactNode; aoTentarNovamente?: () => void }) {
  return (
    <div className="estado-feedback estado-feedback-erro" role="alert">
      <IconeInterface nome="informacoes" className="estado-feedback-icone-svg" />
      <p className="estado-feedback-texto">{children}</p>
      {aoTentarNovamente && (
        <button type="button" className="secundario estado-feedback-retry" onClick={aoTentarNovamente}>
          Tentar novamente
        </button>
      )}
    </div>
  );
}
