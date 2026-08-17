package com.visionhub.dashboard.grid;

import java.time.Instant;

/**
 * status: NOT_DEPLOYED | OFFLINE | IDLE | RUNNING
 * colorLevel: GREY (not deployed / offline) | BLUE (idle) | GREEN | YELLOW | RED
 */
public record VisionCellDto(
        String line,
        String visionName,
        String status,
        String colorLevel,
        String agentId,
        String currentLotId,
        String currentModelId,
        Long totalCount,
        Long okCount,
        Long defectCount,
        Double defectRatePct,
        Integer bmCount,
        Instant lastEventAt,
        Instant lastHeartbeatAt
) {
}
