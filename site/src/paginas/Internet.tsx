import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type FichaRenderizada, type ItemCatalogo, type ItemInventario,
} from "../api";
import { getSocket } from "../socket";

interface Props {
  characterId: string;
  campaignId: string;
  ficha: FichaRenderizada | null;
}

/** Chaves canônicas do gate de acesso à Internet (ordem #286):
 *  conhecimento em Computador OU talento Tecnologia ≥ 1, E posse de
 *  Notebook OU Celular no inventário — sempre via vínculo `regra`
 *  {kind,key} do Acervo, nunca por substring de nome. */
const REGRA_CONHECIMENTO = [
  { kind: "conhecimento", key: "computador", rotulo: "Computador" },
  { kind: "talento", key: "tecnologia", rotulo: "Tecnologia" },
] as const;
const REGRA_DISPOSITIVO = [
  { kind: "item", key: "notebook", rotulo: "Notebook" },
  { kind: "item", key: "celular", rotulo: "Celular" },
] as const;

const mesmaRegra = (regra: unknown, kind: string, key: string) =>
  !!regra && typeof regra === "object" &&
  (regra as { kind?: unknown }).kind === kind &&
  (regra as { key?: unknown }).key === key;

interface ResultadoGate {
  carregando: boolean;
  erro: string | null;
  /** true = requerimento atendido; null = não foi possível verificar (fail-closed). */
  conhecimento: boolean | null;
  dispositivo: boolean | null;
  detalheConhecimento: string;
  detalheDispositivo: string;
}

/** Internet (1.1.0): ponto de entrada independente da ficha. Nesta etapa
 *  implementa o gate cumulativo de elegibilidade — o comércio diegético
 *  (lojas, checkout, LOJA-B) depende dos endpoints do backend em
 *  integração e só é exibido quando o servidor os oferecer. A avaliação
 *  aqui é de UX; o servidor é sempre a autoridade final. */
export default function Internet({ characterId, campaignId, ficha }: Props) {
  const [gate, setGate] = useState<ResultadoGate>({
    carregando: true, erro: null,
    conhecimento: null, dispositivo: null,
    detalheConhecimento: "", detalheDispositivo: "",
  });
  const recarregarRef = useRef<() => Promise<void>>(async () => undefined);

  const carregar = useCallback(async () => {
    setGate((g) => ({ ...g, carregando: true, erro: null }));
    try {
      const [{ itens }, { itens: catalogo }] = await Promise.all([
        api.listarInventario(characterId),
        api.listarCatalogo(campaignId),
      ]);

      // --- Dispositivo: item do inventário vinculado ao Acervo (regra
      // direta em data.regra ou via templateId → data.regra do catálogo).
      const regraDoTemplate = new Map<string, unknown>();
      for (const t of catalogo as ItemCatalogo[]) {
        regraDoTemplate.set(t.id, (t.data as Record<string, unknown> | undefined)?.regra);
      }
      const itensComRegra = (itens as ItemInventario[]).filter((i) => (i.quantity ?? 0) > 0);
      const ehDispositivo = (i: ItemInventario) => {
        const direta = (i.data as Record<string, unknown> | undefined)?.regra;
        const viaTemplate = typeof i.data?.templateId === "string"
          ? regraDoTemplate.get(i.data.templateId as string)
          : undefined;
        return REGRA_DISPOSITIVO.some((r) =>
          mesmaRegra(direta, r.kind, r.key) || mesmaRegra(viaTemplate, r.kind, r.key));
      };
      const dispositivo = itensComRegra.some(ehDispositivo);

      // --- Conhecimento: campo da ficha vinculado ao elemento canônico.
      // Sem ficha publicada não há como verificar → fail-closed.
      let conhecimento: boolean | null = null;
      let detalheConhecimento = "";
      if (!ficha?.estrutura) {
        detalheConhecimento = "Ficha do personagem indisponível — não foi possível verificar o conhecimento.";
      } else {
        const campos = ficha.estrutura.secoes.flatMap((s) => [
          ...s.campos,
          ...ficha.estrutura.secoes.filter((x) => x.parentId === s.id).flatMap((x) => x.campos),
        ]);
        const atendidos: string[] = [];
        for (const c of campos) {
          const regra = c.regra;
          if (!REGRA_CONHECIMENTO.some((r) => mesmaRegra(regra, r.kind, r.key))) continue;
          const valor = ficha.campos[c.id];
          const nivel = typeof valor === "number" ? valor : Number(valor);
          if (Number.isFinite(nivel) && nivel >= 1) {
            atendidos.push(REGRA_CONHECIMENTO.find((r) => mesmaRegra(regra, r.kind, r.key))!.rotulo);
          }
        }
        conhecimento = atendidos.length > 0;
        detalheConhecimento = conhecimento
          ? `Conhecimento verificado: ${[...new Set(atendidos)].join(", ")}.`
          : "Nenhum campo da ficha com vínculo a Computador (conhecimento) ou Tecnologia (talento) atinge nível 1.";
      }

      const detalheDispositivo = dispositivo
        ? "Dispositivo verificado: Notebook ou Celular presente no inventário."
        : "Nenhum item do inventário vinculado a Notebook ou Celular (Acervo).";

      setGate({ carregando: false, erro: null, conhecimento, dispositivo, detalheConhecimento, detalheDispositivo });
    } catch (e) {
      setGate({
        carregando: false,
        erro: e instanceof Error ? e.message : "Erro ao verificar acesso",
        conhecimento: null, dispositivo: null,
        detalheConhecimento: "", detalheDispositivo: "",
      });
    }
  }, [characterId, campaignId, ficha]);
  recarregarRef.current = carregar;

  useEffect(() => {
    void carregar();
    const socket = getSocket();
    socket.emit("entrar-campanha", campaignId, () => undefined);
    const aoMudar = () => void recarregarRef.current();
    socket.on("patrimonio:atualizado", aoMudar);
    socket.on("inventario:atualizado", aoMudar);
    socket.on("fichas:atualizadas", aoMudar);
    socket.on("regras:atualizadas", aoMudar);
    return () => {
      socket.off("patrimonio:atualizado", aoMudar);
      socket.off("inventario:atualizado", aoMudar);
      socket.off("fichas:atualizadas", aoMudar);
      socket.off("regras:atualizadas", aoMudar);
      socket.emit("sair-campanha", campaignId);
    };
  }, [campaignId, carregar]);

  const elegivel = gate.conhecimento === true && gate.dispositivo === true;

  return (
    <section className="cartao" aria-label="Internet">
      <h3>Internet</h3>
      {gate.carregando && <p className="meta">Verificando acesso…</p>}
      {gate.erro && <p className="erro" role="alert">{gate.erro}</p>}

      {!gate.carregando && !gate.erro && (
        <div aria-live="polite">
          <h4>Requisitos de acesso</h4>
          <ul className="meta">
            <li>
              Conhecimento: {gate.conhecimento === true ? "✓ atendido" : gate.conhecimento === false ? "✗ não atendido" : "não verificável"}
              {" — "}{gate.detalheConhecimento}
            </li>
            <li>
              Dispositivo: {gate.dispositivo === true ? "✓ atendido" : gate.dispositivo === false ? "✗ não atendido" : "não verificável"}
              {" — "}{gate.detalheDispositivo}
            </li>
          </ul>

          {!elegivel && (
            <p className="meta">
              O acesso à Internet exige as duas condições: pelo menos 1 ponto em
              Computador ou Tecnologia <strong>e</strong> um Notebook ou Celular no
              inventário. A verificação exibida é indicativa — o servidor é a
              autoridade final em todas as operações.
            </p>
          )}

          {elegivel && (
            <section className="cartao cartao-destaque" aria-label="Acesso à Internet liberado">
              <p className="online">Acesso à Internet liberado para este personagem.</p>
              <p className="meta">
                O comércio diegético (lojas, ofertas, checkout e vendas) está em
                integração no servidor desta versão. Esta tela passa a exibir as
                vitrines quando os serviços estiverem disponíveis — nenhuma
                funcionalidade futura é anunciada aqui.
              </p>
            </section>
          )}
        </div>
      )}
    </section>
  );
}
