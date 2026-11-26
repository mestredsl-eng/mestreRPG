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
import { aoTeclarAbas, AbaBotao } from "./abas";
import ContaInternet from "./ContaInternet";
import Contatos from "./Contatos";
import Mensagens from "./Mensagens";
import Conversa from "./Conversa";
import "./estilos-internet.css";

type Aba = "mensagens" | "conta";
type SubAbaMensagens = "caixa" | "contatos";

const ABAS_PRINCIPAIS = ["mensagens", "conta"] as const;
const SUBABAS_MENSAGENS = ["caixa", "contatos"] as const;

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

  return (
    <div className="internet-rede">
      {conexao !== "conectado" && !conversa && (
        <p className="internet-rede-banner internet-rede-banner-reconectando" role="status">
          Reconectando… as mensagens novas podem demorar um instante.
        </p>
      )}

      <div
        className="abas"
        role="tablist"
        aria-label="Internet do personagem"
        onKeyDown={(e) => aoTeclarAbas(e, [...ABAS_PRINCIPAIS], aba, (id) => { setAba(id as Aba); setConversa(null); })}
      >
        <AbaBotao id="mensagens" rotulo="Mensagens" ativo={aba === "mensagens"} controles="painel-mensagens" aoClicar={() => { setAba("mensagens"); setConversa(null); }} />
        <AbaBotao id="conta" rotulo="Conta" ativo={aba === "conta"} controles="painel-conta" aoClicar={() => { setAba("conta"); setConversa(null); }} />
      </div>

      {aba === "conta" ? (
        <div role="tabpanel" id="painel-conta" aria-labelledby="aba-conta">
          <ContaInternet adaptador={adaptador} />
        </div>
      ) : (
        <div role="tabpanel" id="painel-mensagens" aria-labelledby="aba-mensagens">
          {conversa ? (
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
              <div
                className="internet-contatos-subabas"
                role="tablist"
                aria-label="Seções de mensagens"
                onKeyDown={(e) => aoTeclarAbas(e, [...SUBABAS_MENSAGENS], subAba, (id) => setSubAba(id as SubAbaMensagens))}
              >
                <AbaBotao id="caixa" rotulo="Caixa de entrada" ativo={subAba === "caixa"} controles="painel-caixa" aoClicar={() => setSubAba("caixa")} />
                <AbaBotao id="contatos" rotulo="Contatos" ativo={subAba === "contatos"} controles="painel-contatos" aoClicar={() => setSubAba("contatos")} />
              </div>
              {subAba === "caixa" ? (
                <div role="tabpanel" id="painel-caixa" aria-labelledby="aba-caixa">
                  <Mensagens
                    key={refreshLista}
                    adaptador={adaptador}
                    aoAbrirConversa={abrirConversa}
                  />
                </div>
              ) : (
                <div role="tabpanel" id="painel-contatos" aria-labelledby="aba-contatos">
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
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
