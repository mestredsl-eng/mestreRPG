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
  preferences?: { dados?: { corExterna: string; corInterna: string } } & Record<string, unknown>;
}

export interface UsuarioAdmin extends Usuario {
  status: string;
  createdAt: string;
  /** true apenas para a conta administradora original protegida (admin_principal). */
  adminPrincipal?: boolean;
}

export class ApiError extends Error {
  detalhes?: unknown;
  constructor(mensagem: string, detalhes?: unknown) {
    super(mensagem);
    this.detalhes = detalhes;
  }
}

async function requisicao<T>(caminho: string, opcoes: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${caminho}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opcoes.headers ?? {}) },
    ...opcoes,
  });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    const c = corpo as { erro?: string; detalhes?: unknown };
    throw new ApiError(c.erro ?? `HTTP ${res.status}`, c.detalhes);
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

  /** Cadastro de jogador por convite — retorna sessão ativa (cookie). */
  registrar: (dados: { codigo: string; username: string; password: string; displayName?: string; email?: string }) =>
    requisicao<{ usuario: Usuario }>("/auth/registrar", { method: "POST", body: JSON.stringify(dados) }),

  logout: () => requisicao<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  me: () => requisicao<{ usuario: Usuario }>("/auth/me"),

  changePassword: (senhaAtual: string, novaSenha: string) =>
    requisicao<{ ok: boolean }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ senhaAtual, novaSenha }),
    }),

  atualizarPreferenciasDados: (corExterna: string, corInterna: string) =>
    requisicao<{ ok: boolean; preferences: Usuario["preferences"] }>("/auth/preferences", {
      method: "PATCH",
      body: JSON.stringify({ dados: { corExterna, corInterna } }),
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
  atualizarCampanha: (id: string, dados: Partial<{ name: string; description: string; system: string; status: string; coverImage: string | null; summary: string | null }>) =>
    requisicao<{ campanha: Campanha }>(`/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(dados) }),
  listarMembros: (id: string) =>
    requisicao<{ membros: Membro[] }>(`/campaigns/${id}/members`),
  atualizarMembro: (campaignId: string, membershipId: string, dados: { role?: string; status?: string; permissions?: PermissoesMembro }) =>
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
  /** Prévia pública do convite (anônimo) — sem dados de membership. */
  previewConvite: (codigo: string) =>
    requisicao<{ convite: ConvitePreview }>(`/convites/${encodeURIComponent(codigo)}/preview`),
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
  criarPersonagem: (cid: string, dados: { name: string; templateVersionId?: string; data?: Record<string, unknown>; isNpc?: boolean }) =>
    requisicao<PersonagemDetalhe>(`/campaigns/${cid}/characters`, { method: "POST", body: JSON.stringify(dados) }),
  obterPersonagem: (charId: string) =>
    requisicao<PersonagemDetalhe>(`/characters/${charId}`),
  previaPontos: (charId: string, dados: Record<string, unknown>) =>
    requisicao<{ pontos: ResultadoPontos }>(`/characters/${charId}/pontos-previa`, { method: "POST", body: JSON.stringify({ dados }) }),
  atualizarPersonagem: (charId: string, dados: { name?: string; data?: Record<string, unknown>; status?: string; overrides?: Record<string, unknown>; ignorarPontos?: boolean }) =>
    requisicao<PersonagemDetalhe>(`/characters/${charId}`, { method: "PATCH", body: JSON.stringify(dados) }),
  alterarHp: (charId: string, dados: { acao: "dano" | "recuperar" | "ajuste"; quantidade?: number; motivo?: string }) =>
    requisicao<{ ok: boolean; hp: NonNullable<NonNullable<PersonagemDetalhe["ficha"]>["vida"]>["hp"] }>(`/characters/${charId}/hp`, { method: "POST", body: JSON.stringify(dados) }),
  alterarVitalidade: (charId: string, nivel: number, motivo?: string) =>
    requisicao<{ ok: boolean; vitalidade: NonNullable<NonNullable<PersonagemDetalhe["ficha"]>["vida"]>["vitalidade"] }>(`/characters/${charId}/vitalidade`, { method: "POST", body: JSON.stringify({ nivel, motivo }) }),
  /** Bônus individual de pontos — somente mestre. */
  adminPontos: (charId: string, dados: { acao: "conceder" | "remover"; quantidade: number; motivo: string }) =>
    requisicao<{ ok: boolean; pontos: { bonus: number; selado: boolean; historico: { em: string; quantidade: number; motivo: string; autorNome: string | null }[] } }>(`/characters/${charId}/pontos`, { method: "POST", body: JSON.stringify(dados) }),

  // Regras da campanha (Etapa 5)
  obterRegras: (cid: string) =>
    requisicao<RegrasCampanha>(`/campaigns/${cid}/regras`),
  listarAcervoCampanha: (cid: string) =>
    requisicao<{ livros: LivroAcervoCampanha[] }>("/campaigns/" + cid + "/regras/acervo"),
  aplicarLivroAcervo: (cid: string, bookId: string, decisoes: Record<string, "manter_campanha" | "usar_livro"> = {}) =>
    requisicao<{ ok: boolean; livroId: string; versaoAplicada: number; inseridos: number; atualizados: number; mantidos: number }>(
      "/campaigns/" + cid + "/regras/acervo/" + bookId + "/aplicar",
      { method: "POST", body: JSON.stringify({ decisoes }) },
    ),
  criarElementoRegra: (cid: string, dados: ElementoRegraInput) =>
    requisicao<{ id: string }>(`/campaigns/${cid}/regras/elementos`, { method: "POST", body: JSON.stringify(dados) }),
  atualizarElementoRegra: (cid: string, elementId: string, dados: Partial<ElementoRegraInput>) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/regras/elementos/${elementId}`, { method: "PATCH", body: JSON.stringify(dados) }),
  removerElementoRegra: (cid: string, elementId: string) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/regras/elementos/${elementId}`, { method: "DELETE" }),
  duplicarElementoRegra: (cid: string, elementId: string) =>
    requisicao<{ id: string }>(`/campaigns/${cid}/regras/duplicar/${elementId}`, { method: "POST" }),
  atualizarConfigRegras: (cid: string, config: Partial<ConfigRegras>) =>
    requisicao<{ ok: boolean; config: ConfigRegras }>(`/campaigns/${cid}/regras/config`, { method: "PUT", body: JSON.stringify(config) }),
  semearBiblioteca: (cid: string) =>
    requisicao<{ ok: boolean; inseridos: number }>(`/campaigns/${cid}/regras/seed`, { method: "POST" }),
  validarFichaRegras: (cid: string, characterId: string) =>
    requisicao<ResultadoValidacaoRegras>(`/campaigns/${cid}/regras/validacao/${characterId}`),
  obterVinculaveis: (cid: string) =>
    requisicao<{ kinds: string[]; elementos: Record<string, ElementoVinculavel[]> }>(`/campaigns/${cid}/regras/vinculaveis`),
  /** Simulador da prévia do editor — mesmo pipeline da ficha real, sem gravar nada. */
  simularFicha: (cid: string, dados: { estrutura: EstruturaFicha; dados: Record<string, unknown>; pontosFicticios?: number }) =>
    requisicao<SimulacaoResultado>(`/campaigns/${cid}/regras/simulacao`, { method: "POST", body: JSON.stringify(dados) }),

  // Patrimônio (Etapa 6)
  listarInventario: (charId: string) =>
    requisicao<{ itens: ItemInventario[]; pesoTotal: number | null; pesoMaximo: number | null; pesoExcedido: boolean }>(`/characters/${charId}/inventario`),
  adicionarItem: (charId: string, dados: ItemInventarioInput) =>
    requisicao<{ id: string }>(`/characters/${charId}/inventario`, { method: "POST", body: JSON.stringify(dados) }),
  atualizarItem: (charId: string, itemId: string, dados: Partial<ItemInventarioInput>) =>
    requisicao<{ ok: boolean }>(`/characters/${charId}/inventario/${itemId}`, { method: "PATCH", body: JSON.stringify(dados) }),
  removerItem: (charId: string, itemId: string) =>
    requisicao<{ ok: boolean }>(`/characters/${charId}/inventario/${itemId}`, { method: "DELETE" }),
  transferirItem: (charId: string, itemId: string, destinoCharacterId: string, quantidade?: number) =>
    requisicao<{ ok: boolean }>(`/characters/${charId}/inventario/${itemId}/transferir`, { method: "POST", body: JSON.stringify({ destinoCharacterId, quantidade }) }),
  equiparItem: (charId: string, itemId: string, slot?: string, requestId?: string) =>
    requisicao<{ id: string; deduplicado?: boolean }>(`/characters/${charId}/inventario/${itemId}/equipar`, { method: "POST", body: JSON.stringify({ slot, requestId }) }),
  listarEquipamentos: (charId: string) =>
    requisicao<{ equipamentos: Equipamento[]; slots: string[] }>(`/characters/${charId}/equipamentos`),
  adicionarEquipamento: (charId: string, dados: { name: string; kind?: string; slot?: string; equipped?: boolean; description?: string }) =>
    requisicao<{ id: string }>(`/characters/${charId}/equipamentos`, { method: "POST", body: JSON.stringify(dados) }),
  atualizarEquipamento: (charId: string, equipId: string, dados: { name?: string; kind?: string; slot?: string; equipped?: boolean; description?: string }) =>
    requisicao<{ ok: boolean }>(`/characters/${charId}/equipamentos/${equipId}`, { method: "PATCH", body: JSON.stringify(dados) }),
  desequipar: (charId: string, equipId: string) =>
    requisicao<{ ok: boolean }>(`/characters/${charId}/equipamentos/${equipId}/desequipar`, { method: "POST" }),
  listarVeiculos: (charId: string) =>
    requisicao<{ veiculos: Veiculo[] }>(`/characters/${charId}/veiculos`),
  adicionarVeiculo: (charId: string, dados: VeiculoInput) =>
    requisicao<{ id: string }>(`/characters/${charId}/veiculos`, { method: "POST", body: JSON.stringify(dados) }),
  atualizarVeiculo: (charId: string, veiculoId: string, dados: Partial<VeiculoInput>) =>
    requisicao<{ ok: boolean }>(`/characters/${charId}/veiculos/${veiculoId}`, { method: "PATCH", body: JSON.stringify(dados) }),
  removerVeiculo: (charId: string, veiculoId: string) =>
    requisicao<{ ok: boolean }>(`/characters/${charId}/veiculos/${veiculoId}`, { method: "DELETE" }),
  obterFinanceiro: (charId: string) =>
    requisicao<Financeiro>(`/characters/${charId}/financeiro`),
  criarConta: (charId: string, dados: ContaInput) =>
    requisicao<{ id: string }>(`/characters/${charId}/financeiro/contas`, { method: "POST", body: JSON.stringify(dados) }),
  atualizarConta: (charId: string, contaId: string, dados: Partial<ContaInput>) =>
    requisicao<{ ok: boolean }>(`/characters/${charId}/financeiro/contas/${contaId}`, { method: "PATCH", body: JSON.stringify(dados) }),
  movimentar: (charId: string, dados: { accountId: string; tipo: "entrada" | "saida" | "ajuste"; valor: number; descricao?: string; requestId?: string }) =>
    requisicao<{ id: string; saldo: number }>(`/characters/${charId}/financeiro/movimentar`, { method: "POST", body: JSON.stringify(dados) }),
  transferirFinanceiro: (charId: string, dados: { origemAccountId: string; destinoAccountId: string; valor: number; descricao?: string; requestId?: string }) =>
    requisicao<{ ok: boolean; tipo: string }>(`/characters/${charId}/financeiro/transferir`, { method: "POST", body: JSON.stringify(dados) }),
  operacaoFinanceira: (charId: string, dados: { tipo: "compra" | "venda"; accountId: string; valor: number; descricao?: string; itemId?: string; item?: ItemInventarioInput; quantidade?: number; contraparte?: string; requestId?: string }) =>
    requisicao<{ ok: boolean; saldo: number }>(`/characters/${charId}/financeiro/operacao`, { method: "POST", body: JSON.stringify(dados) }),

  // Catálogo de itens (Etapa 6)
  listarCatalogo: (cid: string) =>
    requisicao<{ itens: ItemCatalogo[]; categorias: string[] }>(`/campaigns/${cid}/inventario`),
  criarItemCatalogo: (cid: string, dados: ItemCatalogoInput) =>
    requisicao<{ id: string }>(`/campaigns/${cid}/inventario`, { method: "POST", body: JSON.stringify(dados) }),
  atualizarItemCatalogo: (cid: string, templateId: string, dados: Partial<ItemCatalogoInput>) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/inventario/${templateId}`, { method: "PATCH", body: JSON.stringify(dados) }),
  removerItemCatalogo: (cid: string, templateId: string) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/inventario/${templateId}`, { method: "DELETE" }),

  // Sessões / mesa (Etapa 7)
  listarSessoes: (cid: string) =>
    requisicao<{ sessoes: Sessao[] }>(`/campaigns/${cid}/sessoes`),
  criarSessao: (cid: string, name?: string) =>
    requisicao<{ sessao: Sessao }>(`/campaigns/${cid}/sessoes`, { method: "POST", body: JSON.stringify({ name }) }),
  atualizarSessao: (cid: string, sid: string, dados: { name?: string; summary?: string; status?: "ativa" | "pausada" | "encerrada" }) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/sessoes/${sid}`, { method: "PATCH", body: JSON.stringify(dados) }),
  obterSessao: (cid: string, sid: string) =>
    requisicao<{ sessao: Sessao; turnos: TurnosState }>(`/campaigns/${cid}/sessoes/${sid}`),
  obterEstadoMesa: (cid: string, sid: string) =>
    requisicao<{ sessao: Sessao; turnos: TurnosState; agora: number }>(`/campaigns/${cid}/sessoes/${sid}/estado`),
  listarMensagens: (cid: string, sid: string, limite = 300) =>
    requisicao<{ mensagens: MensagemMesa[] }>(`/campaigns/${cid}/sessoes/${sid}/mensagens?limite=${limite}`),
  listarTestes: (cid: string, sid: string) =>
    requisicao<{ testes: TesteMesa[] }>(`/campaigns/${cid}/sessoes/${sid}/testes`),

  // ---- Etapa 8: diário, anotações, snapshots, histórico ----
  listarAnotacoes: (cid: string, tipo?: string, personagemId?: string) =>
    requisicao<{ anotacoes: Anotacao[] }>(`/campaigns/${cid}/anotacoes?tipo=${tipo ?? "diario"}${personagemId ? `&personagemId=${personagemId}` : ""}`),
  criarAnotacao: (cid: string, dados: Partial<Anotacao> & { tipo?: string; personagemId?: string }) =>
    requisicao<{ id: string }>(`/campaigns/${cid}/anotacoes`, { method: "POST", body: JSON.stringify(dados) }),
  atualizarAnotacao: (cid: string, aid: string, dados: Partial<Anotacao>) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/anotacoes/${aid}`, { method: "PATCH", body: JSON.stringify(dados) }),
  excluirAnotacao: (cid: string, aid: string) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/anotacoes/${aid}`, { method: "DELETE" }),
  anexarArquivoNota: (cid: string, aid: string, fileId: string) =>
    requisicao<{ id: string }>(`/campaigns/${cid}/anotacoes/${aid}/anexos`, { method: "POST", body: JSON.stringify({ fileId }) }),
  removerAnexoNota: (cid: string, aid: string, fileId: string) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/anotacoes/${aid}/anexos/${fileId}`, { method: "DELETE" }),
  historicoSessao: (cid: string, sid: string) =>
    requisicao<HistoricoSessao>(`/campaigns/${cid}/sessoes/${sid}/historico`),
  listarSnapshots: (cid: string) =>
    requisicao<{ snapshots: Snapshot[] }>(`/campaigns/${cid}/snapshots`),
  criarSnapshot: (cid: string, description?: string) =>
    requisicao<{ id: string }>(`/campaigns/${cid}/snapshots`, { method: "POST", body: JSON.stringify({ description }) }),
  restaurarSnapshot: (cid: string, sid: string) =>
    requisicao<{ ok: boolean; preSnapshotId: string; arquivosRecuperados?: number; arquivosAusentes?: string[] }>(`/campaigns/${cid}/snapshots/${sid}/restaurar`, { method: "POST", body: JSON.stringify({ confirmacao: "RESTAURAR" }) }),
  estadoCampanha: (cid: string) =>
    requisicao<EstadoAtualCampanha>(`/campaigns/${cid}/snapshots/estado`),
  listarRestauracoes: (cid: string) =>
    requisicao<{ restauracoes: Restauracao[] }>(`/campaigns/${cid}/snapshots/restauracoes`),
  exportarCampanha: async (cid: string): Promise<PacoteCampanha> => {
    const res = await fetch(`${API_BASE}/campaigns/${cid}/exportar`, { credentials: "same-origin" });
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError((corpo as { erro?: string }).erro ?? `HTTP ${res.status}`);
    return corpo as PacoteCampanha;
  },
  importarCampanha: (pacote: PacoteCampanha, modo: "nova" | "substituir", campaignId?: string) =>
    requisicao<{ ok: boolean; campaignId: string; modo: string; arquivosGravados?: number }>(`/campaigns/importar`, {
      method: "POST",
      body: JSON.stringify({ pacote, modo, campaignId, confirmacao: modo === "substituir" ? "SUBSTITUIR" : undefined }),
    }),

  // ---- Etapa 9: biblioteca de arquivos ----
  listarArquivos: (cid: string) =>
    requisicao<{ arquivos: ArquivoBiblioteca[]; limites: { tamanhoMaxMb: number }; config: { jogadoresEnviam: boolean; espectadorVe: boolean } }>(`/campaigns/${cid}/arquivos`),
  listarPastas: (cid: string) =>
    requisicao<{ pastas: PastaBiblioteca[] }>(`/campaigns/${cid}/arquivos/pastas`),
  criarPasta: (cid: string, dados: { name: string; parentId?: string | null }) =>
    requisicao<{ id: string }>(`/campaigns/${cid}/arquivos/pastas`, { method: "POST", body: JSON.stringify(dados) }),
  atualizarPasta: (cid: string, pid: string, dados: { name?: string; parentId?: string | null; allowPlayerUploads?: boolean }) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/arquivos/pastas/${pid}`, { method: "PATCH", body: JSON.stringify(dados) }),
  excluirPasta: (cid: string, pid: string) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/arquivos/pastas/${pid}`, { method: "DELETE" }),
  enviarArquivo: async (cid: string, arquivo: File, meta: { folderId?: string | null; displayName?: string; description?: string; category?: string; visibility?: string; recipients?: string[] }) => {
    const res = await fetch(`${API_BASE}/campaigns/${cid}/arquivos/upload`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": encodeURIComponent(arquivo.name),
        "X-File-Mime": arquivo.type || "application/octet-stream",
        ...(meta.folderId ? { "X-Folder-Id": meta.folderId } : {}),
        ...(meta.displayName ? { "X-Display-Name": encodeURIComponent(meta.displayName) } : {}),
        ...(meta.description ? { "X-Description": encodeURIComponent(meta.description) } : {}),
        ...(meta.category ? { "X-Category": encodeURIComponent(meta.category) } : {}),
        ...(meta.visibility ? { "X-Visibility": meta.visibility } : {}),
        ...(meta.recipients?.length ? { "X-Recipients": meta.recipients.join(",") } : {}),
      },
      body: arquivo,
    });
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError((corpo as { erro?: string }).erro ?? `HTTP ${res.status}`);
    return corpo as { id: string };
  },
  atualizarArquivo: (cid: string, fid: string, dados: Partial<ArquivoBiblioteca>) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/arquivos/${fid}`, { method: "PATCH", body: JSON.stringify(dados) }),
  moderarArquivo: (cid: string, fid: string, acao: "aprovar" | "rejeitar") =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/arquivos/${fid}/moderacao`, { method: "PATCH", body: JSON.stringify({ acao }) }),
  excluirArquivo: (cid: string, fid: string) =>
    requisicao<{ ok: boolean }>(`/campaigns/${cid}/arquivos/${fid}`, { method: "DELETE" }),
  urlArquivo: (cid: string, fid: string, download = false) =>
    `${API_BASE}/campaigns/${cid}/arquivos/${fid}${download ? "?download=1" : ""}`,

  // ---- Etapa 10: administração do servidor ----
  statusServidor: () => requisicao<StatusServidor>("/admin/servidor/status"),
  configServidor: () => requisicao<ConfigServidor>("/admin/servidor/config"),
  salvarConfigServidor: (dados: Partial<ConfigServidor>) =>
    requisicao<{ ok: boolean }>("/admin/servidor/config", { method: "PUT", body: JSON.stringify(dados) }),
  logsServidor: (limite = 200) => requisicao<{ logs: LogServidor[] }>(`/admin/servidor/logs?limite=${limite}`),
  listarBackupsServidor: () => requisicao<{ backups: BackupServidor[] }>("/admin/servidor/backups"),
  criarBackupServidor: (nota?: string) =>
    requisicao<{ id: string; sucesso: boolean; erros: string[] }>("/admin/servidor/backups", { method: "POST", body: JSON.stringify({ nota }) }),
  verificarBackupServidor: (id: string) =>
    requisicao<{ ok: boolean; detalhes: string[] }>(`/admin/servidor/backups/${id}/verificar`, { method: "POST", body: "{}" }),
  restaurarBackupServidor: (id: string, modo: "preparar" | "agora" = "preparar") =>
    requisicao<{ ok: boolean; seguranca?: string; mensagem?: string; proximoPasso?: string }>(`/admin/servidor/backups/${id}/restaurar`, { method: "POST", body: JSON.stringify({ confirmacao: "RESTAURAR", modo }) }),
  desligarServidor: () =>
    requisicao<{ ok: boolean; mensagem?: string }>("/admin/servidor/desligar", { method: "POST", body: "{}" }),

  // ---- Acervo global de livros de regras ----

  listarLivrosAcervo: (q?: string, tipo?: string, incluirExcluidos = false, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (tipo) params.set("tipo", tipo);
    if (incluirExcluidos) params.set("incluirExcluidos", "1");
    const qs = params.toString();
    return requisicao<{ livros: LivroAcervoResumo[]; total: number }>(`/biblioteca/livros${qs ? `?${qs}` : ""}`, { signal });
  },
  obterLivroAcervo: (id: string, signal?: AbortSignal) =>
    requisicao<{ livro: LivroAcervoResumo; itens: ItemLivroAcervo[] }>(`/biblioteca/livros/${id}`, { signal }),
  criarLivroAcervo: (dados: LivroAcervoInput) =>
    requisicao<{ livro: LivroAcervoResumo }>("/biblioteca/livros", { method: "POST", body: JSON.stringify(dados) }),
  atualizarLivroAcervo: (id: string, dados: Partial<LivroAcervoInput>) =>
    requisicao<{ livro: LivroAcervoResumo }>(`/biblioteca/livros/${id}`, { method: "PATCH", body: JSON.stringify(dados) }),
  removerLivroAcervo: (id: string, definitivo = false) =>
    requisicao<{ ok: boolean; excluido?: boolean; definitivo?: boolean }>(`/biblioteca/livros/${id}${definitivo ? "?definitivo=1" : ""}`, { method: "DELETE" }),
  restaurarLivroAcervo: (id: string) =>
    requisicao<{ livro: LivroAcervoResumo }>(`/biblioteca/livros/${id}/restaurar`, { method: "POST", body: "{}" }),
  adicionarItemLivro: (bookId: string, dados: ItemLivroInput) =>
    requisicao<{ ok: boolean; id: string }>(`/biblioteca/livros/${bookId}/itens`, { method: "POST", body: JSON.stringify(dados) }),
  atualizarItemLivro: (bookId: string, itemId: string, dados: Partial<ItemLivroInput>) =>
    requisicao<{ ok: boolean }>(`/biblioteca/livros/${bookId}/itens/${itemId}`, { method: "PATCH", body: JSON.stringify(dados) }),
  removerItemLivro: (bookId: string, itemId: string) =>
    requisicao<{ ok: boolean }>(`/biblioteca/livros/${bookId}/itens/${itemId}`, { method: "DELETE" }),
  reordenarItensLivro: (bookId: string, itens: { id: string; ordem: number }[]) =>
    requisicao<{ ok: boolean }>(`/biblioteca/livros/${bookId}/itens/ordem`, { method: "PUT", body: JSON.stringify({ itens }) }),
  previaImportacaoAcervo: (envelope: EnvelopeAcervo) =>
    requisicao<PreviaImportacaoAcervo>("/biblioteca/importar/previa", { method: "POST", body: JSON.stringify(envelope) }),
  confirmarImportacaoAcervo: (envelope: EnvelopeAcervo, decisoes: DecisaoImportacao[]) =>
    requisicao<{ ok: boolean; resultados: { indice: number; titulo: string; acao: string; bookId: string }[] }>(
      "/biblioteca/importar/confirmar",
      { method: "POST", body: JSON.stringify({ envelope, decisoes: { decisoes } }) }
    ),
  urlExportarAcervo: () => `${API_BASE}/biblioteca/exportar`,
  urlExportarLivro: (id: string) => `${API_BASE}/biblioteca/livros/${id}/exportar`,
  listarBackupsLivro: (bookId: string, signal?: AbortSignal) =>
    requisicao<{ backups: BackupLivro[] }>(`/biblioteca/livros/${bookId}/backups`, { signal }),
  obterBackupLivro: (backupId: string) =>
    requisicao<{ backup: { id: string; bookId: string; motivo: string; createdAt: string; snapshot: unknown } }>(`/biblioteca/backups/${backupId}`),
  restaurarBackupLivro: (backupId: string) =>
    requisicao<{ ok: boolean }>(`/biblioteca/backups/${backupId}/restaurar`, { method: "POST", body: "{}" }),
};

// ---- Tipos da Etapa 4: fichas e personagens ----

export type TipoCampo =
  | "texto" | "texto_longo" | "inteiro" | "decimal" | "moeda" | "data"
  | "checkbox" | "selecao_unica" | "selecao_multipla" | "selecao_nivel" | "lista" | "tabela"
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
  colunas?: { key: string; label: string; tipo: string; opcoes?: string[] }[];
  formula?: string;
  referencia?: string;
  visibilidade: string;
  destinatarios?: string[];
  editavelPor: string;
  usadoEmTestes?: boolean;
  custoPontos?: number;
  custoProgressivo?: number[];
  reservaPontos?: string;
  regra?: { kind: string; key: string };
  regraKind?: string;
  carteira?: { saldoEditavelPor: string };
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
  isNpc?: boolean;
  updatedAt: string;
}

export interface PoolPontos {
  id: string;
  nome: string;
  disponiveis: number;
  gastos: number;
  saldo: number;
  cedidos?: number;
  recebidos?: number;
}

export interface ResultadoPontos {
  habilitado: boolean;
  pools: PoolPontos[];
  detalhes: { campoId: string; label: string; poolId: string; custo: number }[];
  erros: string[];
  transferencias?: { de: string; para: string; pontos: number }[];
}

export interface FichaRenderizada {
  campos: Record<string, unknown>;
  calculados: Record<string, number | string>;
  pontos?: ResultadoPontos;
  estrutura: EstruturaFicha;
  validacao?: { ok: boolean; erros: { campoId?: string; codigo: string; mensagem: string }[]; calculos?: Record<string, number> };
  poderes?: ConfigPoderes | null;
  carteiras?: Record<string, { saldoInicial: number; entradas: number; saidas: number; saldo: number }>;
  vida?: {
    hp: { maximo: number; atual: number; historico: { em: string; tipo: string; quantidade: number; motivo: string | null; autorNome: string | null }[] } | null;
    vitalidade: { nivel: number; nome: string; penalidadeDados: number; bloqueiaAcoes: boolean; niveis: { indice: number; nome: string; penalidadeDados: number; bloqueiaAcoes: boolean }[]; alteradoEm: string | null; alteradoPor: string | null; historico: { em: string; nivelAnterior: number; nivelNovo: number; motivo: string | null; autorNome: string | null }[] } | null;
    podeEditarHp: boolean;
    podeEditarVitalidade: boolean;
  } | null;
  /** Bônus individual de pontos concedido pelo mestre (__pontos). */
  pontosBonus?: { bonus: number; selado: boolean; historico?: { em: string; quantidade: number; motivo: string; autorNome: string | null }[] };
}

/** Configuração Poderes×Defeitos da campanha (regras). */
export interface ConfigPoderes {
  limitePoderes: number | null;   // null = sem limite
  exigirDefeito: boolean;
  limiteDefeitos?: number | null;  // null/undefined = sem limite
}

// ---- Tipos da Etapa 5: motor de regras ----

export type TipoRegra =
  | "atributo" | "talento" | "habilidade" | "conhecimento" | "profissao"
  | "especializacao" | "vantagem" | "defeito" | "poder" | "disciplina"
  | "pericia" | "caracteristica" | "item" | "veiculo" | "dinheiro";

export interface DefinicaoElemento {
  descricao?: string;
  subcategoria?: string;
  custoPontos?: number;
  custoProgressivo?: number[];
  niveis?: { descricao?: string; custo?: number }[];
  minimo?: number;
  maximo?: number;
  prerequisitos?: { kind: string; key: string; minLevel?: number }[];
  dependencias?: { kind: string; key: string }[];
  grupoExclusividade?: string;
  gruposExclusividade?: string[];
  exclusivos?: string[];
  obrigatorios?: string[];
  reservaPontos?: string;
  disponivel?: boolean;
  ordem?: number;
  formulas?: Record<string, string>;
}

export interface ElementoRegra {
  id: string;
  kind: TipoRegra;
  key: string;
  name: string;
  category: string | null;
  parentKey: string | null;
  definition: DefinicaoElemento;
  createdAt: string;
  updatedAt: string;
}

export interface ElementoRegraInput {
  kind: TipoRegra;
  key: string;
  name: string;
  category?: string;
  parentKey?: string;
  definition?: DefinicaoElemento;
}

export interface ConfigRegras {
  aprovacaoAutomatica: boolean;
  pontos: {
    habilitado: boolean;
    pontosIniciais: number;
    pools: { id: string; nome: string; pontos: number }[];
    custos: Record<string, number[]>;
  };
  pontosExtras: number;
  transferivelEntreReservas: boolean;
  transferencias: { origem: string; destino: string; limite?: number }[];
  poderes?: ConfigPoderes;
  hp?: {
    habilitado: boolean;
    base: number;
    porNivel: number;
    campoId?: string;
    semantico?: string;
    edicaoPor: string;
  };
  vitalidade?: {
    niveis: { nome: string; penalidadeDados: number; bloqueiaAcoes: boolean }[];
    edicaoPor: string;
  };
  dados?: {
    d10SucessoMinimo: number;
  };
}

export interface RegrasCampanha {
  config: ConfigRegras;
  ruleSetId: string | null;
  kinds: TipoRegra[];
  elementos: ElementoRegra[];
  total: number;
}

/** Elemento da biblioteca exposto ao editor/ficha (vinculaveis). */
export interface ElementoVinculavel {
  key: string;
  name: string;
  category: string | null;
  niveis?: { descricao?: string; custo?: number }[];
  custoPontos?: number;
  maximo?: number;
}

export interface ResultadoValidacaoRegras {
  ok: boolean;
  erros: { campoId?: string; codigo: string; mensagem: string }[];
  calculos?: Record<string, number>;
  pontosHabilitados: boolean;
  totalErros: number;
}

/** Resumo de HP/Vitalidade (vida.ts) — ficha real ou simulação. */
export interface VidaResumo {
  hp: { maximo: number; atual: number; historico: { em: string; tipo: string; quantidade: number; motivo: string | null; autorNome: string | null }[] } | null;
  vitalidade: { nivel: number; nome: string; penalidadeDados: number; bloqueiaAcoes: boolean; niveis: { indice: number; nome: string; penalidadeDados: number; bloqueiaAcoes: boolean }[]; alteradoEm: string | null; alteradoPor: string | null; historico: { em: string; nivelAnterior: number; nivelNovo: number; motivo: string | null; autorNome: string | null }[] } | null;
}

/** Resposta do simulador da prévia do editor (POST /regras/simulacao). */
export interface SimulacaoResultado {
  ok: boolean;
  erros: { campoId?: string; codigo: string; mensagem: string }[];
  calculos: Record<string, number>;
  pontos: ResultadoPontos;
  pontosCfg: EstruturaFicha["pontos"];
  vida?: VidaResumo;
}

// ---- Tipos da Etapa 6: patrimônio e finanças ----

export interface ItemInventario {
  id: string;
  name: string;
  quantity: number;
  description: string | null;
  category: string | null;
  location: string | null;
  condition: string | null;
  weight: number | null;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ItemInventarioInput {
  name: string;
  quantity?: number;
  description?: string;
  category?: string;
  location?: string;
  condition?: string;
  weight?: number;
  valueCents?: number;
  transferable?: boolean;
  templateId?: string;
  data?: Record<string, unknown>;
}

export interface Equipamento {
  id: string;
  name: string;
  kind: string | null;
  slot: string | null;
  equipped: boolean;
  description: string | null;
  data: Record<string, unknown>;
}

export interface Veiculo {
  id: string;
  name: string;
  kind: string | null;
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  plate: string | null;
  serialNumber: string | null;
  condition: string | null;
  valueCents: number | null;
  fuel: string | null;
  capacity: string | null;
  ownership: string;
  data: Record<string, unknown>;
}

export interface VeiculoInput {
  name: string;
  kind?: string;
  brand?: string;
  model?: string;
  year?: number;
  color?: string;
  plate?: string;
  serialNumber?: string;
  condition?: string;
  valueCents?: number;
  fuel?: string;
  capacity?: string;
  ownership?: "propriedade" | "compartilhado";
  data?: Record<string, unknown>;
}

export interface ContaFinanceira {
  id: string;
  type: string;
  name: string;
  institution: string | null;
  agency: string | null;
  accountNumber: string | null;
  holder: string | null;
  currency: string;
  balanceCents: number;
  saldo: number;
  creditLimitCents: number | null;
  data: Record<string, unknown>;
}

export interface ContaInput {
  type: "especie" | "banco" | "cartao_debito" | "cartao_credito" | "pre_pago" | "pix" | "outro";
  name: string;
  institution?: string;
  agency?: string;
  accountNumber?: string;
  holder?: string;
  currency?: string;
  balanceReais?: number;
  creditLimitReais?: number;
  data?: Record<string, unknown>;
}

export interface TransacaoFinanceira {
  id: string;
  kind: string;
  amount: number;
  amountCents: number | null;
  currency: string;
  account: string | null;
  accountId: string | null;
  counterparty: string | null;
  counterpartyCharacterId: string | null;
  description: string | null;
  balanceBeforeCents: number | null;
  balanceAfterCents: number | null;
  createdBy: string | null;
  createdAt: string;
}

export interface Financeiro {
  config: {
    moedaPrincipal: string;
    simbolo: string;
    casasDecimais: number;
    permitirSaldoNegativo: boolean;
    jogadorPix: boolean;
    jogadorCompraVenda: boolean;
    moedas: { codigo: string; nome: string; simbolo?: string; conversaoParaPrincipal?: number }[];
    faturaCartaoCredito: boolean;
  };
  contas: ContaFinanceira[];
  historico: TransacaoFinanceira[];
}

export interface ItemCatalogo {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  data: Record<string, unknown>;
  isActive: boolean;
}

export interface ItemCatalogoInput {
  name: string;
  category?: string;
  description?: string;
  data?: Record<string, unknown>;
  isActive?: boolean;
}

// ---- Tipos da Etapa 7: mesa ----

export interface Sessao {
  id: string;
  campaignId: string;
  number: number;
  name: string | null;
  summary: string | null;
  status: string; // ativa|pausada|encerrada
  startedAt: string | null;
  endedAt: string | null;
  timerState: TimerState | null;
  createdAt: string;
}

export interface TimerState {
  status?: "rodando" | "pausado" | "parado";
  endsAt?: number;
  remainingMs?: number;
  totalMs?: number;
}

export interface TurnosState {
  ordem: string[]; // membershipIds
  atual: number;
  ativo: boolean;
}

export interface MensagemMesa {
  id: string;
  sessionId: string | null;
  authorId: string | null;
  kind: string;
  content: string;
  visibility: string;
  recipients: string[] | null;
  createdAt: string;
  autorNome?: string;
  autor?: { id: string; username: string; displayName: string | null } | null;
}

export interface TesteMesa {
  id: string;
  sessionId: string | null;
  characterId: string;
  requestedBy: string;
  skillRef: unknown;
  rotulo?: string | null;
  modifiers: { bonus?: number; malus?: number; valorCampo?: number | null; positivos?: number };
  dados?: { lados: number; count: number };
  pool?: { positivos: number; negativos: number; dadosLados: number };
  alvo?: number | null;
  privado?: boolean;
  d10?: { minimo: number; lancados: number; sucessos: number; falhas: number } | null;
  diceCount: number;
  diceSides: number;
  target: number | null;
  status: string;
  rollId: string | null;
  outcome: string | null;
  outcomeNote: string | null;
  visibility: string;
  createdAt: string;
}

export interface PersonagemDetalhe {
  personagem: {
    id: string;
    campaignId: string;
    name: string;
    status: string;
    templateVersionId: string | null;
    templateId?: string;
    donoNome?: string | null;
    isNpc?: boolean;
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
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PermissoesMembro {
  enviarMensagens?: boolean;
  verBiblioteca?: boolean;
  verHistorico?: boolean;
}

export interface CampanhaResumo extends Campanha {
  meuPapel: string;
  meuStatus: string;
  meuPermissions?: PermissoesMembro;
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

/** Prévia pública do convite (anônimo) — não inclui membership. */
export interface ConvitePreview {
  role: string;
  requiresApproval: boolean;
  status: string;
  campanha: { name: string; system: string | null };
}

// ---- Tipos da Etapa 8 ----

export interface Anotacao {
  id: string;
  campaignId: string;
  ownerId: string;
  characterId: string | null;
  kind: "diario" | "mestre";
  category: string | null;
  title: string;
  content: string;
  important: number | boolean;
  visibility: "privada" | "mestre" | "publica" | "selecionada";
  recipients: string[] | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  owner?: { username: string; displayName: string | null } | null;
  ehMinha?: boolean;
  anexos?: { id: string; fileId: string; fileName: string; displayName: string; mimeType: string | null; sizeBytes: number | null }[];
}

export interface Snapshot {
  id: string;
  kind: "manual" | "automatico" | "pre_restauracao";
  description: string | null;
  createdAt: string;
  createdBy: string;
  autor?: { username: string; displayName: string | null } | null;
}

export interface EstadoAtualCampanha {
  campanha: { id: string; name: string; status: string; updatedAt: string } | null;
  sessaoAtiva: { id: string; status: string; number: number; startedAt: string | null; endedAt: string | null } | null;
  totais: { personagens: number; mensagens: number; membrosAtivos: number };
  ultimoPonto: { id: string; kind: string; description: string | null; createdAt: string } | null;
}

export interface Restauracao {
  id: string;
  createdAt: string;
  autor: { username: string; displayName: string | null } | null;
  detalhe: { snapshotId?: string; descricao?: string; arquivosRecuperados?: number; arquivosAusentes?: number } | null;
}

export interface PacoteCampanha {
  versao: number;
  exportadoEm: string;
  campanhaId: string;
  estado: Record<string, unknown>;
  arquivos: Record<string, { conteudo: string; mimeType: string | null }>;
}

export interface HistoricoSessao {
  sessao: Sessao;
  duracaoMs: number | null;
  participantes: { id: string; username: string; displayName: string | null }[];
  eventos: { id: string; kind: string; content: string; createdAt: string; autor: { id: string; username: string; displayName: string | null } | null }[];
  testes: TesteMesa[];
  rolagens: Record<string, unknown>[];
  alteracoes?: { id: string; action: string; createdAt: string; autor: { id: string; username: string; displayName: string | null } | null; detalhe?: unknown }[];
  resumo: string | null;
}

// ---- Tipos da Etapa 9: biblioteca de arquivos ----

export interface PastaBiblioteca {
  id: string;
  campaignId: string;
  parentId: string | null;
  name: string;
  allowPlayerUploads: boolean;
  createdBy: string;
  createdAt: string;
}

export interface ArquivoBiblioteca {
  id: string;
  folderId: string | null;
  folderPath: string;
  fileName: string;
  displayName: string;
  description: string | null;
  category: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  status: "aprovado" | "pendente" | "rejeitado";
  visibility: "mestre" | "publica" | "selecionada";
  recipients: string[] | null;
  uploadedBy: string;
  uploader: { username: string; displayName: string | null } | null;
  ehMeu: boolean;
  createdAt: string;
  updatedAt: string | null;
}

// ---- Tipos da Etapa 10: administração do servidor ----
export interface StatusServidor {
  servidor: { status: string; uptimeSegundos: number; versao: string; node: string; plataforma: string };
  banco: { acessivel: boolean };
  arquivos: { diretorioOk: boolean; tamanhoBytes: number };
  disco: { livreBytes: number; totalBytes: number };
  contagens: { campanhas: number; usuarios: number; sessoesMesa: number; sessoesLoginAtivas: number };
  backup: { id: string; criadoEm: string; tamanhoBytes: number | null; sucesso: boolean | undefined } | null;
  alertas: string[];
}
export interface ConfigServidor {
  nomeInstalacao: string;
  backup: { agenda: string; hora: string; retencaoDiarios: number; retencaoSemanais: number; pasta: string };
  acesso: { dominioPublico: string; proxyHops: number; https: boolean };
  arquivos: { tamanhoMaxMb: number };
}
export interface LogServidor { ts: string; nivel: string; msg: string; detalhe?: unknown }
export interface BackupServidor { id: string; kind: string; filePath: string; sizeBytes: number | null; note: string | null; createdAt: string; sucesso?: boolean }

// ---- Acervo global de livros de regras ----

export interface LivroAcervoCampanha {
  id: string;
  titulo: string;
  descricao: string | null;
  autor: string | null;
  sistema: string | null;
  edicao: string | null;
  tipo: string;
  versao: number;
  totalItens: number;
  aplicado: boolean;
  versaoAplicada: number | null;
  aplicadoEm: string | null;
  atualizacaoDisponivel: boolean;
}

export interface LivroAcervoResumo {
  id: string;
  titulo: string;
  descricao: string | null;
  autor: string | null;
  sistema: string | null;
  edicao: string | null;
  tipo: "livro" | "suplemento" | string;
  versao: number;
  formatoVersao: number;
  origem: "manual" | "importado" | string;
  excluidoEm?: string | null;
  totalItens?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ItemLivroAcervo {
  id: string;
  bookId?: string;
  kind: string;
  key: string;
  name: string;
  category: string | null;
  parentKey: string | null;
  definition: Record<string, unknown>;
  ordem: number;
}

export interface LivroAcervoInput {
  titulo: string;
  descricao?: string | null;
  autor?: string | null;
  sistema?: string | null;
  edicao?: string | null;
  tipo?: "livro" | "suplemento";
  itens?: ItemLivroInput[];
}

export interface ItemLivroInput {
  kind: string;
  key: string;
  name: string;
  category?: string | null;
  parentKey?: string | null;
  definition?: Record<string, unknown>;
  ordem?: number;
}

export interface LivroEnvelope {
  id?: string;
  titulo: string;
  descricao?: string | null;
  autor?: string | null;
  sistema?: string | null;
  edicao?: string | null;
  tipo?: "livro" | "suplemento";
  versao?: number;
  formatoVersao?: number;
  itens: (ItemLivroInput & { id?: string })[];
}

export interface EnvelopeAcervo {
  formato: "mestre-rpg-biblioteca";
  versao: number;
  livros: LivroEnvelope[];
  exportadoEm?: string;
}

export interface PreviaLivro {
  indice: number;
  titulo: string;
  acao: "novo" | "atualizar";
  bookId: string | null;
  metadadosAlterados: { campo: string; de: unknown; para: unknown }[];
  resumo: { itensNovos: number; itensAlterados: number; itensIdenticos: number; itensAusentesPreservados: number };
  conflitos: { kind: string; key: string; name: string; campos: string[] }[];
  aviso: string;
}

export interface PreviaImportacaoAcervo {
  formato: string;
  versao: number;
  totalLivros: number;
  novos: number;
  atualizacoes: number;
  livros: PreviaLivro[];
}

export interface DecisaoImportacao {
  indice: number;
  metadados: "atualizar" | "manter";
  itens: Record<string, "atualizar" | "manter">;
}

export interface BackupLivro {
  id: string;
  motivo: string;
  createdAt: string;
  itens: number;
}
