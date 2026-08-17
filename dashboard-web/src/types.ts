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
  defectCount: number | null;
  defectRatePct: number | null;
  bmCount: number | null;
  lastEventAt: string | null;
  lastHeartbeatAt: string | null;
}

export interface TopDefect {
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

export interface VisionDetail {
  summary: VisionCell;
  topDefects: TopDefect[];
  recentDefects: RecentDefect[];
  recentAlarms: AlarmEntry[];
  lotHistory: LotHistoryEntry[];
}

export interface Setting {
  key: string;
  value: string;
  description: string | null;
}
