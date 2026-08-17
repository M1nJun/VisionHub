package com.visionhub.dashboard.catalog;

import java.util.List;

/**
 * The full grid the dashboard always shows - 11 lines x 6 vision types - independent
 * of which agents have actually been deployed yet. Only Welding Cathode/Anode agents
 * exist today; the other four vision types render as NOT_DEPLOYED placeholder cells
 * until their agents ship. Adding a new deployed vision type needs no change here -
 * it just starts showing real data once a matching (line, visionName) agent reports in.
 */
public final class VisionCatalog {
    private VisionCatalog() {
    }

    public static final List<String> LINES = List.of(
            "1-1", "1-2", "2-1", "2-2", "3-1", "3-2", "4-1", "4-2", "5-1", "5-2", "5-3"
    );

    // Display order matches the original dashboard mockup.
    public static final List<String> VISION_NAMES = List.of(
            "Welding Cathode Vision",
            "Welding Anode Vision",
            "Lead Vision",
            "Lead Align Vision",
            "Pouch Align Vision",
            "Pinhole Vision"
    );

    public record VisionSlot(String line, String visionName) {
    }

    public static List<VisionSlot> allSlots() {
        return LINES.stream()
                .flatMap(line -> VISION_NAMES.stream().map(v -> new VisionSlot(line, v)))
                .toList();
    }
}
