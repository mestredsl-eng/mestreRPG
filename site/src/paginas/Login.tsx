import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { api } from "../api";

export default function Login() {
  const { entrar } = useAuth();
  const [modo, setModo] = useState<"login" | "setup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      if (modo === "setup") {
        await api.setup({ username, password, displayName: displayName || undefined });
        setModo("login");
        setErro(null);
      } else {
        await entrar(username, password);
      }
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro inesperado");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <main className="container container-estreito">
      <h1>Mestre RPG</h1>
      <p className="subtitulo">
        {modo === "login" ? "Entre com sua conta" : "Criar conta de administrador"}
      </p>

      <form className="cartao formulario" onSubmit={submeter}>
        <label>
          Usuário
          <input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} autoComplete="username" />
        </label>
        {modo === "setup" && (
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
          {enviando ? "Aguarde…" : modo === "login" ? "Entrar" : "Criar administrador"}
        </button>

        <button
          type="button"
          className="link"
          onClick={() => {
            setModo(modo === "login" ? "setup" : "login");
            setErro(null);
          }}
        >
          {modo === "login"
            ? "Primeiro acesso? Criar conta de administrador"
            : "Já tenho conta — voltar ao login"}
        </button>
      </form>
    </main>
  );
}
