import { useEffect, useState } from "react";
import { api, type ConviteInfo } from "../api";

const PAPEL_LABEL: Record<string, string> = { jogador: "Jogador", espectador: "Espectador" };

/** Tela de entrada por convite — /convite?code=XXXX-XXXX-XXXX */
export default function Convite({ aoEntrar }: { aoEntrar: () => void }) {
  const codigo = new URLSearchParams(window.location.search).get("code") ?? "";
  const [info, setInfo] = useState<ConviteInfo | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [processando, setProcessando] = useState(false);
  const [resultado, setResultado] = useState<string | null>(null);

  useEffect(() => {
    if (!codigo) {
      setErro("Código de convite ausente na URL.");
      return;
    }
    api
      .validarConvite(codigo)
      .then(({ convite }) => setInfo(convite))
      .catch((e) => setErro(e instanceof Error ? e.message : "Convite inválido"));
  }, [codigo]);

  const aceitar = async () => {
    setProcessando(true);
    setErro(null);
    try {
      const r = await api.aceitarConvite(codigo);
      setResultado(r.mensagem);
      if (r.status === "ativo") setTimeout(aoEntrar, 1500);
      else setTimeout(aoEntrar, 2500);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao entrar na campanha");
    } finally {
      setProcessando(false);
    }
  };

  return (
    <main className="container container-estreito">
      <h1>Convite para campanha</h1>

      {erro && <section className="cartao"><p className="erro">{erro}</p><button className="secundario" onClick={aoEntrar}>Ir para o painel</button></section>}

      {!erro && !info && <section className="cartao"><p>Verificando convite…</p></section>}

      {info && !resultado && (
        <section className="cartao">
          <h2>{info.campanha.name}</h2>
          <p>{info.campanha.system ? `Sistema: ${info.campanha.system}` : ""}</p>
          <p>
            Você foi convidado como <strong>{PAPEL_LABEL[info.role] ?? info.role}</strong>
            {info.requiresApproval && " (entrada sujeita a aprovação do mestre)"}.
          </p>

          {info.status !== "ativo" && <p className="erro">Este convite está {info.status}.</p>}
          {info.jaParticipa && <p>Você já participa desta campanha{info.meuStatus === "pendente" ? " (aguardando aprovação)" : ""}.</p>}

          {info.status === "ativo" && !info.jaParticipa && (
            <button onClick={() => void aceitar()} disabled={processando}>
              {processando ? "Entrando…" : "Aceitar convite"}
            </button>
          )}
          {info.jaParticipa && <button className="secundario" onClick={aoEntrar}>Ir para o painel</button>}
        </section>
      )}

      {resultado && (
        <section className="cartao">
          <p className="online">{resultado}</p>
          <button className="secundario" onClick={aoEntrar}>Ir para o painel</button>
        </section>
      )}
    </main>
  );
}
