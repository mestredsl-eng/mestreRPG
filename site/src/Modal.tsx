import { useEffect, type ReactNode } from "react";

interface ModalBaseProps {
  titulo?: string;
  aoFechar: () => void;
  /** Quando true, impede fechar por backdrop, ESC ou Cancelar (ação em andamento). */
  ocupado?: boolean;
  children: ReactNode;
  acoes?: ReactNode;
}

/** Casca de modal — backdrop, fechamento por ESC/clique fora (respeitando `ocupado`). */
export function Modal({ titulo, aoFechar, ocupado = false, children, acoes }: ModalBaseProps) {
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !ocupado) aoFechar();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [aoFechar, ocupado]);

  return (
    <div className="modal-fundo" onClick={() => { if (!ocupado) aoFechar(); }}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        onClick={(e) => e.stopPropagation()}
      >
        {titulo && <h3 className="modal-titulo">{titulo}</h3>}
        {children}
        {acoes && <div className="acoes-modal">{acoes}</div>}
      </div>
    </div>
  );
}

interface ModalConfirmarProps {
  titulo: string;
  mensagem: ReactNode;
  rotuloConfirmar?: string;
  rotuloCancelar?: string;
  /** true = ação destrutiva (botão vermelho). */
  perigo?: boolean;
  ocupado?: boolean;
  aoConfirmar: () => void;
  aoCancelar: () => void;
}

/** Modal de confirmação — usar para qualquer ação que exija aceite explícito. */
export function ModalConfirmar({
  titulo, mensagem, rotuloConfirmar = "Confirmar", rotuloCancelar = "Cancelar",
  perigo = false, ocupado = false, aoConfirmar, aoCancelar,
}: ModalConfirmarProps) {
  return (
    <Modal titulo={titulo} aoFechar={aoCancelar} ocupado={ocupado}
      acoes={<>
        <button type="button" className="secundario" onClick={aoCancelar} disabled={ocupado}>
          {rotuloCancelar}
        </button>
        <button
          type="button"
          className={perigo ? "perigo" : "primario"}
          onClick={aoConfirmar}
          disabled={ocupado}
        >
          {ocupado ? "Aguarde…" : rotuloConfirmar}
        </button>
      </>}
    >
      <div className="modal-texto">{mensagem}</div>
    </Modal>
  );
}

interface ModalInfoProps {
  titulo: string;
  mensagem: ReactNode;
  aoFechar: () => void;
  rotuloBotao?: string;
}

/** Modal de informação — substitui alert() para avisos que exigem reconhecimento. */
export function ModalInfo({ titulo, mensagem, aoFechar, rotuloBotao = "Entendi" }: ModalInfoProps) {
  return (
    <Modal titulo={titulo} aoFechar={aoFechar}
      acoes={<button type="button" className="primario" onClick={aoFechar}>{rotuloBotao}</button>}
    >
      <div className="modal-texto">{mensagem}</div>
    </Modal>
  );
}
