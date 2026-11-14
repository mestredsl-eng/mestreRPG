import { useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { useNotificar } from "../Notificacoes";
import { api } from "../api";

export default function Conta() {
  const { estado, sair, recarregar } = useAuth();
  const usuario = estado.status === "autenticado" ? estado.usuario : null;
  const [senhaAtual, setSenhaAtual] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const { notificar } = useNotificar();

  const trocarSenha = async (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    if (novaSenha !== confirmacao) {
      setErro("A confirmação não confere com a nova senha");
      return;
    }
    try {
      await api.changePassword(senhaAtual, novaSenha);
      setSenhaAtual("");
      setNovaSenha("");
      setConfirmacao("");
      notificar("Senha alterada com sucesso.", "sucesso");
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao alterar senha");
    }
  };

  return (
    <>
      <section className="cartao">
        <h2>Sua conta</h2>
        {usuario && (
          <table className="tabela">
            <tbody>
              <tr><th>Usuário</th><td>{usuario.username}</td></tr>
              <tr><th>Nome</th><td>{usuario.displayName ?? "—"}</td></tr>
              <tr><th>E-mail</th><td>{usuario.email ?? "—"}</td></tr>
              <tr><th>Papel</th><td>{usuario.adminPrincipal ? "Administrador principal" : usuario.isAdmin ? "Administrador" : "Usuário"}</td></tr>
              {(usuario.guildas ?? []).length > 0 && (
                <tr>
                  <th>Guildas</th>
                  <td>{(usuario.guildas ?? []).map((g) => `${g.role === "gm" ? "GM" : "Membro"} — ${g.nome}`).join(" · ")}</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <div className="linha">
          <button className="secundario" onClick={() => void recarregar()}>Atualizar</button>
          <button className="perigo" onClick={() => void sair()}>Sair</button>
        </div>
      </section>

      <section className="cartao">
        <h2>Alterar senha</h2>
        <form className="formulario" onSubmit={trocarSenha}>
          <label>Senha atual<input type="password" value={senhaAtual} onChange={(e) => setSenhaAtual(e.target.value)} required autoComplete="current-password" /></label>
          <label>Nova senha<input type="password" value={novaSenha} onChange={(e) => setNovaSenha(e.target.value)} required minLength={8} autoComplete="new-password" /></label>
          <label>Confirmar nova senha<input type="password" value={confirmacao} onChange={(e) => setConfirmacao(e.target.value)} required minLength={8} autoComplete="new-password" /></label>
          {erro && <p className="erro">{erro}</p>}
          <button type="submit">Alterar senha</button>
        </form>
      </section>
    </>
  );
}
