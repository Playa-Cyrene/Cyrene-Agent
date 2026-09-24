import { describe, expect, it } from "vitest";
import {
  getProfileSelectableModels,
  resolveSessionProfileBinding,
  resolveEffectiveSessionModel,
  planSessionModelUpdate,
  type SessionModelSettingsView,
} from "./session-model";

// 测试档案：A/B 同 key 场景 + 默认档案 D（含与会话 raw model 同名的模型，验证不串档）
const SETTINGS: SessionModelSettingsView = {
  defaultModelProfileId: "D",
  modelProfiles: [
    { id: "A", model: "a1", models: ["a1", "a2", "shared-x"] },
    { id: "B", model: "b1", models: ["b1", "shared-x"] },
    { id: "D", model: "d1", models: ["d1", "d2", "shared-x"] },
  ],
};

describe("getProfileSelectableModels（①）", () => {
  it("多模型档案返回清单", () => {
    expect(getProfileSelectableModels({ model: "a1", models: ["a1", "a2"] })).toEqual(["a1", "a2"]);
  });

  it("单模型档案（无 models / 空清单）回退 [model]，与旧档案行为一致", () => {
    expect(getProfileSelectableModels({ model: "m" })).toEqual(["m"]);
    expect(getProfileSelectableModels({ model: "m", models: [] })).toEqual(["m"]);
    expect(getProfileSelectableModels({ model: "m", models: undefined })).toEqual(["m"]);
  });
});

describe("resolveSessionProfileBinding（② provenance）", () => {
  it("命中原绑定 → bindingMatched = true", () => {
    const binding = resolveSessionProfileBinding(SETTINGS, { modelProfileId: "B", model: "b1" });
    expect(binding).toMatchObject({ profile: { id: "B" }, resolvedProfileId: "B", bindingMatched: true });
  });

  it("绑定失效（档案已删）→ 回退默认档案链，bindingMatched = false", () => {
    const binding = resolveSessionProfileBinding(SETTINGS, { modelProfileId: "deleted", model: "x" });
    expect(binding).toMatchObject({ profile: { id: "D" }, resolvedProfileId: "D", bindingMatched: false });
  });

  it("旧会话无绑定 → 回退默认档案链，bindingMatched = false", () => {
    const binding = resolveSessionProfileBinding(SETTINGS, {});
    expect(binding).toMatchObject({ resolvedProfileId: "D", bindingMatched: false });
  });

  it("defaultModelProfileId 失效 → 回退首个档案", () => {
    const binding = resolveSessionProfileBinding(
      { ...SETTINGS, defaultModelProfileId: "deleted" },
      {},
    );
    expect(binding.resolvedProfileId).toBe("A");
  });

  it("一个档案都没有 → profile = undefined（消费方回退全局）", () => {
    const binding = resolveSessionProfileBinding({ modelProfiles: [] }, { modelProfileId: "A" });
    expect(binding).toEqual({ profile: undefined, resolvedProfileId: undefined, bindingMatched: false });
  });
});

describe("resolveEffectiveSessionModel（③ Invariant C）", () => {
  it("命中原绑定且模型在清单内 → 会话模型（对话自持）", () => {
    const binding = resolveSessionProfileBinding(SETTINGS, { modelProfileId: "A", model: "a2" });
    expect(resolveEffectiveSessionModel({ modelProfileId: "A", model: "a2" }, binding)).toBe("a2");
  });

  it("#14：session.model 指向绑定档案里不存在的模型 → 回退档案默认，不崩", () => {
    const binding = resolveSessionProfileBinding(SETTINGS, { modelProfileId: "A", model: "ghost" });
    expect(resolveEffectiveSessionModel({ modelProfileId: "A", model: "ghost" }, binding)).toBe("a1");
  });

  it("#19：绑定失效 → raw model 一并失效，即使回退档案含同名模型也不串档", () => {
    // 会话原绑 A（当前 shared-x）；A 被删后回退 D，D 恰好也有 shared-x——仍必须用 D 的默认
    const binding = resolveSessionProfileBinding(SETTINGS, { modelProfileId: "deleted-A", model: "shared-x" });
    expect(binding.bindingMatched).toBe(false);
    expect(resolveEffectiveSessionModel({ modelProfileId: "deleted-A", model: "shared-x" }, binding)).toBe("d1");
  });

  it("#25：legacy 会话无 model → 跟随档案默认（兼容性例外）", () => {
    const binding = resolveSessionProfileBinding(SETTINGS, { modelProfileId: "A" });
    expect(resolveEffectiveSessionModel({ modelProfileId: "A" }, binding)).toBe("a1");
  });

  it("无档案 → undefined", () => {
    const binding = resolveSessionProfileBinding({ modelProfiles: [] }, {});
    expect(resolveEffectiveSessionModel({}, binding)).toBeUndefined();
  });
});

describe("planSessionModelUpdate（窄 IPC validator + 决策 13 修复）", () => {
  it("命中绑定 + 清单成员 → 只写模型，绑定保持原值", () => {
    const plan = planSessionModelUpdate(SETTINGS, { modelProfileId: "A", model: "a1" }, "a2");
    expect(plan).toEqual({ ok: true, modelProfileId: "A", model: "a2" });
  });

  it("validator 不留旁门：非清单成员一律拒绝（单模型档案同样只认自己的默认）", () => {
    const single: SessionModelSettingsView = {
      modelProfiles: [{ id: "S", model: "glm-5.3" }],
    };
    expect(planSessionModelUpdate(single, { modelProfileId: "S" }, "whatever-i-want"))
      .toEqual({ ok: false, error: "invalid-model" });
    expect(planSessionModelUpdate(single, { modelProfileId: "S" }, "glm-5.3"))
      .toEqual({ ok: true, modelProfileId: "S", model: "glm-5.3" });
  });

  it("#24：stale binding 下主动选择 → 原子修复为回退档案 + 选中模型", () => {
    const plan = planSessionModelUpdate(SETTINGS, { modelProfileId: "deleted-A", model: "shared-x" }, "d2");
    expect(plan).toEqual({ ok: true, modelProfileId: "D", model: "d2" });
  });

  it("旧会话无绑定时的首次主动选择 → 修复为默认档案（进入快照语义）", () => {
    const plan = planSessionModelUpdate(SETTINGS, {}, "d1");
    expect(plan).toEqual({ ok: true, modelProfileId: "D", model: "d1" });
  });

  it("无任何档案 → no-profile", () => {
    expect(planSessionModelUpdate({ modelProfiles: [] }, {}, "m")).toEqual({ ok: false, error: "no-profile" });
  });
});
