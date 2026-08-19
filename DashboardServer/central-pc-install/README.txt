DashboardServer - central PC install package
==============================================

Contents:
  OpenJDK21U-jre_x64_windows_hotspot_21.0.12_8.msi   Java runtime (one-time install)
  dashboard-server-0.0.1-SNAPSHOT.jar                The app itself (React frontend is baked in)
  run-dashboard-server.ps1                           Launcher (sets DB connection env vars, then runs it)

Steps:
  1. Install the JRE:
       msiexec /i OpenJDK21U-jre_x64_windows_hotspot_21.0.12_8.msi /quiet /norestart
     (or just double-click it and click through the wizard)

  2. Open a NEW PowerShell window (so PATH picks up the JRE), and check:
       java -version
     Should print something like "openjdk version 21.0.12".

  3. Open the firewall for the dashboard port (matches run-dashboard-server.ps1's SERVER_PORT, 8080 by default):
       New-NetFirewallRule -DisplayName "VisionDashboard Web" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow

  4. Run it:
       .\run-dashboard-server.ps1
     Leave this window open - closing it stops the server (same as CentralTestReceiver / SmbImageFetcher).

  5. Verify:
       - In this same PC's browser: http://127.0.0.1:8080/dashboard
       - From another PC on the LAN: http://<this PC's IP>:8080/dashboard

If DB connection settings ever change (port, password, etc), edit the env vars at the top of
run-dashboard-server.ps1 to match.
