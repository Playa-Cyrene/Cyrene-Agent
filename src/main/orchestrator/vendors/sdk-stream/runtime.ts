/** 主会话的流式执行已统一到 AI SDK；保留入口名供调用方使用。 */
export { streamChatWithAiSdk as streamChatWithSdk } from "../model-runtime";
export type { ModelRunInput as SdkStreamRunInput } from "../model-runtime";
