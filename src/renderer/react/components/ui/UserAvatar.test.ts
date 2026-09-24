// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserAvatar } from "./UserAvatar";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];

async function renderAvatar() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(createElement(UserAvatar)); });
  return host;
}

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { user?: unknown }).user;
  vi.restoreAllMocks();
});

describe("UserAvatar profile dialog", () => {
  it("opens the profile editor from the sidebar identity and loads existing profile data", async () => {
    Object.assign(window, {
      user: {
        getProfile: vi.fn(async () => ({
          nickname: "小昔", gender: "female", callPreference: "阿澄", birthday: "2000-06-18",
          defaultCity: "上海", timezone: "Asia/Shanghai",
        })),
        getAvatar: vi.fn(async () => null),
        onProfileChanged: vi.fn(() => () => {}),
        onAvatarChanged: vi.fn(() => () => {}),
        saveProfile: vi.fn(async () => ({ ok: true })),
        uploadAvatar: vi.fn(async () => ({ avatarPath: null })),
      },
    });

    const host = await renderAvatar();
    const trigger = host.querySelector<HTMLButtonElement>(".cy-user-avatar__trigger");
    expect(trigger).not.toBeNull();
    await act(async () => { trigger!.click(); });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("我的信息");
    expect(dialog?.querySelector<HTMLInputElement>('input[name="nickname"]')?.value).toBe("小昔");
    expect(dialog?.querySelector<HTMLInputElement>('input[name="defaultCity"]')?.value).toBe("上海");
    const birthdayPicker = dialog?.querySelector<HTMLButtonElement>('[data-testid="birthday-picker"]');
    expect(birthdayPicker?.textContent).toContain("2000");
    await act(async () => { birthdayPicker!.click(); });
    expect(document.querySelector(".cy-user-profile__calendar-popover .rdp-root")).not.toBeNull();

    const save = Array.from(dialog!.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "保存");
    await act(async () => { save!.click(); });
    expect((window as typeof window & { user: { saveProfile: ReturnType<typeof vi.fn> } }).user.saveProfile).toHaveBeenCalledWith({
      nickname: "小昔", gender: "female", callPreference: "阿澄", birthday: "2000-06-18",
      defaultCity: "上海", timezone: "Asia/Shanghai",
    });
  });
});
