import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
import IconeInterface from "../IconeInterface";
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

export default function Campanha({ id, aoVoltar }: { id: string; aoVoltar: () => void }) {
  const [campanha, setCampanha] = useState<CampanhaResumo | null>(null);
  const [membros, setMembros] = useState<Membro[]>([]);
  const [convites, setConvites] = useState<Convite[]>([]);
  const [aba, setAba] = useState<Aba>("info");
  const abaRef = useRef<Aba>("info");
  abaRef.current = aba;
  const [erro, setErro] = useState<string | null>(null);
  // Erro de leitura (carregar) é separado de erro de ação (PATCH/POST):
  // o retry de uma ação rejeitada reenvia a MESMA mutação com os dados
  // atuais — nunca um GET que sobrescreveria o rascunho local.
  const [erroAcao, setErroAcao] = useState<{ texto: string; retry?: () => void } | null>(null);
  // Issue #239 — membros/convites carregam junto da campanha; gate
  // evita o "EstadoVazio" de convites piscar antes do GET resolver.
  const [extrasCarregados, setExtrasCarregados] = useState(false);
  const [editando, setEditando] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", system: "", status: "preparacao" });
  const [conviteCriado, setConviteCriado] = useState<{ code: string } | null>(null);
  const [conviteForm, setConviteForm] = useState({ role: "jogador", maxUses: "", expiresInHours: "", requiresApproval: false });
  const [confirmando, setConfirmando] = useState<{ m: Membro; acao: "remover" | "transferir" } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  // Refs espelham os formulários para que o retry de uma ação rejeitada
  // envie o rascunho MAIS RECENTE (o closure do erro pode ser antigo).
  const formRef = useRef(form);
  formRef.current = form;
  const conviteFormRef = useRef(conviteForm);
  conviteFormRef.current = conviteForm;

  const souMestre = campanha?.meuPapel === "mestre";
  // Personagens exige mestre/jogador no backend (GET /characters → 403
  // para espectador): a aba e a página só existem para quem pode ler.
  const vePersonagens = campanha?.meuPapel !== "espectador";

  // A permissão pode mudar em tempo real enquanto a pessoa está numa aba
  // que acabou de deixar de existir. Recoloca a seleção numa aba pública
  // para manter uma tab selecionada, com painel visível e foco alcançável.
  useEffect(() => {
    const abaExclusivaMestre =
      aba === "fichas" || aba === "regras" || aba === "participantes" || aba === "convites";
    if ((!souMestre && abaExclusivaMestre) || (!vePersonagens && aba === "personagens")) {
      setAba("info");
    }
  }, [aba, souMestre, vePersonagens]);

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
      setExtrasCarregados(true);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar campanha");
    }
  }, [id]);

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
    const aoMudar = () => void carregar();
    socket.on("membros:atualizados", aoMudar);
    socket.on("campanha:atualizada", aoMudar);
    return () => {
      socket.off("connect", entrar);
      socket.off("membros:atualizados", aoMudar);
      socket.off("campanha:atualizada", aoMudar);
      socket.emit("sair-campanha", id);
    };
  }, [id, carregar]);

  // Se a reconexão aconteceu na aba Mesa sem sessão aberta (MesaView não