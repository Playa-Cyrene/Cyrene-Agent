import { networkInterfaces } from "node:os";
import {
  normalizeQqListenMode,
  type QqListenAuthRequirement,
  type QqListenMode,
} from "../../shared/qq-listen";

// 宿主持有监听地址与鉴权策略，预检不需要加载 QQ 后端。
export function resolveOneBotListenHost(
  mode: QqListenMode,
  customHost?: string,
  interfaces?: ReturnType<typeof networkInterfaces>,
): { host: string; resolvedMode: QqListenMode } {
  if (mode === "loopback") return { host: "127.0.0.1", resolvedMode: "loopback" };
  if (mode === "custom") {
    const host = customHost?.trim();
    if (!host) throw new Error("QQ 自定义监听地址为空");
    return { host, resolvedMode: "custom" };
  }

  // 网卡枚举（uv_interface_addresses）在受限环境（部分 Linux 容器/沙箱）会抛
  // ERR_SYSTEM_ERROR，而 loopback/custom 不依赖网卡——枚举必须停留在只有
  // wsl/auto 才会到达的位置，不能作为参数默认值提前求值（#218）。
  const available = interfaces ?? networkInterfaces();
  const wslAddress = Object.entries(available)
    .filter(([name]) => /wsl/i.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .find((item) => item.family === "IPv4" && !item.internal)?.address;
  if (wslAddress) return { host: wslAddress, resolvedMode: "wsl" };
  if (mode === "wsl") throw new Error("未检测到 Windows WSL 虚拟网卡 IPv4 地址");
  return { host: "127.0.0.1", resolvedMode: "loopback" };
}

/** 回环地址（本机）可以免 token；其余地址（局域网 IP、WSL 虚拟网卡、0.0.0.0/::）上
 *  任何能连到端口的对端都能冒充 NapCat 注入消息，必须配置 Access Token 鉴权。 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === ""
    || normalized === "127.0.0.1"
    || normalized === "localhost"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}

/**
 * 权威鉴权预检：回答「按当前参数监听时是否必须配置 Access Token」。
 *
 * 渲染进程看不到网络接口（auto 模式在存在 WSL 虚拟网卡时会解析为非回环地址），
 * 因此该判定只能由主进程给出。这里与 start() 里的硬校验复用同一对辅助函数
 * （resolveOneBotListenHost + isLoopbackHost），保证预检与实际启动不会分叉。
 */
export function resolveQqListenAuthRequirement(
  input: {
    listenMode?: unknown;
    customHost?: unknown;
  },
  /** 仅测试注入；缺省读真实网卡，与 start() 的路径完全一致。 */
  interfaces: Parameters<typeof resolveOneBotListenHost>[2] = undefined,
): QqListenAuthRequirement {
  const customHost = typeof input.customHost === "string" ? input.customHost : undefined;
  try {
    const { host, resolvedMode } = resolveOneBotListenHost(
      normalizeQqListenMode(input.listenMode),
      customHost,
      interfaces,
    );
    return {
      ok: true,
      requiresAccessToken: !isLoopbackHost(host),
      resolvedHost: host,
      resolvedMode,
    };
  } catch (error) {
    // 地址本身解析不出来（wsl 模式但无 WSL 网卡 / custom 地址为空）：这不是 token
    // 的问题，因此 requiresAccessToken 为 false，把原因原样交给渲染端展示。
    return {
      ok: false,
      requiresAccessToken: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
