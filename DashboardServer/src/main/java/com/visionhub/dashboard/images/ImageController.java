package com.visionhub.dashboard.images;

import com.visionhub.dashboard.settings.SettingsService;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.List;

/**
 * Serves images SmbImageFetcher already pulled onto local disk.
 *
 * Deliberately does NOT trust defect_images.local_main_path/local_overlay_path
 * as an absolute path - those reflect whatever SmbImageFetcher's own
 * config.json said at fetch time, which the user wants to control
 * independently from a dashboard-side "image_root_path" setting (Settings
 * page). So only the filename is taken from the stored path, and it's
 * rejoined under {image_root_path}/{line}/{visionName}/ - the exact same
 * folder shape SmbImageFetcher's own local_dest_paths() builds. If the two
 * roots are kept in sync (the user's responsibility, by design), this finds
 * the same file; if the dashboard's copy of the setting is wrong, fixing it
 * in Settings fixes image serving immediately, no DB changes needed.
 */
@RestController
@RequestMapping("/api/images")
public class ImageController {
    private final JdbcTemplate jdbc;
    private final SettingsService settings;

    public ImageController(JdbcTemplate jdbc, SettingsService settings) {
        this.jdbc = jdbc;
        this.settings = settings;
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
        RowMapper<ImageRow> mapper = (rs, rowNum) -> new ImageRow(
                rs.getString(column), rs.getString("line"), rs.getString("vision_name"));

        List<ImageRow> rows = jdbc.query("""
                SELECT di.%s, d.line, d.vision_name
                FROM defect_images di
                JOIN defects d ON d.id = di.defect_id
                WHERE di.id = ? AND di.fetch_status = 'fetched'
                """.formatted(column), mapper, id);

        if (rows.isEmpty() || rows.get(0).storedPath() == null) {
            return ResponseEntity.notFound().build();
        }

        ImageRow row = rows.get(0);
        String filename = Paths.get(row.storedPath()).getFileName().toString();
        String imageRoot = settings.getRaw("image_root_path", "D:\\VisionDashboardImages");
        Path path = Paths.get(imageRoot, row.line(), row.visionName(), filename);

        if (!Files.exists(path) || !Files.isReadable(path)) {
            return ResponseEntity.notFound().build();
        }

        MediaType contentType = probeContentType(path);
        return ResponseEntity.ok()
                .contentType(contentType)
                .cacheControl(CacheControl.maxAge(Duration.ofDays(30)))
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

    private record ImageRow(String storedPath, String line, String visionName) {
    }
}
