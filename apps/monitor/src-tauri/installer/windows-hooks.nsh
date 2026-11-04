; Keep the shortcut available for an ordinary per-user installation.
!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$DESKTOP\Raspbaby Monitor.lnk" "$INSTDIR\raspbaby-monitor-app.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$DESKTOP\Raspbaby Monitor.lnk"
!macroend
