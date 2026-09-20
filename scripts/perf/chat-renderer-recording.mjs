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
