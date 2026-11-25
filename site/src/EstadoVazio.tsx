import type { ReactNode } from "react";
import IconeInterface, { type NomeIconeInterface } from "./IconeInterface";

// Issue #236 — estado vazio ilustrado e acessível: o texto é o conteúdo
// principal; o ícone é decorativo (aria-hidden dentro de IconeInterface).
export default function EstadoVazio({ icone, children }: { icone: NomeIconeInterface; children: ReactNode }) {
  return (
    <div className="estado-vazio">
      <IconeInterface nome={icone} className="estado-vazio-icone" />
      <p className="estado-vazio-texto">{children}</p>
    </div>
  );
}
