package com.visionhub.dashboard.images;

import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Serves images SmbImageFetcher already pulled onto local disk (defect_images
 * .local_main_path / local_overlay_path). Looked up by defect_images.id, not
 * defect_id, since one defect can have image rows for more than one side.
 */
@RestController
@RequestMapping("/api/images")
public class ImageController {
    private final JdbcTemplate jdbc;

    public ImageController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/{id}/main")
    public ResponseEntity<Resource> main(@PathVariable long id) {
        return serve(id, "local_main_path");
    }

    @GetMapping("/{id}/overlay")
    public ResponseEntity<Resource> overlay(@PathVariable long id) {
        return serve(id, "local_overlay_path");
    }

    // column is always one of the two literal strings passed by main()/overlay() above,
    // never external input, so building the SELECT with it is safe.
    private ResponseEntity<Resource> serve(long id, String column) {
        List<String> rows = jdbc.query(
                "SELECT " + column + " FROM defect_images WHERE id = ? AND fetch_status = 'fetched'",
                (rs, rowNum) -> rs.getString(1), id);

        if (rows.isEmpty() || rows.get(0) == null) {
            return ResponseEntity.notFound().build();
        }

        Path path = Path.of(rows.get(0));
        if (!Files.exists(path) || !Files.isReadable(path)) {
            return ResponseEntity.notFound().build();
        }

        MediaType contentType = probeContentType(path);
        return ResponseEntity.ok()
                .contentType(contentType)
                .cacheControl(org.springframework.http.CacheControl.maxAge(java.time.Duration.ofDays(30)))
                .body(new FileSystemResource(path));
    }

    private MediaType probeContentType(Path path) {
        try {
            String probed = Files.probeContentType(path);
            if (probed != null) {
                return MediaType.parseMediaType(probed);
            }
        } catch (IOException ignored) {
            // fall through to default below
        }
        return MediaType.IMAGE_JPEG;
    }
}
