; Added to the Windows installer by desktop/build.mjs. Uninstalling, but not updating, removes
; the "open at login" entry the app writes, which Electron names after the app's id.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.aicooldown.app"
  ${endIf}
!macroend
