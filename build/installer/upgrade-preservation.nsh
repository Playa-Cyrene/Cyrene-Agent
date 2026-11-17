!ifndef CYRENE_UPGRADE_PRESERVATION_INCLUDED
!define CYRENE_UPGRADE_PRESERVATION_INCLUDED
!include "FileFunc.nsh"

Var CyreneOldDir
Var CyreneTargetDir
Var CyreneOtherDir
Var CyreneOtherUninstallString
Var CyreneOtherUninstaller
Var CyrenePathCheck
Var CyrenePathParent
Var CyrenePathAttributes
Var CyreneCompareLength
Var CyreneComparePath
Var CyreneOldRoot
Var CyreneTargetRoot
Var CyreneOldUninstallProtected
Var CyreneFullPathValue
Var CyreneFullPathLength

; NSIS 的 GetFullPathName 会查询磁盘，父目录尚不存在时可能置 Errors。
; Win32 API 只规范化字符串；检查返回值及缓冲区长度，不能把截断/失败当作有效路径。
!macro CyreneFullPath SOURCE OUTPUT
  ${If} "${SOURCE}" == ""
    !insertmacro CyreneContentFailure "无法确定空路径"
  ${EndIf}
  Push $0
  Push $1
  System::Call 'kernel32::GetFullPathNameW(w "${SOURCE}", i ${NSIS_MAX_STRLEN}, w .r0, p 0) i.r1'
  StrCpy $CyreneFullPathValue $0
  StrCpy $CyreneFullPathLength $1
  Pop $1
  Pop $0
  ${If} $CyreneFullPathLength <= 0
  ${OrIf} $CyreneFullPathLength >= ${NSIS_MAX_STRLEN}
    !insertmacro CyreneContentFailure "无法规范化路径或路径过长：${SOURCE}"
  ${EndIf}
  StrCpy ${OUTPUT} $CyreneFullPathValue
!macroend

!macro CyreneCanonicalInstallDir SOURCE OUTPUT ROOT
  !insertmacro CyreneFullPath "${SOURCE}" ${OUTPUT}
  ${GetRoot} "${OUTPUT}" ${ROOT}
  ${If} ${OUTPUT} == ${ROOT}
  ${OrIf} ${OUTPUT} == "${ROOT}\"
    !insertmacro CyreneContentFailure "不能把磁盘或共享根目录作为安装目录：${OUTPUT}"
  ${EndIf}
  ; GetFullPathName 可保留用户输入的尾斜杠，比较前去掉，避免嵌套前缀变成双斜杠。
  ${Do}
    StrCpy $CyreneComparePath "${OUTPUT}" 1 -1
    ${If} $CyreneComparePath != "\"
      ${ExitDo}
    ${EndIf}
    StrCpy ${OUTPUT} "${OUTPUT}" -1
  ${Loop}
!macroend

; 拒绝路径自身或任何已存在的祖先是重解析点，避免文本路径检查被 junction 绕过。
!macro CyreneRequirePlainPath CONTENT_PATH
  !insertmacro CyreneFullPath "${CONTENT_PATH}" $CyrenePathCheck
  ${Do}
    Push $0
    System::Call 'kernel32::GetFileAttributesW(w "$CyrenePathCheck") i.r0'
    StrCpy $CyrenePathAttributes $0
    Pop $0
    ${If} $CyrenePathAttributes != -1
      IntOp $CyrenePathAttributes $CyrenePathAttributes & 0x400
      ${If} $CyrenePathAttributes != 0
        !insertmacro CyreneContentFailure "重解析路径：${CONTENT_PATH}"
      ${EndIf}
    ${EndIf}
    ${GetParent} "$CyrenePathCheck" $CyrenePathParent
    ${If} $CyrenePathParent == ""
    ${OrIf} $CyrenePathParent == $CyrenePathCheck
      ${ExitDo}
    ${EndIf}
    StrCpy $CyrenePathCheck $CyrenePathParent
  ${Loop}
!macroend

!macro CyreneReadOtherInstallation
  !insertmacro readReg $CyreneOtherUninstallString "HKEY_CURRENT_USER" "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $CyreneOtherUninstallString == ""
    !ifdef UNINSTALL_REGISTRY_KEY_2
      !insertmacro readReg $CyreneOtherUninstallString "HKEY_CURRENT_USER" "${UNINSTALL_REGISTRY_KEY_2}" UninstallString
    !endif
  ${EndIf}
  !insertmacro readReg $CyreneOtherDir "HKEY_CURRENT_USER" "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $CyreneOtherDir == ""
  ${AndIf} $CyreneOtherUninstallString != ""
      !insertmacro GetInQuotes $CyreneOtherUninstaller "$CyreneOtherUninstallString"
      ${If} $CyreneOtherUninstaller != ""
        Push $CyreneOtherUninstaller
        Call GetFileParent
        Pop $CyreneOtherDir
      ${EndIf}
  ${EndIf}
!macroend

; 上游找不到有效卸载信息时会直接返回；已有安装/目标内容不能因此绕过保护。
!macro CyreneCheckMissingUninstaller
  !insertmacro CyreneCanonicalInstallDir "$INSTDIR" $CyreneTargetDir $CyreneTargetRoot
  !insertmacro CyreneRequirePlainPath "$CyreneTargetDir"
  !insertmacro CyreneRequirePlainPath "$CyreneTargetDir\..\.Cyrene.content-preserve"
  !insertmacro CyreneRequirePlainPath "$CyreneTargetDir\..\.Cyrene.models-preserve"
  !insertmacro CyreneCheckContentStaging "$CyreneTargetDir\..\.Cyrene.content-preserve"
  !insertmacro readReg $CyreneOtherDir "$rootKey" "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $CyreneOtherDir != ""
    !insertmacro CyreneContentFailure "旧卸载信息缺失或无效，无法安全覆盖现有安装：$CyreneOtherDir；$INSTDIR"
  ${EndIf}
  ; all 模式的第二次 HKCU 查询可能没有旧安装；此时第一次卸载已安全恢复 models。
  ; 仅本次流程真实保护成功后允许这些目标内容，不能把普通陈旧注册误认成已迁移。
  ${If} $CyreneOldUninstallProtected != "1"
    ${If} ${FileExists} "$INSTDIR\prompts"
    ${OrIf} ${FileExists} "$INSTDIR\skills"
    ${OrIf} ${FileExists} "$INSTDIR\models"
      !insertmacro CyreneContentFailure "没有有效旧卸载信息，目标已有用户内容：$INSTDIR"
    ${EndIf}
  ${EndIf}
!macroend

; 仅由锁定版本的 installUtil.nsh 调用：此时范围、旧目录和向导最终目标均已确定，
; CHECK_APP_RUNNING 已完成，尚未复制或执行任何旧卸载器。不要移回 .onInit/页面离开钩子。
!macro CyreneBeforeOldUninstall
  ; 外层初始化已释放目录；内层实际调用旧卸载器前再次释放。
  SetOutPath "$TEMP"
  !insertmacro CyreneCanonicalInstallDir "$installationDir" $CyreneOldDir $CyreneOldRoot
  !insertmacro CyreneCanonicalInstallDir "$INSTDIR" $CyreneTargetDir $CyreneTargetRoot

  ; all-users 安装随后还会卸载 HKCU。必须在第一次卸载前排除多目录歧义，
  ; 包括第二个目录为目标祖先但没有 prompts/skills/models 的情况。
  ${If} $installMode == "all"
  ${AndIf} $rootKey == "SHELL_CONTEXT"
    !insertmacro CyreneReadOtherInstallation
    ${If} $CyreneOtherDir != ""
    ${OrIf} $CyreneOtherUninstallString != ""
      !insertmacro CyreneContentFailure "检测到两个安装范围的旧安装：$CyreneOldDir；$CyreneOtherDir。请先分别处理旧安装。"
    ${EndIf}
  ${EndIf}

  !insertmacro CyreneRequirePlainPath "$CyreneOldDir"
  !insertmacro CyreneRequirePlainPath "$CyreneTargetDir"
  !insertmacro CyreneRequirePlainPath "$CyreneOldDir\prompts"
  !insertmacro CyreneRequirePlainPath "$CyreneOldDir\skills"
  !insertmacro CyreneRequirePlainPath "$CyreneOldDir\models"
  !insertmacro CyreneRequirePlainPath "$CyreneTargetDir\..\.Cyrene.content-preserve"
  !insertmacro CyreneRequirePlainPath "$CyreneTargetDir\..\.Cyrene.models-preserve"
  !insertmacro CyreneCheckContentStaging "$CyreneOldDir\..\.Cyrene.content-preserve"
  !insertmacro CyreneCheckContentStaging "$CyreneTargetDir\..\.Cyrene.content-preserve"

  ${If} $CyreneOldDir == $CyreneTargetDir
    Push $INSTDIR
    StrCpy $INSTDIR $CyreneOldDir
    !insertmacro CyrenePreserveContent
    Pop $INSTDIR
  ${Else}
    ${GetRoot} "$CyreneOldDir" $CyreneOldRoot
    ${GetRoot} "$CyreneTargetDir" $CyreneTargetRoot
    ${If} $CyreneOldRoot != $CyreneTargetRoot
      !insertmacro CyreneContentFailure "跨磁盘迁移需先保留旧安装：$CyreneOldDir -> $CyreneTargetDir"
    ${EndIf}
    StrCpy $CyreneComparePath "$CyreneOldDir\"
    StrLen $CyreneCompareLength $CyreneComparePath
    StrCpy $CyreneComparePath "$CyreneTargetDir\" $CyreneCompareLength
    ${If} $CyreneComparePath == "$CyreneOldDir\"
      !insertmacro CyreneContentFailure "新目录位于旧安装内：$CyreneTargetDir"
    ${EndIf}
    StrCpy $CyreneComparePath "$CyreneTargetDir\"
    StrLen $CyreneCompareLength $CyreneComparePath
    StrCpy $CyreneComparePath "$CyreneOldDir\" $CyreneCompareLength
    ${If} $CyreneComparePath == "$CyreneTargetDir\"
      !insertmacro CyreneContentFailure "旧目录位于新安装内：$CyreneOldDir"
    ${EndIf}

    ; 新目录或任一旧/新暂存中已有内容时，不猜测合并顺序，不启动旧卸载器。
    ${If} ${FileExists} "$CyreneTargetDir\prompts"
    ${OrIf} ${FileExists} "$CyreneTargetDir\skills"
    ${OrIf} ${FileExists} "$CyreneTargetDir\models"
    ${OrIf} ${FileExists} "$CyreneOldDir\..\.Cyrene.content-preserve\prompts"
    ${OrIf} ${FileExists} "$CyreneOldDir\..\.Cyrene.content-preserve\skills"
    ${OrIf} ${FileExists} "$CyreneOldDir\..\.Cyrene.models-preserve"
    ${OrIf} ${FileExists} "$CyreneTargetDir\..\.Cyrene.content-preserve\prompts"
    ${OrIf} ${FileExists} "$CyreneTargetDir\..\.Cyrene.content-preserve\skills"
    ${OrIf} ${FileExists} "$CyreneTargetDir\..\.Cyrene.models-preserve"
      !insertmacro CyreneContentFailure "更改目录时发现已有用户内容或暂存：$CyreneTargetDir"
    ${EndIf}
    ClearErrors
    CreateDirectory "$CyreneTargetDir\..\.Cyrene.content-preserve"
    CreateDirectory "$CyreneTargetDir"
    ${If} ${Errors}
      !insertmacro CyreneContentFailure "$CyreneTargetDir"
    ${EndIf}
    !insertmacro CyreneMoveContent "$CyreneOldDir\prompts" "$CyreneTargetDir\..\.Cyrene.content-preserve\prompts"
    !insertmacro CyreneMoveContent "$CyreneOldDir\skills" "$CyreneTargetDir\..\.Cyrene.content-preserve\skills"
    ; 直接放入最终 models，防止同一父目录下的旧卸载器把公共暂存又还原到旧目录。
    !insertmacro CyreneMoveContent "$CyreneOldDir\models" "$CyreneTargetDir\models"
  ${EndIf}
  StrCpy $CyreneOldUninstallProtected "1"
  ClearErrors
!macroend
!endif
