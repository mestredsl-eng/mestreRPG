import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

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

interface AjudaPopoverProps {
  /** Texto da descrição a ser exibida */
  texto: string;
  /** Rótulo acessível para o botão de ajuda */
  rotuloBotao?: string;
  /** Rótulo acessível para o popover */
  rotuloPopover?: string;
}

/**
 * Ícone de interrogação (?) com popover para exibir descrições contextuais.
 * Só renderiza o ícone se o texto não for vazio ou apenas espaços.
 */
export function AjudaPopover({ texto, rotuloBotao = "Ver descrição", rotuloPopover = "Descrição" }: AjudaPopoverProps) {
  const [aberto, setAberto] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const botaoRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Verifica se o texto tem conteúdo válido (não vazio, não nulo, não apenas espaços)
  const temConteudo = texto && typeof texto === "string" && texto.trim().length > 0;

  const fechar = () => setAberto(false);

  // Fechar ao clicar fora
  useEffect(() => {
    if (!aberto) return;
    const aoClicarFora = (e: MouseEvent) => {
      if (
        botaoRef.current && !botaoRef.current.contains(e.target as Node) &&
        popoverRef.current && !popoverRef.current.contains(e.target as Node)
      ) {
        fechar();
      }
    };
    document.addEventListener("mousedown", aoClicarFora);
    return () => document.removeEventListener("mousedown", aoClicarFora);
  }, [aberto]);

  // Fechar com ESC
  useEffect(() => {
    if (!aberto) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") fechar();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [aberto]);

  // Posição fixed calculada a partir do botão — evita cortes por overflow
  // de containers (ex.: lista rolável do seletor único) e mantém o popover
  // dentro da viewport em qualquer tamanho de tela.
  useLayoutEffect(() => {
    if (!aberto) {
      setPos(null);
      return;
    }
    const btn = botaoRef.current;
    const pop = popoverRef.current;
    if (!btn || !pop) return;
    const posicionar = () => {
      const r = btn.getBoundingClientRect();
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      let left = r.left;
      if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
      if (left < 8) left = 8;
      let top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
      setPos({ top, left });
    };
    posicionar();
    window.addEventListener("resize", posicionar);
    window.addEventListener("scroll", posicionar, true);
    return () => {
      window.removeEventListener("resize", posicionar);
      window.removeEventListener("scroll", posicionar, true);
    };
  }, [aberto]);

  if (!temConteudo) {
    return null;
  }

  return (
    <span className="ajuda-contextual">
      <button
        ref={botaoRef}
        type="button"
        className="ajuda-botao"
        aria-label={rotuloBotao}
        aria-expanded={aberto}
        aria-haspopup="true"
        onClick={(e) => { e.preventDefault(); setAberto(!aberto); }}
      >
        ?
      </button>
      {aberto && (
        <div
          ref={popoverRef}
          className="ajuda-popover"
          role="dialog"
          aria-label={rotuloPopover}
          style={pos ? { top: pos.top, left: pos.left } : undefined}
        >
          <div className="ajuda-conteudo">{texto}</div>
        </div>
      )}
    </span>
  );
}
