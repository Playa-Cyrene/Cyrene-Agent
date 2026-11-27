!include "nsDialogs.nsh"
!include "${__FILEDIR__}\content-preservation.nsh"

!ifndef BUILD_UNINSTALLER
!include "${__FILEDIR__}\install-validation.nsh"
!include "${__FILEDIR__}\upgrade-preservation.nsh"
!define CYRENE_INSTALLER_DIR "${__FILEDIR__}"

; 标准模板仍由 electron-builder 生成/签名。只在该模板即将 include installUtil
; 时临时切换搜索目录；覆盖文件第一行立即恢复，避免影响后续打包相对路径。
!macro customHeader
  !define CYRENE_NSIS_TEMPLATE_DIR "${__FILEDIR__}"
  !system 'node "${CYRENE_INSTALLER_DIR}\..\..\scripts\verify\nsis-overlay.mjs" "${CYRENE_NSIS_TEMPLATE_DIR}"' = 0
  !cd "${CYRENE_INSTALLER_DIR}\nsis-overrides"
!macroend
Var CyreneDesktopShortcutCheckbox
Var CyreneLaunchAtLoginCheckbox
Var CyreneCreateDesktopShortcut
Var CyreneLaunchAtLogin
Var CyreneOptionsSubmitted

!macro customPageAfterChangeDir
  Page custom CyreneOptionsPageCreate CyreneOptionsPageLeave
!macroend

Function CyreneOptionsPageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "安装选项"
  Pop $0

  ${NSD_CreateCheckbox} 0 34u 100% 12u "创建桌面快捷方式"
  Pop $CyreneDesktopShortcutCheckbox
  ${NSD_Check} $CyreneDesktopShortcutCheckbox

  ${NSD_CreateCheckbox} 0 56u 100% 12u "开机时自动启动 Cyrene"
  Pop $CyreneLaunchAtLoginCheckbox
  ${NSD_Uncheck} $CyreneLaunchAtLoginCheckbox

  nsDialogs::Show
FunctionEnd

Function CyreneOptionsPageLeave
  ${NSD_GetState} $CyreneDesktopShortcutCheckbox $CyreneCreateDesktopShortcut
  ${NSD_GetState} $CyreneLaunchAtLoginCheckbox $CyreneLaunchAtLogin
  StrCpy $CyreneOptionsSubmitted "1"
FunctionEnd

; 静默升级没有用户选择，不得用未初始化的复选框覆盖已有登录启动设置。
; 参数化输出目录，供独立 NSIS 夹具验证，生产仍写入应用的 APPDATA 目录。
!macro CyreneSaveLaunchAtLoginSelection OPTIONS_DIR
  ${IfNot} ${Silent}
  ${AndIf} $CyreneOptionsSubmitted == "1"
    CreateDirectory "${OPTIONS_DIR}"
    FileOpen $0 "${OPTIONS_DIR}\installer-options.json" w
    ${If} $CyreneLaunchAtLogin == ${BST_CHECKED}
      FileWrite $0 "{$\"launchAtLogin$\":true}"
    ${Else}
      FileWrite $0 "{$\"launchAtLogin$\":false}"
    ${EndIf}
    FileClose $0
  ${EndIf}
!macroend

; 初始化/向导取消均不移动用户文件；静默与交互升级统一在旧卸载器调用前保护。
!macro customInit
  ; 上游 .onInit 把工作目录设为 $INSTDIR。必须在 UAC 外层等待前释放目录句柄，
  ; 否则旧卸载器删完文件仍无法删除空目录，会在模型恢复前退出。
  SetOutPath "$TEMP"
!macroend

; electron-builder 默认忽略启动旧卸载器失败。保护后必须停止，不能继续覆盖旧程序。
!macro CyreneCheckOldUninstallResult
  ${If} ${Errors}
    !insertmacro CyreneContentFailure "无法启动旧卸载器：$CyreneOldDir"
  ${EndIf}
  ${If} $R0 != 0
    !insertmacro CyreneContentFailure "旧卸载器失败（$R0）：$CyreneOldDir"
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro CyreneCheckOldUninstallResult
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro CyreneCheckOldUninstallResult
!macroend

!macro customInstall
  ; 恢复升级保护暂存的 models（新版安装器不写 models 目录，原样搬回即可）
  !insertmacro CyreneRestoreModels

  ; 先恢复已暂存的 models，再检查新程序，失败时不丢弃用户内容或误报成功。
  !insertmacro CyreneValidateInstallation

  ${If} $CyreneCreateDesktopShortcut == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}

  CreateShortCut "$SMPROGRAMS\${MENU_FILENAME}\卸载 ${PRODUCT_FILENAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0

  !insertmacro CyreneSaveLaunchAtLoginSelection "$APPDATA\${APP_PACKAGE_NAME}"
!macroend
!endif

!macro customUnInstall
  Delete "$SMPROGRAMS\${MENU_FILENAME}\卸载 ${PRODUCT_FILENAME}.lnk"
!macroend

; 卸载器侧升级保护：本卸载器被新版安装器以 --updated 调起（而非用户主动卸载）时，
; 默认的 RMDir /r 会连 models/skills/prompts 一起清掉。这里先把用户内容挪到同级暂存目录：
; models 清完目录后原样搬回；prompts/skills 留在暂存目录，等应用启动时合并进 userData。
; 用户主动卸载（无 --updated）时行为不变：整个安装目录干净移除。
!macro customRemoveFiles
  SetOutPath "$TEMP"
  ${If} ${isUpdated}
    !insertmacro CyrenePreserveContent
    ClearErrors
    RMDir /r "$INSTDIR"
    ${If} ${Errors}
      !insertmacro CyreneContentFailure "$INSTDIR"
    ${EndIf}
    !insertmacro CyreneRestoreModels
  ${Else}
    RMDir /r "$INSTDIR"
  ${EndIf}
!macroend
