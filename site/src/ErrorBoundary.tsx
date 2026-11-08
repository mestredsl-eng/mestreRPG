import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface Estado {
  erro: Error | null;
}

/**
 * Captura erros de renderização da árvore React e mostra tela de recuperação.
 * Não cobre erros assíncronos, eventos ou falhas de API — esses seguem o
 * tratamento normal de cada página. Dados ficam no servidor, então recarregar
 * é sempre seguro.
 */
export default class ErrorBoundary extends Component<Props, Estado> {
  state: Estado = { erro: null };

  static getDerivedStateFromError(erro: Error): Estado {
    return { erro };
  }

  componentDidCatch(erro: Error, info: { componentStack?: string | null }) {
    // Diagnóstico no console do navegador — sem expor stack ao usuário.
    console.error("[mestre-rpg] erro de renderização:", erro, info.componentStack ?? "");
  }

  private recarregar = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.erro) return this.props.children;
    return (
      <main className="container">
        <section className="cartao">
          <h2>Algo deu errado</h2>
          <p>
            Ocorreu um erro inesperado na interface. Seus dados estão seguros —
            tudo fica salvo no servidor. Tente recarregar a página.
          </p>
          <p className="meta">
            Se o problema continuar, avise o mestre da campanha informando a hora em que aconteceu.
          </p>
          <button className="primario" onClick={this.recarregar}>Recarregar aplicação</button>
        </section>
      </main>
    );
  }
}
