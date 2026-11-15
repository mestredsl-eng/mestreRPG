import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type ConviteInternoGuilda, type Guilda, type GuildaCampanha, type GuildaCampanhaCandidata, type GuildaMembro } from "../api";
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
  const jaCarregou = useRef(false);
  const geracaoCarregamento = useRef(0);

  const carregar = useCallback(async () => {
    const geracao = ++geracaoCarregamento.current;
    setCarregando(true);
    try {
      // ADMIN lista todas as guildas (inclusive as que não gerencia);
      // os demais veem as suas, já com status para permitir reativação
      const { guildas } = await api.listarGuildas(!!usuario?.isAdmin);
      if (geracao !== geracaoCarregamento.current) return;
      setGuildas(guildas);
      setErro(null);
    } catch (e) {
      if (geracao !== geracaoCarregamento.current) return;
      // Não conserva uma lista antiga quando a leitura atual falha.
      setGuildas([]);
      setErro(e instanceof Error ? e.message : "Erro ao carregar guildas");
    } finally {
      if (geracao === geracaoCarregamento.current) {
        setCarregando(false);
        jaCarregou.current = true;
      }
    }
  }, [usuario?.isAdmin]);

  useEffect(() => {
    void carregar();
    return () => { geracaoCarregamento.current++; };
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
        {carregando && !jaCarregou.current ? (
          <p>Carregando…</p>
        ) : guildas.length === 0 ? (
          <p>Nenhuma guilda ainda. Crie a primeira ou peça a um GM para adicioná-lo.</p>
        ) : (
          <>
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
          <div className="cartoes-registro">
            {guildas.map((g) => (
              <div key={g.id} className="registro-cartao">
                <div className="registro-campo"><span className="registro-rotulo">Nome</span><strong>{g.name}</strong></div>
                <div className="registro-campo"><span className="registro-rotulo">Seu papel</span><span>{g.meuPapel === "gm" ? "GM" : g.meuPapel === "membro" ? "Membro" : g.meuPapel === "admin" ? "Administrador" : "—"}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Status</span><span>{g.status === "arquivada" ? "Arquivada" : "Ativa"}</span></div>
                <div className="registro-acoes">
                  <button className="mini" onClick={() => setSelecionada(g.id)}>Abrir</button>
                </div>
              </div>
            ))}
          </div>
          </>
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
  const [novoResponsavel, setNovoResponsavel] = useState("");
  const [confirmandoResp, setConfirmandoResp] = useState(false);
  const [transferindo, setTransferindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const geracaoCarregamento = useRef(0);

  const carregar = useCallback(async () => {
    const geracao = ++geracaoCarregamento.current;
    setCarregando(true);
    try {
      // o papel efetivo só é conhecido após obterGuilda — candidatas
      // exige gestão (GM da guilda ou ADMIN) e não pode derrubar a
      // visualização dos dados que o membro comum tem direito de ler
      const g = await api.obterGuilda(guildId);
      if (geracao !== geracaoCarregamento.current) return;
      setGuilda(g.guilda);
      const podeGerir = souAdmin || g.guilda.souGM === true;
      const [m, c, mc] = await Promise.allSettled([
        api.listarMembrosGuilda(guildId),
        api.listarCampanhasGuilda(guildId),
        podeGerir ? api.listarCampanhasCandidatasGuilda(guildId) : Promise.resolve(null),
      ]);
      if (geracao !== geracaoCarregamento.current) return;
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
      if (geracao !== geracaoCarregamento.current) return;
      // Revogação pode remover o acesso desta tela enquanto ela está aberta.
      // Limpa a visão anterior imediatamente (fail-closed) em vez de manter
      // nomes, membros ou controles que o usuário já não pode consultar.
      setGuilda(null);
      setMembros([]);
      setCampanhas([]);
      setCandidatas([]);
      setErro(e instanceof Error ? e.message : "Erro ao carregar guilda");
    } finally {
      if (geracao === geracaoCarregamento.current) setCarregando(false);
    }
  }, [guildId, souAdmin]);

  useEffect(() => {
    void carregar();
    return () => { geracaoCarregamento.current++; };
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

  // Responsável administrativo (guilda.responsavelId — distinto de
  // createdBy, que é autoria histórica). O nome é resolvido pelo roster,
  // que só traz membros não-removidos da própria guilda.
  const eu = membros.find((m) => m.ehEu);
  const membroResponsavel = guilda ? membros.find((m) => m.userId === guilda.responsavelId) : undefined;
  const nomeResponsavel = membroResponsavel ? (membroResponsavel.displayName ?? membroResponsavel.username) : null;
  // Espelha a regra do backend para exibição: ADMIN sempre; o responsável
  // só enquanto mantiver vínculo GM ativo. O backend revalida tudo —
  // esconder o botão é apenas conveniência de UX, nunca a segurança.
  const souResponsavel = !!eu && eu.userId === guilda?.responsavelId && eu.role === "gm" && eu.status === "ativo";
  const podeTransferir = !!guilda && (souAdmin || souResponsavel);
  // Elegíveis = GM com vínculo ativo E conta ativa (contaStatus do
  // roster). GM com conta bloqueada segue visível na lista de membros,
  // apenas não aparece neste seletor — o backend também rejeita (409).
  const gmsElegiveis = guilda
    ? membros.filter((m) => m.role === "gm" && m.status === "ativo" && m.contaStatus === "ativo" && m.userId !== guilda.responsavelId)
    : [];
  const alvoResp = gmsElegiveis.find((m) => m.userId === novoResponsavel);

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

  // Dois passos: primeiro clique pede confirmação explícita com o nome do
  // novo responsável; só o segundo envia o PUT. Nenhum papel muda —
  // o responsável anterior continua GM.
  const transferirResponsavel = async (e: FormEvent) => {
    e.preventDefault();
    if (!novoResponsavel || transferindo) return;
    if (!confirmandoResp) {
      setConfirmandoResp(true);
      return;
    }
    setTransferindo(true);
    setErro(null);
    try {
      const res = await api.transferirResponsavelGuilda(guildId, novoResponsavel);
      const alvo = membros.find((m) => m.userId === res.responsavelId);
      notificar(`Responsabilidade transferida para ${alvo ? (alvo.displayName ?? alvo.username) : "o novo responsável"}.`, "sucesso");
      setNovoResponsavel("");
      setConfirmandoResp(false);
      await carregar();
    } catch (err) {
      setConfirmandoResp(false);
      setErro(err instanceof Error ? err.message : "Erro ao transferir responsabilidade");
    } finally {
      setTransferindo(false);
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

  // Só bloqueia a tela no primeiro carregamento: recargas disparadas por
  // guilda:atualizada (ex.: convite criado) não podem desmontar a seção de
  // convites — o código do link só é exibido uma única vez, logo após criar.
  if (carregando && !guilda) return <section className="cartao"><p>Carregando…</p></section>;
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
        <p className="dica">
          Responsável: <strong>{nomeResponsavel ?? "—"}</strong>
          {souResponsavel && " (você)"}
        </p>
        {erro && <p className="erro">{erro}</p>}
      </section>

      {podeTransferir && (
        <section className="cartao">
          <h2>Transferir responsabilidade</h2>
          <p className="dica">
            O responsável administra a guilda. A transferência não altera papéis:
            o responsável anterior continua GM e nenhum membro de campanha é afetado.
          </p>
          {gmsElegiveis.length === 0 ? (
            <p className="dica">Nenhum outro GM ativo disponível para receber a responsabilidade.</p>
          ) : (
            <form className="formulario" onSubmit={transferirResponsavel}>
              <div className="linha">
                <select
                  value={novoResponsavel}
                  onChange={(e) => { setNovoResponsavel(e.target.value); setConfirmandoResp(false); }}
                  required
                  aria-label="Novo responsável"
                >
                  <option value="">Escolha o novo responsável…</option>
                  {gmsElegiveis.map((m) => (
                    <option key={m.userId} value={m.userId}>{m.displayName ?? m.username} (@{m.username})</option>
                  ))}
                </select>
                <button type="submit" disabled={!novoResponsavel || transferindo}>
                  {transferindo ? "Transferindo…" : confirmandoResp ? "Confirmar transferência" : "Transferir"}
                </button>
              </div>
              {confirmandoResp && alvoResp && (
                <p className="dica">
                  Confirmar: <strong>{alvoResp.displayName ?? alvoResp.username}</strong> passa a ser o
                  responsável da guilda. O responsável atual continuará como GM — nenhum papel muda.
                </p>
              )}
              {confirmandoResp && (
                <button type="button" className="mini" onClick={() => setConfirmandoResp(false)}>Cancelar</button>
              )}
            </form>
          )}
        </section>
      )}

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
        <div className="cartoes-registro">
          {membros.map((m) => {
            const ultimoGM = m.ehEu && m.role === "gm" && membros.filter((x) => x.role === "gm" && x.status === "ativo").length <= 1;
            return (
              <div key={m.userId} className="registro-cartao">
                <div className="registro-campo"><span className="registro-rotulo">Usuário</span><strong>{m.username}</strong></div>
                <div className="registro-campo"><span className="registro-rotulo">Nome</span><span>{m.displayName ?? "—"}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Papel</span><span>{m.role === "gm" ? "GM" : "Membro"}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Status</span><span>{m.status === "ativo" ? "Ativo" : m.status}</span></div>
                {podeGerir && m.status === "ativo" && (
                  <div className="registro-acoes">
                    <button className="mini" onClick={() => void alternarGM(m)} disabled={ultimoGM}>
                      {m.role === "gm" ? "Rebaixar" : "Promover a GM"}
                    </button>
                    <button className="mini perigo" onClick={() => void remover(m)} disabled={ultimoGM}>Remover</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
          <>
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
          <div className="cartoes-registro">
            {campanhas.map((c) => (
              <div key={c.id} className="registro-cartao">
                <div className="registro-campo"><span className="registro-rotulo">Nome</span><strong>{c.name}</strong></div>
                <div className="registro-campo"><span className="registro-rotulo">Status</span><span>{c.status}</span></div>
                {souAdmin && (
                  <div className="registro-acoes">
                    <button className="mini perigo" onClick={() => void desvincular(c)}>Desvincular</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          </>
        )}
      </section>

      {podeGerir && guilda.status === "ativa" && <SecaoConvitesInternos guildId={guildId} />}
    </>
  );
}

const SITUACAO_CONVITE: Record<string, string> = {
  ativo: "Ativo",
  esgotado: "Esgotado",
  expirado: "Expirado",
  revogado: "Revogado",
};

function situacaoConvite(c: ConviteInternoGuilda): string {
  // O servidor informa `status`; recalculamos no cliente apenas como
  // rede de segurança para listas abertas entre expiração/limite.
  if (c.status === "revogado" || c.status === "expirado" || c.status === "esgotado") return c.status;
  if (new Date(c.expiraEm).getTime() <= Date.now()) return "expirado";
  if (c.maxUsos > 0 && c.usos >= c.maxUsos) return "esgotado";
  return "ativo";
}

function SecaoConvitesInternos({ guildId }: { guildId: string }) {
  const [convites, setConvites] = useState<ConviteInternoGuilda[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [validadeHoras, setValidadeHoras] = useState("168");
  const [maxUsos, setMaxUsos] = useState("1");
  // Link recém-criado: o código opaco só é exibido aqui, uma única vez.
  const [linkCriado, setLinkCriado] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const [revogando, setRevogando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const { convites: lista } = await api.listarConvitesInternosGuilda(guildId);
      setConvites(lista);
    } catch (e) {
      setConvites([]);
      setErro(e instanceof Error ? e.message : "Erro ao carregar convites");
    }
  }, [guildId]);

  useEffect(() => { void carregar(); }, [carregar]);

  // Aceites/revogações emitem guilda:atualizada — sem este listener a
  // listagem de convites (usos e situação) ficaria desatualizada enquanto
  // a seção permanecer montada.
  useEffect(() => {
    const socket = getSocket();
    const aoAtualizar = (evento: { guildId?: string }) => {
      if (evento?.guildId === guildId) void carregar();
    };
    socket.on("guilda:atualizada", aoAtualizar);
    return () => { socket.off("guilda:atualizada", aoAtualizar); };
  }, [carregar, guildId]);

  const criar = async (e: FormEvent) => {
    e.preventDefault();
    if (criando) return;
    setCriando(true);
    setErro(null);
    setLinkCriado(null);
    try {
      const { convite } = await api.criarConviteInternoGuilda(guildId, {
        validadeHoras: Number(validadeHoras),
        maxUsos: Number(maxUsos),
      });
      if (convite.codigo) {
        setLinkCriado(`${window.location.origin}/?conviteGuilda=${convite.codigo}`);
        setCopiado(false);
      }
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao criar convite");
    } finally {
      setCriando(false);
    }
  };

  const copiar = async () => {
    if (!linkCriado) return;
    try {
      await navigator.clipboard.writeText(linkCriado);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = linkCriado;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopiado(true);
  };

  const revogar = async (c: ConviteInternoGuilda) => {
    if (revogando) return;
    setRevogando(c.id);
    setErro(null);
    try {
      await api.revogarConviteInternoGuilda(guildId, c.id);
      await carregar();
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao revogar convite");
    } finally {
      setRevogando(null);
    }
  };

  return (
    <section className="cartao">
      <h2>Convites internos</h2>
      <p className="dica">
        Links para adicionar pessoas a esta guilda como <strong>membro</strong>. O papel de GM
        nunca é concedido por convite — continua sendo decisão de um GM.
      </p>
      {erro && <p className="erro">{erro}</p>}

      <form className="formulario" onSubmit={criar}>
        <div className="grade-2">
          <label>Validade
            <select value={validadeHoras} onChange={(e) => setValidadeHoras(e.target.value)}>
              <option value="24">24 horas</option>
              <option value="72">3 dias</option>
              <option value="168">7 dias</option>
              <option value="720">30 dias</option>
            </select>
          </label>
          <label>Limite de usos
            <select value={maxUsos} onChange={(e) => setMaxUsos(e.target.value)}>
              <option value="1">1 uso</option>
              <option value="5">5 usos</option>
              <option value="25">25 usos</option>
            </select>
          </label>
        </div>
        <button type="submit" disabled={criando}>{criando ? "Gerando…" : "Gerar convite"}</button>
      </form>

      {linkCriado && (
        <div className="formulario">
          <p><strong>Convite criado.</strong> Compartilhe o link — ele só é exibido agora:</p>
          <div className="linha">
            <input readOnly value={linkCriado} onFocus={(e) => e.target.select()} aria-label="Link do convite" />
            <button type="button" className="mini" onClick={() => void copiar()}>{copiado ? "Copiado!" : "Copiar link"}</button>
          </div>
        </div>
      )}

      {convites === null ? (
        <p>Carregando convites…</p>
      ) : convites.length === 0 ? (
        <p className="dica">Nenhum convite criado ainda.</p>
      ) : (
        <>
        <table className="tabela tabela-responsiva">
          <thead><tr><th>Convite</th><th>Expira em</th><th>Usos</th><th>Situação</th><th>Ações</th></tr></thead>
          <tbody>
            {convites.map((c) => {
              const sit = situacaoConvite(c);
              return (
                <tr key={c.id}>
                  <td>{c.id.slice(0, 8)}…</td>
                  <td>{new Date(c.expiraEm).toLocaleString("pt-BR")}</td>
                  <td>{c.usos}/{c.maxUsos > 0 ? c.maxUsos : "∞"}</td>
                  <td><span className={`badge badge-${sit}`}>{SITUACAO_CONVITE[sit] ?? sit}</span></td>
                  <td className="acoes">
                    {sit === "ativo" && (
                      <button className="mini perigo" onClick={() => void revogar(c)} disabled={revogando === c.id}>
                        {revogando === c.id ? "Revogando…" : "Revogar"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="cartoes-registro">
          {convites.map((c) => {
            const sit = situacaoConvite(c);
            return (
              <div key={c.id} className="registro-cartao">
                <div className="registro-campo"><span className="registro-rotulo">Convite</span><span>{c.id.slice(0, 8)}…</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Expira em</span><span>{new Date(c.expiraEm).toLocaleString("pt-BR")}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Usos</span><span>{c.usos}/{c.maxUsos > 0 ? c.maxUsos : "∞"}</span></div>
                <div className="registro-campo"><span className="registro-rotulo">Situação</span><span className={`badge badge-${sit}`}>{SITUACAO_CONVITE[sit] ?? sit}</span></div>
                {sit === "ativo" && (
                  <div className="registro-acoes">
                    <button className="mini perigo" onClick={() => void revogar(c)} disabled={revogando === c.id}>
                      {revogando === c.id ? "Revogando…" : "Revogar"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        </>
      )}
    </section>
  );
}
