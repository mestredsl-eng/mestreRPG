import { useEffect, useRef, type ReactNode } from "react";

interface ModalBaseProps {
  titulo?: string;
  aoFechar: () => void;
  /** Quando true, impede fechar por backdrop, ESC ou Cancelar (ação em andamento). */
  ocupado?: boolean;
  children: ReactNode;
  acoes?: ReactNode;
}

const SELETOR_FOCAVEIS = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focaveisDe(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(SELETOR_FOCAVEIS))
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Casca de modal — backdrop, fechamento por ESC/clique fora (respeitando `ocupado`),
 * foco inicial, aprisionamento de Tab e retorno de foco ao elemento que abriu. */
export function Modal({ titulo, aoFechar, ocupado = false, children, acoes }: ModalBaseProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const modal = ref.current;
    if (!modal) return;
    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Foco inicial: primeiro campo/botão do modal (ou o próprio diálogo).
    const primeiro = focaveisDe(modal)[0] ?? modal;
    primeiro.focus();

    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!ocupado) aoFechar();
        return;
      }
      if (e.key !== "Tab") return;
      // Trap: mantém o foco dentro do diálogo.
      const els = focaveisDe(modal);
      if (els.length === 0) { e.preventDefault(); modal.focus(); return; }
      const primeiroEl = els[0];
      const ultimoEl = els[els.length - 1];
      const ativo = document.activeElement;
      if (e.shiftKey && (ativo === primeiroEl || ativo === modal)) {
        e.preventDefault(); ultimoEl.focus();
      } else if (!e.shiftKey && (ativo === ultimoEl || ativo === modal)) {
        e.preventDefault(); primeiroEl.focus();
      }
    };
    window.addEventListener("keydown", aoTeclar);
    return () => {
      window.removeEventListener("keydown", aoTeclar);
      // Retorno de foco a quem abriu o modal.
      if (anterior && document.contains(anterior)) anterior.focus();
    };
  }, [aoFechar, ocupado]);

  return (
    <div className="modal-fundo" onClick={() => { if (!ocupado) aoFechar(); }}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        tabIndex={-1}
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
