import type { TrendPoint } from "../types";

interface Props {
  points: TrendPoint[];
  warningPct: number;
  criticalPct: number;
  height?: number;
}

const WIDTH = 900;
const PAD_LEFT = 40;
const PAD_RIGHT = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 24;

export default function TrendChart({ points, warningPct, criticalPct, height = 220 }: Props) {
  if (points.length === 0) {
    return <div className="empty-state">No data yet this lot.</div>;
  }

  const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerH = height - PAD_TOP - PAD_BOTTOM;

  const maxRate = Math.max(criticalPct * 1.2, ...points.map((p) => p.defectRatePct), 0.001);
  const times = points.map((p) => new Date(p.bucketStart).getTime());
  const minT = times[0];
  const maxT = times[times.length - 1];
  const spanT = Math.max(maxT - minT, 1);

  const x = (t: number) => PAD_LEFT + ((t - minT) / spanT) * innerW;
  const y = (rate: number) => PAD_TOP + innerH - (rate / maxRate) * innerH;

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${x(new Date(p.bucketStart).getTime())} ${y(p.defectRatePct)}`)
    .join(" ");

  const areaPath =
    `M ${x(minT)} ${y(0)} ` +
    points.map((p) => `L ${x(new Date(p.bucketStart).getTime())} ${y(p.defectRatePct)}`).join(" ") +
    ` L ${x(maxT)} ${y(0)} Z`;

  const timeLabels = points.filter((_, i) => i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} width="100%" height={height} style={{ overflow: "visible" }}>
      {/* y-axis gridlines: 0, warning, critical, max */}
      {[0, warningPct, criticalPct, maxRate].map((v, i) => (
        <g key={i}>
          <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y(v)} y2={y(v)} stroke="var(--panel-border)" strokeWidth={1} />
          <text x={PAD_LEFT - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill="var(--text-dim)">
            {v.toFixed(3)}%
          </text>
        </g>
      ))}
      <line
        x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y(warningPct)} y2={y(warningPct)}
        stroke="var(--yellow)" strokeWidth={1} strokeDasharray="4 3" opacity={0.6}
      />
      <line
        x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y(criticalPct)} y2={y(criticalPct)}
        stroke="var(--red)" strokeWidth={1} strokeDasharray="4 3" opacity={0.6}
      />

      <path d={areaPath} fill="var(--accent)" opacity={0.12} stroke="none" />
      <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {points.map((p, i) => (
        <circle key={i} cx={x(new Date(p.bucketStart).getTime())} cy={y(p.defectRatePct)} r={2.5} fill="var(--accent)">
          <title>{`${new Date(p.bucketStart).toLocaleTimeString()}: ${p.defectRatePct.toFixed(3)}% (${p.defectCount}/${p.totalCount})`}</title>
        </circle>
      ))}

      {timeLabels.map((p, i) => (
        <text
          key={i}
          x={x(new Date(p.bucketStart).getTime())}
          y={height - 6}
          textAnchor="middle"
          fontSize={10}
          fill="var(--text-dim)"
        >
          {new Date(p.bucketStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </text>
      ))}
    </svg>
  );
}
