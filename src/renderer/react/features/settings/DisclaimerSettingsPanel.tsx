import { useState, type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import "./DisclaimerSettingsPanel.css";
import { Card } from "../../components/ui/Card";
import type { TermsDocument, TermsLocale, TermsSnapshot } from "../../../../shared/terms-types";
import { useTermsSnapshot } from "../../hooks/useTermsSnapshot";

type DisclaimerBlock =
  | { kind: "paragraph" | "heading"; text: string }
  | { kind: "list"; items: string[] };
interface DisclaimerSection { title: string; blocks: DisclaimerBlock[] }

/** 只支持条款所需的行内格式；文本由 React 转义，不把译文当作 HTML 执行。 */
function inlineContent(text: string, openEmail: (url: string) => Promise<void>): ReactNode[] {
  const result: ReactNode[] = [];
  const token = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)]+)\)|\*([^*]+)\*/g;
  let offset = 0;
  for (const match of text.matchAll(token)) {
    result.push(text.slice(offset, match.index));
    if (match[1]) result.push(<strong key={match.index}>{match[1]}</strong>);
    else if (match[2]) {
      // 即使译文被错误编辑，也不能生成可执行脚本或本机文件链接。
      const safe = /^(?:https:\/\/|mailto:)[^\s]+$/i.test(match[3]);
      result.push(safe
        ? <a key={match.index} href={match[3]} target="_blank" rel="noopener noreferrer"
          onClick={/^mailto:/i.test(match[3]) ? (event) => {
            // 全局新窗口策略只放行 HTTP(S)；邮件必须走已有的受限系统 IPC。
            event.preventDefault();
            void openEmail(match[3]);
          } : undefined}>{match[2]}</a>
        : match[2]);
    } else result.push(<em key={match.index}>{match[4]}</em>);
    offset = match.index + match[0].length;
  }
  result.push(text.slice(offset));
  return result;
}

/** 首次启动、设置页和权限说明共用一份已本地化的完整条款。 */
export function DisclaimerSettingsPanel({ snapshot: suppliedSnapshot }: { snapshot?: TermsSnapshot | null } = {}) {
  const { t, locale } = useTranslation();
  const { snapshot: liveSnapshot } = useTermsSnapshot(suppliedSnapshot === undefined);
  const snapshot = suppliedSnapshot === undefined ? liveSnapshot : suppliedSnapshot;
  const termsLocale: TermsLocale = locale?.startsWith("ja") ? "ja-JP" : locale?.startsWith("en") ? "en" : "zh-CN";
  const document: TermsDocument | undefined = snapshot?.locales[termsLocale];
  const [linkError, setLinkError] = useState(false);
  async function openEmail(url: string) {
    setLinkError(false);
    try {
      if (!window.system?.openExternal) throw new Error("External link API unavailable");
      const result = await window.system.openExternal(url);
      if (!result.ok) throw new Error(result.error ?? "Unable to open link");
    } catch {
      // 系统未配置邮件应用或 IPC 不可用时保留地址并提示，不尝试绕过协议限制。
      setLinkError(true);
    }
  }
  const sections = document?.sections ?? t("settingsPage.disclaimer.sections", { returnObjects: true }) as unknown as DisclaimerSection[];

  return (
    <>
      <h1>{document?.heading ?? t("settingsPage.disclaimer.heading")}</h1>
      {snapshot && <p className="cy-settings-intro">{t("onboarding.termsVersion", { version: snapshot.consentVersion, revision: snapshot.revision })}</p>}
      {linkError && <p role="alert">{t("ui.reportIssue.openFailed")}</p>}
      <div className="cy-settings-disclaimer">
        {sections.map((section, index) => (
          <Card as="article" data-settings-search-id={`settingsPage.disclaimer.sections.${index}.title`} className={`cy-disclaimer-section${index === 0 ? " cy-disclaimer-notice" : ""}`} key={index}>
            <h2>{section.title}</h2>
            {section.blocks.map((block, blockIndex) => {
              if (block.kind === "list") return <ul key={blockIndex}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineContent(item, openEmail)}</li>)}</ul>;
              if (block.kind === "heading") return <h3 key={blockIndex}>{inlineContent(block.text, openEmail)}</h3>;
              return <p key={blockIndex}>{inlineContent(block.text, openEmail)}</p>;
            })}
          </Card>
        ))}
      </div>
    </>
  );
}
