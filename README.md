# Welding CSV Agent + Central Test Receiver v5

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
dotnet publish -c Release -r win-x64 --self-contained true
```

Receiver:

```bat
cd CentralTestReceiver
go build -o CentralTestReceiver.exe
CentralTestReceiver.exe -listen :5000 -out D:\VisionDashboardTest
```

## Clean test reset

For a clean test only:

```text
C:\VisionDashboardAgent\state.json
D:\VisionDashboardTest\received_events.jsonl
D:\VisionDashboardTest\received_event_ids.txt
```

Deleting state in production can cause CSV rows to be re-read. Only do it intentionally during tests.
