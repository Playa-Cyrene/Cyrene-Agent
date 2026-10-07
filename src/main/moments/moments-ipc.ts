// Moments（动态 / 朋友圈）IPC 桥接：把 moments-service 的门面 API 暴露给渲染进程。
//
// Actor 边界（不信任 renderer）：
// - renderer 发起的 createPost / createComment / toggleLike 一律强制 author/actor = "user"；
// - 昔涟发帖/点赞/评论走 moments-store 的昔涟内部通道，不经任何 IPC。
//
// 任何写操作成功后向所有窗口广播 moments:changed，由各窗口自行刷新（幂等）。

import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { MomentCreateCommentInput, MomentCreatePostInput } from "../../shared/moments-types";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { loadGeneralSettings } from "../settings/settings-facade";
import { loadCharacterPersonas } from "./character-personas";
import { momentsService } from "./moments-service";
import * as momentsStore from "./moments-store";

function logMoments(event: string, detail?: unknown): void {
  console.log(`[Moments] ${event}`, detail ?? "");
}

function broadcastChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(IPC.MOMENTS_CHANGED);
    } catch {
      // 某些刚创建/未 ready 的窗口 send 可能抛错，忽略即可
    }
  }
}

export async function registerMomentsIpc(ipcOption?: IpcScope): Promise<void> {
  const ipc = ipcOption ?? createIpcScope();
  // 读模型加载完成后才注册 handler：渲染端最早可触发的读不会撞上未就绪的缓存
  await momentsStore.initialize();
  momentsStore.onMomentsChanged(() => broadcastChanged());

  // 昔涟行为的提交时开关复核：AI 思考期间关闭开关时，迟到的结果被 moments_disabled 拒绝。
  // 反应（点赞/评论）受 cyreneMomentsReactionsEnabled 约束；
  // 主动发帖受 cyreneMomentsPostingEnabled 约束（提交时二道闸，与 service 前置闸互补）。
  momentsStore.setCyreneBehaviorGate((behavior) => {
    const settings = loadGeneralSettings();
    if (!settings.momentsEnabled) return false;
    if (behavior === "reaction") return settings.cyreneMomentsReactionsEnabled;
    if (behavior === "posting") return settings.cyreneMomentsPostingEnabled;
    return true;
  });

  // 角色行为的提交时开关复核：总开关 + 角色互动开关双闸。
  // 随机点赞不走决策阶段，这里是它唯一的开关防线（入队前闸门关掉的是"还没入队的"）。
  momentsStore.setCharacterBehaviorGate(() => {
    const settings = loadGeneralSettings();
    return settings.momentsEnabled && settings.momentsCharacterReactionsEnabled;
  });

  // 角色入驻名单：立绘池 ∩ 人设 md。store 只信任名单内的角色身份写入（渲染端无法伪造）。
  // 启动时先注册一次——重启后队列里存留的角色任务（如随机点赞）会先于任何抽签被扫描执行
  const characterRegistry = () => new Set(loadCharacterPersonas({ log: logMoments }).keys());
  momentsStore.setCharacterAuthorRegistry(characterRegistry());

  // 点名名单：渲染端选择框的数据源（昔涟 + 全部入驻角色，昵称按名排序）
  ipc.handle(IPC.MOMENTS_LIST_CHARACTERS, () => {
    const characters = [...characterRegistry()].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
    return ["cyrene", ...characters];
  });

  ipc.handle(IPC.MOMENTS_LIST, (_event, options?: { limit?: number; before?: number }) =>
    momentsService.listFeed(options));

  ipc.handle(IPC.MOMENTS_GET_POST, (_event, postId: string) =>
    typeof postId === "string" ? momentsService.getFeedItem(postId) : null);

  ipc.handle(IPC.MOMENTS_CREATE_POST, (_event, input: MomentCreatePostInput) =>
    momentsService.createUserPost(input));

  ipc.handle(IPC.MOMENTS_DELETE_POST, (_event, postId: string) =>
    typeof postId === "string"
      ? momentsService.deletePost(postId)
      : { applied: false, reason: "post_not_found" });

  ipc.handle(IPC.MOMENTS_CREATE_COMMENT, (_event, input: MomentCreateCommentInput) =>
    momentsService.createUserComment(input));

  ipc.handle(IPC.MOMENTS_TOGGLE_LIKE, (_event, postId: string) =>
    typeof postId === "string"
      ? momentsService.toggleUserLike(postId)
      : { applied: false, reason: "post_not_found" });
}
