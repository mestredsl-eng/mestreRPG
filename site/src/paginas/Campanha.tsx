import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, type CampanhaResumo, type Convite, type Membro, type PermissoesMembro } from "../api";
import { getSocket } from "../socket";
import { statusLabel } from "./Campanhas";
import { ModalConfirmar } from "../Modal";
import ModelosFicha from "./ModelosFicha";
import Personagens from "./Personagens";
import Regras from "./Regras";
import Mesa from "./Mesa";
import Diario from "./Diario";
import Historico from "./Historico";
import Arquivos from "./Arquivos";
import IconeInterface from "../IconeInterface";
import EstadoVazio from "../EstadoVazio";
import { EstadoCarregando, EstadoErro } from "../EstadoFeedback";

const STATUS_OPCOES = [
  ["preparacao", "Em preparação"],
  ["andamento", "Em andamento"],
  ["pausada", "Pausada"],
  ["concluida", "Concluída"],
  ["arquivada", "Arquivada"],
] as const;

const PAPEL_LABEL: Record<string, string> = { mestre: "Mestre", jogador: "Jogador", espectador: "Espectador" };
type Aba = "info" | "mesa" | "personagens" | "diario" | "historico" | "arquivos" | "fichas" | "regras" | "participantes" | "convites";

export default function Campanha({ id, aoVoltar }: { id: string; aoVoltar: () => void }) {
  const [campanha, setCampanha] = useState<CampanhaResumo | null>(null);
  const [membros, setMembros] = useState<Membro[]>([]);
  const [convites, setConvites] = useState<Convite[]>([]);
  const [aba, setAba] = useState<Aba>("info");
  const abaRef = useRef<Aba>("info");
  abaRef.current = aba;
  const [erro, setErro] = useState<string | null>(null);
  // Erro de leitura (carregar) é separado de erro de ação (PATCH/POST):
  // o retry de uma ação rejeitada reenvia a MESMA mutação com os dados
  // atuais — nunca um GET que sobrescreveria o rascunho local.
  const [erroAcao, setErroAcao] = useState<{ texto: string; retry?: () => void } | null>(null);
  // Issue #239 — membros/convites carregam junto da campanha; gate
  // evita o "EstadoVazio" de convites piscar antes do GET resolver.
  const [extrasCarregados, setExtrasCarregados] = useState(false);
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", system: "", status: "preparacao" });
  const [conviteCriado, setConviteCriado] = useState<{ code: string } | null>(null);
  const [conviteForm, setConviteForm] = useState({ role: "jogador", maxUses: "", expiresInHours: "", requiresApproval: false });
  const [confirmando, setConfirmando] = useState<{ m: Membro; acao: "remover" | "transferir" } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  // Refs espelham os formulários para que o retry de uma ação rejeitada
  // envie o rascunho MAIS RECENTE (o closure do erro pode ser antigo).
  const formRef = useRef(form);
  formRef.current = form;
  const conviteFormRef = useRef(conviteForm);
  conviteFormRef.current = conviteForm;
  // Edição em andamento não pode ser sobrescrita por recargas
  // (socket, retry de leitura, aoAtualizar): o GET traz o estado do
  // servidor, não o rascunho local. Ref para o carregar() enxergar o
  // valor mais recente sem recriar o callback.
  const editandoRef = useRef(editando);
  editandoRef.current = editando;

  const souMestre = campanha?.meuPapel === "mestre";
  // Personagens exige mestre/jogador no backend (GET /characters → 403
  // para espectador): a aba e a página só existem para quem pode ler.
  const vePersonagens = campanha?.meuPapel !== "espectador";

  // A permissão pode mudar em tempo real enquanto a pessoa está numa aba
  // que acabou de deixar de existir. Recoloca a seleção numa aba pública
  // para manter uma tab selecionada, com painel visível e foco alcançável.
  useEffect(() => {
    const abaExclusivaMestre =
      aba === "fichas" || aba === "regras" || aba === "participantes" || aba === "convites";
    if ((!souMestre && abaExclusivaMestre) || (!vePersonagens && aba === "personagens")) {
      setAba("info");
    }
  }, [aba, souMestre, vePersonagens]);

  const carregar = useCallback(async () => {
    try {
      const { campanha } = await api.obterCampanha(id);
      setCampanha(campanha);
      // Não sobrescreve o rascunho enquanto o formulário está em edição:
      // PATCH rejeitado + retry reenviam o estado local; um GET disparado
      // por socket/refresh apagaria campos não salvos.
      if (!editandoRef.current) {
        setForm({
          name: campanha.name,
          description: campanha.description ?? "",
          system: campanha.system ?? "",
          status: campanha.status,
        });
      }
      if (campanha.meuPapel === "mestre") {
        const [{ membros }, { convites }] = await Promise.all([api.listarMembros(id), api.listarConvites(id)]);
        setMembros(membros);
        setConvites(convites);
      } else {
        const { membros } = await api.listarMembros(id);
        setMembros(membros);
      }
      setExtrasCarregados(true);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar campanha");
    }
  }, [id]);

  useEffect(() => {
    void carregar();
    // Sincronização em tempo real: entra na room da campanha e recarrega em mudanças.
    // A sala pertence à conexão do socket — após uma reconexão é preciso entrar
    // de novo, senão os eventos desta campanha deixam de chegar. Na aba Mesa
    // a MesaView já reingressa nas rooms campanha:*/sessao:* a cada connect —
    // emitir aqui seria tráfego duplicado.
    const socket = getSocket();
    const entrar = () => {
      if (abaRef.current !== "mesa") socket.emit("entrar-campanha", id);
    };
    socket.emit("entrar-campanha", id);
    socket.on("connect", entrar);
    const aoMudar = () => void carregar();
    socket.on("membros:atualizados", aoMudar);
    socket.on("campanha:atualizada", aoMudar);
    return () => {
      socket.off("connect", entrar);
      socket.off("membros:atualizados", aoMudar);
      socket.off("campanha:atualizada", aoMudar);
      socket.emit("sair-campanha", id);
    };
  }, [id, carregar]);

  // Se a reconexão aconteceu na aba Mesa sem sessão aberta (MesaView não
  // montada → ninguém reingressou na room), a entrada acontece ao abrir
  // qualquer outra aba — as páginas já recarregam no mount de qualquer
  // forma, então nenhuma atualização se perde.
  const primeiraAba = useRef(true);
  useEffect(() => {
    if (primeiraAba.current) { primeiraAba.current = false; return; }
    if (aba !== "mesa") getSocket().emit("entrar-campanha", id);
  }, [aba, id]);

  const salvarDados = async () => {
    const f = formRef.current;
    try {
      await api.atualizarCampanha(id, {
        name: f.name,
        description: f.description,
        system: f.system,
        status: f.status,
      });
      setErroAcao(null);
      setEditando(false);
      editandoRef.current = false;
      await carregar();
    } catch (err) {
      // PATCH rejeitado: form/rascunho permanecem intactos; o retry
      // reenvia a mutação com o estado atual, não um reload.
      setErroAcao({
        texto: err instanceof Error ? err.message : "Erro ao salvar",
        retry: () => void salvarDados(),
      });
    }
  };

  const salvarEdicao = (e: FormEvent) => {
    e.preventDefault();
    void salvarDados();
  };

  const mudarMembro = async (m: Membro, dados: { role?: string; status?: string; permissions?: PermissoesMembro }) => {
    try {
      await api.atualizarMembro(id, m.membershipId, dados);
      setErroAcao(null);
      await carregar();
    } catch (err) {
      setErroAcao({
        texto: err instanceof Error ? err.message : "Erro ao atualizar participante",
        retry: () => void mudarMembro(m, dados),
      });
    }
  };

  const confirmarAcao = async () => {
    if (!confirmando || ocupado) return;
    const { m, acao } = confirmando;
    setOcupado(true);
    try {
      if (acao === "remover") await api.removerMembro(id, m.membershipId);
      else await api.transferirTitularidade(id, m.membershipId);
      setConfirmando(null);
      setErroAcao(null);
      await carregar();
    } catch (err) {
      setErroAcao({
        texto: err instanceof Error ? err.message : acao === "remover" ? "Erro ao remover participante" : "Erro ao transferir titularidade",
        retry: () => void confirmarAcao(),
      });
    } finally {
      setOcupado(false);
    }
  };

  const enviarConvite = async () => {
    const f = conviteFormRef.current;
    try {
      const { convite } = await api.criarConvite(id, {
        role: f.role,
        maxUses: f.maxUses ? Number(f.maxUses) : undefined,
        expiresInHours: f.expiresInHours ? Number(f.expiresInHours) : undefined,
        requiresApproval: f.requiresApproval,
      });
      setConviteCriado({ code: convite.code });
      setErroAcao(null);
      await carregar();
    } catch (err) {
      setErroAcao({
        texto: err instanceof Error ? err.message : "Erro ao criar convite",
        retry: () => void enviarConvite(),
      });
    }
  };

  const criarConvite = (e: FormEvent) => {
    e.preventDefault();
    void enviarConvite();
  };

  const navegarAbas = (event: KeyboardEvent<HTMLButtonElement>) => {
    const lista = event.currentTarget.closest('[role="tablist"]');
    if (!lista) return;
    const tabs = Array.from(lista.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const atual = tabs.indexOf(event.currentTarget);
    if (atual < 0 || tabs.length === 0) return;

    let proximo = atual;
    if (event.key === "ArrowRight") proximo = (atual + 1) % tabs.length;
    else if (event.key === "ArrowLeft") proximo = (atual - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") proximo = 0;
    else if (event.key === "End") proximo = tabs.length - 1;
    else return;

    event.preventDefault();
    const destino = tabs[proximo];
    destino.focus();
    destino.click();
  };

  if (!campanha) {
    return <section className="cartao"><p>{erro ?? "Carregando…"}</p><button className="secundario" onClick={aoVoltar}>Voltar</button></section>;
  }

  const pendentes = membros.filter((m) => m.status === "pendente");

  return (
    <>
      <section className="cartao">
        <div className="linha-entre">
          <div>
            <h2>{campanha.name}</h2>
            <p className="meta">
              {campanha.system ? `Sistema: ${campanha.system} · ` : ""}
              {statusLabel(campanha.status)} · Você é {PAPEL_LABEL[campanha.meuPapel] ?? campanha.meuPapel}
            </p>
          </div>
          <button className="secundario" onClick={aoVoltar}>Voltar</button>
        </div>
        {campanha.description && <p>{campanha.description}</p>}

        <div className="abas" role="tablist" aria-label="Seções da campanha" aria-orientation="horizontal">
          {/* Issue #233 — ícones complementam os rótulos (que permanecem
              como accessible name); nunca substituem o texto. */}
          <button id="campanha-tab-info" aria-controls="campanha-panel-info" tabIndex={aba === "info" ? 0 : -1} onKeyDown={navegarAbas} type="button" role="tab" aria-selected={aba === "info"} className={aba === "info" ? "ativo" : "secundario"} onClick={() => setAba("info")}><IconeInterface nome="informacoes" />Informações</button>
          <button id="campanha-tab-mesa" aria-controls="campanha-panel-mesa" tabIndex={aba === "mesa" ? 0 : -1} onKeyDown={navegarAbas} type="button" role="tab" aria-selected={aba === "mesa"} className={aba === "mesa" ? "ativo" : "secundario"} onClick={() => setAba("mesa")}><IconeInterface nome="mesa" />Mesa</button>
          {vePersonagens && <button id="campanha-tab-personagens" aria-controls="campanha-panel-personagens" tabIndex={aba === "personagens" ? 0 : -1} onKeyDown={navegarAbas} type="button" role="tab" aria-selected={aba === "personagens"} className={aba === "personagens" ? "ativo" : "secundario"} onClick={() => setAba("personagens")}><IconeInterface nome="personagens" />Personagens</button>}
          <button id="campanha-tab-diario" aria-controls="campanha-panel-diario" tabIndex={aba === "diario" ? 0 : -1} onKeyDown={navegarAbas} type="button" role="tab" aria-selected={aba === "diario"} className={aba === "diario" ? "ativo" : "secundario"} onClick={() => setAba("diario")}><IconeInterface nome="diario" />Diário</button>
          <button id="campanha-tab-historico" aria-controls="campanha-panel-historico" tabIndex={aba === "historico" ? 0 : -1} onKeyDown={navegarAbas} type="button" role="tab" aria-selected={aba === "historico"} className={aba === "historico" ? "ativo" : "secundario"} onClick={() => setAba("historico")}><IconeInterface nome="historico" />Histórico</button>
          <button id="campanha-tab-arquivos" aria-controls="campanha-panel-arquivos" tabIndex={aba === "arquivos" ? 0 : -1} onKeyDown={navegarAbas} type="button" role="tab" aria-selected={aba === "arquivos"} className={aba === "arquivos" ? "ativo" : "secundario"} onClick={() => setAba("arquivos")}><IconeInterface nome="arquivos" />Arquivos</button>
          {souMestre && (
            <>
              <button id="campanha-tab-fichas" aria-controls="campanha-panel-fichas" tabIndex={aba === "fichas" ? 0 : -1} onKeyDown={navegarAbas} type="button" role="tab" aria-selected={aba === "fichas"} className={aba === "fichas" ? "ativo" : "secundario"} onClick={() => setAba("fichas")}><IconeInterface nome="fichas" />Fichas</button>
              <button id="campanha-tab-regras" aria-controls="campanha-panel-regras" tabIndex={aba === "regras" ? 0 : -1} onKeyDown={navegarAbas} type="button" role="tab" aria-selected={aba === "regras"} className={aba === "regras" ? "ativo" : "secundario"} onClick={() => setAba("regras")}><IconeInterface nome="regras" />Regras</button>
              <button id="campanha-tab-participantes" aria-controls="campanha-panel-participantes" tabIndex={aba === "participantes" ? 0 : -1} onKeyDown={navegarAbas} type="button" role="tab" aria-selected={aba === "participantes"} className={aba === "participantes" ? "ativo" : "secundario"} onClick={() => setAba("participantes")}><IconeInterface nome="participantes" />Participantes ({membros.length})</button>
              <button id="campanha-tab-convites" aria-controls="campanha-panel-convites" tabIndex={aba === "convites" ? 0 : -1} onKeyDown={navegarAbas} type="button" role="tab" aria-selected={aba === "convites"} className={aba === "convites" ? "ativo" : "secundario"} onClick={() => setAba("convites")}><IconeInterface nome="convites" />Convites ({convites.length})</button>
            </>
          )}
        </div>
      </section>

      <div id="campanha-panel-mesa" role="tabpanel" aria-labelledby="campanha-tab-mesa" tabIndex={0} hidden={aba !== "mesa"}>
        {aba === "mesa" && <Mesa campaignId={id} campanha={campanha} />}
      </div>
      {vePersonagens && (
        <div id="campanha-panel-personagens" role="tabpanel" aria-labelledby="campanha-tab-personagens" tabIndex={0} hidden={aba !== "personagens"}>
          {aba === "personagens" && <Personagens campaignId={id} campanha={campanha} />}
        </div>
      )}
      <div id="campanha-panel-diario" role="tabpanel" aria-labelledby="campanha-tab-diario" tabIndex={0} hidden={aba !== "diario"}>
        {aba === "diario" && <Diario campaignId={id} campanha={campanha} />}
      </div>
      <div id="campanha-panel-historico" role="tabpanel" aria-labelledby="campanha-tab-historico" tabIndex={0} hidden={aba !== "historico"}>
        {aba === "historico" && <Historico campaignId={id} campanha={campanha} aoAtualizar={() => void carregar()} />}
      </div>
      <div id="campanha-panel-arquivos" role="tabpanel" aria-labelledby="campanha-tab-arquivos" tabIndex={0} hidden={aba !== "arquivos"}>
        {aba === "arquivos" && <Arquivos campaignId={id} campanha={campanha} />}
      </div>
      {souMestre && (
        <div id="campanha-panel-fichas" role="tabpanel" aria-labelledby="campanha-tab-fichas" tabIndex={0} hidden={aba !== "fichas"}>
          {aba === "fichas" && <ModelosFicha campaignId={id} />}
        </div>
      )}
      {souMestre && (
        <div id="campanha-panel-regras" role="tabpanel" aria-labelledby="campanha-tab-regras" tabIndex={0} hidden={aba !== "regras"}>
          {aba === "regras" && <Regras campaignId={id} />}
        </div>
      )}

      {erro && <EstadoErro aoTentarNovamente={() => void carregar()}>{erro}</EstadoErro>}
      {erroAcao && <EstadoErro aoTentarNovamente={erroAcao.retry}>{erroAcao.texto}</EstadoErro>}

      <div id="campanha-panel-info" role="tabpanel" aria-labelledby="campanha-tab-info" tabIndex={0} hidden={aba !== "info"}>
      {aba === "info" && (
        <section className="cartao">
          {!editando ? (
            <>
              <p><strong>Sistema:</strong> {campanha.system ?? "—"}</p>
              <p><strong>Status:</strong> {statusLabel(campanha.status)}</p>
              <p><strong>Descrição:</strong> {campanha.description ?? "—"}</p>
              {souMestre && <button onClick={() => setEditando(true)}>Editar campanha</button>}
            </>
          ) : (
            <form className="formulario" onSubmit={salvarEdicao}>
              <label>Nome<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} maxLength={120} /></label>
              <label>Sistema de RPG<input value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })} /></label>
              <label>Status
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  {STATUS_OPCOES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label>Descrição<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} maxLength={4000} /></label>
              <div className="linha">
                <button type="submit">Salvar</button>
                <button type="button" className="secundario" onClick={() => setEditando(false)}>Cancelar</button>
              </div>
            </form>
          )}
        </section>
      )}

      </div>

      {souMestre && (
        <div id="campanha-panel-participantes" role="tabpanel" aria-labelledby="campanha-tab-participantes" tabIndex={0} hidden={aba !== "participantes"}>
      {aba === "participantes" && souMestre && (
        <section className="cartao">
          <h2>Participantes</h2>
          {pendentes.length > 0 && (
            <>
              <h3>Aguardando aprovação ({pendentes.length})</h3>
              <table className="tabela">
                <tbody>
                  {pendentes.map((m) => (
                    <tr key={m.membershipId}>
                      <td>{m.displayName ?? m.username} <span className="meta">({m.username})</span></td>
                      <td>{PAPEL_LABEL[m.role] ?? m.role}</td>
                      <td className="acoes">
                        <button className="mini" onClick={() => void mudarMembro(m, { status: "ativo" })}>Aprovar</button>
                        <button className="mini perigo" onClick={() => void mudarMembro(m, { status: "removido" })}>Recusar</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <table className="tabela tabela-responsiva">
            <thead>
              <tr><th>Nome</th><th>Usuário</th><th>Papel</th><th>Status</th><th>Entrada</th><th>Permissões</th><th>Ações</th></tr>
            </thead>
            <tbody>
              {membros.filter((m) => m.status !== "removido").map((m) => (
                <tr key={m.membershipId} className={m.status === "bloqueado" ? "linha-bloqueada" : ""}>
                  <td>{m.displayName ?? "—"}</td>
                  <td>{m.username}</td>
                  <td>
                    <select
                      aria-label={`Papel de ${m.username}`}
                      value={m.role}
                      disabled={m.ehEu && m.role === "mestre" && membros.filter((x) => x.role === "mestre" && x.status === "ativo").length <= 1}
                      onChange={(e) => void mudarMembro(m, { role: e.target.value })}
                    >
                      <option value="mestre">Mestre</option>
                      <option value="jogador">Jogador</option>
                      <option value="espectador">Espectador</option>
                    </select>
                  </td>
                  <td>
                    <select aria-label={`Status de ${m.username}`} value={m.status} onChange={(e) => void mudarMembro(m, { status: e.target.value })}>
                      <option value="ativo">Ativo</option>
                      <option value="bloqueado">Bloqueado</option>
                      <option value="pendente">Pendente</option>
                    </select>
                  </td>
                  <td>{m.joinedAt ? new Date(m.joinedAt).toLocaleDateString("pt-BR") : "—"}</td>
                  <td>
                    {m.role === "espectador" && m.status === "ativo" ? (
                      <div className="permissoes-membro">
                        {([
                          ["enviarMensagens", "chat"],
                          ["verBiblioteca", "arquivos"],
                          ["verHistorico", "histórico"],
                        ] as [keyof PermissoesMembro, string][]).map(([key, rotulo]) => {
                          const perms = (m.permissions ?? {}) as PermissoesMembro;
                          const padrao = key === "enviarMensagens" ? false : true;
                          const ativo = perms[key] ?? padrao;
                          return (
                            <label key={key} className="check" title={`Permitir ${rotulo}`}>
                              <input
                                type="checkbox"
                                checked={!!ativo}
                                onChange={(e) => void mudarMembro(m, { permissions: { [key]: e.target.checked } })}
                              />
                              {rotulo}
                            </label>
                          );
                        })}
                      </div>
                    ) : "—"}
                  </td>
                  <td className="acoes">
                    {m.role === "mestre" && m.status === "ativo" && !m.ehEu && (
                      <button className="mini" onClick={() => setConfirmando({ m, acao: "transferir" })}>Transferir</button>
                    )}
                    {!m.ehEu && (
                      <button className="mini perigo" onClick={() => setConfirmando({ m, acao: "remover" })}>Remover</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cartoes-registro">
            {membros.filter((m) => m.status !== "removido").map((m) => (
              <div key={m.membershipId} className={`registro-cartao ${m.status === "bloqueado" ? "linha-bloqueada" : ""}`}>
                <div className="registro-campo"><span className="registro-rotulo">Nome</span><strong>{m.displayName ?? "—"}</strong></div>
                <div className="registro-campo"><span className="registro-rotulo">Usuário</span><span>{m.username}</span></div>
                <div className="registro-campo">
                  <span className="registro-rotulo">Papel</span>
                  <select
                    aria-label={`Papel de ${m.username}`}
                    value={m.role}
                    disabled={m.ehEu && m.role === "mestre" && membros.filter((x) => x.role === "mestre" && x.status === "ativo").length <= 1}
                    onChange={(e) => void mudarMembro(m, { role: e.target.value })}
                  >
                    <option value="mestre">Mestre</option>
                    <option value="jogador">Jogador</option>
                    <option value="espectador">Espectador</option>
                  </select>
                </div>
                <div className="registro-campo">
                  <span className="registro-rotulo">Status</span>
                  <select aria-label={`Status de ${m.username}`} value={m.status} onChange={(e) => void mudarMembro(m, { status: e.target.value })}>
                    <option value="ativo">Ativo</option>
                    <option value="bloqueado">Bloqueado</option>
                    <option value="pendente">Pendente</option>
                  </select>
                </div>
                <div className="registro-campo"><span className="registro-rotulo">Entrada</span><span>{m.joinedAt ? new Date(m.joinedAt).toLocaleDateString("pt-BR") : "—"}</span></div>
                {m.role === "espectador" && m.status === "ativo" && (
                  <div className="registro-campo">
                    <span className="registro-rotulo">Permissões</span>
                    <div className="permissoes-membro">
                      {([
                        ["enviarMensagens", "chat"],
                        ["verBiblioteca", "arquivos"],
                        ["verHistorico", "histórico"],
                      ] as [keyof PermissoesMembro, string][]).map(([key, rotulo]) => {
                        const perms = (m.permissions ?? {}) as PermissoesMembro;
                        const padrao = key === "enviarMensagens" ? false : true;
                        const ativo = perms[key] ?? padrao;
                        return (
                          <label key={key} className="check" title={`Permitir ${rotulo}`}>
                            <input
                              type="checkbox"
                              checked={!!ativo}
                              onChange={(e) => void mudarMembro(m, { permissions: { [key]: e.target.checked } })}
                            />
                            {rotulo}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="registro-acoes">
                  {m.role === "mestre" && m.status === "ativo" && !m.ehEu && (
                    <button className="mini" onClick={() => setConfirmando({ m, acao: "transferir" })}>Transferir</button>
                  )}
                  {!m.ehEu && (
                    <button className="mini perigo" onClick={() => setConfirmando({ m, acao: "remover" })}>Remover</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

        </div>
      )}

      {souMestre && (
        <div id="campanha-panel-convites" role="tabpanel" aria-labelledby="campanha-tab-convites" tabIndex={0} hidden={aba !== "convites"}>
      {aba === "convites" && souMestre && (
        <section className="cartao">
          <h2>Convites</h2>

          {conviteCriado && (
            <div className="convite-criado">
              <p><strong>Código:</strong> <code>{conviteCriado.code}</code></p>
              <p><strong>Link:</strong> <code>{`${window.location.origin}/convite?code=${conviteCriado.code}`}</code></p>
              <p className="meta">Copie agora — por segurança, o código não poderá ser exibido novamente.</p>
              <button className="secundario" onClick={() => setConviteCriado(null)}>Fechar</button>
            </div>
          )}

          <form className="formulario" onSubmit={criarConvite}>
            <div className="grade-2">
              <label>Papel inicial
                <select aria-label="Papel do convite" value={conviteForm.role} onChange={(e) => setConviteForm({ ...conviteForm, role: e.target.value })}>
                  <option value="jogador">Jogador</option>
                  <option value="espectador">Espectador</option>
                </select>
              </label>
              <label>Máx. de usos<input type="number" min="1" placeholder="Ilimitado" value={conviteForm.maxUses} onChange={(e) => setConviteForm({ ...conviteForm, maxUses: e.target.value })} /></label>
              <label>Expira em (horas)<input type="number" min="1" placeholder="Nunca" value={conviteForm.expiresInHours} onChange={(e) => setConviteForm({ ...conviteForm, expiresInHours: e.target.value })} /></label>
              <label className="checkbox">
                <input type="checkbox" checked={conviteForm.requiresApproval} onChange={(e) => setConviteForm({ ...conviteForm, requiresApproval: e.target.checked })} />
                Exigir aprovação do mestre
              </label>
            </div>
            <button type="submit">Gerar convite</button>
          </form>

          {!extrasCarregados ? (
            <EstadoCarregando>Carregando convites…</EstadoCarregando>
          ) : convites.length === 0 ? (
            <EstadoVazio icone="vazio-lista">Nenhum convite gerado ainda.</EstadoVazio>
          ) : null}

          <table className="tabela tabela-responsiva">
            <thead>
              <tr><th>Criado em</th><th>Papel</th><th>Usos</th><th>Expira</th><th>Aprovação</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {convites.map((c) => (
                <tr key={c.id}>
                  <td>{new Date(c.createdAt).toLocaleString("pt-BR")}</td>
                  <td>{PAPEL_LABEL[c.role] ?? c.role}</td>
                  <td>{c.uses}{c.maxUses !== null ? `/${c.maxUses}` : ""}</td>
                  <td>{c.expiresAt ? new Date(c.expiresAt).toLocaleString("pt-BR") : "Nunca"}</td>
                  <td>{c.requiresApproval ? "Sim" : "Não"}</td>
                  <td>{c.status}</td>
                  <td>
                    {c.status === "ativo" && (
                      <button className="mini perigo" onClick={async () => { await api.revogarConvite(id, c.id); await carregar(); }}>Revogar</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cartoes-registro">
            {convites.map((c) => (
              <div key={c.id} className="registro-cartao">
                <div className="registro-campo"><span className="registro-rotulo">Criado em</span><span>{new Date(c.createdAt).toLocaleString("pt-BR")}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Papel</span><span>{PAPEL_LABEL[c.role] ?? c.role}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Usos</span><span>{c.uses}{c.maxUses !== null ? `/${c.maxUses}` : ""}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Expira</span><span>{c.expiresAt ? new Date(c.expiresAt).toLocaleString("pt-BR") : "Nunca"}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Aprovação</span><span>{c.requiresApproval ? "Sim" : "Não"}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Status</span><span>{c.status}</span></div>
                {c.status === "ativo" && (
                  <div className="registro-acoes">
                    <button className="mini perigo" onClick={async () => { await api.revogarConvite(id, c.id); await carregar(); }}>Revogar</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

        </div>
      )}

      {confirmando && (
        <ModalConfirmar
          titulo={confirmando.acao === "remover" ? "Remover participante" : "Transferir titularidade"}
          mensagem={confirmando.acao === "remover"
            ? `Remover ${confirmando.m.displayName ?? confirmando.m.username} da campanha?`
            : `Transferir a titularidade da campanha para ${confirmando.m.displayName ?? confirmando.m.username}?`}
          rotuloConfirmar={confirmando.acao === "remover" ? "Remover" : "Transferir"}
          perigo={confirmando.acao === "remover"}
          ocupado={ocupado}
          aoConfirmar={() => void confirmarAcao()}
          aoCancelar={() => { if (!ocupado) setConfirmando(null); }}
        />
      )}
    </>
  );
}