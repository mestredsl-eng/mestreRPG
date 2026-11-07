import { useEffect, useState } from "react";
import { verificarSaude, type HealthStatus } from "./api";

type Estado = "verificando" | "online" | "offline";

export default function App() {
  const [estado, setEstado] = useState<Estado>("verificando");
  const [info, setInfo] = useState<HealthStatus | null>(null);

  useEffect(() => {
    let ativo = true;
    const checar = async () => {
      try {
        const dados = await verificarSaude();
        if (!ativo) return;
        setInfo(dados);
        setEstado("online");
      } catch {
        if (ativo) setEstado("offline");
      }
    };
    checar();
    const intervalo = setInterval(checar, 10_000);
    return () => {
      ativo = false;
      clearInterval(intervalo);
    };
  }, []);

  return (
    <main className="container">
      <h1>Mestre RPG</h1>
      <p className="subtitulo">
        Plataforma de campanhas de RPG — o mestre define as regras, os jogadores
        participam pelo navegador.
      </p>

      <section className="cartao">
        <h2>Servidor</h2>
        {estado === "verificando" && <p>Status: verificando…</p>}
        {estado === "online" && (
          <p className="online">● Servidor online{info ? ` — ${info.servico}` : ""}</p>
        )}
        {estado === "offline" && (
          <p className="offline">
            ○ Servidor offline — inicie com <code>iniciar-mestre-rpg.bat</code> ou{" "}
            <code>npm run dev:servidor</code>
          </p>
        )}
      </section>

      <section className="cartao">
        <h2>Em construção</h2>
        <p>
          Esta é a fundação do projeto (Etapa 1). As próximas etapas trarão
          autenticação, campanhas, editor de fichas, mesa virtual, dados e testes
          conforme a especificação Mestre RPG 2.0.
        </p>
      </section>
    </main>
  );
}
