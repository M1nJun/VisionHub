-- Vision Dashboard - Central DB schema
-- Target: MySQL 8.4
-- Run with: mysql -u vision_app -p vision_dashboard < schema.sql

CREATE TABLE IF NOT EXISTS events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(512) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  line VARCHAR(16),
  vision_name VARCHAR(128),
  payload JSON NOT NULL,
  agent_created_at DATETIME(3) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_events_event_id (event_id),
  KEY idx_events_agent_type_time (agent_id, event_type, received_at),
  KEY idx_events_line_time (line, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agents (
  agent_id VARCHAR(128) PRIMARY KEY,
  line VARCHAR(16) NOT NULL,
  vision_name VARCHAR(128) NOT NULL,
  vision_type VARCHAR(64),
  current_lot_id VARCHAR(64),
  current_model_id VARCHAR(64),
  last_csv_file VARCHAR(255),
  last_event_at DATETIME(3),
  last_heartbeat_at DATETIME(3),
  last_heartbeat_ip VARCHAR(45),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS vision_counters (
  agent_id VARCHAR(128) PRIMARY KEY,
  lot_id VARCHAR(64),
  lot_started_at DATETIME(3) NULL,
  total_count INT NOT NULL DEFAULT 0,
  ok_count INT NOT NULL DEFAULT 0,
  ng_count INT NOT NULL DEFAULT 0,
  cng_count INT NOT NULL DEFAULT 0,
  dlng_count INT NOT NULL DEFAULT 0,
  defect_count INT NOT NULL DEFAULT 0,
  unknown_judge_count INT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_counters_agent FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS defects (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(512) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  line VARCHAR(16),
  vision_name VARCHAR(128),
  csv_file VARCHAR(255),
  model_id VARCHAR(64),
  lot_id VARCHAR(64),
  no INT,
  cell_id VARCHAR(64),
  judge VARCHAR(16) NOT NULL,
  judge_defect VARCHAR(128) NOT NULL,
  defect_sides VARCHAR(64),
  used_column_format VARCHAR(64),
  fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  backlight_uses_path1 BOOLEAN NOT NULL DEFAULT FALSE,
  parse_warnings TEXT,
  agent_created_at DATETIME(3) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_defects_event_id (event_id),
  KEY idx_defects_agent_time (agent_id, received_at),
  KEY idx_defects_agent_defect (agent_id, judge_defect),
  CONSTRAINT fk_defects_agent FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS defect_images (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  defect_id BIGINT NOT NULL,
  side VARCHAR(16) NOT NULL,
  image_set VARCHAR(32) NOT NULL,
  main_image_path VARCHAR(500),
  overlay_image_path VARCHAR(500),
  fetch_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  fetch_attempts INT NOT NULL DEFAULT 0,
  local_main_path VARCHAR(500),
  local_overlay_path VARCHAR(500),
  last_fetch_error VARCHAR(500) NULL,
  fetched_at DATETIME(3) NULL,
  CONSTRAINT fk_images_defect FOREIGN KEY (defect_id) REFERENCES defects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lot_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  agent_id VARCHAR(128) NOT NULL,
  line VARCHAR(16),
  vision_name VARCHAR(128),
  lot_id VARCHAR(64) NOT NULL,
  model_id VARCHAR(64),
  started_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  total_count INT NOT NULL DEFAULT 0,
  ok_count INT NOT NULL DEFAULT 0,
  ng_count INT NOT NULL DEFAULT 0,
  cng_count INT NOT NULL DEFAULT 0,
  dlng_count INT NOT NULL DEFAULT 0,
  defect_count INT NOT NULL DEFAULT 0,
  end_reason VARCHAR(32) NOT NULL DEFAULT 'LOT_CHANGE',
  KEY idx_lot_history_agent_lot (agent_id, lot_id),
  CONSTRAINT fk_lot_history_agent FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS alarms (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(512) NOT NULL,
  agent_id VARCHAR(128) NOT NULL,
  line VARCHAR(16),
  vision_name VARCHAR(128),
  vision_type VARCHAR(64),
  alarm_code VARCHAR(32),
  alarm_name VARCHAR(128),
  alarm_detail VARCHAR(255),
  alarm_raw_message VARCHAR(500),
  alarm_time_raw VARCHAR(64),
  alarm_time DATETIME(3) NULL,
  bm_type ENUM('HW','SW') DEFAULT NULL,
  log_drive VARCHAR(4),
  log_file_name VARCHAR(128),
  log_file VARCHAR(500),
  raw_line VARCHAR(1000),
  agent_created_at DATETIME(3) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_alarms_event_id (event_id),
  KEY idx_alarms_agent_time (agent_id, alarm_time),
  CONSTRAINT fk_alarms_agent FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Dashboard-tunable thresholds (defect rate colors, offline/idle timeouts,
-- etc). Read + written by DashboardServer's Settings screen so operators
-- can adjust these without a redeploy. DashboardServer seeds the default
-- rows on startup if this table is empty (see SchemaInitializer).
CREATE TABLE IF NOT EXISTS dashboard_settings (
  setting_key VARCHAR(64) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  description VARCHAR(255),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
