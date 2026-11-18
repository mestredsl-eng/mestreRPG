import type { ReactNode } from "react";

export type NomeIconeInterface =
  | "simbolo"
  | "painel"
  | "campanhas"
  | "acervo"
  | "novidades"
  | "guildas"
  | "admin"
  | "conta"
  | "sair";

const desenhos: Record<NomeIconeInterface, ReactNode> = {
  simbolo: (
    <>
      <path d="M12 2.8 14.2 8l5.1-2.1-2.1 5.1 5.1 2.2-5.1 2.1 2.1 5.1-5.1-2.1-2.2 5.1-2.1-5.1-5.1 2.1 2.1-5.1-5.1-2.1L7 11l-2.1-5.1L10 8 12 2.8Z" />
      <circle cx="12" cy="13" r="2.3" />
    </>
  ),
  painel: (
    <>
      <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V10Z" />
      <path d="M8 21v-7h8v7" />
    </>
  ),
  campanhas: (
    <>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21V5.5Z" />
      <path d="M4 6v15M8 7h8M8 11h7" />
    </>
  ),
  acervo: (
    <>
      <path d="M3 7h18v13H3zM2 4h20v3H2z" />
      <path d="M10 11h4" />
    </>
  ),
  novidades: (
    <>
      <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" />
      <path d="M10 21h4" />
      <path d="M12 3V2" />
    </>
  ),
  guildas: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-1a6 6 0 0 1 12 0v1H3Z" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8M18 14a5 5 0 0 1 3 4.5v1h-4" />
    </>
  ),
  admin: (
    <>
      <path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  conta: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  sair: (
    <>
      <path d="M10 17l5-5-5-5M15 12H3" />
      <path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" />
    </>
  ),
};

export default function IconeInterface({ nome, className = "" }: { nome: NomeIconeInterface; className?: string }) {
  return (
    <svg
      className={`icone-interface ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {desenhos[nome]}
    </svg>
  );
}
