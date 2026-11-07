import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./auth";
import { api, type HealthStatus } from "./api";
import Login from "./paginas/Login";
import Admin from "./paginas/Admin";
import Conta from "./paginas/Conta";

type Aba = "painel" | "admin" | "conta";

function Painel() {
  const { estado } = useAuth();
  const usuario = estado.status === "autenticado" ? estado.usuario : null;
  const [info, setInfo] = useState<HealthStatus | null>(null);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    let ativo = true;
    const checar = async () => {
      try {
        const dados = await api.health();
        if (!ativo) return;
        setInfo(dados);
        setOnline(true);
      } catch {
        if (ativo) setOnline(false);
      }
    };
    void checar();
    const intervalo = setInterval(checar, 10_000);
    return () => {
      ativo = false;
      clearInterval(intervalo);
    };
  }, []);

  return (
    <>
      <section className="cartao">
        <h2>Olá{usuario?.displayName ? `, ${usuario.displayName}` : usuario ? `, ${usuario.username}` : ""}</h2>
        <p>
          {online ? "● Servidor online" : "○ Servidor offline"}
          {info ? ` — ${info.servico}` : ""}
        </p>
      </section>

      <section className="cartao">
        <h2>Em construção</h2>
        <p>
          Esta é a Etapa 2 — contas e autenticação. As próximas etapas trarão
          campanhas e convites, editor de fichas, mesa virtual, dados e testes
          conforme a especificação Mestre RPG 2.0.
        </p>
      </section>
    </>
  );
}

function Shell() {
  const { estado, sair } = useAuth();
  const [aba, setAba] = useState<Aba>("painel");
  const usuario = estado.status === "autenticado" ? estado.usuario : null;

  if (estado.status === "carregando") {
    return (
      <main className="container">
        <p>Carregando…</p>
      </main>
    );
  }
  if (estado.status === "anonimo") return <Login />;

  return (
    <>
      <header className="topo">
        <span className="marca">Mestre RPG</span>
        <nav>
          <button className={aba === "painel" ? "ativo" : ""} onClick={() => setAba("painel")}>Painel</button>
          {usuario?.isAdmin && (
            <button className={aba === "admin" ? "ativo" : ""} onClick={() => setAba("admin")}>Administração</button>
          )}
          <button className={aba === "conta" ? "ativo" : ""} onClick={() => setAba("conta")}>Conta</button>
          <button className="sair" onClick={() => void sair()}>Sair</button>
        </nav>
      </header>
      <main className="container">
        {aba === "painel" && <Painel />}
        {aba === "admin" && usuario?.isAdmin && <Admin />}
        {aba === "conta" && <Conta />}
      </main>
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
