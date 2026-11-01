!ifndef CYRENE_INSTALL_VALIDATION_INCLUDED
!define CYRENE_INSTALL_VALIDATION_INCLUDED

!include "LogicLib.nsh"

; 只检查启动所需的两个落盘文件是否可读且非空，不把它当作全包哈希校验。
; 解包器的最后重试分支可能忽略复制错误，不能仅凭解包返回就显示安装成功。
Function CyreneRequireInstalledFile
  Exch $0
  Push $1
  Push $2
  ClearErrors
  FileOpen $1 "$0" r
  IfErrors CyreneInstalledFileInvalid
  FileReadByte $1 $2
  IfErrors CyreneInstalledFileEmpty
  FileClose $1
  Pop $2
  Pop $1
  Pop $0
  Return

CyreneInstalledFileEmpty:
  FileClose $1
CyreneInstalledFileInvalid:
  DetailPrint "Cyrene installation validation failed: $0"
  MessageBox MB_OK|MB_ICONSTOP "Cyrene 安装未完成：关键文件缺失、为空或无法读取。$\r$\n$0$\r$\n请关闭 Cyrene 后重新运行安装器。$\r$\nInstallation is incomplete. Close Cyrene and run the installer again." /SD IDOK
  ; 静默更新同样返回失败，不能继续进入成功页或执行 --force-run。
  SetErrorLevel 2
  Quit
FunctionEnd

!macro CyreneValidateInstallation
  Push "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Call CyreneRequireInstalledFile
  Push "$INSTDIR\resources\app.asar"
  Call CyreneRequireInstalledFile
!macroend

!endif
