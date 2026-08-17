package com.visionhub.dashboard.detail;

import com.visionhub.dashboard.grid.VisionCellDto;

import java.time.Instant;
import java.util.List;

public record VisionDetailDto(
        VisionCellDto summary,
        List<TopDefect> topDefects,
        List<RecentDefect> recentDefects,
        List<AlarmEntry> recentAlarms,
        List<LotHistoryEntry> lotHistory
) {
    public record TopDefect(String judgeDefect, long count) {
    }

    public record RecentDefect(
            long defectId,
            String judge,
            String judgeDefect,
            String defectSides,
            Instant occurredAt,
            List<ImageRef> images
    ) {
    }

    public record ImageRef(String side, String mainUrl, String overlayUrl, String fetchStatus) {
    }

    public record AlarmEntry(String alarmCode, String alarmName, String alarmDetail, Instant alarmTime) {
    }

    public record LotHistoryEntry(
            String lotId, Instant startedAt, Instant endedAt,
            long totalCount, long okCount, long defectCount
    ) {
    }
}
