import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api, ApiError,
  type ItemInventario, type ItemInventarioInput, type Equipamento,
  type Veiculo, type VeiculoInput, type Financeiro, type ContaFinanceira, type ContaInput,
  type ItemCatalogo, type ItemCatalogoInput, type PersonagemResumo,
} from "../api";
import { getSocket } from "../socket";
import { ModalConfirmar } from "../Modal";

const fmtMoeda = (cents: number | null | undefined, casas = 2) =>
  cents === null || cents === undefined ? "—" : (cents / 100).toFixed(casas);

interface Props {
  characterId: string;
  campaignId: string;
  souMestre: boolean;
}

type Aba = "inventario" | "equipamentos" | "veiculos" | "dinheiro" | "catalogo";

export default function Patrimonio({ characterId, campaignId, souMestre }: Props) {
  const [aba, setAba] = useState<Aba>("inventario");
  const [erro, setErro] = useState<string | null>(null);
  const recarregarRef = useRef<{ fn?: () => Promise<void> }>({}).current;

  const avisoErro = (e: unknown) => setErro(e instanceof Error ? e.message : "Erro");

  useEffect(() => {
    const socket = getSocket();
    socket.emit("entrar-campanha", campaignId, () => undefined);
    const aoMudar = () => recarregarRef.fn?.();
    socket.on("patrimonio:atualizado", aoMudar);
    socket.on("inventario:atualizado", aoMudar);
    return () => {
      socket.off("patrimonio:atualizado", aoMudar);
      socket.off("inventario:atualizado", aoMudar);
      socket.emit("sair-campanha", campaignId);
    };
  }, [campaignId]);

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
      {aba === "inventario" && <Inventario characterId={characterId} campaignId={campaignId} souMestre={souMestre} aoErro={avisoErro} recarregarRef={recarregarRef} />}
      {aba === "equipamentos" && <Equipamentos characterId={characterId} aoErro={avisoErro} recarregarRef={recarregarRef} />}
      {aba === "veiculos" && <Veiculos characterId={characterId} aoErro={avisoErro} recarregarRef={recarregarRef} />}
      {aba === "dinheiro" && <Dinheiro characterId={characterId} campaignId={campaignId} souMestre={souMestre} aoErro={avisoErro} recarregarRef={recarregarRef} />}
      {aba === "catalogo" && <Catalogo campaignId={campaignId} aoErro={avisoErro} recarregarRef={recarregarRef} />}
    </section>
  );
}

// ================= INVENTÁRIO =================

function Inventario({ characterId, campaignId, souMestre, aoErro, recarregarRef }: {
  characterId: string; campaignId: string; souMestre: boolean;
  aoErro: (e: unknown) => void;
  recarregarRef: { fn?: () => Promise<void> };
}) {
  const [itens, setItens] = useState<ItemInventario[]>([]);
  const [pesoTotal, setPesoTotal] = useState<number | null>(null);
  const [pesoMax, setPesoMax] = useState<number | null>(null);
  const [pesoExcedido, setPesoExcedido] = useState(false);
  const [catalogo, setCatalogo] = useState<{ id: string; name: string; category: string | null; data: Record<string, unknown> }[]>([]);
  const [busca, setBusca] = useState("");
  const [filtroCat, setFiltroCat] = useState("");
  const [personagens, setPersonagens] = useState<PersonagemResumo[]>([]);
  const [novo, setNovo] = useState<ItemInventarioInput>({ name: "", quantity: 1 });
  const [editando, setEditando] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[]>([]);
  const [confirmandoItem, setConfirmandoItem] = useState<ItemInventario | null>(null);
  const [ocupadoItem, setOcupadoItem] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const [inv, cat, pers] = await Promise.all([
        api.listarInventario(characterId),
        api.listarCatalogo(campaignId).catch(() => ({ itens: [], categorias: [] })),
        api.listarPersonagens(campaignId).catch(() => ({ personagens: [] })),
      ]);
      setItens(inv.itens); setPesoTotal(inv.pesoTotal); setPesoMax(inv.pesoMaximo); setPesoExcedido(inv.pesoExcedido);
      setCatalogo(cat.itens); setPersonagens(pers.personagens);
    } catch (e) { aoErro(e); }
  }, [characterId, campaignId, aoErro]);

  useEffect(() => { void carregar(); recarregarRef.fn = carregar; }, [carregar, recarregarRef]);
  useEffect(() => { api.listarEquipamentos(characterId).then((r) => setSlots(r.slots)).catch(() => undefined); }, [characterId]);

  const categorias = [...new Set([...itens.map((i) => i.category).filter(Boolean) as string[], ...catalogo.map((c) => c.category).filter(Boolean) as string[]])].sort();
  const visiveis = itens.filter((i) =>
    (!filtroCat || i.category === filtroCat) &&
    (!busca || i.name.toLowerCase().includes(busca.toLowerCase()) || (i.description ?? "").toLowerCase().includes(busca.toLowerCase()))
  );

  const submeterNovo = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.adicionarItem(characterId, novo);
      setNovo({ name: "", quantity: 1 });
      await carregar();
    } catch (err) { aoErro(err); }
  };

  const qtd = (_item: ItemInventario, data: Record<string, unknown>) => Number(data.valueCents ?? 0);

  return (
    <div>
      {pesoTotal !== null && (
        <p className={`meta ${pesoExcedido ? "erro" : ""}`}>
          Peso: {pesoTotal.toFixed(1)} / {pesoMax} kg{pesoExcedido ? " — peso excedido" : ""}
        </p>
      )}
      <div className="linha">
        <input placeholder="Buscar item…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <select value={filtroCat} onChange={(e) => setFiltroCat(e.target.value)}>
          <option value="">Todas as categorias</option>
          {categorias.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <form className="formulario linha" onSubmit={submeterNovo}>
        <input placeholder="Nome do item" value={novo.name} onChange={(e) => setNovo({ ...novo, name: e.target.value })} required />
        <input type="number" min="0.01" step="any" placeholder="Qtd" value={novo.quantity} onChange={(e) => setNovo({ ...novo, quantity: Number(e.target.value) })} style={{ width: 80 }} />
        <input placeholder="Categoria" value={novo.category ?? ""} onChange={(e) => setNovo({ ...novo, category: e.target.value })} list="cats-inv" />
        <datalist id="cats-inv">{categorias.map((c) => <option key={c} value={c} />)}</datalist>
        <input placeholder="Peso (kg)" type="number" min="0" step="any" value={novo.weight ?? ""} onChange={(e) => setNovo({ ...novo, weight: e.target.value === "" ? undefined : Number(e.target.value) })} style={{ width: 110 }} />
        <input placeholder="Local" value={novo.location ?? ""} onChange={(e) => setNovo({ ...novo, location: e.target.value })} />
        <button type="submit">Adicionar</button>
      </form>

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
                {editando === item.id ? (
                  <input type="number" min="0.01" step="any" defaultValue={item.quantity} style={{ width: 70 }}
                    onBlur={async (e) => {
                      const q = Number(e.target.value);
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
                <button className="secundario" title="Equipar" onClick={async () => {
                  try { await api.equiparItem(characterId, item.id, slots[0]); await carregar(); } catch (e) { aoErro(e); }
                }}>Equipar</button>
                <TransferirButton item={item} personagens={personagens} proprioId={characterId} souMestre={souMestre} onTransfer={async (dest, q) => {
                  await api.transferirItem(characterId, item.id, dest, q);
                  await carregar();
                }} aoErro={aoErro} />
                <button className="perigo" onClick={() => setConfirmandoItem(item)}>×</button>
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
              {editando === item.id ? (
                <input type="number" min="0.01" step="any" defaultValue={item.quantity} style={{ width: 90 }}
                  onBlur={async (e) => {
                    const q = Number(e.target.value);
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
            <div className="registro-acoes">
              <button className="secundario" title="Equipar" onClick={async () => {
                try { await api.equiparItem(characterId, item.id, slots[0]); await carregar(); } catch (e) { aoErro(e); }
              }}>Equipar</button>
              <TransferirButton item={item} personagens={personagens} proprioId={characterId} souMestre={souMestre} onTransfer={async (dest, q) => {
                await api.transferirItem(characterId, item.id, dest, q);
                await carregar();
              }} aoErro={aoErro} />
              <button className="perigo" onClick={() => setConfirmandoItem(item)}>×</button>
            </div>
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
    </div>
  );
}

function TransferirButton({ item, personagens, proprioId, souMestre, onTransfer, aoErro }: {
  item: ItemInventario; personagens: PersonagemResumo[]; proprioId: string; souMestre: boolean;
  onTransfer: (destinoId: string, quantidade?: number) => Promise<void>;
  aoErro: (e: unknown) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [destino, setDestino] = useState("");
  const [qtd, setQtd] = useState<number | undefined>(undefined);
  const outros = personagens.filter((p) => p.id !== proprioId);
  if (!souMestre && (item.data?.transferable === false)) return null;
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

// ================= EQUIPAMENTOS =================

function Equipamentos({ characterId, aoErro, recarregarRef }: {
  characterId: string; aoErro: (e: unknown) => void;
  recarregarRef: { fn?: () => Promise<void> };
}) {
  const [lista, setLista] = useState<Equipamento[]>([]);
  const [slots, setSlots] = useState<string[]>([]);
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

  return (
    <div>
      <div className="linha">
        {slots.length > 0 && slots.map((s) => {
          const ocupado = lista.find((e) => e.slot === s && e.equipped);
          return <span key={s} className="tag">{s}: {ocupado?.name ?? "—"}</span>;
        })}
      </div>
      <form className="formulario linha" onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        try {
          await api.adicionarEquipamento(characterId, { name: nome, slot: slot || undefined, equipped: true, description: descricao || undefined });
          setNome(""); setSlot(""); setDescricao("");
          await carregar();
        } catch (err) { aoErro(err); }
      }}>
        <input placeholder="Nome do equipamento" value={nome} onChange={(e) => setNome(e.target.value)} required />
        <select value={slot} onChange={(e) => setSlot(e.target.value)}>
          <option value="">Sem posição</option>
          {slots.map((s) => <option key={s} value={s}>{s}</option>)}
          {!slots.includes(slot) && slot && <option value={slot}>{slot}</option>}
        </select>
        <input placeholder="Descrição" value={descricao} onChange={(e) => setDescricao(e.target.value)} />
        <button type="submit">Adicionar</button>
      </form>
      <table className="tabela">
        <thead><tr><th>Equipamento</th><th>Posição</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          {lista.map((eq) => (
            <tr key={eq.id}>
              <td>{eq.name}{eq.description && <div className="meta">{eq.description}</div>}</td>
              <td>{eq.slot ?? "—"}</td>
              <td>{eq.equipped ? "Equipado" : "Guardado"}</td>
              <td>
                {eq.equipped
                  ? <button className="secundario" onClick={async () => { try { await api.desequipar(characterId, eq.id); await carregar(); } catch (e) { aoErro(e); } }}>Desequipar</button>
                  : <button className="secundario" onClick={async () => {
                      try {
                        // PATCH equipped=true via endpoint de patch genérico? usar PATCH equipamentos
                        await api.atualizarEquipamento(characterId, eq.id, { equipped: true });
                        await carregar();
                      } catch (e) { aoErro(e); }
                    }}>Equipar</button>}
              </td>
            </tr>
          ))}
          {lista.length === 0 && <tr><td colSpan={4} className="meta">Nenhum equipamento.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ================= VEÍCULOS =================

function Veiculos({ characterId, aoErro, recarregarRef }: {
  characterId: string; aoErro: (e: unknown) => void;
  recarregarRef: { fn?: () => Promise<void> };
}) {
  const [lista, setLista] = useState<Veiculo[]>([]);
  const [novo, setNovo] = useState<VeiculoInput>({ name: "", kind: "carro" });
  const [confirmandoVeiculo, setConfirmandoVeiculo] = useState<Veiculo | null>(null);
  const [ocupadoVeiculo, setOcupadoVeiculo] = useState(false);

  const carregar = useCallback(async () => {
    try { setLista((await api.listarVeiculos(characterId)).veiculos); } catch (e) { aoErro(e); }
  }, [characterId, aoErro]);
  useEffect(() => { void carregar(); recarregarRef.fn = carregar; }, [carregar, recarregarRef]);

  const TIPOS = ["carro", "motocicleta", "caminhao", "barco", "helicoptero", "aviao", "militar", "futurista", "outro"];

  return (
    <div>
      <form className="formulario" onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        try { await api.adicionarVeiculo(characterId, novo); setNovo({ name: "", kind: "carro" }); await carregar(); }
        catch (err) { aoErro(err); }
      }}>
        <div className="grade-2">
          <label>Nome<input value={novo.name} onChange={(e) => setNovo({ ...novo, name: e.target.value })} required /></label>
          <label>Tipo
            <select value={novo.kind} onChange={(e) => setNovo({ ...novo, kind: e.target.value })}>
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
        <button type="submit">Adicionar veículo</button>
      </form>
      <table className="tabela tabela-responsiva">
        <thead><tr><th>Veículo</th><th>Tipo</th><th>Marca/Modelo</th><th>Ano</th><th>Placa</th><th>Posse</th><th></th></tr></thead>
        <tbody>
          {lista.map((v) => (
            <tr key={v.id}>
              <td>{v.name}</td>
              <td>{v.kind ?? "—"}</td>
              <td>{[v.brand, v.model].filter(Boolean).join(" ") || "—"}</td>
              <td>{v.year ?? "—"}</td>
              <td>{v.plate ?? "—"}</td>
              <td>{v.ownership === "compartilhado" ? "Compartilhado" : "Propriedade"}</td>
              <td><button className="perigo" onClick={() => setConfirmandoVeiculo(v)}>×</button></td>
            </tr>
          ))}
          {lista.length === 0 && <tr><td colSpan={7} className="meta">Nenhum veículo.</td></tr>}
        </tbody>
      </table>
      <div className="cartoes-registro">
        {lista.map((v) => (
          <div key={v.id} className="registro-cartao">
            <div className="registro-campo"><strong>{v.name}</strong><span className="tag">{v.kind ?? "—"}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Marca/Modelo</span><span>{[v.brand, v.model].filter(Boolean).join(" ") || "—"}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Ano</span><span>{v.year ?? "—"}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Placa</span><span>{v.plate ?? "—"}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Posse</span><span>{v.ownership === "compartilhado" ? "Compartilhado" : "Propriedade"}</span></div>
            <div className="registro-acoes">
              <button className="perigo" onClick={() => setConfirmandoVeiculo(v)}>×</button>
            </div>
          </div>
        ))}
        {lista.length === 0 && <p className="meta">Nenhum veículo.</p>}
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

function Dinheiro({ characterId, campaignId, souMestre, aoErro, recarregarRef }: {
  characterId: string; campaignId: string; souMestre: boolean; aoErro: (e: unknown) => void;
  recarregarRef: { fn?: () => Promise<void> };
}) {
  const [fin, setFin] = useState<Financeiro | null>(null);
  const [contasOutros, setContasOutros] = useState<{ conta: ContaFinanceira; personagem: string }[]>([]);

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
  const fmt = (cents: number | null | undefined) => fmtMoeda(cents, cfg.casasDecimais);

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

      <NovaConta characterId={characterId} cfg={cfg} aoErro={aoErro} aoOk={carregar} />
      <Movimentar characterId={characterId} contas={fin.contas} souMestre={souMestre} aoErro={aoErro} aoOk={carregar} />
      <Transferir characterId={characterId} contas={fin.contas} contasOutros={contasOutros} souMestre={souMestre} aoErro={aoErro} aoOk={carregar} />

      <h4>Histórico financeiro</h4>
      <table className="tabela tabela-responsiva">
        <thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>Conta</th><th>Contraparte</th><th>Valor</th><th>Saldo após</th></tr></thead>
        <tbody>
          {fin.historico.map((t) => (
            <tr key={t.id}>
              <td>{new Date(t.createdAt).toLocaleString("pt-BR")}</td>
              <td>{t.kind}</td>
              <td>{t.description ?? "—"}</td>
              <td>{t.account ?? "—"}</td>
              <td>{t.counterparty ?? "—"}</td>
              <td className={t.amountCents !== null && t.amountCents < 0 ? "erro" : "online"}>{t.amountCents !== null ? fmt(t.amountCents) : fmt(t.amount * 100)}</td>
              <td>{t.balanceAfterCents !== null ? fmt(t.balanceAfterCents) : "—"}</td>
            </tr>
          ))}
          {fin.historico.length === 0 && <tr><td colSpan={7} className="meta">Sem movimentações.</td></tr>}
        </tbody>
      </table>
      <div className="cartoes-registro">
        {fin.historico.map((t) => (
          <div key={t.id} className="registro-cartao">
            <div className="registro-campo"><span className="registro-rotulo">Data</span><span>{new Date(t.createdAt).toLocaleString("pt-BR")}</span></div>
            <div className="registro-campo"><span className="registro-rotulo">Tipo</span><span>{t.kind}</span></div>
            {t.description && <div className="registro-campo"><span className="registro-rotulo">Descrição</span><span>{t.description}</span></div>}
            <div className="registro-campo"><span className="registro-rotulo">Conta</span><span>{t.account ?? "—"}</span></div>
            {t.counterparty && <div className="registro-campo"><span className="registro-rotulo">Contraparte</span><span>{t.counterparty}</span></div>}
            <div className="registro-campo">
              <span className="registro-rotulo">Valor</span>
              <span className={t.amountCents !== null && t.amountCents < 0 ? "erro" : "online"}>{t.amountCents !== null ? fmt(t.amountCents) : fmt(t.amount * 100)}</span>
            </div>
            <div className="registro-campo"><span className="registro-rotulo">Saldo após</span><span>{t.balanceAfterCents !== null ? fmt(t.balanceAfterCents) : "—"}</span></div>
          </div>
        ))}
        {fin.historico.length === 0 && <p className="meta">Sem movimentações.</p>}
      </div>
    </div>
  );
}

function NovaConta({ characterId, cfg, aoErro, aoOk }: {
  characterId: string;
  cfg: Financeiro["config"];
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
          try { await api.criarConta(characterId, form); setAberto(false); setForm({ type: "especie", name: "", balanceReais: 0 }); await aoOk(); }
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
          <input placeholder="Saldo inicial" type="number" step="0.01" value={form.balanceReais ?? 0} onChange={(e) => setForm({ ...form, balanceReais: Number(e.target.value) })} style={{ width: 110 }} />
          {form.type === "cartao_credito" && (
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

function Transferir({ characterId, contas, contasOutros, souMestre, aoErro, aoOk }: {
  characterId: string; contas: ContaFinanceira[]; contasOutros: { conta: ContaFinanceira; personagem: string }[];
  souMestre: boolean; aoErro: (e: unknown) => void; aoOk: () => Promise<void>;
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
            <optgroup label="Minhas contas">
              {contas.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.currency})</option>)}
            </optgroup>
            <optgroup label="Outros personagens">
              {contasOutros.map((o) => <option key={o.conta.id} value={o.conta.id}>{o.personagem} — {o.conta.name} ({o.conta.currency})</option>)}
            </optgroup>
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

function Catalogo({ campaignId, aoErro, recarregarRef }: {
  campaignId: string; aoErro: (e: unknown) => void;
  recarregarRef: { fn?: () => Promise<void> };
}) {
  const [itens, setItens] = useState<ItemCatalogo[]>([]);
  const [novo, setNovo] = useState<ItemCatalogoInput>({ name: "", category: "" });
  const [busca, setBusca] = useState("");
  const [confirmandoItem, setConfirmandoItem] = useState<ItemCatalogo | null>(null);
  const [ocupadoItem, setOcupadoItem] = useState(false);

  const carregar = useCallback(async () => {
    try { setItens((await api.listarCatalogo(campaignId)).itens); } catch (e) { aoErro(e); }
  }, [campaignId, aoErro]);
  useEffect(() => { void carregar(); recarregarRef.fn = carregar; }, [carregar, recarregarRef]);

  const visiveis = itens.filter((i) => !busca || i.name.toLowerCase().includes(busca.toLowerCase()) || (i.category ?? "").toLowerCase().includes(busca.toLowerCase()));

  return (
    <div>
      <p className="meta">Itens do catálogo da campanha — disponíveis para adicionar rapidamente ao inventário dos personagens.</p>
      <div className="linha">
        <input placeholder="Buscar…" value={busca} onChange={(e) => setBusca(e.target.value)} />
      </div>
      <form className="formulario linha" onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        try { await api.criarItemCatalogo(campaignId, { ...novo, category: novo.category || undefined }); setNovo({ name: "", category: "" }); await carregar(); }
        catch (err) { aoErro(err instanceof ApiError ? err.message : err); }
      }}>
        <input placeholder="Nome do item" value={novo.name} onChange={(e) => setNovo({ ...novo, name: e.target.value })} required />
        <input placeholder="Categoria" value={novo.category ?? ""} onChange={(e) => setNovo({ ...novo, category: e.target.value })} />
        <input placeholder="Descrição" value={novo.description ?? ""} onChange={(e) => setNovo({ ...novo, description: e.target.value })} />
        <button type="submit">Adicionar ao catálogo</button>
      </form>
      <table className="tabela">
        <thead><tr><th>Item</th><th>Categoria</th><th>Descrição</th><th></th></tr></thead>
        <tbody>
          {visiveis.map((i) => (
            <tr key={i.id}>
              <td>{i.name}</td>
              <td>{i.category ?? "—"}</td>
              <td>{i.description ?? "—"}</td>
              <td><button className="perigo" onClick={() => setConfirmandoItem(i)}>×</button></td>
            </tr>
          ))}
          {visiveis.length === 0 && <tr><td colSpan={4} className="meta">Catálogo vazio.</td></tr>}
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
