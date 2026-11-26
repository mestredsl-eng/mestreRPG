// F4 / Issue #352 — S2: conta diegética do personagem.
// Perfil conservador (decisão §7 do spec): só @handle + nome do
// personagem. Criação/optação da conta é fluxo F2 — aqui só exibimos
// o estado "sem conta" de forma honesta.

import { useEffect, useState } from "react";
import type { AdaptadorInternet } from "./adaptador";
import type { ContaInternet } from "./tipos";
import { Carregando, ErroRetry, Vazio } from "./estados";

export default function ContaInternet({ adaptador }: { adaptador: AdaptadorInternet }) {
  const [conta, setConta] = useState<ContaInternet | null | undefined>(undefined);
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    let vivo = true;
    setErro(false);
    adaptador.obterConta()
      .then((c) => { if (vivo) setConta(c); })
      .catch(() => { if (vivo) { setConta(null); setErro(true); } });
    return () => { vivo = false; };
  }, [adaptador, tentativa]);

  if (erro) {
    return <ErroRetry mensagem="Não foi possível carregar sua conta." aoTentar={() => setTentativa((t) => t + 1)} />;
  }
  if (conta === undefined) return <Carregando rotulo="Carregando conta…" />;

  if (conta === null) {
    return (
      <Vazio
        titulo="Este personagem ainda não tem conta na Internet"
        dica="A criação de conta diegética será liberada em versão futura. Personagens sem conta não aparecem em contatos nem conversas."
      />
    );
  }

  return (
    <section className="cartao" aria-label="Sua conta na Internet">
      <h2>Sua conta</h2>
      <dl className="internet-conta-dados">
        <div><dt>Usuário</dt><dd>@{conta.handle}</dd></div>
        <div><dt>Personagem</dt><dd>{conta.nomePersonagem}</dd></div>
      </dl>
      <p className="meta">
        Este @handle é visível apenas para quem tem contato aceito com você.
        Mensagens trocadas aqui são do personagem — o mestre da campanha pode
        auditar acessos, mas não lê conversas pela interface.
      </p>
    </section>
  );
}
