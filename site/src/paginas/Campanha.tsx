import { useCallback, useEffect, useState, type FormEvent } from "react";
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
  const [erro, setErro] = useState<string | null>(null);
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", system: "", status: "preparacao" });
  const [conviteCriado, setConviteCriado] = useState<{ code: string } | null>(null);
  const [conviteForm, setConviteForm] = useState({ role: "jogador", maxUses: "", expiresInHours: "", requiresApproval: false });
  const [confirmando, setConfirmando] = useState<{ m: Membro; acao: "remover" | "transferir" } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const souMestre = campanha?.meuPapel === "mestre";

  const carregar = useCallback(async () => {
    try {
      const { campanha } = await api.obterCampanha(id);
      setCampanha(campanha);
      setForm({
        name: campanha.name,
        description: campanha.description ?? "",
        system: campanha.system ?? "",
        status: campanha.status,
      });
      if (campanha.meuPapel === "mestre") {
        const [{ membros }, { convites }] = await Promise.all([api.listarMembros(id), api.listarConvites(id)]);
        setMembros(membros);
        setConvites(convites);
      } else {
        const { membros } = await api.listarMembros(id);
        setMembros(membros);
      }
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar campanha");
    }
  }, [id]);

  useEffect(() => {
    void carregar();
    // Sincronização em tempo real: entra na room da campanha e recarrega em mudanças
    const socket = getSocket();
    socket.emit("entrar-campanha", id, () => undefined);
    const aoMudar = () => void carregar();
    socket.on("membros:atualizados", aoMudar);
    socket.on("campanha:atualizada", aoMudar);
    return () => {
      socket.off("membros:atualizados", aoMudar);
      socket.off("campanha:atualizada", aoMudar);
      socket.emit("sair-campanha", id);
    };
  }, [id, carregar]);

  const salvarEdicao = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.atualizarCampanha(id, {
        name: form.name,
        description: form.description,
        system: form.system,
        status: form.status,
      });
      setEditando(false);
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao salvar");
    }
  };

  const mudarMembro = async (m: Membro, dados: { role?: string; status?: string; permissions?: PermissoesMembro }) => {
    try {
      await api.atualizarMembro(id, m.membershipId, dados);
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao atualizar participante");
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
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : acao === "remover" ? "Erro ao remover participante" : "Erro ao transferir titularidade");
    } finally {
      setOcupado(false);
    }
  };

  const criarConvite = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { convite } = await api.criarConvite(id, {
        role: conviteForm.role,
        maxUses: conviteForm.maxUses ? Number(conviteForm.maxUses) : undefined,
        expiresInHours: conviteForm.expiresInHours ? Number(conviteForm.expiresInHours) : undefined,
        requiresApproval: conviteForm.requiresApproval,
      });
      setConviteCriado({ code: convite.code });
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao criar convite");
    }
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

        <div className="abas">
          <button className={aba === "info" ? "ativo" : "secundario"} onClick={() => setAba("info")}>Informações</button>
          <button className={aba === "mesa" ? "ativo" : "secundario"} onClick={() => setAba("mesa")}>Mesa</button>
          <button className={aba === "personagens" ? "ativo" : "secundario"} onClick={() => setAba("personagens")}>Personagens</button>
          <button className={aba === "diario" ? "ativo" : "secundario"} onClick={() => setAba("diario")}>Diário</button>
          <button className={aba === "historico" ? "ativo" : "secundario"} onClick={() => setAba("historico")}>Histórico</button>
          <button className={aba === "arquivos" ? "ativo" : "secundario"} onClick={() => setAba("arquivos")}>Arquivos</button>
          {souMestre && (
            <>
              <button className={aba === "fichas" ? "ativo" : "secundario"} onClick={() => setAba("fichas")}>Fichas</button>
              <button className={aba === "regras" ? "ativo" : "secundario"} onClick={() => setAba("regras")}>Regras</button>
              <button className={aba === "participantes" ? "ativo" : "secundario"} onClick={() => setAba("participantes")}>Participantes ({membros.length})</button>
              <button className={aba === "convites" ? "ativo" : "secundario"} onClick={() => setAba("convites")}>Convites ({convites.length})</button>
            </>
          )}
        </div>
      </section>

      {aba === "mesa" && <Mesa campaignId={id} campanha={campanha} />}
      {aba === "personagens" && <Personagens campaignId={id} campanha={campanha} />}
      {aba === "diario" && <Diario campaignId={id} campanha={campanha} />}
      {aba === "historico" && <Historico campaignId={id} campanha={campanha} aoAtualizar={() => void carregar()} />}
      {aba === "arquivos" && <Arquivos campaignId={id} campanha={campanha} />}
      {aba === "fichas" && souMestre && <ModelosFicha campaignId={id} />}
      {aba === "regras" && souMestre && <Regras campaignId={id} />}

      {erro && <p className="erro">{erro}</p>}

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
              <label>Nome<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} /></label>
              <label>Sistema de RPG<input value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })} /></label>
              <label>Status
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  {STATUS_OPCOES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label>Descrição<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} /></label>
              <div className="linha">
                <button type="submit">Salvar</button>
                <button type="button" className="secundario" onClick={() => setEditando(false)}>Cancelar</button>
              </div>
            </form>
          )}
        </section>
      )}

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
                    <select value={m.status} onChange={(e) => void mudarMembro(m, { status: e.target.value })}>
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
                  <select value={m.status} onChange={(e) => void mudarMembro(m, { status: e.target.value })}>
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
                <select value={conviteForm.role} onChange={(e) => setConviteForm({ ...conviteForm, role: e.target.value })}>
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
