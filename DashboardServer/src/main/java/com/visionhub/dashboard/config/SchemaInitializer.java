package com.visionhub.dashboard.config;

import org.springframework.boot.CommandLineRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Ensures dashboard_settings exists and has its default rows, the same
 * "each component defensively bootstraps what it needs" pattern the Go
 * receiver (schema.sql via go:embed) and SmbImageFetcher (ensure_columns)
 * already use - so DashboardServer works even if it's the first thing
 * started against a brand new DB.
 */
@Component
public class SchemaInitializer implements CommandLineRunner {
    private final JdbcTemplate jdbc;

    public SchemaInitializer(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void run(String... args) {
        jdbc.execute("""
                CREATE TABLE IF NOT EXISTS dashboard_settings (
                  setting_key VARCHAR(64) PRIMARY KEY,
                  setting_value VARCHAR(255) NOT NULL,
                  description VARCHAR(255),
                  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                """);

        seedDefault("defect_rate_warning_pct", "0.005", "Defect rate % at/above which a card turns yellow");
        seedDefault("defect_rate_critical_pct", "0.01", "Defect rate % at/above which a card turns red");
        seedDefault("agent_offline_threshold_seconds", "10", "No heartbeat for this long -> Agent Offline");
        seedDefault("line_idle_threshold_seconds", "300", "Agent alive but no new cell for this long -> Line Idle");
        seedDefault("dashboard_poll_interval_seconds", "5", "How often the browser re-fetches grid/detail data");
        seedDefault("image_root_path", "D:\\VisionDashboardImages",
                "Folder this server looks for fetched images under - set independently from SmbImageFetcher's "
                        + "own config.json; keep them pointed at the same place by hand");
        seedDefault("trend_bucket_minutes", "30", "Time bucket size for the defect rate trend chart");
    }

    private void seedDefault(String key, String value, String description) {
        jdbc.update(
                "INSERT IGNORE INTO dashboard_settings (setting_key, setting_value, description) VALUES (?, ?, ?)",
                key, value, description
        );
    }
}
