import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "./auth";
import { api, type ConviteGuildaPreview, type HealthStatus } from "./api";
import Login from "./paginas/Login";
import { ProvedorNotificacoes, useNotificar } from "./Notificacoes";
import { getSocket } from "./socket";
import IconeInterface from "./IconeInterface";
import { aplicarPreferenciasVisuais, limparPreferenciasVisuais, preferenciasVisuaisDe } from "./visualUsuario";

// Telas secundárias são carregadas sob demanda para reduzir o JavaScript
// necessário no primeiro acesso. O estado e a navegação continuam no Shell.
const Admin = lazy(() => import("./paginas/Admin"));
const Conta = lazy(() => import("./paginas/Conta"));
const Campanhas = lazy(() => import("./paginas/Campanhas"));
const Campanha = lazy(() => import("./paginas/Campanha"));
const Convite = lazy(() => import("./paginas/Convite"));
const ConviteCadastro = lazy(() => import("./paginas/ConviteCadastro"));
const Acervo = lazy(() => import("./paginas/Acervo"));
const Guildas = lazy(() => import("./paginas/Guildas"));
const Novidades = lazy(() => import("./paginas/Novidades"));
type Aba = "painel" | "campanhas" | "acervo" | "novidades" | "guildas" | "admin" | "conta";

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

/** Tela de aceite de convite interno de guilda (/?conviteGuilda=...). */
function AceiteConviteGuilda({ codigo, aoConcluir, aoSair }: { codigo: string; aoConcluir: () => void; aoSair: () => void }) {
  const [preview, setPreview] = useState<ConviteGuildaPreview | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aceitando, setAceitando] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);
  const aceitou = useRef(false);

  useEffect(() => {
    let ativo = true;
    api.obterConviteGuilda(codigo)
      .then((r) => { if (ativo) setPreview(r.convite); })
      .catch((e) => { if (ativo) setErro(e instanceof Error ? e.message : "Convite inválido"); });
    return () => { ativo = false; };
  }, [codigo]);

  const aceitar = async () => {
    // nunca aceitar automaticamente nem em cliques repetidos
    if (aceitando || aceitou.current) return;
    aceitou.current = true;
    setAceitando(true);
    setErro(null);
    try {
      const r = await api.aceitarConviteGuilda(codigo);
      setResultado(`Você entrou na guilda como ${r.papel === "gm" ? "GM" : "membro"}.`);
      setTimeout(aoConcluir, 1200);
    } catch (e) {
      aceitou.current = false;
      setErro(e instanceof Error ? e.message : "Erro ao aceitar convite");
    } finally {
      setAceitando(false);
    }
  };

  const invalido = erro && !preview;
  return (
    <main className="container container-estreito">
      <h1>Convite de guilda</h1>
      {invalido && (
        <section className="cartao">
          <p className="erro">{erro}</p>
          <button className="secundario" onClick={aoSair}>Ir para o painel</button>
        </section>
      )}
      {!erro && !preview && <section className="cartao"><p>Verificando convite…</p></section>}
      {preview && !resultado && (
        <section className="cartao">
          <h2>{preview.guilda.nome}</h2>
          <p className="meta">
            Convite para entrar como <strong>membro</strong>
            {preview.usosRestantes >= 0 ? ` · ${preview.usosRestantes} uso${preview.usosRestantes === 1 ? "" : "s"} restante${preview.usosRestantes === 1 ? "" : "s"}` : ""}
            {` · válido até ${new Date(preview.expiraEm).toLocaleString("pt-BR")}`}
          </p>
          {preview.status !== "ativo" && <p className="erro">Este convite está {preview.status}.</p>}
          {erro && <p className="erro">{erro}</p>}
          <div className="linha">
            {preview.status === "ativo" ? (
              <button onClick={() => void aceitar()} disabled={aceitando}>
                {aceitando ? "Entrando…" : "Aceitar convite"}
              </button>
            ) : null}
            <button className="secundario" onClick={aoSair}>Ir para o painel</button>
          </div>
        </section>
      )}
      {resultado && (
        <section className="cartao">
          <p className="online">{resultado}</p>
        </section>
      )}
    </main>
  );
}

function Shell() {
  const { estado, sair } = useAuth();
  const [aba, setAba] = useState<Aba>("painel");
  const [campanhaAberta, setCampanhaAberta] = useState<string | null>(null);
  const [naoLidas, setNaoLidas] = useState(0);
  // Incrementa a cada novidade:publicada — sinal para a aba Novidades
  // recarregar a lista sem sair da tela.
  const [novidadesVersao, setNovidadesVersao] = useState(0);
  const usuario = estado.status === "autenticado" ? estado.usuario : null;
  const ehConvite = window.location.pathname.startsWith("/convite");
  const forcarErro = new URLSearchParams(window.location.search).has("__erro");
  // Convite interno de guilda (/?conviteGuilda=...): o código opaco fica
  // na URL durante o login e só vira aceite após autenticação + clique
  // explícito — nunca é consumido pela simples visualização.
  const [codigoConviteGuilda, setCodigoConviteGuilda] = useState(() =>
    new URLSearchParams(window.location.search).get("conviteGuilda"));
  const limparConviteGuilda = useCallback(() => {
    window.history.replaceState({}, "", "/");
    setCodigoConviteGuilda(null);
  }, []);

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

  // Preferências visuais da conta (Issue #132): aplica os tokens salvos
  // no <html> a cada mudança de sessão/usuário; no logout, limpa os
  // overrides para não vazar o tema de um usuário para outro.
  useEffect(() => {
    if (estado.status === "autenticado") {
      aplicarPreferenciasVisuais(preferenciasVisuaisDe(estado.usuario.preferences?.visual));
    } else if (estado.status === "anonimo") {
      limparPreferenciasVisuais();
    }
  }, [estado]);

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
      // A deduplicação id:revisão acima é a autoridade deste evento;
      // não reaplicar a janela global baseada apenas no texto do toast.
      notificar(`Nova publicação: ${n.titulo}`, "info", { deduplicar: false });
      atualizarNaoLidas();
      setNovidadesVersao((v) => v + 1);
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
          <span className="marca"><IconeInterface nome="simbolo" /><span>Mestre RPG</span></span>
          <nav><button className="sair" onClick={() => { window.location.href = "/"; }}>Painel</button></nav>
        </header>
        <Convite aoEntrar={() => { window.location.href = "/"; }} />
      </>
    );
  }

  // Aceite de convite interno de guilda — somente autenticado.
  // Anônimos caem no Login acima com o código preservado na URL.
  if (codigoConviteGuilda) {
    return (
      <AceiteConviteGuilda
        codigo={codigoConviteGuilda}
        aoConcluir={() => { limparConviteGuilda(); setAba("guildas"); }}
        aoSair={limparConviteGuilda}
      />
    );
  }

  return (
    <>
      <header className="topo">
        <span className="marca"><IconeInterface nome="simbolo" /><span>Mestre RPG</span></span>
        <nav>
          <button className={aba === "painel" ? "ativo" : ""} onClick={() => { setAba("painel"); setCampanhaAberta(null); }}><IconeInterface nome="painel" /><span>Painel</span></button>
          <button className={aba === "campanhas" ? "ativo" : ""} onClick={() => { setAba("campanhas"); setCampanhaAberta(null); }}><IconeInterface nome="campanhas" /><span>Campanhas</span></button>
          <button className={aba === "acervo" ? "ativo" : ""} onClick={() => { setAba("acervo"); setCampanhaAberta(null); }}><IconeInterface nome="acervo" /><span>Acervo</span></button>
          <button className={aba === "novidades" ? "ativo" : ""} onClick={() => { setAba("novidades"); setCampanhaAberta(null); atualizarNaoLidas(); }}>
            <IconeInterface nome="novidades" /><span>Novidades</span>
            {naoLidas > 0 && <span className="contador-nao-lidas" aria-label={`${naoLidas} não lidas`}>{naoLidas}</span>}
          </button>
          <button className={aba === "guildas" ? "ativo" : ""} onClick={() => { setAba("guildas"); setCampanhaAberta(null); }}><IconeInterface nome="guildas" /><span>Guildas</span></button>
          {usuario?.isAdmin && (
            <button className={aba === "admin" ? "ativo" : ""} onClick={() => setAba("admin")}><IconeInterface nome="admin" /><span>Administração</span></button>
          )}
          <button className={aba === "conta" ? "ativo" : ""} onClick={() => setAba("conta")}><IconeInterface nome="conta" /><span>Conta</span></button>
          <button className="sair" onClick={() => void sair()}><IconeInterface nome="sair" /><span>Sair</span></button>
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
        {aba === "novidades" && <Novidades aoMudarLeitura={atualizarNaoLidas} versao={novidadesVersao} />}
        {aba === "guildas" && <Guildas />}
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
        <Suspense fallback={<main className="container"><p>Carregando módulo…</p></main>}>
          <Shell />
        </Suspense>
      </ProvedorNotificacoes>
    </AuthProvider>
  );
}
