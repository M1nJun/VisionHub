# DashboardServer launcher for the central PC.
# Adjust these to match the central PC's actual MySQL setup if it ever changes.
$env:DB_HOST = "127.0.0.1"
$env:DB_PORT = "3306"
$env:DB_USER = "vision_app"
$env:DB_PASSWORD = "1234"
$env:DB_NAME = "vision_dashboard"
$env:SERVER_PORT = "8080"

# Full path instead of relying on `java` being on PATH - avoids needing a
# fresh shell right after installing the JRE for PATH to take effect.
$javaExe = Get-ChildItem "C:\Program Files\Eclipse Adoptium" -Recurse -Filter java.exe -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $javaExe) {
    Write-Error "java.exe not found under C:\Program Files\Eclipse Adoptium - is the JRE installed? See README in this folder."
    exit 1
}

& $javaExe -jar "$PSScriptRoot\dashboard-server-0.0.1-SNAPSHOT.jar"
