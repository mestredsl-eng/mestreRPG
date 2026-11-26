// F4 / Issue #352 — harness de desenvolvimento para revisão visual/a11y.
// SOMENTE em DEV (import.meta.env.DEV) via ?harness=internet-f4 — nunca
// entra no build de produção e nunca é montado pela aplicação real.
// Dados são fixtures ilustrativos para inspeção das telas e estados;
// não representam integração com backend.

import { useState } from "react";
import InternetDiegetica from "./InternetDiegetica";
import type { AdaptadorInternet } from "./adaptador";
import type {
  ContaInternet, ContatosInternet, ConversaResumo, DetalhesGrupo,
  EventoInternet, MensagemInternet, PaginaMensagens, ResultadoEnvio,
} from "./tipos";

const conta: ContaInternet = { id: "cta-1", handle: "lyra_stormwind", nomePersonagem: "Lyra Stormwind" };

const contatos: ContatosInternet = {
  aceitos: [
    { id: "ct1", contaId: "cta-2", handle: "borin_ferro", nomePersonagem: "Borin Ferro", estado: "aceito", direcao: "recebido" },
    { id: "ct2", contaId: "cta-3", handle: "mira_vega", nomePersonagem: "Mira Vega", estado: "aceito", direcao: "enviado" },
    { id: "ct3", contaId: "cta-4", handle: "tomas_cinza", nomePersonagem: "Tomás Cinza", estado: "aceito", direcao: "enviado" },
  ],
  pedidosRecebidos: [
    { id: "ct4", contaId: "cta-5", handle: "nix_bric", nomePersonagem: "Nix Bric", estado: "pendente", direcao: "recebido" },
  ],
  pedidosEnviados: [
    { id: "ct5", contaId: "cta-6", handle: "vex_ono", nomePersonagem: "Vex Ono", estado: "pendente", direcao: "enviado" },
  ],
  bloqueados: [
    { id: "ct6", contaId: "cta-7", handle: "spam_bot", nomePersonagem: "Spam Bot", estado: "bloqueado", direcao: "enviado" },
  ],
};

const conversas: ConversaResumo[] = [
  {
    id: "cv-1", tipo: "direta", nome: null,
    interlocutor: { contaId: "cta-2", handle: "borin_ferro", nomePersonagem: "Borin Ferro" },
    ultimaMensagem: { conteudo: "A caravana parte amanhã de madrugada.", criadoEm: "2026-11-26T03:00:00Z", autorHandle: "borin_ferro" },
    naoLidas: 2, atualizadoEm: "2026-11-26T03:00:00Z", status: "ativa",
  },
  {
    id: "cv-2", tipo: "grupo", nome: "Caçada de quinta",
    ultimaMensagem: { conteudo: "Levem poção — o lodo é bravo.", criadoEm: "2026-11-25T22:00:00Z", autorHandle: "mira_vega" },
    naoLidas: 0, atualizadoEm: "2026-11-25T22:00:00Z", status: "ativa",
  },
];

const mensagensCv1: MensagemInternet[] = [
  { id: "m1", conversaId: "cv-1", contaIdAutor: "cta-2", autorHandle: "borin_ferro", autorNome: "Borin Ferro", tipo: "texto", conteudo: "A caravana parte amanhã de madrugada.", criadoEm: "2026-11-26T02:58:00Z", requestId: "r1", minha: false },
  { id: "m2", conversaId: "cv-1", contaIdAutor: "cta-2", autorHandle: "borin_ferro", autorNome: "Borin Ferro", tipo: "texto", conteudo: "Encontro no beco dos caixotes.", criadoEm: "2026-11-26T03:00:00Z", requestId: "r2", minha: false },
];

const mensagensCv2: MensagemInternet[] = [
  { id: "m3", conversaId: "cv-2", contaIdAutor: "cta-3", autorHandle: "mira_vega", autorNome: "Mira Vega", tipo: "texto", conteudo: "Levem poção — o lodo é bravo.", criadoEm: "2026-11-25T21:59:00Z", requestId: "r3", minha: false },
  { id: "m4", conversaId: "cv-2", contaIdAutor: "cta-1", autorHandle: "lyra_stormwind", autorNome: "Lyra Stormwind", tipo: "texto", conteudo: "Anotado. Eu cuido da retaguarda.", criadoEm: "2026-11-25T22:00:00Z", requestId: "r4", minha: true },
];

const detalhesCv2: DetalhesGrupo = {
  conversaId: "cv-2", nome: "Caçada de quinta", papelMinhaConta: "dono",
  meuStatusParticipante: "ativo", minhaContaId: "cta-1",
  membros: [
    { contaId: "cta-1", handle: "lyra_stormwind", nomePersonagem: "Lyra Stormwind", papel: "dono", status: "ativo" },
    { contaId: "cta-3", handle: "mira_vega", nomePersonagem: "Mira Vega", papel: "membro", status: "ativo" },
    { contaId: "cta-2", handle: "borin_ferro", nomePersonagem: "Borin Ferro", papel: "membro", status: "ativo" },
  ],
};

const pendente = () => Promise.reject(new Error("harness: não implementado"));

function criarAdaptadorFixture(): AdaptadorInternet {
  const enviadas = new Map<string, MensagemInternet[]>();
  return {
    obterConta: () => Promise.resolve(conta),
    listarContatos: () => Promise.resolve(contatos),
    enviarPedidoContato: () => Promise.resolve(),
    responderPedidoContato: () => Promise.resolve(),
    cancelarPedidoContato: () => Promise.resolve(),
    bloquearContato: () => Promise.resolve(),
    desbloquearContato: () => Promise.resolve(),
    removerContato: () => Promise.resolve(),
    listarConversas: () => Promise.resolve(conversas),
    obterPaginaMensagens: (conversaId: string): Promise<PaginaMensagens> => {
      const base = conversaId === "cv-1" ? mensagensCv1 : conversaId === "cv-2" ? mensagensCv2 : [];
      const extras = enviadas.get(conversaId) ?? [];
      return Promise.resolve({
        mensagens: [...base, ...extras],
        cursorAnterior: null,
        cursorLeitura: { lastReadCreatedAt: null, lastReadMessageId: null },
      });
    },
    enviarMensagem: (conversaId, conteudo, requestId): Promise<ResultadoEnvio> => {
      const m: MensagemInternet = {
        id: `m-${requestId}`, conversaId, contaIdAutor: conta.id,
        autorHandle: conta.handle, autorNome: conta.nomePersonagem,
        tipo: "texto", conteudo, criadoEm: new Date().toISOString(),
        requestId, minha: true, estadoEnvio: "enviada",
      };
      enviadas.set(conversaId, [...(enviadas.get(conversaId) ?? []), m]);
      return Promise.resolve({ mensagem: m, replay: false });
    },
    marcarLida: () => Promise.resolve(),
    iniciarConversaDireta: (contaId) => Promise.resolve({ conversaId: `cv-nova-${contaId}` }),
    criarGrupo: () => Promise.resolve({ conversaId: "cv-grupo-novo" }),
    convidarParaGrupo: () => Promise.resolve(),
    responderConviteGrupo: () => Promise.resolve(),
    sairDoGrupo: () => Promise.resolve(),
    renomearGrupo: () => Promise.resolve(),
    removerMembroGrupo: () => Promise.resolve(),
    obterDetalhesGrupo: () => Promise.resolve(detalhesCv2),
    inscreverEventos: (_o: (e: EventoInternet) => void) => () => {},
    estadoConexao: () => "conectado",
    // operações não exercitadas pelo harness falham de forma explícita
    // em vez de fingir sucesso — pendente() nunca é chamado porque os
    // métodos acima cobrem as telas; mantido como documentação.
  };
}

export default function HarnessInternet() {
  const [adaptador] = useState(() => criarAdaptadorFixture());
  void pendente;
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
      <h1>Harness F4 — Internet diegética (DEV)</h1>
      <p className="meta">Fixtures ilustrativos. Não é a aplicação real.</p>
      <InternetDiegetica adaptador={adaptador} />
    </main>
  );
}
