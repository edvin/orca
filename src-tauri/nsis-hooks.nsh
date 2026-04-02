; Kill orca-daemon.exe before installing/updating so the binary can be replaced.
; This is needed because the daemon runs as a background process and holds a
; file lock on Windows, preventing the installer from overwriting it.

!macro NSIS_HOOK_PREINSTALL
  ; Kill the main app first (it will try to kill the daemon on exit,
  ; but we do it explicitly here as a safety net)
  nsExec::ExecToLog 'taskkill /f /im Orca.exe'
  nsExec::ExecToLog 'taskkill /f /im orca-daemon.exe'
  nsExec::ExecToLog 'taskkill /f /im orca.exe'
  ; Give processes time to fully exit and release file handles
  Sleep 1000
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Add install directory to user PATH so 'orca' CLI is available from any terminal
  nsExec::ExecToLog 'powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable(\"Path\", [Environment]::GetEnvironmentVariable(\"Path\", \"User\") + \";$INSTDIR\", \"User\")"'
  ; Register orca:// URL scheme
  WriteRegStr HKCU "Software\Classes\orca" "" "URL:Orca Desktop"
  WriteRegStr HKCU "Software\Classes\orca" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\orca\shell\open\command" "" '"$INSTDIR\Orca Desktop.exe" "%1"'
!macroend

; Clean up Orca Desktop data on uninstall (but NOT config — preserve user settings)
!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove orca:// URL scheme registration
  DeleteRegKey HKCU "Software\Classes\orca"
  ; Remove cached/runtime data but keep config (API keys, settings, etc.)
  RMDir /r "$LOCALAPPDATA\orca"
  ; Remove Docker TCP override from WSL (best effort)
  nsExec::ExecToLog 'wsl -u root -- rm -f /etc/systemd/system/docker.service.d/override.conf'
  nsExec::ExecToLog 'wsl -u root -- systemctl daemon-reload'
  ; Remove from user PATH
  nsExec::ExecToLog 'powershell -NoProfile -Command "$p = [Environment]::GetEnvironmentVariable(\"Path\", \"User\"); $p = ($p -split \";\" | Where-Object { $_ -ne \"$INSTDIR\" }) -join \";\"; [Environment]::SetEnvironmentVariable(\"Path\", $p, \"User\")"'
!macroend
