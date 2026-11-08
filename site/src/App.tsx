import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./auth";
import { api, type HealthStatus } from "./api";
import Login from "./paginas/Login";
import Admin from "./paginas/Admin";
import Conta from "./paginas/Conta";
import Campanhas from "./paginas/Campanhas";
import Campanha from "./paginas/Campanha";
import Convite from "./paginas/Convite";

type Aba = "painel" | "campanhas" | "admin" | "conta";

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
        <h2>Próximas etapas</h2>
        <p>
          Campanhas, convites e participantes implementados. A seguir: editor de
          fichas, regras personalizáveis, mesa virtual, dados e testes.
        </p>
      </section>
    </>
  );
}

function Shell() {
  const { estado, sair } = useAuth();
  const [aba, setAba] = useState<Aba>("painel");
  const [campanhaAberta, setCampanhaAberta] = useState<string | null>(null);
  const usuario = estado.status === "autenticado" ? estado.usuario : null;
  const ehConvite = window.location.pathname.startsWith("/convite");

  if (estado.status === "carregando") {
    return (
      <main className="container">
        <p>Carregando…</p>
      </main>
    );
  }
  if (estado.status === "anonimo") return <Login />;

  // Tela de aceite de convite (link /convite?code=...)
  if (ehConvite) {
    return (
      <>
        <header className="topo">
          <span className="marca">Mestre RPG</span>
          <nav><button className="sair" onClick={() => { window.location.href = "/"; }}>Painel</button></nav>
        </header>
        <Convite aoEntrar={() => { window.location.href = "/"; }} />
      </>
    );
  }

  return (
    <>
      <header className="topo">
        <span className="marca">Mestre RPG</span>
        <nav>
          <button className={aba === "painel" ? "ativo" : ""} onClick={() => { setAba("painel"); setCampanhaAberta(null); }}>Painel</button>
          <button className={aba === "campanhas" ? "ativo" : ""} onClick={() => { setAba("campanhas"); setCampanhaAberta(null); }}>Campanhas</button>
          {usuario?.isAdmin && (
            <button className={aba === "admin" ? "ativo" : ""} onClick={() => setAba("admin")}>Administração</button>
          )}
          <button className={aba === "conta" ? "ativo" : ""} onClick={() => setAba("conta")}>Conta</button>
          <button className="sair" onClick={() => void sair()}>Sair</button>
        </nav>
      </header>
      <main className={campanhaAberta ? "container container-largo" : "container"}>
        {aba === "painel" && <Painel />}
        {aba === "campanhas" && !campanhaAberta && <Campanhas aoAbrir={setCampanhaAberta} />}
        {aba === "campanhas" && campanhaAberta && (
          <Campanha id={campanhaAberta} aoVoltar={() => setCampanhaAberta(null)} />
        )}
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
