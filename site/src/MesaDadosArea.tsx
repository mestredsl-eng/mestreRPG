import { useEffect, useRef, useState, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  ariaLabel?: string;
}

/**
 * Área da mesa de dados com modo imersivo. A expansão é puramente CSS
 * (position:fixed no MESMO elemento): o canvas, a cena de física e os
 * valores já recebidos do servidor nunca são desmontados nem reiniciados.
 * Um placeholder preserva a altura original para que abrir/fechar não
 * desloque o scroll da página.
 */
export default function MesaDadosArea({ children, ariaLabel }: Props) {
  const [imersivo, setImersivo] = useState(false);
  const [altura, setAltura] = useState(0);
  const areaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!imersivo) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setImersivo(false);
    };
    window.addEventListener("keydown", onKey);
    // foco no botão de recolher sem rolar a página (preventScroll:
    // focus() comum dispararia scrollIntoView e mudaria window.scrollY)
    const btn = areaRef.current?.querySelector<HTMLButtonElement>(".mesa-ampliar");
    btn?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey);
  }, [imersivo]);

  const abrir = () => {
    // mede ANTES de expandir: o placeholder replica esta altura no fluxo
    setAltura(areaRef.current?.offsetHeight ?? 0);
    setImersivo(true);
  };

  return (
    <div className="mesa-dados-wrap">
      {imersivo && <div className="mesa-dados-placeholder" style={{ height: altura }} aria-hidden="true" />}
      <div
        ref={areaRef}
        className={`mesa-dados-area${imersivo ? " imersivo" : ""}`}
        aria-label={ariaLabel}
      >
        {children}
        <button
          type="button"
          className="mesa-ampliar"
          aria-pressed={imersivo}
          aria-label={imersivo ? "Recolher mesa de dados" : "Ampliar mesa de dados"}
          title={imersivo ? "Recolher (Esc)" : "Ampliar mesa"}
          onClick={() => (imersivo ? setImersivo(false) : abrir())}
        >
          {imersivo ? "⤡ Recolher" : "⤢ Ampliar"}
        </button>
      </div>
    </div>
  );
}
