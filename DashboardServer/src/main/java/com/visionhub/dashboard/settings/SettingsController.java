package com.visionhub.dashboard.settings;

import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/settings")
public class SettingsController {
    private final SettingsService service;

    public SettingsController(SettingsService service) {
        this.service = service;
    }

    @GetMapping
    public List<SettingsService.SettingDto> getAll() {
        return service.getAll();
    }

    @PutMapping("/{key}")
    public void update(@PathVariable String key, @RequestBody Map<String, String> body) {
        String value = body.get("value");
        if (value == null) {
            throw new IllegalArgumentException("Missing 'value' in request body");
        }
        service.update(key, value);
    }
}
