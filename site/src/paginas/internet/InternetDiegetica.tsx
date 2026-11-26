// F4 / Issue #352 — raiz visual da Internet diegética.
//
// Camada de UI do contrato #349/#360: assume que o gate do dispositivo
// já foi validado pelo chamador (Internet.tsx v1.1.0 — fail-closed no
// servidor). Recebe um `AdaptadorInternet` — hoje apenas o stub
// fail-closed `adaptadorInternetIndisponivel` existe; o adaptador real
// (F2 REST + F3 socket) será injetado quando o PAI fechar o contrato.
//
// Nada aqui busca dados por conta própria: toda informação vem do
// adaptador. Sem fetch falso, sem fixtures em produção.

import { useState } from "react";
import { adaptadorInternetIndisponivel, type AdaptadorInternet } from "./adaptador";
import type { ConexaoRealtime, ConversaResumo } from "./tipos";
import ContaInternet from "./ContaInternet";
import Contatos from "./Contatos";
import Mensagens from "./Mensagens";
import Conversa from "./Conversa";
import "./estilos-internet.css";

type Aba = "mensagens" | "conta";
type SubAbaMensagens = "caixa" | "contatos";

interface ConversaAberta {
  id: string;
  nome: string;
  tipo: "direta" | "grupo";
}

export default function InternetDiegetica({
  adaptador = adaptadorInternetIndisponivel,
  conexao = "conectado",
}: {
  adaptador?: AdaptadorInternet;
  conexao?: ConexaoRealtime;
}) {
  const [aba, setAba] = useState<Aba>("mensagens");
  const [subAba, setSubAba] = useState<SubAbaMensagens>("caixa");
  const [conversa, setConversa] = useState<ConversaAberta | null>(null);
  const [refreshLista, setRefreshLista] = useState(0);

  const nomeDeConversa = (c: ConversaResumo) =>
    c.tipo === "grupo" ? (c.nome ?? "Grupo") : (c.interlocutor ? `@${c.interlocutor.handle}` : "Conversa direta");

  const abrirConversa = (c: ConversaResumo) => {
    setConversa({ id: c.id, nome: nomeDeConversa(c), tipo: c.tipo });
  };

  // nome/tipo da conversa aberta: a caixa de entrada conhece o resumo;
  // Conversa recebe o rótulo já resolvido pelo chamador quando souber.
  // Para conversas abertas por id (deep-link/evento), o cabeçalho usa
  // um rótulo genérico honesto até o F2 expor resolução de título.
  return (
    <div className="internet-rede">
      {conexao !== "conectado" && aba !== null && !conversa && (
        <p className="internet-rede-banner internet-rede-banner-reconectando" role="status">
          Reconectando… as mensagens novas podem demorar um instante.
        </p>
      )}

      <div className="abas" role="tablist" aria-label="Internet do personagem">
        <button
          type="button"
          role="tab"
          aria-selected={aba === "mensagens"}
          className={aba === "mensagens" ? "ativo" : "secundario"}
          onClick={() => { setAba("mensagens"); setConversa(null); }}
        >
          Mensagens
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={aba === "conta"}
          className={aba === "conta" ? "ativo" : "secundario"}
          onClick={() => { setAba("conta"); setConversa(null); }}
        >
          Conta
        </button>
      </div>

      {aba === "conta" ? (
        <ContaInternet adaptador={adaptador} />
      ) : conversa ? (
        <Conversa
          key={conversa.id}
          adaptador={adaptador}
          conversaId={conversa.id}
          nomeConversa={conversa.nome}
          tipoConversa={conversa.tipo}
          conexao={conexao}
          aoVoltar={() => setConversa(null)}
          aoMudarLista={() => setRefreshLista((n) => n + 1)}
        />
      ) : (
        <>
          <div className="internet-contatos-subabas" role="tablist" aria-label="Seções de mensagens">
            <button
              type="button"
              role="tab"
              aria-selected={subAba === "caixa"}
              className={subAba === "caixa" ? "ativo" : "secundario"}
              onClick={() => setSubAba("caixa")}
            >
              Caixa de entrada
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={subAba === "contatos"}
              className={subAba === "contatos" ? "ativo" : "secundario"}
              onClick={() => setSubAba("contatos")}
            >
              Contatos
            </button>
          </div>
          {subAba === "caixa" ? (
            <Mensagens
              key={refreshLista}
              adaptador={adaptador}
              aoAbrirConversa={abrirConversa}
            />
          ) : (
            <Contatos
              adaptador={adaptador}
              aoIniciarConversa={async (contaId) => {
                try {
                  const { conversaId } = await adaptador.iniciarConversaDireta(contaId);
                  abrirConversa({
                    id: conversaId, tipo: "direta", nome: null, interlocutor: null,
                    ultimaMensagem: null, naoLidas: 0, atualizadoEm: new Date().toISOString(),
                    status: "ativa",
                  });
                } catch { /* erro já exibido pela superfície de contatos */ }
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
