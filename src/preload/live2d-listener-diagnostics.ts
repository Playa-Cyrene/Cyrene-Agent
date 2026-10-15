import { IPC } from "../shared/ipc-channels";

export const LIVE2D_IPC_DIAGNOSTIC_CHANNELS = [
  IPC.LIVE2D_SPEECH_PREPARE,
  IPC.LIVE2D_MOUTH_START,
  IPC.LIVE2D_MOUTH_STOP,
  IPC.PET_ZOOM,
  IPC.PET_VISIBILITY_CHANGED,
] as const;

export type Live2DIpcListenerCounts = Record<typeof LIVE2D_IPC_DIAGNOSTIC_CHANNELS[number], number>;

export function getLive2DIpcListenerCounts(ipcRenderer: { listenerCount: (channel: string) => number }): Live2DIpcListenerCounts {
  return Object.fromEntries(
    LIVE2D_IPC_DIAGNOSTIC_CHANNELS.map((channel) => [channel, ipcRenderer.listenerCount(channel)]),
  ) as Live2DIpcListenerCounts;
}
