import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type UsuarioAdmin } from "../api";

export default function Admin() {
  const [usuarios, setUsuarios] = useState<UsuarioAdmin[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [editando, setEditando] = useState<string | null>(null);
  const [novoAberto, setNovoAberto] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", email: "", password: "", isAdmin: false });

  const carregar = useCallback(async () => {
    try {
      const { usuarios } = await api.listarUsuarios();
      setUsuarios(usuarios);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar usuários");
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const criar = async (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    try {
      await api.criarUsuario({
        username: form.username,
        displayName: form.displayName || undefined,
        email: form.email || undefined,
        password: form.password,
        isAdmin: form.isAdmin,
      });
      setNovoAberto(false);
      setForm({ username: "", displayName: "", email: "", password: "", isAdmin: false });
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao criar usuário");
    }
  };

  const alternarBloqueio = async (u: UsuarioAdmin) => {
    try {
      await api.atualizarUsuario(u.id, { status: u.status === "bloqueado" ? "ativo" : "bloqueado" });
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao alterar status");
    }
  };

  const redefinirSenha = async (u: UsuarioAdmin) => {
    const senha = window.prompt(`Nova senha para ${u.username} (mín. 8 caracteres):`);
    if (!senha) return;
    try {
      await api.atualizarUsuario(u.id, { password: senha });
      alert("Senha redefinida. As sessões ativas do usuário foram encerradas.");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao redefinir senha");
    }
  };

  const remover = async (u: UsuarioAdmin) => {
    if (!window.confirm(`Remover o usuário "${u.username}"? Esta ação não pode ser desfeita.`)) return;
    try {
      await api.removerUsuario(u.id);
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao remover usuário");
    }
  };

  return (
    <section className="cartao">
      <div className="linha-entre">
        <h2>Usuários</h2>
        <button onClick={() => setNovoAberto((v) => !v)}>{novoAberto ? "Cancelar" : "Novo usuário"}</button>
      </div>

      {erro && <p className="erro">{erro}</p>}

      {novoAberto && (
        <form className="formulario" onSubmit={criar}>
          <div className="grade-2">
            <label>Usuário<input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required minLength={3} /></label>
            <label>Nome de exibição<input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></label>
            <label>E-mail<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label>Senha inicial<input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} /></label>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} />
            Administrador do servidor
          </label>
          <button type="submit">Criar usuário</button>
        </form>
      )}

      <table className="tabela">
        <thead>
          <tr>
            <th>Usuário</th>
            <th>Nome</th>
            <th>Papel</th>
            <th>Status</th>
            <th>Criado em</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          {usuarios.map((u) => (
            <tr key={u.id} className={u.status === "bloqueado" ? "linha-bloqueada" : ""}>
              <td>{u.username}</td>
              <td>{u.displayName ?? "—"}</td>
              <td>{u.isAdmin ? "Administrador" : "Usuário"}</td>
              <td>{u.status === "bloqueado" ? "Bloqueado" : "Ativo"}</td>
              <td>{new Date(u.createdAt).toLocaleDateString("pt-BR")}</td>
              <td className="acoes">
                <button className="mini" onClick={() => setEditando(editando === u.id ? null : u.id)}>
                  {editando === u.id ? "Fechar" : "Editar"}
                </button>
                <button className="mini" onClick={() => void alternarBloqueio(u)}>
                  {u.status === "bloqueado" ? "Desbloquear" : "Bloquear"}
                </button>
                <button className="mini" onClick={() => void redefinirSenha(u)}>Senha</button>
                <button className="mini perigo" onClick={() => void remover(u)}>Remover</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editando && (
        <FormEdicao
          usuario={usuarios.find((u) => u.id === editando)!}
          aoSalvar={async (dados) => {
            await api.atualizarUsuario(editando, dados);
            setEditando(null);
            await carregar();
          }}
          aoCancelar={() => setEditando(null)}
        />
      )}
    </section>
  );
}

function FormEdicao({
  usuario,
  aoSalvar,
  aoCancelar,
}: {
  usuario: UsuarioAdmin;
  aoSalvar: (dados: { username?: string; displayName?: string; email?: string; isAdmin?: boolean }) => Promise<void>;
  aoCancelar: () => void;
}) {
  const [username, setUsername] = useState(usuario.username);
  const [displayName, setDisplayName] = useState(usuario.displayName ?? "");
  const [email, setEmail] = useState(usuario.email ?? "");
  const [isAdmin, setIsAdmin] = useState(usuario.isAdmin);
  const [erro, setErro] = useState<string | null>(null);

  const salvar = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await aoSalvar({ username, displayName, email, isAdmin });
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao salvar");
    }
  };

  return (
    <form className="formulario formulario-edicao" onSubmit={salvar}>
      <h3>Editando {usuario.username}</h3>
      <div className="grade-2">
        <label>Usuário<input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={3} /></label>
        <label>Nome de exibição<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></label>
        <label>E-mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
        Administrador do servidor
      </label>
      {erro && <p className="erro">{erro}</p>}
      <div className="linha">
        <button type="submit">Salvar</button>
        <button type="button" className="secundario" onClick={aoCancelar}>Cancelar</button>
      </div>
    </form>
  );
}
