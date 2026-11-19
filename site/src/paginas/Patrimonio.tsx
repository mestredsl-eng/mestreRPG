import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api, ApiError,
  type ItemInventario, type ItemInventarioInput, type Equipamento,
  type Veiculo, type VeiculoInput, type Financeiro, type ContaFinanceira, type ContaInput,
  type ItemCatalogo, type ItemCatalogoInput, type PersonagemResumo, type TransacaoFinanceira,
  type AcervoCatalogoItem, type DisponibilidadeAcervo, type RegraRef, type EconomiaAcervo,
} from "../api";
import { getSocket } from "../socket";
import { ModalConfirmar } from "../Modal";

const fmtMoeda = (cents: number | null | undefined, casas = 2) =>
  cents === null || cents === undefined ? "—" : (cents / 100).toFixed(casas);

interface Props {
  characterId: string;
  campaignId: string;
  souMestre: boolean;
  /** Personagem arquivado: somente consulta — esconde todos os controles de alteração. */
  somenteLeitura?: boolean;
}

type Aba = "inventario" | "equipamentos" | "veiculos" | "dinheiro" | "catalogo";

// Permissões granulares de patrimônio/financeiro (Issue #165). Os defaults
// espelham o schema do backend (servidor/src/lib/regras.ts): campanhas antigas
// sem as chaves recebem estes valores ao serem carregadas.
interface PermissoesPatrimonio {
  adicionaItens: boolean;
  removeItens: boolean;
  editaEquipamentos: boolean;
  editaVeiculos: boolean;
  criaContas: boolean;
  compraVenda: boolean;
  pix: boolean;
}
const PERMISSOES_PADRAO: PermissoesPatrimonio = {
  adicionaItens: true, removeItens: false, editaEquipamentos: true,
  editaVeiculos: true, criaContas: true, compraVenda: true, pix: true,
};
interface ConfigPermissoes {
  patrimonio?: Partial<{
    jogadorAdicionaItens: boolean; jogadorRemoveItens: boolean;
    jogadorEditaEquipamentos: boolean; jogadorEditaVeiculos: boolean; jogadorCriaContas: boolean;
  }>;
  financeiro?: { jogadorCompraVenda?: boolean; jogadorPix?: boolean };
}

export default function Patrimonio({ characterId, campaignId, souMestre, somenteLeitura = false }: Props) {
  const [aba, setAba] = useState<Aba>("inventario");
  const [erro, setErro] = useState<string | null>(null);
  // Regras granulares: fail-closed — `null` durante o carregamento inicial
  // E durante recarregamentos por `regras:atualizadas`: enquanto a config
  // nova não confirma, nenhum controle dependente de autorização aparece.
  const [permissoes, setPermissoes] = useState<PermissoesPatrimonio | null>(null);
  const recarregarRef = useRef<{ fn?: () => Promise<void> }>({}).current;

  const carregarPermissoes = useCallback(async () => {
    setPermissoes(null);
    try {
      const r = await api.obterRegras(campaignId);
      const cfg = (r.config ?? {}) as unknown as ConfigPermissoes;
      const pat = cfg.patrimonio ?? {};
      const fin = cfg.financeiro ?? {};
      setPermissoes({
        adicionaItens: pat.jogadorAdicionaItens ?? PERMISSOES_PADRAO.adicionaItens,
        removeItens: pat.jogadorRemoveItens ?? PERMISSOES_PADRAO.removeItens,
        editaEquipamentos: pat.jogadorEditaEquipamentos ?? PERMISSOES_PADRAO.editaEquipamentos,
        editaVeiculos: pat.jogadorEditaVeiculos ?? PERMISSOES_PADRAO.editaVeiculos,
        criaContas: pat.jogadorCriaContas ?? PERMISSOES_PADRAO.criaContas,
        compraVenda: fin.jogadorCompraVenda ?? PERMISSOES_PADRAO.compraVenda,
        pix: fin.jogadorPix ?? PERMISSOES_PADRAO.pix,
      });
    } catch { /* permanece null → fail-closed */ }
  }, [campaignId]);

  useEffect(() => { void carregarPermissoes(); }, [carregarPermissoes]);

  const avisoErro = (e: unknown) => setErro(e instanceof Error ? e.message : "Erro");

  useEffect(() => {
    const socket = getSocket();
    socket.emit("entrar-campanha", campaignId, () => undefined);
    const aoMudar = () => recarregarRef.fn?.();
    // Qualquer alteração de regras (inclusive permissões granulares)
    // dispara refetch fail-closed — a UI nunca exibe controle cuja
    // autorização ainda não foi reconfirmada pelo servidor.
    const aoRegras = () => void carregarPermissoes();
    socket.on("patrimonio:atualizado", aoMudar);
    socket.on("inventario:atualizado", aoMudar);
    socket.on("regras:atualizadas", aoRegras);
    return () => {
      socket.off("patrimonio:atualizado", aoMudar);
      socket.off("inventario:atualizado", aoMudar);
      socket.off("regras:atualizadas", aoRegras);
      socket.emit("sair-campanha", campaignId);
    };
  }, [campaignId, recarregarRef, carregarPermissoes]);

  const abas: [Aba, string][] = [
    ["inventario", "Inventário"],
    ["equipamentos", "Equipamentos"],
    ["veiculos", "Veículos"],
    ["dinheiro", "Dinheiro"],
    ...(souMestre ? [["catalogo", "Catálogo"] as [Aba, string]] : []),
  ];

  return (
    <section className="cartao">
      <h3>Patrimônio</h3>
      <div className="abas">
        {abas.map(([id, label]) => (
          <button key={id} className={aba === id ? "ativo" : "secundario"} onClick={() => setAba(id)}>{label}</button>
        ))}
      </div>
      {erro && <p className="erro">{erro}</p>}
      {aba === "inventario" && <Inventario characterId={characterId} campaignId={campaignId} souMestre={souMestre} somenteLeitura={somenteLeitura} permissoes={permissoes} aoErro={avisoErro} recarregarRef={recarregarRef} />}
      {aba === "equipamentos" && <Equipamentos characterId={characterId} souMestre={souMestre} somenteLeitura={somenteLeitura} permissoes={permissoes} aoErro={avisoErro} recarregarRef={recarregarRef} />}
      {aba === "veiculos" && <Veiculos characterId={characterId} campaignId={campaignId} souMestre={souMestre} somenteLeitura={somenteLeitura} permissoes={permissoes} aoErro={avisoErro} recarregarRef={recarregarRef} />}
      {aba === "dinheiro" && <Dinheiro characterId={characterId} campaignId={campaignId} souMestre={souMestre} somenteLeitura={somenteLeitura} permissoes={permissoes} aoErro={avisoErro} recarregarRef={recarregarRef} />}
      {aba === "catalogo" && <Catalogo campaignId={campaignId} souMestre={souMestre} somenteLeitura={somenteLeitura} aoErro={avisoErro} recarregarRef={recarregarRef} />}
    </section>
  );
}

// ================= INVENTÁRIO =================

function Inventario({ characterId, campaignId, souMestre, somenteLeitura = false, permissoes, aoErro, recarregarRef }: {
  characterId: string; campaignId: string; souMestre: boolean; somenteLeitura?: boolean;
  permissoes: PermissoesPatrimonio | null;
  aoErro: (e: unknown) => void;
  recarregarRef: { fn?: () => Promise<void> };
}) {
  const [itens, setItens] = useState<ItemInventario[]>([]);
  const [pesoTotal, setPesoTotal] = useState<number | null>(null);
  const [pesoMax, setPesoMax] = useState<number | null>(null);
  const [pesoExcedido, setPesoExcedido] = useState(false);
  const [catalogo, setCatalogo] = useState<{ id: string; name: string; category: string | null; data: Record<string, unknown> }[]>([]);
  const [acervo, setAcervo] = useState<AcervoCatalogoItem[]>([]);
  const [requisitos, setRequisitos] = useState<Record<string, DisponibilidadeAcervo>>({});
  const [busca, setBusca] = useState("");
  const [filtroCat, setFiltroCat] = useState("");
  const [personagens, setPersonagens] = useState<PersonagemResumo[]>([]);
  const [novo, setNovo] = useState<ItemInventarioInput>({ name: "", quantity: 1 });
  const [editando, setEditando] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [confirmandoItem, setConfirmandoItem] = useState<ItemInventario | null>(null);
  const [ocupadoItem, setOcupadoItem] = useState(false);
  const [fin, setFin] = useState<Financeiro | null>(null);
  const [comprando, setComprando] = useState(false);
  const [vendendo, setVendendo] = useState<ItemInventario | null>(null);
  const [estornandoItem, setEstornandoItem] = useState<ItemInventario | null>(null);
  const [ocupadoEstornoItem, setOcupadoEstornoItem] = useState(false);
  // Idempotência de equipar: uma intenção = um requestId, reutilizado em
  // duplo clique e retries; uma nova ação após sucesso gera outro ID.
  const equipReqIds = useRef(new Map<string, string>()).current;
  const equiparUnidade = async (itemId: string) => {
    if (!equipReqIds.has(itemId)) equipReqIds.set(itemId, crypto.randomUUID());
    const rid = equipReqIds.get(itemId)!;
    try {
      await api.equiparItem(characterId, itemId, slots[0], rid);
      equipReqIds.delete(itemId);
      await carregar();
    } catch (e) { aoErro(e); }
  };

  const carregar = useCallback(async () => {
    try {
      const [inv, cat, pers, reqs] = await Promise.all([
        api.listarInventario(characterId),
        api.listarCatalogo(campaignId).catch((): { itens: never[]; categorias: never[]; acervo: AcervoCatalogoItem[] } => ({ itens: [], categorias: [], acervo: [] })),
        api.listarPersonagens(campaignId).catch(() => ({ personagens: [] })),
        api.listarRequisitosPatrimonio(characterId).catch(() => ({ requisitos: {} })),
      ]);
      setItens(inv.itens); setPesoTotal(inv.pesoTotal); setPesoMax(inv.pesoMaximo); setPesoExcedido(inv.pesoExcedido);
      setCatalogo(cat.itens); setAcervo(cat.acervo ?? []); setPersonagens(pers.personagens);
      setRequisitos(reqs.requisitos);
    } catch (e) { aoErro(e); }
  }, [characterId, campaignId, aoErro]);

  const carregarFin = useCallback(async () => {
    try { setFin(await api.obterFinanceiro(characterId)); }
    catch (e) { aoErro(e); }
  }, [characterId, aoErro]);

  useEffect(() => { void carregar(); recarregarRef.fn = carregar; }, [carregar, recarregarRef]);
  useEffect(() => { api.listarEquipamentos(characterId).then((r) => setSlots(r.slots)).catch(() => undefined); }, [characterId]);
  useEffect(() => { void carregarFin(); }, [carregarFin]);

  const acervoItens = acervo.filter((e) => e.regra.kind === "item");
  const dispDe = (regra?: { kind: string; key: string }) =>
    regra ? requisitos[`${regra.kind}:${regra.key}`] : undefined;
  const textoRequisito = (e?: AcervoCatalogoItem) =>
    !e ? "" : e.prerequisitos.length
      ? "Requisito: " + e.prerequisitos.map((p) => `${p.nome} ${p.minLevel}`).join(" + ")
      : "Sem pré-requisitos";
  const detalheRequisito = (e?: AcervoCatalogoItem) => {
    if (!e) return "";
    const d = dispDe(e.regra);
    if (!d) return textoRequisito(e);
    if (d.prerequisitos.length === 0) return "Sem pré-requisitos";
    return "Requisito: " + d.prerequisitos
      .map((p) => `${p.nome} nível ${p.minLevel} — personagem: ${p.nivelAtual}${p.atendido ? "" : " ✗"}`)
      .join(" + ");
  };
  const categorias = [...new Set([...itens.map((i) => i.category).filter(Boolean) as string[], ...catalogo.map((c) => c.category).filter(Boolean) as string[]])].sort();
  const visiveis = itens.filter((i) =>
    (!filtroCat || i.category === filtroCat) &&
    (!busca || i.name.toLowerCase().includes(busca.toLowerCase()) || (i.description ?? "").toLowerCase().includes(busca.toLowerCase()))
  );

  // Issue #165: cada ação consulta a permissão granular exata. O mestre
  // mantém capacidade administrativa; somenteLeitura continua barreira total.
  const podeAdicionar = souMestre || permissoes?.adicionaItens === true;
  const podeRemover = souMestre || permissoes?.removeItens === true;
  const podeEquiparItem = souMestre || permissoes?.editaEquipamentos === true;
  const podeReceberDeOutros = souMestre || permissoes?.adicionaItens === true;
  const podeTransferir = souMestre || permissoes?.removeItens === true;
  const podeAjustarQuantidade = (atual: number, novoQ: number) =>
    novoQ < atual ? podeRemover : podeAdicionar; // PATCH: redução→removeItens, demais→adicionaItens

  const submeterNovo = async (e: FormEvent) => {
    e.preventDefault();
    if (!podeAdicionar) { aoErro(new Error("Adicionar itens não é permitido nesta campanha.")); return; }
    try {
      await api.adicionarItem(characterId, novo);
      setNovo({ name: "", quantity: 1 });
      await carregar();
    } catch (err) { aoErro(err); }
  };

  const qtd = (_item: ItemInventario, data: Record<string, unknown>) => Number(data.valueCents ?? 0);
  const podeOperar = !somenteLeitura && (souMestre || permissoes?.compraVenda === true);
  // Compra registrada com pagar=false: sem transação financeira, o
  // estorno só é localizável pelo operacaoId gravado nos dados do item.
  const compraSemPagamento = (item: ItemInventario) => {
    const d = item.data ?? {};
    const aq = d.aquisicao as { semPagamento?: boolean } | undefined;
    return aq?.semPagamento === true && typeof d.operacaoId === "string";
  };
  const operacaoIdDe = (item: ItemInventario) => (item.data?.operacaoId as string | undefined) ?? null;
  const confirmarEstornoItem = async () => {
    const opId = estornandoItem ? operacaoIdDe(estornandoItem) : null;
    if (!opId || ocupadoEstornoItem) return;
    setOcupadoEstornoItem(true);
    try {
      await api.estornarOperacao(characterId, opId);
      setEstornandoItem(null);
      await carregar();
      await carregarFin();
    } catch (e) { aoErro(e); } finally { setOcupadoEstornoItem(false); }
  };

  return (
    <div>
      {pesoTotal !== null && (
        <p className={`meta ${pesoExcedido ? "erro" : ""}`}>
          Peso: {pesoTotal.toFixed(1)} / {pesoMax} kg{pesoExcedido ? " — peso excedido" : ""}
        </p>
      )}
      <div className="linha">
        <input placeholder="Buscar item…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select aria-label="Filtrar por categoria" value={filtroCat} onChange={(e) => setFiltroCat(e.target.value)}>
          <option value="">Todas as categorias</option>
          {categorias.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {!somenteLeitura && (
      <form className="formulario linha" onSubmit={submeterNovo}>
        <select aria-label="Item do Acervo" value={novo.regra?.key ?? ""} onChange={(e) => {
          const key = e.target.value;
          if (!key) { setNovo({ ...novo, name: "", category: undefined, regra: undefined }); return; }
          const el = acervoItens.find((x) => x.regra.key === key);
          if (el) setNovo({ name: el.nome, quantity: 1, category: el.categoria ?? undefined, regra: el.regra });
        }}>
          <option value="">Cadastro livre…</option>
          {acervoItens.map((el) => {
            const d = dispDe(el.regra);
            return <option key={el.regra.key} value={el.regra.key}>{el.nome}{d && d.prerequisitos.length ? ` — ${d.prerequisitos.map((p) => `${p.nome} ${p.nivelAtual}/${p.minLevel}`).join(" + ")}` : el.prerequisitos.length ? ` — exige ${el.prerequisitos.map((p) => `${p.nome} ${p.minLevel}`).join(" + ")}` : ""}</option>;
          })}
        </select>
        <input placeholder={novo.regra ? "Nome definido pelo Acervo" : "Nome do item"} value={novo.name} disabled={!!novo.regra} onChange={(e) => setNovo({ ...novo, name: e.target.value })} required />
        <input type="number" min="0.01" step="any" placeholder="Qtd" value={novo.quantity} onChange={(e) => setNovo({ ...novo, quantity: Number(e.target.value) })} style={{ width: 80 }} />
        <input placeholder="Categoria" value={novo.category ?? ""} onChange={(e) => setNovo({ ...novo, category: e.target.value })} list="cats-inv" />
        <datalist id="cats-inv">{categorias.map((c) => <option key={c} value={c} />)}</datalist>
        <input placeholder="Peso (kg)" type="number" min="0" step="any" value={novo.weight ?? ""} onChange={(e) => setNovo({ ...novo, weight: e.target.value === "" ? undefined : Number(e.target.value) })} style={{ width: 110 }} />
        <input placeholder="Local" value={novo.location ?? ""} onChange={(e) => setNovo({ ...novo, location: e.target.value })} />
        <button type="submit" disabled={!podeAdicionar || !!(novo.regra && dispDe(novo.regra) && !dispDe(novo.regra)!.ok)}>Adicionar</button>
        {podeOperar && <button type="button" className="secundario" onClick={() => setComprando(true)}>Comprar…</button>}
      </form>
      )}
      {novo.regra && (() => {
        const el = acervoItens.find((x) => x.regra!.key === novo.regra!.key);
        const d = dispDe(novo.regra);
        return (
          <p className={`meta ${d && !d.ok ? "erro" : ""}`}>
            {detalheRequisito(el)}
            {d && !d.ok && <> Aquisição indisponível. {d.mensagens.join(" ")}</>}
          </p>
        );
      })()}
      <table className="tabela tabela-responsiva">
        <thead><tr><th>Item</th><th>Qtd</th><th>Categoria</th><th>Peso</th><th>Local</th><th></th></tr></thead>
        <tbody>
          {visiveis.map((item) => (
            <tr key={item.id}>
              <td>
                {item.name}
                {item.description && <div className="meta">{item.description}</div>}
                {item.data?.equipped === true && <span className="tag">equipado</span>}
                {qtd(item, item.data) > 0 && <span className="tag">{fmtMoeda(qtd(item, item.data))}</span>}
              </td>
              <td>
                {somenteLeitura || !(podeAdicionar || podeRemover) ? <span>{item.quantity}</span> : editando === item.id ? (
                  <input type="number" min="0.01" step="any" defaultValue={item.quantity} style={{ width: 70 }} aria-label="Quantidade"
                    onBlur={async (e) => {
                      const q = Number(e.target.value);
                      if (q === item.quantity) { setEditando(null); return; }
                      if (!podeAjustarQuantidade(item.quantity, q)) {
                        setEditando(null);
                        aoErro(new Error(q > item.quantity
                          ? "Aumentar a quantidade exige permissão de adicionar itens."
                          : "Diminuir a quantidade exige permissão de remover itens."));
                        return;
                      }
                      try { await api.atualizarItem(characterId, item.id, { quantity: q }); setEditando(null); await carregar(); }
                      catch (err) { aoErro(err); }
                    }} />
                ) : (
                  <span className="clicavel" onClick={() => setEditando(item.id)}>{item.quantity}</span>
                )}
              </td>
              <td>{item.category ?? "—"}</td>
              <td>{item.weight != null ? `${item.weight} kg` : "—"}</td>
              <td>{item.location ?? "—"}</td>
              <td className="linha">
                {!somenteLeitura && <>
                {podeEquiparItem && <button className="secundario" title="Equipar" onClick={() => { void equiparUnidade(item.id); }}>Equipar</button>}
                {podeOperar && <button className="secundario" onClick={() => setVendendo(item)}>Vender</button>}
                {podeOperar && compraSemPagamento(item) && (
                  <button className="secundario" onClick={() => setEstornandoItem(item)}>Estornar compra</button>
                )}
                {podeTransferir && <TransferirButton item={item} personagens={personagens} proprioId={characterId} souMestre={souMestre} podeReceberDeOutros={podeReceberDeOutros} onTransfer={async (dest, q) => {
                  await api.transferirItem(characterId, item.id, dest, q);
                  await carregar();
                }} aoErro={aoErro} />}
                {podeRemover && <button className="perigo" onClick={() => setConfirmandoItem(item)}>×</button>}
                </>}
              </td>
            </tr>
          ))}
          {visiveis.length === 0 && <tr><td colSpan={6} className="meta">Inventário vazio.</td></tr>}
        </tbody>
      </table>
      <div className="cartoes-registro">
        {visiveis.map((item) => (
          <div key={item.id} className="registro-cartao">
            <div className="registro-campo">
              <strong>{item.name}</strong>
              <span>
                {item.data?.equipped === true && <span className="tag">equipado</span>}
                {qtd(item, item.data) > 0 && <span className="tag">{fmtMoeda(qtd(item, item.data))}</span>}
              </span>
            </div>
            {item.description && <p className="meta">{item.description}</p>}
            <div className="registro-campo">
              <span className="registro-rotulo">Qtd</span>
              {somenteLeitura || !(podeAdicionar || podeRemover) ? <span>{item.quantity}</span> : editando === item.id ? (
                <input type="number" min="0.01" step="any" defaultValue={item.quantity} style={{ width: 90 }} aria-label="Quantidade"
                  onBlur={async (e) => {
                    const q = Number(e.target.value);
                    if (q === item.quantity) { setEditando(null); return; }
                    if (!podeAjustarQuantidade(item.quantity, q)) {
                      setEditando(null);
                      aoErro(new Error(q > item.quantity
                        ? "Aumentar a quantidade exige permissão de adicionar itens."
                        : "Diminuir a quantidade exige permissão de remover itens."));
                      return;
                    }
                    try { await api.atualizarItem(characterId, item.id, { quantity: q }); setEditando(null); await carregar(); }
                    catch (err) { aoErro(err); }
                  }} />
              ) : (
                <span className="clicavel" onClick={() => setEditando(item.id)}>{item.quantity}</span>
              )}
            </div>
            <div className="registro-campo"><span className="registro-rotulo">Categoria</span><span>{item.category ?? "—"}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Peso</span><span>{item.weight != null ? `${item.weight} kg` : "—"}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Local</span><span>{item.location ?? "—"}</span></div>
            {!somenteLeitura && (
            <div className="registro-acoes">
              {podeEquiparItem && <button className="secundario" title="Equipar" onClick={() => { void equiparUnidade(item.id); }}>Equipar</button>}
              {podeOperar && <button className="secundario" onClick={() => setVendendo(item)}>Vender</button>}
              {podeOperar && compraSemPagamento(item) && (
                <button className="secundario" onClick={() => setEstornandoItem(item)}>Estornar compra</button>
              )}
              {podeTransferir && <TransferirButton item={item} personagens={personagens} proprioId={characterId} souMestre={souMestre} podeReceberDeOutros={podeReceberDeOutros} onTransfer={async (dest, q) => {
                await api.transferirItem(characterId, item.id, dest, q);
                await carregar();
              }} aoErro={aoErro} />}
              {podeRemover && <button className="perigo" onClick={() => setConfirmandoItem(item)}>×</button>}
            </div>
            )}
          </div>
        ))}
        {visiveis.length === 0 && <p className="meta">Inventário vazio.</p>}
      </div>
      {confirmandoItem && (
        <ModalConfirmar
          titulo="Remover item"
          mensagem={`Remover "${confirmandoItem.name}"?`}
          rotuloConfirmar="Remover"
          perigo
          ocupado={ocupadoItem}
          aoConfirmar={() => {
            if (ocupadoItem) return;
            setOcupadoItem(true);
            api.removerItem(characterId, confirmandoItem.id)
              .then(async () => { setConfirmandoItem(null); await carregar(); })
              .catch((e) => aoErro(e))
              .finally(() => setOcupadoItem(false));
          }}
          aoCancelar={() => { if (!ocupadoItem) setConfirmandoItem(null); }}
        />
      )}
      {estornandoItem && (
        <ModalConfirmar
          titulo="Estornar compra"
          mensagem={`Estornar a compra de "${estornandoItem.name}"? O item será removido do patrimônio. Como a compra foi feita sem pagamento, nenhum saldo financeiro será alterado.`}
          rotuloConfirmar="Estornar compra"
          perigo
          ocupado={ocupadoEstornoItem}
          aoConfirmar={() => void confirmarEstornoItem()}
          aoCancelar={() => { if (!ocupadoEstornoItem) setEstornandoItem(null); }}
        />
      )}
      {comprando && (
        <ModalCompra
          characterId={characterId}
          catalogo={catalogo}
          acervo={acervoItens}
          requisitos={requisitos}
          fin={fin}
          aoErro={aoErro}
          aoOk={async () => { setComprando(false); await carregar(); await carregarFin(); }}
          aoFechar={() => setComprando(false)}
        />
      )}
      {vendendo && (
        <ModalVenda
          characterId={characterId}
          item={vendendo}
          fin={fin}
          aoErro={aoErro}
          aoOk={async () => { setVendendo(null); await carregar(); await carregarFin(); }}
          aoFechar={() => setVendendo(null)}
        />
      )}
    </div>
  );
}

function TransferirButton({ item, personagens, proprioId, souMestre, podeReceberDeOutros, onTransfer, aoErro }: {
  item: ItemInventario; personagens: PersonagemResumo[]; proprioId: string; souMestre: boolean;
  podeReceberDeOutros: boolean;
  onTransfer: (destinoId: string, quantidade?: number) => Promise<void>;
  aoErro: (e: unknown) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [destino, setDestino] = useState("");
  const [qtd, setQtd] = useState<number | undefined>(undefined);
  // Backend: tirar o item exige jogadorRemoveItens; colocar no patrimônio
  // de OUTRO jogador exige também jogadorAdicionaItens. Personagens do
  // próprio usuário (ehEu) dispensam a segunda permissão.
  const outros = personagens.filter((p) => p.id !== proprioId && (podeReceberDeOutros || p.ehEu));
  if (!souMestre && (item.data?.transferable === false)) return null;
  if (outros.length === 0) return null;
  return (
    <>
      <button className="secundario" onClick={() => setAberto(true)}>Transferir</button>
      {aberto && (
        <div className="modal-fundo" onClick={() => setAberto(false)}>
          <div className="modal cartao" onClick={(e) => e.stopPropagation()}>
            <h4>Transferir "{item.name}"</h4>
            <label>Para
              <select value={destino} onChange={(e) => setDestino(e.target.value)}>
                <option value="">Escolher personagem…</option>
                {outros.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.displayName ?? p.dono})</option>)}
              </select>
            </label>
            <label>Quantidade (vazio = tudo)
              <input type="number" min="0.01" step="any" max={item.quantity} value={qtd ?? ""} onChange={(e) => setQtd(e.target.value === "" ? undefined : Number(e.target.value))} />
            </label>
            <div className="linha">
              <button disabled={!destino} onClick={async () => {
                try { await onTransfer(destino, qtd); setAberto(false); } catch (e) { aoErro(e); }
              }}>Confirmar</button>
              <button className="secundario" onClick={() => setAberto(false)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ================= COMPRA / VENDA COM CONTA =================

const fmtOp = (v: number, casas: number) => v.toFixed(casas);

function ModalCompra({ characterId, catalogo, acervo = [], requisitos = {}, fin, aoErro, aoOk, aoFechar }: {
  characterId: string;
  catalogo: { id: string; name: string; category: string | null; data: Record<string, unknown> }[];
  acervo?: AcervoCatalogoItem[];
  requisitos?: Record<string, DisponibilidadeAcervo>;
  fin: Financeiro | null;
  aoErro: (e: unknown) => void;
  aoOk: () => Promise<void>;
  aoFechar: () => void;
}) {
  const [templateId, setTemplateId] = useState("");
  const [acervoSel, setAcervoSel] = useState<AcervoCatalogoItem | null>(null);
  const [nome, setNome] = useState("");
  const [qtd, setQtd] = useState(1);
  const [valorUnit, setValorUnit] = useState<number | "">("");
  const [contaId, setContaId] = useState("");
  const [pagar, setPagar] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const reqId = useRef(crypto.randomUUID()).current;
  const casas = fin?.config.casasDecimais ?? 2;
  // Resolve tanto a seleção avulsa quanto o vínculo salvo pelo mestre
  // no template. A UI falha fechado quando o vínculo não pode ser resolvido
  // ou a disponibilidade do personagem ainda não foi calculada.
  const templateSel = templateId ? catalogo.find((item) => item.id === templateId) : undefined;
  const regraTemplateRaw = templateSel?.data?.regra;
  const temRegraTemplate = regraTemplateRaw !== undefined && regraTemplateRaw !== null;
  const regraTemplate = regraTemplateRaw && typeof regraTemplateRaw === "object" &&
    typeof (regraTemplateRaw as RegraRef).kind === "string" &&
    typeof (regraTemplateRaw as RegraRef).key === "string"
      ? regraTemplateRaw as RegraRef
      : undefined;
  const regraTemplateInvalida = temRegraTemplate && !regraTemplate;
  const itemTemplateAcervo = regraTemplate
    ? acervo.find((item) => item.regra.kind === regraTemplate.kind && item.regra.key === regraTemplate.key)
    : undefined;
  const itemAcervoSelecionado = templateId ? itemTemplateAcervo : acervoSel ?? undefined;
  const regraSelecionada = templateId ? regraTemplate : acervoSel?.regra;
  const dispSel = regraSelecionada
    ? requisitos[`${regraSelecionada.kind}:${regraSelecionada.key}`]
    : undefined;
  const templateApontaVeiculo = !!(templateId && regraTemplate && regraTemplate.kind !== "item");
  const templateSemElemento = !!(templateId && temRegraTemplate && regraTemplate && !itemTemplateAcervo);
  const templateSemDisponibilidade = !!(templateId && temRegraTemplate && regraTemplate && itemTemplateAcervo && !dispSel);
  const bloqueado = regraTemplateInvalida || templateApontaVeiculo || templateSemElemento ||
    templateSemDisponibilidade || (!!regraSelecionada && (!dispSel || !dispSel.ok));
  const contaSel = fin?.contas.find((c) => c.id === contaId);
  const moeda = contaSel?.currency ?? fin?.config.moedaPrincipal ?? "";
  // Ponte econômica (Issue #103): preço/peso de referência do Acervo
  // (template vinculado ou elemento direto) é SUGESTÃO — o valor
  // debitado é sempre o confirmado pelo mestre neste formulário.
  const econRef: EconomiaAcervo | undefined = templateId
    ? (templateSel?.data as (EconomiaAcervo & Record<string, unknown>) | undefined)
    : itemAcervoSelecionado ?? undefined;
  const refBRL = (() => {
    // Mesma precedência do editor: valueCents (override local efetivo)
    // primeiro; economia.precoReferenciaBRL é fallback — uma atualização
    // parcial que mude só um dos campos não pode exibir o valor antigo.
    // valueCents: 0 é override explícito (item sem custo) — não pode
    // cair para a referência antiga do Acervo. Number(null) seria 0,
    // por isso o teste é typeof, não coerção.
    const vc = econRef?.valueCents;
    if (typeof vc === "number" && Number.isFinite(vc) && vc >= 0) return vc / 100;
    const p = econRef?.economia?.precoReferenciaBRL;
    return typeof p === "number" && Number.isFinite(p) ? p : undefined;
  })();
  const refFaixa = econRef?.economia?.faixaPrecoBRL ?? undefined;
  const refPeso = typeof econRef?.weight === "number" ? econRef.weight : undefined;
  const total = (Number(qtd) || 0) * (Number(valorUnit) || 0);
  const valido = !bloqueado && (templateId !== "" || acervoSel !== null || nome.trim().length > 0) && Number(qtd) > 0 &&
    (pagar ? !!contaId && Number(valorUnit) > 0 : true);
  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    if (ocupado || !valido) return;
    setOcupado(true);
    try {
      await api.operacaoFinanceira(characterId, {
        tipo: "compra", accountId: pagar ? contaId : undefined,
        valor: pagar ? total : (total > 0 ? total : undefined),
        pagar, quantidade: Number(qtd),
        templateId: templateId || undefined,
        item: templateId ? undefined : acervoSel
          ? { name: acervoSel.nome, quantity: 1, regra: acervoSel.regra }
          : { name: nome.trim(), quantity: 1 },
        requestId: reqId,
      });
      await aoOk();
    } catch (err) { aoErro(err); } finally { setOcupado(false); }
  };
  return (
    <div className="modal-fundo" onClick={() => { if (!ocupado) aoFechar(); }}>
      <div className="modal cartao" onClick={(e) => e.stopPropagation()}>
        <h4>Comprar item</h4>
        <form className="formulario" onSubmit={submeter}>
          <label>Item do catálogo
            <select value={templateId} onChange={(e) => {
              setTemplateId(e.target.value);
              setAcervoSel(null);
            }}>
              <option value="">Item avulso…</option>
              {catalogo.map((item) => {
                const regra = item.data?.regra as RegraRef | undefined;
                const disponibilidade = regra ? requisitos[`${regra.kind}:${regra.key}`] : undefined;
                const sufixo = regra
                  ? regra.kind !== "item" ? " — veículo (use a aba Veículos)"
                    : disponibilidade?.ok ? " — requisito atendido"
                    : " — aquisição indisponível"
                  : "";
                return <option key={item.id} value={item.id}>
                  {item.name}{item.category ? ` (${item.category})` : ""}{sufixo}
                </option>;
              })}
            </select>
          </label>
          {templateId === "" && (
            <label>Item do Acervo
              <select value={acervoSel?.regra.key ?? ""} onChange={(e) => {
                const el = acervo.find((x) => x.regra.key === e.target.value) ?? null;
                setAcervoSel(el);
                if (el) setNome(el.nome);
              }}>
                <option value="">Item avulso…</option>
                {acervo.map((el) => {
                const d = requisitos[`${el.regra.kind}:${el.regra.key}`];
                return <option key={el.regra.key} value={el.regra.key}>{el.nome}{d && d.prerequisitos.length ? ` — ${d.prerequisitos.map((pr) => `${pr.nome} ${pr.nivelAtual}/${pr.minLevel}`).join(" + ")}` : el.prerequisitos.length ? ` — exige ${el.prerequisitos.map((pr) => `${pr.nome} ${pr.minLevel}`).join(" + ")}` : ""}</option>;
              })}
              </select>
            </label>
          )}
          {itemAcervoSelecionado && (
            <p className={`meta ${bloqueado ? "erro" : ""}`}>
              {dispSel && dispSel.prerequisitos.length
                ? "Requisito: " + dispSel.prerequisitos.map((pr) => `${pr.nome} nível ${pr.minLevel} — personagem: ${pr.nivelAtual}`).join(" + ")
                : itemAcervoSelecionado.prerequisitos.length
                  ? "Requisito: " + itemAcervoSelecionado.prerequisitos.map((pr) => `${pr.nome} nível ${pr.minLevel}`).join(" + ")
                  : "Sem pré-requisitos."}
              {bloqueado && <> Aquisição indisponível. {dispSel?.mensagens.join(" ") ?? (
                templateApontaVeiculo
                  ? "Este template está vinculado a um veículo. Faça a aquisição pela aba Veículos."
                  : regraTemplateInvalida
                    ? "O vínculo do Acervo no catálogo é inválido. Peça ao mestre para revisar o template."
                    : templateSemElemento
                      ? "O elemento vinculado não está ativo ou não existe nas regras desta campanha."
                      : "Não foi possível verificar os pré-requisitos. Atualize o patrimônio ou peça ao mestre para revisar o vínculo."
              )}</>}
            </p>
          )}
          {templateId !== "" && !temRegraTemplate && (
            <p className="meta">Template manual — sem vínculo com pré-requisitos do Acervo.</p>
          )}
          {templateId !== "" && bloqueado && !itemAcervoSelecionado && (
            <p className="meta erro">
              Aquisição indisponível. {templateApontaVeiculo
                ? "Este template está vinculado a um veículo. Faça a aquisição pela aba Veículos."
                : regraTemplateInvalida
                  ? "O vínculo do Acervo no catálogo é inválido. Peça ao mestre para revisar o template."
                  : "O elemento vinculado não está ativo ou não existe nas regras desta campanha. Peça ao mestre para revisar o catálogo."}
            </p>
          )}
          {templateId === "" && acervoSel === null && (
            <label>Nome do item
              <input value={nome} onChange={(e) => setNome(e.target.value)} required />
            </label>
          )}
          <label>Quantidade
            <input type="number" min="0.01" step="any" value={qtd} onChange={(e) => setQtd(Number(e.target.value))} required />
          </label>
          <label>Valor unitário ({moeda}){pagar ? "" : " (referência, opcional)"}
            <input type="number" min="0" step="any" placeholder="0,00" value={valorUnit} onChange={(e) => setValorUnit(e.target.value === "" ? "" : Number(e.target.value))} required={pagar} />
          </label>
          {refBRL !== undefined && (
            <p className="meta">
              Referência do Acervo: R$ {refBRL.toFixed(2)} (BRL)
              {refFaixa ? ` — faixa R$ ${refFaixa.min.toFixed(2)}–${refFaixa.max.toFixed(2)}` : ""}.
              {" "}{moeda === "BRL"
                ? "É apenas sugestão — confirme o valor efetivamente pago."
                : `Referência em BRL é apenas informativa — a cobrança segue a moeda da conta (${moeda}), sem conversão automática.`}
            </p>
          )}
          {refBRL !== undefined && moeda === "BRL" && valorUnit === "" && (
            <button type="button" className="secundario" onClick={() => setValorUnit(refBRL)}>Usar valor de referência</button>
          )}
          {refPeso !== undefined && <p className="meta">Peso de referência do Acervo: {refPeso} kg.</p>}
          <label className="check">
            <input type="checkbox" checked={pagar} onChange={(e) => setPagar(e.target.checked)} />
            {" "}Pagar agora — debitar conta financeira
          </label>
          {pagar ? (
            <label>Conta que paga
              <select value={contaId} onChange={(e) => setContaId(e.target.value)} required>
                <option value="">Escolher conta…</option>
                {(fin?.contas ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name} — saldo {fmtOp(c.balanceCents / 10 ** casas, casas)} {c.currency}</option>
                ))}
              </select>
            </label>
          ) : (
            <p className="meta">Compra sem movimentação financeira — nenhum débito será registrado.</p>
          )}
          {pagar && contaSel && (
            <p className="meta">
              Saldo disponível: {fmtOp(contaSel.balanceCents / 10 ** casas, casas)} {contaSel.currency}.
              {" "}Será debitado {fmtOp(total, casas)} {moeda}.
            </p>
          )}
          {total > 0 && <p className="meta">Total: {fmtOp(total, casas)} {moeda}{pagar ? "" : " (referência)"}</p>}
          <div className="linha">
            <button type="submit" disabled={!valido || ocupado}>{ocupado ? "Processando…" : pagar ? "Confirmar compra" : "Confirmar compra sem pagamento"}</button>
            <button type="button" className="secundario" onClick={aoFechar} disabled={ocupado}>Cancelar</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ModalVenda({ characterId, item, fin, aoErro, aoOk, aoFechar }: {
  characterId: string;
  item: ItemInventario;
  fin: Financeiro | null;
  aoErro: (e: unknown) => void;
  aoOk: () => Promise<void>;
  aoFechar: () => void;
}) {
  const [qtd, setQtd] = useState(1);
  const [valorUnit, setValorUnit] = useState<number | "">("");
  const [contaId, setContaId] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const reqId = useRef(crypto.randomUUID()).current;
  const casas = fin?.config.casasDecimais ?? 2;
  const contaSel = fin?.contas.find((c) => c.id === contaId);
  const moeda = contaSel?.currency ?? fin?.config.moedaPrincipal ?? "";

  useEffect(() => {
    if (fin && valorUnit === "") {
      const d = item.data ?? {};
      const aq = d.aquisicao as { formato?: string; unitCents?: number | null } | undefined;
      let inicial: number | "" = "";
      if (aq?.formato === "unitario-v1") {
        // Formato novo: unitCents só existe quando o unitário é
        // representável em centavos — caso contrário sem sugestão.
        const uc = Number(aq.unitCents);
        if (Number.isFinite(uc) && uc > 0) inicial = +(uc / 10 ** casas).toFixed(casas);
      } else if (d.origem !== "compra") {
        // Item manual: valueCents é a referência unitária informada.
        // Item legado de compra (sem aquisicao): valueCents era o TOTAL —
        // sem quantidade original não há unitário confiável → vazio.
        const vc = Number(d.valueCents ?? 0);
        if (vc > 0) inicial = +(vc / 10 ** casas).toFixed(casas);
      }
      if (inicial !== "") setValorUnit(inicial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fin]);

  const total = (Number(qtd) || 0) * (Number(valorUnit) || 0);
  const valido = !!contaId && Number(qtd) > 0 && Number(qtd) <= item.quantity && Number(valorUnit) > 0;
  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    if (ocupado || !valido) return;
    setOcupado(true);
    try {
      await api.operacaoFinanceira(characterId, {
        tipo: "venda", accountId: contaId, valor: total,
        itemId: item.id, quantidade: Number(qtd), requestId: reqId,
      });
      await aoOk();
    } catch (err) { aoErro(err); } finally { setOcupado(false); }
  };
  return (
    <div className="modal-fundo" onClick={() => { if (!ocupado) aoFechar(); }}>
      <div className="modal cartao" onClick={(e) => e.stopPropagation()}>
        <h4>Vender "{item.name}"</h4>
        <p className="meta">Disponível: {item.quantity} un.</p>
        <form className="formulario" onSubmit={submeter}>
          <label>Quantidade
            <input type="number" min="0.01" max={item.quantity} step="any" value={qtd} onChange={(e) => setQtd(Number(e.target.value))} required />
          </label>
          <label>Valor unitário ({moeda})
            <input type="number" min="0" step="any" placeholder="0,00" value={valorUnit} onChange={(e) => setValorUnit(e.target.value === "" ? "" : Number(e.target.value))} required />
          </label>
          <label>Conta que recebe
            <select value={contaId} onChange={(e) => setContaId(e.target.value)} required>
              <option value="">Escolher conta…</option>
              {(fin?.contas ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name} — saldo {fmtOp(c.balanceCents / 10 ** casas, casas)} {c.currency}</option>
              ))}
            </select>
          </label>
          {contaSel && (
            <p className="meta">
              Saldo da conta: {fmtOp(contaSel.balanceCents / 10 ** casas, casas)} {contaSel.currency}.
              {" "}Será creditado {fmtOp(total, casas)} {moeda}.
            </p>
          )}
          <p className="meta">Total a receber: {fmtOp(total, casas)} {moeda}</p>
          <div className="linha">
            <button type="submit" disabled={!valido || ocupado}>{ocupado ? "Processando…" : "Confirmar venda"}</button>
            <button type="button" className="secundario" onClick={aoFechar} disabled={ocupado}>Cancelar</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ================= EQUIPAMENTOS =================

function Equipamentos({ characterId, souMestre, somenteLeitura = false, permissoes, aoErro, recarregarRef }: {
  characterId: string; souMestre: boolean; somenteLeitura?: boolean; permissoes: PermissoesPatrimonio | null;
  aoErro: (e: unknown) => void;
  recarregarRef: { fn?: () => Promise<void> };
}) {
  const [lista, setLista] = useState<Equipamento[]>([]);
  const podeEditar = souMestre || permissoes?.editaEquipamentos === true;
  const [slots, setSlots] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  const [nome, setNome] = useState("");
  const [slot, setSlot] = useState("");
  const [descricao, setDescricao] = useState("");

  const carregar = useCallback(async () => {
    try {
      const r = await api.listarEquipamentos(characterId);
      setLista(r.equipamentos); setSlots(r.slots);
    } catch (e) { aoErro(e); }
  }, [characterId, aoErro]);
  useEffect(() => { void carregar(); recarregarRef.fn = carregar; }, [carregar, recarregarRef]);

  const q = busca.trim().toLowerCase();
  const visiveis = lista.filter((eq) =>
    !q || eq.name.toLowerCase().includes(q) || (eq.description ?? "").toLowerCase().includes(q) || (eq.slot ?? "").toLowerCase().includes(q)
  );

  return (
    <div>
      <div className="linha filtros-lista">
        <input type="search" placeholder="Buscar equipamento…" aria-label="Buscar equipamento" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>
      <div className="linha">
        {slots.length > 0 && slots.map((s) => {
          const ocupado = lista.find((e) => e.slot === s && e.equipped);
          return <span key={s} className="tag">{s}: {ocupado?.name ?? "—"}</span>;
        })}
      </div>
      {!somenteLeitura && podeEditar && (
      <form className="formulario linha" onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        try {
          await api.adicionarEquipamento(characterId, { name: nome, slot: slot || undefined, equipped: true, description: descricao || undefined });
          setNome(""); setSlot(""); setDescricao("");
          await carregar();
        } catch (err) { aoErro(err); }
      }}>
        <input placeholder="Nome do equipamento" value={nome} onChange={(e) => setNome(e.target.value)} required />
        <select aria-label="Posição do equipamento" value={slot} onChange={(e) => setSlot(e.target.value)}>
          <option value="">Sem posição</option>
          {slots.map((s) => <option key={s} value={s}>{s}</option>)}
          {!slots.includes(slot) && slot && <option value={slot}>{slot}</option>}
        </select>
        <input placeholder="Descrição" value={descricao} onChange={(e) => setDescricao(e.target.value)} />
        <button type="submit">Adicionar</button>
      </form>
      )}
      <table className="tabela">
        <thead><tr><th>Equipamento</th><th>Posição</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          {visiveis.map((eq) => (
            <tr key={eq.id}>
              <td>{eq.name}{eq.description && <div className="meta">{eq.description}</div>}</td>
              <td>{eq.slot ?? "—"}</td>
              <td>{eq.equipped ? "Equipado" : "Guardado"}</td>
              <td>
                {!somenteLeitura && podeEditar && (eq.equipped
                  ? <button className="secundario" onClick={async () => { try { await api.desequipar(characterId, eq.id); await carregar(); } catch (e) { aoErro(e); } }}>Desequipar</button>
                  : <button className="secundario" onClick={async () => {
                      try {
                        // PATCH equipped=true via endpoint de patch genérico? usar PATCH equipamentos
                        await api.atualizarEquipamento(characterId, eq.id, { equipped: true });
                        await carregar();
                      } catch (e) { aoErro(e); }
                    }}>Equipar</button>)}
              </td>
            </tr>
          ))}
          {lista.length === 0 && <tr><td colSpan={4} className="meta">Nenhum equipamento.</td></tr>}
          {lista.length > 0 && visiveis.length === 0 && <tr><td colSpan={4} className="meta">Nenhum equipamento corresponde à busca.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ================= VEÍCULOS =================

function Veiculos({ characterId, campaignId, souMestre, somenteLeitura = false, permissoes, aoErro, recarregarRef }: {
  characterId: string; campaignId: string; souMestre: boolean; somenteLeitura?: boolean; permissoes: PermissoesPatrimonio | null;
  aoErro: (e: unknown) => void;
  recarregarRef: { fn?: () => Promise<void> };
}) {
  const [lista, setLista] = useState<Veiculo[]>([]);
  const [acervo, setAcervo] = useState<AcervoCatalogoItem[]>([]);
  const [requisitos, setRequisitos] = useState<Record<string, DisponibilidadeAcervo>>({});
  const [busca, setBusca] = useState("");
  const [filtroTipo, setFiltroTipo] = useState("");
  const [novo, setNovo] = useState<VeiculoInput>({ name: "", kind: "carro" });
  const [confirmandoVeiculo, setConfirmandoVeiculo] = useState<Veiculo | null>(null);
  const [ocupadoVeiculo, setOcupadoVeiculo] = useState(false);
  const podeEditar = souMestre || permissoes?.editaVeiculos === true;
  // Backend: DELETE /veiculos/:id usa jogadorRemoveItens (remoção), enquanto
  // criar/editar usa jogadorEditaVeiculos — a UI espelha essa distinção.
  const podeRemover = souMestre || permissoes?.removeItens === true;

  const carregar = useCallback(async () => {
    try {
      const [v, cat, reqs] = await Promise.all([
        api.listarVeiculos(characterId),
        api.listarCatalogo(campaignId).catch((): { itens: never[]; categorias: never[]; acervo: AcervoCatalogoItem[] } => ({ itens: [], categorias: [], acervo: [] })),
        api.listarRequisitosPatrimonio(characterId).catch(() => ({ requisitos: {} })),
      ]);
      setLista(v.veiculos); setAcervo((cat.acervo ?? []).filter((e) => e.regra.kind === "veiculo"));
      setRequisitos(reqs.requisitos);
    } catch (e) { aoErro(e); }
  }, [characterId, campaignId, aoErro]);
  useEffect(() => { void carregar(); recarregarRef.fn = carregar; }, [carregar, recarregarRef]);

  const tipoVeiculoAcervo = (el: AcervoCatalogoItem): string => {
    const nome = el.nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const categoria = (el.categoria ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    if (categoria.includes("motociclet") || nome.includes("motocicleta")) return "motocicleta";
    if (categoria.includes("embarc") || nome.includes("lancha") || nome.includes("aquatica")) return "barco";
    if (nome.includes("helicopter")) return "helicoptero";
    if (categoria.includes("militar") || nome.includes("caca ")) return "militar";
    if (categoria.includes("aeronave") || nome.includes("aviao")) return "aviao";
    if (nome.includes("caminhao")) return "caminhao";
    return "carro";
  };

  const TIPOS = ["carro", "motocicleta", "caminhao", "barco", "helicoptero", "aviao", "militar", "futurista", "outro"];

  const q = busca.trim().toLowerCase();
  const visiveis = lista.filter((v) =>
    (!filtroTipo || v.kind === filtroTipo) &&
    (!q || v.name.toLowerCase().includes(q) || (v.brand ?? "").toLowerCase().includes(q) || (v.model ?? "").toLowerCase().includes(q) || (v.plate ?? "").toLowerCase().includes(q))
  );

  return (
    <div>
      <div className="linha filtros-lista">
        <input type="search" placeholder="Buscar veículo…" aria-label="Buscar veículo" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select aria-label="Filtrar por tipo de veículo" value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)}>
          <option value="">Todos os tipos</option>
          {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      {!somenteLeitura && podeEditar && (
      <form className="formulario" onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        try { await api.adicionarVeiculo(characterId, novo); setNovo({ name: "", kind: "carro" }); await carregar(); }
        catch (err) { aoErro(err); }
      }}>
        <div className="grade-2">
          <label>Veículo do Acervo
            <select value={novo.regra?.key ?? ""} onChange={(e) => {
              const key = e.target.value;
              if (!key) { setNovo({ name: "", kind: "carro", regra: undefined }); return; }
              const el = acervo.find((x) => x.regra.key === key);
              if (el) setNovo({ name: el.nome, kind: tipoVeiculoAcervo(el), regra: el.regra });
            }}>
              <option value="">Cadastro livre…</option>
              {acervo.map((el) => <option key={el.regra.key} value={el.regra.key}>{el.nome}{el.prerequisitos.length ? ` — exige ${el.prerequisitos.map((pr) => `${pr.nome} ${pr.minLevel}`).join(" + ")}` : ""}</option>)}
            </select>
          </label>
          <label>Nome<input value={novo.name} disabled={!!novo.regra} onChange={(e) => setNovo({ ...novo, name: e.target.value })} required /></label>
          <label>Tipo
            <select value={novo.kind} disabled={!!novo.regra} onChange={(e) => setNovo({ ...novo, kind: e.target.value })}>
              {TIPOS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label>Marca<input value={novo.brand ?? ""} onChange={(e) => setNovo({ ...novo, brand: e.target.value })} /></label>
          <label>Modelo<input value={novo.model ?? ""} onChange={(e) => setNovo({ ...novo, model: e.target.value })} /></label>
          <label>Ano<input type="number" value={novo.year ?? ""} onChange={(e) => setNovo({ ...novo, year: e.target.value ? Number(e.target.value) : undefined })} /></label>
          <label>Placa<input value={novo.plate ?? ""} onChange={(e) => setNovo({ ...novo, plate: e.target.value })} /></label>
          <label>Valor (R$)<input type="number" min="0" step="0.01" value={novo.valueCents !== undefined ? novo.valueCents / 100 : ""} onChange={(e) => setNovo({ ...novo, valueCents: e.target.value ? Math.round(Number(e.target.value) * 100) : undefined })} /></label>
          <label>Posse
            <select value={novo.ownership ?? "propriedade"} onChange={(e) => setNovo({ ...novo, ownership: e.target.value as "propriedade" | "compartilhado" })}>
              <option value="propriedade">Propriedade do personagem</option>
              <option value="compartilhado">Compartilhado</option>
            </select>
          </label>
        </div>
        {novo.regra && (() => {
          const el = acervo.find((x) => x.regra!.key === novo.regra!.key);
          const d = novo.regra ? requisitos[`${novo.regra.kind}:${novo.regra.key}`] : undefined;
          const bloqueado = !!(d && !d.ok);
          return (
            <p className={`meta ${bloqueado ? "erro" : ""}`}>
              {d && d.prerequisitos.length
                ? "Requisito: " + d.prerequisitos.map((pr) => `${pr.nome} nível ${pr.minLevel} — personagem: ${pr.nivelAtual}`).join(" + ")
                : el?.prerequisitos.length
                  ? "Requisito: " + el.prerequisitos.map((pr) => `${pr.nome} nível ${pr.minLevel}`).join(" + ")
                  : "Sem pré-requisitos."}
              {el && (el.fuel || el.capacity || el.veiculo) && (
                <span className="meta">
                  {" "}Referência do Acervo: {[el.fuel && `combustível ${el.fuel}`, el.capacity && `lotação ${el.capacity}`, el.veiculo?.consumoOuAutonomia].filter(Boolean).join(" · ")}
                  {el.veiculo?.baseDoPeso ? ` (${el.veiculo.baseDoPeso})` : ""}.
                </span>
              )}
              {bloqueado && <> Aquisição indisponível. {d!.mensagens.join(" ")}</>}
            </p>
          );
        })()}
        <button type="submit" disabled={!!(novo.regra && requisitos[`${novo.regra.kind}:${novo.regra.key}`] && !requisitos[`${novo.regra.kind}:${novo.regra.key}`].ok)}>Adicionar veículo</button>
      </form>
      )}
      <table className="tabela tabela-responsiva">
        <thead><tr><th>Veículo</th><th>Tipo</th><th>Marca/Modelo</th><th>Ano</th><th>Placa</th><th>Posse</th><th></th></tr></thead>
        <tbody>
          {visiveis.map((v) => (
            <tr key={v.id}>
              <td>{v.name}</td>
              <td>{v.kind ?? "—"}</td>
              <td>{[v.brand, v.model].filter(Boolean).join(" ") || "—"}</td>
              <td>{v.year ?? "—"}</td>
              <td>{v.plate ?? "—"}</td>
              <td>{v.ownership === "compartilhado" ? "Compartilhado" : "Propriedade"}</td>
              <td>{!somenteLeitura && podeRemover && <button className="perigo" onClick={() => setConfirmandoVeiculo(v)}>×</button>}</td>
            </tr>
          ))}
          {lista.length === 0 && <tr><td colSpan={7} className="meta">Nenhum veículo.</td></tr>}
          {lista.length > 0 && visiveis.length === 0 && <tr><td colSpan={7} className="meta">Nenhum veículo corresponde à busca.</td></tr>}
        </tbody>
      </table>
      <div className="cartoes-registro">
        {visiveis.map((v) => (
          <div key={v.id} className="registro-cartao">
            <div className="registro-campo"><strong>{v.name}</strong><span className="tag">{v.kind ?? "—"}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Marca/Modelo</span><span>{[v.brand, v.model].filter(Boolean).join(" ") || "—"}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Ano</span><span>{v.year ?? "—"}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Placa</span><span>{v.plate ?? "—"}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Posse</span><span>{v.ownership === "compartilhado" ? "Compartilhado" : "Propriedade"}</span></div>
            <div className="registro-acoes">
              {!somenteLeitura && podeRemover && <button className="perigo" onClick={() => setConfirmandoVeiculo(v)}>×</button>}
            </div>
          </div>
        ))}
        {lista.length === 0 && <p className="meta">Nenhum veículo.</p>}
        {lista.length > 0 && visiveis.length === 0 && <p className="meta">Nenhum veículo corresponde à busca.</p>}
      </div>
      {confirmandoVeiculo && (
        <ModalConfirmar
          titulo="Remover veículo"
          mensagem={`Remover "${confirmandoVeiculo.name}"?`}
          rotuloConfirmar="Remover"
          perigo
          ocupado={ocupadoVeiculo}
          aoConfirmar={() => {
            if (ocupadoVeiculo) return;
            setOcupadoVeiculo(true);
            api.removerVeiculo(characterId, confirmandoVeiculo.id)
              .then(async () => { setConfirmandoVeiculo(null); await carregar(); })
              .catch((e) => aoErro(e))
              .finally(() => setOcupadoVeiculo(false));
          }}
          aoCancelar={() => { if (!ocupadoVeiculo) setConfirmandoVeiculo(null); }}
        />
      )}
    </div>
  );
}

// ================= DINHEIRO =================

function Dinheiro({ characterId, campaignId, souMestre, somenteLeitura = false, permissoes, aoErro, recarregarRef }: {
  characterId: string; campaignId: string; souMestre: boolean; somenteLeitura?: boolean; permissoes: PermissoesPatrimonio | null;
  aoErro: (e: unknown) => void;
  recarregarRef: { fn?: () => Promise<void> };
}) {
  const [fin, setFin] = useState<Financeiro | null>(null);
  const [contasOutros, setContasOutros] = useState<{ conta: ContaFinanceira; personagem: string }[]>([]);
  const [estornando, setEstornando] = useState<TransacaoFinanceira | null>(null);
  const [ocupadoEstorno, setOcupadoEstorno] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const f = await api.obterFinanceiro(characterId);
      setFin(f);
      const { personagens } = await api.listarPersonagens(campaignId).catch(() => ({ personagens: [] as PersonagemResumo[] }));
      // contas de outros personagens para PIX fictício
      const outros = personagens.filter((p) => p.id !== characterId);
      const todas: { conta: ContaFinanceira; personagem: string }[] = [];
      for (const p of outros.slice(0, 10)) {
        try {
          const pf = await api.obterFinanceiro(p.id);
          for (const c of pf.contas) todas.push({ conta: c, personagem: p.name });
        } catch { /* sem acesso */ }
      }
      setContasOutros(todas);
    } catch (e) { aoErro(e); }
  }, [characterId, campaignId, aoErro]);
  useEffect(() => { void carregar(); recarregarRef.fn = carregar; }, [carregar, recarregarRef]);

  if (!fin) return <p className="meta">Carregando…</p>;
  const cfg = fin.config;
  // Issue #165: permissões granulares — criar conta, movimentar (compra/venda),
  // PIX entre personagens e transferência entre contas próprias são independentes.
  const podeCriarConta = souMestre || permissoes?.criaContas === true;
  const podeMovimentar = souMestre || permissoes?.compraVenda === true;
  const podePix = souMestre || permissoes?.pix === true;
  const podeMesmaConta = souMestre || permissoes?.compraVenda === true;
  const podeDefinirValor = souMestre || permissoes?.compraVenda === true;
  const mostrarTransferir = souMestre ||
    (podeMesmaConta && fin.contas.length > 0) ||
    (podePix && contasOutros.length > 0);
  // O backend escala os inteiros financeiros por 10 ** casasDecimais (não sempre por 100).
  const fmt = (unidades: number | null | undefined) =>
    unidades === null || unidades === undefined ? "—" : (unidades / 10 ** cfg.casasDecimais).toFixed(cfg.casasDecimais);

  // amountCents chega sempre escalado pelo servidor — inclusive para
  // transações legadas, que o GET /financeiro normaliza na resposta com a
  // mesma política das escritas (Math.round(valor * 10 ** casas)). O
  // cliente não mantém um segundo caminho de arredondamento: toFixed()
  // sobre o REAL bruto diverge do contrato canônico (ex.: 10.235 → 10.23
  // vs 10.24) e não pode ser usado aqui.
  const valorTransacao = (t: TransacaoFinanceira) => fmt(t.amountCents);
  const transacaoNegativa = (t: TransacaoFinanceira) => (t.amountCents ?? 0) < 0;
  // Modal de estorno: mesmo amountCents já normalizado pelo servidor —
  // transações legadas chegam com o inteiro canônico preenchido pelo
  // GET, então o valor nunca cai em "—" por causa do REAL bruto. O "—"
  // só aparece quando nem o legado nem o cents existem de fato.
  const valorTransacaoAbs = (t: TransacaoFinanceira) =>
    t.amountCents != null ? fmt(Math.abs(t.amountCents)) : "—";

  // Rótulos amigáveis dos tipos de movimentação.
  const ROTULO_KIND: Record<string, string> = {
    entrada: "Entrada", saida: "Saída", ajuste: "Ajuste", compra: "Compra",
    venda: "Venda", transferencia: "Transferência", estorno: "Estorno", pix: "PIX",
  };
  const rotuloKind = (k: string) => ROTULO_KIND[k] ?? k;
  // Operações de compra/venda estornáveis: têm requestId e ainda não
  // possuem transação de estorno `${requestId}:estorno` no histórico.
  const estornadas = new Set(fin.historico.map((t) => t.requestId).filter(Boolean));
  const podeEstornar = (t: TransacaoFinanceira) =>
    !somenteLeitura && (souMestre || permissoes?.compraVenda === true) &&
    (t.kind === "compra" || t.kind === "venda") && !!t.requestId &&
    !estornadas.has(`${t.requestId}:estorno`);
  const confirmarEstorno = async () => {
    if (!estornando || ocupadoEstorno) return;
    setOcupadoEstorno(true);
    try {
      await api.estornarOperacao(characterId, estornando.requestId!);
      setEstornando(null);
      await carregar();
    } catch (e) { aoErro(e); } finally { setOcupadoEstorno(false); }
  };

  return (
    <div>
      <div className="linha">
        {fin.contas.map((c) => (
          <span key={c.id} className="tag">
            {c.name}: {c.currency} {fmt(c.balanceCents)}
            {c.type === "cartao_credito" && c.creditLimitCents ? ` (limite ${fmt(c.creditLimitCents)})` : ""}
          </span>
        ))}
        <span className="tag">Moeda: {cfg.moedaPrincipal} {cfg.simbolo}</span>
      </div>

      {!somenteLeitura && <>
      {podeCriarConta && <NovaConta characterId={characterId} cfg={cfg} podeDefinirValor={podeDefinirValor} aoErro={aoErro} aoOk={carregar} />}
      {podeMovimentar && <Movimentar characterId={characterId} contas={fin.contas} souMestre={souMestre} aoErro={aoErro} aoOk={carregar} />}
      {mostrarTransferir && <Transferir characterId={characterId} contas={fin.contas} contasOutros={contasOutros} souMestre={souMestre} podePix={podePix} podeMesmaConta={podeMesmaConta} aoErro={aoErro} aoOk={carregar} />}
      </>}

      <h4>Histórico financeiro</h4>
      <table className="tabela tabela-responsiva">
        <thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Conta</th><th>Contraparte</th><th>Valor</th><th>Saldo após</th>{!somenteLeitura && <th></th>}</tr></thead>
        <tbody>
          {fin.historico.map((t) => (
            <tr key={t.id}>
              <td>{new Date(t.createdAt).toLocaleString("pt-BR")}</td>
              <td>{rotuloKind(t.kind)}</td>
              <td>{t.description ?? "—"}</td>
              <td>{t.account ?? "—"}</td>
              <td>{t.counterparty ?? "—"}</td>
              <td className={transacaoNegativa(t) ? "erro" : "online"}>{valorTransacao(t)}</td>
              <td>{t.balanceAfterCents !== null ? fmt(t.balanceAfterCents) : "—"}</td>
              {!somenteLeitura && (
                <td>{podeEstornar(t) && <button type="button" className="secundario" onClick={() => setEstornando(t)}>Estornar</button>}</td>
              )}
            </tr>
          ))}
          {fin.historico.length === 0 && <tr><td colSpan={somenteLeitura ? 7 : 8} className="meta">Sem movimentações.</td></tr>}
        </tbody>
      </table>
      <div className="cartoes-registro">
        {fin.historico.map((t) => (
          <div key={t.id} className="registro-cartao">
            <div className="registro-campo"><span className="registro-rotulo">Data</span><span>{new Date(t.createdAt).toLocaleString("pt-BR")}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Tipo</span><span>{rotuloKind(t.kind)}</span></div>
            {t.description && <div className="registro-campo"><span className="registro-rotulo">Descrição</span><span>{t.description}</span></div>}
            <div className="registro-campo"><span className="registro-rotulo">Conta</span><span>{t.account ?? "—"}</span></div>
            {t.counterparty && <div className="registro-campo"><span className="registro-rotulo">Contraparte</span><span>{t.counterparty}</span></div>}
            <div className="registro-campo">
              <span className="registro-rotulo">Valor</span>
              <span className={transacaoNegativa(t) ? "erro" : "online"}>{valorTransacao(t)}</span>
            </div>
            <div className="registro-campo"><span className="registro-rotulo">Saldo após</span><span>{t.balanceAfterCents !== null ? fmt(t.balanceAfterCents) : "—"}</span></div>
            {podeEstornar(t) && (
              <div className="registro-campo">
                <button type="button" className="secundario" onClick={() => setEstornando(t)}>Estornar operação</button>
              </div>
            )}
          </div>
        ))}
        {fin.historico.length === 0 && <p className="meta">Sem movimentações.</p>}
      </div>
      {estornando && (
        <ModalConfirmar
          titulo="Estornar operação"
          mensagem={`Estornar a ${rotuloKind(estornando.kind).toLowerCase()} de ${valorTransacaoAbs(estornando)}? O saldo será revertido na mesma conta e o item correspondente será devolvido/removido do inventário. O histórico original será preservado.`}
          rotuloConfirmar="Estornar"
          perigo
          ocupado={ocupadoEstorno}
          aoConfirmar={() => void confirmarEstorno()}
          aoCancelar={() => { if (!ocupadoEstorno) setEstornando(null); }}
        />
      )}
    </div>
  );
}

function NovaConta({ characterId, cfg, podeDefinirValor, aoErro, aoOk }: {
  characterId: string;
  cfg: Financeiro["config"];
  // Backend: conta aberta com saldo/limite positivo exige também
  // jogadorCompraVenda — sem a permissão os campos nem aparecem.
  podeDefinirValor: boolean;
  aoErro: (e: unknown) => void; aoOk: () => Promise<void>;
}) {
  const [form, setForm] = useState<ContaInput>({ type: "especie", name: "", balanceReais: 0 });
  const [aberto, setAberto] = useState(false);
  const TIPOS: [ContaInput["type"], string][] = [
    ["especie", "Dinheiro em espécie"], ["banco", "Conta bancária"], ["cartao_debito", "Cartão de débito"],
    ["cartao_credito", "Cartão de crédito"], ["pre_pago", "Pré-pago"], ["pix", "Chave PIX"], ["outro", "Outro"],
  ];
  return (
    <div className="linha">
      <button className="secundario" onClick={() => setAberto(!aberto)}>Nova conta</button>
      {aberto && (
        <form className="formulario linha" onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          try {
            await api.criarConta(characterId, podeDefinirValor ? form : { ...form, balanceReais: 0, creditLimitReais: undefined });
            setAberto(false); setForm({ type: "especie", name: "", balanceReais: 0 }); await aoOk();
          }
          catch (err) { aoErro(err); }
        }}>
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ContaInput["type"] })}>
            {TIPOS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input placeholder="Nome (ex.: Carteira, Banco X)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input placeholder="Instituição" value={form.institution ?? ""} onChange={(e) => setForm({ ...form, institution: e.target.value })} />
          <select value={form.currency ?? cfg.moedaPrincipal} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            <option value={cfg.moedaPrincipal}>{cfg.moedaPrincipal} (principal)</option>
            {cfg.moedas.map((m) => <option key={m.codigo} value={m.codigo}>{m.codigo} — {m.nome}</option>)}
          </select>
          {podeDefinirValor && (
            <input placeholder="Saldo inicial" type="number" step="0.01" value={form.balanceReais ?? 0} onChange={(e) => setForm({ ...form, balanceReais: Number(e.target.value) })} style={{ width: 110 }} />
          )}
          {podeDefinirValor && form.type === "cartao_credito" && (
            <input placeholder="Limite de crédito" type="number" step="0.01" min="0" value={form.creditLimitReais ?? ""} onChange={(e) => setForm({ ...form, creditLimitReais: e.target.value === "" ? undefined : Number(e.target.value) })} style={{ width: 130 }} />
          )}
          <button type="submit">Criar</button>
        </form>
      )}
    </div>
  );
}

function Movimentar({ characterId, contas, souMestre, aoErro, aoOk }: {
  characterId: string; contas: ContaFinanceira[]; souMestre: boolean;
  aoErro: (e: unknown) => void; aoOk: () => Promise<void>;
}) {
  const [form, setForm] = useState({ accountId: "", tipo: "entrada" as "entrada" | "saida" | "ajuste", valor: 0, descricao: "" });
  if (contas.length === 0) return null;
  return (
    <form className="formulario linha" onSubmit={async (e: FormEvent) => {
      e.preventDefault();
      try {
        await api.movimentar(characterId, { ...form, requestId: crypto.randomUUID() });
        setForm({ ...form, valor: 0, descricao: "" });
        await aoOk();
      } catch (err) { aoErro(err); }
    }}>
      <select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })} required>
        <option value="">Conta…</option>
        {contas.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select value={form.tipo} onChange={(e) => setForm({ ...form, tipo: e.target.value as typeof form.tipo })}>
        <option value="entrada">Entrada</option>
        <option value="saida">Saída</option>
        {souMestre && <option value="ajuste">Ajuste do mestre</option>}
      </select>
      <input placeholder="Valor" type="number" min="0.01" step="0.01" value={form.valor || ""} onChange={(e) => setForm({ ...form, valor: Number(e.target.value) })} required style={{ width: 100 }} />
      <input placeholder="Descrição" value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} />
      <button type="submit">Registrar</button>
    </form>
  );
}

function Transferir({ characterId, contas, contasOutros, souMestre, podePix, podeMesmaConta, aoErro, aoOk }: {
  characterId: string; contas: ContaFinanceira[]; contasOutros: { conta: ContaFinanceira; personagem: string }[];
  souMestre: boolean; podePix: boolean; podeMesmaConta: boolean;
  aoErro: (e: unknown) => void; aoOk: () => Promise<void>;
}) {
  const [aberto, setAberto] = useState(false);
  const [origem, setOrigem] = useState("");
  const [destino, setDestino] = useState("");
  const [valor, setValor] = useState(0);
  const [descricao, setDescricao] = useState("");
  const destinoEhOutro = contasOutros.some((o) => o.conta.id === destino);
  return (
    <div className="linha">
      <button className="secundario" onClick={() => setAberto(!aberto)}>Transferir (PIX fictício)</button>
      {aberto && (
        <form className="formulario linha" onSubmit={async (e: FormEvent) => {
          e.preventDefault();
          try {
            await api.transferirFinanceiro(characterId, { origemAccountId: origem, destinoAccountId: destino, valor, descricao, requestId: crypto.randomUUID() });
            setAberto(false); setValor(0); setDescricao("");
            await aoOk();
          } catch (err) { aoErro(err); }
        }}>
          <select value={origem} onChange={(e) => setOrigem(e.target.value)} required>
            <option value="">De…</option>
            {contas.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}
          </select>
          <select value={destino} onChange={(e) => setDestino(e.target.value)} required>
            <option value="">Para…</option>
            {podeMesmaConta && (
            <optgroup label="Minhas contas">
              {contas.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}
            </optgroup>
            )}
            {podePix && (
            <optgroup label="Outros personagens">
              {contasOutros.map((o) => <option key={o.conta.id} value={o.conta.id}>{o.personagem} — {o.conta.name} ({o.conta.currency})</option>)}
            </optgroup>
            )}
          </select>
          <input placeholder="Valor" type="number" min="0.01" step="0.01" value={valor || ""} onChange={(e) => setValor(Number(e.target.value))} required style={{ width: 100 }} />
          <input placeholder="Descrição" value={descricao} onChange={(e) => setDescricao(e.target.value)} />
          <button type="submit">Enviar</button>
        </form>
      )}
      {destinoEhOutro && !souMestre && <span className="meta">(transferência para outro personagem)</span>}
    </div>
  );
}

// ================= CATÁLOGO (mestre) =================

function Catalogo({ campaignId, souMestre, somenteLeitura = false, aoErro, recarregarRef }: {
  campaignId: string; souMestre: boolean; somenteLeitura?: boolean; aoErro: (e: unknown) => void;
  recarregarRef: { fn?: () => Promise<void> };
}) {
  const [itens, setItens] = useState<ItemCatalogo[]>([]);
  const [acervo, setAcervo] = useState<AcervoCatalogoItem[]>([]);
  const [novo, setNovo] = useState<ItemCatalogoInput>({ name: "", category: "" });
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [confirmandoItem, setConfirmandoItem] = useState<ItemCatalogo | null>(null);
  const [ocupadoItem, setOcupadoItem] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await api.listarCatalogo(campaignId);
      setItens(r.itens);
      setAcervo((r.acervo ?? []).filter((el) => el.regra.kind === "item"));
    } catch (e) { aoErro(e); }
  }, [campaignId, aoErro]);
  useEffect(() => { void carregar(); recarregarRef.fn = carregar; }, [carregar, recarregarRef]);

  const visiveis = itens.filter((i) => !busca || i.name.toLowerCase().includes(busca.toLowerCase()) || (i.category ?? "").toLowerCase().includes(busca.toLowerCase()));
  const editarItemCatalogo = (item: ItemCatalogo) => {
    const regra = item.data?.regra as RegraRef | undefined;
    setNovo({
      name: item.name,
      category: item.category ?? "",
      description: item.description ?? "",
      regra: regra ?? null,
      data: item.data ?? {},
      isActive: item.isActive,
    });
    setEditandoId(item.id);
  };
  const cancelarEdicaoCatalogo = () => {
    setNovo({ name: "", category: "" });
    setEditandoId(null);
  };

  return (
    <div>
      <p className="meta">Itens do catálogo da campanha — disponíveis para adicionar rapidamente ao inventário dos personagens.</p>
      <div className="linha">
        <input placeholder="Buscar…" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>
      {souMestre && !somenteLeitura && (
      <form className="formulario linha" onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        try {
          const dados = { ...novo, category: novo.category || undefined };
          if (editandoId) await api.atualizarItemCatalogo(campaignId, editandoId, dados);
          else await api.criarItemCatalogo(campaignId, dados);
          cancelarEdicaoCatalogo();
          await carregar();
        } catch (err) { aoErro(err instanceof ApiError ? err.message : err); }
      }}>
        <label>Vínculo do Acervo (opcional)
          <select aria-label="Vínculo do Acervo" value={novo.regra ? `${novo.regra.kind}:${novo.regra.key}` : ""} onChange={(e) => {
            const ref = e.target.value;
            if (!ref) { setNovo({ ...novo, regra: editandoId ? null : undefined }); return; }
            const el = acervo.find((x) => `${x.regra.kind}:${x.regra.key}` === ref);
            if (el) setNovo({ ...novo, name: el.nome, category: el.categoria ?? "", description: el.descricao ?? "", regra: el.regra });
          }}>
            <option value="">Item manual — sem vínculo</option>
            {acervo.map((el) => (
              <option key={`${el.regra.kind}:${el.regra.key}`} value={`${el.regra.kind}:${el.regra.key}`}>
                {el.nome}{el.prerequisitos.length ? ` — exige ${el.prerequisitos.map((p) => `${p.nome} ${p.minLevel}`).join(" + ")}` : ""}
              </option>
            ))}
          </select>
        </label>
        <input placeholder="Nome do item" value={novo.name} disabled={!!novo.regra} onChange={(e) => setNovo({ ...novo, name: e.target.value })} required />
        <input placeholder="Categoria" value={novo.category ?? ""} disabled={!!novo.regra} onChange={(e) => setNovo({ ...novo, category: e.target.value })} />
        <input placeholder="Descrição" value={novo.description ?? ""} disabled={!!novo.regra} onChange={(e) => setNovo({ ...novo, description: e.target.value })} />
        {novo.regra && (() => {
          // Ponte econômica (Issue #103): o Acervo fornece a referência;
          // estes campos são override local do template (cópia de
          // trabalho) — nunca alteram rule_definitions.
          const el = acervo.find((x) => x.regra.kind === novo.regra!.kind && x.regra.key === novo.regra!.key);
          if (!el) return null;
          const d = (novo.data ?? {}) as Record<string, unknown>;
          const pesoRef = typeof d.weight === "number" ? d.weight : el.weight;
          const econData = d.economia as EconomiaAcervo["economia"] | undefined;
          const precoDataReais = typeof d.valueCents === "number" ? d.valueCents / 100
            : typeof econData?.precoReferenciaBRL === "number" ? econData.precoReferenciaBRL : undefined;
          const precoRef = precoDataReais ?? el.economia?.precoReferenciaBRL ?? (el.valueCents !== undefined ? el.valueCents / 100 : undefined);
          // null = "sem override local": o servidor remove o valor e a
          // mescla com o Acervo repõe a referência original (Issue #119).
          // Omitir a chave no PATCH preservaria o override anterior.
          const definirPeso = (v: number | undefined) => {
            const dataNovo = { ...(novo.data ?? {}) };
            dataNovo.weight = v === undefined ? null : v;
            setNovo({ ...novo, data: dataNovo });
          };
          const definirPreco = (v: number | undefined) => {
            const dataNovo = { ...(novo.data ?? {}) };
            if (v === undefined) {
              dataNovo.valueCents = null;
              dataNovo.economia = null;
            } else {
              dataNovo.valueCents = Math.round(v * 100);
              const econAtual = (dataNovo.economia ?? el.economia) as Record<string, unknown> | undefined;
              if (econAtual && typeof econAtual === "object") {
                dataNovo.economia = { ...econAtual, precoReferenciaBRL: v };
              }
            }
            setNovo({ ...novo, data: dataNovo });
          };
          const restaurarReferencia = () => {
            const dataNovo = { ...(novo.data ?? {}) };
            dataNovo.weight = null;
            dataNovo.valueCents = null;
            dataNovo.economia = null;
            setNovo({ ...novo, data: dataNovo });
          };
          return (
            <span className="linha">
              <span className="meta">
                Ref. Acervo{pesoRef !== undefined ? `: ${pesoRef} kg` : ""}{precoRef !== undefined ? ` · ~R$ ${precoRef.toFixed(2)}` : ""}
              </span>
              <input placeholder="Peso override (kg)" type="number" min="0" step="any" style={{ width: 120 }}
                value={typeof d.weight === "number" ? d.weight : ""}
                onChange={(e) => definirPeso(e.target.value === "" ? undefined : Number(e.target.value))} />
              <input placeholder="Preço override (R$)" type="number" min="0" step="0.01" style={{ width: 120 }}
                value={precoDataReais !== undefined ? precoDataReais : ""}
                onChange={(e) => definirPreco(e.target.value === "" ? undefined : Number(e.target.value))} />
              <button type="button" className="secundario" onClick={restaurarReferencia}
                title="Remove os overrides locais e volta aos valores de referência do Acervo">
                Restaurar referência do Acervo
              </button>
            </span>
          );
        })()}
        <button type="submit">{editandoId ? "Salvar alterações" : "Adicionar ao catálogo"}</button>
        {editandoId && <button type="button" className="secundario" onClick={cancelarEdicaoCatalogo}>Cancelar edição</button>}
      </form>
      )}
      <table className="tabela">
        <thead><tr><th>Item</th><th>Categoria</th><th>Descrição</th><th>Vínculo Acervo</th><th></th></tr></thead>
        <tbody>
          {visiveis.map((i) => {
            const regra = (i.data as Record<string, unknown> | undefined)?.regra as { kind?: string; key?: string } | undefined;
            const vinculo = regra?.kind && regra.key
              ? acervo.find((el) => el.regra.kind === regra.kind && el.regra.key === regra.key)?.nome ?? `${regra.kind}:${regra.key}`
              : null;
            return (
            <tr key={i.id}>
              <td>{i.name}</td>
              <td>{i.category ?? "—"}</td>
              <td>{i.description ?? "—"}</td>
              <td>{vinculo ?? "Manual"}</td>
              <td className="linha">
                {souMestre && !somenteLeitura && <>
                  <button className="secundario" onClick={() => editarItemCatalogo(i)}>Editar</button>
                  <button className="perigo" onClick={() => setConfirmandoItem(i)}>×</button>
                </>}
              </td>
            </tr>
          );})}
          {visiveis.length === 0 && <tr><td colSpan={5} className="meta">Catálogo vazio.</td></tr>}
        </tbody>
      </table>
      {confirmandoItem && (
        <ModalConfirmar
          titulo="Desativar item do catálogo"
          mensagem={`Desativar "${confirmandoItem.name}"?`}
          rotuloConfirmar="Desativar"
          perigo
          ocupado={ocupadoItem}
          aoConfirmar={() => {
            if (ocupadoItem) return;
            setOcupadoItem(true);
            api.removerItemCatalogo(campaignId, confirmandoItem.id)
              .then(async () => { setConfirmandoItem(null); await carregar(); })
              .catch((e) => aoErro(e))
              .finally(() => setOcupadoItem(false));
          }}
          aoCancelar={() => { if (!ocupadoItem) setConfirmandoItem(null); }}
        />
      )}
    </div>
  );
}
