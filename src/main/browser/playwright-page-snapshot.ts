import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import type { WebContents } from "electron";

const PLAYWRIGHT_WORLD_ID = 9876;
const PLAYWRIGHT_GLOBAL = "__cyrenePlaywrightInjected";
const GENERATED_SOURCE_ASSIGNMENT = /\bsource\d+\s*=\s*/g;

export interface RuntimePageElement {
  ref: string;
  description: string;
  tag: string;
  href?: string;
  context?: string;
  bounds: [number, number, number, number];
  inViewport: boolean;
  disabled: boolean;
  id?: string;
  classes: string[];
  attributes: Record<string, string>;
}

export interface RuntimeSnapshot {
  observationId: string;
  ariaSnapshot: string;
  elements: RuntimePageElement[];
  totalReferences: number;
  note: string;
}

let injectedSourceCache: string | undefined;
const initializedContents = new WeakSet<WebContents>();

function readStringLiteralEnd(source: string, start: number): number {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') {
    throw new Error("Playwright generated source is not a string literal");
  }
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return index + 1;
  }
  throw new Error("Playwright generated source string is unterminated");
}

/**
 * Playwright does not publicly export its injected selector runtime. Read the generated
 * runtime from the exact installed playwright-core package and verify its expected API.
 */
function getPlaywrightInjectedSource(): string {
  if (injectedSourceCache) return injectedSourceCache;

  // A different transitive Playwright can be hoisted at the app root.
  const playwrightDirectory = dirname(require.resolve("playwright/package.json"));
  const packageJsonPath = require.resolve("playwright-core/package.json", { paths: [playwrightDirectory] });
  const bundlePath = join(dirname(packageJsonPath), "lib", "coreBundle.js");
  const bundle = readFileSync(bundlePath, "utf8");
  GENERATED_SOURCE_ASSIGNMENT.lastIndex = 0;
  let assignment: RegExpExecArray | null;
  while ((assignment = GENERATED_SOURCE_ASSIGNMENT.exec(bundle))) {
    const start = assignment.index + assignment[0].length;
    const quote = bundle[start];
    // coreBundle.js also has ordinary assignments such as `source = this.value`.
    // Only generated source payloads are string literals.
    if (quote !== "'" && quote !== '"') continue;
    const end = readStringLiteralEnd(bundle, start);
    const literal = bundle.slice(start, end);
    // The injected selector runtime is hundreds of KB; skip smaller unrelated source literals.
    if (literal.length < 100_000) continue;
    let decoded: unknown;
    try {
      decoded = runInNewContext(literal, Object.create(null), { timeout: 1_000 });
    } catch {
      continue;
    }
    if (typeof decoded !== "string") continue;
    if (
      decoded.includes("module.exports = __toCommonJS(injectedScript_exports)") &&
      decoded.includes("ariaSnapshot(node, options)")
    ) {
      injectedSourceCache = decoded;
      return decoded;
    }
  }
  throw new Error("Unable to find the Playwright injected selector runtime in playwright-core");
}

function buildInitializationScript(): string {
  const source = getPlaywrightInjectedSource();
  const options = JSON.stringify({
    browserName: "chromium",
    customEngines: [],
    isUnderTest: false,
    sdkLanguage: "javascript",
    stableRafCount: 1,
    testIdAttributeName: "data-testid",
  });
  return `(() => {
    try {
      const runtimeExports = (() => {
        const module = {};
        ${source}
        return module.exports;
      })();
      if (typeof runtimeExports?.InjectedScript !== "function") {
        throw new Error("Playwright InjectedScript export is unavailable");
      }
      // This generated bundle exports a factory that returns the class.
      const InjectedScript = runtimeExports.InjectedScript();
      if (typeof InjectedScript !== "function") {
        throw new Error("Playwright InjectedScript factory returned no constructor");
      }
      const injected = new InjectedScript(globalThis, ${options});
      const editableSelector = "textarea,[role='textbox'],[role='searchbox'],[contenteditable]:not([contenteditable='false']),selectedcontent";
      const isSelectedContent = (node) => {
        for (let ancestor = node; ancestor; ancestor = ancestor.parentNode ?? ancestor.host) {
          if (ancestor.localName === "selectedcontent") return true;
        }
        return false;
      };
      const isEditableText = (node) => {
        let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement ?? node.getRootNode().host;
        while (element) {
          if (element.isContentEditable || element.closest(editableSelector)) return true;
          element = element.getRootNode().host;
        }
        return false;
      };
      const masksInputValue = (input) => !["button", "submit", "reset"].includes(input.type);
      globalThis.__cyreneBrowserPublicText = (element) => {
        if (isEditableText(element) || element.querySelector(editableSelector)) return "";
        return element.innerText || element.textContent || "";
      };

      // Playwright reads live values both as node text and when computing accessible
      // names. Mask the getters for the synchronous capture in this isolated world.
      // The real controls, their values in the page world, and selector refs stay intact.
      const ariaSnapshot = injected.ariaSnapshot.bind(injected);
      injected.ariaSnapshot = (node, snapshotOptions) => {
        const restore = [];
        const mask = (prototype, key, shouldMask, maskedValue = "") => {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
          if (!descriptor?.get) throw new Error("Unable to mask browser field values");
          Object.defineProperty(prototype, key, {
            ...descriptor,
            get() { return shouldMask(this) ? maskedValue : descriptor.get.call(this); },
          });
          restore.push(() => Object.defineProperty(prototype, key, descriptor));
        };
        try {
          mask(HTMLInputElement.prototype, "value", masksInputValue);
          mask(HTMLTextAreaElement.prototype, "value", () => true);
          mask(HTMLOptionElement.prototype, "selected", () => true, false);
          mask(HTMLSelectElement.prototype, "selectedOptions", () => true, []);
          // Embedded accessible names fall back to the first option if none is selected.
          mask(HTMLSelectElement.prototype, "options", () => true, []);
          // The browser clones rich options into <selectedcontent>. Skip that subtree in
          // the snapshot and treat its elements as ignored even when referenced by ID.
          mask(Node.prototype, "nodeType", isSelectedContent, Node.COMMENT_NODE);
          mask(Element.prototype, "tagName", isSelectedContent, "TEMPLATE");
          // Clones can duplicate IDs. Resolve ARIA references to the original element.
          for (const prototype of [Document.prototype, DocumentFragment.prototype]) {
            for (const method of ["querySelector", "getElementById"]) {
              const original = prototype[method];
              prototype[method] = function (query) {
                const first = original.call(this, query);
                if (!isSelectedContent(first)) return first;
                const selector = method === "getElementById" ? "#" + CSS.escape(query) : query;
                return Array.from(this.querySelectorAll(selector)).find((element) => !isSelectedContent(element)) ?? null;
              };
              restore.push(() => { prototype[method] = original; });
            }
          }
          mask(Node.prototype, "nodeValue", (node) => node.nodeType === Node.TEXT_NODE && isEditableText(node));
          mask(Node.prototype, "textContent", isEditableText);
          const getAttribute = Element.prototype.getAttribute;
          Element.prototype.getAttribute = function (name) {
            // Embedded range controls use ARIA value attributes or the HTML value fallback for their name.
            if (name === "aria-valuetext" || name === "aria-valuenow"
              || (name === "value" && ((this instanceof HTMLInputElement && masksInputValue(this))
                || this.matches("[role='slider'],[role='spinbutton'],[role='scrollbar'],[role='progressbar']")))) return null;
            return getAttribute.call(this, name);
          };
          restore.push(() => { Element.prototype.getAttribute = getAttribute; });
          return ariaSnapshot(node, snapshotOptions);
        } finally {
          for (const reset of restore.reverse()) reset();
        }
      };
      globalThis.${PLAYWRIGHT_GLOBAL} = injected;
      return true;
    } catch (error) {
      return {
        __cyrenePlaywrightError: {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
          stack: String(error?.stack || ""),
        },
      };
    }
  })()`;
}

const SNAPSHOT_SCRIPT = `(() => {
  try {
  const injected = globalThis.${PLAYWRIGHT_GLOBAL};
  const root = document.body || document.documentElement;
  if (!injected || !root) throw new Error("Playwright snapshot runtime is unavailable");

  const snapshot = injected.ariaSnapshot(root, { mode: "ai" });
  const refs = new Map();
  const elements = [];
  const lines = String(snapshot || "").split("\\n");
  const seen = new Set();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  for (const line of lines) {
    const match = line.match(/\\[ref=([^\\]]+)\\]/);
    if (!match || seen.has(match[1])) continue;
    const ref = match[1];
    seen.add(ref);
    let element;
    try {
      const selector = injected.parseSelector("aria-ref=" + ref);
      element = injected.querySelectorAll(selector, root)[0];
    } catch {
      continue;
    }
    if (!element) continue;

    refs.set(ref, element);
    const rect = element.getBoundingClientRect();
    const tag = element.localName || "";
    const href = element instanceof HTMLAnchorElement ? element.href : "";
    const contextContainer = element.closest("tr,[role='row'],li,[role='listitem'],article,[role='article'],[role='dialog']");
    const contextText = contextContainer && contextContainer !== element
      ? String(globalThis.__cyreneBrowserPublicText(contextContainer)).replace(/\\s+/g, " ").trim()
      : "";
    const attributes = {};
    for (const name of ["aria-label", "aria-labelledby", "title", "alt", "placeholder", "type", "name", "href", "data-testid"]) {
      const value = element.getAttribute?.(name);
      if (value) attributes[name] = String(value);
    }

    elements.push({
      ref,
      description: line.trim().replace(/^[-*]\\s*/, "").replace(/\\s*\\[ref=[^\\]]+\\]/, ""),
      tag,
      ...(href && /^https?:/i.test(href) ? { href } : {}),
      ...(contextText ? { context: contextText } : {}),
      bounds: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      inViewport: rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0,
      disabled: Boolean(element.disabled || element.getAttribute?.("aria-disabled") === "true"),
      ...(element.id ? { id: String(element.id) } : {}),
      classes: Array.from(element.classList || []).map((name) => String(name)),
      attributes,
    });
  }

  elements.sort((left, right) => Number(Boolean(right.inViewport)) - Number(Boolean(left.inViewport)));
  globalThis.__cyreneBrowserObservationId = "__CYRENE_OBSERVATION_ID__";
  globalThis.__cyreneBrowserRefs = refs;
  globalThis.__cyreneBrowserSnapshotText = String(snapshot || "");
  return {
    observationId: globalThis.__cyreneBrowserObservationId,
    ariaSnapshot: String(snapshot || ""),
    elements,
    totalReferences: elements.length,
    note: "ariaSnapshot 是已隐藏表单输入值的 Playwright 语义树；ref 与树中的编号对应。",
  };
  } catch (error) {
    return {
      __cyrenePlaywrightError: {
        name: String(error?.name || "Error"),
        message: String(error?.message || error),
        stack: String(error?.stack || ""),
      },
    };
  }
})()`;

const START_ELEMENT_PICKER_SCRIPT = `(() => {
  const previous = globalThis.__cyreneBrowserElementPicker;
  if (previous?.cleanup) previous.cleanup();
  const injected = globalThis.${PLAYWRIGHT_GLOBAL};
  if (!injected || !document.documentElement) return { ok: false };
  let hovered = null;
  let selected = null;
  const savedStyles = new WeakMap();
  const restoreOutline = (element) => {
    const saved = element && savedStyles.get(element);
    if (!saved) return;
    for (const [name, value, priority] of saved) {
      if (value) element.style.setProperty(name, value, priority);
      else element.style.removeProperty(name);
    }
    savedStyles.delete(element);
  };
  const highlight = (element) => {
    if (!element || element === document.documentElement || element === document.body) return;
    if (hovered !== element) {
      restoreOutline(hovered);
      hovered = element;
      savedStyles.set(element, ["outline", "outline-offset", "box-shadow"].map((name) => [
        name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name),
      ]));
      element.style.setProperty("outline", "2px solid #ff4f91", "important");
      element.style.setProperty("outline-offset", "2px", "important");
      element.style.setProperty("box-shadow", "0 0 0 4px rgba(255,79,145,.25)", "important");
    }
  };
  const onMove = (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const element = path.find((item) => item instanceof Element) || (event.target instanceof Element ? event.target : null);
    highlight(element);
  };
  const onClick = (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    let element = path.find((item) => item instanceof Element) || (event.target instanceof Element ? event.target : null);
    if (!element || element === document.documentElement || element === document.body) return;
    const selectedContent = element.closest("select selectedcontent");
    if (selectedContent) element = selectedContent.closest("select");
    event.preventDefault();
    event.stopImmediatePropagation();
    const refs = globalThis.__cyreneBrowserRefs;
    let ref = "";
    if (refs instanceof Map) {
      let candidateNode = element;
      while (candidateNode && candidateNode !== document.body) {
        for (const [candidate, node] of refs) {
          if (node === candidateNode) {
            ref = String(candidate);
            element = candidateNode;
            break;
          }
        }
        if (ref) break;
        candidateNode = candidateNode.parentElement;
      }
    }
    const rawSnapshot = String(globalThis.__cyreneBrowserSnapshotText || "");
    const snapshotLines = rawSnapshot.split("\\n");
    const selectedLineIndex = ref
      ? snapshotLines.findIndex((candidate) => candidate.includes("[ref=" + ref + "]"))
      : -1;
    const line = selectedLineIndex >= 0 ? snapshotLines[selectedLineIndex] : "";
    const snapshotContext = [];
    if (selectedLineIndex >= 0) {
      const indentation = (value) => value.length - value.trimStart().length;
      const selectedIndentation = indentation(line);
      for (let index = selectedLineIndex - 1; index >= 0; index -= 1) {
        const candidate = snapshotLines[index];
        if (!candidate.trim()) continue;
        if (indentation(candidate) < selectedIndentation) snapshotContext.unshift(candidate);
      }
      snapshotContext.push(line);
    }
    const semantic = line || String(injected.ariaSnapshot(element, { mode: "ai" }) || "").split("\\n")[0] || element.localName;
    const rect = element.getBoundingClientRect();
    const attributes = {};
    for (const name of ["aria-label", "aria-labelledby", "title", "alt", "placeholder", "type", "name", "href", "data-testid", "role"]) {
      const value = element.getAttribute(name);
      if (value) attributes[name] = String(value);
    }
    const style = getComputedStyle(element);
    const computedStyle = {};
    for (const name of ["display", "position", "color", "backgroundColor", "fontFamily", "fontSize", "fontWeight", "lineHeight", "margin", "padding", "width", "height", "borderRadius"]) {
      computedStyle[name] = String(style[name] || "");
    }
    const text = String(globalThis.__cyreneBrowserPublicText(element)).replace(/\\s+/g, " ").trim();
    const name = String(element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("alt") || text || element.localName).slice(0, 240);
    selected = {
      observationId: globalThis.__cyreneBrowserObservationId,
      ref: ref || undefined,
      name,
      snapshotLine: line || semantic.trim(),
      ...(snapshotContext.length > 0 ? { snapshotContext } : {}),
      tag: String(element.localName || ""),
      id: element.id ? String(element.id) : undefined,
      classes: Array.from(element.classList || []).map((item) => String(item)),
      attributes,
      bounds: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      computedStyle,
    };
    cleanup(false);
  };
  const onKey = (event) => {
    if (event.key === "Escape") cleanup(true);
  };
  function cleanup(cancelled) {
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    restoreOutline(hovered);
    hovered = null;
    if (globalThis.__cyreneBrowserElementPicker) {
      globalThis.__cyreneBrowserElementPicker.active = false;
      globalThis.__cyreneBrowserElementPicker.cancelled = Boolean(cancelled);
      globalThis.__cyreneBrowserElementPicker.selected = selected;
      globalThis.__cyreneBrowserElementPicker.cleanup = null;
    }
  }
  globalThis.__cyreneBrowserElementPicker = { active: true, cancelled: false, selected: null, cleanup };
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  return { ok: true };
})()`;

const READ_ELEMENT_PICKER_SCRIPT = `(() => {
  const picker = globalThis.__cyreneBrowserElementPicker;
  if (!picker) return { active: false, cancelled: true };
  return { active: Boolean(picker.active), cancelled: Boolean(picker.cancelled), selected: picker.selected || null };
})()`;

const CANCEL_ELEMENT_PICKER_SCRIPT = `(() => {
  const picker = globalThis.__cyreneBrowserElementPicker;
  if (picker?.cleanup) picker.cleanup(true);
  return true;
})()`;

function wrapRuntimeScript(script: string): string {
  return `(() => {
    try {
      const run = new Function("return (" + ${JSON.stringify(script)} + ");");
      return run();
    } catch (error) {
      return {
        __cyrenePlaywrightError: {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
          stack: String(error?.stack || ""),
        },
      };
    }
  })()`;
}

function throwIfRuntimeError(stage: string, result: unknown): void {
  if (!result || typeof result !== "object") return;
  const runtimeError = (result as {
    __cyrenePlaywrightError?: { name?: string; message?: string; stack?: string };
  }).__cyrenePlaywrightError;
  if (!runtimeError) return;
  const detail = [runtimeError.name, runtimeError.message].filter(Boolean).join(": ");
  const stack = runtimeError.stack ? `\n${runtimeError.stack}` : "";
  throw new Error(`Playwright ${stage} 脚本异常：${detail}${stack}`);
}

export function resetPlaywrightPageSnapshot(contents: WebContents): void {
  initializedContents.delete(contents);
}

export async function capturePlaywrightPageSnapshot(contents: WebContents): Promise<RuntimeSnapshot> {
  if (!initializedContents.has(contents)) {
    const initialization = await contents.executeJavaScriptInIsolatedWorld(PLAYWRIGHT_WORLD_ID, [
      { code: wrapRuntimeScript(buildInitializationScript()) },
    ]);
    throwIfRuntimeError("初始化", initialization);
    initializedContents.add(contents);
  }
  const observationId = randomUUID();
  const snapshot = await contents.executeJavaScriptInIsolatedWorld(PLAYWRIGHT_WORLD_ID, [
    { code: wrapRuntimeScript(SNAPSHOT_SCRIPT.replace("__CYRENE_OBSERVATION_ID__", observationId)) },
  ]);
  throwIfRuntimeError("页面快照", snapshot);
  const result = snapshot as Partial<RuntimeSnapshot> | null;
  if (!result || typeof result.ariaSnapshot !== "string" || !Array.isArray(result.elements)
    || typeof result.totalReferences !== "number") {
    throw new Error("Playwright 页面快照脚本没有返回有效快照");
  }
  return { ...result, observationId } as RuntimeSnapshot;
}

/** Validate the original node kept in the same isolated world as Playwright's aria-ref map. */
export async function validatePlaywrightSnapshotTarget(
  contents: WebContents,
  input: { observationId: string; ref: string; description: string; x: number; y: number },
): Promise<{ ok: true; x: number; y: number } | { ok: false }> {
  const serialized = JSON.stringify(input);
  const result = await contents.executeJavaScriptInIsolatedWorld(PLAYWRIGHT_WORLD_ID, [{
    code: `(() => {
      const expected = ${serialized};
      const refs = globalThis.__cyreneBrowserRefs;
      if (globalThis.__cyreneBrowserObservationId !== expected.observationId || !(refs instanceof Map)) return { ok: false };
      const node = refs.get(expected.ref);
      if (!(node instanceof Element) || !node.isConnected) return { ok: false };
      const injected = globalThis.${PLAYWRIGHT_GLOBAL};
      if (!injected) return { ok: false };
      const currentLine = String(injected.ariaSnapshot(node, { mode: "ai" }) || "").split("\\n")[0]
        .trim().replace(/^[-*]\\s*/, "").replace(/\\s*\\[ref=[^\\]]+\\]/, "");
      if (currentLine !== expected.description) return { ok: false };
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      if (node.matches(":disabled") || node.getAttribute("aria-disabled") === "true") return { ok: false };
      if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none") return { ok: false };
      let hit = document.elementFromPoint(expected.x, expected.y);
      for (let depth = 0; hit && depth < 8; depth += 1, hit = hit.parentElement) {
        if (hit === node) return { ok: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      }
      return { ok: false };
    })()`,
  }]);
  return result && typeof result === "object" && (result as { ok?: boolean }).ok === true
    ? result as { ok: true; x: number; y: number }
    : { ok: false };
}

export async function startPlaywrightElementPicker(contents: WebContents): Promise<RuntimeSnapshot> {
  const snapshot = await capturePlaywrightPageSnapshot(contents);
  const result = await contents.executeJavaScriptInIsolatedWorld(PLAYWRIGHT_WORLD_ID, [
    { code: wrapRuntimeScript(START_ELEMENT_PICKER_SCRIPT) },
  ]);
  throwIfRuntimeError("启动元素选择", result);
  if (!result || typeof result !== "object" || (result as { ok?: boolean }).ok !== true) {
    throw new Error("无法在当前页面启动元素选择");
  }
  return snapshot;
}

export async function readPlaywrightElementPicker(contents: WebContents): Promise<{
  active: boolean;
  cancelled: boolean;
  selected?: Omit<import("../../shared/browser-panel-types").BrowserElementSelection, "tabId" | "pageUrl" | "pageTitle"> | null;
}> {
  const result = await contents.executeJavaScriptInIsolatedWorld(PLAYWRIGHT_WORLD_ID, [
    { code: wrapRuntimeScript(READ_ELEMENT_PICKER_SCRIPT) },
  ]);
  throwIfRuntimeError("读取元素选择", result);
  return result as { active: boolean; cancelled: boolean; selected?: Omit<import("../../shared/browser-panel-types").BrowserElementSelection, "tabId" | "pageUrl" | "pageTitle"> | null };
}

export async function cancelPlaywrightElementPicker(contents: WebContents): Promise<void> {
  if (contents.isDestroyed()) return;
  const result = await contents.executeJavaScriptInIsolatedWorld(PLAYWRIGHT_WORLD_ID, [
    { code: wrapRuntimeScript(CANCEL_ELEMENT_PICKER_SCRIPT) },
  ]);
  throwIfRuntimeError("取消元素选择", result);
}
