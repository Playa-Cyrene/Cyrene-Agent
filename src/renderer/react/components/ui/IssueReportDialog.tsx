import { useEffect, useState } from "react";
import { Bug, Check, Code, Copy, ExternalLink, HelpCircle, Mail, Package, X } from "lucide-react";
import { Dialog } from "radix-ui";
import packageJson from "../../../../../package.json";
import { useTranslation } from "../../i18n";
import { copyTextToClipboard } from "../../features/chat/components/CopyButton";
import { SettingsSelect } from "./SettingsControls";
import "./IssueReportDialog.css";

const ISSUES_URL = "https://github.com/Playa-Cyrene/Cyrene-Agent/issues";
const REPORT_EMAIL = "ky2569ly@gmail.com";

// 源码运行与安装包的 GitHub 表单字段并不相同：安装包模板填应用版本，源码模板必填提交号。
// 所以进入表单前先让用户选运行方式，据此决定打开哪个模板、预填哪些字段。
// 模板文件名刻意互不包含：GitHub 解析 template 参数时可能部分命中多个文件，
// 早先的 runtime-bug-source.yml 就把 runtime-bug.yml 抢走了，所以源码模板改名为不相干的 bug-from-source.yml。
const INSTALL_SOURCES = [
  { value: "sourceCode", label: "sourceCode", template: "bug-from-source.yml", icon: Code },
  { value: "prebuilt", label: "prebuilt", template: "runtime-bug.yml", icon: Package },
  { value: "unknown", label: "sourceUnknown", template: "runtime-bug.yml", icon: HelpCircle },
] as const;

type InstallSource = (typeof INSTALL_SOURCES)[number]["value"];

const SESSION_MODES = [
  { value: "chat（聊天）", label: "modeChat" },
  { value: "work（工作）", label: "modeWork" },
  { value: "learn（学习）", label: "modeLearn" },
  { value: "code（编程）", label: "modeCode" },
  { value: "不确定 / 其他入口（渠道、定时任务等）", label: "modeOther" },
] as const;

interface ReportForm {
  title: string;
  appVersion: string;
  os: string;
  installSource: InstallSource | "";
  mode: string[];
  steps: string;
  actual: string;
  expected: string;
  logs: string;
  frequency: string;
  commit: string;
}

function initialForm(): ReportForm {
  return {
    title: "",
    appVersion: `v${packageJson.version}`,
    os: "",
    installSource: "",
    mode: [],
    steps: "",
    actual: "",
    expected: "",
    logs: "",
    frequency: "",
    commit: "",
  };
}

function buildReport(form: ReportForm, t: (key: string) => string): string {
  const mode = form.mode.length ? form.mode.join(", ") : t("ui.reportIssue.notProvided");
  const sourceLabel = form.installSource ? t(`ui.reportIssue.${form.installSource}`) : "";
  const fields: Array<[string, string]> = [
    [t("ui.reportIssue.appVersion"), form.appVersion],
    [t("ui.reportIssue.os"), form.os],
    [t("ui.reportIssue.installSource"), sourceLabel],
  ];
  // 提交号只对源码运行有意义，安装包用户不需要填
  if (form.installSource === "sourceCode") fields.push([t("ui.reportIssue.commit"), form.commit]);
  fields.push(
    [t("ui.reportIssue.mode"), mode],
    [t("ui.reportIssue.steps"), form.steps],
    [t("ui.reportIssue.actual"), form.actual],
    [t("ui.reportIssue.expected"), form.expected],
    [t("ui.reportIssue.logs"), form.logs],
    [t("ui.reportIssue.frequency"), form.frequency],
  );
  return [`# ${form.title.trim()}`, ...fields.map(([label, value]) => `## ${label}\n${value.trim() || t("ui.reportIssue.notProvided")}`)].join("\n\n");
}

export function IssueReportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ReportForm>(initialForm);
  const [feedback, setFeedback] = useState("");
  // 每次打开都从选择运行方式开始，避免上次选过的来源被悄悄沿用
  const [step, setStep] = useState<"source" | "form">("source");

  useEffect(() => {
    if (open) setStep("source");
  }, [open]);

  function update<K extends keyof ReportForm>(key: K, value: ReportForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setFeedback("");
  }

  function toggleMode(mode: string) {
    update("mode", form.mode.includes(mode) ? form.mode.filter((item) => item !== mode) : [...form.mode, mode]);
  }

  const isSourceBuild = form.installSource === "sourceCode";
  const ready = Boolean(
    form.title.trim() &&
      form.appVersion.trim() &&
      form.os &&
      form.installSource &&
      form.mode.length &&
      form.steps.trim() &&
      form.actual.trim() &&
      (!isSourceBuild || form.commit.trim()),
  );

  async function copyReport() {
    if (!ready) {
      setFeedback(t("ui.reportIssue.requiredFields"));
      return;
    }
    const ok = await copyTextToClipboard(buildReport(form, t));
    setFeedback(ok ? t("ui.reportIssue.copied") : t("ui.reportIssue.copyFailed"));
  }

  async function openExternal(url: string) {
    try {
      if (!window.system?.openExternal) throw new Error("External link API unavailable");
      const result = await window.system.openExternal(url);
      if (!result.ok) throw new Error(result.error ?? "Unable to open link");
      return true;
    } catch {
      setFeedback(t("ui.reportIssue.openFailed"));
      return false;
    }
  }

  async function openEmail() {
    const hasReportContent = Boolean(form.title.trim() || form.os || form.installSource || form.mode.length || form.steps.trim() || form.actual.trim() || form.expected.trim() || form.logs.trim() || form.frequency.trim());
    const subject = form.title.trim() || t("ui.reportIssue.emailSubject");
    const body = hasReportContent ? buildReport(form, t) : "";
    const params = new URLSearchParams({ subject });
    if (body) params.set("body", body);
    let url = `mailto:${REPORT_EMAIL}?${params.toString()}`;

    if (url.length > 6000) {
      const copied = await copyTextToClipboard(body);
      url = `mailto:${REPORT_EMAIL}?${new URLSearchParams({ subject }).toString()}`;
      if (await openExternal(url)) {
        setFeedback(t(copied ? "ui.reportIssue.emailBodyCopied" : "ui.reportIssue.emailBodyTooLong"));
      }
      return;
    }

    if (await openExternal(url)) setFeedback(t("ui.reportIssue.emailReady"));
  }

  async function openGitHubDraft() {
    if (!ready) {
      setFeedback(t("ui.reportIssue.requiredFields"));
      return;
    }
    const route = INSTALL_SOURCES.find((source) => source.value === form.installSource) ?? INSTALL_SOURCES[1];
    const url = new URL(`${ISSUES_URL}/new`);
    url.searchParams.set("template", route.template);
    url.searchParams.set("title", form.title.trim());
    url.searchParams.set("os", form.os);
    form.mode.forEach((mode) => url.searchParams.append("mode", mode));
    url.searchParams.set("steps", form.steps.trim());
    url.searchParams.set("actual", form.actual.trim());
    url.searchParams.set("expected", form.expected.trim());
    url.searchParams.set("logs", form.logs.trim());
    url.searchParams.set("frequency", form.frequency.trim());
    // 两个模板的字段集不同：安装包模板要应用版本，源码模板必填提交号。
    // 早先传的 install-source 在两个模板里都没有同名字段，会被 GitHub 静默丢弃，已移除。
    if (isSourceBuild) url.searchParams.set("commit", form.commit.trim());
    else url.searchParams.set("app-version", form.appVersion.trim());
    if (url.toString().length > 7000) {
      setFeedback(t("ui.reportIssue.urlTooLong"));
      return;
    }
    await openExternal(url.toString());
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="cy-issue-report__overlay" />
        <Dialog.Content className="cy-issue-report" aria-describedby="cy-issue-report-description">
          <header className="cy-issue-report__header">
            <div>
              <Dialog.Title className="cy-issue-report__title">{t("ui.reportIssue.title")}</Dialog.Title>
              <Dialog.Description id="cy-issue-report-description" className="cy-issue-report__description">
                {t("ui.reportIssue.description")}
              </Dialog.Description>
            </div>
            <Dialog.Close className="cy-issue-report__close" aria-label={t("common.close")}>
              <X size={17} aria-hidden="true" />
            </Dialog.Close>
          </header>

          {step === "source" ? (
            <div className="cy-issue-report__body">
              <div className="cy-issue-report__source-picker">
                <p className="cy-issue-report__source-lead">{t("ui.reportIssue.chooseSourceLead")}</p>
                {INSTALL_SOURCES.map((source) => (
                  <button
                    key={source.value}
                    type="button"
                    className="cy-issue-report__source-option"
                    onClick={() => {
                      update("installSource", source.value);
                      setStep("form");
                    }}
                  >
                    <source.icon size={17} aria-hidden="true" className="cy-issue-report__source-option-icon" />
                    <span className="cy-issue-report__source-option-text">
                      <span className="cy-issue-report__source-option-title">{t(`ui.reportIssue.${source.label}`)}</span>
                      <span className="cy-issue-report__source-option-hint">{t(`ui.reportIssue.${source.label}Hint`)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="cy-issue-report__body">
              <div className="cy-issue-report__contacts">
                <div className="cy-issue-report__contact">
                  <Mail size={16} aria-hidden="true" />
                  <span>{t("ui.reportIssue.email")}</span>
                  <button type="button" onClick={() => void openEmail()}>{REPORT_EMAIL}</button>
                </div>
                <div className="cy-issue-report__contact">
                  <Bug size={16} aria-hidden="true" />
                  <span>{t("ui.reportIssue.github")}</span>
                  <a
                    href={ISSUES_URL}
                    onClick={(event) => { event.preventDefault(); void openExternal(ISSUES_URL); }}
                  >
                    {t("ui.reportIssue.openIssues")} <ExternalLink size={13} aria-hidden="true" />
                  </a>
                </div>
              </div>

              <form className="cy-issue-report__form" onSubmit={(event) => event.preventDefault()}>
                {/* 安装包用户手上只有编译产物，先把「源码依据」的要求讲清，免得提交后被要求补充 */}
                {!isSourceBuild && (
                  <div className="cy-issue-report__notice">
                    <span className="cy-issue-report__notice-title">{t("ui.reportIssue.sourceEvidenceTitle")}</span>
                    <p className="cy-issue-report__notice-body">{t("ui.reportIssue.sourceEvidenceBody")}</p>
                  </div>
                )}
                <label className="cy-issue-report__field cy-issue-report__field--full">
                  <span>{t("ui.reportIssue.reportTitle")} <i>*</i></span>
                  <input value={form.title} maxLength={120} onChange={(event) => update("title", event.target.value)} placeholder={t("ui.reportIssue.titlePlaceholder")} />
                </label>
                <label className="cy-issue-report__field">
                  <span>{t("ui.reportIssue.appVersion")} <i>*</i></span>
                  <input value={form.appVersion} maxLength={40} onChange={(event) => update("appVersion", event.target.value)} />
                </label>
                <label className="cy-issue-report__field">
                  <span>{t("ui.reportIssue.os")} <i>*</i></span>
                  <SettingsSelect
                    value={form.os}
                    onChange={(value) => update("os", value)}
                    ariaLabel={t("ui.reportIssue.os")}
                    placeholder={t("ui.reportIssue.choose")}
                    className="cy-issue-report__select"
                    contentClassName="cy-issue-report__select-content"
                    options={[
                      { value: "Windows 11", label: "Windows 11" },
                      { value: "Windows 10", label: "Windows 10" },
                    ]}
                  />
                </label>
                <div className="cy-issue-report__field cy-issue-report__field--full">
                  <span>{t("ui.reportIssue.installSource")} <i>*</i></span>
                  <div className="cy-issue-report__source-picked">
                    <span>{form.installSource ? t(`ui.reportIssue.${form.installSource}`) : ""}</span>
                    <button type="button" onClick={() => setStep("source")}>{t("ui.reportIssue.changeSource")}</button>
                  </div>
                </div>
                {isSourceBuild && (
                  <label className="cy-issue-report__field cy-issue-report__field--full">
                    <span>{t("ui.reportIssue.commit")} <i>*</i></span>
                    <input value={form.commit} maxLength={40} onChange={(event) => update("commit", event.target.value)} placeholder={t("ui.reportIssue.commitPlaceholder")} />
                  </label>
                )}
                <fieldset className="cy-issue-report__field cy-issue-report__field--full">
                  <legend>{t("ui.reportIssue.mode")} <i>*</i></legend>
                  <div className="cy-issue-report__modes">
                    {SESSION_MODES.map((mode) => (
                      <button
                        key={mode.value}
                        type="button"
                        aria-pressed={form.mode.includes(mode.value)}
                        className={form.mode.includes(mode.value) ? "is-selected" : ""}
                        onClick={() => toggleMode(mode.value)}
                      >
                        {form.mode.includes(mode.value) && <Check size={13} aria-hidden="true" />}
                        {t(`ui.reportIssue.${mode.label}`)}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label className="cy-issue-report__field cy-issue-report__field--full">
                  <span>{t("ui.reportIssue.steps")} <i>*</i></span>
                  <textarea value={form.steps} maxLength={1600} rows={3} onChange={(event) => update("steps", event.target.value)} placeholder={t("ui.reportIssue.stepsPlaceholder")} />
                </label>
                <label className="cy-issue-report__field cy-issue-report__field--full">
                  <span>{t("ui.reportIssue.actual")} <i>*</i></span>
                  <textarea value={form.actual} maxLength={1200} rows={3} onChange={(event) => update("actual", event.target.value)} placeholder={t("ui.reportIssue.actualPlaceholder")} />
                </label>
                <label className="cy-issue-report__field cy-issue-report__field--full">
                  <span>{t("ui.reportIssue.expected")}</span>
                  <textarea value={form.expected} maxLength={1200} rows={2} onChange={(event) => update("expected", event.target.value)} placeholder={t("ui.reportIssue.expectedPlaceholder")} />
                </label>
                <label className="cy-issue-report__field cy-issue-report__field--full">
                  <span>{t("ui.reportIssue.logs")}</span>
                  <textarea value={form.logs} maxLength={800} rows={2} onChange={(event) => update("logs", event.target.value)} placeholder={t("ui.reportIssue.logsPlaceholder")} />
                </label>
                <label className="cy-issue-report__field cy-issue-report__field--full">
                  <span>{t("ui.reportIssue.frequency")}</span>
                  <input value={form.frequency} maxLength={120} onChange={(event) => update("frequency", event.target.value)} placeholder={t("ui.reportIssue.frequencyPlaceholder")} />
                </label>
              </form>
            </div>
          )}

          {step === "form" && (
            <footer className="cy-issue-report__footer">
              <div className="cy-issue-report__feedback" role="status" aria-live="polite">{feedback || t("ui.reportIssue.requiredHint")}</div>
              <div className="cy-issue-report__actions">
                <button type="button" className="cy-issue-report__secondary" disabled={!ready} onClick={() => void copyReport()}>
                  <Copy size={15} aria-hidden="true" />{t("ui.reportIssue.copyReport")}
                </button>
                <button type="button" className="cy-issue-report__secondary" onClick={() => void openEmail()}>
                  <Mail size={15} aria-hidden="true" />{t("ui.reportIssue.sendEmail")}
                </button>
                <button type="button" className="cy-issue-report__primary" disabled={!ready} onClick={() => void openGitHubDraft()}>
                  <ExternalLink size={15} aria-hidden="true" />{t("ui.reportIssue.openDraft")}
                </button>
              </div>
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}