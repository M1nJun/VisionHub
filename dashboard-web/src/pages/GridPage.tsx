import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchGrid } from "../api";
import { usePolling } from "../usePolling";
import { useDashboardConfig } from "../useDashboardConfig";
import type { VisionCell } from "../types";

type RankMetric = "NG" | "DLNG" | "CNG";
const RANK_TOP_N = 7;

const LINES = ["1-1", "1-2", "2-1", "2-2", "3-1", "3-2", "4-1", "4-2", "5-1", "5-2", "5-3"];
const VISION_NAMES = [
  "Welding Cathode Vision",
  "Welding Anode Vision",
  "Lead Vision",
  "Lead Align Vision",
  "Pouch Align Vision",
  "Pinhole Vision",
];

function fmtPct(v: number | null): string {
  return v === null ? "-" : `${v.toFixed(3)}%`;
}

function fmtInt(v: number | null): string {
  return v === null ? "-" : v.toLocaleString();
}

export default function GridPage() {
  const { pollMs } = useDashboardConfig();
  const { data: cells, error, loading } = usePolling(fetchGrid, pollMs, [pollMs]);
  const navigate = useNavigate();

  const byKey = useMemo(() => {
    const m = new Map<string, VisionCell>();
    (cells ?? []).forEach((c) => m.set(`${c.line}||${c.visionName}`, c));
    return m;
  }, [cells]);

  const totals = useMemo(() => {
    let production = 0;
    let ng = 0;
    let dlng = 0;
    let cng = 0;
    let bm = 0;
    let running = 0;
    let offline = 0;
    for (const c of cells ?? []) {
      production += c.totalCount ?? 0;
      ng += c.ngCount ?? 0;
      dlng += c.dlngCount ?? 0;
      cng += c.cngCount ?? 0;
      bm += c.bmCount ?? 0;
      if (c.status === "RUNNING") running++;
      if (c.status === "OFFLINE") offline++;
    }
    const ngRate = production > 0 ? (ng / production) * 100 : null;
    const dlngRate = production > 0 ? (dlng / production) * 100 : null;
    const cngRate = production > 0 ? (cng / production) * 100 : null;
    return { production, ng, dlng, cng, ngRate, dlngRate, cngRate, bm, running, offline };
  }, [cells]);

  if (loading && !cells) {
    return <div className="page empty-state">Loading...</div>;
  }
  if (error && !cells) {
    return <div className="page empty-state">Failed to load: {error}</div>;
  }

  return (
    <div className="page">
      <div className="dashboard-layout">
        <TopRankedPanel cells={cells ?? []} onSelect={(line, visionName) =>
          navigate(`/vision/${encodeURIComponent(line)}/${encodeURIComponent(visionName)}`)
        } />

        <div className="grid-main">
          <div className="stat-grid" style={{ marginBottom: 10 }}>
            <div className="stat-tile">
              <div className="label">Total Production</div>
              <div className="value">{fmtInt(totals.production)}</div>
            </div>
            <div className="stat-tile">
              <div className="label">Total Defect Rate (NG)</div>
              <div className="value">{fmtPct(totals.ngRate)} <span className="value-count">({totals.ng})</span></div>
            </div>
            <div className="stat-tile">
              <div className="label">Total DLNG Rate</div>
              <div className="value">{fmtPct(totals.dlngRate)} <span className="value-count">({totals.dlng})</span></div>
            </div>
            <div className="stat-tile">
              <div className="label">Total CNG Rate</div>
              <div className="value">{fmtPct(totals.cngRate)} <span className="value-count">({totals.cng})</span></div>
            </div>
            <div className="stat-tile">
              <div className="label">BM Events</div>
              <div className="value">{totals.bm}</div>
            </div>
            <div className="stat-tile">
              <div className="label">Running</div>
              <div className="value" style={{ color: "var(--green)" }}>{totals.running}</div>
            </div>
            <div className="stat-tile">
              <div className="label">Offline</div>
              <div className="value" style={{ color: totals.offline > 0 ? "var(--grey)" : undefined }}>
                {totals.offline}
              </div>
            </div>
          </div>

          <div className="legend">
            <span className="legend-item"><span className="swatch GREEN" /> Normal</span>
            <span className="legend-item"><span className="swatch YELLOW" /> Warning</span>
            <span className="legend-item"><span className="swatch RED" /> Critical</span>
            <span className="legend-item"><span className="swatch BLUE" /> Idle (agent alive, no data)</span>
            <span className="legend-item"><span className="swatch GREY" /> Offline / Not deployed</span>
          </div>

          <div className="grid-header-row">
            <div />
            {VISION_NAMES.map((name) => (
              <div className="vision-col-header" key={name} title={name}>{name}</div>
            ))}
          </div>

          {LINES.map((line) => (
            <div className="grid-row" key={line}>
              <div className="line-label">
                <span>{line}</span>
              </div>
              {VISION_NAMES.map((visionName) => {
                const cell = byKey.get(`${line}||${visionName}`);
                return (
                  <VisionCard
                    key={visionName}
                    line={line}
                    visionName={visionName}
                    cell={cell}
                    onClick={() => {
                      if (cell && cell.status !== "NOT_DEPLOYED") {
                        navigate(`/vision/${encodeURIComponent(line)}/${encodeURIComponent(visionName)}`);
                      }
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function rateOf(cell: VisionCell, metric: RankMetric): number | null {
  if (metric === "NG") return cell.ngRatePct;
  if (metric === "DLNG") return cell.dlngRatePct;
  return cell.cngRatePct;
}

function TopRankedPanel({
  cells,
  onSelect,
}: {
  cells: VisionCell[];
  onSelect: (line: string, visionName: string) => void;
}) {
  const [metric, setMetric] = useState<RankMetric>("NG");

  const ranked = useMemo(() => {
    return cells
      .filter((c) => c.status !== "NOT_DEPLOYED" && rateOf(c, metric) !== null)
      .sort((a, b) => (rateOf(b, metric) ?? 0) - (rateOf(a, metric) ?? 0))
      .slice(0, RANK_TOP_N);
  }, [cells, metric]);

  return (
    <div className="panel top-ranked-panel">
      <h2>Top {RANK_TOP_N} 불량률 호기</h2>
      <div className="judge-tab-row">
        {(["NG", "DLNG", "CNG"] as RankMetric[]).map((m) => (
          <div
            key={m}
            className={`judge-tab ${m} ${metric === m ? "selected" : ""}`}
            onClick={() => setMetric(m)}
          >
            {m}
          </div>
        ))}
      </div>
      <div className="ranked-list">
        {ranked.length === 0 && <div className="empty-state" style={{ padding: "12px 0" }}>No data yet.</div>}
        {ranked.map((c, i) => (
          <div
            key={`${c.line}||${c.visionName}`}
            className={`ranked-item judge-${metric}`}
            onClick={() => onSelect(c.line, c.visionName)}
          >
            <span className="ranked-rank">#{i + 1}</span>
            <span className="ranked-label" title={c.visionName}>{c.line} &middot; {c.visionName}</span>
            <span className="ranked-rate">{fmtPct(rateOf(c, metric))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VisionCard({
  visionName,
  cell,
  onClick,
}: {
  line: string;
  visionName: string;
  cell: VisionCell | undefined;
  onClick: () => void;
}) {
  const color = cell?.colorLevel ?? "GREY";
  const status = cell?.status ?? "NOT_DEPLOYED";

  if (!cell || status === "NOT_DEPLOYED") {
    return (
      <div className="vision-card color-GREY" title={visionName}>
        <span className="not-deployed-label">N/D</span>
      </div>
    );
  }

  return (
    <div className={`vision-card color-${color}`} onClick={onClick} title={`${visionName} - ${status}`}>
      <div className="vision-card-rates">
        <span className="defect-rate">{fmtPct(cell.ngRatePct)}</span>
        <span className="dlng-rate">DLNG {fmtPct(cell.dlngRatePct)}</span>
      </div>
      {cell.bmCount ? <span className="bm-badge">BM {cell.bmCount}</span> : null}
    </div>
  );
}
