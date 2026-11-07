const API_BASE = "/api";

export interface HealthStatus {
  status: string;
  servico: string;
  timestamp: string;
}

export async function verificarSaude(): Promise<HealthStatus> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<HealthStatus>;
}
