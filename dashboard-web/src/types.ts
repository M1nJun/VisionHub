export type CellStatus = "NOT_DEPLOYED" | "OFFLINE" | "IDLE" | "RUNNING";
export type ColorLevel = "GREY" | "BLUE" | "GREEN" | "YELLOW" | "RED";

export interface VisionCell {
  line: string;
  visionName: string;
  status: CellStatus;
  colorLevel: ColorLevel;
  agentId: string | null;
  currentLotId: string | null;
  currentModelId: string | null;
  totalCount: number | null;
  okCount: number | null;
  ngCount: number | null;
  dlngCount: number | null;
  cngCount: number | null;
  ngRatePct: number | null;
  dlngRatePct: number | null;
  cngRatePct: number | null;
  bmCount: number | null;
  lastEventAt: string | null;
  lastHeartbeatAt: string | null;
}

export type Judge = "NG" | "DLNG" | "C-NG";

export interface TopDefect {
  judge: string;
  judgeDefect: string;
  count: number;
}

export interface ImageRef {
  side: string;
  mainUrl: string | null;
  overlayUrl: string | null;
  fetchStatus: string;
}

export interface RecentDefect {
  defectId: number;
  judge: string;
  judgeDefect: string;
  cellId: string | null;
  defectSides: string | null;
  occurredAt: string;
  images: ImageRef[];
}

export interface AlarmEntry {
  alarmCode: string | null;
  alarmName: string | null;
  alarmDetail: string | null;
  alarmTime: string | null;
}

export interface LotHistoryEntry {
  lotId: string;
  startedAt: string | null;
  endedAt: string | null;
  totalCount: number;
  okCount: number;
  defectCount: number;
}

export interface TrendPoint {
  bucketStart: string;
  totalCount: number;
  defectCount: number;
  defectRatePct: number;
}

export interface VisionDetail {
  summary: VisionCell;
  topDefects: TopDefect[];
  recentDefects: RecentDefect[];
  recentAlarms: AlarmEntry[];
  lotHistory: LotHistoryEntry[];
  defectRateTrend: TrendPoint[];
}

export interface Setting {
  key: string;
  value: string;
  description: string | null;
}
