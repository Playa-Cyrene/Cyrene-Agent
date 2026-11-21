!ifndef CYRENE_CONTENT_PRESERVATION_INCLUDED
!define CYRENE_CONTENT_PRESERVATION_INCLUDED

!include "LogicLib.nsh"
Var CyreneStagingHandle
Var CyreneStagingEntry
Var CyreneStagingAttributes

; 安装器和卸载器共用失败出口：保留原目录/暂存文件，禁止继续清理或报告成功。
!macro CyreneContentFailure CONTENT_PATH
  DetailPrint "Cyrene content preservation failed: ${CONTENT_PATH}"
  MessageBox MB_OK|MB_ICONSTOP "Cyrene 升级已停止，用户内容未能安全迁移。$\r$\n${CONTENT_PATH}$\r$\n请保留安装目录及同级 .Cyrene.*-preserve 暂存目录，关闭占用程序并检查残留备份后重试。" /SD IDOK
  SetErrorLevel 2
  Quit
!macroend

!macro CyreneCheckStaging SOURCE DESTINATION
  ${If} ${FileExists} "${SOURCE}"
  ${AndIf} ${FileExists} "${DESTINATION}"
    !insertmacro CyreneContentFailure "${DESTINATION}"
  ${EndIf}
!macroend

!macro CyreneMoveContent SOURCE DESTINATION
  ${If} ${FileExists} "${SOURCE}"
    ClearErrors
    Rename "${SOURCE}" "${DESTINATION}"
    ${If} ${Errors}
      !insertmacro CyreneContentFailure "${SOURCE} -> ${DESTINATION}"
    ${EndIf}
  ${EndIf}
!macroend

; 首启迁移会消费整个暂存根，因此不能混入未知旧文件或把普通文件当作暂存目录。
!macro CyreneCheckContentStaging STAGING_DIR
  ${If} ${FileExists} "${STAGING_DIR}"
    Push $0
    System::Call 'kernel32::GetFileAttributesW(w "${STAGING_DIR}") i.r0'
    IntOp $CyreneStagingAttributes $0 & 0x10
    Pop $0
    ${If} $CyreneStagingAttributes == 0
      !insertmacro CyreneContentFailure "${STAGING_DIR}"
    ${EndIf}
    ClearErrors
    FindFirst $CyreneStagingHandle $CyreneStagingEntry "${STAGING_DIR}\*"
    ${IfNot} ${Errors}
      ${DoWhile} $CyreneStagingEntry != ""
        ${If} $CyreneStagingEntry != "."
        ${AndIf} $CyreneStagingEntry != ".."
        ${AndIf} $CyreneStagingEntry != "prompts"
        ${AndIf} $CyreneStagingEntry != "skills"
          FindClose $CyreneStagingHandle
          !insertmacro CyreneContentFailure "未知暂存文件：${STAGING_DIR}\$CyreneStagingEntry"
        ${EndIf}
        FindNext $CyreneStagingHandle $CyreneStagingEntry
      ${Loop}
      FindClose $CyreneStagingHandle
    ${Else}
      !insertmacro CyreneContentFailure "无法读取暂存目录：${STAGING_DIR}"
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro CyrenePreserveContent
  !insertmacro CyreneCheckContentStaging "$INSTDIR\..\.Cyrene.content-preserve"
  ; 先检查全部冲突，不能移动到一半才发现上次升级留下的同名备份。
  !insertmacro CyreneCheckStaging "$INSTDIR\prompts" "$INSTDIR\..\.Cyrene.content-preserve\prompts"
  !insertmacro CyreneCheckStaging "$INSTDIR\skills" "$INSTDIR\..\.Cyrene.content-preserve\skills"
  !insertmacro CyreneCheckStaging "$INSTDIR\models" "$INSTDIR\..\.Cyrene.models-preserve"
  ClearErrors
  CreateDirectory "$INSTDIR\..\.Cyrene.content-preserve"
  ${If} ${Errors}
    !insertmacro CyreneContentFailure "$INSTDIR\..\.Cyrene.content-preserve"
  ${EndIf}
  ; 非冲突的 I/O 错误也必须停止。此前已移动的文件留在暂存目录，不能删除它们。
  !insertmacro CyreneMoveContent "$INSTDIR\prompts" "$INSTDIR\..\.Cyrene.content-preserve\prompts"
  !insertmacro CyreneMoveContent "$INSTDIR\skills" "$INSTDIR\..\.Cyrene.content-preserve\skills"
  !insertmacro CyreneMoveContent "$INSTDIR\models" "$INSTDIR\..\.Cyrene.models-preserve"
!macroend

!macro CyreneRestoreModels
  ${If} ${FileExists} "$INSTDIR\..\.Cyrene.models-preserve"
    !insertmacro CyreneCheckStaging "$INSTDIR\..\.Cyrene.models-preserve" "$INSTDIR\models"
    ClearErrors
    CreateDirectory "$INSTDIR"
    ${If} ${Errors}
      !insertmacro CyreneContentFailure "$INSTDIR"
    ${EndIf}
    !insertmacro CyreneMoveContent "$INSTDIR\..\.Cyrene.models-preserve" "$INSTDIR\models"
  ${EndIf}
!macroend

!endif
