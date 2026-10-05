import type { ImageMessageAttachment } from "./chat-types";

/** 临时模型输出，只能在主进程保存前短暂存在，禁止写入轨迹或前端事件。 */
export interface GeneratedImageOutput {
  id: string;
  toolCallId: string;
  base64: string;
  mime: "image/png";
}

/** 已落盘的模型图片引用，可写入权威助手消息并传给界面。 */
export interface GeneratedImageAttachment extends ImageMessageAttachment {
  id: string;
  source: "model";
  byteLength: number;
  status: "done";
}
