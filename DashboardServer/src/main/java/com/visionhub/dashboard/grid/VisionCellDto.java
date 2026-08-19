package com.visionhub.dashboard.grid;

import java.time.Instant;

/**
 * status: NOT_DEPLOYED | OFFLINE | IDLE | RUNNING
 * colorLevel: GREY (not deployed / offline) | BLUE (idle) | GREEN | YELLOW | RED (driven by ngRatePct)
 *
 * NG/DLNG/C-NG are tracked as three separate judgements (Welding Cathode/Anode
 * report all three; every other vision type only ever produces NG). "Defect
 * rate" as the term is used on the floor means the NG rate specifically -
 * DLNG/CNG are their own separate rates, not folded into it.
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
        Long ngCount,
        Long dlngCount,
        Long cngCount,
        Double ngRatePct,
        Double dlngRatePct,
        Double cngRatePct,
        Integer bmCount,
        Instant lastEventAt,
        Instant lastHeartbeatAt
) {
}
