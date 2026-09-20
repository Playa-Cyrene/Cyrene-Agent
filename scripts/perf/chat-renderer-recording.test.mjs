import assert from "node:assert/strict";
import test from "node:test";
import { createRecordingContextOptions, installLiveMessageFollow, recordingFileName } from "./chat-renderer-recording.mjs";

test("enables a fixed viewport and video capture only when an output directory is supplied", () => {
  assert.deepEqual(createRecordingContextOptions(undefined), {});
  assert.deepEqual(createRecordingContextOptions("C:/videos"), {
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: "C:/videos", size: { width: 1440, height: 900 } },
  });
});

test("gives each renderer replay a stable descriptive filename", () => {
  assert.equal(
    recordingFileName({ dataset: "markdown", count: 0, scroll: "bottom", streamRender: "animated" }, 1),
    "markdown-0-bottom-animated-run-1.webm",
  );
});

test("follows the live message only after the fixture enters streaming", () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalRaf = globalThis.requestAnimationFrame;
  const callbacks = [];
  const list = { scrollTop: 0, scrollHeight: 912 };

  try {
    globalThis.window = { __perfState: "hydrated" };
    globalThis.document = { querySelector: () => list };
    globalThis.requestAnimationFrame = (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    };

    installLiveMessageFollow();
    callbacks.shift()();
    assert.equal(list.scrollTop, 0);

    globalThis.window.__perfState = "streaming";
    callbacks.shift()();
    assert.equal(list.scrollTop, 912);
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.requestAnimationFrame = originalRaf;
  }
});
