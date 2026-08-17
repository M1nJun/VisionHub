package com.visionhub.dashboard.settings;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;

@Service
public class SettingsService {
    private final JdbcTemplate jdbc;

    public SettingsService(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<SettingDto> getAll() {
        return jdbc.query(
                "SELECT setting_key, setting_value, description FROM dashboard_settings ORDER BY setting_key",
                (rs, rowNum) -> new SettingDto(
                        rs.getString("setting_key"),
                        rs.getString("setting_value"),
                        rs.getString("description"))
        );
    }

    public void update(String key, String value) {
        int updated = jdbc.update(
                "UPDATE dashboard_settings SET setting_value = ? WHERE setting_key = ?", value, key);
        if (updated == 0) {
            throw new IllegalArgumentException("Unknown setting: " + key);
        }
    }

    /** Read fresh on every call (no caching) - settings changes take effect on the next API request, no restart. */
    public double getDouble(String key, double fallback) {
        return getRaw(key).map(Double::parseDouble).orElse(fallback);
    }

    public int getInt(String key, int fallback) {
        return getRaw(key).map(Integer::parseInt).orElse(fallback);
    }

    private Optional<String> getRaw(String key) {
        List<String> rows = jdbc.query(
                "SELECT setting_value FROM dashboard_settings WHERE setting_key = ?",
                (rs, rowNum) -> rs.getString(1), key);
        return rows.stream().findFirst();
    }

    public record SettingDto(String key, String value, String description) {
    }
}
