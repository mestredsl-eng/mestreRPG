import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { api, type ConvitePreview } from "../api";

const PAPEL_LABEL: Record<string, string> = { jogador: "Jogador", espectador: "Espectador" };

/**
 * Porta de entrada anônima do convite (/convite?code=...):
 * mostra a campanha convidante e oferece cadastro de jogador ou login.
 * O código fica na URL o tempo todo — após autenticar, o Shell renderiza
 * a tela de aceite (<Convite>) sem perder o ?code=.
 */
export default function ConviteCadastro() {
  const { entrar, recarregar } = useAuth();
  const codigo = new URLSearchParams(window.location.search).get("code") ?? "";
  const [info, setInfo] = useState<ConvitePreview | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [modo, setModo] = useState<"cadastro" | "login">("cadastro");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!codigo) {
      setErro("Código de convite ausente na URL.");
      return;
    }
    api
      .previewConvite(codigo)
      .then(({ convite }) => setInfo(convite))
      .catch((e) => setErro(e instanceof Error ? e.message : "Convite inválido"));
  }, [codigo]);

  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      if (modo === "cadastro") {
        await api.registrar({
          codigo,
          username,
          password,
          displayName: displayName || undefined,
        });
        // /registrar já abre sessão — recarregar reflete o estado autenticado
        // e o Shell passa a renderizar a tela de aceite do convite.
        await recarregar();
      } else {
        await entrar(username, password);
      }
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro inesperado");
    } finally {
      setEnviando(false);
    }
  };

  const conviteInativo = !!info && info.status !== "ativo";

  return (
    <main className="container container-estreito">
      <h1>Convite para campanha</h1>

      {erro && !info && (
        <section className="cartao">
          <p className="erro">{erro}</p>
          <button className="secundario" onClick={() => { window.location.href = "/"; }}>Ir para o painel</button>
        </section>
      )}

      {!erro && !info && <section className="cartao"><p>Verificando convite…</p></section>}

      {info && (
        <>
          <section className="cartao">
            <h2>{info.campanha.name}</h2>
            <p>{info.campanha.system ? `Sistema: ${info.campanha.system}` : ""}</p>
            <p>
              Você foi convidado como <strong>{PAPEL_LABEL[info.role] ?? info.role}</strong>
              {info.requiresApproval && " (entrada sujeita a aprovação do mestre)"}.
            </p>
            {conviteInativo && <p className="erro">Este convite está {info.status}.</p>}
          </section>

          {!conviteInativo && (
            <form className="cartao formulario" onSubmit={submeter}>
              <p className="subtitulo">
                {modo === "cadastro" ? "Crie sua conta de jogador" : "Entre com sua conta"}
              </p>
              <label>
                Usuário
                <input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} autoComplete="username" />
              </label>
              {modo === "cadastro" && (
                <label>
                  Nome de exibição (opcional)
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={80} />
                </label>
              )}
              <label>
                Senha
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoComplete={modo === "login" ? "current-password" : "new-password"}
                />
              </label>

              {erro && <p className="erro">{erro}</p>}

              <button type="submit" disabled={enviando}>
                {enviando ? "Aguarde…" : modo === "cadastro" ? "Criar conta e entrar" : "Entrar"}
              </button>

              <button
                type="button"
                className="link"
                onClick={() => {
                  setModo(modo === "cadastro" ? "login" : "cadastro");
                  setErro(null);
                }}
              >
                {modo === "cadastro" ? "Já tenho conta — entrar" : "Não tenho conta — criar jogador"}
              </button>
            </form>
          )}
        </>
      )}
    </main>
  );
}
