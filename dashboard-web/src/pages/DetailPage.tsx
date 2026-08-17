import { useParams } from "react-router-dom";
import { fetchDetail } from "../api";
import { usePolling } from "../usePolling";

const POLL_MS = 5000;

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

export default function DetailPage() {
  const { line = "", visionName = "" } = useParams();
  const { data, error, loading } = usePolling(
    () => fetchDetail(line, visionName),
    POLL_MS,
    [line, visionName]
  );

  if (loading && !data) {
    return <div className="page empty-state">Loading...</div>;
  }
  if (error && !data) {
    return <div className="page empty-state">Failed to load: {error}</div>;
  }
  if (!data) {
    return null;
  }

  const { summary, topDefects, recentDefects, recentAlarms, lotHistory } = data;

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
        <h2>Top 5 Defects (current lot)</h2>
        {topDefects.length === 0 ? (
          <div className="empty-state">No defects this lot.</div>
        ) : (
          <table>
            <thead><tr><th>Defect Type</th><th>Count</th></tr></thead>
            <tbody>
              {topDefects.map((d) => (
                <tr key={d.judgeDefect}>
                  <td>{d.judgeDefect}</td>
                  <td>{d.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Recent Defect Images</h2>
        {recentDefects.length === 0 ? (
          <div className="empty-state">No defects recorded yet.</div>
        ) : (
          <div className="image-grid">
            {recentDefects.flatMap((d) =>
              d.images.length > 0
                ? d.images.map((img) => (
                    <div className="image-card" key={`${d.defectId}-${img.side}`}>
                      {img.mainUrl ? (
                        <img src={img.mainUrl} alt={`${d.judgeDefect} ${img.side}`} loading="lazy" />
                      ) : (
                        <div style={{ aspectRatio: "4/3", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
                          {img.fetchStatus === "pending" ? "Fetching..." : "Unavailable"}
                        </div>
                      )}
                      <div className="caption">
                        {d.judgeDefect} &middot; {img.side} &middot; {fmtTime(d.occurredAt)}
                      </div>
                    </div>
                  ))
                : [
                    <div className="image-card" key={d.defectId}>
                      <div style={{ aspectRatio: "4/3", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
                        No image
                      </div>
                      <div className="caption">
                        {d.judgeDefect} &middot; {d.judge} &middot; {fmtTime(d.occurredAt)}
                      </div>
                    </div>,
                  ]
            )}
          </div>
        )}
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
