"""
SMB Image Fetcher - pulls defect main/overlay image pairs from inspection PCs
to the central PC's local disk, based on rows in defect_images (fetch_status='pending').

Images are shared "Everyone" on each inspection PC with the share name equal to
the drive letter (e.g. F:\\... is shared as \\<ip>\\F\\...), and no credentials
are required, so a plain file copy over the UNC path is enough - no SMB library
needed.
"""

import json
import os
import shutil
import socket
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pymysql
from pymysql.cursors import DictCursor


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def build_ip_lookup(pcs_data, vision_name_to_pcs_type):
    """(line, vision_name) -> ip, going through pcs.json's (line, vision_type)."""
    by_line_type = {}
    for pc in pcs_data["pcs"]:
        by_line_type[(pc["line"], pc["vision_type"])] = pc["ip"]

    lookup = {}
    for vision_name, pcs_type in vision_name_to_pcs_type.items():
        for (line, vtype), ip in by_line_type.items():
            if vtype == pcs_type:
                lookup[(line, vision_name)] = ip
    return lookup


def is_smb_reachable(ip, timeout_seconds):
    """A plain shutil.copy2 to an unreachable UNC path can hang for well over
    a minute (Windows' own SMB connection retries), and since the poll loop
    is single-threaded, one offline PC would stall every other pending image
    behind it. A short TCP probe on 445 first lets us fail fast instead."""
    try:
        with socket.create_connection((ip, 445), timeout=timeout_seconds):
            return True
    except OSError:
        return False


def copy_with_timeout(src, dest, timeout_seconds):
    """shutil.copy2 has no timeout of its own - if a copy stalls mid-transfer
    (network hiccup, remote share going slow/unresponsive after the initial
    port-445 check already passed), the whole single-threaded poll loop would
    hang forever with no way to notice or recover. Running it in its own
    daemon thread and giving up after timeout_seconds means one stuck copy
    can never freeze the process again - the abandoned thread just sits idle
    until it (maybe) finishes or the process exits; Python can't forcibly
    kill a blocked thread, so this bounds *our* wait, not the copy itself."""
    result = {}

    def worker():
        try:
            shutil.copy2(src, dest)
            result["ok"] = True
        except Exception as e:
            result["error"] = e

    t = threading.Thread(target=worker, daemon=True)
    t.start()
    t.join(timeout_seconds)
    if t.is_alive():
        raise TimeoutError(f"copy timed out after {timeout_seconds}s: {src} -> {dest}")
    if "error" in result:
        raise result["error"]


def to_unc_path(local_path, ip):
    """'F:\\Files\\Image\\x.jpg' + ip -> '\\\\<ip>\\F\\Files\\Image\\x.jpg'"""
    if ":" not in local_path:
        raise ValueError(f"path has no drive letter: {local_path}")
    drive, rest = local_path.split(":", 1)
    return f"\\\\{ip}\\{drive}{rest}"


def local_dest_paths(root, line, vision_name, defect_id, side, src_main, src_overlay):
    folder = os.path.join(root, line, vision_name)
    os.makedirs(folder, exist_ok=True)
    main_ext = os.path.splitext(src_main)[1] or ".jpg"
    overlay_ext = os.path.splitext(src_overlay)[1] or ".jpg"
    main_dest = os.path.join(folder, f"{defect_id}_{side}_main{main_ext}")
    overlay_dest = os.path.join(folder, f"{defect_id}_{side}_overlay{overlay_ext}")
    return main_dest, overlay_dest


def _column_exists(cur, table, column):
    cur.execute(
        "SELECT COUNT(*) FROM information_schema.columns "
        "WHERE table_schema = DATABASE() AND table_name = %s AND column_name = %s",
        (table, column),
    )
    return cur.fetchone()[0] > 0


def ensure_columns(conn):
    """Idempotent migration: add retry-tracking columns if this DB predates them.
    MySQL (unlike MariaDB) has no ADD COLUMN IF NOT EXISTS, so check first."""
    with conn.cursor() as cur:
        if not _column_exists(cur, "defect_images", "fetch_attempts"):
            cur.execute(
                "ALTER TABLE defect_images "
                "ADD COLUMN fetch_attempts INT NOT NULL DEFAULT 0 AFTER fetch_status"
            )
        if not _column_exists(cur, "defect_images", "last_fetch_error"):
            cur.execute(
                "ALTER TABLE defect_images "
                "ADD COLUMN last_fetch_error VARCHAR(500) NULL AFTER local_overlay_path"
            )
    conn.commit()


def fetch_pending_rows(conn, max_attempts, batch_size):
    with conn.cursor(DictCursor) as cur:
        cur.execute(
            """
            SELECT di.id, di.defect_id, di.side, di.main_image_path, di.overlay_image_path,
                   di.fetch_attempts, d.line, d.vision_name
            FROM defect_images di
            JOIN defects d ON di.defect_id = d.id
            WHERE di.fetch_status = 'pending' AND di.fetch_attempts < %s
            ORDER BY di.id
            LIMIT %s
            """,
            (max_attempts, batch_size),
        )
        return cur.fetchall()


def mark_fetched(conn, image_id, dest_main, dest_overlay):
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE defect_images SET fetch_status='fetched', local_main_path=%s, "
            "local_overlay_path=%s, fetched_at=NOW(3), last_fetch_error=NULL WHERE id=%s",
            (dest_main, dest_overlay, image_id),
        )
    conn.commit()


def mark_attempt_failed(conn, image_id, current_attempts, error_text, max_attempts):
    # Computed in Python rather than as a SQL expression: MySQL evaluates SET
    # clauses left-to-right and uses the already-incremented value for later
    # clauses in the same UPDATE, which silently double-counts the attempt.
    new_attempts = current_attempts + 1
    new_status = "failed" if new_attempts >= max_attempts else "pending"
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE defect_images SET fetch_attempts = %s, last_fetch_error = %s, "
            "fetch_status = %s WHERE id = %s",
            (new_attempts, error_text[:500], new_status, image_id),
        )
    conn.commit()


def mark_terminal_failed(conn, image_id, error_text):
    """For errors that a retry can never fix (e.g. no known IP for this line/vision)."""
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE defect_images SET fetch_status='failed', last_fetch_error=%s WHERE id=%s",
            (error_text[:500], image_id),
        )
    conn.commit()


def process_row(conn, row, cfg, ip_lookup):
    image_id = row["id"]
    defect_id = row["defect_id"]
    side = row["side"]
    line = row["line"]
    vision_name = row["vision_name"]

    ip = ip_lookup.get((line, vision_name))
    if not ip:
        mark_terminal_failed(
            conn, image_id, f"No IP mapping for line={line} vision_name={vision_name}"
        )
        print(f"[SKIP] image_id={image_id}: no IP mapping for ({line}, {vision_name})")
        return

    smb_timeout = cfg.get("smbCheckTimeoutSeconds", 3)
    if not is_smb_reachable(ip, smb_timeout):
        mark_attempt_failed(
            conn, image_id, row["fetch_attempts"],
            f"SMB port 445 unreachable on {ip} (probed with {smb_timeout}s timeout)",
            cfg["maxFetchAttempts"],
        )
        print(f"[FAIL] image_id={image_id} defect_id={defect_id}: {ip}:445 unreachable")
        return

    copy_timeout = cfg.get("copyTimeoutSeconds", 20)
    try:
        unc_main = to_unc_path(row["main_image_path"], ip)
        unc_overlay = to_unc_path(row["overlay_image_path"], ip)
        dest_main, dest_overlay = local_dest_paths(
            cfg["localImageRoot"], line, vision_name, defect_id, side,
            row["main_image_path"], row["overlay_image_path"],
        )
        copy_with_timeout(unc_main, dest_main, copy_timeout)
        copy_with_timeout(unc_overlay, dest_overlay, copy_timeout)
        mark_fetched(conn, image_id, dest_main, dest_overlay)
        print(f"[OK]   image_id={image_id} defect_id={defect_id} side={side} -> {dest_main}")
    except Exception as e:
        mark_attempt_failed(conn, image_id, row["fetch_attempts"], str(e), cfg["maxFetchAttempts"])
        print(f"[FAIL] image_id={image_id} defect_id={defect_id}: {e}")


def make_notify_handler(wake_event):
    class NotifyHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path == "/notify":
                wake_event.set()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"OK")
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, fmt, *args):
            pass  # quiet - the main loop already prints what matters

    return NotifyHandler


def start_notify_server(port, wake_event):
    """Lets the Receiver wake the poll loop immediately after inserting a new
    defect, instead of waiting up to pollIntervalSeconds. Polling still runs
    as the reliability fallback if this never fires (Fetcher restart, missed
    notify, etc)."""
    server = ThreadingHTTPServer(("0.0.0.0", port), make_notify_handler(wake_event))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(f"Notify server listening on :{port} (POST /notify wakes the poll loop early)")
    return server


def connect(db_cfg):
    # Explicit timeouts on purpose: pymysql has none by default, so a stalled
    # network path to MySQL (rare, but this process runs unattended for days)
    # could otherwise hang a query forever - the same class of bug as the
    # untimed shutil.copy2 calls below.
    return pymysql.connect(
        host=db_cfg["host"],
        port=db_cfg["port"],
        user=db_cfg["user"],
        password=db_cfg["password"],
        database=db_cfg["database"],
        autocommit=False,
        connect_timeout=10,
        read_timeout=20,
        write_timeout=20,
    )


def main():
    config_path = sys.argv[1] if len(sys.argv) > 1 else "config.json"
    base_dir = os.path.dirname(os.path.abspath(config_path)) or "."
    cfg = load_json(config_path)

    pcs_path = cfg["pcsFile"]
    if not os.path.isabs(pcs_path):
        pcs_path = os.path.join(base_dir, pcs_path)
    pcs_data = load_json(pcs_path)
    ip_lookup = build_ip_lookup(pcs_data, cfg["visionNameToPcsType"])
    print(f"Loaded {len(ip_lookup)} (line, vision_name) -> IP mappings from {pcs_path}")

    conn = connect(cfg["db"])
    ensure_columns(conn)
    print("SmbImageFetcher started. Polling every "
          f"{cfg['pollIntervalSeconds']}s, max {cfg['maxFetchAttempts']} attempts per image.")

    wake_event = threading.Event()
    notify_port = cfg.get("notifyPort", 6001)
    start_notify_server(notify_port, wake_event)

    poll_count = 0
    while True:
        # Everything below is inside one try/except - including the
        # reconnect attempt, which used to sit outside it. A DB hiccup right
        # as we tried to recover from a *previous* DB hiccup would otherwise
        # raise unhandled and silently kill this whole process (the notify
        # HTTP server is a daemon thread, so it dies with it) - the process
        # would still show as "running" in a stale console until someone
        # checked, exactly the "looks alive, does nothing" symptom this was
        # written to prevent.
        try:
            rows = fetch_pending_rows(conn, cfg["maxFetchAttempts"], cfg["batchSize"])
            for row in rows:
                process_row(conn, row, cfg, ip_lookup)
            poll_count += 1
            if poll_count % 12 == 0:  # ~ every 2 minutes at the default 10s interval
                print(f"[POLL] alive, poll #{poll_count}, {len(rows)} row(s) last pass")
        except pymysql.err.OperationalError as e:
            print(f"[DB] connection error: {e}")
            try:
                conn.close()
            except Exception:
                pass
            try:
                conn = connect(cfg["db"])
                print("[DB] reconnected")
            except Exception as reconnect_error:
                print(f"[DB] reconnect failed, will retry next poll: {reconnect_error}")
        except Exception:
            traceback.print_exc()

        # Sleeps up to pollIntervalSeconds, but a POST /notify from the
        # Receiver wakes this immediately for near-real-time fetching.
        wake_event.wait(timeout=cfg["pollIntervalSeconds"])
        wake_event.clear()


if __name__ == "__main__":
    main()
