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

  // Campanhas (Etapa 3)
  listarCampanhas: () =>
    requisicao<{ campanhas: CampanhaResumo[] }>("/campaigns"),
  criarCampanha: (dados: { name: string; description?: string; system?: string }) =>
    requisicao<{ campanha: CampanhaResumo }>("/campaigns", { method: "POST", body: JSON.stringify(dados) }),
  obterCampanha: (id: string) =>
    requisicao<{ campanha: CampanhaResumo }>(`/campaigns/${id}`),
  atualizarCampanha: (id: string, dados: Partial<{ name: string; description: string; system: string; status: string; coverImage: string | null }>) =>
    requisicao<{ campanha: Campanha }>(`/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(dados) }),
  listarMembros: (id: string) =>
    requisicao<{ membros: Membro[] }>(`/campaigns/${id}/members`),
  atualizarMembro: (campaignId: string, membershipId: string, dados: { role?: string; status?: string }) =>
    requisicao<{ ok: boolean }>(`/campaigns/${campaignId}/members/${membershipId}`, { method: "PATCH", body: JSON.stringify(dados) }),
  removerMembro: (campaignId: string, membershipId: string) =>
    requisicao<{ ok: boolean }>(`/campaigns/${campaignId}/members/${membershipId}`, { method: "DELETE" }),
  transferirTitularidade: (campaignId: string, membershipId: string) =>
    requisicao<{ ok: boolean }>(`/campaigns/${campaignId}/transferir/${membershipId}`, { method: "POST" }),
  criarConvite: (campaignId: string, dados: { role?: string; maxUses?: number; expiresInHours?: number; requiresApproval?: boolean }) =>
    requisicao<{ convite: { id: string; code: string } }>(`/campaigns/${campaignId}/invitations`, { method: "POST", body: JSON.stringify(dados) }),
  listarConvites: (campaignId: string) =>
    requisicao<{ convites: Convite[] }>(`/campaigns/${campaignId}/invitations`),
  revogarConvite: (campaignId: string, invitationId: string) =>
    requisicao<{ ok: boolean }>(`/campaigns/${campaignId}/invitations/${invitationId}`, { method: "PATCH", body: JSON.stringify({ action: "revogar" }) }),

  // Convites públicos (Etapa 3)
  validarConvite: (codigo: string) =>
    requisicao<{ convite: ConviteInfo }>(`/convites/${encodeURIComponent(codigo)}`),
  aceitarConvite: (codigo: string) =>
    requisicao<{ ok: boolean; status: string; mensagem: string }>(`/convites/${encodeURIComponent(codigo)}/aceitar`, { method: "POST" }),

  // Modelos de ficha (Etapa 4)
  listarModelos: (cid: string) =>
    requisicao<{ modelos: ModeloResumo[] }>(`/campaigns/${cid}/sheet-templates`),
  criarModelo: (cid: string, dados: { name: string; description?: string }) =>
    requisicao<{ modelo: { id: string; versionId: string } }>(`/campaigns/${cid}/sheet-templates`, { method: "POST", body: JSON.stringify(dados) }),
  obterModelo: (cid: string, tid: string) =>
    requisicao<{ modelo: ModeloResumo; versoes: VersaoModelo[] }>(`/campaigns/${cid}/sheet-templates/${tid}`),
  atualizarModelo: (cid: string, tid: string, dados: { name?: string; description?: string | null; isActive?: boolean; isDefault?: boolean }) =>
    requisicao<{ modelo: ModeloResumo }>(`/campaigns/${cid}/sheet-templates/${tid}`, { method: "PATCH", body: JSON.stringify(dados) }),
  duplicarModelo: (cid: string, tid: string) =>
    requisicao<{ modelo: { id: string; versionId: string } }>(`/campaigns/${cid}/sheet-templates/${tid}/duplicate`, { method: "POST" }),
  criarVersaoModelo: (cid: string, tid: string) =>
    requisicao<{ versionId: string }>(`/campaigns/${cid}/sheet-templates/${tid}/versions`, { method: "POST" }),
  salvarEstrutura: (cid: string, tid: string, vid: string, estrutura: EstruturaFicha) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/sheet-templates/${tid}/versions/${vid}`, { method: "PUT", body: JSON.stringify({ estrutura }) }),
  publicarVersao: (cid: string, tid: string, versionId: string) =>
    requisicao<{ ok: boolean; version: number }>(`/campaigns/${cid}/sheet-templates/${tid}/publish`, { method: "POST", body: JSON.stringify({ versionId }) }),

  // Personagens (Etapa 4)
  listarPersonagens: (cid: string) =>
    requisicao<{ personagens: PersonagemResumo[] }>(`/campaigns/${cid}/characters`),
  criarPersonagem: (cid: string, dados: { name: string; templateVersionId?: string; data?: Record<string, unknown> }) =>
    requisicao<PersonagemDetalhe>(`/campaigns/${cid}/characters`, { method: "POST", body: JSON.stringify(dados) }),
  obterPersonagem: (charId: string) =>
    requisicao<PersonagemDetalhe>(`/characters/${charId}`),
  atualizarPersonagem: (charId: string, dados: { name?: string; data?: Record<string, unknown>; status?: string; overrides?: Record<string, unknown> }) =>
    requisicao<PersonagemDetalhe>(`/characters/${charId}`, { method: "PATCH", body: JSON.stringify(dados) }),
};

// ---- Tipos da Etapa 4: fichas e personagens ----

export type TipoCampo =
  | "texto" | "texto_longo" | "inteiro" | "decimal" | "moeda" | "data"
  | "checkbox" | "selecao_unica" | "selecao_multipla" | "lista" | "tabela"
  | "calculado" | "referencia";

export interface CampoDef {
  id: string;
  label: string;
  descricao?: string;
  tipo: TipoCampo;
  semantico: string;
  categoria?: string;
  parentKey?: string;
  obrigatorio: boolean;
  padrao?: unknown;
  minimo?: number;
  maximo?: number;
  maxCaracteres?: number;
  opcoes?: string[];
  repetivel: boolean;
  colunas?: { key: string; label: string; tipo: string }[];
  formula?: string;
  referencia?: string;
  visibilidade: string;
  destinatarios?: string[];
  editavelPor: string;
  usadoEmTestes: boolean;
  custoPontos?: number;
  reservaPontos?: string;
}

export interface SecaoDef {
  id: string;
  titulo: string;
  descricao?: string;
  parentId?: string;
  ordem: number;
  campos: CampoDef[];
}

export interface EstruturaFicha {
  versao: number;
  secoes: SecaoDef[];
  pontos: { habilitado: boolean; pontosIniciais: number; pools: { id: string; nome: string; pontos: number }[]; custos: Record<string, number[]> };
}

export interface ModeloResumo {
  id: string;
  campaignId: string | null;
  name: string;
  description: string | null;
  isActive: boolean;
  isDefault: boolean;
  currentVersionId: string | null;
  versaoAtual: { id: string; version: number; publishedAt: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersaoModelo {
  id: string;
  version: number;
  publishedAt: string | null;
  rascunho: boolean;
  estrutura?: EstruturaFicha;
}

export interface PersonagemResumo {
  id: string;
  name: string;
  status: string;
  dono: string;
  displayName: string | null;
  membershipId: string;
  ehEu: boolean;
  updatedAt: string;
}

export interface FichaRenderizada {
  campos: Record<string, unknown>;
  calculados: Record<string, number | string>;
  estrutura: EstruturaFicha;
}

export interface PersonagemDetalhe {
  personagem: {
    id: string;
    campaignId: string;
    name: string;
    status: string;
    templateVersionId: string | null;
    templateId?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  ficha: FichaRenderizada | null;
}

// ---- Tipos da Etapa 3 ----

export interface Campanha {
  id: string;
  name: string;
  description: string | null;
  system: string | null;
  coverImage: string | null;
  status: string;
  ownerId: string;
  settings: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CampanhaResumo extends Campanha {
  meuPapel: string;
  meuStatus: string;
}

export interface Membro {
  membershipId: string;
  userId: string;
  username: string;
  displayName: string | null;
  email: string | null;
  role: string;
  status: string;
  permissions: unknown;
  joinedAt: string | null;
  ehEu: boolean;
}

export interface Convite {
  id: string;
  role: string;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  requiresApproval: boolean;
  status: string;
  createdAt: string;
}

export interface ConviteInfo {
  role: string;
  requiresApproval: boolean;
  status: string;
  campanha: { id: string; name: string; system: string | null; status: string };
  jaParticipa: boolean;
  meuStatus: string | null;
}
