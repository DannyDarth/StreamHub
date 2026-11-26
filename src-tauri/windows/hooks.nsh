; Run by StreamHub's installer (Tauri NSIS hooks).

!macro NSIS_HOOK_POSTINSTALL
  ; Windows caches app icons: after an update the exe and the desktop shortcut can keep showing the
  ; old icon. Tell Explorer that icons changed and refresh its icon cache.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend
