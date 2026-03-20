; Kill orca-daemon.exe before installing/updating so the binary can be replaced.
; This is needed because the daemon runs as a background process and holds a
; file lock on Windows, preventing the installer from overwriting it.

!macro NSIS_HOOK_PREINSTALL
  ; Kill the main app first (it will try to kill the daemon on exit,
  ; but we do it explicitly here as a safety net)
  nsExec::ExecToLog 'taskkill /f /im Orca.exe'
  nsExec::ExecToLog 'taskkill /f /im orca-daemon.exe'
  ; Give processes time to fully exit and release file handles
  Sleep 1000
!macroend

; Clean up Orca Desktop config and data on uninstall
!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove Orca config directory
  RMDir /r "$APPDATA\orca"
  RMDir /r "$LOCALAPPDATA\orca"
  ; Remove Docker TCP override from WSL (best effort)
  nsExec::ExecToLog 'wsl -u root -- rm -f /etc/systemd/system/docker.service.d/override.conf'
  nsExec::ExecToLog 'wsl -u root -- systemctl daemon-reload'
!macroend
