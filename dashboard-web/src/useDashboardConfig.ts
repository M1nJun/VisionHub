import { useEffect, useState } from "react";
import { fetchSettings } from "./api";

export interface DashboardConfig {
  pollMs: number;
  warningPct: number;
  criticalPct: number;
}

const DEFAULTS: DashboardConfig = {
  pollMs: 5000,
  warningPct: 0.005,
  criticalPct: 0.01,
};

/** Reads the tunables from Settings once per page mount; falls back to
 * sensible defaults until that resolves. Settings page changes take effect
 * the next time a page loads it (grid/detail already re-fetch on every
 * navigation), no app restart needed. */
export function useDashboardConfig(): DashboardConfig {
  const [config, setConfig] = useState<DashboardConfig>(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    fetchSettings().then((settings) => {
      if (cancelled) return;
      const get = (key: string, fallback: number) => {
        const s = settings.find((x) => x.key === key);
        const n = s ? Number(s.value) : NaN;
        return Number.isNaN(n) ? fallback : n;
      };
      setConfig({
        pollMs: get("dashboard_poll_interval_seconds", 5) * 1000,
        warningPct: get("defect_rate_warning_pct", DEFAULTS.warningPct),
        criticalPct: get("defect_rate_critical_pct", DEFAULTS.criticalPct),
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return config;
}
