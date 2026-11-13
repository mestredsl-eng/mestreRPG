import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Usuario } from "./api";
import { desconectarSocket } from "./socket";

type EstadoAuth =
  | { status: "carregando" }
  | { status: "anonimo" }
  | { status: "autenticado"; usuario: Usuario };

interface AuthContexto {
  estado: EstadoAuth;
  entrar: (username: string, password: string) => Promise<void>;
  sair: () => Promise<void>;
  recarregar: () => Promise<void>;
}

const AuthContext = createContext<AuthContexto | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<EstadoAuth>({ status: "carregando" });

  const recarregar = async () => {
    try {
      const { usuario } = await api.me();
      setEstado({ status: "autenticado", usuario });
    } catch {
      // Sessão inválida/expirada: encerra o socket para não deixar uma
      // conexão autenticada por sessão morta recebendo eventos.
      desconectarSocket();
      setEstado({ status: "anonimo" });
    }
  };

  useEffect(() => {
    void recarregar();
  }, []);

  const entrar = async (username: string, password: string) => {
    // Garante que nenhuma conexão de sessão anterior seja reutilizada —
    // o próximo getSocket() criará uma conexão nova com o novo cookie.
    desconectarSocket();
    const { usuario } = await api.login(username, password);
    setEstado({ status: "autenticado", usuario });
  };

  const sair = async () => {
    // Encerra imediatamente a conexão Socket.IO da sessão atual — a
    // revogação no servidor também desconecta, mas não dependemos dela.
    desconectarSocket();
    await api.logout().catch(() => undefined);
    setEstado({ status: "anonimo" });
  };

  return (
    <AuthContext.Provider value={{ estado, entrar, sair, recarregar }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContexto {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth fora do AuthProvider");
  return ctx;
}
