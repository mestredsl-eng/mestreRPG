// F4 / Issue #352 — padrão APG de abas para os tablists da Internet
// diegética (mesmo padrão aplicado na #132: setas ←/→ com wrap,
// Home/End, roving tabindex, tab↔tabpanel por aria-controls/labelledby).

import type { KeyboardEvent, ReactNode } from "react";

export function AbaBotao({ id, rotulo, ativo, controles, aoClicar, children }: {
  id: string; rotulo?: string; ativo: boolean; controles: string; aoClicar: () => void; children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`aba-${id}`}
      aria-selected={ativo}
      aria-controls={controles}
      tabIndex={ativo ? 0 : -1}
      className={ativo ? "ativo" : "secundario"}
      onClick={aoClicar}
    >
      {children ?? rotulo}
    </button>
  );
}

/** Handlers de teclado APG para um tablist horizontal. */
export function aoTeclarAbas(e: KeyboardEvent<HTMLElement>, ids: string[], ativo: string, aoMudar: (id: string) => void) {
  const i = ids.indexOf(ativo);
  if (i < 0) return;
  let alvo = -1;
  if (e.key === "ArrowRight") alvo = (i + 1) % ids.length;
  else if (e.key === "ArrowLeft") alvo = (i - 1 + ids.length) % ids.length;
  else if (e.key === "Home") alvo = 0;
  else if (e.key === "End") alvo = ids.length - 1;
  if (alvo < 0) return;
  e.preventDefault();
  const novo = ids[alvo];
  aoMudar(novo);
  // move o foco para a aba recém-ativada após o re-render
  requestAnimationFrame(() => {
    document.getElementById(`aba-${novo}`)?.focus();
  });
}
