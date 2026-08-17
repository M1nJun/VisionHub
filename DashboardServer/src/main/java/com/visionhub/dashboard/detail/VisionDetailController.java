package com.visionhub.dashboard.detail;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/vision")
public class VisionDetailController {
    private final VisionDetailService service;

    public VisionDetailController(VisionDetailService service) {
        this.service = service;
    }

    @GetMapping("/{line}/{visionName}")
    public VisionDetailDto getDetail(@PathVariable String line, @PathVariable String visionName) {
        try {
            return service.getDetail(line, visionName);
        } catch (VisionDetailService.NoSuchVisionException e) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, e.getMessage());
        }
    }
}
