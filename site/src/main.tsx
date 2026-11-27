import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";
import "./estilos.css";
import "./identidade-visual.css";

// Harness de desenvolvimento F4 (#352): somente em DEV e somente com
// ?harness=internet-f4 explícito — lazy para nem entrar no bundle de
// produção.
const HarnessInternetLazy = lazy(() => import("./paginas/internet/Harness"));
const harnessF4 = import.meta.env.DEV
  && new URLSearchParams(window.location.search).get("harness") === "internet-f4";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {harnessF4 ? (
        <Suspense fallback={null}><HarnessInternetLazy /></Suspense>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>
);
