// @vitest-environment jsdom
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { Button } from "antd";
import { SettingsSearch } from "./SettingsSearch";
import { MemorySettingsPanel } from "./MemorySettingsPanel";
import { AsrSettingsPanel } from "./AsrSettingsPanel";
import { TtsSettingsPanel } from "./TtsSettingsPanel";
import { AppProviders } from "../../app/providers/AppProviders";
import type { SettingsSection } from "./AppearanceSettingsPage";
import { buildCatalogEntries, buildSettingEntries, searchSettings } from "./settingsSearchIndex";

vi.mock("@lobehub/icons", () => {
  const Icon = Object.assign(() => null, { Color: () => null });
  return Object.fromEntries(["MCP", "Anthropic", "DeepSeek", "Doubao", "Gemini", "Grok", "Minimax", "Kimi", "OpenAI", "Qwen", "XiaomiMiMo", "Zhipu"].map(name => [name, Icon]));
});
vi.mock("@lobehub/ui/icons", () => ({ Lark: () => null }));

const w = window as any;
let host: HTMLDivElement;
let root: Root;
function Harness({ children, section }: { children?: React.ReactNode; section: SettingsSection }) {
  const content = useRef<HTMLElement>(null);
  return <><SettingsSearch section={section} onSelectSection={() => {}} getContentRoot={() => content.current} /><main ref={content}>{children}</main></>;
}
async function mount(children?: React.ReactNode, section: SettingsSection = "general") {
  await act(async () => { root.render(<AppProviders><Harness section={section}>{children}</Harness></AppProviders>); });
}
async function fill(value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>(".cy-settings-search__input")!;
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function pick(label: string) {
  const items = [...host.querySelectorAll<HTMLButtonElement>(".cy-settings-search__item")];
  const result = items.find(item => item.querySelector(".cy-settings-search__item-label")?.textContent === label);
  expect(result, `搜索应包含 ${label}`).toBeTruthy();
  await act(async () => { result!.click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(350); });
}
const flashed = () => host.querySelector(".cy-settings-search-flash-host");

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.scrollTo = vi.fn();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  await i18next.changeLanguage("zh-CN");
  w.plugins = { list: async () => [] };
  w.settings = { getToolCatalog: async () => [], getSkillCatalog: async () => [], getConfig: async () => ({memoryMode: "vector"}) };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); host.remove();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  delete w.memoryPanel; delete w.tts;
});

describe("独立预期：高亮不能丢字符、错位或重复原文", () => {
  it("忽略大小写不能把日文清音与浊音当作同一个词", () => {
    const entries = buildCatalogEntries([{id:'japanese-label',name:'ガス設定',enabled:true}], 'tool', 'toolToggle');
    expect(searchSettings(entries,'カス設定')).toEqual([]);
  });
  it.each([
    ["🤖Alpha", "Alpha", "Alpha"],
    ["🤖Alpha", "🤖", "🤖"],
    ["前🤖后🤖尾", "🤖", "🤖|🤖"],
    ["ΟΣ", "ΟΣ", "ΟΣ"],
    ["I\u0307stanbul", "istanbul", "I\u0307stanbul"],
    ["가", "ᄀ", "가"],
  ])("%s 搜索 %s 的原文切片", async (label, query, expected) => {
    w.settings.getToolCatalog = async () => [{ id: "independent-unicode", name: label, enabled: true }];
    await mount(); await fill(query);
    const rendered = host.querySelector(".cy-settings-search__item-label");
    expect(rendered?.textContent).toBe(label);
    expect([...rendered!.querySelectorAll("mark")].map(node => node.textContent).join("|")).toBe(expected);
  });
});

describe("独立预期：文本近似不能改变身份", () => {
  it("A B 与 AB 是两个不同设置，不能删除空格后闪错行", async () => {
    i18next.addResource("zh-CN", "translation", "settingsPage.general.auditSpaceA", "独立 A B");
    i18next.addResource("zh-CN", "translation", "settingsPage.general.auditSpaceB", "独立 AB");
    await mount(<div className="cy-settings-row"><span>独立 AB</span></div>);
    await fill("独立 A B"); await pick("独立 A B"); expect(flashed()).toBeNull();
  });
  it("真实 antd 两字按钮仍应能安全定位", async () => {
    i18next.addResource("zh-CN", "translation", "settingsPage.general.auditTwoHan", "核验");
    await mount(<div id="han-row" className="cy-settings-row"><Button>核验</Button></div>);
    await fill("核验"); await pick("核验"); expect(flashed()?.id, host.querySelector('#han-row')?.outerHTML).toBe("han-row");
  });
  it("同一个 key 同时出现两次时不能任意闪第一行", async () => {
    i18next.addResource("zh-CN", "translation", "settingsPage.general.auditRepeatedKey", "重复身份独立测试");
    await mount(<>{[1,2].map(id => <div key={id} className="cy-settings-row"><span data-settings-search-key="settingsPage.general.auditRepeatedKey">重复身份独立测试</span></div>)}</>);
    await fill("重复身份独立测试"); await pick("重复身份独立测试"); expect(flashed()).toBeNull();
  });
  it("同一行父子重复身份标记仍可定位", async () => {
    i18next.addResource('zh-CN','translation','settingsPage.general.auditNestedKey','同一行嵌套标记');
    await mount(<label id="nested-row" data-settings-search-key="settingsPage.general.auditNestedKey"><span data-settings-search-key="settingsPage.general.auditNestedKey">同一行嵌套标记</span><input/></label>);
    await fill('同一行嵌套标记'); await pick('同一行嵌套标记'); expect(flashed()?.id).toBe('nested-row');
  });
});

describe("真实数据条件：必须指出具体控件，不能由定位算法给自己判分", () => {
  it("记忆两张卡片都有编辑按钮时不能把同一 key 任意解释为 L0", async () => {
    w.memoryPanel = {getData: async () => ({l0:{},l1:{},reflections:[],events:[]}),getVaultConfig: async () => ({}),getSummaryMemory: async () => ({})};
    await mount(<MemorySettingsPanel/>, 'memory');
    expect(host.querySelectorAll('main [data-settings-search-key="settingsPage.memory.edit"]')).toHaveLength(2);
    await fill('编辑'); await pick('编辑'); expect(flashed()).toBeNull();
  });
  it.each([['gptsovits','gptUrl'],['custom-cloud','endpointUrl']])("TTS %s 的服务地址只定位对应分支", async (engine, suffix) => {
    const saveSettings = vi.fn(); w.tts = {loadSettings: async () => ({ttsEngine:engine}), saveSettings};
    await mount(<TtsSettingsPanel/>, "tts");
    const settingKey = `settingsPage.tts.${suffix}`;
    const target = host.querySelector(`main [data-settings-search-key="${settingKey}"]`)?.closest('label');
    expect(target).toBeTruthy();
    const label = String(i18next.t(settingKey));
    const siblings = buildSettingEntries(i18next.getResourceBundle('zh-CN','translation')).filter(entry => entry.section === 'tts' && entry.label === label);
    await fill(label);
    const options = [...host.querySelectorAll<HTMLButtonElement>('.cy-settings-search__item')].filter(item => item.querySelector('.cy-settings-search__item-label')?.textContent === label);
    expect(options).toHaveLength(siblings.length);
    await act(async () => { options[siblings.findIndex(entry => entry.settingKey === settingKey)].click(); await vi.advanceTimersByTimeAsync(350); });
    expect(flashed()).toBe(target); expect(saveSettings).not.toHaveBeenCalled();
    await fill(label);
    const newOptions = [...host.querySelectorAll<HTMLButtonElement>('.cy-settings-search__item')].filter(item => item.querySelector('.cy-settings-search__item-label')?.textContent === label);
    await act(async () => { newOptions[siblings.findIndex(entry => entry.settingKey !== settingKey)].click(); await vi.advanceTimersByTimeAsync(350); });
    expect(flashed()).toBeNull(); expect(saveSettings).not.toHaveBeenCalled();
  });
  it.each(["l0", "l1"] as const)("记忆 %s 编辑态的保存必须定位且不能执行保存", async tier => {
    const save = vi.fn();
    w.memoryPanel = {
      getData: async () => ({l0: {preferredName:"用户名称不索引917",occupation:"",longTermInterests:"",language:"",permanentNote:""},l1:{recentGoals:"",recentPreferences:"",currentProject:""},reflections:[],events:[]}),
      getVaultConfig: async () => ({path:"",autoSync:false}), getSummaryMemory: async () => ({}), saveL0: save, saveL1: save,
    };
    await mount(<MemorySettingsPanel/>, "memory");
    const editButtons = host.querySelectorAll<HTMLButtonElement>('main [data-settings-search-key="settingsPage.memory.edit"]');
    expect(editButtons).toHaveLength(2);
    await act(async () => { editButtons[tier === "l0" ? 0 : 1].click(); });
    const saveButton = host.querySelector('main [data-settings-search-key="settingsPage.memory.save"]');
    expect(saveButton).not.toBeNull(); await fill("保存"); await pick("保存");
    expect(flashed() === saveButton || flashed()?.contains(saveButton)).toBe(true); expect(save).not.toHaveBeenCalled();
    await fill("用户名称不索引917"); expect(host.querySelector(".cy-settings-search__item")).toBeNull();
  });
  it("ASR 预先选择阿里云时能定位语言行，搜索不写设置", async () => {
    const saveSettings = vi.fn(); w.tts = {loadSettings: async () => ({asrEngine:"aliyun"}), saveSettings};
    await mount(<AsrSettingsPanel/>, "asr");
    const target = [...host.querySelectorAll("main label")].find(label => label.querySelector("span")?.textContent === i18next.t("settingsPage.asr.language"));
    expect(target).toBeTruthy(); await fill(String(i18next.t("settingsPage.asr.language"))); await pick(String(i18next.t("settingsPage.asr.language")));
    expect(flashed()).toBe(target); expect(saveSettings).not.toHaveBeenCalled();
  });
});

describe("用户填写内容不得借目录进入索引", () => {
  it("宿主排除标记覆盖名称、说明与 ID，同时保留内置工具", () => {
    const items = [{id:'private-id',name:'private-name',description:'private-description',settingsSearchable:false}, {id:'builtin-id',name:'正常内置工具',description:'正常工具说明'}];
    const entries = buildCatalogEntries(items,'tool','toolToggle');
    expect(searchSettings(entries,'private')).toEqual([]);
    expect(searchSettings(entries,'正常')).toHaveLength(1);
  });
  it("用户技能的 frontmatter 名称、说明、目录 id 不得被索引", () => {
    const user = {id:"private-user-skill-917",name:"用户填写技能名917",description:"用户填写技能描述917",source:"user",enabled:true};
    const entries = buildCatalogEntries([user], "skill", "skill");
    for (const query of [user.id,user.name,user.description]) expect(searchSettings(entries,query)).toEqual([]);
  });
  it("MCP 工具名拼入的用户服务器名称不得被索引", async () => {
    // 负载结构来自 mcp-adapter 与 TOOL_GET_CATALOG；不使用或读取真实用户配置。
    w.settings.getToolCatalog = async () => [{id:"mcp-user917-read",name:"[用户填写服务器名917] read",description:"读取",enabled:true,settingsSearchable:false}];
    await mount(); await fill("用户填写服务器名917"); expect(host.querySelector(".cy-settings-search__item")).toBeNull();
  });
  it("用户技能说明也不能在真实结果列表中展示", async () => {
    w.settings.getSkillCatalog = async () => [{id:'user-skill-917',name:'用户填写名称917',description:'用户填写技能正文摘要917',source:'user',enabled:true}];
    await mount(); await fill('用户填写技能正文摘要917'); expect(host.querySelector('.cy-settings-search__item')).toBeNull();
  });
});

describe("截断提示必须由真实组件证明", () => {
  it.each(['zh-CN','en','ja-JP'])("%s 显示剩余数量，缩小查询后移除提示", async locale => {
    await i18next.changeLanguage(locale);
    w.settings.getToolCatalog = async () => Array.from({length:45},(_,i)=>({id:`count-${i}`,name:`CountFixture${String(i).padStart(2,'0')}`,enabled:true}));
    await mount(); await fill('CountFixture');
    expect(host.querySelector('[role="status"]')?.textContent).toBe(i18next.t('settingsPage.search.more',{count:5}));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('5');
    await fill('CountFixture00'); expect(host.querySelectorAll('.cy-settings-search__item')).toHaveLength(1); expect(host.querySelector('[role="status"]')).toBeNull();
  });
  it("45 个已知命中只显示 40 个时必须有可见的额外结果提示", async () => {
    w.settings.getToolCatalog = async () => Array.from({length:45},(_,i)=>({id:`limit-${i}`,name:`独立截断样本${String(i).padStart(2,'0')}`,enabled:true}));
    await mount(); await fill('独立截断样本');
    expect(host.querySelectorAll('.cy-settings-search__item')).toHaveLength(40);
    const notice = host.querySelector('.cy-settings-search [role="status"], .cy-settings-search [aria-live]');
    expect(notice, '45 个命中被截断，但组件没有结果数量提示').not.toBeNull();
    expect(notice?.textContent).toMatch(/更多|还有|剩余|more|45|5/);
  });
});
