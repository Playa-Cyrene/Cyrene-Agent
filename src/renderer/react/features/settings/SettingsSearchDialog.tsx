import { Input, Modal, type InputRef } from "antd";
import { ArrowLeft, Bot, FileText, Search, Settings2, Smartphone, Trash2, Volume2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "../../i18n";
import { searchSettings, type SettingsSearchCategory, type SettingsSearchItem } from "./settings-search-index";
import { readSearchHistory, rememberSearch, writeSearchHistory } from "./settings-search-history";
import { SettingsSearchResults, type SearchTransitionDirection } from "./SettingsSearchResults";
import { isSettingsSearchAvailable, useSettingsSearchAvailability } from "./settings-search-availability";
import "./SettingsSearchDialog.css";

const categories = [
  { id: "basic", key: "settingsPage.basicSettings", icon: Settings2 },
  { id: "agent", key: "settingsPage.agentAbilities", icon: Bot },
  { id: "channels", key: "settingsPage.externalChannels", icon: Smartphone },
  { id: "voice", key: "settingsPage.voiceAbilities", icon: Volume2 },
  { id: "about", key: "settingsPage.usageNotice", icon: FileText },
] as const;

interface SettingsSearchDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (item: SettingsSearchItem) => void;
}

export function SettingsSearchDialog({ open, onClose, onSelect }: SettingsSearchDialogProps) {
  const { t, locale } = useTranslation();
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState<SearchTransitionDirection>("forward");
  const [category, setCategory] = useState<SettingsSearchCategory>();
  const [browseSection, setBrowseSection] = useState<SettingsSearchItem>();
  const [history, setHistory] = useState(readSearchHistory);
  const [managing, setManaging] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [active, setActive] = useState(0);
  const [visibleHistory, setVisibleHistory] = useState(30);
  const historyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<InputRef>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const availability = useSettingsSearchAvailability(open);
  const browsing = !!category && !query.trim();
  const matches = query.trim() || category ? searchSettings(query, t, category).filter((item) => isSettingsSearchAvailable(item.id, availability)) : [];
  const scoped = browseSection ? matches.filter((item) => item.section === browseSection.section) : matches;
  const results = browsing
    ? scoped.filter((item) => browseSection ? !item.id.startsWith("section:") : item.id.startsWith("section:"))
    : scoped;
  const path = [t("settingsSearch.title"), ...(category ? [t(categories.find((item) => item.id === category)!.key)] : []),
    ...(browseSection ? [t(browseSection.titleKey)] : [])].join("\\");
  const viewKey = JSON.stringify([open, locale, category, browseSection?.id, query.trim(), results.map((item) => item.id)]);

  useEffect(() => { setActive(0); }, [viewKey]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDirection("forward");
    setCategory(undefined);
    setBrowseSection(undefined);
    setManaging(false);
    setConfirmClear(false);
    setHistory(readSearchHistory());
  }, [open]);

  // 历史词条长度不一，按实际换行位置限制三行；隐藏项保留布局，方便缩放或删除后重新测量。
  useLayoutEffect(() => {
    const container = historyRef.current;
    if (!container || !open) return;
    function measure() {
      const rows: number[] = [];
      let count = 0;
      for (const child of Array.from(container!.children)) {
        const top = (child as HTMLElement).offsetTop;
        if (!rows.includes(top)) rows.push(top);
        if (rows.length > 3) break;
        count++;
      }
      setVisibleHistory(count);
    }
    measure();
    // 关闭弹窗、依赖变化或卸载时，由 effect 的清理函数停止观察。
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [open, history, managing]);

  function updateHistory(next: string[]) {
    setHistory(next);
    writeSearchHistory(next);
  }
  function remember(value: string) {
    updateHistory(rememberSearch(history, value));
  }
  function select(item: SettingsSearchItem) {
    if (query.trim()) remember(query);
    onSelect(item);
    onClose();
  }
  function chooseCategory(next?: SettingsSearchCategory) {
    setDirection("forward");
    setActive(0);
    setCategory(next);
    setBrowseSection(undefined);
    inputRef.current?.focus({ preventScroll: true });
  }
  function activate(item: SettingsSearchItem) {
    if (browsing && item.id.startsWith("section:") && matches.some((child) => child.section === item.section && child.id !== item.id)) {
      setDirection("forward");
      setActive(0);
      setBrowseSection(item);
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    select(item);
  }
  function goBack() {
    setDirection("back");
    setActive(0);
    if (browseSection) setBrowseSection(undefined);
    else setCategory(undefined);
    inputRef.current?.focus({ preventScroll: true });
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.nativeEvent.isComposing || (!query.trim() && !category)) return;
    const target = event.target as HTMLElement;
    if (!target.closest('input[role="combobox"], [data-result-index]')) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      inputRef.current?.focus({ preventScroll: true });
      setActive((current) => results.length ? (current + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length : 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (results[active]) activate(results[active]);
      else if (query.trim()) remember(query);
    }
  }

  return <>
    <Modal className="cy-settings-search-modal" open={open} centered width={600} title={t("settingsSearch.title")} footer={null} onCancel={onClose} destroyOnHidden>
      <div className="cy-settings-search" onKeyDown={onKeyDown}>
        <Input ref={inputRef} autoFocus allowClear prefix={<Search size={16} />} placeholder={t("settingsSearch.placeholder")} aria-label={t("settingsSearch.title")}
          value={query} onChange={(event) => { setDirection("forward"); setActive(0); setQuery(event.target.value); }}
          role="combobox" aria-expanded={results.length > 0} aria-controls="settings-search-results"
          aria-activedescendant={results[active] ? `settings-search-result-${active}` : undefined} />
        {category && <button className="cy-settings-search__back" type="button" onClick={goBack}><ArrowLeft size={14} /><span>{path}</span></button>}
        {!query.trim() && !category ? <div key={viewKey} className="cy-settings-search__categories">
          {categories.map(({ id, key, icon: Icon }) => <button type="button" key={id} className="is-entering" data-direction={direction} style={{ animationDelay: `${categories.findIndex((item) => item.id === id) * 50}ms` }} onClick={() => chooseCategory(id)}><Icon size={20} strokeWidth={1.6} /><span>{t(key)}</span></button>)}
        </div> : <SettingsSearchResults key={viewKey} items={results} active={active} browsing={browsing} direction={direction}
          containerRef={resultsRef} translate={t} onActivate={activate} onActiveChange={setActive} />}
        <section className="cy-settings-search__history" aria-label={t("settingsSearch.history")}>
          <div className="cy-settings-search__history-heading"><span>{t("settingsSearch.history")}</span><div>
            <button type="button" aria-pressed={managing} onClick={() => setManaging(!managing)}>{t(managing ? "settingsSearch.done" : "settingsSearch.manage")}</button>
            {managing && <button type="button" aria-label={t("settingsSearch.clear")} title={t("settingsSearch.clear")} disabled={!history.length} onClick={() => setConfirmClear(true)}><Trash2 size={16} strokeWidth={1.6} /></button>}
          </div></div>
          <div className="cy-settings-search__chips" ref={historyRef}>
            {history.map((entry, index) => <div className="cy-settings-search__chip" key={entry} style={{ visibility: index < visibleHistory ? "visible" : "hidden" }} aria-hidden={index >= visibleHistory}>
              <button type="button" tabIndex={index < visibleHistory ? 0 : -1} title={entry} onClick={() => { setQuery(entry); chooseCategory(); }}>{entry}</button>
              {managing && <button className="cy-settings-search__delete" type="button" tabIndex={index < visibleHistory ? 0 : -1} aria-label={t("settingsSearch.delete", { query: entry })} onClick={() => updateHistory(history.filter((value) => value !== entry))}><X size={12} /></button>}
            </div>)}
          </div>
          {!history.length && <p className="cy-settings-search__empty">{t("settingsSearch.noHistory")}</p>}
        </section>
      </div>
    </Modal>
    <Modal open={open && confirmClear} title={t("settingsSearch.clearConfirm")} onCancel={() => setConfirmClear(false)} okText={t("settingsSearch.clear")} cancelText={t("settingsSearch.cancel")} okButtonProps={{ danger: true }}
      onOk={() => { updateHistory([]); setConfirmClear(false); }}><p>{t("settingsSearch.clearDescription")}</p></Modal>
  </>;
}
