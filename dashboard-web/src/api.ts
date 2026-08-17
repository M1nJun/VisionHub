import type { Setting, VisionCell, VisionDetail } from "./types";

// Same context path Spring Boot is configured with (server.servlet.context-path).
const API_BASE = "/dashboard/api";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`${path} -> HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchGrid(): Promise<VisionCell[]> {
  return getJson<VisionCell[]>("/grid");
}

export function fetchDetail(line: string, visionName: string): Promise<VisionDetail> {
  return getJson<VisionDetail>(
    `/vision/${encodeURIComponent(line)}/${encodeURIComponent(visionName)}`
  );
}

export function fetchSettings(): Promise<Setting[]> {
  return getJson<Setting[]>("/settings");
}

export async function updateSetting(key: string, value: string): Promise<void> {
  const res = await fetch(`${API_BASE}/settings/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}
