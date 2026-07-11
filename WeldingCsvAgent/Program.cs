using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Security.Cryptography;

var configPath = args.Length > 0 ? args[0] : "personality.json";
if (!File.Exists(configPath))
{
    Console.WriteLine($"Missing config: {Path.GetFullPath(configPath)}");
    Console.WriteLine("Copy personality.example.json to personality.json and edit it.");
    return 2;
}

var jsonOptions = new JsonSerializerOptions
{
    PropertyNameCaseInsensitive = true,
    WriteIndented = false,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};

var config = JsonSerializer.Deserialize<Personality>(File.ReadAllText(configPath), jsonOptions)
             ?? throw new InvalidOperationException("Invalid personality file.");

var appDir = AppContext.BaseDirectory;
var statePath = MakeAbsolute(config.StateFile ?? "state.json", appDir);
var logPath = MakeAbsolute(config.LogFile ?? "agent.log", appDir);
Directory.CreateDirectory(Path.GetDirectoryName(statePath)!);
Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);

var logger = new Logger(logPath);
var state = AgentState.Load(statePath);
using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(config.Receiver.TimeoutSeconds <= 0 ? 3 : config.Receiver.TimeoutSeconds) };

var pollMs = config.PollIntervalMs <= 0 ? 1000 : config.PollIntervalMs;

Console.WriteLine($"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] WeldingCsvAgent started: {config.AgentId}");
Console.WriteLine($"Config: {Path.GetFullPath(configPath)}");
Console.WriteLine($"State : {statePath}");
Console.WriteLine("Mode  : change-driven row events; no periodic summary events");
Console.WriteLine("Press Ctrl+C to stop.");
logger.Info($"Started agent {config.AgentId}");

while (true)
{
    try
    {
        var files = DiscoverFiles(config).ToList();
        foreach (var file in files)
        {
            await ProcessCsvFile(file, config, state, http, logger, jsonOptions);
        }
        state.Save(statePath);
    }
    catch (Exception ex)
    {
        logger.Error("Main loop error: " + ex);
    }

    await Task.Delay(pollMs);
}

static IEnumerable<string> DiscoverFiles(Personality config)
{
    var folder = config.Csv.Folder;
    if (!Directory.Exists(folder)) yield break;

    var today = DateTime.Now.ToString("yyyyMMdd");
    var pattern = (config.Csv.FilePattern ?? "*.csv").Replace("{yyyyMMdd}", today);

    var ignoreEndsWith = config.Csv.IgnoreFileNameEndsWith ?? new List<string>();
    var ignoreContains = config.Csv.IgnoreFileNameContains ?? new List<string>();

    foreach (var file in Directory.EnumerateFiles(folder, pattern, SearchOption.TopDirectoryOnly)
                 .Where(f => !ShouldIgnoreFile(Path.GetFileName(f), ignoreEndsWith, ignoreContains))
                 .OrderBy(f => File.GetCreationTimeUtc(f))
                 .ThenBy(f => f, StringComparer.OrdinalIgnoreCase))
    {
        yield return file;
    }
}

static bool ShouldIgnoreFile(string fileName, List<string> ignoreEndsWith, List<string> ignoreContains)
{
    foreach (var suffix in ignoreEndsWith)
    {
        if (!string.IsNullOrWhiteSpace(suffix) && fileName.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) return true;
    }

    foreach (var part in ignoreContains)
    {
        if (!string.IsNullOrWhiteSpace(part) && fileName.Contains(part, StringComparison.OrdinalIgnoreCase)) return true;
    }

    return false;
}

static async Task ProcessCsvFile(string file, Personality config, AgentState state, HttpClient http, Logger logger, JsonSerializerOptions jsonOptions)
{
    var fileState = state.GetFileState(file);
    var encoding = GetEncoding(config.Csv.Encoding);

    FileInfo fi;
    try { fi = new FileInfo(file); }
    catch { return; }

    if (!fi.Exists) return;

    if (fi.Length < fileState.LastOffset)
    {
        logger.Info($"File size became smaller. Resetting offset: {file}");
        fileState.LastOffset = 0;
        fileState.Header = null;
        fileState.PendingPartialLine = "";
    }

    using var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    fs.Seek(fileState.LastOffset, SeekOrigin.Begin);

    using var sr = new StreamReader(fs, encoding, detectEncodingFromByteOrderMarks: true, bufferSize: 16 * 1024, leaveOpen: true);
    var appended = await sr.ReadToEndAsync();
    var newOffset = fs.Position;

    if (string.IsNullOrEmpty(appended)) return;

    var combined = (fileState.PendingPartialLine ?? "") + appended;
    var endsWithNewline = combined.EndsWith("\n") || combined.EndsWith("\r");
    var lines = SplitLines(combined).ToList();

    if (!endsWithNewline && lines.Count > 0)
    {
        fileState.PendingPartialLine = lines[^1];
        lines.RemoveAt(lines.Count - 1);
    }
    else
    {
        fileState.PendingPartialLine = "";
    }

    if (lines.Count == 0)
    {
        fileState.LastOffset = newOffset;
        return;
    }

    var header = fileState.Header;
    var lineStartIndex = 0;
    if (header == null || header.Count == 0)
    {
        header = Csv.ParseLine(lines[0], config.Csv.DelimiterChar()).Select(h => h.Trim()).ToList();
        fileState.Header = header;
        lineStartIndex = 1;
        logger.Info($"Header loaded from {Path.GetFileName(file)}: {header.Count} columns");
    }

    var index = header.Select((name, i) => new { name, i })
                      .GroupBy(x => x.name, StringComparer.OrdinalIgnoreCase)
                      .ToDictionary(g => g.Key, g => g.First().i, StringComparer.OrdinalIgnoreCase);

    var allEventsSent = true;

    for (int i = lineStartIndex; i < lines.Count; i++)
    {
        var line = lines[i];
        if (string.IsNullOrWhiteSpace(line)) continue;

        List<string> fields;
        try { fields = Csv.ParseLine(line, config.Csv.DelimiterChar()); }
        catch (Exception ex)
        {
            logger.Warn($"CSV parse failed. File={Path.GetFileName(file)} LineIndex={i}. {ex.Message}");
            continue;
        }

        var row = new CsvRow(index, fields);
        var no = row.Get(config.Columns.No).Trim();
        var modelId = row.Get(config.Columns.ModelId).Trim();
        var lotId = row.Get(config.Columns.LotId).Trim();
        var cellId = row.Get(config.Columns.CellId).Trim();
        var judge = row.Get(config.Columns.Judge).Trim();
        var judgeDefect = row.Get(config.Columns.JudgeDefect).Trim();
        var csvFileName = Path.GetFileName(file);

        if (!string.IsNullOrWhiteSpace(lotId) && !string.IsNullOrWhiteSpace(fileState.LastLotId) && !string.Equals(lotId, fileState.LastLotId, StringComparison.OrdinalIgnoreCase))
        {
            state.CurrentLotId = lotId;
            if (config.Options.SendLotChangeEvent)
            {
                var lotEventId = EventIds.Make(config.AgentId, csvFileName, fileState.LastLotId, lotId, no, cellId, "LOT_CHANGE");
                var lotEvent = new
                {
                    eventType = "LOT_CHANGE",
                    eventId = lotEventId,
                    agentId = config.AgentId,
                    line = config.Line,
                    visionName = config.VisionName,
                    oldLotId = fileState.LastLotId,
                    newLotId = lotId,
                    detectedAtNo = no,
                    detectedAtCellId = cellId,
                    csvFile = csvFileName,
                    createdAt = DateTimeOffset.Now
                };
                if (!await SendEvent(lotEvent, config, http, logger, jsonOptions)) { allEventsSent = false; break; }
            }
        }

        var baseInfo = new RowBaseInfo(config.AgentId, config.Line, config.VisionName, config.VisionType, csvFileName, modelId, lotId, no, cellId, judge, judgeDefect);

        if (string.Equals(judge, config.JudgeRules.OkJudge, StringComparison.OrdinalIgnoreCase))
        {
            var countEvent = BuildCountDeltaEvent(baseInfo);
            if (!await SendEvent(countEvent, config, http, logger, jsonOptions)) { allEventsSent = false; break; }
            state.TotalReadCount++;
            state.OkCount++;
        }
        else if (config.JudgeRules.DefectJudges.Contains(judge, StringComparer.OrdinalIgnoreCase))
        {
            var defectEvent = BuildDefectEvent(config, row, index, baseInfo);
            if (!await SendEvent(defectEvent, config, http, logger, jsonOptions)) { allEventsSent = false; break; }

            state.TotalReadCount++;
            state.DefectCount++;
            if (string.Equals(judge, "C-NG", StringComparison.OrdinalIgnoreCase)) state.CNgCount++;
            else if (string.Equals(judge, "DLNG", StringComparison.OrdinalIgnoreCase)) state.DlngCount++;
            else if (string.Equals(judge, "NG", StringComparison.OrdinalIgnoreCase)) state.NgCount++;
        }
        else
        {
            state.UnknownJudgeCount++;
            logger.Warn($"Unknown JUDGE value '{judge}' at NO={no}, CELL-ID={cellId}");
            var unknownEvent = BuildUnknownJudgeEvent(baseInfo);
            if (!await SendEvent(unknownEvent, config, http, logger, jsonOptions)) { allEventsSent = false; break; }
        }

        if (!string.IsNullOrWhiteSpace(lotId)) fileState.LastLotId = lotId;
        state.CurrentLotId = lotId;
        state.CurrentModelId = modelId;
        state.LastCellId = cellId;
        state.LastNo = no;
        state.LastCsvFile = csvFileName;
        state.LastReadTime = DateTimeOffset.Now;
    }

    if (allEventsSent)
    {
        fileState.LastOffset = newOffset;
    }
    else
    {
        logger.Warn($"Not advancing file offset because at least one event failed. File will be retried: {Path.GetFileName(file)}");
    }
}

static object BuildCountDeltaEvent(RowBaseInfo b)
{
    var eventId = EventIds.Make(b.AgentId, b.CsvFile, b.LotId, b.No, b.CellId, b.Judge);
    return new
    {
        eventType = "WELDING_COUNT_DELTA",
        eventId,
        agentId = b.AgentId,
        line = b.Line,
        visionName = b.VisionName,
        visionType = b.VisionType,
        csvFile = b.CsvFile,
        modelId = b.ModelId,
        lotId = b.LotId,
        no = b.No,
        cellId = b.CellId,
        judge = b.Judge,
        totalDelta = 1,
        okDelta = 1,
        defectDelta = 0,
        createdAt = DateTimeOffset.Now
    };
}

static object BuildUnknownJudgeEvent(RowBaseInfo b)
{
    var eventId = EventIds.Make(b.AgentId, b.CsvFile, b.LotId, b.No, b.CellId, b.Judge, "UNKNOWN_JUDGE");
    return new
    {
        eventType = "WELDING_UNKNOWN_JUDGE",
        eventId,
        agentId = b.AgentId,
        line = b.Line,
        visionName = b.VisionName,
        visionType = b.VisionType,
        csvFile = b.CsvFile,
        modelId = b.ModelId,
        lotId = b.LotId,
        no = b.No,
        cellId = b.CellId,
        judge = b.Judge,
        judgeDefect = b.JudgeDefect,
        totalDelta = 1,
        okDelta = 0,
        defectDelta = 0,
        createdAt = DateTimeOffset.Now,
        parseWarnings = new[] { $"Unknown JUDGE value: {b.Judge}" }
    };
}

static object BuildDefectEvent(Personality config, CsvRow row, Dictionary<string, int> index, RowBaseInfo b)
{
    var warnings = new List<string>();
    var usePath1 = config.JudgeRules.BacklightDefectsUsePath1.Contains(b.JudgeDefect, StringComparer.OrdinalIgnoreCase);

    var primaryFormat = string.Equals(b.Judge, "NG", StringComparison.OrdinalIgnoreCase)
        ? config.JudgeRules.NgColumnFormat
        : config.JudgeRules.CNgAndDlngColumnFormat;
    var fallbackFormat = string.Equals(primaryFormat, config.JudgeRules.NgColumnFormat, StringComparison.OrdinalIgnoreCase)
        ? config.JudgeRules.CNgAndDlngColumnFormat
        : config.JudgeRules.NgColumnFormat;

    var primary = TryDetectSides(config, row, index, b.JudgeDefect, primaryFormat);
    SideDetectionResult used = primary;
    var fallbackUsed = false;

    if (primary.DefectSides.Count == 0)
    {
        var fallback = TryDetectSides(config, row, index, b.JudgeDefect, fallbackFormat);
        if (fallback.FoundAnyColumn || fallback.DefectSides.Count > 0)
        {
            used = fallback;
            fallbackUsed = true;
        }
    }

    warnings.AddRange(used.Warnings);
    if (used.DefectSides.Count == 0) warnings.Add("No defective side detected from dynamic LOWER/UPPER columns.");

    var images = new List<object>();
    foreach (var side in used.DefectSides)
    {
        if (!config.ImageColumns.TryGetValue(side, out var imageCols))
        {
            warnings.Add($"Image column config missing for side: {side}");
            continue;
        }

        var mainCol = usePath1 ? imageCols.Path1Main : imageCols.Path3Main;
        var overlayCol = usePath1 ? imageCols.Path1Overlay : imageCols.Path3Overlay;
        var mainPath = row.Get(mainCol);
        var overlayPath = row.Get(overlayCol);

        if (string.IsNullOrWhiteSpace(mainPath)) warnings.Add($"Empty image path: {mainCol}");
        if (string.IsNullOrWhiteSpace(overlayPath)) warnings.Add($"Empty overlay image path: {overlayCol}");

        images.Add(new
        {
            side,
            imageSet = usePath1 ? "PATH-1-BACKLIGHT" : "PATH-3-MAIN",
            mainImageColumn = mainCol,
            overlayImageColumn = overlayCol,
            mainImagePath = mainPath,
            overlayImagePath = overlayPath
        });
    }

    var eventId = EventIds.Make(b.AgentId, b.CsvFile, b.LotId, b.No, b.CellId, b.Judge, b.JudgeDefect);

    return new
    {
        eventType = "WELDING_DEFECT",
        eventId,
        agentId = b.AgentId,
        line = b.Line,
        visionName = b.VisionName,
        visionType = b.VisionType,
        csvFile = b.CsvFile,
        modelId = b.ModelId,
        lotId = b.LotId,
        cellId = b.CellId,
        no = b.No,
        judge = b.Judge,
        judgeDefect = b.JudgeDefect,
        totalDelta = 1,
        okDelta = 0,
        defectDelta = 1,
        backlightDefectUsesPath1 = usePath1,
        sideDetection = new
        {
            primaryColumnFormat = primaryFormat,
            fallbackColumnFormat = fallbackFormat,
            usedColumnFormat = used.UsedColumnFormat,
            fallbackUsed
        },
        sideCheckColumns = config.Options.SendDebugFields ? used.SideCheck : null,
        defectSides = used.DefectSides,
        images,
        parseWarnings = warnings.Count > 0 ? warnings.Distinct().ToList() : null,
        createdAt = DateTimeOffset.Now
    };
}

static SideDetectionResult TryDetectSides(Personality config, CsvRow row, Dictionary<string, int> index, string judgeDefect, string colFormat)
{
    var result = new SideDetectionResult { UsedColumnFormat = colFormat };
    foreach (var side in config.JudgeRules.Sides)
    {
        var dynamicColumn = colFormat.Replace("{SIDE}", side).Replace("{DEFECT}", judgeDefect);
        var exists = index.ContainsKey(dynamicColumn);
        var value = row.Get(dynamicColumn).Trim();
        if (exists) result.FoundAnyColumn = true;
        else result.Warnings.Add($"Column not found: {dynamicColumn}");

        result.SideCheck[side] = new { column = dynamicColumn, exists, value };
        var isDefectiveSide = config.JudgeRules.DefectSideValues.Contains(value, StringComparer.OrdinalIgnoreCase);
        if (isDefectiveSide) result.DefectSides.Add(side);
    }
    return result;
}

static async Task<bool> SendEvent(object ev, Personality config, HttpClient http, Logger logger, JsonSerializerOptions jsonOptions)
{
    if (config.Options.DryRun)
    {
        Console.WriteLine(JsonSerializer.Serialize(ev, new JsonSerializerOptions(jsonOptions) { WriteIndented = true }));
        return true;
    }

    try
    {
        using var resp = await http.PostAsJsonAsync(config.Receiver.EventUrl, ev, jsonOptions);
        if (!resp.IsSuccessStatusCode)
        {
            logger.Warn($"Receiver returned {(int)resp.StatusCode}: {await resp.Content.ReadAsStringAsync()}");
            return false;
        }
        return true;
    }
    catch (Exception ex)
    {
        logger.Warn("Failed to send event: " + ex.Message);
        return false;
    }
}

static Encoding GetEncoding(string? name)
{
    if (string.IsNullOrWhiteSpace(name)) return new UTF8Encoding(false);
    return Encoding.GetEncoding(name);
}

static IEnumerable<string> SplitLines(string text)
{
    using var reader = new StringReader(text);
    string? line;
    while ((line = reader.ReadLine()) != null) yield return line;
}

static string MakeAbsolute(string path, string baseDir) => Path.IsPathRooted(path) ? path : Path.Combine(baseDir, path);

public readonly record struct RowBaseInfo(string AgentId, string Line, string VisionName, string VisionType, string CsvFile, string ModelId, string LotId, string No, string CellId, string Judge, string JudgeDefect);

public sealed class SideDetectionResult
{
    public string UsedColumnFormat { get; set; } = "";
    public bool FoundAnyColumn { get; set; }
    public Dictionary<string, object?> SideCheck { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public List<string> DefectSides { get; set; } = new();
    public List<string> Warnings { get; set; } = new();
}

public static class EventIds
{
    public static string Make(params string?[] parts)
    {
        var raw = string.Join("|", parts.Select(p => (p ?? "").Trim()));
        // Keep the human-readable key and add a short hash to avoid issues with very long/odd strings later.
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)))[..12];
        return raw + "|" + hash;
    }
}

public sealed class Personality
{
    public string AgentId { get; set; } = "TEST_AGENT";
    public string Line { get; set; } = "";
    public string VisionName { get; set; } = "";
    public string VisionType { get; set; } = "Welding Vision";
    public int PollIntervalMs { get; set; } = 1000;
    public string? StateFile { get; set; }
    public string? LogFile { get; set; }
    public CsvConfig Csv { get; set; } = new();
    public ReceiverConfig Receiver { get; set; } = new();
    public ColumnConfig Columns { get; set; } = new();
    public JudgeRules JudgeRules { get; set; } = new();
    public Dictionary<string, ImageColumnConfig> ImageColumns { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public Options Options { get; set; } = new();
}
public sealed class CsvConfig
{
    public string Folder { get; set; } = ".";
    public string FilePattern { get; set; } = "*.csv";
    public List<string> IgnoreFileNameEndsWith { get; set; } = new() { "_defect.csv" };
    public List<string> IgnoreFileNameContains { get; set; } = new();
    public string Encoding { get; set; } = "utf-8";
    public string Delimiter { get; set; } = ",";
    public bool HasHeader { get; set; } = true;
    public char DelimiterChar() => string.IsNullOrEmpty(Delimiter) ? ',' : Delimiter[0];
}
public sealed class ReceiverConfig
{
    public string EventUrl { get; set; } = "http://127.0.0.1:5000/events";
    public int SummaryIntervalSeconds { get; set; } = 0; // no longer used; kept for backward-compatible personality files
    public int TimeoutSeconds { get; set; } = 3;
}
public sealed class ColumnConfig
{
    public string No { get; set; } = "NO";
    public string ModelId { get; set; } = "MODEL-ID";
    public string LotId { get; set; } = "LOT-ID";
    public string CellId { get; set; } = "CELL-ID";
    public string Judge { get; set; } = "JUDGE";
    public string JudgeDefect { get; set; } = "JUDGE-DEFECT";
}
public sealed class JudgeRules
{
    public string OkJudge { get; set; } = "OK";
    public List<string> DefectJudges { get; set; } = new() { "C-NG", "DLNG", "NG" };
    public string CNgAndDlngColumnFormat { get; set; } = "{SIDE}_{DEFECT}-JUDGE";
    public string NgColumnFormat { get; set; } = "{SIDE}_{DEFECT}-OK/NG";
    public List<string> DefectSideValues { get; set; } = new() { "NG", "BYPASS_NG" };
    public List<string> Sides { get; set; } = new() { "LOWER", "UPPER" };
    public List<string> BacklightDefectsUsePath1 { get; set; } = new();
}
public sealed class ImageColumnConfig
{
    public string Path1Main { get; set; } = "";
    public string Path1Overlay { get; set; } = "";
    public string Path3Main { get; set; } = "";
    public string Path3Overlay { get; set; } = "";
}
public sealed class Options
{
    public bool SendDebugFields { get; set; } = true;
    public bool SendLotChangeEvent { get; set; } = true;
    public bool DryRun { get; set; } = false;
}
public sealed class FileState
{
    public long LastOffset { get; set; }
    public string? LastLotId { get; set; }
    public string? PendingPartialLine { get; set; } = "";
    public List<string>? Header { get; set; }
}
public sealed class AgentState
{
    public Dictionary<string, FileState> Files { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public long TotalReadCount { get; set; }
    public long OkCount { get; set; }
    public long DefectCount { get; set; }
    public long CNgCount { get; set; }
    public long DlngCount { get; set; }
    public long NgCount { get; set; }
    public long UnknownJudgeCount { get; set; }
    public string? CurrentLotId { get; set; }
    public string? CurrentModelId { get; set; }
    public string? LastNo { get; set; }
    public string? LastCellId { get; set; }
    public string? LastCsvFile { get; set; }
    public DateTimeOffset? LastReadTime { get; set; }

    public FileState GetFileState(string file)
    {
        var full = Path.GetFullPath(file);
        if (!Files.TryGetValue(full, out var fs))
        {
            fs = new FileState();
            Files[full] = fs;
        }
        return fs;
    }
    public static AgentState Load(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                return JsonSerializer.Deserialize<AgentState>(File.ReadAllText(path), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? new AgentState();
            }
        }
        catch { }
        return new AgentState();
    }
    public void Save(string path)
    {
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, path, overwrite: true);
    }
}
public sealed class CsvRow
{
    private readonly Dictionary<string, int> _index;
    private readonly List<string> _fields;
    public CsvRow(Dictionary<string, int> index, List<string> fields) { _index = index; _fields = fields; }
    public string Get(string? column)
    {
        if (string.IsNullOrWhiteSpace(column)) return "";
        if (!_index.TryGetValue(column, out var i)) return "";
        return i >= 0 && i < _fields.Count ? _fields[i] : "";
    }
}
public static class Csv
{
    public static List<string> ParseLine(string line, char delimiter)
    {
        var result = new List<string>();
        var sb = new StringBuilder();
        var inQuotes = false;
        for (int i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (c == '"')
            {
                if (inQuotes && i + 1 < line.Length && line[i + 1] == '"')
                {
                    sb.Append('"');
                    i++;
                }
                else inQuotes = !inQuotes;
            }
            else if (c == delimiter && !inQuotes)
            {
                result.Add(sb.ToString());
                sb.Clear();
            }
            else sb.Append(c);
        }
        result.Add(sb.ToString());
        return result;
    }
}
public sealed class Logger
{
    private readonly string _path;
    public Logger(string path) => _path = path;
    public void Info(string msg) => Write("INFO", msg);
    public void Warn(string msg) => Write("WARN", msg);
    public void Error(string msg) => Write("ERROR", msg);
    private void Write(string level, string msg)
    {
        var line = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {msg}";
        Console.WriteLine(line);
        try { File.AppendAllText(_path, line + Environment.NewLine); } catch { }
    }
}
