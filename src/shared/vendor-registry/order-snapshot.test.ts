// 聚合表顺序与内容的逐字节基准（由迁移前旧规则表的一次性脚本捕获固化）。
//
// 规则数据与厂商排列顺序都是可观察行为：resolver 第二轮跨家族兜底按全局
// 顺序 first-match。调整规则请改 entries/ 下对应厂商文件，并同步更新此基准
// （基准的更新必须是有意识的兼容性决策，而不是搬运事故）。
import { describe, expect, test } from "vitest";
import { MODEL_REASONING_RULES, VENDOR_REGISTRY } from "./index";

// 期望值结构：{ providerId, pattern: { source, flags }, capability }[]
const EXPECTED = [
  {
    "providerId": "chatgpt",
    "pattern": {
      "source": "^gpt-6-(?:sol|luna)",
      "flags": "i"
    },
    "capability": {
      "control": "effort",
      "supportedEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "defaultEffort": "medium",
      "requestStyle": "openai-effort",
      "supportsDisable": true,
      "supportsProMode": true
    }
  },
  {
    "providerId": "chatgpt",
    "pattern": {
      "source": "^gpt-6",
      "flags": "i"
    },
    "capability": {
      "control": "effort",
      "supportedEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "defaultEffort": "medium",
      "requestStyle": "openai-effort",
      "supportsDisable": false,
      "supportsProMode": true
    }
  },
  {
    "providerId": "chatgpt",
    "pattern": {
      "source": "^gpt-5\\.6",
      "flags": "i"
    },
    "capability": {
      "control": "effort",
      "supportedEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "defaultEffort": "medium",
      "requestStyle": "openai-effort",
      "supportsDisable": true,
      "supportsProMode": true
    }
  },
  {
    "providerId": "chatgpt",
    "pattern": {
      "source": "^gpt-5",
      "flags": "i"
    },
    "capability": {
      "control": "effort",
      "supportedEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ],
      "defaultEffort": "medium",
      "requestStyle": "openai-effort",
      "supportsDisable": true
    }
  },
  {
    "providerId": "chatgpt",
    "pattern": {
      "source": "^o1",
      "flags": "i"
    },
    "capability": {
      "control": "effort",
      "supportedEfforts": [
        "low",
        "medium",
        "high"
      ],
      "defaultEffort": "medium",
      "requestStyle": "openai-effort",
      "supportsDisable": true
    }
  },
  {
    "providerId": "chatgpt",
    "pattern": {
      "source": "^o3",
      "flags": "i"
    },
    "capability": {
      "control": "effort",
      "supportedEfforts": [
        "low",
        "medium",
        "high"
      ],
      "defaultEffort": "medium",
      "requestStyle": "openai-effort",
      "supportsDisable": true
    }
  },
  {
    "providerId": "chatgpt",
    "pattern": {
      "source": "^o4",
      "flags": "i"
    },
    "capability": {
      "control": "effort",
      "supportedEfforts": [
        "medium",
        "high"
      ],
      "defaultEffort": "medium",
      "requestStyle": "openai-effort",
      "supportsDisable": true
    }
  },
  {
    "providerId": "chatgpt",
    "pattern": {
      "source": ".*",
      "flags": ""
    },
    "capability": {
      "control": "none",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "claude",
    "pattern": {
      "source": "^claude-fable-5",
      "flags": "i"
    },
    "capability": {
      "control": "toggle-effort",
      "supportedEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "defaultEffort": "high",
      "requestStyle": "anthropic-adaptive",
      "supportsDisable": true
    }
  },
  {
    "providerId": "claude",
    "pattern": {
      "source": "^claude-sonnet-5",
      "flags": "i"
    },
    "capability": {
      "control": "toggle-effort",
      "supportedEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "defaultEffort": "high",
      "requestStyle": "anthropic-adaptive",
      "supportsDisable": true
    }
  },
  {
    "providerId": "claude",
    "pattern": {
      "source": "^claude-opus-4-(8|7|6)",
      "flags": "i"
    },
    "capability": {
      "control": "toggle-effort",
      "supportedEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "defaultEffort": "high",
      "requestStyle": "anthropic-adaptive",
      "supportsDisable": true
    }
  },
  {
    "providerId": "claude",
    "pattern": {
      "source": "^claude-sonnet-4-6",
      "flags": "i"
    },
    "capability": {
      "control": "toggle-effort",
      "supportedEfforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ],
      "defaultEffort": "high",
      "requestStyle": "anthropic-adaptive",
      "supportsDisable": true
    }
  },
  {
    "providerId": "claude",
    "pattern": {
      "source": ".*",
      "flags": ""
    },
    "capability": {
      "control": "none",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "deepseek",
    "pattern": {
      "source": "^deepseek-(?:v4|flash)",
      "flags": "i"
    },
    "capability": {
      "control": "toggle-effort",
      "supportedEfforts": [
        "high",
        "max"
      ],
      "defaultEffort": "high",
      "requestStyle": "thinking-type",
      "supportsDisable": true,
      "autoEffort": "high"
    }
  },
  {
    "providerId": "deepseek",
    "pattern": {
      "source": "^deepseek-(chat|reasoner)$",
      "flags": "i"
    },
    "capability": {
      "control": "none",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "deepseek",
    "pattern": {
      "source": ".*",
      "flags": ""
    },
    "capability": {
      "control": "none",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "glm",
    "pattern": {
      "source": "^glm-5\\.3",
      "flags": "i"
    },
    "capability": {
      "control": "toggle-effort",
      "supportedEfforts": [
        "low",
        "high",
        "max"
      ],
      "defaultEffort": "high",
      "requestStyle": "thinking-type",
      "supportsDisable": false,
      "autoEffort": "high"
    }
  },
  {
    "providerId": "glm",
    "pattern": {
      "source": "^glm-5\\.2",
      "flags": "i"
    },
    "capability": {
      "control": "toggle-effort",
      "supportedEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ],
      "defaultEffort": "high",
      "requestStyle": "thinking-type",
      "supportsDisable": true,
      "autoEffort": "high"
    }
  },
  {
    "providerId": "glm",
    "pattern": {
      "source": "^glm-5-turbo$",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "thinking-type",
      "supportsDisable": true
    }
  },
  {
    "providerId": "glm",
    "pattern": {
      "source": "^glm-5v-turbo$",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "thinking-type",
      "supportsDisable": true
    }
  },
  {
    "providerId": "glm",
    "pattern": {
      "source": "^glm-5\\.1",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "thinking-type",
      "supportsDisable": true
    }
  },
  {
    "providerId": "glm",
    "pattern": {
      "source": "^glm-5",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "thinking-type",
      "supportsDisable": true
    }
  },
  {
    "providerId": "glm",
    "pattern": {
      "source": "^glm-(4\\.5|4\\.6|4\\.7)",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "thinking-type",
      "supportsDisable": true
    }
  },
  {
    "providerId": "glm",
    "pattern": {
      "source": ".*",
      "flags": ""
    },
    "capability": {
      "control": "none",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "qwen",
    "pattern": {
      "source": "-thinking$",
      "flags": "i"
    },
    "capability": {
      "control": "fixed-on",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "qwen",
    "pattern": {
      "source": "^qwen3",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "qwen-enable-thinking",
      "supportsDisable": true
    }
  },
  {
    "providerId": "qwen",
    "pattern": {
      "source": "^qwen-(max|plus|turbo)",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "qwen-enable-thinking",
      "supportsDisable": true
    }
  },
  {
    "providerId": "qwen",
    "pattern": {
      "source": ".*",
      "flags": ""
    },
    "capability": {
      "control": "none",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "kimi",
    "pattern": {
      "source": "^kimi-k3",
      "flags": "i"
    },
    "capability": {
      "control": "effort",
      "supportedEfforts": [
        "low",
        "high",
        "max"
      ],
      "defaultEffort": "high",
      "requestStyle": "openai-effort",
      "supportsDisable": false,
      "autoEffort": "high"
    }
  },
  {
    "providerId": "kimi",
    "pattern": {
      "source": "^kimi-k2\\.7-code-highspeed$",
      "flags": "i"
    },
    "capability": {
      "control": "fixed-on",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "kimi",
    "pattern": {
      "source": "^kimi-k2\\.7-code$",
      "flags": "i"
    },
    "capability": {
      "control": "fixed-on",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "kimi",
    "pattern": {
      "source": "^kimi-k2\\.6",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "thinking-type",
      "supportsDisable": true,
      "keepOnTools": true
    }
  },
  {
    "providerId": "kimi",
    "pattern": {
      "source": "^kimi-k2\\.5",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "thinking-type",
      "supportsDisable": true,
      "keepOnTools": false
    }
  },
  {
    "providerId": "kimi",
    "pattern": {
      "source": "^kimi-k2-thinking",
      "flags": "i"
    },
    "capability": {
      "control": "fixed-on",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "kimi",
    "pattern": {
      "source": ".*",
      "flags": ""
    },
    "capability": {
      "control": "none",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "minimax",
    "pattern": {
      "source": "^MiniMax-M3",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "anthropic-adaptive",
      "supportsDisable": true
    }
  },
  {
    "providerId": "minimax",
    "pattern": {
      "source": "^MiniMax-M2\\.",
      "flags": "i"
    },
    "capability": {
      "control": "fixed-on",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "minimax",
    "pattern": {
      "source": ".*",
      "flags": ""
    },
    "capability": {
      "control": "none",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "mimo",
    "pattern": {
      "source": "^mimo-v2\\.",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "thinking-type",
      "supportsDisable": true
    }
  },
  {
    "providerId": "mimo",
    "pattern": {
      "source": ".*",
      "flags": ""
    },
    "capability": {
      "control": "none",
      "requestStyle": "none",
      "supportsDisable": false
    }
  },
  {
    "providerId": "doubao",
    "pattern": {
      "source": "^doubao-seed-",
      "flags": "i"
    },
    "capability": {
      "control": "toggle",
      "requestStyle": "thinking-type",
      "supportsDisable": true
    }
  },
  {
    "providerId": "doubao",
    "pattern": {
      "source": ".*",
      "flags": ""
    },
    "capability": {
      "control": "none",
      "requestStyle": "none",
      "supportsDisable": false
    }
  }
];

describe("规则表聚合 — 顺序与内容快照", () => {
  test("聚合表与迁移前基准逐字节一致", () => {
    const normalized = MODEL_REASONING_RULES.map((r) => ({
      providerId: r.providerId,
      pattern: { source: r.modelPattern.source, flags: r.modelPattern.flags },
      capability: r.capability,
    }));
    expect(JSON.stringify(normalized, null, 2)).toBe(JSON.stringify(EXPECTED, null, 2));
  });
  test("聚合表与基准深度相等（可读 diff 兜底）", () => {
    const normalized = MODEL_REASONING_RULES.map((r) => ({
      providerId: r.providerId,
      pattern: { source: r.modelPattern.source, flags: r.modelPattern.flags },
      capability: r.capability,
    }));
    expect(normalized).toEqual(EXPECTED);
  });
});

// 旧 capability 表的厂商排列（迁移前 capabilities.ts 的数组顺序，minimax 开头）。
// PROVIDER_CAPABILITIES 由 VENDOR_REGISTRY map 派生，该顺序是导出数组的
// 可观察行为；条目内容正确性由 capabilities.test / provider-contracts.test 兜底，
// 此处只钉顺序。
const EXPECTED_CAPABILITY_ORDER = [
  "minimax",
  "deepseek",
  "doubao",
  "glm",
  "kimi",
  "qwen",
  "chatgpt",
  "claude",
  "mimo",
];

describe("能力表聚合 — 顺序快照", () => {
  test("VENDOR_REGISTRY 与派生能力表保持旧 capability 表顺序", () => {
    expect(VENDOR_REGISTRY.map((e) => e.capability.id)).toEqual(EXPECTED_CAPABILITY_ORDER);
  });
});
