package com.visionhub.dashboard.grid;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/grid")
public class GridController {
    private final GridService service;

    public GridController(GridService service) {
        this.service = service;
    }

    @GetMapping
    public List<VisionCellDto> getGrid() {
        return service.getGrid();
    }
}
