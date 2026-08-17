package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"database/sql"
	_ "github.com/go-sql-driver/mysql"
)

//go:embed schema.sql
var schemaSQL string

type server struct {
	db               *sql.DB
	fetcherNotifyURL string
	notifyClient     *http.Client
}

func main() {
	listen := flag.String("listen", ":5000", "HTTP listen address")
	dsn := flag.String("dsn", "vision_app:VisionAppDevPw!2026@tcp(127.0.0.1:3306)/vision_dashboard?parseTime=true&loc=Local", "MySQL DSN")
	fetcherNotifyURL := flag.String("fetcherNotifyUrl", "http://127.0.0.1:6001/notify", "SmbImageFetcher notify endpoint, called after a new defect image is stored so it fetches immediately instead of waiting for its poll interval. Empty disables this.")
	heartbeatListen := flag.String("heartbeatListen", ":6002", "UDP address to listen for agent heartbeats on. Empty disables this.")
	flag.Parse()

	db, err := sql.Open("mysql", *dsn)
	if err != nil {
		log.Fatalf("failed to open db: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Fatalf("failed to connect to db: %v", err)
	}

	if err := applySchema(db); err != nil {
		log.Fatalf("failed to apply schema: %v", err)
	}
	if err := ensureAgentColumns(db); err != nil {
		log.Fatalf("failed to migrate agents table: %v", err)
	}

	s := &server{
		db:               db,
		fetcherNotifyURL: *fetcherNotifyURL,
		notifyClient:     &http.Client{Timeout: 2 * time.Second},
	}

	http.HandleFunc("/events", s.handleEvents)
	http.HandleFunc("/health", s.handleHealth)

	if *heartbeatListen != "" {
		if err := startHeartbeatListener(db, *heartbeatListen); err != nil {
			log.Fatalf("failed to start heartbeat listener: %v", err)
		}
		log.Printf("Heartbeat listener (UDP): %s", *heartbeatListen)
	}

	log.Printf("CentralTestReceiver listening on %s", *listen)
	log.Printf("DB: %s", redactDSN(*dsn))
	if s.fetcherNotifyURL != "" {
		log.Printf("Fetcher notify: %s", s.fetcherNotifyURL)
	}
	log.Fatal(http.ListenAndServe(*listen, nil))
}

// applySchema runs the embedded schema.sql on startup so a fresh DB can
// bootstrap itself. All statements are CREATE TABLE IF NOT EXISTS, so this
// is a no-op once the tables already exist.
func applySchema(db *sql.DB) error {
	for _, stmt := range strings.Split(schemaSQL, ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("statement failed: %s: %w", short(stmt), err)
		}
	}
	return nil
}

// ensureAgentColumns is an idempotent migration for DBs created before the
// heartbeat feature existed. MySQL (unlike MariaDB) has no
// ADD COLUMN IF NOT EXISTS, so information_schema is checked first - the
// same pattern SmbImageFetcher uses for its own defect_images columns.
func ensureAgentColumns(db *sql.DB) error {
	for _, col := range []struct{ name, ddl string }{
		{"last_heartbeat_at", "ALTER TABLE agents ADD COLUMN last_heartbeat_at DATETIME(3) AFTER last_event_at"},
		{"last_heartbeat_ip", "ALTER TABLE agents ADD COLUMN last_heartbeat_ip VARCHAR(45) AFTER last_heartbeat_at"},
	} {
		var count int
		err := db.QueryRow(
			"SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'agents' AND column_name = ?",
			col.name,
		).Scan(&count)
		if err != nil {
			return err
		}
		if count == 0 {
			if _, err := db.Exec(col.ddl); err != nil {
				return err
			}
		}
	}
	return nil
}

// startHeartbeatListener listens for small UDP "I'm alive" packets from
// agents (2s interval by design - see WeldingCsvAgent's heartbeat loop) and
// upserts agents.last_heartbeat_at. UDP rather than the HTTP /events path on
// purpose: heartbeats are frequent and disposable (losing one is fine, the
// next arrives in 2s), so they don't need TCP's delivery guarantees or the
// overhead of a full HTTP request/response.
func startHeartbeatListener(db *sql.DB, addr string) error {
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		return err
	}
	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		return err
	}

	go func() {
		buf := make([]byte, 2048)
		for {
			n, remote, err := conn.ReadFromUDP(buf)
			if err != nil {
				log.Printf("heartbeat listener read error: %v", err)
				continue
			}
			var m map[string]any
			if err := json.Unmarshal(buf[:n], &m); err != nil {
				log.Printf("heartbeat: invalid json from %s: %v", remote, err)
				continue
			}
			if err := upsertHeartbeat(db, m, remote.IP.String()); err != nil {
				log.Printf("heartbeat: db error for agent=%s: %v", str(m["agentId"]), err)
			}
		}
	}()
	return nil
}

func upsertHeartbeat(db *sql.DB, m map[string]any, sourceIP string) error {
	agentId := str(m["agentId"])
	if agentId == "" {
		return fmt.Errorf("missing agentId")
	}
	ts := parseTime(str(m["ts"]))
	if ts == nil {
		ts = time.Now()
	}
	_, err := db.Exec(`
		INSERT INTO agents (agent_id, line, vision_name, vision_type, last_heartbeat_at, last_heartbeat_ip)
		VALUES (?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			line = VALUES(line),
			vision_name = VALUES(vision_name),
			vision_type = COALESCE(VALUES(vision_type), vision_type),
			last_heartbeat_at = VALUES(last_heartbeat_at),
			last_heartbeat_ip = VALUES(last_heartbeat_ip)`,
		agentId, str(m["line"]), str(m["visionName"]), nullStr(str(m["visionType"])), ts, sourceIP)
	return err
}

// notifyFetcher pokes SmbImageFetcher to fetch immediately instead of
// waiting for its own poll interval. Best-effort and non-blocking: the
// fetcher's periodic polling is the reliability fallback if this fails
// (fetcher down, network hiccup, etc), so failures are just logged.
func (s *server) notifyFetcher() {
	if s.fetcherNotifyURL == "" {
		return
	}
	go func() {
		resp, err := s.notifyClient.Post(s.fetcherNotifyURL, "application/octet-stream", nil)
		if err != nil {
			log.Printf("fetcher notify failed (will still be picked up by polling): %v", err)
			return
		}
		_ = resp.Body.Close()
	}()
}

func redactDSN(dsn string) string {
	at := strings.Index(dsn, "@")
	colon := strings.Index(dsn, ":")
	if at > 0 && colon > 0 && colon < at {
		return dsn[:colon] + ":***" + dsn[at:]
	}
	return dsn
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := s.db.PingContext(r.Context()); err != nil {
		http.Error(w, "DB_DOWN: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	_, _ = w.Write([]byte("OK"))
}

func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()

	body, err := io.ReadAll(io.LimitReader(r.Body, 5*1024*1024))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}

	eventId := str(m["eventId"])
	eventType := str(m["eventType"])
	agentId := str(m["agentId"])

	ctx := r.Context()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	inserted, err := insertEvent(ctx, tx, eventId, eventType, agentId, str(m["line"]), str(m["visionName"]), body, parseTime(str(m["createdAt"])))
	if err != nil {
		log.Printf("events insert error: %v", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if !inserted {
		_ = tx.Rollback()
		log.Printf("duplicate ignored eventId=%s type=%s agent=%s", short(eventId), eventType, agentId)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"duplicate_ignored"}`))
		return
	}

	if err := s.applySideEffects(ctx, tx, eventType, m); err != nil {
		log.Printf("side effect error for eventType=%s agent=%s: %v", eventType, agentId, err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := tx.Commit(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if eventType == "WELDING_DEFECT" {
		if images, ok := m["images"].([]any); ok && len(images) > 0 {
			s.notifyFetcher()
		}
	}

	log.Printf("received %-22s agent=%s no=%s cell=%s judge=%s defect=%s sides=%s eventId=%s",
		eventType, agentId, str(m["no"]), str(m["cellId"]), str(m["judge"]), str(m["judgeDefect"]), sides(m["defectSides"]), short(eventId))

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

// insertEvent stores the raw payload and reports whether this eventId was
// newly stored (false means it was already present, i.e. a duplicate delivery).
func insertEvent(ctx context.Context, tx *sql.Tx, eventId, eventType, agentId, line, visionName string, payload []byte, createdAt any) (bool, error) {
	res, err := tx.ExecContext(ctx, `
		INSERT IGNORE INTO events (event_id, event_type, agent_id, line, vision_name, payload, agent_created_at)
		VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?)`,
		eventId, eventType, agentId, nullStr(line), nullStr(visionName), string(payload), createdAt)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func (s *server) applySideEffects(ctx context.Context, tx *sql.Tx, eventType string, m map[string]any) error {
	agentId := str(m["agentId"])
	if agentId == "" {
		// No agent to attach this to (e.g. a manual/ad-hoc test event). The
		// raw event is already stored, nothing more to do.
		return nil
	}

	switch eventType {
	case "WELDING_COUNT_DELTA":
		if err := upsertAgent(ctx, tx, m); err != nil {
			return err
		}
		return incrementCounters(ctx, tx, agentId, str(m["lotId"]), parseTime(str(m["createdAt"])), counterDeltas{
			total: numToInt(m["totalDelta"]),
			ok:    numToInt(m["okDelta"]),
		})

	case "WELDING_UNKNOWN_JUDGE":
		if err := upsertAgent(ctx, tx, m); err != nil {
			return err
		}
		return incrementCounters(ctx, tx, agentId, str(m["lotId"]), parseTime(str(m["createdAt"])), counterDeltas{
			total:   numToInt(m["totalDelta"]),
			unknown: numToInt(m["totalDelta"]),
		})

	case "WELDING_DEFECT":
		if err := upsertAgent(ctx, tx, m); err != nil {
			return err
		}
		defectDelta := numToInt(m["defectDelta"])
		deltas := counterDeltas{total: numToInt(m["totalDelta"]), defect: defectDelta}
		switch strings.ToUpper(str(m["judge"])) {
		case "NG":
			deltas.ng = defectDelta
		case "C-NG":
			deltas.cng = defectDelta
		case "DLNG":
			deltas.dlng = defectDelta
		}
		if err := incrementCounters(ctx, tx, agentId, str(m["lotId"]), parseTime(str(m["createdAt"])), deltas); err != nil {
			return err
		}
		return insertDefect(ctx, tx, m)

	case "LOT_CHANGE":
		return handleLotChange(ctx, tx, m)

	case "VISION_ALARM":
		if err := upsertAgent(ctx, tx, m); err != nil {
			return err
		}
		return insertAlarm(ctx, tx, m)

	default:
		log.Printf("unhandled eventType=%s agent=%s: stored in events only", eventType, agentId)
		return nil
	}
}

type counterDeltas struct {
	total, ok, ng, cng, dlng, defect, unknown int
}

// incrementCounters adds the given deltas to the agent's current-lot counters.
// lot_started_at is only set on first insert (a brand-new agent/lot pair);
// the ON DUPLICATE branch deliberately leaves it untouched so it always
// reflects when this lot was first observed, not the latest row.
func incrementCounters(ctx context.Context, tx *sql.Tx, agentId, lotId string, createdAt any, d counterDeltas) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO vision_counters (agent_id, lot_id, lot_started_at, total_count, ok_count, ng_count, cng_count, dlng_count, defect_count, unknown_judge_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			lot_id = VALUES(lot_id),
			total_count = total_count + VALUES(total_count),
			ok_count = ok_count + VALUES(ok_count),
			ng_count = ng_count + VALUES(ng_count),
			cng_count = cng_count + VALUES(cng_count),
			dlng_count = dlng_count + VALUES(dlng_count),
			defect_count = defect_count + VALUES(defect_count),
			unknown_judge_count = unknown_judge_count + VALUES(unknown_judge_count)`,
		agentId, nullStr(lotId), createdAt, d.total, d.ok, d.ng, d.cng, d.dlng, d.defect, d.unknown)
	return err
}

func upsertAgent(ctx context.Context, tx *sql.Tx, m map[string]any) error {
	agentId := str(m["agentId"])
	_, err := tx.ExecContext(ctx, `
		INSERT INTO agents (agent_id, line, vision_name, vision_type, current_lot_id, current_model_id, last_csv_file, last_event_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			line = VALUES(line),
			vision_name = VALUES(vision_name),
			vision_type = COALESCE(VALUES(vision_type), vision_type),
			current_lot_id = COALESCE(VALUES(current_lot_id), current_lot_id),
			current_model_id = COALESCE(VALUES(current_model_id), current_model_id),
			last_csv_file = COALESCE(VALUES(last_csv_file), last_csv_file),
			last_event_at = VALUES(last_event_at)`,
		agentId, str(m["line"]), str(m["visionName"]), nullStr(str(m["visionType"])),
		nullStr(str(m["lotId"])), nullStr(str(m["modelId"])), nullStr(str(m["csvFile"])),
		parseTime(str(m["createdAt"])))
	return err
}

func insertDefect(ctx context.Context, tx *sql.Tx, m map[string]any) error {
	usedFormat, fallbackUsed := sideDetectionFields(m["sideDetection"])
	res, err := tx.ExecContext(ctx, `
		INSERT INTO defects (
			event_id, agent_id, line, vision_name, csv_file, model_id, lot_id, no, cell_id,
			judge, judge_defect, defect_sides, used_column_format, fallback_used,
			backlight_uses_path1, parse_warnings, agent_created_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		str(m["eventId"]), str(m["agentId"]), str(m["line"]), str(m["visionName"]), str(m["csvFile"]),
		nullStr(str(m["modelId"])), nullStr(str(m["lotId"])), nullInt(str(m["no"])), str(m["cellId"]),
		str(m["judge"]), str(m["judgeDefect"]), sides(m["defectSides"]), nullStr(usedFormat), fallbackUsed == "true",
		asBool(m["backlightDefectUsesPath1"]), nullStr(listStrings(m["parseWarnings"])), parseTime(str(m["createdAt"])))
	if err != nil {
		return err
	}
	defectId, err := res.LastInsertId()
	if err != nil {
		return err
	}

	images, _ := m["images"].([]any)
	for _, item := range images {
		im, ok := item.(map[string]any)
		if !ok {
			continue
		}
		_, err := tx.ExecContext(ctx, `
			INSERT INTO defect_images (defect_id, side, image_set, main_image_path, overlay_image_path)
			VALUES (?, ?, ?, ?, ?)`,
			defectId, strings.ToUpper(str(im["side"])), str(im["imageSet"]), str(im["mainImagePath"]), str(im["overlayImagePath"]))
		if err != nil {
			return err
		}
	}
	return nil
}

func insertAlarm(ctx context.Context, tx *sql.Tx, m map[string]any) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO alarms (
			event_id, agent_id, line, vision_name, vision_type,
			alarm_code, alarm_name, alarm_detail, alarm_raw_message,
			alarm_time_raw, alarm_time, log_drive, log_file_name, log_file, raw_line, agent_created_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		str(m["eventId"]), str(m["agentId"]), str(m["line"]), str(m["visionName"]), nullStr(str(m["visionType"])),
		nullStr(str(m["alarmCode"])), nullStr(str(m["alarmName"])), nullStr(str(m["alarmDetail"])), nullStr(str(m["alarmRawMessage"])),
		nullStr(str(m["alarmTimeRaw"])), parseTime(str(m["alarmTime"])), nullStr(str(m["logDrive"])), nullStr(str(m["logFileName"])),
		nullStr(str(m["logFile"])), nullStr(str(m["rawLine"])), parseTime(str(m["createdAt"])))
	return err
}

func handleLotChange(ctx context.Context, tx *sql.Tx, m map[string]any) error {
	agentId := str(m["agentId"])
	newLotId := str(m["newLotId"])
	oldLotId := str(m["oldLotId"])
	now := parseTime(str(m["createdAt"]))

	if err := upsertAgentBasic(ctx, tx, agentId, str(m["line"]), str(m["visionName"]), newLotId, now); err != nil {
		return err
	}

	var prevLotId sql.NullString
	var lotStartedAt sql.NullTime
	var total, ok, ng, cng, dlng, defect int
	row := tx.QueryRowContext(ctx, `
		SELECT lot_id, lot_started_at, total_count, ok_count, ng_count, cng_count, dlng_count, defect_count
		FROM vision_counters WHERE agent_id = ?`, agentId)
	err := row.Scan(&prevLotId, &lotStartedAt, &total, &ok, &ng, &cng, &dlng, &defect)
	hasPrevCounters := err == nil
	if err != nil && err != sql.ErrNoRows {
		return err
	}

	closedLotId := oldLotId
	if hasPrevCounters && prevLotId.Valid && prevLotId.String != "" {
		closedLotId = prevLotId.String
	}

	if closedLotId != "" {
		var startedAt any
		if lotStartedAt.Valid {
			startedAt = lotStartedAt.Time
		}
		_, err = tx.ExecContext(ctx, `
			INSERT INTO lot_history (agent_id, line, vision_name, lot_id, started_at, ended_at, total_count, ok_count, ng_count, cng_count, dlng_count, defect_count, end_reason)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOT_CHANGE')`,
			agentId, str(m["line"]), str(m["visionName"]), closedLotId, startedAt, now, total, ok, ng, cng, dlng, defect)
		if err != nil {
			return err
		}
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO vision_counters (agent_id, lot_id, lot_started_at, total_count, ok_count, ng_count, cng_count, dlng_count, defect_count, unknown_judge_count)
		VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0)
		ON DUPLICATE KEY UPDATE
			lot_id = VALUES(lot_id), lot_started_at = VALUES(lot_started_at),
			total_count = 0, ok_count = 0, ng_count = 0, cng_count = 0, dlng_count = 0, defect_count = 0, unknown_judge_count = 0`,
		agentId, nullStr(newLotId), now)
	return err
}

func upsertAgentBasic(ctx context.Context, tx *sql.Tx, agentId, line, visionName, lotId string, lastEventAt any) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO agents (agent_id, line, vision_name, current_lot_id, last_event_at)
		VALUES (?, ?, ?, ?, ?)
		ON DUPLICATE KEY UPDATE
			line = VALUES(line), vision_name = VALUES(vision_name),
			current_lot_id = COALESCE(VALUES(current_lot_id), current_lot_id),
			last_event_at = VALUES(last_event_at)`,
		agentId, line, visionName, nullStr(lotId), lastEventAt)
	return err
}

// ---- small helpers for pulling typed values out of the generic JSON map ----

func str(v any) string {
	if v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%.0f", t)
		}
		return fmt.Sprintf("%v", t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

func asBool(v any) bool {
	b, _ := v.(bool)
	return b
}

func numToInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(t)
		return n
	default:
		return 0
	}
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullInt(s string) any {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return nil
	}
	return n
}

// parseTime parses the ISO-8601 timestamps the C# agent sends
// (DateTimeOffset.Now, e.g. "2026-07-14T13:45:12.1234567-04:00").
// Returns nil when empty or unparsable so the column stores NULL
// instead of a zero-value time.
func parseTime(s string) any {
	if s == "" {
		return nil
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t
	}
	return nil
}

func short(s string) string {
	if len(s) <= 80 {
		return s
	}
	return s[:77] + "..."
}

func sides(v any) string { return listStrings(v) }

func listStrings(v any) string {
	arr, ok := v.([]any)
	if !ok {
		return ""
	}
	parts := make([]string, 0, len(arr))
	for _, item := range arr {
		parts = append(parts, str(item))
	}
	return strings.Join(parts, ";")
}

func sideDetectionFields(v any) (usedFormat, fallbackUsed string) {
	m, ok := v.(map[string]any)
	if !ok {
		return "", ""
	}
	return str(m["usedColumnFormat"]), str(m["fallbackUsed"])
}
