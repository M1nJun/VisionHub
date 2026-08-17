import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { fetchGrid } from "../api";
import { usePolling } from "../usePolling";
import type { VisionCell } from "../types";

const LINES = ["1-1", "1-2", "2-1", "2-2", "3-1", "3-2", "4-1", "4-2", "5-1", "5-2", "5-3"];
const VISION_NAMES = [
  "Welding Cathode Vision",
  "Welding Anode Vision",
  "Lead Vision",
  "Lead Align Vision",
  "Pouch Align Vision",
  "Pinhole Vision",
];

const POLL_MS = 5000;

function fmtPct(v: number | null): string {
  return v === null ? "-" : `${v.toFixed(3)}%`;
}

function fmtInt(v: number | null): string {
  return v === null ? "-" : v.toLocaleString();
}

export default function GridPage() {
  const { data: cells, error, loading } = usePolling(fetchGrid, POLL_MS);
  const navigate = useNavigate();

  const byKey = useMemo(() => {
    const m = new Map<string, VisionCell>();
    (cells ?? []).forEach((c) => m.set(`${c.line}||${c.visionName}`, c));
    return m;
  }, [cells]);

  const totals = useMemo(() => {
    let production = 0;
    let defects = 0;
    let bm = 0;
    let running = 0;
    let offline = 0;
    for (const c of cells ?? []) {
      production += c.totalCount ?? 0;
      defects += c.defectCount ?? 0;
      bm += c.bmCount ?? 0;
      if (c.status === "RUNNING") running++;
      if (c.status === "OFFLINE") offline++;
    }
    const rate = production > 0 ? (defects / production) * 100 : null;
    return { production, defects, rate, bm, running, offline };
  }, [cells]);

  if (loading && !cells) {
    return <div className="page empty-state">Loading...</div>;
  }
  if (error && !cells) {
    return <div className="page empty-state">Failed to load: {error}</div>;
  }

  return (
    <div className="page">
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-tile">
          <div className="label">Total Production</div>
          <div className="value">{fmtInt(totals.production)}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Total Defect Rate</div>
          <div className="value">{fmtPct(totals.rate)}</div>
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

      {LINES.map((line) => (
        <div className="grid-row" key={line}>
          <div className="line-label">
            <span>{line}</span>
            <span style={{ fontWeight: 400, fontSize: 11 }}>Line</span>
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
      <div className={`vision-card color-GREY`}>
        <div className="top-row">
          <span className="name">{visionName}</span>
        </div>
        <div className="not-deployed-label">Not deployed yet</div>
      </div>
    );
  }

  return (
    <div className={`vision-card color-${color}`} onClick={onClick}>
      <div className="top-row">
        <span className="name">{visionName}</span>
        <span className={`status-dot ${status}`} title={status} />
      </div>
      <div className="defect-rate">{fmtPct(cell.defectRatePct)}</div>
      <div className="metrics-row">
        <span>{fmtInt(cell.okCount)} / {fmtInt(cell.totalCount)}</span>
        {cell.bmCount ? <span style={{ color: "var(--yellow)" }}>BM {cell.bmCount}</span> : null}
      </div>
    </div>
  );
}
