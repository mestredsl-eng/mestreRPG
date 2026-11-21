import { useEffect, useState, type ReactNode } from "react";
import IconeInterface from "./IconeInterface";
import "./estado-feedback.css";

// Issue #239 — feedback acessível de carregamento e erro nas listas.
// Texto sempre visível/anunciado; ícone decorativo aria-hidden;
// retry só existe quando a página já possui recarga segura (GET
// idempotente) — o botão apenas reexecuta essa função, sem mutation.

export function EstadoCarregando({ children = "Carregando…" }: { children?: string }) {
  // Live region estável: o nó role="status" monta vazio e recebe o texto
  // no MESMO nó via efeito — leitores de tela anunciam a atualização sem
  // depender de a região já existir antes do mount do componente, e sem
  // anúncio duplicado quando `children` muda.
  const [texto, setTexto] = useState("");
  useEffect(() => setTexto(children), [children]);
  return (
    <div className="estado-feedback estado-feedback-carregando">
      <span className="estado-feedback-icone" aria-hidden="true" />
      <p className="estado-feedback-texto" role="status">{texto}</p>
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
