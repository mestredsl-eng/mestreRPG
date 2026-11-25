import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type Equipamento, type ItemInventario, type Veiculo,
} from "../api";
import { getSocket } from "../socket";

interface Props {
  characterId: string;
  campaignId: string;
  /** Atalho para a venda LOJA-B: a operação financeira mora na Internet;
   *  aqui o item só é exibido e encaminhado pré-selecionado. */
  aoVenderItem: (item: ItemInventario) => void;
}

type Aba = "inventario" | "equipamentos" | "veiculos";

const fmtPeso = (w: number | null) => (w === null ? "—" : String(w));
const fmtValor = (cents: number | null) => (cents === null ? "—" : `R$ ${(cents / 100).toFixed(2)}`);

/** Preço unitário autoritativo do item para LOJA-B: SOMENTE
 *  data.aquisicao.unitCents (gravado pelo servidor na compra). O campo
 *  valueCents é ambíguo (unit-vs-total) e o servidor o rejeita com
 *  422 item_sem_valor — a UI não deve exibir cotação que o backend
 *  recusaria. Usado aqui só para habilitar/desabilitar o atalho de
 *  venda; a cotação em si acontece na Internet. */
function precoUnitarioItem(item: ItemInventario): number | null {
  const aquisicao = item.data?.aquisicao as { unitCents?: unknown } | undefined;
  return typeof aquisicao?.unitCents === "number" ? aquisicao.unitCents : null;
}

function itemEquipado(item: ItemInventario, equipamentos: Equipamento[]): boolean {
  if (item.data?.equipped === true) return true;
  return equipamentos.some((e) => e.data?.inventoryEntryId === item.id);
}

/** Equipamento/Armazém (1.1.0): ponto de entrada independente da ficha que
 *  mostra o patrimônio físico do personagem — inventário, equipamentos e
 *  vínculos, veículos. `location` é anotação em texto livre (não é estado
 *  estruturado); "Equipado" só aparece para a relação real em
 *  equipment_entries. Edição de itens/equipamentos/veículos continua no
 *  painel Patrimônio até a substituição ser validada por regressão.
 *  A venda do item para uma loja (LOJA-B) é operação financeira e mora
 *  na Internet — aqui o item só é exibido e encaminhado pré-selecionado
 *  (atalho), sem executar nem hospedar a operação. */
export default function EquipamentoArmazem({ characterId, campaignId, aoVenderItem }: Props) {
  const [aba, setAba] = useState<Aba>("inventario");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [itens, setItens] = useState<ItemInventario[]>([]);
  const [pesoTotal, setPesoTotal] = useState<number | null>(null);
  const [pesoMaximo, setPesoMaximo] = useState<number | null>(null);
  const [pesoExcedido, setPesoExcedido] = useState(false);
  const [equipamentos, setEquipamentos] = useState<Equipamento[]>([]);
  const [veiculos, setVeiculos] = useState<Veiculo[]>([]);
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
        Consulta do patrimônio físico do personagem. Edição de itens, equipamentos e veículos segue no painel Patrimônio. A venda de um item para uma loja (LOJA-B) é operação financeira e acontece na Internet — o botão encaminha o item pré-selecionado para lá.
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
                          title={equipado ? "Item equipado não pode ser vendido" : semValor ? "Item sem valor — a loja não pode cotar" : "Vender na Internet"}
                          onClick={() => { setErro(null); aoVenderItem(i); }}
                        >Vender na Internet</button>
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

