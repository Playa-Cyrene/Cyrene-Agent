export const VIDEO_SIZE = { width: 1440, height: 900 };

export function createRecordingContextOptions(recordVideoDir) {
  if (!recordVideoDir) {
    return {};
  }

  return {
    viewport: VIDEO_SIZE,
    recordVideo: {
      dir: recordVideoDir,
      size: VIDEO_SIZE,
    },
  };
}

export function recordingFileName({ dataset, count, scroll, streamRender }, runNumber) {
  return `${dataset}-${count}-${scroll}-${streamRender ?? "animated"}-run-${runNumber}.webm`;
}

/** 仅录像时注入：将视口固定在正在增长的最后一条消息上。 */
export function installLiveMessageFollow() {
  const follow = () => {
    if (globalThis.window?.__perfState === "streaming") {
      const list = globalThis.document.querySelector(".cy-message-list");
      if (list) list.scrollTop = list.scrollHeight;
    }
    globalThis.requestAnimationFrame(follow);
  };
  globalThis.requestAnimationFrame(follow);
}
