; This replaces electron-builder's process-closing macro for both install and uninstall.
; No process-close or process-termination command is permitted here.
LangString billboardSaveAndClose 2052 "BillBoard 仍在运行。请保存内容、正常退出应用，再重新运行安装或卸载程序。本次操作已取消。"
LangString billboardSaveAndClose 1033 "BillBoard is still running. Save your work, exit the app normally, then run setup or uninstall again. This operation was cancelled."
LangString billboardProcessCheckFailed 2052 "无法确认 BillBoard 已退出。本次操作已取消，请正常退出应用后重试。"
LangString billboardProcessCheckFailed 1033 "Setup could not confirm that BillBoard has exited. This operation was cancelled. Exit the app normally and retry."

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  ${If} $installMode != "CurrentUser"
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customUnInit
  ${If} $installMode != "CurrentUser"
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customCheckAppRunning
  StrCpy $R8 0
  billboard_wait_for_normal_exit:
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R9
    ${If} $R9 == 603
      Goto billboard_process_exited
    ${ElseIf} $R9 != 0
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(billboardProcessCheckFailed)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${If} $R8 >= 30
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(billboardSaveAndClose)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    Sleep 500
    IntOp $R8 $R8 + 1
    Goto billboard_wait_for_normal_exit
  billboard_process_exited:
!macroend
