import { useEffect, useState } from "react";
import type { RetratoPersonagem } from "./api";

function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?";
  const primeira = partes[0][0] ?? "";
  const ultima = partes.length > 1 ? partes[partes.length - 1][0] ?? "" : "";
  return (primeira + ultima).toUpperCase();
}

/** Retrato do personagem com fallback visual: sem retrato ou imagem
 *  indisponível (404/erro de rede) exibe as iniciais — nunca fica
 *  quebrado nem entra em loop de requisições. */
export default function AvatarRetrato({ retrato, nome, tamanho = 40 }: {
  retrato?: RetratoPersonagem | null;
  nome: string;
  tamanho?: number;
}) {
  const [falhou, setFalhou] = useState(false);
  useEffect(() => { setFalhou(false); }, [retrato?.url]);
  const estilo = { width: tamanho, height: tamanho, fontSize: Math.round(tamanho * 0.4) };
  if (!retrato?.url || falhou) {
    return (
      <span className="avatar-retrato avatar-fallback" style={estilo} aria-hidden="true">
        {iniciais(nome)}
      </span>
    );
  }
  return (
    <img
      className="avatar-retrato"
      style={estilo}
      src={retrato.url}
      alt={`Retrato de ${nome}`}
      loading="lazy"
      onError={() => setFalhou(true)}
    />
  );
}
