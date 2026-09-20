# Full Streamdown Renderer Design

## Goal

Replace the chat message Markdown renderer with Streamdown for streaming,
completed, and historical assistant messages. A response must remain in the
same renderer when generation ends: it must never hand a long document from
Streamdown to XMarkdown at completion.

## Confirmed constraints

- Work directly on the current branch; do not create a new worktree or branch.
- This migration does not include a recording deliverable.
- Preserve the current user-visible behavior for Mermaid, SVG cards, syntax
  highlighting, workspace file links, external links, raw HTML handling,
  cancellation, retry, and message replacement.
- Preserve live formula rendering. The upstream Streamdown formula issue is a
  release risk to test locally, not a reason to silently fall back to
  XMarkdown.
- Do not retain a dual-renderer architecture after the migration.

## Current state

`ChatMessageList.tsx` renders all production Markdown through XMarkdown. The
existing `react-perf/streamdown-spike.tsx` demonstrated that Streamdown's
block-level memoization removes the dominant repeated full-document parsing
cost, but it is an experiment only: it is connected through a performance
harness and weakens Streamdown's default `rehype-harden` protection to permit
`file:` URLs. It is not a product component and must not be copied wholesale.

## Architecture

Create a production-owned renderer component near the chat Markdown code. It
will be the single renderer for every assistant Markdown message.

1. `MarkdownContent` normalizes model output once and renders the production
   Streamdown component regardless of whether the message is streaming.
2. Active output supplies `mode="streaming"` and `parseIncompleteMarkdown`.
   Completed and historical output supplies `mode="static"` to the same
   component type. The switch is an in-place Streamdown prop update, not a
   renderer swap or a new XMarkdown mount.
3. The migration must measure the streaming-to-static transition on long
   content. If it still causes a visible full-document stall, completed
   messages remain in Streamdown streaming mode until a Streamdown-only
   transition that preserves block identity is proven. XMarkdown is not a
   fallback for this case.
4. Streamdown component overrides reuse the existing MermaidBlock,
   SvgCardBlock, CodeHighlighter, FileLinkContext, and
   MessageStreamingContext. No duplicate business rules are introduced.

## Links and security

Streamdown's default hardening intentionally rejects `file:` URLs. Product
code will keep that default hardening enabled. Before rendering, workspace
`file:///...` Markdown destinations are encoded into an application-owned,
safe placeholder URL. The custom anchor renderer decodes only that exact
placeholder form, verifies it again with `parseFileLinkHref` and
`relativePathInsideWorkspace`, then renders the existing file chip. Other
links stay in Streamdown's default safety path.

This avoids both unsafe protocol allowlisting and the spike's removal of
`rehype-harden`.

## Math and styles

Move `streamdown` and `@streamdown/math` from development-only dependencies
to runtime dependencies. Load Streamdown's prebuilt CSS and KaTeX CSS through
the renderer stylesheet; do not add Tailwind to the product renderer build.
Configure the math plugin to support the existing single-dollar inline math
syntax as well as display math. Add regression fixtures for valid, incomplete,
and malformed formulas.

If the upstream formula issue reproduces locally, record exact input,
browser, and output in a failing regression test. Do not ship a hidden
XMarkdown fallback; pause release integration until the Streamdown-only path
has a safe, visible behavior.

## Removal and compatibility

After production parity tests pass, remove XMarkdown imports, its Latex
extension configuration, XMarkdown-only streaming options, and the
performance-harness global renderer hook. Keep the performance fixture and
probe infrastructure only if it continues to serve the benchmark; it must not
affect production bundles.

## Acceptance criteria

1. No production path imports or mounts XMarkdown for chat message Markdown.
2. A generated long Markdown response does not change renderer at completion;
   no completion-only full-document XMarkdown parse occurs.
3. Markdown tables, lists, fenced code, Mermaid, SVG, syntax highlighting,
   `$...$` and `$$...$$` formulas, external links, workspace file links,
   unsafe HTML, and unsafe URLs have covered tests.
4. Content replacement (retry, discard, different round, cancellation) leaves
   no stale block from the preceding content.
5. Existing chat tests and the complete project test suite pass.
6. The established performance matrix is rerun without a recording step; the
   long-message completion transition is explicitly reported.

## Rollback

Keep the migration in focused commits. If a release-blocking Streamdown defect
is found, revert the renderer migration commit as a unit. Do not leave a
runtime engine-selection flag or a silent per-message XMarkdown fallback in
the shipped code.
