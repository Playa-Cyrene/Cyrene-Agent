/* Adapted from ZCode packages/ui/src/components/ai-elements/terminal.tsx,
 * itself derived from Vercel ai-elements (Apache-2.0). See THIRD_PARTY_NOTICES.md. */
import RawAnsi from "ansi-to-react";
import { Terminal as TerminalIcon } from "lucide-react";
import { useEffect, useRef, type ComponentType } from "react";
import type { ToolExecutionRecord } from "../../../../../shared/chat-types";
import { useTranslation } from "../../../i18n";
import { CopyButton } from "./CopyButton";
import "./CommandTerminal.css";

const Ansi = RawAnsi as unknown as ComponentType<{ children?: string; linkify?: boolean }>;

function parseObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function resultOutput(result: string | undefined): { command?: string; output: string; exitCode?: number; structuredOutput?: boolean; background?: boolean } {
  if (!result) return { output: "" };
  const outer = parseObject(result);
  const inner = typeof outer?.output === "string" ? parseObject(outer.output) : null;
  const payload = inner ?? outer;
  if (!payload) return { output: result };
  const command = typeof payload.command === "string" ? payload.command : undefined;
  const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : undefined;
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
  if ("stdout" in payload || "stderr" in payload) {
    return { command, exitCode, output: [stdout, stderr].filter(Boolean).join("\n"), structuredOutput: true };
  }
  return { command, exitCode, output: "", background: payload.ranInBackground === true };
}

export function CommandTerminal({ tool }: { tool: ToolExecutionRecord }) {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const args = parseObject(tool.argsText);
  const legacy = resultOutput(tool.result);
  const command = (typeof args?.command === "string" && args.command.trim())
    || legacy.command
    || t("messageList.commandUnknown");
  // spawn 错误可能只出现在最终结果中，未经过 stdout/stderr 流。
  const output = tool.terminalOutput === "" && legacy.structuredOutput && legacy.output
    ? legacy.output
    : tool.terminalOutput ?? legacy.output;
  const running = tool.status === "running";

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [output]);

  const status = running
    ? t("messageList.commandRunning")
    : tool.status === "error"
      ? t("messageList.commandFailed")
      : legacy.background
        ? t("messageList.commandBackground")
        : t("messageList.commandCompleted");
  const statusText = !running && legacy.exitCode !== undefined
    ? `${status} · ${t("messageList.commandExitCode")} ${legacy.exitCode}`
    : status;

  return (
    <section className="cy-command-terminal" aria-label={t("messageList.commandTerminalTitle")}>
      <div className="cy-command-terminal__header">
        <span className="cy-command-terminal__title"><TerminalIcon size={14} aria-hidden="true" />{t("messageList.commandTerminalTitle")}</span>
        <span className={`cy-command-terminal__status is-${tool.status}`}>{statusText}</span>
        <CopyButton text={output} size={15} color="#a1a1aa" />
      </div>
      <div className="cy-command-terminal__body" ref={scrollerRef}>
        <div className="cy-command-terminal__command"><span aria-hidden="true">$</span><code>{command}</code></div>
        {tool.terminalOutputTruncated && (
          <div className="cy-command-terminal__truncated">{t("messageList.commandOutputTruncated")}</div>
        )}
        <pre className="cy-command-terminal__output"><Ansi>{output}</Ansi>{running && <span className="cy-command-terminal__cursor" aria-hidden="true" />}</pre>
        {!running && !output && <div className="cy-command-terminal__empty">{t("messageList.commandNoOutput")}</div>}
      </div>
    </section>
  );
}
