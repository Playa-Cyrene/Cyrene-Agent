!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER
!include "${__FILEDIR__}\install-validation.nsh"
Var CyreneDesktopShortcutCheckbox
Var CyreneLaunchAtLoginCheckbox
Var CyreneCreateDesktopShortcut
Var CyreneLaunchAtLogin

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
FunctionEnd

; 升级保护：升级会先跑旧版卸载器，其 RMDir /r 会清空整个安装目录（models/skills/prompts
; 连同用户放进去的文件）。这里在 .onInit（multiUser 已从注册表恢复 $INSTDIR 为旧安装目录）
; 阶段把用户内容挪到同级暂存目录，等新版装完后再恢复/合并。
; 仅静默安装（应用内更新/定制安装器/独立升级器）时启用：向导模式用户在场，取消安装不留烂摊子。
!macro customInit
  ${If} ${Silent}
    CreateDirectory "$INSTDIR\..\.Cyrene.content-preserve"
    ClearErrors
    ${If} ${FileExists} "$INSTDIR\prompts"
      Rename "$INSTDIR\prompts" "$INSTDIR\..\.Cyrene.content-preserve\prompts"
    ${EndIf}
    ClearErrors
    ${If} ${FileExists} "$INSTDIR\skills"
      Rename "$INSTDIR\skills" "$INSTDIR\..\.Cyrene.content-preserve\skills"
    ${EndIf}
    ClearErrors
    ${If} ${FileExists} "$INSTDIR\models"
      Rename "$INSTDIR\models" "$INSTDIR\..\.Cyrene.models-preserve"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ; 恢复 customInit 暂存的 models（新版安装器不写 models 目录，原样搬回即可）
  ClearErrors
  ${If} ${FileExists} "$INSTDIR\..\.Cyrene.models-preserve"
    CreateDirectory "$INSTDIR"
    Rename "$INSTDIR\..\.Cyrene.models-preserve" "$INSTDIR\models"
  ${EndIf}

  ; 先恢复已暂存的 models，再检查新程序，失败时不丢弃用户内容或误报成功。
  !insertmacro CyreneValidateInstallation

  ${If} $CyreneCreateDesktopShortcut == ${BST_CHECKED}
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  ${EndIf}

  CreateShortCut "$SMPROGRAMS\${MENU_FILENAME}\卸载 ${PRODUCT_FILENAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0

  ${If} $CyreneLaunchAtLogin == ${BST_CHECKED}
    CreateDirectory "$APPDATA\${APP_PACKAGE_NAME}"
    FileOpen $0 "$APPDATA\${APP_PACKAGE_NAME}\installer-options.json" w
    FileWrite $0 "{$\"launchAtLogin$\":true}"
    FileClose $0
  ${Else}
    CreateDirectory "$APPDATA\${APP_PACKAGE_NAME}"
    FileOpen $0 "$APPDATA\${APP_PACKAGE_NAME}\installer-options.json" w
    FileWrite $0 "{$\"launchAtLogin$\":false}"
    FileClose $0
  ${EndIf}
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
    CreateDirectory "$INSTDIR\..\.Cyrene.content-preserve"
    ClearErrors
    ${If} ${FileExists} "$INSTDIR\prompts"
      Rename "$INSTDIR\prompts" "$INSTDIR\..\.Cyrene.content-preserve\prompts"
    ${EndIf}
    ClearErrors
    ${If} ${FileExists} "$INSTDIR\skills"
      Rename "$INSTDIR\skills" "$INSTDIR\..\.Cyrene.content-preserve\skills"
    ${EndIf}
    ClearErrors
    ${If} ${FileExists} "$INSTDIR\models"
      Rename "$INSTDIR\models" "$INSTDIR\..\.Cyrene.models-preserve"
    ${EndIf}
    RMDir /r "$INSTDIR"
    ${If} ${FileExists} "$INSTDIR\..\.Cyrene.models-preserve"
      CreateDirectory "$INSTDIR"
      Rename "$INSTDIR\..\.Cyrene.models-preserve" "$INSTDIR\models"
    ${EndIf}
  ${Else}
    RMDir /r "$INSTDIR"
  ${EndIf}
!macroend
