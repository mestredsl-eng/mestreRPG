import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, type CampanhaResumo, type Convite, type Membro, type PermissoesMembro } from "../api";
import { getSocket } from "../socket";
import { IndicadorConexao } from "../ConexaoSocket";
import { useSincronizacaoCampanha, registrarSyncOk } from "../useSincronizacao";
import { statusLabel } from "./Campanhas";
import { ModalConfirmar } from "../Modal";
import ModelosFicha from "./ModelosFicha";
import Personagens from "./Personagens";
import Regras from "./Regras";
import Mesa from "./Mesa";
import Diario from "./Diario";
import Historico from "./Historico";
import Arquivos from "./Arquivos";
import IconeInterface, { type NomeIconeInterface } from "../IconeInterface";
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

// Abas servidas pelo GET do shell (campanha+membros+convites). A aba Mesa
// tem ciclo próprio e não recebe marca do shell.
const TELAS_SHELL: readonly string[] = ["info", "participantes", "convites"];

export default function Campanha({ id, aoVoltar }: { id: string; aoVoltar: () => void }) {
  const [campanha, setCampanha] = useState<CampanhaResumo | null>(null);
  const [membros, setMembros] = useState<Membro[]>([]);
  const [convites, setConvites] = useState<Convite[]>([]);
  const [aba, setAba] = useState<Aba>("info");
  const abaRef = useRef<Aba>("info");
  abaRef.current = aba;
  const [erro, setErro] = useState<string | null>(null);
  // Issue #239 — membros/convites carregam junto da campanha; gate
  // evita o "EstadoVazio" de convites piscar antes do GET resolver.
  const [extrasCarregados, setExtrasCarregados] = useState(false);
  // P3 #132: se listarMembros/listarConvites falha depois de a campanha
  // carregar, a aba Convites não pode ficar em "Carregando…" eterno —
  // marca erro próprio com retry (o erro global já aparece via EstadoErro).
  const [extrasErro, setExtrasErro] = useState(false);
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", system: "", status: "preparacao" });
  const [conviteCriado, setConviteCriado] = useState<{ code: string } | null>(null);
  const [conviteForm, setConviteForm] = useState({ role: "jogador", maxUses: "", expiresInHours: "", requiresApproval: false });
  const [confirmando, setConfirmando] = useState<{ m: Membro; acao: "remover" | "transferir" } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const souMestre = campanha?.meuPapel === "mestre";
  // Personagens exige mestre/jogador no backend (GET /characters → 403
  // para espectador): a aba e a página só existem para quem pode ler.
  const vePersonagens = campanha?.meuPapel !== "espectador";

  const geracao = useRef(0);
  const carregar = useCallback(async () => {
    const g = ++geracao.current;
    try {
      const { campanha } = await api.obterCampanha(id);
      if (g !== geracao.current) return;
      setCampanha(campanha);
      setForm({
        name: campanha.name,
        description: campanha.description ?? "",
        system: campanha.system ?? "",
        status: campanha.status,
      });
      if (campanha.meuPapel === "mestre") {
        const [{ membros }, { convites }] = await Promise.all([api.listarMembros(id), api.listarConvites(id)]);
        if (g !== geracao.current) return;
        setMembros(membros);
        setConvites(convites);
      } else {
        const { membros } = await api.listarMembros(id);
        if (g !== geracao.current) return;
        setMembros(membros);
      }
      setExtrasCarregados(true);
      setExtrasErro(false);
      setErro(null);
      // Issue #285: a marca de sincronização só avança após o GET
      // autoritativo terminar com sucesso. O shell serve as abas
      // info/participantes/convites — cada uma recebe a mesma marca.
      for (const tela of TELAS_SHELL) registrarSyncOk(id, tela);
    } catch (e) {
      if (g === geracao.current) {
        setExtrasErro(true);
        setErro(e instanceof Error ? e.message : "Erro ao carregar campanha");
      }
    }
  }, [id]);

  // Invalidação por evento + resync na reconexão passam pelo hook único
  // (coalescência + connect → recarga). Aqui fica só o ciclo de vida da
  // room: entrar na conexão e a cada reconnect, sair no unmount.
  useSincronizacaoCampanha(["membros:atualizados", "campanha:atualizada"], () => void carregar());

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
    return () => {
      socket.off("connect", entrar);
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

  // Issue #132 P3 — abas como tablist ARIA de verdade: role=tab com
  // aria-selected/aria-controls, roving tabindex e setas ←/→/Home/End
  // movem foco+seleção. Painéis correspondentes recebem role=tabpanel.
  const abasVisiveis: { id: Aba; rotulo: string; icone: NomeIconeInterface }[] = [
    { id: "info", rotulo: "Informações", icone: "informacoes" },
    { id: "mesa", rotulo: "Mesa", icone: "mesa" },
    ...(vePersonagens ? [{ id: "personagens" as Aba, rotulo: "Personagens", icone: "personagens" as NomeIconeInterface }] : []),
    { id: "diario", rotulo: "Diário", icone: "diario" },
    { id: "historico", rotulo: "Histórico", icone: "historico" },
    { id: "arquivos", rotulo: "Arquivos", icone: "arquivos" },
    ...(souMestre
      ? ([
          { id: "fichas", rotulo: "Fichas", icone: "fichas" },
          { id: "regras", rotulo: "Regras", icone: "regras" },
          { id: "participantes", rotulo: `Participantes (${membros.length})`, icone: "participantes" },
          { id: "convites", rotulo: `Convites (${convites.length})`, icone: "convites" },
        ] as { id: Aba; rotulo: string; icone: NomeIconeInterface }[])
      : []),
  ];

  const aoTeclarAbas = (e: ReactKeyboardEvent) => {
    const ids = abasVisiveis.map((a) => a.id);
    const i = ids.indexOf(aba);
    let j = -1;
    if (e.key === "ArrowRight") j = (i + 1) % ids.length;
    else if (e.key === "ArrowLeft") j = (i - 1 + ids.length) % ids.length;
    else if (e.key === "Home") j = 0;
    else if (e.key === "End") j = ids.length - 1;
    else return;
    e.preventDefault();
    const alvo = ids[j];
    setAba(alvo);
    requestAnimationFrame(() => document.getElementById(`aba-${alvo}`)?.focus());
  };

  return (
    <>
      <section className="cartao">
        <div className="linha-entre">
          <div>
            <h2>{campanha.name}</h2>
            <p className="meta">
              {campanha.system ? `Sistema: ${campanha.system} · ` : ""}
              {statusLabel(campanha.status)} · Você é {PAPEL_LABEL[campanha.meuPapel] ?? campanha.meuPapel}
              {" · "}<IndicadorConexao campaignId={id} tela={aba} />
            </p>
          </div>
          <button className="secundario" onClick={aoVoltar}>Voltar</button>
        </div>
        {campanha.description && <p>{campanha.description}</p>}

        {/* Issue #233 — ícones complementam os rótulos (que permanecem
            como accessible name); nunca substituem o texto.
            Issue #132 P3 — tablist ARIA real: setas/Home/End navegam. */}
        <div className="abas" role="tablist" aria-label="Seções da campanha" onKeyDown={aoTeclarAbas}>
          {abasVisiveis.map((a) => (
            <button
              key={a.id}
              id={`aba-${a.id}`}
              role="tab"
              aria-selected={aba === a.id}
              aria-controls={`painel-${a.id}`}
              tabIndex={aba === a.id ? 0 : -1}
              className={aba === a.id ? "ativo" : "secundario"}
              onClick={() => setAba(a.id)}
            ><IconeInterface nome={a.icone} />{a.rotulo}</button>
          ))}
        </div>
      </section>

      {aba === "mesa" && <div role="tabpanel" id="painel-mesa" aria-labelledby="aba-mesa"><Mesa campaignId={id} campanha={campanha} /></div>}
      {aba === "personagens" && vePersonagens && <div role="tabpanel" id="painel-personagens" aria-labelledby="aba-personagens"><Personagens campaignId={id} campanha={campanha} /></div>}
      {aba === "diario" && <div role="tabpanel" id="painel-diario" aria-labelledby="aba-diario"><Diario campaignId={id} campanha={campanha} /></div>}
      {aba === "historico" && <div role="tabpanel" id="painel-historico" aria-labelledby="aba-historico"><Historico campaignId={id} campanha={campanha} aoAtualizar={() => void carregar()} /></div>}
      {aba === "arquivos" && <div role="tabpanel" id="painel-arquivos" aria-labelledby="aba-arquivos"><Arquivos campaignId={id} campanha={campanha} /></div>}
      {aba === "fichas" && souMestre && <div role="tabpanel" id="painel-fichas" aria-labelledby="aba-fichas"><ModelosFicha campaignId={id} /></div>}
      {aba === "regras" && souMestre && <div role="tabpanel" id="painel-regras" aria-labelledby="aba-regras"><Regras campaignId={id} /></div>}

      {erro && <EstadoErro aoTentarNovamente={carregar}>{erro}</EstadoErro>}

      {aba === "info" && (
        <div role="tabpanel" id="painel-info" aria-labelledby="aba-info">
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
        </div>
      )}

      {aba === "participantes" && souMestre && (
        <div role="tabpanel" id="painel-participantes" aria-labelledby="aba-participantes">
        <section className="cartao">
          <h2>Participantes</h2>
          {extrasErro && <EstadoErro aoTentarNovamente={carregar}>Não foi possível carregar os participantes.</EstadoErro>}
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
        </div>
      )}

      {aba === "convites" && souMestre && (
        <div role="tabpanel" id="painel-convites" aria-labelledby="aba-convites">
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

          {extrasErro ? (
            <EstadoErro aoTentarNovamente={carregar}>Não foi possível carregar os convites.</EstadoErro>
          ) : !extrasCarregados ? (
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
