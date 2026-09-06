; A temporary extraction launcher: no installer, registry entries or elevation.
Unicode true
Name "PSForge"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
!ifdef FAST_BUILD
  SetCompress off
!else
  SetCompressor /SOLID lzma
!endif
!include "FileFunc.nsh"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=PSForge.exe "${APP_BINARY}"
  File "${RUNTIME_DIR}\vcruntime140*.dll"
  File "${RUNTIME_DIR}\msvcp140*.dll"
  SetOutPath "$PLUGINSDIR\runtime"
  File /r "${RUNTIME_DIR}\*"
  ; Fixed WebView2 uses AppContainer on Windows 10; grant read/execute only.
  nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$PLUGINSDIR\runtime" /grant *S-1-15-2-1:(OI)(CI)(RX) *S-1-15-2-2:(OI)(CI)(RX) /T'
  Pop $0
  Pop $1
  StrCmp $0 "0" runtime_ready
    MessageBox MB_OK|MB_ICONSTOP "PSForge could not prepare its browser runtime."
    SetErrorLevel 1
    Quit
  runtime_ready:
  System::Call 'kernel32::SetEnvironmentVariable(t "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", t "$PLUGINSDIR\runtime") i.r0'
  StrCmp $0 "0" environment_failed
  ${GetParameters} $1
  SetOutPath "$EXEDIR"
  ExecWait '"$PLUGINSDIR\PSForge.exe" $1' $0
  IfErrors launch_failed
  SetErrorLevel $0
  Goto finished
  environment_failed:
  launch_failed:
    MessageBox MB_OK|MB_ICONSTOP "PSForge could not start."
    SetErrorLevel 1
  finished:
SectionEnd
