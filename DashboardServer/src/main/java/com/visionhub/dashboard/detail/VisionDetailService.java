package com.visionhub.dashboard.detail;

import com.visionhub.dashboard.grid.GridService;
import com.visionhub.dashboard.grid.VisionCellDto;
import com.visionhub.dashboard.settings.SettingsService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class VisionDetailService {
    // Not really a "top N" anymore now that the images pane groups this by judge
    // (NG/DLNG/C-NG) and lists every defect type as a filter option under each -
    // kept generous rather than actually limiting to a top few.
    private static final int TOP_DEFECTS_LIMIT = 100;
    private static final int RECENT_DEFECTS_LIMIT = 20;
    private static final int RECENT_ALARMS_LIMIT = 20;
    private static final int LOT_HISTORY_LIMIT = 10;

    private final JdbcTemplate jdbc;
    private final GridService gridService;
    private final SettingsService settings;
    private final String contextPath;

    public VisionDetailService(
            JdbcTemplate jdbc,
            GridService gridService,
            SettingsService settings,
            @Value("${server.servlet.context-path:}") String contextPath) {
        this.jdbc = jdbc;
        this.gridService = gridService;
        this.settings = settings;
        this.contextPath = contextPath;
    }

    public VisionDetailDto getDetail(String line, String visionName) {
        VisionCellDto summary = gridService.getCell(line, visionName);
        if (summary == null) {
            throw new NoSuchVisionException(line, visionName);
        }
        if (summary.agentId() == null) {
            // NOT_DEPLOYED: no agent has ever reported in, nothing further to query.
            return new VisionDetailDto(summary, List.of(), List.of(), List.of(), List.of(), List.of());
        }

        String agentId = summary.agentId();
        return new VisionDetailDto(
                summary,
                getTopDefects(agentId, summary.currentLotId()),
                getRecentDefects(agentId),
                getRecentAlarms(agentId),
                getLotHistory(agentId),
                getDefectRateTrend(agentId)
        );
    }

    private List<VisionDetailDto.TrendPoint> getDefectRateTrend(String agentId) {
        Instant lotStartedAt = jdbc.query(
                "SELECT lot_started_at FROM vision_counters WHERE agent_id = ?",
                (rs, rowNum) -> toInstant(rs.getTimestamp("lot_started_at")), agentId)
                .stream().findFirst().orElse(null);
        if (lotStartedAt == null) {
            return List.of();
        }

        int bucketMinutes = settings.getInt("trend_bucket_minutes", 30);
        long bucketSeconds = bucketMinutes * 60L;

        return jdbc.query("""
                SELECT
                  FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(received_at) / ?) * ?) AS bucket_start,
                  SUM(CASE WHEN event_type = 'WELDING_DEFECT' THEN 1 ELSE 0 END) AS defect_count,
                  COUNT(*) AS total_count
                FROM events
                WHERE agent_id = ?
                  AND event_type IN ('WELDING_COUNT_DELTA','WELDING_DEFECT','WELDING_UNKNOWN_JUDGE')
                  AND received_at >= ?
                GROUP BY bucket_start
                ORDER BY bucket_start
                """,
                (rs, rowNum) -> {
                    long total = rs.getLong("total_count");
                    long defects = rs.getLong("defect_count");
                    double rate = total > 0 ? 100.0 * defects / total : 0.0;
                    return new VisionDetailDto.TrendPoint(
                            toInstant(rs.getTimestamp("bucket_start")), total, defects, rate);
                },
                bucketSeconds, bucketSeconds, agentId, Timestamp.from(lotStartedAt));
    }

    private List<VisionDetailDto.TopDefect> getTopDefects(String agentId, String currentLotId) {
        if (currentLotId == null) {
            return List.of();
        }
        return jdbc.query("""
                SELECT judge, judge_defect, COUNT(*) AS c
                FROM defects
                WHERE agent_id = ? AND lot_id = ?
                GROUP BY judge, judge_defect
                ORDER BY c DESC
                LIMIT ?
                """,
                (rs, rowNum) -> new VisionDetailDto.TopDefect(
                        rs.getString("judge"), rs.getString("judge_defect"), rs.getLong("c")),
                agentId, currentLotId, TOP_DEFECTS_LIMIT);
    }

    private List<VisionDetailDto.RecentDefect> getRecentDefects(String agentId) {
        List<Long> defectIds = new ArrayList<>();
        Map<Long, VisionDetailDto.RecentDefect> byId = new LinkedHashMap<>();

        jdbc.query("""
                SELECT id, judge, judge_defect, cell_id, defect_sides, received_at
                FROM defects
                WHERE agent_id = ?
                ORDER BY received_at DESC
                LIMIT ?
                """, (ResultSet rs) -> {
            long id = rs.getLong("id");
            defectIds.add(id);
            byId.put(id, new VisionDetailDto.RecentDefect(
                    id,
                    rs.getString("judge"),
                    rs.getString("judge_defect"),
                    rs.getString("cell_id"),
                    rs.getString("defect_sides"),
                    toInstant(rs.getTimestamp("received_at")),
                    new ArrayList<>()
            ));
        }, agentId, RECENT_DEFECTS_LIMIT);

        if (defectIds.isEmpty()) {
            return List.of();
        }

        // images is a mutable list inside each record's constructor arg reference -
        // records are immutable but the List<ImageRef> instance itself is a normal
        // ArrayList we're still allowed to add to before returning.
        // defect_images.id (not defect_id) is what ImageController looks images up by,
        // since one defect can have image rows for more than one side.
        String inClause = String.join(",", defectIds.stream().map(String::valueOf).toList());
        jdbc.query("SELECT id, defect_id, side, local_main_path, local_overlay_path, fetch_status "
                        + "FROM defect_images WHERE defect_id IN (" + inClause + ")",
                (ResultSet rs) -> {
                    long imageId = rs.getLong("id");
                    long defectId = rs.getLong("defect_id");
                    String side = rs.getString("side");
                    String fetchStatus = rs.getString("fetch_status");
                    boolean fetched = "fetched".equals(fetchStatus) && rs.getString("local_main_path") != null;
                    VisionDetailDto.ImageRef ref = new VisionDetailDto.ImageRef(
                            side,
                            fetched ? contextPath + "/api/images/" + imageId + "/main" : null,
                            fetched ? contextPath + "/api/images/" + imageId + "/overlay" : null,
                            fetchStatus
                    );
                    VisionDetailDto.RecentDefect owner = byId.get(defectId);
                    if (owner != null) {
                        owner.images().add(ref);
                    }
                });

        return List.copyOf(byId.values());
    }

    private List<VisionDetailDto.AlarmEntry> getRecentAlarms(String agentId) {
        return jdbc.query("""
                SELECT alarm_code, alarm_name, alarm_detail, alarm_time
                FROM alarms
                WHERE agent_id = ?
                ORDER BY alarm_time DESC
                LIMIT ?
                """,
                (rs, rowNum) -> new VisionDetailDto.AlarmEntry(
                        rs.getString("alarm_code"),
                        rs.getString("alarm_name"),
                        rs.getString("alarm_detail"),
                        toInstant(rs.getTimestamp("alarm_time"))
                ),
                agentId, RECENT_ALARMS_LIMIT);
    }

    private List<VisionDetailDto.LotHistoryEntry> getLotHistory(String agentId) {
        return jdbc.query("""
                SELECT lot_id, started_at, ended_at, total_count, ok_count, defect_count
                FROM lot_history
                WHERE agent_id = ?
                ORDER BY ended_at DESC
                LIMIT ?
                """,
                (rs, rowNum) -> new VisionDetailDto.LotHistoryEntry(
                        rs.getString("lot_id"),
                        toInstant(rs.getTimestamp("started_at")),
                        toInstant(rs.getTimestamp("ended_at")),
                        rs.getLong("total_count"),
                        rs.getLong("ok_count"),
                        rs.getLong("defect_count")
                ),
                agentId, LOT_HISTORY_LIMIT);
    }

    private Instant toInstant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }

    public static class NoSuchVisionException extends RuntimeException {
        public NoSuchVisionException(String line, String visionName) {
            super("Unknown (line, visionName): (" + line + ", " + visionName + ")");
        }
    }
}
