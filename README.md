# Welding CSV Agent + Central Test Receiver v2

Lightweight prototype for Welding Vision CSV parsing and central receiver testing.

## Safety principles

- Agent opens CSV files with `FileAccess.Read` and `FileShare.ReadWrite | FileShare.Delete`.
- Agent never edits, moves, renames, or deletes CSV/image/log files.
- Agent only writes its own `state.json` and `agent.log`.
- Receiver only writes to the configured output folder.
- This version does not fetch images. It only sends image paths for a later central fetcher.

## What changed in v2

- No periodic `WELDING_SUMMARY` events.
- Agent sends events only when new complete CSV rows are detected.
- OK rows send `WELDING_COUNT_DELTA` with `totalDelta=1`, `okDelta=1`, `defectDelta=0`.
- Defective rows send `WELDING_DEFECT` with `totalDelta=1`, `okDelta=0`, `defectDelta=1`, defect side, and image path pair.
- Every row event includes `eventId`.
- Receiver keeps `received_event_ids.txt` and ignores duplicate `eventId` values.
- Side detection uses primary column format first, then fallback format if needed.
  - C-NG / DLNG primary: `{SIDE}_{DEFECT}-JUDGE`; fallback: `{SIDE}_{DEFECT}-OK/NG`
  - NG primary: `{SIDE}_{DEFECT}-OK/NG`; fallback: `{SIDE}_{DEFECT}-JUDGE`

## Central Test Receiver

Build and run on the central PC:

```bat
cd CentralTestReceiver
go build -o CentralTestReceiver.exe
CentralTestReceiver.exe -listen :5000 -out D:\VisionDashboardTest
```

Output files:

```text
D:\VisionDashboardTest\received_events.jsonl
D:\VisionDashboardTest\received_summary.csv
D:\VisionDashboardTest\received_event_ids.txt
```

Health check:

```text
http://<central-pc-ip>:5000/health
```

## WeldingCsvAgent

Build on a Windows PC with .NET 8 SDK:

```bat
cd WeldingCsvAgent
dotnet publish -c Release -r win-x64 --self-contained true
```

Copy the full contents of the `publish` folder to:

```text
C:\VisionDashboardAgent\
```

Copy `personality.example.json` to `personality.json`, then edit:

- `receiver.eventUrl`
- `csv.folder`
- `csv.filePattern`
- `agentId`, `line`, `visionName`
- `judgeRules.backlightDefectsUsePath1`

Run:

```bat
WeldingCsvAgent.exe personality.json
```

## Backlight defects / PATH-1 rule

Put defect names that must use PATH-1 backlight images here:

```json
"backlightDefectsUsePath1": ["DEFECT_NAME_1", "DEFECT_NAME_2"]
```

If `JUDGE-DEFECT` matches this list, the agent sends:

- `<SIDE>_IMAGE-PATH-1`
- `<SIDE>_OVERLAY-IMAGE-PATH-1`

Otherwise it sends:

- `<SIDE>_IMAGE-PATH-3`
- `<SIDE>_OVERLAY-IMAGE-PATH-3`

## Testing notes

For repeated tests on the same CSV copy, delete both:

```text
C:\VisionDashboardAgent\state.json
D:\VisionDashboardTest\received_event_ids.txt
```

Only delete `state.json` while testing copied CSV files. Do not delete it casually when connected to live production CSV files.
