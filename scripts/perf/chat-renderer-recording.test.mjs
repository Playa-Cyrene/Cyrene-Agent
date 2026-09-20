import assert from "node:assert/strict";
import test from "node:test";
import { createRecordingContextOptions, recordingFileName } from "./chat-renderer-recording.mjs";

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
