import { type ReactNode } from "react";
import { useTranslation } from "../../i18n";
import "./DisclaimerSettingsPanel.css";
import { Card } from "../../components/ui/Card";

type DisclaimerBlock =
  | { kind: "paragraph" | "heading"; text: string }
  | { kind: "list"; items: string[] };
interface DisclaimerSection { title: string; blocks: DisclaimerBlock[] }

/** 只支持条款所需的行内格式；文本由 React 转义，不把译文当作 HTML 执行。 */
function inlineContent(text: string): ReactNode[] {
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
        ? <a key={match.index} href={match[3]} target="_blank" rel="noopener noreferrer">{match[2]}</a>
        : match[2]);
    } else result.push(<em key={match.index}>{match[4]}</em>);
    offset = match.index + match[0].length;
  }
  result.push(text.slice(offset));
  return result;
}

/** 首次启动、设置页和权限说明共用一份已本地化的完整条款。 */
export function DisclaimerSettingsPanel() {
  const { t } = useTranslation();
  const sections = t("settingsPage.disclaimer.sections", { returnObjects: true }) as unknown as DisclaimerSection[];

  return (
    <>
      <h1>{t("settingsPage.disclaimer.heading")}</h1>
      <div className="cy-settings-disclaimer">
        {sections.map((section, index) => (
          <Card as="article" data-settings-search-id={`settingsPage.disclaimer.sections.${index}.title`} className={`cy-disclaimer-section${index === 0 ? " cy-disclaimer-notice" : ""}`} key={index}>
            <h2>{section.title}</h2>
            {section.blocks.map((block, blockIndex) => {
              if (block.kind === "list") return <ul key={blockIndex}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{inlineContent(item)}</li>)}</ul>;
              if (block.kind === "heading") return <h3 key={blockIndex}>{inlineContent(block.text)}</h3>;
              return <p key={blockIndex}>{inlineContent(block.text)}</p>;
            })}
          </Card>
        ))}
      </div>
    </>
  );
}
