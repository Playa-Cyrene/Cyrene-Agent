# Full Streamdown Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Render every chat Markdown message with Streamdown and never hand a completed response to XMarkdown.

**Architecture:** A product-owned StreamdownMessageContent component becomes the sole renderer behind MarkdownContent. It uses the current code, Mermaid, SVG, and workspace-file adapters. A safe HTTPS placeholder transforms file links before Streamdown sanitization, so the default hardening plugin stays enabled.

**Tech Stack:** React 19, Streamdown 2.6, @streamdown/math, KaTeX, Tailwind CSS v4, Vite, Vitest.

**Spec:** docs/superpowers/specs/2026-09-20-full-streamdown-renderer-design.md

## Global Constraints

- Work on the current codex/a1-s-streamdown-spike branch. Do not create a worktree or another branch.
- Streamdown is the only chat Markdown renderer for active, completed, and historical content.
- Keep default rehype-harden protection. Do not allow file protocol URLs and do not copy the spike security configuration.
- Reuse MermaidBlock, SvgCardBlock, CodeHighlighter, FileLinkContext, MessageStreamingContext, parseFileLinkHref, and relativePathInsideWorkspace.
- Tailwind only generates Streamdown utilities with an sd prefix. Do not add Tailwind preflight or product utility classes.
- No video recording is part of implementation or verification.

## Review Focus

- A forged placeholder cannot bypass the current workspace-root test.
- Incomplete formulas and code fences render safely while text streams.
- Retry, cancellation, and round replacement remove stale Streamdown blocks.
- Inline and display math both emit KaTeX.
- Completion must not mount XMarkdown or cause an XMarkdown full-document parse.

## File Map

- Create src/renderer/react/features/chat/components/streamdown-file-link.ts and its test for safe placeholder encoding, decoding, and HAST transformation.
- Create src/renderer/react/features/chat/components/StreamdownMessageContent.tsx, its CSS, semantic test, and mounted-state test.
- Modify ChatMessageList.tsx, ChatMessageList.test.ts, ChatMessageList.last-turn.test.ts, and ChatMessageList.css to use production Streamdown only.
- Modify package.json, package-lock.json, and vite.config.ts for runtime dependencies and scoped Tailwind compilation.
- Remove experiment-only Streamdown injection files from src/renderer/react-perf and the paired control from scripts/perf/chat-renderer-baseline.mjs.
- Update docs/internal-issue/2026-09-17-chat-renderer-performance-known-issues.md with the measured result.

### Task 1: Secure workspace-file placeholder protocol

**Files:**
- Create: src/renderer/react/features/chat/components/streamdown-file-link.ts
- Test: src/renderer/react/features/chat/components/streamdown-file-link.test.ts

**Interfaces:**
- Produces encodeStreamdownFileHref(href: string): string.
- Produces decodeStreamdownFileHref(href: string): string or null.
- Produces encodeStreamdownFileLinksInHast: Plugin.
- Only file protocol href values encode to an application-owned HTTPS placeholder. Non-file href values remain unchanged.

- [ ] **Step 1: Write failing protocol tests**

~~~ts
const encoded = encodeStreamdownFileHref("file:///E:/ws/src/a.ts#L12");
expect(encoded).toMatch(/^https:\/\/cyrene\.invalid\/__file-link__\//);
expect(decodeStreamdownFileHref(encoded)).toBe("file:///E:/ws/src/a.ts#L12");
expect(encodeStreamdownFileHref("https://example.com/a")).toBe("https://example.com/a");
expect(decodeStreamdownFileHref("https://cyrene.invalid/__file-link__/not-base64!")).toBeNull();
expect(decodeStreamdownFileHref("https://attacker.invalid/__file-link__/ZmlsZTovLy9FL3g")).toBeNull();
~~~

- [ ] **Step 2: Run the test and confirm it fails**

Run: npx vitest run src/renderer/react/features/chat/components/streamdown-file-link.test.ts

Expected: the module is absent.

- [ ] **Step 3: Implement the codec and AST transformer**

~~~ts
export function encodeStreamdownFileHref(href: string): string {
  return href.startsWith("file:///") ? encodePlaceholder(href) : href;
}

export function decodeStreamdownFileHref(href: string): string | null {
  const decoded = decodeExactPlaceholder(href);
  return decoded?.startsWith("file:///") ? decoded : null;
}

export const encodeStreamdownFileLinksInHast: Plugin = () => (tree) => {
  visitElementNodes(tree, (node) => {
    if (node.tagName === "a" && typeof node.properties?.href === "string") {
      node.properties.href = encodeStreamdownFileHref(node.properties.href);
    }
  });
};
~~~

Use a local recursive HAST child walker. Insert the transformer after Streamdown raw parsing and before default sanitize and harden. Do not add an import from an undeclared transitive package.

- [ ] **Step 4: Run the focused test**

Run: npx vitest run src/renderer/react/features/chat/components/streamdown-file-link.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/renderer/react/features/chat/components/streamdown-file-link.ts src/renderer/react/features/chat/components/streamdown-file-link.test.ts
git commit -m "feat(chat): encode workspace links for Streamdown safety"
~~~
+

### Task 2: Production Streamdown renderer

**Files:**
- Create: src/renderer/react/features/chat/components/StreamdownMessageContent.tsx
- Create: src/renderer/react/features/chat/components/StreamdownMessageContent.css
- Create: src/renderer/react/features/chat/components/StreamdownMessageContent.test.ts
- Modify: package.json
- Modify: package-lock.json
- Modify: vite.config.ts

**Interfaces:**
- Produces StreamdownMessageContent with content: string and streaming: boolean.
- Active messages use mode streaming plus parseIncompleteMarkdown.
- Completed and historical messages use mode static on the same component type.
- Component map, rehype plugin list, and math plugin are module constants.
- Math configuration uses createMathPlugin with singleDollarTextMath true.

- [ ] **Step 1: Write failing semantic tests**

~~~ts
expect(render("行内 $E=mc^2$ 与块级公式", true)).toContain("katex");
expect(render("~~~ts\nconst n = 1;", true)).toContain("data-code-stub");
expect(render("~~~mermaid\ngraph TD\nA-->B", true)).toContain("cy-mermaid--pending");
expect(render("[文件](file:///E:/ws/src/a.ts#L12)", false, workspaceEnv)).toContain("cy-file-link");
expect(render("[危险](javascript:alert(1))\n<script>alert(1)</script>", false)).not.toMatch(/javascript:|<script/i);
~~~

The helper wraps real FileLinkContext and MessageStreamingContext. Only browser-only highlighter and diagram implementations are mocked.

- [ ] **Step 2: Run the test and confirm it fails**

Run: npx vitest run src/renderer/react/features/chat/components/StreamdownMessageContent.test.ts

Expected: the component is absent.

- [ ] **Step 3: Implement the component**

~~~tsx
const mathPlugin = createMathPlugin({ singleDollarTextMath: true });
const rehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  encodeStreamdownFileLinksInHast,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
];

export function StreamdownMessageContent({ content, streaming }: Props) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      plugins={{ math: mathPlugin }}
      components={messageComponents}
      rehypePlugins={rehypePlugins}
      prefix="sd"
      className="cy-message-markdown cy-streamdown-message"
    >
      {content}
    </Streamdown>
  );
}
~~~

The anchor adapter decodes only a valid placeholder, then reruns parseFileLinkHref and relativePathInsideWorkspace before rendering the existing chip. Other links stay ordinary external anchors. The pre adapter routes Mermaid and SVG to current blocks; other fences use current CodeHighlighter.

Create CSS importing Streamdown and KaTeX styles. Compile Tailwind theme and utilities with the sd prefix and a source directive for Streamdown distribution. Place theme aliases only below cy-streamdown-message. Vite must process this stylesheet in product renderer builds without preflight. Move streamdown, @streamdown/math, and direct katex to dependencies; keep Tailwind packages as build dependencies.

- [ ] **Step 4: Verify semantics and types**

Run: npx vitest run src/renderer/react/features/chat/components/StreamdownMessageContent.test.ts && npm run check:renderer

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add package.json package-lock.json vite.config.ts src/renderer/react/features/chat/components/StreamdownMessageContent.tsx src/renderer/react/features/chat/components/StreamdownMessageContent.css src/renderer/react/features/chat/components/StreamdownMessageContent.test.ts
git commit -m "feat(chat): add production Streamdown renderer"
~~~
+

### Task 3: Replace MarkdownContent and prove mounted updates

**Files:**
- Modify: src/renderer/react/features/chat/components/ChatMessageList.tsx
- Modify: src/renderer/react/features/chat/components/ChatMessageList.test.ts
- Modify: src/renderer/react/features/chat/components/ChatMessageList.last-turn.test.ts
- Modify: src/renderer/react/features/chat/components/ChatMessageList.css
- Create: src/renderer/react/features/chat/components/streamdown-message-content-state.test.ts

**Interfaces:**
- MarkdownContent public properties remain content and optional streaming.
- It normalizes content and delegates to StreamdownMessageContent.
- It has no XMarkdown import and no window performance renderer hook.

- [ ] **Step 1: Write failing state and source tests**

~~~tsx
root.render(<MarkdownContent content="第一轮 AAA" streaming />);
await flush();
root.render(<MarkdownContent content="完全替换 BBB" streaming={false} />);
await flush();
expect(container.textContent).toContain("BBB");
expect(container.textContent).not.toContain("AAA");

expect(chatMessageListSource).not.toContain("@ant-design/x-markdown");
expect(chatMessageListSource).not.toContain("__cyreneChatPerfMarkdownRenderer");
~~~

Include a sequence from an incomplete tildes code fence to completed unrelated text so remend output cannot remain.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: npx vitest run src/renderer/react/features/chat/components/streamdown-message-content-state.test.ts src/renderer/react/features/chat/components/ChatMessageList.test.ts

Expected: ChatMessageList still mounts XMarkdown.

- [ ] **Step 3: Replace the boundary**

~~~tsx
export function MarkdownContent({ content, streaming = false }: Props) {
  reportChatPerfRender("markdownRenders");
  const normalized = useMemo(() => normalizeModelMarkdown(content), [content]);
  return (
    <MarkdownRenderBoundary content={normalized}>
      <MessageStreamingContext.Provider value={streaming}>
        <StreamdownMessageContent content={normalized} streaming={streaming} />
      </MessageStreamingContext.Provider>
    </MarkdownRenderBoundary>
  );
}
~~~

Remove XMarkdown, Latex, ComponentProps, XMarkdown stream options, perfStreamRenderMode, and optional window renderer injection. Retain existing contexts, error boundary, Bubble roles, and CSS declarations. Replace XMarkdown mocks in tests.

- [ ] **Step 4: Verify chat-local tests**

Run: npx vitest run src/renderer/react/features/chat/components/ChatMessageList.test.ts src/renderer/react/features/chat/components/ChatMessageList.last-turn.test.ts src/renderer/react/features/chat/components/streamdown-message-content-state.test.ts src/renderer/react/features/chat/components/file-link.test.ts && npm run check:renderer

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/renderer/react/features/chat/components/ChatMessageList.tsx src/renderer/react/features/chat/components/ChatMessageList.test.ts src/renderer/react/features/chat/components/ChatMessageList.last-turn.test.ts src/renderer/react/features/chat/components/ChatMessageList.css src/renderer/react/features/chat/components/streamdown-message-content-state.test.ts
git commit -m "refactor(chat): render all Markdown with Streamdown"
~~~
+

### Task 4: Remove the injection experiment and measure completion

**Files:**
- Modify: src/renderer/react-perf/main.tsx
- Delete: src/renderer/react-perf/streamdown-spike.tsx
- Delete: src/renderer/react-perf/streamdown-spike.css
- Delete: src/renderer/react-perf/streamdown-spike.test.ts
- Delete: src/renderer/react-perf/streamdown-spike-state.test.ts
- Modify: scripts/perf/chat-renderer-baseline.mjs
- Create: src/renderer/react-perf/react-perf-cleanup.test.ts
- Modify: docs/internal-issue/2026-09-17-chat-renderer-performance-known-issues.md

**Interfaces:**
- Production MarkdownContent is the only Streamdown renderer the harness sees.
- No window renderer injection or paired injected-renderer control remains.
- Measurements contain metrics only, not videos.

- [ ] **Step 1: Write failing cleanup checks**

~~~ts
expect(readFileSync(perfMain, "utf8")).not.toContain("__cyreneChatPerfMarkdownRenderer");
expect(existsSync(streamdownSpike)).toBe(false);
expect(readFileSync(baselineScript, "utf8")).not.toContain("paired-control");
~~~

Keep generic animated, static, and plain controls only when they remain independently useful.

- [ ] **Step 2: Run the check and confirm it fails**

Run: npx vitest run src/renderer/react-perf/react-perf-cleanup.test.ts

Expected: spike injection and paired control are present.

- [ ] **Step 3: Delete only experiment paths**

Remove spike imports, streamdown URL parsing, global registration, and paired control. Preserve generic probe infrastructure. Update the issue with the migration decision, local formula test result, and numeric completion-transition observation.

- [ ] **Step 4: Verify non-recording measurement**

Run: npx vitest run src/renderer/react-perf/react-perf-cleanup.test.ts && npm run perf:chat-baseline -- --smoke --only-b

Expected: PASS and no webm output.

- [ ] **Step 5: Commit**

~~~bash
git add -A src/renderer/react-perf scripts/perf/chat-renderer-baseline.mjs docs/internal-issue/2026-09-17-chat-renderer-performance-known-issues.md
git commit -m "chore(chat): retire Streamdown perf injection"
~~~

### Task 5: Remove XMarkdown dependency and verify fully

**Files:**
- Modify: package.json
- Modify: package-lock.json
- Modify: src/renderer/react-perf/react-perf-cleanup.test.ts

**Interfaces:**
- dependencies contains streamdown, @streamdown/math, and katex.
- dependencies does not contain @ant-design/x-markdown.

- [ ] **Step 1: Add failing package assertions**

~~~ts
expect(packageJson.dependencies.streamdown).toBeDefined();
expect(packageJson.dependencies["@streamdown/math"]).toBeDefined();
expect(packageJson.dependencies.katex).toBeDefined();
expect(packageJson.dependencies["@ant-design/x-markdown"]).toBeUndefined();
~~~

- [ ] **Step 2: Run the test and confirm it fails**

Run: npx vitest run src/renderer/react-perf/react-perf-cleanup.test.ts

Expected: current dependency classification and XMarkdown declaration violate the assertions.

- [ ] **Step 3: Update declared dependencies**

Run: npm install

Verify only package.json and package-lock.json are changed for this step.

- [ ] **Step 4: Run final verification**

Run: npm run check:renderer && npm run build:renderer && npm test

Expected: all commands exit 0.

Run: rg -l "@ant-design/x-markdown|XMarkdown" dist/renderer

Expected: no matches.

- [ ] **Step 5: Commit**

~~~bash
git add package.json package-lock.json src/renderer/react-perf/react-perf-cleanup.test.ts
git commit -m "chore(chat): remove XMarkdown runtime dependency"
~~~

## Plan self-review

- Tasks 1 to 3 implement safe file links, formula and code behavior, one product renderer, and replacement-state correctness.
- Task 4 removes the dual-path experiment and measures completion without video recording.
- Task 5 validates the runtime dependency graph, renderer build, and full suite.
- Every review-focus item has a named task and command.

