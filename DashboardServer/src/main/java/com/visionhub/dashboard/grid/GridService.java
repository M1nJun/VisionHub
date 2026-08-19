package com.visionhub.dashboard.grid;

import com.visionhub.dashboard.catalog.VisionCatalog;
import com.visionhub.dashboard.settings.SettingsService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
public class GridService {
    private final JdbcTemplate jdbc;
    private final SettingsService settings;

    public GridService(JdbcTemplate jdbc, SettingsService settings) {
        this.jdbc = jdbc;
        this.settings = settings;
    }

    /** Convenience for the detail page - re-runs the whole-grid query and picks one cell out.
     * Fine at this data volume (a few dozen agents); not worth a second query path. */
    public VisionCellDto getCell(String line, String visionName) {
        return getGrid().stream()
                .filter(c -> c.line().equals(line) && c.visionName().equals(visionName))
                .findFirst()
                .orElse(null);
    }

    public List<VisionCellDto> getGrid() {
        double warnPct = settings.getDouble("defect_rate_warning_pct", 0.005);
        double critPct = settings.getDouble("defect_rate_critical_pct", 0.01);
        int offlineSec = settings.getInt("agent_offline_threshold_seconds", 10);
        int idleSec = settings.getInt("line_idle_threshold_seconds", 300);

        Map<String, AgentRow> byKey = new HashMap<>();
        jdbc.query("""
                SELECT
                    a.agent_id, a.line, a.vision_name,
                    a.current_lot_id, a.current_model_id, a.last_event_at, a.last_heartbeat_at,
                    vc.total_count, vc.ok_count, vc.ng_count, vc.dlng_count, vc.cng_count,
                    (SELECT COUNT(*) FROM alarms al
                        WHERE al.agent_id = a.agent_id AND al.alarm_time >= vc.lot_started_at) AS bm_count
                FROM agents a
                LEFT JOIN vision_counters vc ON vc.agent_id = a.agent_id
                """, (ResultSet rs) -> {
            AgentRow row = mapRow(rs);
            byKey.put(key(row.line, row.visionName), row);
        });

        Instant now = Instant.now();
        List<VisionCellDto> result = new ArrayList<>();
        for (VisionCatalog.VisionSlot slot : VisionCatalog.allSlots()) {
            AgentRow row = byKey.get(key(slot.line(), slot.visionName()));
            result.add(buildCell(slot, row, now, offlineSec, idleSec, warnPct, critPct));
        }
        return result;
    }

    private String key(String line, String visionName) {
        return line + "||" + visionName;
    }

    private AgentRow mapRow(ResultSet rs) throws SQLException {
        AgentRow row = new AgentRow();
        row.agentId = rs.getString("agent_id");
        row.line = rs.getString("line");
        row.visionName = rs.getString("vision_name");
        row.currentLotId = rs.getString("current_lot_id");
        row.currentModelId = rs.getString("current_model_id");
        row.lastEventAt = toInstant(rs.getTimestamp("last_event_at"));
        row.lastHeartbeatAt = toInstant(rs.getTimestamp("last_heartbeat_at"));
        row.totalCount = nullableLong(rs, "total_count");
        row.okCount = nullableLong(rs, "ok_count");
        row.ngCount = nullableLong(rs, "ng_count");
        row.dlngCount = nullableLong(rs, "dlng_count");
        row.cngCount = nullableLong(rs, "cng_count");
        row.bmCount = nullableInt(rs, "bm_count");
        return row;
    }

    private VisionCellDto buildCell(VisionCatalog.VisionSlot slot, AgentRow row, Instant now,
                                     int offlineSec, int idleSec, double warnPct, double critPct) {
        if (row == null) {
            return new VisionCellDto(slot.line(), slot.visionName(), "NOT_DEPLOYED", "GREY",
                    null, null, null, null, null, null, null, null, null, null, null, null, null, null);
        }

        String status;
        if (row.lastHeartbeatAt == null || secondsSince(row.lastHeartbeatAt, now) > offlineSec) {
            status = "OFFLINE";
        } else if (row.lastEventAt == null || secondsSince(row.lastEventAt, now) > idleSec) {
            status = "IDLE";
        } else {
            status = "RUNNING";
        }

        Double ngRatePct = null;
        Double dlngRatePct = null;
        Double cngRatePct = null;
        if (row.totalCount != null && row.totalCount > 0) {
            long ng = row.ngCount == null ? 0 : row.ngCount;
            long dlng = row.dlngCount == null ? 0 : row.dlngCount;
            long cng = row.cngCount == null ? 0 : row.cngCount;
            ngRatePct = 100.0 * ng / row.totalCount;
            dlngRatePct = 100.0 * dlng / row.totalCount;
            cngRatePct = 100.0 * cng / row.totalCount;
        }

        // Color-coding (and the warn/crit settings) is driven by NG rate only -
        // that's what "defect rate" means on the floor; DLNG/CNG are separate
        // figures shown alongside it, not folded into the traffic light.
        String color = switch (status) {
            case "OFFLINE" -> "GREY";
            case "IDLE" -> "BLUE";
            default -> {
                if (ngRatePct != null && ngRatePct >= critPct) yield "RED";
                if (ngRatePct != null && ngRatePct >= warnPct) yield "YELLOW";
                yield "GREEN";
            }
        };

        return new VisionCellDto(slot.line(), slot.visionName(), status, color, row.agentId,
                row.currentLotId, row.currentModelId, row.totalCount, row.okCount,
                row.ngCount, row.dlngCount, row.cngCount,
                ngRatePct, dlngRatePct, cngRatePct, row.bmCount, row.lastEventAt, row.lastHeartbeatAt);
    }

    private long secondsSince(Instant t, Instant now) {
        return Duration.between(t, now).getSeconds();
    }

    private Instant toInstant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }

    private Long nullableLong(ResultSet rs, String col) throws SQLException {
        long v = rs.getLong(col);
        return rs.wasNull() ? null : v;
    }

    private Integer nullableInt(ResultSet rs, String col) throws SQLException {
        int v = rs.getInt(col);
        return rs.wasNull() ? null : v;
    }

    private static class AgentRow {
        String agentId, line, visionName, currentLotId, currentModelId;
        Instant lastEventAt, lastHeartbeatAt;
        Long totalCount, okCount, ngCount, dlngCount, cngCount;
        Integer bmCount;
    }
}
