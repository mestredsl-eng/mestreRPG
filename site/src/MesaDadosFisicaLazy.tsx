import { lazy, Suspense } from "react";
import MesaDadosCanvas, { seedDeId, type ItemDadoMesa } from "./MesaDados3D";

export { seedDeId };

const MesaDadosFisica = lazy(() => import("./MesaDadosFisica"));

interface Props {
  dados: ItemDadoMesa[];
  semente?: number;
  estado?: "sucesso" | "falha" | null;
  className?: string;
}

export default function MesaDadosFisicaLazy(props: Props) {
  return (
    <Suspense fallback={<MesaDadosCanvas {...props} />}>
      <MesaDadosFisica {...props} />
    </Suspense>
  );
}