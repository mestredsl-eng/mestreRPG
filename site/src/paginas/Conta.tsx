import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useAuth } from "../auth";
import { useNotificar } from "../Notificacoes";
import { api, type SessaoConta } from "../api";

function descreverNavegador(userAgent: string | null): string {
  if (!userAgent) return "Dispositivo desconhecido";
  const ua = userAgent;
  let navegador = "Navegador";
  if (ua.includes("Edg/")) navegador = "Edge";
  else if (ua.includes("OPR/") || ua.includes("Opera")) navegador = "Opera";
  else if (ua.includes("Firefox/")) navegador = "Firefox";
  else if (ua.includes("Chrome/")) navegador = "Chrome";
  else if (ua.includes("Safari/") && !ua.includes("Chrome")) navegador = "Safari";
  let sistema = "";
  if (ua.includes("Windows")) sistema = "Windows";
  else if (ua.includes("Android")) sistema = "Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) sistema = "iOS";
  else if (ua.includes("Mac OS")) sistema = "macOS";
  else if (ua.includes("Linux")) sistema = "Linux";
  return sistema ? `${navegador} · ${sistema}` : navegador;
}

export default function Conta() {
  const { estado, sair, recarregar } = useAuth();
  const usuario = estado.status === "autenticado" ? estado.usuario : null;
  const [senhaAtual, setSenhaAtual] = useState("");
  const [novaSenha, setNovaSenha] = useState("");
  const [confirmacao, setConfirmacao] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [sessoes, setSessoes] = useState<SessaoConta[] | null>(null);
  const [erroSessoes, setErroSessoes] = useState<string | null>(null);
  const [revogando, setRevogando] = useState<string | null>(null);
  const { notificar } = useNotificar();

  const carregarSessoes = useCallback(async () => {
    try {
      const r = await api.listarSessoesAuth();
      setSessoes(r.sessoes);
      setErroSessoes(null);
    } catch {
      setErroSessoes("Não foi possível carregar as sessões.");
    }
  }, []);

  useEffect(() => {
    void carregarSessoes();
  }, [carregarSessoes]);

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

  const encerrarSessao = async (s: SessaoConta) => {
    if (s.atual) return;
    if (!window.confirm(`Encerrar a sessão "${descreverNavegador(s.userAgent)}" de ${s.ip ?? "IP desconhecido"}? O dispositivo será desconectado.`)) return;
    setRevogando(s.id);
    try {
      await api.revogarSessaoAuth(s.id);
      notificar("Sessão encerrada.", "sucesso");
      await carregarSessoes();
    } catch (err) {
      notificar(err instanceof Error ? err.message : "Erro ao encerrar sessão.", "erro");
    } finally {
      setRevogando(null);
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
        <h2>Sessões ativas</h2>
        {erroSessoes && <p className="erro">{erroSessoes}</p>}
        {sessoes === null && !erroSessoes && <p className="dica">Carregando…</p>}
        {sessoes !== null && sessoes.length === 0 && <p className="dica">Nenhuma sessão ativa.</p>}
        {sessoes !== null && sessoes.length > 0 && (
          <>
          <table className="tabela tabela-responsiva">
            <thead>
              <tr><th>Dispositivo</th><th>IP</th><th>Criada em</th><th>Expira em</th><th /></tr>
            </thead>
            <tbody>
              {sessoes.map((s) => (
                <tr key={s.id}>
                  <td>
                    {descreverNavegador(s.userAgent)}
                    {s.atual && <span className="badge badge-ativa">esta sessão</span>}
                  </td>
                  <td>{s.ip ?? "—"}</td>
                  <td>{new Date(s.createdAt).toLocaleString("pt-BR")}</td>
                  <td>{new Date(s.expiresAt).toLocaleString("pt-BR")}</td>
                  <td>
                    {!s.atual && (
                      <button
                        type="button"
                        className="secundario"
                        disabled={revogando === s.id}
                        onClick={() => void encerrarSessao(s)}
                      >
                        {revogando === s.id ? "Encerrando…" : "Encerrar"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cartoes-registro">
            {sessoes.map((s) => (
              <div key={s.id} className="registro-cartao">
                <div className="registro-campo">
                  <span className="registro-rotulo">Dispositivo</span>
                  <span>
                    {descreverNavegador(s.userAgent)}
                    {s.atual && <> <span className="badge badge-ativa">esta sessão</span></>}
                  </span>
                </div>
                <div className="registro-campo"><span className="registro-rotulo">IP</span><span>{s.ip ?? "—"}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Criada em</span><span>{new Date(s.createdAt).toLocaleString("pt-BR")}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Expira em</span><span>{new Date(s.expiresAt).toLocaleString("pt-BR")}</span></div>
                {!s.atual && (
                  <div className="registro-acoes">
                    <button
                      type="button"
                      className="mini secundario"
                      disabled={revogando === s.id}
                      onClick={() => void encerrarSessao(s)}
                    >
                      {revogando === s.id ? "Encerrando…" : "Encerrar"}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          </>
        )}
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
