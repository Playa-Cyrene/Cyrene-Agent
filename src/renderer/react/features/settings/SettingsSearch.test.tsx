// @vitest-environment jsdom
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { SettingsSearch } from './SettingsSearch';
import { SETTINGS_NAV_ITEMS } from './settingsNavItems';
import { buildSettingEntries, buildCatalogEntries, buildPluginEntries, searchSettings } from './settingsSearchIndex';
import zh from '../../i18n/zh-CN.json';
import en from '../../i18n/en.json';
import { ToolToggleSettingsPanel } from './ToolToggleSettingsPanel';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { PluginModePanel } from '../chat/components/PluginModePanel';
import { AppProviders } from '../../app/providers/AppProviders';

// 图标入口间接导入浏览器专用 JSON；替身仅绕开无关资源，不替换待测面板。
vi.mock('@lobehub/icons',()=>{
 const Icon=Object.assign(()=>null,{Color:()=>null});
 return Object.fromEntries(['MCP','Anthropic','DeepSeek','Doubao','Gemini','Grok','Minimax','Kimi','OpenAI','Qwen','XiaomiMiMo','Zhipu'].map(name=>[name,Icon]));
});
// 挂载实际产品组件，IPC 使用隔离数据；模拟时钟和几何只验证行为，不代表像素验收。
let host: HTMLDivElement;
let root: Root;
let onSelect: ReturnType<typeof vi.fn>;
const w = window as any;
const tool = (id='read-file', name='读取文件', extra={}) => ({id,name,description:'按路径读取文本文件内容',enabled:true,modes:null,deprecated:null,...extra});
function setApis(extra: Record<string,unknown>={}) {
 w.plugins={list:vi.fn(async()=>({plugins:[],issues:[]}))};
 w.settings={getToolCatalog:vi.fn(async()=>[]),getSkillCatalog:vi.fn(async()=>[]),getToolModeOverrides:async()=>({}),getGeneral:async()=>({}),...extra};
}
function Harness({children,initial='appearance'}:any) {
 const [section,setSection]=useState(initial);
 const content=useRef<HTMLElement>(null);
 return <><aside className="cy-settings-sidebar"><SettingsSearch section={section} onSelectSection={(s)=>{onSelect(s);setSection(s)}} getContentRoot={()=>content.current}/></aside><main ref={content} data-section={section}>{children}</main></>;
}
async function mount(children:React.ReactNode=null,initial='appearance') {
 await act(async()=>{root.render(<Harness initial={initial}>{children}</Harness>)});
}
async function advance(ms:number) {await act(async()=>{await vi.advanceTimersByTimeAsync(ms)})}
function input(){return host.querySelector<HTMLInputElement>('input.cy-settings-search__input')!}
async function fill(value:string){await act(async()=>{input().focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input(),value);input().dispatchEvent(new Event('input',{bubbles:true}))})}
async function key(key:string,other:any={}){await act(async()=>{input().dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...other}))})}
function labels(){return [...host.querySelectorAll('.cy-settings-search__item-label')].map(x=>x.textContent)}
async function pick(label:string){const row=[...host.querySelectorAll<HTMLButtonElement>('.cy-settings-search__item')].find(x=>x.querySelector('.cy-settings-search__item-label')?.textContent===label);expect(row,'search result exists: '+label).toBeTruthy();await act(async()=>row!.click())}
const isActive=()=>!!host.querySelector('.cy-settings-search.is-active');
function row(label:string,id='target'){return <div id={id} className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{label}</strong><span>说明</span></div><button>控件</button></div>}

beforeEach(async()=>{
 (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
 w.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 (globalThis as any).ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
 w.scrollTo=vi.fn();
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout','requestAnimationFrame','cancelAnimationFrame','performance']});
 await i18next.changeLanguage('zh-CN');setApis();onSelect=vi.fn();
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks()});

describe('Controls: explicit intended behavior',()=>{
 it('C01 empty and whitespace searches display no list',async()=>{await mount();await fill('   ');expect(labels()).toEqual([]);expect(host.querySelector('.cy-settings-search__empty')).toBeNull()});
 it('C02 plugin ID matches, plugin description does not',async()=>{w.plugins.list=async()=>({plugins:[{id:'cyrene-hud',name:'桌面状态栏',description:'独特描述暗号'}]});await mount();await fill('cyrene-hud');expect(labels()).toContain('桌面状态栏');await fill('独特描述暗号');expect(labels()).toEqual([])});
 it('C03 deprecated tools excluded, tool descriptions searchable',async()=>{w.settings.getToolCatalog=async()=>[tool(),tool('old','旧工具',{deprecated:'read-file'})];await mount();await fill('读取文本');expect(labels()).toEqual(['读取文件']);await fill('旧工具');expect(labels()).toEqual([])});
 it('C04 casing, trimming, punctuation are literal and safe',async()=>{w.settings.getSkillCatalog=async()=>[{id:'PDF.[1]',name:'PDF [1] <img onerror=alert(1)>',description:'audit'}];await mount();await fill('  pdf  ');expect(labels()).toHaveLength(1);expect(host.querySelector('mark')?.textContent).toBe('PDF');expect(host.querySelector('img')).toBeNull();await fill('[1]');expect(labels()).toHaveLength(1)});
 it('C05 clear keeps search mode and input focus',async()=>{await mount();await fill('超时');await act(async()=>host.querySelector<HTMLButtonElement>('.cy-settings-search__clear')!.click());expect(input().value).toBe('');expect(isActive()).toBe(true);expect(document.activeElement).toBe(input())});
 it('C06 one rejected catalog does not remove successful catalogs',async()=>{w.plugins.list=async()=>{throw new Error('synthetic offline')};w.settings.getToolCatalog=async()=>[tool()];await mount();await fill('读取文件');expect(labels()).toEqual(['读取文件'])});
 it('C07 normal target flashes exactly three pulses',async()=>{await mount(row('保持置顶'));await fill('保持置顶');await pick('保持置顶');const target=host.querySelector('#target')!;let previous=false,pulses=0;for(let t=0;t<2300;t+=20){await advance(20);const active=target.classList.contains('cy-settings-search-flash');if(active&&!previous)pulses++;previous=active}expect(pulses).toBe(3);expect(target.classList.contains('cy-settings-search-flash-host')).toBe(false)});
 it('C08 interaction during an already running flash stops it',async()=>{await mount(row('保持置顶'));await fill('保持置顶');await pick('保持置顶');await advance(350);expect(host.querySelector('.cy-settings-search-flash')).not.toBeNull();window.dispatchEvent(new Event('wheel'));expect(host.querySelector('.cy-settings-search-flash')).toBeNull();await advance(2000);expect(host.querySelector('.cy-settings-search-flash')).toBeNull()});
 it('C09 locale changes rebuild ordinary labels',async()=>{await mount();await act(async()=>{await i18next.changeLanguage('en')});await fill('Always on top');expect(labels()).toContain('Always on top');await fill('保持置顶');expect(labels()).toEqual([])});
});

describe('Adversarial: expected user behavior',()=>{
 it('F01 IME Enter confirms composition without selecting a result',async()=>{await mount();await fill('自定义风格');await key('Enter',{isComposing:true,keyCode:229});expect(onSelect).not.toHaveBeenCalled();expect(isActive()).toBe(true)});
 it('F02 IME Escape cancels composition without closing search',async()=>{await mount();await fill('超时');await key('Escape',{isComposing:true,keyCode:229});expect(isActive()).toBe(true);expect(input().value).toBe('超时')});
 it('F03 click focused input after Escape should reopen search',async()=>{await mount();await fill('超时');await key('Escape');expect(isActive()).toBe(false);expect(document.activeElement).toBe(input());await act(async()=>input().click());await fill('置顶');expect(isActive()).toBe(true);expect(labels()).toContain('保持置顶')});
 it('F04 input during scroll/wait must cancel the pending flash',async()=>{await mount(row('保持置顶'));await fill('保持置顶');await pick('保持置顶');await advance(100);window.dispatchEvent(new Event('wheel'));await advance(250);expect(host.querySelector('.cy-settings-search-flash')).toBeNull()});
 it('F05 duplicate runtime names must locate by selected item ID',async()=>{
 w.settings.getToolCatalog=async()=>[tool('tool-a','同名工具'),tool('tool-b','同名工具')];
 await mount(<ToolToggleSettingsPanel/>,'toolToggle');
 expect(host.querySelectorAll('.tool-card')).toHaveLength(2);
 await fill('tool-b');await pick('同名工具');await advance(350);
 const cards=host.querySelectorAll('.tool-card');
 expect(cards[0].classList.contains('cy-settings-search-flash'),'first card must not be selected').toBe(false);
 expect(cards[1].classList.contains('cy-settings-search-flash'),'second tool must be selected by id').toBe(true);
 });
 it('F06 globally-disabled tools are excluded because no tool tab displays them',async()=>{w.settings.getToolCatalog=async()=>[tool('disabled-a','停用读取工具',{enabled:false})];await mount(<ToolToggleSettingsPanel/>,'toolToggle');expect(host.querySelector('.tool-card__name')).toBeNull();await fill('disabled-a');expect(labels()).toEqual([])});
 it('F07 plugin search should flash the actual full plugin card',async()=>{
 const plugin={id:'cyrene-hud',name:'桌面状态栏',description:'审计用假数据',author:'audit',version:'1.0.0',status:'disabled',enabled:false,source:'user',configuredEnabled:false};
 w.plugins.list=async()=>({plugins:[plugin],issues:[]});
 await mount(<AppProviders><PluginModePanel/></AppProviders>,'plugins');
 expect(host.querySelector('.plugin-card-ui__name')?.textContent).toBe('桌面状态栏');
 await fill('cyrene-hud');await pick('桌面状态栏');await advance(350);
 expect(host.querySelector('article.plugin-card-ui')?.classList.contains('cy-settings-search-flash')).toBe(true);
 });
 it('F08 a visible row must win over a hidden identical label',async()=>{await mount(<><div style={{display:'none'}}>{row('保持置顶','hidden')}</div>{row('保持置顶','visible')}</>);await fill('保持置顶');await pick('保持置顶');await advance(350);expect(host.querySelector('#visible')?.classList.contains('cy-settings-search-flash')).toBe(true)});
 // 分两次 act 推进：先让 React 提交异步挂载，再推进滚动/闪烁，避免批处理制造假失败。
 it('F09 slow panel mounting after 900ms should still locate',async()=>{function Slow(){const [ready,setReady]=useState(false);React.useEffect(()=>{const t=setTimeout(()=>setReady(true),1100);return()=>clearTimeout(t)},[]);return ready?row('保持置顶'):null}await mount(<Slow/>);await fill('保持置顶');await pick('保持置顶');await advance(1100);await advance(350);expect(host.querySelector('#target')).not.toBeNull();expect(host.querySelector('#target')?.classList.contains('cy-settings-search-flash')).toBe(true)});
 it('F10 a pending plugin list must not block resolved tool results',async()=>{w.plugins.list=()=>new Promise(()=>{});w.settings.getToolCatalog=async()=>[tool()];await mount();await fill('读取文件');await advance(1000);expect(labels()).toContain('读取文件')});
 it('F11 reopening search after catalog changes should refresh runtime results',async()=>{let items=[tool('old','旧目录工具')];w.settings.getToolCatalog=vi.fn(async()=>items);await mount();await fill('旧目录工具');expect(labels()).toContain('旧目录工具');await key('Escape');await act(async()=>input().blur());items=[tool('new','刚启用的工具')];await fill('刚启用的工具');expect(labels()).toContain('刚启用的工具')});
 it('F12 real model timeout row should be revealed inside collapsed runtime section',async()=>{
 Object.assign(w.settings,{listModelProfiles:async()=>({profiles:[],defaultModelProfileId:''}),getConfig:async()=>({}),getTimeoutSettings:async()=>({testTimeout:15000,userChoiceTimeout:60000,modelRequestTimeoutSec:60})});
 await mount(<AppProviders><ModelSettingsPanel/></AppProviders>,'models');
 expect(host.querySelector('.cy-model-runtime-section .ant-collapse-header')).not.toBeNull();
 await fill('连接测试超时');await pick('连接测试超时');await advance(1000);
 expect(host.querySelector('.cy-model-runtime-section .ant-collapse-header')?.getAttribute('aria-expanded')).toBe('true');
 expect([...host.querySelectorAll('main span')].some(x=>x.textContent==='连接测试超时'),'search itself should reveal the collapsed target').toBe(true);
 expect(host.querySelector('[data-settings-search-key="settingsPage.modelSettings.testTimeout"]')?.closest('.cy-model-field')?.classList.contains('cy-settings-search-flash-host')).toBe(true);
 });
 it('F16 wheel during rAF scrolling must return control immediately',async()=>{
 await mount(row('保持置顶'));const main=host.querySelector('main')!;const target=host.querySelector<HTMLElement>('#target')!;
 Object.defineProperties(main,{clientHeight:{value:400},scrollHeight:{value:2000}});main.style.overflowY='auto';
 Object.defineProperty(target,'offsetHeight',{value:40});
 target.getBoundingClientRect=()=>({top:1000,bottom:1040,height:40,left:0,right:100,width:100,x:0,y:1000,toJSON(){}});
 await fill('保持置顶');await pick('保持置顶');await advance(100);expect(main.scrollTop).toBeGreaterThan(0);
 window.dispatchEvent(new Event('wheel'));main.scrollTop=0;await advance(250);
 expect(main.scrollTop,'program must not overwrite the user scroll').toBe(0);
 });
 it('C11 scroll reaches clamped center in controlled geometry',async()=>{
 await mount(row('保持置顶'));const main=host.querySelector('main')!;const target=host.querySelector<HTMLElement>('#target')!;
 Object.defineProperties(main,{clientHeight:{value:400},scrollHeight:{value:1000}});main.style.overflowY='auto';
 Object.defineProperty(target,'offsetHeight',{value:40});target.getBoundingClientRect=()=>({top:1000,bottom:1040,height:40,left:0,right:100,width:100,x:0,y:1000,toJSON(){}});
 await fill('保持置顶');await pick('保持置顶');await advance(350);expect(main.scrollTop).toBe(600);
 });
});

describe('Index: coverage independent of the implementation assumptions',()=>{
 it('F13 English visible GPU setting must not vanish at 24 characters',()=>{expect(en.settingsPage.general.disableGpu.length).toBeGreaterThan(24);const entries=buildSettingEntries(en);expect(searchSettings(entries,'Disable client GPU rendering').map(x=>x.label)).toContain(en.settingsPage.general.disableGpu)});
 it('F14 same-section equal labels must retain both descriptions',()=>{const entries=buildSettingEntries({settingsPage:{general:{alpha:'启用',alphaDescription:'蓝色选项',beta:'启用',betaDescription:'绿色选项'}}});expect(searchSettings(entries,'绿色选项')).toHaveLength(1);expect(entries.filter(x=>x.label==='启用')).toHaveLength(2)});
 it('F15 visible model Hint descriptions should be searchable',()=>{const text=zh.settingsPage.modelSettings.requestTimeoutHint;expect(typeof text).toBe('string');const entries=buildSettingEntries(zh);expect(searchSettings(entries,text).map(x=>x.label)).toContain(zh.settingsPage.modelSettings.requestTimeout)});
 it('C10 cross-section duplicates remain distinguishable',()=>{const entries=buildSettingEntries({settingsPage:{general:{a:'启用'},memory:{b:'启用'}}});expect(searchSettings(entries,'启用')).toHaveLength(2)});
});

describe('Regression: cancellation, identity and asynchronous boundaries',()=>{
 it('R01 legacy IME keyCode 229 alone must not navigate',async()=>{await mount();await fill('自定义风格');await key('Enter',{keyCode:229});expect(onSelect).not.toHaveBeenCalled();expect(isActive()).toBe(true)});
 it('R02 typing after Escape reopens without a focus or click event',async()=>{await mount();await fill('超时');await key('Escape');await fill('置顶');expect(isActive()).toBe(true);expect(labels()).toContain('保持置顶')});
 it('R03 interaction cancels lookup before the slow target mounts',async()=>{
  function Slow(){const [ready,setReady]=useState(false);React.useEffect(()=>{const timer=setTimeout(()=>setReady(true),1100);return()=>clearTimeout(timer)},[]);return ready?row('保持置顶'):null}
  await mount(<Slow/>);await fill('保持置顶');await pick('保持置顶');await advance(100);window.dispatchEvent(new Event('pointerdown'));await advance(1000);await advance(500);expect(host.querySelector('#target')).not.toBeNull();expect(host.querySelector('.cy-settings-search-flash-host')).toBeNull();
 });
 it('R04 lookup expires instead of flashing an unrelated late render',async()=>{
  function Slow(){const [ready,setReady]=useState(false);React.useEffect(()=>{const timer=setTimeout(()=>setReady(true),6000);return()=>clearTimeout(timer)},[]);return ready?row('保持置顶'):null}
  await mount(<Slow/>);await fill('保持置顶');await pick('保持置顶');await advance(6000);await advance(500);expect(host.querySelector('#target')).not.toBeNull();expect(host.querySelector('.cy-settings-search-flash-host')).toBeNull();
 });
 it('R05 unmount cancels animation frames and pending flash',async()=>{
  await mount(row('保持置顶'));const main=host.querySelector('main')!;const target=host.querySelector<HTMLElement>('#target')!;
  Object.defineProperties(main,{clientHeight:{value:400},scrollHeight:{value:2000}});main.style.overflowY='auto';
  Object.defineProperty(target,'offsetHeight',{value:40});target.getBoundingClientRect=()=>({top:1000,bottom:1040,height:40,left:0,right:100,width:100,x:0,y:1000,toJSON(){}});
  await fill('保持置顶');await pick('保持置顶');await advance(100);expect(main.scrollTop).toBeGreaterThan(0);
  await act(async()=>root.render(null));const saved=main.scrollTop;await advance(2500);expect(main.scrollTop).toBe(saved);expect(target.classList.contains('cy-settings-search-flash-host')).toBe(false);
 });
 it('R06 stale catalog responses cannot replace a newer search session',async()=>{
  let resolveOld!:(items:any[])=>void;const old=new Promise<any[]>(resolve=>{resolveOld=resolve});let calls=0;
  w.settings.getToolCatalog=()=>++calls===1?old:Promise.resolve([tool('new-id','最新目录工具')]);
  await mount();await fill('目录工具');expect(labels()).toEqual(['最新目录工具']);await act(async()=>resolveOld([tool('old-id','过期目录工具')]));expect(labels()).toEqual(['最新目录工具']);
 });
 it('R07 synchronous IPC failure cannot block other catalogs',async()=>{w.plugins.list=()=>{throw new Error('sync IPC failure')};w.settings.getToolCatalog=async()=>[tool()];await mount();await fill('读取文件');expect(labels()).toEqual(['读取文件'])});
 it('R08 equal setting labels use translation keys to select the correct row',async()=>{
  i18next.addResource('zh-CN','translation','settingsPage.general.auditAlpha','审计重复标题');
  i18next.addResource('zh-CN','translation','settingsPage.general.auditBeta','审计重复标题');
  i18next.addResource('zh-CN','translation','settingsPage.general.auditBetaDescription','仅第二条的审计描述');
  await mount(<><div id="first" className="cy-settings-row"><span data-settings-search-key="settingsPage.general.auditAlpha">审计重复标题</span></div><div id="second" className="cy-settings-row"><span data-settings-search-key="settingsPage.general.auditBeta">审计重复标题</span></div></>);
  await fill('仅第二条的审计描述');expect(labels()).toEqual(['审计重复标题']);await pick('审计重复标题');await advance(350);
  expect(host.querySelector('#first')?.classList.contains('cy-settings-search-flash')).toBe(false);expect(host.querySelector('#second')?.classList.contains('cy-settings-search-flash')).toBe(true);
 });
 it('R09 absent keyed setting must not flash a different keyed namesake',async()=>{
  await mount(<label data-settings-search-key="settingsPage.tts.endpointUrl"><span>服务地址</span></label>,'tts');
  await fill('服务地址');const entries=host.querySelectorAll<HTMLButtonElement>('.cy-settings-search__item');expect(entries.length).toBeGreaterThan(1);
  // 资源顺序中的 gptUrl 在 endpointUrl 之前；只挂载后者不能替代前者。
  await act(async()=>entries[0].click());await advance(350);expect(host.querySelector('.cy-settings-search-flash')).toBeNull();
 });
 it('R10 descriptions combine Hint and Description without standalone entries',()=>{
  const entries=buildSettingEntries({settingsPage:{general:{option:'设置标题',optionHint:'边界说明',optionDescription:'用途说明',optionSaved:'已保存'}}});
  expect(entries).toHaveLength(1);expect(entries[0].settingKey).toBe('settingsPage.general.option');expect(searchSettings(entries,'边界说明')).toHaveLength(1);expect(searchSettings(entries,'用途说明')).toHaveLength(1);
 });
 it('R11 duplicate plugin names and selector punctuation still resolve by ID',async()=>{
  const id='plugin["b"]#';w.plugins.list=async()=>[{id:'a',name:'同名插件'},{id,name:'同名插件'}];
  await mount(<><article id="first" className="plugin-card-ui" data-settings-search-kind="plugin" data-settings-search-id="a"><strong>同名插件</strong></article><article id="second" className="plugin-card-ui" data-settings-search-kind="plugin" data-settings-search-id={id}><strong>同名插件</strong></article></>,'plugins');
  await fill(id);await pick('同名插件');await advance(350);expect(host.querySelector('#first')?.classList.contains('cy-settings-search-flash')).toBe(false);expect(host.querySelector('#second')?.classList.contains('cy-settings-search-flash')).toBe(true);
 });
 it('R12 starting another search cancels the previous highlight',async()=>{
  await mount(<>{row('保持置顶','first')}{row('自定义风格','second')}</>);await fill('保持置顶');await pick('保持置顶');await advance(350);expect(host.querySelector('#first')?.classList.contains('cy-settings-search-flash')).toBe(true);
  await fill('自定义风格');await pick('自定义风格');await advance(350);expect(host.querySelector('#first')?.classList.contains('cy-settings-search-flash-host')).toBe(false);expect(host.querySelector('#second')?.classList.contains('cy-settings-search-flash')).toBe(true);
 });
});

describe('Index: long titles versus explanatory text',()=>{
 it('R13 keeps long English labels but excludes lowercase descriptions and paragraphs',()=>{
  const entries=buildSettingEntries({settingsPage:{general:{disableGpu:'Disable client GPU rendering',description:'General settings without punctuation',body:'This is a complete explanatory sentence.',multiline:'First line\nSecond line'}}});
  expect(entries.map(entry=>entry.label)).toEqual(['Disable client GPU rendering']);
 });
});

describe('Navigation: preserve upstream sections',()=>{
 it('R14 keeps email navigation and indexes the email settings section',()=>{
  expect(SETTINGS_NAV_ITEMS.map(item=>item.section)).toEqual(['general','appearance','preferences','models','usage','browser','email','toolToggle','tools','subagents','plugins','mcp','memory','knowledge','cyrene','skill','channels','tts','asr','disclaimer']);
  const entries=buildSettingEntries(zh);
  expect(entries.find(entry=>entry.settingKey==='settingsPage.emailSettings.title')?.section).toBe('email');
  expect(searchSettings(entries,zh.settingsPage.emailSettings.title).some(entry=>entry.section==='email')).toBe(true);
 });
});
