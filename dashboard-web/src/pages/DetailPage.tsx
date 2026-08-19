import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchDetail } from "../api";
import { usePolling } from "../usePolling";
import { useDashboardConfig } from "../useDashboardConfig";
import TrendChart from "../components/TrendChart";
import ImageViewer, { type FlatImage } from "../components/ImageViewer";

function fmtPct(v: number | null): string {
  return v === null ? "-" : `${v.toFixed(3)}%`;
}

function fmtInt(v: number | null): string {
  return v === null ? "-" : v.toLocaleString();
}

function fmtTime(v: string | null): string {
  if (!v) return "-";
  return new Date(v).toLocaleString();
}

const ALL = "ALL";

export default function DetailPage() {
  const { line = "", visionName = "" } = useParams();
  const { pollMs, warningPct, criticalPct } = useDashboardConfig();
  const { data, error, loading } = usePolling(
    () => fetchDetail(line, visionName),
    pollMs,
    [line, visionName, pollMs]
  );
  const [selectedType, setSelectedType] = useState<string>(ALL);

  // Backend already orders recentDefects newest-first; flattening preserves
  // that order well enough (a defect's own side-images have no meaningful
  // order between each other).
  const flatImages = useMemo<FlatImage[]>(() => {
    if (!data) return [];
    return data.recentDefects.flatMap((d) =>
      d.images.length > 0
        ? d.images.map((img) => ({
            defectId: d.defectId,
            judgeDefect: d.judgeDefect,
            judge: d.judge,
            side: img.side,
            occurredAt: d.occurredAt,
            mainUrl: img.mainUrl,
            overlayUrl: img.overlayUrl,
            fetchStatus: img.fetchStatus,
          }))
        : []
    );
  }, [data]);

  const filteredImages = useMemo(() => {
    if (selectedType === ALL) return flatImages;
    return flatImages.filter((img) => img.judgeDefect === selectedType);
  }, [flatImages, selectedType]);

  if (loading && !data) {
    return <div className="page empty-state">Loading...</div>;
  }
  if (error && !data) {
    return <div className="page empty-state">Failed to load: {error}</div>;
  }
  if (!data) {
    return null;
  }

  const { summary, topDefects, recentAlarms, lotHistory, defectRateTrend } = data;

  return (
    <div className="page">
      <a href="#" className="back-link" onClick={(e) => { e.preventDefault(); history.back(); }}>
        &larr; Back to Dashboard
      </a>
      <h2 style={{ marginTop: 0 }}>
        {summary.line} Line / {summary.visionName}
        <span className={`status-dot ${summary.status}`} style={{ marginLeft: 10 }} title={summary.status} />
        <span style={{ fontSize: 13, color: "var(--text-dim)", marginLeft: 6 }}>{summary.status}</span>
      </h2>

      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-tile">
          <div className="label">Current Lot</div>
          <div className="value" style={{ fontSize: 15 }}>{summary.currentLotId ?? "-"}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Model</div>
          <div className="value" style={{ fontSize: 15 }}>{summary.currentModelId ?? "-"}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Total / OK</div>
          <div className="value" style={{ fontSize: 15 }}>{fmtInt(summary.totalCount)} / {fmtInt(summary.okCount)}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Defects</div>
          <div className="value">{fmtInt(summary.defectCount)}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Defect Rate</div>
          <div className="value">{fmtPct(summary.defectRatePct)}</div>
        </div>
        <div className="stat-tile">
          <div className="label">BM Events (this lot)</div>
          <div className="value">{summary.bmCount ?? 0}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Last Heartbeat</div>
          <div className="value" style={{ fontSize: 13 }}>{fmtTime(summary.lastHeartbeatAt)}</div>
        </div>
        <div className="stat-tile">
          <div className="label">Last Cell Received</div>
          <div className="value" style={{ fontSize: 13 }}>{fmtTime(summary.lastEventAt)}</div>
        </div>
      </div>

      <div className="panel">
        <h2>Defect Images</h2>
        <div className="viewer-defects-row">
          <ImageViewer key={selectedType} images={filteredImages} />
          <div>
            <div className="defect-type-list">
              <div
                className={`defect-type-row ${selectedType === ALL ? "selected" : ""}`}
                onClick={() => setSelectedType(ALL)}
              >
                <span>All defect types</span>
                <span className="count">{flatImages.length}</span>
              </div>
              {topDefects.map((d) => (
                <div
                  key={d.judgeDefect}
                  className={`defect-type-row ${selectedType === d.judgeDefect ? "selected" : ""}`}
                  onClick={() => setSelectedType(d.judgeDefect)}
                >
                  <span>{d.judgeDefect}</span>
                  <span className="count">{d.count}</span>
                </div>
              ))}
              {topDefects.length === 0 && (
                <div className="empty-state" style={{ padding: "12px 0" }}>No defects this lot.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Defect Rate Trend (current lot)</h2>
        <TrendChart points={defectRateTrend} warningPct={warningPct} criticalPct={criticalPct} />
      </div>

      <div className="panel">
        <h2>Recent Alarms (BM)</h2>
        {recentAlarms.length === 0 ? (
          <div className="empty-state">No alarms recorded.</div>
        ) : (
          <table>
            <thead><tr><th>Time</th><th>Code</th><th>Name</th><th>Detail</th></tr></thead>
            <tbody>
              {recentAlarms.map((a, i) => (
                <tr key={i}>
                  <td>{fmtTime(a.alarmTime)}</td>
                  <td>{a.alarmCode ?? "-"}</td>
                  <td>{a.alarmName ?? "-"}</td>
                  <td>{a.alarmDetail ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Lot History</h2>
        {lotHistory.length === 0 ? (
          <div className="empty-state">No completed lots yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Lot ID</th><th>Started</th><th>Ended</th><th>Total</th><th>OK</th><th>Defects</th></tr>
            </thead>
            <tbody>
              {lotHistory.map((l) => (
                <tr key={l.lotId + l.endedAt}>
                  <td>{l.lotId}</td>
                  <td>{fmtTime(l.startedAt)}</td>
                  <td>{fmtTime(l.endedAt)}</td>
                  <td>{l.totalCount}</td>
                  <td>{l.okCount}</td>
                  <td>{l.defectCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
