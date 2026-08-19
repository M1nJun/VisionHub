package com.visionhub.dashboard.detail;

import com.visionhub.dashboard.grid.VisionCellDto;

import java.time.Instant;
import java.util.List;

public record VisionDetailDto(
        VisionCellDto summary,
        List<TopDefect> topDefects,
        List<RecentDefect> recentDefects,
        List<AlarmEntry> recentAlarms,
        List<LotHistoryEntry> lotHistory,
        List<TrendPoint> defectRateTrend
) {
    /** judge is one of NG / DLNG / C-NG - the images pane groups this list by judge first. */
    public record TopDefect(String judge, String judgeDefect, long count) {
    }

    /** One time bucket of the defect-rate-over-time chart (current lot only). Still combines
     * all three judgements - this chart tracks overall inspection activity/rate, not NG specifically. */
    public record TrendPoint(Instant bucketStart, long totalCount, long defectCount, double defectRatePct) {
    }

    public record RecentDefect(
            long defectId,
            String judge,
            String judgeDefect,
            String cellId,
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
