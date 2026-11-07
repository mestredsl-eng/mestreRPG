import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Usuario } from "./api";

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
      setEstado({ status: "anonimo" });
    }
  };

  useEffect(() => {
    void recarregar();
  }, []);

  const entrar = async (username: string, password: string) => {
    const { usuario } = await api.login(username, password);
    setEstado({ status: "autenticado", usuario });
  };

  const sair = async () => {
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
