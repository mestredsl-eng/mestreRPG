import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, ApiError,
  type ContaFinanceira, type Equipamento, type Financeiro, type ItemInventario,
  type LojaComercio, type OfertaComercio, type PedidoComercio,
} from "../api";
import { getSocket } from "../socket";

interface Props {
  characterId: string;
  campaignId: string;
  /** Atalho do Equipamento/Armazém: item pré-selecionado para venda
   *  (LOJA-B mora aqui — o Armazém só exibe e aponta). */
  itemInicial?: ItemInventario | null;
  /** Chamado quando o fluxo de venda do itemInicial é fechado — o pai
   *  limpa a pré-seleção para não reabrir a venda depois. */
  aoItemConsumido?: () => void;
}

const fmtMoeda = (cents: number, moeda = "BRL") =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(cents / 100);

const MOTIVO_LABEL: Record<string, string> = {
  pericia_ou_conhecimento_insuficiente: "Conhecimento insuficiente — é preciso pelo menos 1 ponto em Computador ou Tecnologia (ou equivalentes configurados pela campanha).",
  dispositivo_ausente: "Nenhum dispositivo compatível (Notebook ou Celular) no patrimônio do personagem.",
};

const ERRO_LABEL: Record<string, string> = {
  internet_indisponivel: "Acesso à Internet revogado — os requisitos não são mais atendidos.",
  preco_divergente: "O preço mudou desde que você abriu a oferta.",
  estoque_insuficiente: "Estoque insuficiente para a quantidade pedida.",
  oferta_indisponivel: "Esta oferta não está mais disponível.",
  loja_fechada: "A loja está fechada no momento.",
  loja_sem_caixa: "A loja está sem caixa para concluir a operação.",
  saldo_insuficiente: "Saldo insuficiente na conta escolhida.",
  moedas_divergentes: "Moeda da conta incompatível com a da loja.",
  conta_nao_encontrada: "Conta de pagamento não encontrada.",
  request_id_divergente: "Conflito de requisição — recarregue e tente novamente.",
  item_sem_valor: "Item sem valor definido — a loja não pode cotar.",
  quantidade_insuficiente: "Quantidade indisponível no inventário.",
  item_equipado: "Item equipado não pode ser vendido.",
  caixa_insuficiente: "O caixa da loja não tem fundos suficientes.",
};

type FaseGate = "carregando" | "indisponivel" | "negado" | "elegivel";
type AbaInternet = "lojas" | "pedidos" | "vender";

interface PedidoIncerto {
  payload: Parameters<typeof api.comercioComprar>[1];
  rotulo: string;
}

/** Preço unitário autoritativo do item para LOJA-B: SOMENTE
 *  data.aquisicao.unitCents (gravado pelo servidor na compra). O campo
 *  valueCents é ambíguo (unit-vs-total) e o servidor o rejeita com
 *  422 item_sem_valor — a UI não deve exibir cotação que o backend
 *  recusaria. */
function precoUnitarioItem(item: ItemInventario): number | null {
  const aquisicao = item.data?.aquisicao as { unitCents?: unknown } | undefined;
  return typeof aquisicao?.unitCents === "number" ? aquisicao.unitCents : null;
}

function itemEquipado(item: ItemInventario, equipamentos: Equipamento[]): boolean {
  if (item.data?.equipped === true) return true;
  return equipamentos.some((e) => e.data?.inventoryEntryId === item.id);
}

/** Internet (1.1.0): comércio diegético do personagem. O gate de
 *  elegibilidade é do servidor (GET /comercio/elegibilidade — mesma
 *  função fail-closed das mutações); a UI apenas exibe o veredito e os
 *  motivos. Vitrine, checkout LOJA-A, venda LOJA-B (aba "Vender") e
 *  histórico conforme WF-D/WF-E aceitos. */
export default function Internet({ characterId, campaignId, itemInicial, aoItemConsumido }: Props) {
  const [gate, setGate] = useState<{ fase: FaseGate; motivos: string[] }>({ fase: "carregando", motivos: [] });
  const [aba, setAba] = useState<AbaInternet>("lojas");
  const [lojas, setLojas] = useState<LojaComercio[] | null>(null);
  const [pedidos, setPedidos] = useState<PedidoComercio[] | null>(null);
  const [lojaSel, setLojaSel] = useState<LojaComercio | null>(null);
  const [contas, setContas] = useState<ContaFinanceira[]>([]);
  const [itens, setItens] = useState<ItemInventario[] | null>(null);
  const [equipamentos, setEquipamentos] = useState<Equipamento[]>([]);
  const [vendendoItem, setVendendoItem] = useState<ItemInventario | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recibo, setRecibo] = useState<PedidoComercio | null>(null);
  const recarregarRef = useRef<() => Promise<void>>(async () => undefined);

  const carregarRef = useRef<() => Promise<void>>(async () => undefined);

  const carregarGate = useCallback(async () => {
    try {
      const r = await api.comercioElegibilidade(characterId);
      setGate(r.elegivel ? { fase: "elegivel", motivos: [] } : { fase: "negado", motivos: r.motivos });
    } catch {
      // Endpoint ausente (backend de comércio ainda não publicado nesta
      // versão do servidor) ou falha de rede — fail-closed, nunca presumir.
      setGate({ fase: "indisponivel", motivos: [] });
    }
  }, [characterId]);

  const carregar = useCallback(async () => {
    try {
      const [{ lojas }, { pedidos }, fin, inv, eq] = await Promise.all([
        api.comercioLojas(campaignId, characterId),
        api.comercioPedidos(characterId),
        api.obterFinanceiro(characterId).catch(() => null as Financeiro | null),
        // inventário/equipamentos alimentam a aba "Vender" (LOJA-B);
        // falha aqui não derruba lojas/histórico — a aba avisa.
        api.listarInventario(characterId).catch(() => null),
        api.listarEquipamentos(characterId).catch(() => null),
      ]);
      setLojas(lojas);
      setPedidos(pedidos);
      if (fin) setContas(fin.contas);
      setItens(inv ? inv.itens : null);
      setEquipamentos(eq ? eq.equipamentos : []);
      setErro(null);
    } catch (e) {
      // Leituras são gated desde #329 @ 55f8adc: se o acesso foi revogado
      // entre o gate e o reload, a resposta é 403 internet_indisponivel —
      // revalida o gate para exibir o motivo real em vez de erro genérico.
      if (e instanceof ApiError && e.status === 403) {
        void carregarGate();
        return;
      }
      setErro(e instanceof Error ? e.message : "Erro ao carregar comércio");
    }
  }, [campaignId, characterId, carregarGate]);
  carregarRef.current = carregar;
  recarregarRef.current = carregar;

  useEffect(() => {
    void carregarGate();
  }, [carregarGate]);

  useEffect(() => {
    if (gate.fase !== "elegivel") return;
    void carregar();
    const socket = getSocket();
    socket.emit("entrar-campanha", campaignId, () => undefined);
    // Canal dedicado do comércio (#329 @ 0731e27): `comercio:atualizado`
    // não chega mais pela sala geral — a inscrição `entrar-internet` é
    // autorizada no servidor (titularidade + gate revalidado no join e a
    // cada entrega). Sem ela, nenhum evento de comércio é entregue.
    socket.emit("entrar-internet", { campaignId, characterId }, () => undefined);
    const aoMudar = () => void recarregarRef.current();
    socket.on("comercio:atualizado", aoMudar);
    socket.on("patrimonio:atualizado", aoMudar);
    return () => {
      socket.off("comercio:atualizado", aoMudar);
      socket.off("patrimonio:atualizado", aoMudar);
      socket.emit("sair-internet", { campaignId, characterId });
      socket.emit("sair-campanha", campaignId);
    };
  }, [campaignId, characterId, gate.fase]);

  // Atalho do Equipamento/Armazém: abre a aba "Vender" já com o item
  // pré-selecionado. O consumo limpa a pré-seleção no pai (evita
  // reabrir a venda ao remontar o módulo).
  useEffect(() => {
    if (!itemInicial) return;
    setAba("vender");
    setVendendoItem(itemInicial);
  }, [itemInicial]);

  if (gate.fase === "carregando") {
    return <section className="cartao"><h3>Internet</h3><p className="meta">Verificando acesso…</p></section>;
  }
  if (gate.fase === "indisponivel") {
    return (
      <section className="cartao"><h3>Internet</h3>
        <p className="meta">O comércio diegético ainda não está disponível nesta versão do servidor.</p>
      </section>
    );
  }
  if (gate.fase === "negado") {
    return (
      <section className="cartao"><h3>Internet</h3>
        <p><strong>Acesso à Internet não liberado.</strong></p>
        <ul className="meta">
          {gate.motivos.map((m) => <li key={m}>{MOTIVO_LABEL[m] ?? m}</li>)}
        </ul>
        <p className="meta">O servidor revalida o acesso em toda operação — esta tela é apenas o veredito atual.</p>
      </section>
    );
  }

  return (
    <section className="cartao" aria-label="Internet">
      <h3>Internet</h3>
      <div className="abas" role="tablist">
        <button role="tab" aria-selected={aba === "lojas"} className={aba === "lojas" ? "ativo" : "secundario"} onClick={() => setAba("lojas")}>Lojas</button>
        <button role="tab" aria-selected={aba === "vender"} className={aba === "vender" ? "ativo" : "secundario"} onClick={() => setAba("vender")}>Vender</button>
        <button role="tab" aria-selected={aba === "pedidos"} className={aba === "pedidos" ? "ativo" : "secundario"} onClick={() => setAba("pedidos")}>Histórico</button>
      </div>
      {erro && <p className="erro" role="alert">{erro}</p>}

      {aba === "lojas" && !lojaSel && (
        lojas === null ? <p className="meta">Carregando lojas…</p> : lojas.length === 0 ? (
          <p className="meta">Nenhuma loja registrada nesta campanha.</p>
        ) : (
          <ul className="lista-lojas">
            {lojas.map((l) => (
              <li key={l.id} className="cartao cartao-campanha">
                <div className="linha-entre">
                  <div>
                    <strong>{l.name}</strong>
                    {l.category && <span className="meta"> · {l.category}</span>}
                    {l.location && <span className="meta"> · {l.location}</span>}
                  </div>
                  <span className={`badge ${l.isOpen ? "badge-ativa" : "badge-bloqueada"}`}>{l.isOpen ? "Aberta" : "Fechada"}</span>
                </div>
                {l.description && <p className="meta">{l.description}</p>}
                <p className="meta">{l.ofertas.length} oferta{l.ofertas.length === 1 ? "" : "s"}</p>
                <button className="secundario" onClick={() => { setLojaSel(l); setErro(null); }}>Ver vitrine</button>
              </li>
            ))}
          </ul>
        )
      )}

      {aba === "lojas" && lojaSel && (
        <VitrineLoja
          loja={lojaSel}
          characterId={characterId}
          contas={contas}
          aoVoltar={() => { setLojaSel(null); void carregar(); }}
          aoConcluido={(p) => { setLojaSel(null); setRecibo(p); void carregar(); }}
          aoErro={setErro}
        />
      )}

      {aba === "vender" && vendendoItem && (
        <VendaParaLoja
          characterId={characterId}
          campaignId={campaignId}
          item={vendendoItem}
          equipado={itemEquipado(vendendoItem, equipamentos)}
          lojas={lojas ?? []}
          contas={contas}
          aoFechar={() => { setVendendoItem(null); aoItemConsumido?.(); }}
          aoConcluido={(p) => { setVendendoItem(null); aoItemConsumido?.(); setRecibo(p); void carregar(); }}
          aoErro={setErro}
        />
      )}

      {aba === "vender" && !vendendoItem && (
        itens === null ? <p className="meta">Carregando inventário…</p> : itens.length === 0 ? (
          <p className="meta">Inventário vazio — não há itens para vender.</p>
        ) : (
          <>
            <p className="meta">Itens do inventário que podem ser vendidos a uma loja. O servidor confirma o valor e a autorização em cada operação.</p>
            <table className="tabela">
              <thead>
                <tr><th>Item</th><th>Qtd</th><th>Localização</th><th>Estado</th><th></th></tr>
              </thead>
              <tbody>
                {itens.map((i) => {
                  const equipado = itemEquipado(i, equipamentos);
                  const semValor = precoUnitarioItem(i) === null;
                  return (
                    <tr key={i.id}>
                      <td>
                        {i.name}
                        {typeof i.data?.valueCents === "number" && (
                          <span className="meta"> · {fmtMoeda(i.data.valueCents as number)}</span>
                        )}
                      </td>
                      <td>{i.quantity}</td>
                      <td>{i.location ?? "—"}</td>
                      <td>{i.condition ?? "—"}</td>
                      <td>
                        <button
                          className="secundario"
                          disabled={equipado || semValor}
                          title={equipado ? "Item equipado não pode ser vendido" : semValor ? "Item sem valor — a loja não pode cotar" : "Vender para uma loja"}
                          onClick={() => { setErro(null); setVendendoItem(i); }}
                        >Vender</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )
      )}

      {aba === "pedidos" && (
        pedidos === null ? <p className="meta">Carregando histórico…</p> : pedidos.length === 0 ? (
          <p className="meta">Nenhuma compra registrada.</p>
        ) : (
          <ul className="lista-lojas">
            {[...pedidos].reverse().map((p) => (
              <li key={p.id} className="cartao cartao-campanha clicavel" onClick={() => setRecibo(p)}>
                <div className="linha-entre">
                  <strong>{lojas?.find((l) => l.id === p.shopId)?.name ?? "Loja"}</strong>
                  <span className="meta">{new Date(p.createdAt).toLocaleString("pt-BR")}</span>
                </div>
                <p className="meta">
                  {p.items.map((i) => `${i.qty}× ${i.name}`).join(", ")} — {fmtMoeda(p.totalCents, p.currency)}
                </p>
                <span className={`badge ${p.status === "concluido" ? "badge-ativa" : "badge-bloqueada"}`}>{p.status}</span>{" "}
                {/* LOJA-B também aparece em /pedidos (buyerCharacterId = vendedor);
                    data.direction distingue — nunca exibir venda como compra. */}
                <span className="badge badge-npc">
                  {(p.direcao ?? p.data?.direction) === "venda_para_loja" ? "Venda p/ loja" : "Compra"}
                </span>
              </li>
            ))}
          </ul>
        )
      )}

      {recibo && <Recibo pedido={recibo} nomeLoja={lojas?.find((l) => l.id === recibo.shopId)?.name} aoFechar={() => setRecibo(null)} />}
    </section>
  );
}

/** Vitrine de uma loja: ofertas com preço/estoque autoritativos do
 *  servidor; compra via checkout com requestId idempotente. */
function VitrineLoja({ loja, characterId, contas, aoVoltar, aoConcluido, aoErro }: {
  loja: LojaComercio;
  characterId: string;
  contas: ContaFinanceira[];
  aoVoltar: () => void;
  aoConcluido: (p: PedidoComercio) => void;
  aoErro: (m: string | null) => void;
}) {
  const [ofertaSel, setOfertaSel] = useState<OfertaComercio | null>(null);
  const [lojaAtual, setLojaAtual] = useState(loja);

  // Revalida a loja ao voltar de erros de estoque/preço — a vitrine pode
  // ter mudado (outro comprador, gestor).
  const recarregarLoja = useCallback(async () => {
    try {
      const { lojas } = await api.comercioLojas(loja.campaignId, characterId);
      const atual = lojas.find((l) => l.id === loja.id);
      if (atual) setLojaAtual(atual);
    } catch { /* mantém a vitrine carregada */ }
  }, [loja.campaignId, loja.id, characterId]);

  if (ofertaSel) {
    return (
      <CheckoutOferta
        loja={lojaAtual}
        characterId={characterId}
        oferta={ofertaSel}
        contas={contas}
        aoVoltar={() => setOfertaSel(null)}
        aoConcluido={aoConcluido}
        aoPrecoMudou={async (precoAtual) => {
          setOfertaSel({ ...ofertaSel, priceCents: precoAtual });
          await recarregarLoja();
        }}
        aoErro={aoErro}
      />
    );
  }

  return (
    <div>
      <div className="linha-entre">
        <h4>{lojaAtual.name}</h4>
        <span className={`badge ${lojaAtual.isOpen ? "badge-ativa" : "badge-bloqueada"}`}>{lojaAtual.isOpen ? "Aberta" : "Fechada"}</span>
      </div>
      {lojaAtual.description && <p className="meta">{lojaAtual.description}</p>}
      {!lojaAtual.isOpen && <p className="meta">Loja fechada — é possível consultar as ofertas, mas não comprar.</p>}
      {lojaAtual.ofertas.length === 0 ? (
        <p className="meta">Nenhuma oferta ativa nesta loja.</p>
      ) : (
        <ul className="lista-lojas">
          {lojaAtual.ofertas.map((o) => (
            <li key={o.id} className="cartao cartao-campanha">
              <div className="linha-entre">
                <strong>{o.name}</strong>
                <strong>{fmtMoeda(o.priceCents, o.currency)}</strong>
              </div>
              {o.description && <p className="meta">{o.description}</p>}
              <p className="meta">
                {o.emEstoque
                  ? (o.stockQty === null ? "Em estoque" : `${o.stockQty} em estoque`)
                  : "Esgotado"}
              </p>
              <button
                className="secundario"
                disabled={!lojaAtual.isOpen || !o.emEstoque}
                title={!lojaAtual.isOpen ? "Loja fechada" : !o.emEstoque ? "Oferta esgotada" : undefined}
                onClick={() => { setOfertaSel(o); aoErro(null); }}
              >Comprar</button>
            </li>
          ))}
        </ul>
      )}
      <button className="secundario" onClick={aoVoltar}>Voltar às lojas</button>
    </div>
  );
}

/** Checkout LOJA-A: quantidade + conta de pagamento + confirmação.
 *  requestId gerado UMA vez por tentativa; 409 de preço abre
 *  reconfirmação com o valor autoritativo atual; timeout/rede preserva
 *  o requestId para verificação idempotente (nunca reenvia payload
 *  divergente nem gera requestId novo às cegas). */
function CheckoutOferta({ loja, characterId, oferta, contas, aoVoltar, aoConcluido, aoPrecoMudou, aoErro }: {
  loja: LojaComercio;
  characterId: string;
  oferta: OfertaComercio;
  contas: ContaFinanceira[];
  aoVoltar: () => void;
  aoConcluido: (p: PedidoComercio) => void;
  aoPrecoMudou: (precoAtualCents: number) => Promise<void>;
  aoErro: (m: string | null) => void;
}) {
  const [qty, setQty] = useState(1);
  const [accountId, setAccountId] = useState(contas[0]?.id ?? "");
  const [enviando, setEnviando] = useState(false);
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  const [reconfirmar, setReconfirmar] = useState<{ antigo: number; atual: number } | null>(null);
  const [incerto, setIncerto] = useState<PedidoIncerto | null>(null);
  const requestIdRef = useRef<string | null>(null);

  const precoAtual = oferta.priceCents;
  const maxQty = oferta.stockQty ?? 999;
  const total = precoAtual * qty;

  const montarPayload = (requestId: string) => ({
    shopId: loja.id,
    accountId,
    items: [{ offerId: oferta.id, qty, expectedUnitCents: precoAtual }],
    requestId,
  });

  const codigoErro = (e: unknown) => (e instanceof ApiError ? e.message : "");

  const submit = async () => {
    if (enviando) return;
    if (!accountId) { setErroLocal("Escolha a conta de pagamento."); return; }
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    setEnviando(true);
    setErroLocal(null);
    aoErro(null);
    try {
      const r = await api.comercioComprar(characterId, montarPayload(requestIdRef.current));
      // sucesso (201 ou replay idempotente): o servidor já gravou o pedido
      const { pedidos } = await api.comercioPedidos(characterId).catch(() => ({ pedidos: [] as PedidoComercio[] }));
      const pedido = pedidos.find((p) => p.id === r.id) ?? null;
      aoConcluido(pedido ?? {
        id: r.id, campaignId: loja.campaignId, shopId: loja.id, requestId: requestIdRef.current!,
        buyerCharacterId: characterId,
        items: (r.itens ?? [{ offerId: oferta.id, name: oferta.name, qty, unitCents: precoAtual }]),
        totalCents: r.totalCents ?? total, currency: oferta.currency,
        status: "concluido", moneyTransactionIds: [], data: {}, createdAt: new Date().toISOString(),
      });
    } catch (e) {
      const codigo = codigoErro(e);
      if (codigo === "preco_divergente") {
        const atual = (e as ApiError).detalhes && typeof (e as ApiError).detalhes === "object"
          ? ((e as ApiError).detalhes as { precoAtualCents?: number }).precoAtualCents
          : undefined;
        setReconfirmar({ antigo: precoAtual, atual: typeof atual === "number" ? atual : precoAtual });
        setIncerto(null);
      } else if (e instanceof ApiError && e.status > 0 && e.status < 500) {
        setErroLocal(ERRO_LABEL[codigo] ?? codigo ?? "Não foi possível concluir a compra.");
        setIncerto(null);
      } else {
        // Timeout/rede/5xx: resultado incerto — NUNCA reenviar cegamente.
        // O requestId fica retido; "Verificar resultado" repete o MESMO
        // payload+requestId (replay idempotente do servidor).
        setIncerto({
          payload: montarPayload(requestIdRef.current),
          rotulo: "Não foi possível confirmar o resultado da compra.",
        });
      }
    } finally {
      setEnviando(false);
    }
  };

  const verificarResultado = async () => {
    if (!incerto || enviando) return;
    setEnviando(true);
    try {
      const r = await api.comercioComprar(characterId, incerto.payload);
      const { pedidos } = await api.comercioPedidos(characterId).catch(() => ({ pedidos: [] as PedidoComercio[] }));
      const pedido = pedidos.find((p) => p.id === r.id) ?? null;
      aoConcluido(pedido ?? {
        id: r.id, campaignId: loja.campaignId, shopId: loja.id, requestId: incerto.payload.requestId,
        buyerCharacterId: characterId,
        items: (r.itens ?? [{ offerId: oferta.id, name: oferta.name, qty, unitCents: precoAtual }]),
        totalCents: r.totalCents ?? total, currency: oferta.currency,
        status: "concluido", moneyTransactionIds: [], data: {}, createdAt: new Date().toISOString(),
      });
    } catch (e) {
      const codigo = codigoErro(e);
      if (e instanceof ApiError && e.status > 0 && e.status < 500) {
        setErroLocal(ERRO_LABEL[codigo] ?? codigo ?? "A operação não foi concluída.");
        setIncerto(null);
      } else {
        setErroLocal("Ainda sem confirmação — tente verificar novamente em instantes.");
      }
    } finally {
      setEnviando(false);
    }
  };

  const confirmarRepreco = async () => {
    if (!reconfirmar) return;
    await aoPrecoMudou(reconfirmar.atual);
    setReconfirmar(null);
    // nova tentativa = novo requestId (a anterior falhou sem efeitos)
    requestIdRef.current = null;
  };

  return (
    <div>
      <h4>Comprar: {oferta.name}</h4>
      <p className="meta">{loja.name} · {fmtMoeda(precoAtual, oferta.currency)} cada</p>
      {reconfirmar && (
        <div className="cartao cartao-destaque" role="alert">
          <p><strong>Preço atualizado pela loja.</strong></p>
          <p>
            Antes: <s>{fmtMoeda(reconfirmar.antigo, oferta.currency)}</s>{" "}
            Agora: <strong>{fmtMoeda(reconfirmar.atual, oferta.currency)}</strong>
          </p>
          <p className="meta">Confirme novamente para concluir com o preço atual.</p>
          <div className="linha">
            <button onClick={() => void confirmarRepreco()} disabled={enviando}>
              Confirmar por {fmtMoeda(reconfirmar.atual * qty, oferta.currency)}
            </button>
            <button className="secundario" onClick={() => setReconfirmar(null)}>Cancelar</button>
          </div>
        </div>
      )}
      {!reconfirmar && (
        <>
          <label>
            Quantidade
            <input
              type="number" min={1} max={maxQty} value={qty}
              onChange={(e) => setQty(Math.max(1, Math.min(maxQty, Number(e.target.value) || 1)))}
            />
          </label>
          <label>
            Conta de pagamento
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">— escolha —</option>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.type}) — saldo {fmtMoeda(c.balanceCents, c.currency)}
                </option>
              ))}
            </select>
          </label>
          {contas.length === 0 && (
            <p className="meta">Nenhuma conta financeira — crie uma no painel Patrimônio &gt; Dinheiro.</p>
          )}
          <p><strong>Total: {fmtMoeda(total, oferta.currency)}</strong></p>
          {erroLocal && <p className="erro" role="alert">{erroLocal}</p>}
          {incerto && (
            <div className="cartao cartao-destaque" role="alert">
              <p>{incerto.rotulo}</p>
              <div className="linha">
                <button onClick={() => void verificarResultado()} disabled={enviando}>
                  {enviando ? "Verificando…" : "Verificar resultado"}
                </button>
                <button className="secundario" onClick={aoVoltar} disabled={enviando}>Voltar</button>
              </div>
            </div>
          )}
          {!incerto && (
            <div className="linha" aria-busy={enviando}>
              <button onClick={() => void submit()} disabled={enviando || !accountId || !loja.isOpen || !oferta.emEstoque}>
                {enviando ? "Processando…" : `Finalizar — ${fmtMoeda(total, oferta.currency)}`}
              </button>
              <button className="secundario" onClick={aoVoltar} disabled={enviando}>Voltar</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Recibo imutável da operação — foco vai ao recibo ao abrir (a11y WF-D). */
function Recibo({ pedido, nomeLoja, aoFechar }: { pedido: PedidoComercio; nomeLoja?: string; aoFechar: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const direcao = (pedido.direcao ?? pedido.data?.direction) === "venda_para_loja" ? "Venda para loja" : "Compra";
  return (
    <div className="cartao cartao-destaque" role="dialog" aria-modal="true" aria-label="Recibo da operação">
      <div ref={ref} tabIndex={-1}>
        <h4>Recibo — {direcao}</h4>
        <p className="meta">
          Pedido {pedido.id.slice(0, 8)} · {new Date(pedido.createdAt).toLocaleString("pt-BR")}
          {nomeLoja ? ` · ${nomeLoja}` : ""}
        </p>
        <ul>
          {pedido.items.map((i, idx) => (
            <li key={idx}>{i.qty}× {i.name} — {fmtMoeda(i.unitCents * i.qty, pedido.currency)}</li>
          ))}
        </ul>
        <p><strong>Total: {fmtMoeda(pedido.totalCents, pedido.currency)}</strong></p>
        <button className="secundario" onClick={aoFechar}>Fechar recibo</button>
      </div>
    </div>
  );
}

/** LOJA-B (WF-E): venda de item do inventário para uma loja — mora na
 *  Internet (comércio é operação financeira do módulo; o Equipamento/
 *  Armazém só exibe o item e aponta para cá). O valor exibido na
 *  confirmação vem do dado autoritativo do item (aquisicao.unitCents)
 *  e é enviado como expectedUnitCents — o servidor revalida e responde
 *  409 preco_divergente se mudou, exigindo reconfirmação. requestId
 *  único por tentativa; timeout/rede preserva o requestId para
 *  verificação idempotente. Lojas/contas chegam prontas do componente
 *  pai (gate de Internet já avaliado como elegível). */
function VendaParaLoja({ characterId, campaignId, item, equipado, lojas, contas, aoFechar, aoConcluido, aoErro }: {
  characterId: string;
  campaignId: string;
  item: ItemInventario;
  equipado: boolean;
  lojas: LojaComercio[];
  contas: ContaFinanceira[];
  aoFechar: () => void;
  aoConcluido: (p: PedidoComercio) => void;
  aoErro: (m: string | null) => void;
}) {
  const [shopId, setShopId] = useState("");
  const [qty, setQty] = useState(1);
  const [accountId, setAccountId] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  const [reconfirmar, setReconfirmar] = useState<number | null>(null);
  const [incerto, setIncerto] = useState<{ payload: Parameters<typeof api.comercioVender>[1]; rotulo: string } | null>(null);
  const requestIdRef = useRef<string | null>(null);

  const precoUnit = precoUnitarioItem(item);
  const lojasAbertas = lojas.filter((l) => l.isOpen);
  const shopIdEfetivo = shopId || lojasAbertas[0]?.id || "";
  const accountIdEfetivo = accountId || contas[0]?.id || "";
  const maxQty = Math.floor(item.quantity);
  const total = (precoUnit ?? 0) * qty;

  const montarPayload = (requestId: string, unitCents: number) => ({
    shopId: shopIdEfetivo, accountId: accountIdEfetivo,
    inventoryEntryId: item.id, qty,
    expectedUnitCents: unitCents,
    requestId,
  });

  const concluir = async (r: { id: string; replay?: boolean; totalCents?: number }, requestId: string, unitCents: number) => {
    const { pedidos } = await api.comercioPedidos(characterId).catch(() => ({ pedidos: [] as PedidoComercio[] }));
    const pedido = pedidos.find((p) => p.id === r.id) ?? null;
    aoConcluido(pedido ?? {
      id: r.id, campaignId, shopId: shopIdEfetivo, requestId, buyerCharacterId: characterId,
      items: [{ inventoryEntryId: item.id, name: item.name, qty, unitCents }],
      totalCents: r.totalCents ?? total, currency: "BRL",
      status: "concluido", moneyTransactionIds: [], direcao: "venda_para_loja",
      data: { direction: "venda_para_loja" },
      createdAt: new Date().toISOString(),
    });
  };

  const submit = async (unitCents: number) => {
    if (enviando) return;
    if (!shopIdEfetivo) { setErroLocal("Escolha a loja compradora."); return; }
    if (!accountIdEfetivo) { setErroLocal("Escolha a conta que recebe o valor."); return; }
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    setEnviando(true);
    setErroLocal(null);
    aoErro(null);
    try {
      const r = await api.comercioVender(characterId, montarPayload(requestIdRef.current, unitCents));
      await concluir(r, requestIdRef.current, unitCents);
    } catch (e) {
      const codigo = e instanceof ApiError ? e.message : "";
      if (codigo === "preco_divergente") {
        const atual = e instanceof ApiError && e.detalhes && typeof e.detalhes === "object"
          ? (e.detalhes as { precoAtualCents?: number }).precoAtualCents
          : undefined;
        setReconfirmar(typeof atual === "number" ? atual : unitCents);
        setIncerto(null);
      } else if (e instanceof ApiError && e.status > 0 && e.status < 500) {
        setErroLocal(ERRO_LABEL[codigo] ?? codigo ?? "Não foi possível concluir a venda.");
        setIncerto(null);
      } else {
        setIncerto({
          payload: montarPayload(requestIdRef.current, unitCents),
          rotulo: "Não foi possível confirmar o resultado da venda.",
        });
      }
    } finally {
      setEnviando(false);
    }
  };

  const verificarResultado = async () => {
    if (!incerto || enviando) return;
    setEnviando(true);
    try {
      const r = await api.comercioVender(characterId, incerto.payload);
      const unit = incerto.payload.expectedUnitCents ?? precoUnit ?? 0;
      await concluir(r, incerto.payload.requestId, unit);
    } catch (e) {
      const codigo = e instanceof ApiError ? e.message : "";
      if (e instanceof ApiError && e.status > 0 && e.status < 500) {
        setErroLocal(ERRO_LABEL[codigo] ?? codigo ?? "A operação não foi concluída.");
        setIncerto(null);
      } else {
        setErroLocal("Ainda sem confirmação — tente verificar novamente em instantes.");
      }
    } finally {
      setEnviando(false);
    }
  };

  if (equipado) {
    return (
      <section className="cartao cartao-destaque">
        <h4>Vender para loja</h4>
        <p className="meta">Item equipado não pode ser vendido — desequipe-o antes.</p>
        <button className="secundario" onClick={aoFechar}>Fechar</button>
      </section>
    );
  }
  if (precoUnit === null) {
    return (
      <section className="cartao cartao-destaque">
        <h4>Vender para loja</h4>
        <p className="meta">Este item não tem valor registrado — a loja não pode cotar a recompra.</p>
        <button className="secundario" onClick={aoFechar}>Fechar</button>
      </section>
    );
  }

  return (
    <section className="cartao cartao-destaque" aria-label="Venda para loja">
      <h4>Vender para loja: {item.name}</h4>
      {reconfirmar !== null ? (
        <div role="alert">
          <p><strong>Valor atualizado.</strong> Confirme novamente com o novo valor.</p>
          <p>Novo valor unitário: <strong>{fmtMoeda(reconfirmar, "BRL")}</strong></p>
          <div className="linha">
            <button onClick={() => { const u = reconfirmar; setReconfirmar(null); requestIdRef.current = null; void submit(u); }} disabled={enviando}>
              Confirmar venda por {fmtMoeda(reconfirmar * qty, "BRL")}
            </button>
            <button className="secundario" onClick={() => setReconfirmar(null)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <>
          {/* Confirmação explícita do valor antes do POST (WF-E / LB1) */}
          <div role="alertdialog" aria-label="Confirmar venda" aria-describedby="venda-resumo">
            <p id="venda-resumo">
              A loja oferece <strong>{fmtMoeda(precoUnit, "BRL")}</strong> por unidade de{" "}
              <strong>{item.name}</strong>. Você receberá o valor na sua conta e o item sairá do inventário.
            </p>
          </div>
          <label>
            Loja compradora
            <select value={shopIdEfetivo} onChange={(e) => setShopId(e.target.value)}>
              {lojasAbertas.length === 0 && <option value="">— nenhuma loja aberta —</option>}
              {lojasAbertas.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label>
            Quantidade (máx. {maxQty})
            <input type="number" min={1} max={maxQty} value={qty}
              onChange={(e) => setQty(Math.max(1, Math.min(maxQty, Number(e.target.value) || 1)))} />
          </label>
          <label>
            Conta que recebe
            <select value={accountIdEfetivo} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">— escolha —</option>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.type}) — saldo {fmtMoeda(c.balanceCents, c.currency)}</option>
              ))}
            </select>
          </label>
          {contas.length === 0 && (
            <p className="meta">Nenhuma conta financeira — crie uma no painel Patrimônio &gt; Dinheiro.</p>
          )}
          <p><strong>Total estimado: {fmtMoeda(total, "BRL")}</strong> <span className="meta">(o servidor confirma o valor final)</span></p>
          {erroLocal && <p className="erro" role="alert">{erroLocal}</p>}
          {incerto && (
            <div className="cartao" role="alert">
              <p>{incerto.rotulo}</p>
              <div className="linha">
                <button onClick={() => void verificarResultado()} disabled={enviando}>
                  {enviando ? "Verificando…" : "Verificar resultado"}
                </button>
                <button className="secundario" onClick={aoFechar} disabled={enviando}>Fechar</button>
              </div>
            </div>
          )}
          {!incerto && (
            <div className="linha" aria-busy={enviando}>
              <button
                onClick={() => void submit(precoUnit)}
                disabled={enviando || !shopIdEfetivo || !accountIdEfetivo || lojasAbertas.length === 0}
              >
                {enviando ? "Processando…" : `Confirmar venda — ${fmtMoeda(total, "BRL")}`}
              </button>
              <button className="secundario" onClick={aoFechar} disabled={enviando}>Cancelar</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
