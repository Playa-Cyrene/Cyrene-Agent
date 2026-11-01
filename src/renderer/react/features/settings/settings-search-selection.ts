import { useEffect, useState } from "react";
import type { SettingsSection } from "./AppearanceSettingsPage";
import type { SettingsSearchItem } from "./settings-search-index";

export function useSettingsSearchSelection(section: SettingsSection) {
  const [searchTarget, setSearchTarget] = useState<SettingsSearchItem>();
  const [noticeSection, setNoticeSection] = useState<SettingsSection>();
  // section 也可能由 IPC 改变，不能只依赖侧栏点击回调清理。
  useEffect(() => {
    if (searchTarget && section !== searchTarget.section) setSearchTarget(undefined);
    if (noticeSection && section !== noticeSection) setNoticeSection(undefined);
  }, [section, searchTarget, noticeSection]);
  return {
    searchTarget: searchTarget?.section === section ? searchTarget : undefined,
    setSearchTarget,
    searchNotice: noticeSection === section,
    setSearchNotice: (value: boolean) => setNoticeSection(value ? section : undefined),
  };
}
