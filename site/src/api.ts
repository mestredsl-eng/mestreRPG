const API_BASE = "/api";

export interface HealthStatus {
  status: string;
  servico: string;
  timestamp: string;
}

export interface Usuario {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
}

export interface UsuarioAdmin extends Usuario {
  status: string;
  createdAt: string;
}

async function requisicao<T>(caminho: string, opcoes: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${caminho}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opcoes.headers ?? {}) },
    ...opcoes,
  });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((corpo as { erro?: string }).erro ?? `HTTP ${res.status}`);
  }
  return corpo as T;
}

export const api = {
  health: () => requisicao<HealthStatus>("/health"),

  setup: (dados: { username: string; password: string; displayName?: string; email?: string }) =>
    requisicao<{ ok: boolean }>("/auth/setup", { method: "POST", body: JSON.stringify(dados) }),

  login: (username: string, password: string) =>
    requisicao<{ usuario: Usuario }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  logout: () => requisicao<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  me: () => requisicao<{ usuario: Usuario }>("/auth/me"),

  changePassword: (senhaAtual: string, novaSenha: string) =>
    requisicao<{ ok: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ senhaAtual, novaSenha }),
    }),

  // Administração (somente admin)
  listarUsuarios: () => requisicao<{ usuarios: UsuarioAdmin[] }>("/admin/users"),
  criarUsuario: (dados: {
    username: string;
    password: string;
    email?: string;
    displayName?: string;
    isAdmin?: boolean;
  }) => requisicao<{ usuario: UsuarioAdmin }>("/admin/users", { method: "POST", body: JSON.stringify(dados) }),
  atualizarUsuario: (id: string, dados: Partial<{ username: string; email: string; displayName: string; password: string; isAdmin: boolean; status: string }>) =>
    requisicao<{ usuario: UsuarioAdmin }>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(dados) }),
  removerUsuario: (id: string) =>
    requisicao<{ ok: boolean }>(`/admin/users/${id}`, { method: "DELETE" }),
};
