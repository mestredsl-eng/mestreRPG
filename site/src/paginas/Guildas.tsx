import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Guilda, type GuildaCampanha, type GuildaCampanhaCandidata, type GuildaMembro } from "../api";
import { useAuth } from "../auth";
import { useNotificar } from "../Notificacoes";
import { getSocket } from "../socket";

const PAPEL_GUILDA: Record<string, string> = { gm: "GM", membro: "Membro" };

export default function Guildas() {
  const { estado } = useAuth();
  const usuario = estado.status === "autenticado" ? estado.usuario : null;
  const { notificar } = useNotificar();
  const [guildas, setGuildas] = useState<Guilda[]>([]);
  const [selecionada, setSelecionada] = useState<string | null>(null);
  const [novaAberta, setNovaAberta] = useState(false);
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      // ADMIN lista todas as guildas (inclusive as que não gerencia);
      // os demais veem as suas, já com status para permitir reativação
      const { guildas } = await api.listarGuildas(!!usuario?.isAdmin);
      setGuildas(guildas);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar guildas");
    } finally {
      setCarregando(false);
    }
  }, [usuario?.isAdmin]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Atualiza a listagem em todas as abas/dispositivos do usuário.
  // O payload só identifica a guilda; os dados sempre são relidos pela API.
  useEffect(() => {
    const socket = getSocket();
    const aoAtualizar = () => { void carregar(); };
    socket.on("guilda:atualizada", aoAtualizar);
    return () => { socket.off("guilda:atualizada", aoAtualizar); };
  }, [carregar]);

  const criar = async (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    try {
      const { guilda } = await api.criarGuilda({ name: nome, description: descricao || undefined });
      setNovaAberta(false);
      setNome("");
      setDescricao("");
      notificar(`Guilda "${guilda.name}" criada — você é o GM fundador.`, "sucesso");
      setSelecionada(guilda.id);
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao criar guilda");
    }
  };

  if (selecionada) {
    return (
      <DetalheGuilda
        guildId={selecionada}
        souAdmin={!!usuario?.isAdmin}
        aoVoltar={() => { setSelecionada(null); void carregar(); }}
      />
    );
  }

  return (
    <>
      <section className="cartao">
        <div className="linha-entre">
          <h2>Guildas</h2>
          <button onClick={() => setNovaAberta((v) => !v)}>{novaAberta ? "Cancelar" : "Nova guilda"}</button>
        </div>
        <p className="dica">
          A guilda é um escopo administrativo próprio: o GM gerencia membros e o vínculo de
          campanhas, mas <strong>não</strong> vira mestre de mesa automaticamente — os papéis
          de campanha (Espectador, Jogador, Mestre) continuam separados.
        </p>
        {erro && <p className="erro">{erro}</p>}
        {novaAberta && (
          <form className="formulario" onSubmit={criar}>
            <div className="grade-2">
              <label>Nome da guilda<input value={nome} onChange={(e) => setNome(e.target.value)} required minLength={2} maxLength={120} /></label>
              <label>Descrição<input value={descricao} onChange={(e) => setDescricao(e.target.value)} maxLength={2000} /></label>
            </div>
            <button type="submit">Criar guilda</button>
          </form>
        )}
        {carregando ? (
          <p>Carregando…</p>
        ) : guildas.length === 0 ? (
          <p>Nenhuma guilda ainda. Crie a primeira ou peça a um GM para adicioná-lo.</p>
        ) : (
          <table className="tabela tabela-responsiva">
            <thead>
              <tr><th>Nome</th><th>Seu papel</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {guildas.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}</td>
                  <td>{g.meuPapel === "gm" ? "GM" : g.meuPapel === "membro" ? "Membro" : g.meuPapel === "admin" ? "Administrador" : "—"}</td>
                  <td>{g.status === "arquivada" ? "Arquivada" : "Ativa"}</td>
                  <td><button className="mini" onClick={() => setSelecionada(g.id)}>Abrir</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function DetalheGuilda({ guildId, souAdmin, aoVoltar }: { guildId: string; souAdmin: boolean; aoVoltar: () => void }) {
  const { notificar } = useNotificar();
  const [guilda, setGuilda] = useState<Guilda | null>(null);
  const [membros, setMembros] = useState<GuildaMembro[]>([]);
  const [campanhas, setCampanhas] = useState<GuildaCampanha[]>([]);
  const [candidatas, setCandidatas] = useState<GuildaCampanhaCandidata[]>([]);
  const [campanhaVincular, setCampanhaVincular] = useState("");
  const [novoMembro, setNovoMembro] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      // o papel efetivo só é conhecido após obterGuilda — candidatas
      // exige gestão (GM da guilda ou ADMIN) e não pode derrubar a
      // visualização dos dados que o membro comum tem direito de ler
      const g = await api.obterGuilda(guildId);
      setGuilda(g.guilda);
      const podeGerir = souAdmin || g.guilda.souGM === true;
      const [m, c, mc] = await Promise.allSettled([
        api.listarMembrosGuilda(guildId),
        api.listarCampanhasGuilda(guildId),
        podeGerir ? api.listarCampanhasCandidatasGuilda(guildId) : Promise.resolve(null),
      ]);
      const falhas: string[] = [];
      if (m.status === "fulfilled") setMembros(m.value.membros);
      else falhas.push("membros");
      if (c.status === "fulfilled") setCampanhas(c.value.campanhas);
      else falhas.push("campanhas vinculadas");
      // candidatas já vêm filtradas pelo servidor (ADMIN: todas;
      // GM: só as que pode operar na mesa) — aqui só o vínculo atual
      if (mc.status === "fulfilled") setCandidatas(mc.value?.campanhas ?? []);
      else if (mc.status === "rejected") falhas.push("campanhas candidatas");
      setErro(falhas.length ? `Falha ao carregar: ${falhas.join(", ")}` : null);
    } catch (e) {
      // Revogação pode remover o acesso desta tela enquanto ela está aberta.
      // Limpa a visão anterior imediatamente (fail-closed) em vez de manter
      // nomes, membros ou controles que o usuário já não pode consultar.
      setGuilda(null);
      setMembros([]);
      setCampanhas([]);
      setCandidatas([]);
      setErro(e instanceof Error ? e.message : "Erro ao carregar guilda");
    } finally {
      setCarregando(false);
    }
  }, [guildId, souAdmin]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // A sala privada usuario:<id> entrega a notificação a todas as sessões
  // autenticadas. Recarregar pela API revalida o papel e o acesso atuais.
  useEffect(() => {
    const socket = getSocket();
    const aoAtualizar = (evento: { guildId?: string }) => {
      if (evento?.guildId === guildId) void carregar();
    };
    socket.on("guilda:atualizada", aoAtualizar);
    return () => { socket.off("guilda:atualizada", aoAtualizar); };
  }, [carregar, guildId]);

  const podeGerir = !!guilda && (souAdmin || guilda.souGM);

  const adicionar = async (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    try {
      await api.adicionarMembroGuilda(guildId, { username: novoMembro });
      setNovoMembro("");
      notificar("Membro adicionado.", "sucesso");
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao adicionar membro");
    }
  };

  const alternarGM = async (m: GuildaMembro) => {
    try {
      await api.atualizarMembroGuilda(guildId, m.userId, { role: m.role === "gm" ? "membro" : "gm" });
      notificar(m.role === "gm" ? `${m.username} rebaixado a membro.` : `${m.username} promovido a GM.`, "info");
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao alterar papel");
    }
  };

  const remover = async (m: GuildaMembro) => {
    try {
      await api.removerMembroGuilda(guildId, m.userId);
      notificar(`${m.username} removido da guilda.`, "info");
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao remover membro");
    }
  };

  const vincular = async (e: FormEvent) => {
    e.preventDefault();
    if (!campanhaVincular) return;
    setErro(null);
    try {
      await api.vincularCampanhaGuilda(guildId, campanhaVincular, "vincular");
      setCampanhaVincular("");
      notificar("Campanha vinculada à guilda.", "sucesso");
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao vincular campanha");
    }
  };

  const desvincular = async (c: GuildaCampanha) => {
    try {
      await api.vincularCampanhaGuilda(guildId, c.id, "desvincular");
      notificar("Campanha desvinculada da guilda.", "info");
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao desvincular campanha");
    }
  };

  const alternarStatus = async () => {
    if (!guilda) return;
    try {
      await api.atualizarGuilda(guildId, { status: guilda.status === "arquivada" ? "ativa" : "arquivada" });
      notificar(guilda.status === "arquivada" ? "Guilda reativada." : "Guilda arquivada.", "info");
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao alterar status");
    }
  };

  if (carregando) return <section className="cartao"><p>Carregando…</p></section>;
  if (!guilda) return <section className="cartao"><p className="erro">{erro ?? "Guilda não encontrada."}</p><button onClick={aoVoltar}>Voltar</button></section>;

  return (
    <>
      <section className="cartao">
        <div className="linha-entre">
          <h2>{guilda.name}</h2>
          <div>
            {podeGerir && (
              <button className="mini" onClick={() => void alternarStatus()}>{guilda.status === "arquivada" ? "Reativar" : "Arquivar"}</button>
            )}
            <button className="mini" onClick={aoVoltar}>Voltar</button>
          </div>
        </div>
        {guilda.description && <p>{guilda.description}</p>}
        <p className="dica">
          Seu papel aqui: <strong>{PAPEL_GUILDA[guilda.meuPapel ?? ""] ?? guilda.meuPapel ?? "—"}</strong>
          {guilda.meuPapel === "gm" && " — você gerencia membros e campanhas desta guilda."}
          {guilda.status === "arquivada" && " — guilda arquivada."}
        </p>
        {erro && <p className="erro">{erro}</p>}
      </section>

      <section className="cartao">
        <h2>Membros ({membros.length})</h2>
        {podeGerir && guilda.status !== "arquivada" && (
          <form className="formulario" onSubmit={adicionar}>
            <div className="linha">
              <input
                placeholder="Nome de usuário existente"
                value={novoMembro}
                onChange={(e) => setNovoMembro(e.target.value)}
                required
                minLength={3}
              />
              <button type="submit">Adicionar</button>
            </div>
          </form>
        )}
        <table className="tabela tabela-responsiva">
          <thead><tr><th>Usuário</th><th>Nome</th><th>Papel</th><th>Status</th>{podeGerir && <th>Ações</th>}</tr></thead>
          <tbody>
            {membros.map((m) => (
              <tr key={m.userId}>
                <td>{m.username}</td>
                <td>{m.displayName ?? "—"}</td>
                <td>{m.role === "gm" ? "GM" : "Membro"}</td>
                <td>{m.status === "ativo" ? "Ativo" : m.status}</td>
                {podeGerir && (
                  <td className="acoes">
                    {m.status === "ativo" && (
                      <>
                        <button className="mini" onClick={() => void alternarGM(m)} disabled={m.ehEu && m.role === "gm" && membros.filter((x) => x.role === "gm" && x.status === "ativo").length <= 1}>
                          {m.role === "gm" ? "Rebaixar" : "Promover a GM"}
                        </button>
                        <button className="mini perigo" onClick={() => void remover(m)} disabled={m.ehEu && m.role === "gm" && membros.filter((x) => x.role === "gm" && x.status === "ativo").length <= 1}>Remover</button>
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="cartao">
        <h2>Campanhas vinculadas ({campanhas.length})</h2>
        {podeGerir && guilda.status === "ativa" && (() => {
          // GM não move campanhas de outra guilda; ADMIN pode mover
          const opcoes = candidatas.filter((c) => souAdmin || !c.guildId || c.guildId === guildId);
          return opcoes.length > 0 ? (
            <form className="formulario" onSubmit={vincular}>
              <div className="linha">
                <select value={campanhaVincular} onChange={(e) => setCampanhaVincular(e.target.value)} required>
                  <option value="">{souAdmin ? "Escolha uma campanha…" : "Escolha uma campanha que você mestra…"}</option>
                  {opcoes.map((c) => <option key={c.id} value={c.id}>{c.name}{c.guildId && c.guildId !== guildId ? " (outra guilda)" : ""}</option>)}
                </select>
                <button type="submit" disabled={!campanhaVincular}>Vincular</button>
              </div>
            </form>
          ) : null;
        })()}
        {campanhas.length === 0 ? (
          <p className="dica">Nenhuma campanha vinculada. Campanhas sem guilda podem ser vinculadas por um mestre delas que seja GM (ou pelo ADMIN).</p>
        ) : (
          <table className="tabela tabela-responsiva">
            <thead><tr><th>Nome</th><th>Status</th>{souAdmin && <th>Ações</th>}</tr></thead>
            <tbody>
              {campanhas.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.status}</td>
                  {souAdmin && (
                    <td className="acoes">
                      <button className="mini perigo" onClick={() => void desvincular(c)}>Desvincular</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
