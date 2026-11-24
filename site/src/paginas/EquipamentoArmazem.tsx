import { useCallback, useEffect, useRef, useState } from "react";
import {
  api, ApiError,
  type ContaFinanceira, type Equipamento, type ItemInventario,
  type LojaComercio, type PedidoComercio, type Veiculo,
} from "../api";
import { getSocket } from "../socket";

interface Props {
  characterId: string;
  campaignId: string;
}

type Aba = "inventario" | "equipamentos" | "veiculos";

const fmtPeso = (w: number | null) => (w === null ? "—" : String(w));
const fmtValor = (cents: number | null) => (cents === null ? "—" : `R$ ${(cents / 100).toFixed(2)}`);
const fmtMoeda = (cents: number, moeda = "BRL") =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: moeda }).format(cents / 100);

/** Preço unitário do item para LOJA-B: o servidor deriva de
 *  data.aquisicao.unitCents (compra anterior) ou data.valueCents — a UI
 *  apenas exibe o mesmo valor e o envia como expectedUnitCents para o
 *  servidor revalidar (409 preco_divergente se mudou). */
function precoUnitarioItem(item: ItemInventario): number | null {
  const aquisicao = item.data?.aquisicao as { unitCents?: unknown } | undefined;
  if (typeof aquisicao?.unitCents === "number") return aquisicao.unitCents;
  const v = item.data?.valueCents;
  return typeof v === "number" ? v : null;
}

function itemEquipado(item: ItemInventario, equipamentos: Equipamento[]): boolean {
  if (item.data?.equipped === true) return true;
  return equipamentos.some((e) => e.data?.inventoryEntryId === item.id);
}

const ERRO_VENDA_LABEL: Record<string, string> = {
  internet_indisponivel: "Acesso à Internet revogado — os requisitos não são mais atendidos.",
  preco_divergente: "O valor do item mudou desde a cotação.",
  estoque_insuficiente: "Estoque insuficiente.",
  loja_fechada: "A loja está fechada no momento.",
  loja_sem_caixa: "A loja está sem caixa para concluir a operação.",
  caixa_insuficiente: "O caixa da loja não tem fundos suficientes para esta compra.",
  saldo_insuficiente: "Saldo insuficiente na conta escolhida.",
  moedas_divergentes: "Moeda da conta incompatível com a da loja.",
  conta_nao_encontrada: "Conta de pagamento não encontrada.",
  request_id_divergente: "Conflito de requisição — recarregue e tente novamente.",
  item_sem_valor: "Este item não tem valor definido — a loja não pode cotar.",
  quantidade_insuficiente: "Quantidade indisponível no inventário.",
  item_equipado: "Item equipado não pode ser vendido.",
};

/** Equipamento/Armazém (1.1.0): ponto de entrada independente da ficha que
 *  mostra o patrimônio físico do personagem — inventário, equipamentos e
 *  vínculos, veículos. `location` é anotação em texto livre (não é estado
 *  estruturado); "Equipado" só aparece para a relação real em
 *  equipment_entries. Edição de itens/equipamentos/veículos continua no
 *  painel Patrimônio até a substituição ser validada por regressão; a
 *  única ação aqui é a venda do item para uma loja (LOJA-B), que exige
 *  o gate de Internet avaliado pelo servidor. */
export default function EquipamentoArmazem({ characterId, campaignId }: Props) {
  const [aba, setAba] = useState<Aba>("inventario");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [itens, setItens] = useState<ItemInventario[]>([]);
  const [pesoTotal, setPesoTotal] = useState<number | null>(null);
  const [pesoMaximo, setPesoMaximo] = useState<number | null>(null);
  const [pesoExcedido, setPesoExcedido] = useState(false);
  const [equipamentos, setEquipamentos] = useState<Equipamento[]>([]);
  const [veiculos, setVeiculos] = useState<Veiculo[]>([]);
  const [vendendo, setVendendo] = useState<ItemInventario | null>(null);
  const recarregarRef = useRef<() => Promise<void>>(async () => undefined);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const [inv, eq, ve] = await Promise.all([
        api.listarInventario(characterId),
        api.listarEquipamentos(characterId),
        api.listarVeiculos(characterId),
      ]);
      setItens(inv.itens);
      setPesoTotal(inv.pesoTotal);
      setPesoMaximo(inv.pesoMaximo);
      setPesoExcedido(inv.pesoExcedido);
      setEquipamentos(eq.equipamentos);
      setVeiculos(ve.veiculos);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar patrimônio");
    } finally {
      setCarregando(false);
    }
  }, [characterId]);
  recarregarRef.current = carregar;

  useEffect(() => {
    void carregar();
    const socket = getSocket();
    socket.emit("entrar-campanha", campaignId, () => undefined);
    const aoMudar = () => void recarregarRef.current();
    socket.on("patrimonio:atualizado", aoMudar);
    socket.on("inventario:atualizado", aoMudar);
    socket.on("regras:atualizadas", aoMudar);
    return () => {
      socket.off("patrimonio:atualizado", aoMudar);
      socket.off("inventario:atualizado", aoMudar);
      socket.off("regras:atualizadas", aoMudar);
      socket.emit("sair-campanha", campaignId);
    };
  }, [campaignId, carregar]);

  const abas: [Aba, string][] = [
    ["inventario", "Inventário"],
    ["equipamentos", "Equipamentos"],
    ["veiculos", "Veículos"],
  ];

  // Resolve o nome do item de inventário referenciado por um equipamento
  // (vínculo real via data.inventoryEntryId — nunca inferido por nome).
  const nomeItemVinculado = (equip: Equipamento) => {
    const refId = typeof equip.data?.inventoryEntryId === "string" ? equip.data.inventoryEntryId : null;
    if (!refId) return null;
    return itens.find((i) => i.id === refId)?.name ?? "item fora do inventário";
  };

  return (
    <section className="cartao" aria-label="Equipamento e Armazém">
      <h3>Equipamento/Armazém</h3>
      <p className="meta">
        Consulta do patrimônio físico do personagem. Edição de itens, equipamentos e veículos segue no painel Patrimônio; a venda de um item para uma loja (LOJA-B) é feita aqui, com confirmação do valor e autorização do servidor.
      </p>
      <div className="abas" role="tablist">
        {abas.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={aba === id}
            className={aba === id ? "ativo" : "secundario"}
            onClick={() => setAba(id)}
          >{label}</button>
        ))}
      </div>
      {erro && <p className="erro" role="alert">{erro}</p>}
      {carregando && <p className="meta">Carregando…</p>}

      {vendendo && (
        <VendaParaLoja
          characterId={characterId}
          campaignId={campaignId}
          item={vendendo}
          precoUnit={precoUnitarioItem(vendendo)}
          equipado={itemEquipado(vendendo, equipamentos)}
          aoFechar={() => setVendendo(null)}
          aoConcluido={() => { setVendendo(null); void carregar(); }}
          aoErro={setErro}
        />
      )}

      {!carregando && aba === "inventario" && (
        itens.length === 0 ? (
          <p className="meta">Inventário vazio.</p>
        ) : (
          <>
            {pesoTotal !== null && pesoMaximo !== null && (
              <p className={`meta${pesoExcedido ? " erro" : ""}`}>
                Peso: {pesoTotal.toFixed(2)} / {pesoMaximo.toFixed(2)} kg{pesoExcedido ? " — acima do máximo" : ""}
              </p>
            )}
            <table className="tabela">
              <thead>
                <tr><th>Item</th><th>Qtd</th><th>Categoria</th><th>Localização</th><th>Estado</th><th>Peso</th><th></th></tr>
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
                          <span className="meta"> · {fmtValor(i.data.valueCents as number)}</span>
                        )}
                      </td>
                      <td>{i.quantity}</td>
                      <td>{i.category ?? "—"}</td>
                      <td>{i.location ?? "—"}</td>
                      <td>{i.condition ?? "—"}</td>
                      <td>{fmtPeso(i.weight)}</td>
                      <td>
                        <button
                          className="secundario"
                          disabled={equipado || semValor}
                          title={equipado ? "Item equipado não pode ser vendido" : semValor ? "Item sem valor — a loja não pode cotar" : "Vender para uma loja"}
                          onClick={() => { setErro(null); setVendendo(i); }}
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

      {!carregando && aba === "equipamentos" && (
        equipamentos.length === 0 ? (
          <p className="meta">Nenhum equipamento registrado.</p>
        ) : (
          <table className="tabela">
            <thead>
              <tr><th>Equipamento</th><th>Tipo</th><th>Slot</th><th>Situação</th><th>Vínculo</th></tr>
            </thead>
            <tbody>
              {equipamentos.map((e) => (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td>{e.kind ?? "—"}</td>
                  <td>{e.slot ?? "—"}</td>
                  <td>{e.equipped ? <span className="badge badge-ativa">Equipado</span> : "Guardado"}</td>
                  <td className="meta">{nomeItemVinculado(e) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {!carregando && aba === "veiculos" && (
        veiculos.length === 0 ? (
          <p className="meta">Nenhum veículo registrado.</p>
        ) : (
          <table className="tabela">
            <thead>
              <tr><th>Veículo</th><th>Tipo</th><th>Marca/Modelo</th><th>Ano</th><th>Placa</th><th>Estado</th><th>Posse</th></tr>
            </thead>
            <tbody>
              {veiculos.map((v) => (
                <tr key={v.id}>
                  <td>{v.name}</td>
                  <td>{v.kind ?? "—"}</td>
                  <td>{[v.brand, v.model].filter(Boolean).join(" ") || "—"}</td>
                  <td>{v.year ?? "—"}</td>
                  <td>{v.plate ?? "—"}</td>
                  <td>{v.condition ?? "—"}</td>
                  <td>{v.ownership === "compartilhado" ? "Compartilhado" : "Propriedade"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </section>
  );
}

/** LOJA-B (WF-E): venda de item do inventário para uma loja. O valor
 *  exibido na confirmação vem do dado autoritativo do item
 *  (aquisicao.unitCents/valueCents) e é enviado como expectedUnitCents —
 *  o servidor revalida e responde 409 preco_divergente se mudou, exigindo
 *  reconfirmação com o novo valor. requestId único por tentativa;
 *  timeout/rede preserva o requestId para verificação idempotente. */
function VendaParaLoja({ characterId, campaignId, item, precoUnit, equipado, aoFechar, aoConcluido, aoErro }: {
  characterId: string;
  campaignId: string;
  item: ItemInventario;
  precoUnit: number | null;
  equipado: boolean;
  aoFechar: () => void;
  aoConcluido: () => void;
  aoErro: (m: string | null) => void;
}) {
  const [carregando, setCarregando] = useState(true);
  const [gateOk, setGateOk] = useState<boolean | null>(null);
  const [motivos, setMotivos] = useState<string[]>([]);
  const [lojas, setLojas] = useState<LojaComercio[]>([]);
  const [contas, setContas] = useState<ContaFinanceira[]>([]);
  const [shopId, setShopId] = useState("");
  const [qty, setQty] = useState(1);
  const [accountId, setAccountId] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  const [reconfirmar, setReconfirmar] = useState<number | null>(null);
  const [incerto, setIncerto] = useState<{ payload: Parameters<typeof api.comercioVender>[1]; rotulo: string } | null>(null);
  const [recibo, setRecibo] = useState<PedidoComercio | null>(null);
  const requestIdRef = useRef<string | null>(null);

  useEffect(() => {
    let ativo = true;
    (async () => {
      try {
        const [eg, { lojas }, fin] = await Promise.all([
          api.comercioElegibilidade(characterId),
          api.comercioLojas(campaignId),
          api.obterFinanceiro(characterId).catch(() => null as { contas: ContaFinanceira[] } | null),
        ]);
        if (!ativo) return;
        setGateOk(eg.elegivel);
        setMotivos(eg.motivos);
        const abertas = lojas.filter((l) => l.isOpen);
        setLojas(abertas);
        setShopId((s) => s || abertas[0]?.id || "");
        if (fin) {
          setContas(fin.contas);
          setAccountId((a) => a || fin.contas[0]?.id || "");
        }
      } catch {
        if (ativo) setGateOk(null); // endpoint ausente — fail-closed
      } finally {
        if (ativo) setCarregando(false);
      }
    })();
    return () => { ativo = false; };
  }, [characterId, campaignId]);

  const precoAtual = precoUnit;
  const maxQty = Math.floor(item.quantity);
  const total = (precoAtual ?? 0) * qty;
  const lojasAbertas = lojas;

  const montarPayload = (requestId: string, unitCents: number) => ({
    shopId, accountId,
    inventoryEntryId: item.id, qty,
    expectedUnitCents: unitCents,
    requestId,
  });

  const concluir = async (r: { id: string; replay?: boolean; totalCents?: number }, requestId: string, unitCents: number) => {
    const { pedidos } = await api.comercioPedidos(characterId).catch(() => ({ pedidos: [] as PedidoComercio[] }));
    const pedido = pedidos.find((p) => p.id === r.id) ?? null;
    setRecibo(pedido ?? {
      id: r.id, campaignId, shopId, requestId, buyerCharacterId: characterId,
      items: [{ inventoryEntryId: item.id, name: item.name, qty, unitCents }],
      totalCents: r.totalCents ?? total, currency: "BRL",
      status: "concluido", moneyTransactionIds: [], data: { direction: "venda_para_loja" },
      createdAt: new Date().toISOString(),
    });
  };

  const submit = async (unitCents: number) => {
    if (enviando) return;
    if (!shopId) { setErroLocal("Escolha a loja compradora."); return; }
    if (!accountId) { setErroLocal("Escolha a conta que recebe o valor."); return; }
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
        setErroLocal(ERRO_VENDA_LABEL[codigo] ?? codigo ?? "Não foi possível concluir a venda.");
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
      const unit = incerto.payload.expectedUnitCents ?? precoAtual ?? 0;
      await concluir(r, incerto.payload.requestId, unit);
    } catch (e) {
      const codigo = e instanceof ApiError ? e.message : "";
      if (e instanceof ApiError && e.status > 0 && e.status < 500) {
        setErroLocal(ERRO_VENDA_LABEL[codigo] ?? codigo ?? "A operação não foi concluída.");
        setIncerto(null);
      } else {
        setErroLocal("Ainda sem confirmação — tente verificar novamente em instantes.");
      }
    } finally {
      setEnviando(false);
    }
  };

  if (carregando) {
    return <section className="cartao cartao-destaque"><h4>Vender para loja</h4><p className="meta">Verificando elegibilidade…</p></section>;
  }
  if (gateOk !== true) {
    return (
      <section className="cartao cartao-destaque">
        <h4>Vender para loja</h4>
        <p className="meta">
          {gateOk === false
            ? "O personagem não atende aos requisitos de acesso à Internet no momento."
            : "O serviço de comércio não está disponível nesta versão do servidor."}
        </p>
        {motivos.length > 0 && <ul className="meta">{motivos.map((m) => <li key={m}>{m}</li>)}</ul>}
        <button className="secundario" onClick={aoFechar}>Fechar</button>
      </section>
    );
  }
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
      ) : recibo ? (
        <div>
          <p className="online">Venda concluída — {fmtMoeda(recibo.totalCents, recibo.currency)}.</p>
          <p className="meta">Recibo {recibo.id.slice(0, 8)} · o item saiu do inventário e o valor será creditado na conta escolhida.</p>
          <div className="linha">
            <button className="secundario" onClick={() => { setRecibo(null); aoConcluido(); }}>Fechar</button>
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
            <select value={shopId} onChange={(e) => setShopId(e.target.value)}>
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
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">— escolha —</option>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.type}) — saldo {fmtMoeda(c.balanceCents, c.currency)}</option>
              ))}
            </select>
          </label>
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
                disabled={enviando || !shopId || !accountId || lojasAbertas.length === 0}
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
