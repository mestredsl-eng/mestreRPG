import { useCallback, useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./auth";
import { api, type HealthStatus } from "./api";
import Login from "./paginas/Login";
import Admin from "./paginas/Admin";
import Conta from "./paginas/Conta";
import Campanhas from "./paginas/Campanhas";
import Campanha from "./paginas/Campanha";
import Convite from "./paginas/Convite";
import ConviteCadastro from "./paginas/ConviteCadastro";
import Acervo from "./paginas/Acervo";
import Novidades from "./paginas/Novidades";
import { ProvedorNotificacoes, useNotificar } from "./Notificacoes";
import { getSocket } from "./socket";

type Aba = "painel" | "campanhas" | "acervo" | "novidades" | "admin" | "conta";

function Painel() {
  const { estado } = useAuth();
  const usuario = estado.status === "autenticado" ? estado.usuario : null;
  const [info, setInfo] = useState<HealthStatus | null>(null);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let ativo = true;
    const checar = async () => {
      try {
        const dados = await api.health();
        if (!ativo) return;
        setInfo(dados);
        setOnline(true);
      } catch {
        if (ativo) setOnline(false);
      }
    };
    void checar();
    const intervalo = setInterval(checar, 10_000);
    return () => {
      ativo = false;
      clearInterval(intervalo);
    };
  }, []);

  return (
    <>
      <section className="cartao">
        <h2>Olá{usuario?.displayName ? `, ${usuario.displayName}` : usuario ? `, ${usuario.username}` : ""}</h2>
        <p>
          {online ? "● Servidor online" : "○ Servidor offline"}
          {info ? ` — ${info.servico}` : ""}
        </p>
      </section>
      <section className="cartao">
        <h2>O que já está no ar</h2>
        <p>
          Campanhas com convites e papéis, fichas personalizáveis por sistema de
          regras, mesa em tempo real com chat e dados D4–D20, desafios do mestre,
          diário, histórico com restauração, biblioteca de arquivos e financeiro
          da campanha — tudo persistente e sincronizado.
        </p>
      </section>
    </>
  );
}

/** Gatilho de diagnóstico: `/?__erro=1` força erro de renderização para testar o ErrorBoundary. */
function ErroProposital(): never {
  throw new Error("erro de renderização proposital (diagnóstico)");
}

function Shell() {
  const { estado, sair } = useAuth();
  const [aba, setAba] = useState<Aba>("painel");
  const [campanhaAberta, setCampanhaAberta] = useState<string | null>(null);
  const [naoLidas, setNaoLidas] = useState(0);
  const usuario = estado.status === "autenticado" ? estado.usuario : null;
  const ehConvite = window.location.pathname.startsWith("/convite");
  const forcarErro = new URLSearchParams(window.location.search).has("__erro");

  // Contador de novidades não lidas — uma consulta ao entrar/autenticar e
  // sob demanda após leituras (sem polling).
  const atualizarNaoLidas = useCallback(() => {
    api.novidadesNaoLidas()
      .then((r) => setNaoLidas(r.naoLidas))
      .catch(() => setNaoLidas(0));
  }, []);

  useEffect(() => {
    if (estado.status === "autenticado") atualizarNaoLidas();
    else setNaoLidas(0);
  }, [estado.status, atualizarNaoLidas]);

  // Tempo real: toast + reconciliação do contador a cada publicação.
  // O contador é sempre reconsultado no servidor (novidadesNaoLidas) —
  // nunca incrementado localmente — e deduplicado por id:revisão.
  const { notificar } = useNotificar();
  useEffect(() => {
    if (estado.status !== "autenticado") return;
    const vistos = new Set<string>();
    const s = getSocket();
    const aoPublicar = (n: { id: string; titulo: string; revisao: string }) => {
      const chave = `${n.id}:${n.revisao}`;
      if (vistos.has(chave)) return;
      vistos.add(chave);
      notificar(`Nova publicação: ${n.titulo}`, "info");
      atualizarNaoLidas();
    };
    const aoConectar = () => atualizarNaoLidas();
    s.on("novidade:publicada", aoPublicar);
    s.on("connect", aoConectar);
    return () => {
      s.off("novidade:publicada", aoPublicar);
      s.off("connect", aoConectar);
    };
  }, [estado.status, notificar, atualizarNaoLidas]);

  if (estado.status === "carregando") {
    return (
      <main className="container">
        <p>Carregando…</p>
      </main>
    );
  }
  // Anônimo em /convite?code=... → fluxo de cadastro/login de jogador
  // (o código permanece na URL e a tela de aceite assume após autenticar).
  if (estado.status === "anonimo") return ehConvite ? <ConviteCadastro /> : <Login />;

  // Tela de aceite de convite (link /convite?code=...)
  if (ehConvite) {
    return (
      <>
        <header className="topo">
          <span className="marca">Mestre RPG</span>
          <nav><button className="sair" onClick={() => { window.location.href = "/"; }}>Painel</button></nav>
        </header>
        <Convite aoEntrar={() => { window.location.href = "/"; }} />
      </>
    );
  }

  return (
    <>
      <header className="topo">
        <span className="marca">Mestre RPG</span>
        <nav>
          <button className={aba === "painel" ? "ativo" : ""} onClick={() => { setAba("painel"); setCampanhaAberta(null); }}>Painel</button>
          <button className={aba === "campanhas" ? "ativo" : ""} onClick={() => { setAba("campanhas"); setCampanhaAberta(null); }}>Campanhas</button>
          <button className={aba === "acervo" ? "ativo" : ""} onClick={() => { setAba("acervo"); setCampanhaAberta(null); }}>Acervo</button>
          <button className={aba === "novidades" ? "ativo" : ""} onClick={() => { setAba("novidades"); setCampanhaAberta(null); atualizarNaoLidas(); }}>
            Novidades
            {naoLidas > 0 && <span className="contador-nao-lidas" aria-label={`${naoLidas} não lidas`}>{naoLidas}</span>}
          </button>
          {usuario?.isAdmin && (
            <button className={aba === "admin" ? "ativo" : ""} onClick={() => setAba("admin")}>Administração</button>
          )}
          <button className={aba === "conta" ? "ativo" : ""} onClick={() => setAba("conta")}>Conta</button>
          <button className="sair" onClick={() => void sair()}>Sair</button>
        </nav>
      </header>
      <main className={campanhaAberta ? "container container-largo" : "container"}>
        {forcarErro && <ErroProposital />}
        {aba === "painel" && <Painel />}
        {aba === "campanhas" && !campanhaAberta && <Campanhas aoAbrir={setCampanhaAberta} />}
        {aba === "campanhas" && campanhaAberta && (
          <Campanha id={campanhaAberta} aoVoltar={() => setCampanhaAberta(null)} />
        )}
        {aba === "acervo" && <Acervo />}
        {aba === "novidades" && <Novidades aoMudarLeitura={atualizarNaoLidas} />}
        {aba === "admin" && usuario?.isAdmin && <Admin />}
        {aba === "conta" && <Conta />}
      </main>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ProvedorNotificacoes>
        <Shell />
      </ProvedorNotificacoes>
    </AuthProvider>
  );
}
