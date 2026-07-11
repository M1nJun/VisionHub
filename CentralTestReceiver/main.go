package main

import (
	"bufio"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type server struct {
	outDir string
	mu     sync.Mutex
	seen   map[string]bool
}

func main() {
	listen := flag.String("listen", ":5000", "HTTP listen address")
	outDir := flag.String("out", "D:\\VisionDashboardTest", "output directory")
	flag.Parse()

	if err := os.MkdirAll(*outDir, 0755); err != nil {
		log.Fatalf("failed to create output directory: %v", err)
	}

	s := &server{outDir: *outDir, seen: map[string]bool{}}
	s.loadSeenEventIds()

	http.HandleFunc("/events", s.handleEvents)
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("OK")) })

	log.Printf("CentralTestReceiver listening on %s", *listen)
	log.Printf("Output directory: %s", *outDir)
	log.Printf("Loaded %d existing eventIds for duplicate protection", len(s.seen))
	log.Fatal(http.ListenAndServe(*listen, nil))
}

func (s *server) loadSeenEventIds() {
	idsPath := filepath.Join(s.outDir, "received_event_ids.txt")
	f, err := os.Open(idsPath)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		id := strings.TrimSpace(sc.Text())
		if id != "" {
			s.seen[id] = true
		}
	}
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

	receivedAt := time.Now().Format(time.RFC3339Nano)
	m["receiverReceivedAt"] = receivedAt
	eventId := str(m["eventId"])

	s.mu.Lock()
	defer s.mu.Unlock()

	if eventId != "" && s.seen[eventId] {
		log.Printf("duplicate ignored eventId=%s type=%s agent=%s no=%s cell=%s judge=%s", short(eventId), str(m["eventType"]), str(m["agentId"]), str(m["no"]), str(m["cellId"]), str(m["judge"]))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"duplicate_ignored"}`))
		return
	}

	normalized, _ := json.Marshal(m)

	jsonlPath := filepath.Join(s.outDir, "received_events.jsonl")
	f, err := os.OpenFile(jsonlPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := f.Write(append(normalized, '\n')); err != nil {
		_ = f.Close()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = f.Close()

	if eventId != "" {
		idsPath := filepath.Join(s.outDir, "received_event_ids.txt")
		idFile, err := os.OpenFile(idsPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		_, _ = idFile.WriteString(eventId + "\n")
		_ = idFile.Close()
		s.seen[eventId] = true
	}

	if err := s.appendSummaryCsv(receivedAt, m); err != nil {
		log.Printf("summary csv error: %v", err)
	}

	eventType := str(m["eventType"])
	log.Printf("received %-20s agent=%s no=%s cell=%s judge=%s defect=%s sides=%s eventId=%s",
		eventType, str(m["agentId"]), str(m["no"]), str(m["cellId"]), str(m["judge"]), str(m["judgeDefect"]), sides(m["defectSides"]), short(eventId))

	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ok"}`))
}

func (s *server) appendSummaryCsv(receivedAt string, m map[string]any) error {
	path := filepath.Join(s.outDir, "received_summary.csv")
	newFile := false
	if _, err := os.Stat(path); os.IsNotExist(err) {
		newFile = true
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	w := csv.NewWriter(f)
	defer w.Flush()

	header := []string{
		"received_time", "event_type", "event_id", "agent_id", "line", "vision_name", "csv_file",
		"no", "model_id", "lot_id", "cell_id", "judge", "judge_defect",
		"total_delta", "ok_delta", "defect_delta", "defect_sides", "image_set",
		"lower_main", "lower_overlay", "upper_main", "upper_overlay",
		"used_column_format", "fallback_used", "warnings",
	}
	if newFile {
		if err := w.Write(header); err != nil {
			return err
		}
	}

	lowerMain, lowerOverlay, upperMain, upperOverlay, imageSet := imageFields(m["images"])
	usedFormat, fallbackUsed := sideDetectionFields(m["sideDetection"])
	record := []string{
		receivedAt,
		str(m["eventType"]),
		str(m["eventId"]),
		str(m["agentId"]),
		str(m["line"]),
		str(m["visionName"]),
		str(m["csvFile"]),
		str(m["no"]),
		str(m["modelId"]),
		str(m["lotId"]),
		str(m["cellId"]),
		str(m["judge"]),
		str(m["judgeDefect"]),
		str(m["totalDelta"]),
		str(m["okDelta"]),
		str(m["defectDelta"]),
		sides(m["defectSides"]),
		imageSet,
		lowerMain,
		lowerOverlay,
		upperMain,
		upperOverlay,
		usedFormat,
		fallbackUsed,
		listStrings(m["parseWarnings"]),
	}
	return w.Write(record)
}

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

func imageFields(v any) (lowerMain, lowerOverlay, upperMain, upperOverlay, imageSet string) {
	arr, ok := v.([]any)
	if !ok {
		return
	}
	sets := []string{}
	for _, item := range arr {
		im, ok := item.(map[string]any)
		if !ok {
			continue
		}
		side := strings.ToUpper(str(im["side"]))
		if s := str(im["imageSet"]); s != "" {
			sets = append(sets, side+":"+s)
		}
		switch side {
		case "LOWER":
			lowerMain = str(im["mainImagePath"])
			lowerOverlay = str(im["overlayImagePath"])
		case "UPPER":
			upperMain = str(im["mainImagePath"])
			upperOverlay = str(im["overlayImagePath"])
		}
	}
	imageSet = strings.Join(sets, ";")
	return
}

func sideDetectionFields(v any) (usedFormat, fallbackUsed string) {
	m, ok := v.(map[string]any)
	if !ok {
		return "", ""
	}
	return str(m["usedColumnFormat"]), str(m["fallbackUsed"])
}
