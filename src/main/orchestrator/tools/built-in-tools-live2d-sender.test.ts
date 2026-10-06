// play_live2d_action 的 sender 接线回归测试。
//
// built-in-tools.ts 在模块求值时就把工具塞进 registry，而组合根
// （default-dependencies 的 startCore）要到运行时才调用 setLive2dWindowSender。
// 注册时若把 `sendToLive2DWindow` 变量本身交给工具，工具会永久持有那一刻的空
// 实现：动作既不报错也不送达，模型侧还收到 ok:true。
//
// 本测试在 import 完成之后才接线 —— 正好是真实启动的顺序，因此能锁住这层
// 隐式的先后依赖。

import { describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc-channels";
import { toolRegistry } from "./registry/tool-registry";
import { setLive2dWindowSender } from "./built-in-tools";

describe("built-in-tools 的 Live2D sender 接线", () => {
  it("用 setLive2dWindowSender 之后写入的发送器，而非注册时刻的快照", async () => {
    const send = vi.fn();
    setLive2dWindowSender(send);

    const tool = toolRegistry.getById("play_live2d_action");
    expect(tool, "play_live2d_action 应已注册").toBeDefined();

    const raw = await tool!.execute({ name: "眨眨眼" });

    expect(JSON.parse(raw)).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(IPC.LIVE2D_PLAY_ACTION, {
      kind: "motion",
      group: "动作#6",
      motionName: "Wink~",
    });
  });
});
