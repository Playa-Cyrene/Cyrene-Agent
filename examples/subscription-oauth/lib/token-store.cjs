"use strict";

/**
 * OAuth token 存储（多账号版）。
 *
 * 每个 provider 一个 key：tokens.chatgpt / tokens.claude / tokens.grok
 * （宿主 key 正则只允许 [a-zA-Z0-9._-]，不能用冒号）。
 *
 * 值结构：
 *   { activeAccountId: string, accounts: [{ id, label, accountId, tokens, addedAt }] }
 *
 * 兼容旧版单账号结构（值直接是 tokens 对象）：读取时自动升级为单账号。
 * 优先写 host secrets（safeStorage 加密），secrets 不可用时降级到插件 storage。
 */

function keyFor(providerId) {
  return `tokens.${providerId}`;
}

/** 账号稳定标识：优先平台 accountId，其次邮箱，最后随机。 */
function accountIdFor(providerId, tokens) {
  const explicit = typeof tokens.accountId === "string" && tokens.accountId.trim();
  if (explicit) return explicit.trim();
  const label = typeof tokens.accountLabel === "string" && tokens.accountLabel.trim();
  if (label) return label.trim().toLowerCase();
  return `${providerId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isLegacyShape(value) {
  return Boolean(value) && typeof value === "object" && typeof value.accessToken === "string";
}

function normalizeStore(value) {
  if (!value || typeof value !== "object") return { activeAccountId: undefined, accounts: [] };
  if (isLegacyShape(value)) {
    const id = accountIdFor("legacy", value);
    return {
      activeAccountId: id,
      accounts: [{
        id,
        label: value.accountLabel || id,
        accountId: value.accountId,
        tokens: value,
        addedAt: Date.now(),
      }],
    };
  }
  const accounts = Array.isArray(value.accounts) ? value.accounts.filter((a) => a && a.tokens) : [];
  const activeAccountId = accounts.some((a) => a.id === value.activeAccountId)
    ? value.activeAccountId
    : accounts[0] && accounts[0].id;
  return { activeAccountId, accounts };
}

function createTokenStore(secrets, storage) {
  /** 读原始存储值（优先 secrets，回退 storage）。 */
  async function readRaw(providerId) {
    const key = keyFor(providerId);
    if (secrets) {
      const raw = await secrets.get(key).catch(() => null);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && (parsed.accessToken || Array.isArray(parsed.accounts))) return parsed;
        } catch {
          // 解析失败按无数据处理
        }
      }
    }
    const legacy = storage.get(key);
    if (legacy && (legacy.accessToken || Array.isArray(legacy.accounts))) return legacy;
    return null;
  }

  async function writeRaw(providerId, value) {
    const key = keyFor(providerId);
    // 只经宿主 secrets（safeStorage 加密）落盘；secrets 不可用时拒绝保存，
    // 绝不降级为明文 JSON 文件。
    if (!secrets) {
      throw new Error("宿主密钥服务不可用，无法安全保存订阅凭据（请确认系统支持加密存储）");
    }
    await secrets.set(key, JSON.stringify(value));
    // 清掉历史版本可能留下的明文遗留，避免双份敏感数据
    if (storage) storage.set(key, { v: null });
  }

  return {
    /** 当前激活账号的 token（无账号返回 null）。 */
    async get(providerId) {
      const active = await this.getActive(providerId);
      return active ? active.tokens : null;
    },

    /**
     * 当前激活账号的完整信息（token + 账号 id）。
     * 刷新 token 时必须用 accountId 定位原账号，不能走 addAccount（否则会造幽灵账号）。
     * @returns {Promise<{accountId: string, tokens: object} | null>}
     */
    async getActive(providerId) {
      const store = normalizeStore(await readRaw(providerId));
      const active = store.accounts.find((a) => a.id === store.activeAccountId) || store.accounts[0];
      return active ? { accountId: active.id, tokens: active.tokens } : null;
    },

    /**
     * 按 accountId 更新某个账号的 token（原地更新，不改激活账号、不新增账号）。
     * 会把原账号的 accountId / 标签回填进新 token —— refresh 响应常缺这些字段，
     * 而 ChatGPT 用量与对话请求都依赖 tokens.accountId。
     * 找不到账号时返回 false。
     */
    async updateAccount(providerId, accountId, tokens) {
      const store = normalizeStore(await readRaw(providerId));
      const index = store.accounts.findIndex((a) => a.id === accountId);
      if (index < 0) return false;
      const prev = store.accounts[index];
      const mergedTokens = {
        ...tokens,
        accountId: tokens.accountId ?? prev.accountId,
        accountLabel: tokens.accountLabel ?? prev.label,
      };
      store.accounts[index] = {
        ...prev,
        label: mergedTokens.accountLabel || prev.label || accountId,
        accountId: mergedTokens.accountId,
        tokens: mergedTokens,
      };
      await writeRaw(providerId, store);
      return true;
    },

    /** 账号列表（不含 token 本体）+ 激活账号 id。 */
    async listAccounts(providerId) {
      const store = normalizeStore(await readRaw(providerId));
      return {
        activeAccountId: store.activeAccountId,
        accounts: store.accounts.map((a) => ({
          id: a.id,
          label: a.label || a.id,
          accountId: a.accountId,
          addedAt: a.addedAt,
          expiresAt: a.tokens && a.tokens.expiresAt,
        })),
      };
    },

    /**
     * 添加或更新一个账号（同 id 覆盖 token），并把它设为激活。
     * @returns {Promise<{accountId: string, added: boolean}>}
     */
    async addAccount(providerId, tokens) {
      const store = normalizeStore(await readRaw(providerId));
      const id = accountIdFor(providerId, tokens);
      const label = tokens.accountLabel || tokens.accountId || id;
      const index = store.accounts.findIndex((a) => a.id === id);
      const entry = { id, label, accountId: tokens.accountId, tokens, addedAt: Date.now() };
      if (index >= 0) store.accounts[index] = { ...store.accounts[index], ...entry };
      else store.accounts.push(entry);
      store.activeAccountId = id;
      await writeRaw(providerId, store);
      return { accountId: id, added: index < 0 };
    },

    /** 切换激活账号；账号不存在返回 false。 */
    async switchAccount(providerId, accountId) {
      const store = normalizeStore(await readRaw(providerId));
      if (!store.accounts.some((a) => a.id === accountId)) return false;
      store.activeAccountId = accountId;
      await writeRaw(providerId, store);
      return true;
    },

    /** 删除账号；若删的是激活账号，自动切到剩余第一个。 */
    async removeAccount(providerId, accountId) {
      const store = normalizeStore(await readRaw(providerId));
      const before = store.accounts.length;
      store.accounts = store.accounts.filter((a) => a.id !== accountId);
      if (store.accounts.length === before) return false;
      if (store.activeAccountId === accountId) {
        store.activeAccountId = store.accounts[0] && store.accounts[0].id;
      }
      await writeRaw(providerId, store);
      return true;
    },

    /** 清空该 provider 的全部账号（退出登录）。 */
    async remove(providerId) {
      const key = keyFor(providerId);
      if (secrets) await secrets.delete(key).catch(() => {});
      if (storage) storage.set(key, { v: null });
    },

    /** 兼容旧接口：把 token 作为账号写入（等价 addAccount）。 */
    async set(providerId, tokens) {
      await this.addAccount(providerId, tokens);
    },

    /** 是否明文降级（secrets 不可用时提醒用户）。 */
    encrypted: Boolean(secrets),
  };
}

module.exports = { createTokenStore, keyFor, accountIdFor, normalizeStore };
