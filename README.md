# Welding CSV Agent + Central Test Receiver v15

## v15: Central PC relocation + third UI feedback round

The central PC moved to a new machine permanently: new IP (`10.93.177.246`), fresh MySQL84 install on the
default port 3306 this time (no more `MySQL80` conflict to dodge), `root`/`vision_app` both `1234`. Updated
everywhere that baked in the old PC's address/port:
- `AgentDeployer/config.json`: `centralHost` -> `10.93.177.246` (drives every future-generated
  `personality.json`'s `receiver.eventUrl`/`heartbeat.host`).
- `DashboardServer/central-pc-install/run-dashboard-server.ps1`: `DB_PORT` 3307->3306, `DB_PASSWORD` -> `1234`.
- `SmbImageFetcher/config.example.json`: port 3307->3306 (the real `config.json` on the central PC needs the
  same edit by hand - example files aren't deployed automatically).

Since it's a genuinely fresh MySQL (not a migrated/restored one), every table gets recreated empty on first
startup of each component (Receiver's `schema.sql`, DashboardServer's `dashboard_settings` seed) - so
`dashboard_settings` (poll interval, color thresholds, `image_root_path`, trend bucket size) resets to
hardcoded defaults too, not whatever had been tuned on the old machine. `image_root_path` in particular
needs to be re-set to wherever SmbImageFetcher is saving images *on this new PC* - not deployment gap, just
new-DB behavior.

The two already-deployed agents (5-2 Welding Cathode/Anode) have the *old* central IP baked into their
already-generated `personality.json` on those inspection PCs - re-running `Deploy-Agent.ps1` against them
now that `config.json` is fixed regenerates and rewrites the correct one via the existing SMB path, cleaner
than hand-editing files on each inspection PC.

**Third UI feedback round**:
- Image viewer canvas height: `360px` fixed -> `min(72vh, 640px)`, so images aren't cramped short while
  plenty of horizontal room went unused.
- Zoom changed from plain scroll to Ctrl/Cmd+scroll - a bare scroll over the image now falls through to
  normal page scrolling instead of being captured by the viewer, matching how zoom works on maps/most
  image viewers elsewhere on the web.
- Vision name column headers now styled as cards (dark panel + border), matching the grid cells below
  instead of floating as bare text.

## v14: SmbImageFetcher hang fix + second UI feedback round

**SmbImageFetcher bug**: reported symptom was the process staying up (no crash, no traceback, console window
still open) but silently doing nothing after some point, and the receiver logging `dial tcp
127.0.0.1:6001: ... actively refused it` for the notify call. Root cause: `shutil.copy2` has no timeout, and
neither did the `pymysql.connect()` calls - a stalled network path (SMB transfer going quiet after the
port-445 precheck already passed, or a MySQL query hanging) could block the single-threaded main loop
forever with no way to notice, which reads as "still running, doing nothing" from the outside. Fixed:
- `copy_with_timeout()` runs each `shutil.copy2` in its own daemon thread and gives up after
  `copyTimeoutSeconds` (default 20s) if it doesn't finish - Python can't forcibly kill a blocked thread, so
  this bounds the *wait*, not the copy itself, but that's enough to stop one stuck transfer from freezing
  every other pending image behind it.
- `connect()` now sets explicit `connect_timeout`/`read_timeout`/`write_timeout` (pymysql has none by
  default).
- The main loop's DB-reconnect path used to sit outside its own try/except - a failure *while recovering
  from* a DB hiccup would raise unhandled and silently kill the whole process (daemon notify thread included).
  Now wrapped, and logs instead of dying either way.
- Added a heartbeat log line every ~12 polls so a future hang is visible immediately in the log (last
  timestamp before the gap) instead of only inferable from "the console still looks open."
- Verified the timeout fix directly: monkeypatched `shutil.copy2` to sleep 60s, confirmed
  `copy_with_timeout(..., 2)` raises after exactly ~2s instead of hanging; confirmed a normal fast copy still
  succeeds through the same wrapper.

**Second UI feedback round**:
- **Neon card style** instead of solid-fill backgrounds: dark card, glowing colored border
  (`box-shadow`) + colored/glowing text, closer to the original mockup's "andon light on a dark HUD" look
  than a flat colored tile.
- **Vision names moved to column headers** (`.grid-header-row`, once per column) instead of repeated on
  every one of the 66 cells - each cell now shows only defect rate % and a BM badge if count > 0.
- **Detail page restructured** per the user's exact spec: stat tiles (added a `Defects` count tile, was
  missing) → a new two-column "Defect Images" panel (`ImageViewer` left, clickable Top-5-Defects-as-filter
  list right) → Defect Rate Trend → Recent Alarms → Lot History. Clicking a defect type in the list filters
  the viewer to that type's images, newest-first.
- **New `ImageViewer` component**: wheel-to-zoom (1x-6x), drag-to-pan when zoomed, prev/next (buttons +
  arrow keys), main/overlay toggle. No image library pulled in - plain CSS `transform: translate() scale()`
  driven by local component state.
- **Real bug caught building the viewer**: `usePolling` hands back a new array reference on every poll
  (5s default) even when the content hasn't changed, and `ImageViewer` had a `useEffect(() => resetToFirst,
  [images])` - so it silently snapped back to image 1 every 5 seconds, making Next/Prev look broken. Fixed
  by removing that effect and instead keying `<ImageViewer key={selectedType} ...>` from the parent, so
  React only resets the viewer's internal state on an actual filter change (a real remount), not on every
  routine poll. Verified: clicked Next, waited past a poll cycle, position held; clicked a different defect
  type filter, viewer correctly reset to that type's newest image.

## v13: Dashboard UI feedback round (from real central-PC testing)

- **Defect rate trend chart**: new `VisionDetailDto.defectRateTrend`, bucketed off the `events` table (not
  just `defects`) so each bucket has a real denominator - `WELDING_COUNT_DELTA`/`WELDING_DEFECT`/
  `WELDING_UNKNOWN_JUDGE` counted together as "total", `WELDING_DEFECT` as "defects", rate = defects/total
  per bucket, scoped to the current lot (`received_at >= vision_counters.lot_started_at`). Bucket size is a
  Setting (`trend_bucket_minutes`, default 30). Rendered with a small hand-rolled inline-SVG line chart
  (`TrendChart.tsx`) rather than pulling in a charting library.
- **Polling interval is now a Setting** (`dashboard_poll_interval_seconds`) instead of hardcoded 5s -
  `useDashboardConfig()` reads it (plus the warning/critical thresholds, so `TrendChart` can draw the same
  reference lines the grid uses for card color) once per page mount.
- **Image root is now independent of SmbImageFetcher's own config.json**, by design per the user: they want
  to point the dashboard at wherever images actually are from the Settings page, separately from whatever
  the fetcher's local config says, rather than one process's config silently controlling another's behavior.
  New setting `image_root_path`. `ImageController` no longer trusts `defect_images.local_main_path` as an
  absolute path - it takes only the filename from it and rejoins under
  `{image_root_path}/{line}/{visionName}/`, the same shape `SmbImageFetcher.local_dest_paths()` builds.
- **Defect-type filter** on the Recent Defect Images panel (client-side, options sourced from the same-lot
  Top 5 Defects list already being fetched).
- **Grid made drastically more compact** so all 66 cells fit on one screen without scrolling: cards dropped
  from a multi-row stat block to a single name+rate row (~40px tall vs ~96px), tighter gaps, smaller stat
  tiles/header. Detail info (OK/total, BM count, etc.) that used to live on the card is still one click away.
- **Card colors made vivid/solid** instead of dark tinted backgrounds - the user's factory-floor "traffic
  light from across the room" requirement wasn't met by the previous subtle dark-green/dark-red look.
  Amber gets dark text for contrast, the other states get white text.
- Renamed to "PKG Vision Dashboard", added the LG Energy Solution logo (fetched from
  `lgensol.com/inc/images/symbol/ci_en.svg`, this being the company's own internal tool) to the header.

Verified against a fresh local seed spanning a simulated 3-hour lot with a deliberately rising defect rate:
trend chart correctly plotted the climb across ~7 buckets with proper time-axis labels, and manually forcing
`vision_counters` to different rates confirmed all three card colors (green/amber/red) render distinctly
and match the configured thresholds.

## v12: DashboardServer + dashboard-web (first web UI)

Two new components, `DashboardServer/` (Spring Boot, Java 21) and `dashboard-web/` (React + Vite +
TypeScript), give the project its first actual dashboard. Spring Boot was the originally-planned stack
(kept over extending the Go receiver, which I'd have leaned toward otherwise) and it serves both the JSON
API and the built React app from one process/port, same "single deployable artifact" spirit as everything
else here - `dashboard-web`'s `npm run build` writes straight into
`DashboardServer/src/main/resources/static`, so `mvn package` afterward produces one runnable jar with
everything baked in.

**Grid**: always renders all 11 lines x 6 vision types (`VisionCatalog`), independent of which agents
actually exist in the DB - only Welding Cathode/Anode are deployed today, the other four vision types show
as `NOT_DEPLOYED` placeholder cards until their agents ship. No catalog change needed when a new vision type
starts reporting; it just starts showing real data.

**Status model** (per the user's requirement to tell "agent down" apart from "agent alive, line just
stopped"): `NOT_DEPLOYED` -> `OFFLINE` (no heartbeat within `agent_offline_threshold_seconds`) -> `IDLE`
(heartbeat fresh, but no new cell within `line_idle_threshold_seconds`) -> `RUNNING`. Card color is grey/blue
for the first three, green/yellow/red off `defect_rate_warning_pct` / `defect_rate_critical_pct` for
`RUNNING`. All four thresholds live in a new `dashboard_settings` DB table (seeded with defaults on startup,
added to `schema.sql` too) and are editable from the Settings page - no redeploy or restart to retune them.

**BM**: per the user's clarification, H/W vs S/W was **not** split - BM is just the `alarms` table shown as
a unified count (scoped to the current lot via `alarm_time >= vision_counters.lot_started_at`) plus a
code/name/detail/time list on the detail page. The `bm_type` column from the original schema design is
unused for now.

**Images**: served by a small `/api/images/{defectImageId}/main|overlay` endpoint that streams whatever
`SmbImageFetcher` already saved locally (`defect_images.local_main_path`/`local_overlay_path`), 404s if not
`fetch_status='fetched'` yet. Detail page shows recent defects as an image grid, "Fetching..." for
still-pending ones.

**Real bug caught during testing**: the datasource URL was configured with `serverTimezone=UTC`, which made
every timestamp read back ~4 hours off (this machine's MySQL `NOW()`/`CURRENT_TIMESTAMP` store local
wall-clock time, not UTC - the Go receiver's own DSN already accounts for this with `loc=Local`). A
heartbeat inserted seconds ago was misread as hours old, permanently showing every agent as `OFFLINE`.
Fixed by dropping `serverTimezone` entirely so the JDBC driver stops trying to convert.

**Deploying to the central PC** (new requirement - everything else so far was a single native exe, this one
needs a JVM):
1. One-time: install a JRE 21 on the central PC. Offline install, same pattern as MySQL - download an
   Eclipse Temurin 21 JRE installer here (this dev PC has internet), move it over by USB, install once.
2. Copy `DashboardServer/target/dashboard-server-*.jar` to the central PC (this is the one file to replace
   on future updates - no separate frontend deploy step, it's embedded in the jar).
3. Run: `java -jar dashboard-server-*.jar`, with `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`/
   `SERVER_PORT` environment variables overriding the dev defaults baked into `application.properties` as
   needed (mirrors how the Go receiver takes `-dsn`, just via env vars instead of flags since that's the
   idiomatic Spring Boot way).
4. Browse to `http://<central PC IP>:8080/dashboard` (or set `SERVER_PORT=80` for a port-free URL - fine to
   share a port with nothing else, Windows doesn't reserve <1024 to admins the way Unix does).
5. Firewall: needs an inbound rule for whatever `SERVER_PORT` is set to, same `New-NetFirewallRule` pattern
   used for the receiver's port 5000.

Verified locally end-to-end: seeded a demo agent/lot/defects/images/alarm/lot-history directly in the dev
DB, confirmed the grid correctly showed `NOT_DEPLOYED` for all 65 other cells and `RUNNING`/`RED` for the
seeded one once its heartbeat was fresh (and `OFFLINE`/grey again once it went stale past the threshold),
clicked through to the detail page and confirmed top defects / recent defect images (including a real
fetched image byte-for-byte) / alarms / lot history all rendered, and edited a setting from the UI and
confirmed it took effect on the next poll with no restart.

## v11: AgentDeployer remote admin auth

Plain "Everyone" SMB share access (used for file copy) and remote Windows Service control via `sc.exe` are two
*separate* Windows permission systems - the user found this the hard way: file copy worked immediately, but
`sc.exe \\<ip> create` failed with Access Denied until they (a) created a local admin account on the inspection
PC (`AgentDeploy`) and (b) set `LocalAccountTokenFilterPolicy=1` in the registry there, since by default a local
(non built-in-Administrator) account gets a filtered, non-admin token over the network even when it's really in
the local Administrators group. `AgentDeploy` + that registry key will be set up ahead of time on every
inspection PC going forward.

`Deploy-Agent.ps1` changes:
- New `-Credential` (prompted for interactively if not supplied - never written to disk, since it's one shared
  admin credential across every inspection PC) and `-DeployAccount` (default from `config.json`'s
  `deployAccount`, `AgentDeploy`) parameters.
- Before touching each target: `net use \\<ip>\IPC$ /user:<ip>\<account> <password>` establishes an
  authenticated session, which Windows then reuses for both the file share and `sc.exe`'s RPC calls to that
  same server - no per-command credentials needed after that. A cheap smoke test (`sc.exe \\<ip> query
  LanmanServer`, a service every Windows PC has) runs right after connecting, so a `LocalAccountTokenFilterPolicy`
  PC gives one specific, actionable error immediately instead of a confusing failure three steps later.
- **Real bug caught while testing this**: with `$ErrorActionPreference = "Stop"` set (as the script does), any
  native command (`net.exe`, `sc.exe`) whose call site redirects stderr with `2>&1` gets that stderr line
  wrapped into a *terminating* `NativeCommandError` in Windows PowerShell 5.1 - even for completely routine,
  expected stderr (e.g. "nothing to delete" from a cleanup `net use /delete` on first run). This silently
  killed the whole deployment after step one. Fixed by dropping `2>&1` everywhere (plain `| Out-Null` only
  touches stdout; stderr still prints normally without being escalated) - matches this session's own tooling
  guidance about not redirecting native stderr in PowerShell 5.1.
- Verified end-to-end on this dev machine: local admin test account + the same registry policy + a temporary
  `\\<hostname>\C` share standing in for a real inspection PC. Full run (`net use` auth → SMB copy →
  personality.json write → `sc.exe create` → `sc.exe start`) succeeded and the service reached `RUNNING`.

## v10: Windows Service support + AgentDeployer

**Agent can now run as a Windows Service, same exe as before.**
- `Program.cs` restructured from top-level statements + a `while(true)` loop into `Microsoft.Extensions.Hosting`'s generic host: `CsvLogWorker` and `HeartbeatWorker` (both `BackgroundService`), wired up with `.AddWindowsService()`. All the CSV/log/event-building logic (`DiscoverFiles`, `ProcessCsvFile`, `BuildDefectEvent`, etc.) moved into one `AgentLogic` static class so it's callable from the worker classes - top-level local functions can only be called from other top-level statements in C#, not from separately-declared types.
- Same binary runs as a plain console app when launched directly (unchanged behavior - this is what all earlier testing in this doc used) and as a real Windows Service when started by SCM. Verified locally: `sc.exe create`/`start` reaches `RUNNING` with no error 1053 (the classic "exe doesn't implement the service control protocol" failure you get registering a plain console app as a service), heartbeat kept flowing while running as a service, and `sc.exe stop` shut it down cleanly.
- **Important path gotcha**: a Windows Service's working directory is `C:\Windows\System32`, not the exe's folder. `AppContext.BaseDirectory` (used for resolving `stateFile`/`logFile`) is unaffected since it's based on the exe's actual location, not the working directory - but the `personality.json` path passed as an argument is resolved relative to the working directory. **The service's binPath must always pass an absolute path to personality.json**, which is exactly what `AgentDeployer` does.
- `WeldingCsvAgent.csproj` now bakes in `SelfContained`, `RuntimeIdentifier=win-x64`, and `PublishSingleFile` so `dotnet publish -c Release` alone produces one portable exe (no more remembering `-r win-x64 --self-contained true`).

**AgentDeployer** (`AgentDeployer/Deploy-Agent.ps1`, PowerShell - no build step):
- Deploys entirely over SMB: copies the agent binary + a per-target `personality.json` to `\\<ip>\C\VisionDashboardAgent`, and (optionally, `-InstallService`) registers/starts a Windows Service via `sc.exe \\<ip> create/start` - which rides over the same SMB/RPC channel (port 445), so no WinRM or PsExec needed. Without `-InstallService`, files are copied but nothing is started - SMB alone can't launch a remote process, only `sc.exe`'s remote *service* control can, which is why service registration is the only way this script can start an agent on a remote PC.
- Targets are resolved from `pcs.json` (line + vision_type) via `-Lines`/`-Sides` filters; `-DryRun` previews the target list and a fully rendered `personality.json` without touching anything; a confirmation prompt gates real deployment unless `-Force`.
- `personality.json` is generated per target from `templates/welding.personality.template.json` (`{{TOKEN}}` placeholders), using the line + Cathode/Anode to fill in `agentId`, `visionName`, and the CSV filename pattern (`Welding (-)` = Anode, `Welding (+)` = Cathode, confirmed earlier). Everything else (judge rules, image columns, `backlightDefectsUsePath1`, log monitor drives) comes from the one real reference `personality.json` the user had already tuned for 5-2 Welding Cathode - **assumed shared across every Welding Cathode/Anode agent**, not yet verified for a second PC.
- **Known open assumptions, flagged rather than silently guessed**: the `JF2` model token embedded in the CSV filename pattern (configurable via `config.json`'s `modelToken`, but assumed the same across all 18 Welding PCs); `D:\Files\Data\Result\Day` as the CSV folder on every Welding PC (only confirmed on 5-2 Cathode so far).
- **Adding a new vision type** (Lead, Lead Align, Pouch Align, Pinhole) once its agent exists: add `payload/<VisionType>/<Exe>`, a `templates/<visiontype>.personality.template.json`, and extend `Get-WeldingTargets`'s vision-type mapping (currently only handles `Welding (+)`/`Welding (-)`).
- Verified end-to-end on this dev machine using a temporary SMB share standing in for a real inspection PC (`\\<hostname>\<share>\VisionDashboardAgent`) plus `sc.exe \\<hostname> create/start/stop/delete`: file copy, service registration, start (`RUNNING`), and clean stop all worked. **Not yet verified against a real factory PC** - this dev machine has no network path to the 10.73.x/10.93.x range, so the first real deployment should start with `-DryRun` then a single PC, per usual.

## v9: Heartbeat

- Agent sends a small UDP "I'm alive" packet every 2s (`heartbeat` block in `personality.json`:
  `enabled`/`host`/`port`/`intervalMs`), independent of the CSV/log poll loop (its own background task), so
  heartbeats keep flowing at a steady cadence even during quiet production periods or a slow poll
  iteration. Payload: `{agentId, line, visionName, visionType, ts}`.
- UDP chosen on purpose (matches the original design): heartbeats are frequent and disposable - losing one
  is fine, the next is 2s away - so they don't need TCP's delivery guarantees or a full HTTP
  request/response per beat.
- Receiver listens on UDP (`-heartbeatListen`, default `:6002`) and upserts `agents.last_heartbeat_at` /
  `last_heartbeat_ip`. This can create a stub `agents` row from a heartbeat alone, before any CSV row has
  ever been read - so a freshly-installed agent shows up as "alive" immediately even with zero production
  data yet. New columns migrated idempotently on startup (`ensureAgentColumns`, same
  information_schema-check pattern as the fetcher's migration) and added to `schema.sql` for fresh installs.
- "Online/offline" is deliberately **not** a stored status column - it's just `NOW() - last_heartbeat_at`
  computed whenever something reads it (future API layer), so it can never go stale independent of reality.
- Verified end-to-end with the real compiled agent: `last_heartbeat_at` updated every ~2s while running,
  and correctly stopped advancing (`seconds_ago` climbing) the moment the agent process was killed.

## v8: near-real-time image fetch + a real reliability bug found while testing it

- Receiver now calls `SmbImageFetcher`'s `/notify` endpoint (fire-and-forget, non-blocking) right after
  committing a `WELDING_DEFECT` event that carries images, so the fetch happens within seconds instead of
  waiting up to the 10s poll interval. New flag: `-fetcherNotifyUrl` (default
  `http://127.0.0.1:6001/notify`, empty disables it). Polling remains as the reliability fallback if the
  notify call fails or the fetcher is down.
- **Bug found while testing this**: a plain `shutil.copy2` to an unreachable inspection PC's UNC path can
  hang for 90+ seconds (Windows' own SMB connection retries) - and since the fetcher's poll loop is
  single-threaded, one offline PC would stall every other pending image behind it, defeating the whole
  point of the low-latency notify. Fixed with a cheap TCP probe on port 445 (`smbCheckTimeoutSeconds`,
  default 3s) before attempting the actual copy - an unreachable PC now fails fast and gets retried on the
  next poll instead of blocking the queue. Verified: before the fix, a failed attempt took ~100s; after,
  ~3s.

## v7: SmbImageFetcher (new component)

Pulls the defect main/overlay image pairs the Receiver already recorded in `defect_images`
(`fetch_status='pending'`) from each inspection PC's SMB share to the central PC's local disk.

- Location: `SmbImageFetcher/` (Python). Built as a standalone `SmbImageFetcher.exe` via PyInstaller
  (`python -m PyInstaller --onefile --name SmbImageFetcher fetcher.py`) so the central PC needs no
  Python install, same pattern as the Go receiver.
- Run: `SmbImageFetcher.exe config.json` (copy `config.example.json` -> `config.json` and fill in the
  real DB port/password for that PC; `pcs.json` next to the exe maps `(line, vision_type)` -> inspection
  PC IP for the SMB path).
- Path conversion: DB stores local paths like `F:\Files\Image\...\x.jpg` (as read from the CSV); since
  every inspection PC shares each drive as "Everyone" under a share name equal to the drive letter, this
  becomes `\\<ip>\F\Files\Image\...\x.jpg`. No SMB library or credentials needed - Windows resolves the
  UNC path and `shutil.copy2` just works.
- `Welding Anode Vision` = `pcs.json`'s `"Welding (-)"`, `Welding Cathode Vision` = `"Welding (+)"`
  (confirmed by the user). Lead / Lead Align / Pouch Align / Pinhole mappings in
  `config.example.json`'s `visionNameToPcsType` are best-guess, unverified until those agents are deployed.
- Polls `defect_images` every `pollIntervalSeconds` (default 10s) for `fetch_status='pending'` rows,
  copies both files, and on success sets `fetch_status='fetched'` + `local_main_path`/`local_overlay_path`.
  On failure it increments `fetch_attempts` and stays `'pending'` (retried next poll) until
  `maxFetchAttempts` (default 5) is reached, then flips permanently to `'failed'` with `last_fetch_error`
  set. A missing IP mapping for a `(line, vision_name)` pair fails immediately (retrying can't fix that).
- Adds two columns to `defect_images` (`fetch_attempts`, `last_fetch_error`) - the fetcher runs its own
  idempotent migration on startup (checks `information_schema.columns` first; MySQL, unlike MariaDB, has
  no `ADD COLUMN IF NOT EXISTS`), and `CentralTestReceiver/schema.sql` was updated too so fresh installs
  get the columns from the start.
- Verified against the real dev DB: attempt-counting bug caught and fixed during testing - MySQL evaluates
  `UPDATE ... SET` clauses left-to-right and uses the already-incremented value later in the *same*
  statement, so `SET fetch_attempts = fetch_attempts + 1, fetch_status = IF(fetch_attempts + 1 >= N, ...)`
  silently double-counted. Fixed by computing the new attempt count in Python and writing plain values.

## v6 changes

- Receiver now persists to **MySQL** instead of local files (`received_events.jsonl` / `received_event_ids.txt` / `received_summary.csv` are gone).
- Schema lives in `CentralTestReceiver/schema.sql` (7 tables) and is auto-applied (idempotent `CREATE TABLE IF NOT EXISTS`) by the receiver on startup, so a fresh DB bootstraps itself.
- Two-tier design:
  - `events`: raw JSON payload for every event, `event_id` UNIQUE. This is the source of truth / replay log and is what now provides duplicate protection (no more `received_event_ids.txt`).
  - Structured tables the dashboard will actually query: `agents`, `vision_counters` (live per-lot counts, reset on `LOT_CHANGE`), `defects` + `defect_images` (one row per defect + per side image, `fetch_status='pending'` placeholder for the future SMB fetcher), `lot_history` (closed-lot summaries), `alarms` (`bm_type` column exists but stays NULL until the central PC classification logic is built).
- Duplicate events are detected via `INSERT IGNORE` on `events.event_id` and short-circuit before any side effects run (counters/defects/alarms are only touched once per unique event).
- `LOT_CHANGE` handling: reads the agent's current `vision_counters` row, seals it into `lot_history` (with `started_at`/`ended_at`), then resets `vision_counters` to zero for the new lot.
- New receiver flag: `-dsn` (MySQL connection string). `-out` is gone since there's no file output anymore.

Verified end-to-end with the real compiled `WeldingCsvAgent.exe` against a test CSV: OK row -> `WELDING_COUNT_DELTA`, DLNG row -> `WELDING_DEFECT` with correct side detection (`UPPER`) and image path capture, and a LOT-ID change in the CSV correctly triggered `LOT_CHANGE`, sealed the old lot into `lot_history`, and reset `vision_counters` for the new lot.

## v5 changes

- Keeps all v4 behavior:
  - Ignores `*_defect.csv` even if old `personality.json` does not list it.
  - Sends `WELDING_COUNT_DELTA` for each new OK row.
  - Sends `WELDING_DEFECT` for each new C-NG / DLNG / NG row.
  - Adds deterministic `eventId` to row events.
  - Uses side-detection fallback for exceptions such as `GAP_DL2`.
- Adds Status.log alarm monitoring:
  - Checks `E:\VisionPC\LOG`, `F:\VisionPC\LOG`, and `G:\VisionPC\LOG` by default.
  - Looks for today's local PC date file: `<YYMMDD>.Status.log`, e.g. `260711.Status.log`.
  - On agent start, begins at the end of existing log files, so old alarms are not sent.
  - While the agent is running, sends every newly appended line containing `[Alarm]`.
  - Sends alarm events as `VISION_ALARM`.
  - Date rollover is handled by recalculating the local-date filename each poll.

## Alarm event example

Input line:

```text
[2026/07/11 06:58:23.665][Alarm] 9003. CAMERA_GRAB_FAIL(LB0000)
```

Output event shape:

```json
{
  "eventType": "VISION_ALARM",
  "eventId": "...",
  "agentId": "TEST_5-2_WELDING_CATHODE",
  "line": "5-2",
  "visionName": "Welding Cathode Vision",
  "logFile": "E:\\VisionPC\\LOG\\260711.Status.log",
  "logDrive": "E",
  "alarmTimeRaw": "2026/07/11 06:58:23.665",
  "alarmTime": "2026-07-11T06:58:23.665-04:00",
  "alarmCode": "9003",
  "alarmName": "CAMERA_GRAB_FAIL",
  "alarmDetail": "LB0000",
  "alarmRawMessage": "9003. CAMERA_GRAB_FAIL(LB0000)",
  "rawLine": "[2026/07/11 06:58:23.665][Alarm] 9003. CAMERA_GRAB_FAIL(LB0000)"
}
```

## personality.json additions

Existing v4 `personality.json` should still work. The log monitor defaults to enabled with E/F/G, but it is better to explicitly add:

```json
"logMonitor": {
  "enabled": true,
  "driveLetters": ["E", "F", "G"],
  "logFolderRelativePath": "VisionPC\\LOG",
  "fileNameFormat": "yyMMdd.Status.log",
  "alarmMarker": "[Alarm]",
  "startAtEndOnAgentStart": true,
  "encoding": "utf-8"
}
```

## Build

Agent:

```bat
cd WeldingCsvAgent
dotnet publish -c Release
```

Output: a single `WeldingCsvAgent.exe` at `bin\Release\net8.0\win-x64\publish\` (self-contained + single-file are now baked into the csproj, so the old `-r win-x64 --self-contained true` flags aren't needed anymore). This is also runnable directly as a console app (double-click / `WeldingCsvAgent.exe personality.json`) - registering it as a Windows Service (see `AgentDeployer/`) is optional, same exe either way.

Receiver:

```bat
cd CentralTestReceiver
go build -o CentralTestReceiver.exe
CentralTestReceiver.exe -listen :5000 -dsn "vision_app:VisionAppDevPw!2026@tcp(127.0.0.1:3306)/vision_dashboard?parseTime=true&loc=Local"
```

The `-dsn` default already points at the local dev DB, so `-dsn` can be omitted on this machine.

## Local dev DB (MySQL)

- Installed via `winget install --id Oracle.MySQL`, running as the `MySQL84` Windows service (auto-start), data dir `C:\ProgramData\MySQL\MySQL Server 8.4\Data`.
- `root` password: `RootDevPw!2026`.
- App DB: `vision_dashboard`. App user (least-privilege, used by the receiver): `vision_app` / `VisionAppDevPw!2026`.
- Schema: `CentralTestReceiver/schema.sql`, auto-applied by the receiver on startup. Can also be applied manually:
  ```bat
  mysql -u vision_app -p vision_dashboard < CentralTestReceiver\schema.sql
  ```

## Clean test reset

For a clean test only:

```text
C:\VisionDashboardAgent\state.json   -- (or wherever the agent's stateFile points) forces CSV/log re-read from scratch
```

Deleting the agent's `state.json` in production can cause CSV rows to be re-read, but that's now safe on the DB side too:
duplicate rows are recognized by `events.event_id` (UNIQUE) and ignored before touching `agents` / `vision_counters` / `defects` / `alarms`.

To wipe DB data for a specific test agent instead of the whole DB:

```sql
DELETE FROM defect_images WHERE defect_id IN (SELECT id FROM defects WHERE agent_id = '<agentId>');
DELETE FROM defects WHERE agent_id = '<agentId>';
DELETE FROM alarms WHERE agent_id = '<agentId>';
DELETE FROM lot_history WHERE agent_id = '<agentId>';
DELETE FROM vision_counters WHERE agent_id = '<agentId>';
DELETE FROM agents WHERE agent_id = '<agentId>';
DELETE FROM events WHERE agent_id = '<agentId>';
```
