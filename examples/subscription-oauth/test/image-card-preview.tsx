// Isolated visual fixture: production component, fake image ID, no account access.
import { createRoot } from "react-dom/client";
import { ConfigProvider } from "antd";
import { GeneratedImageCard } from "../../../src/renderer/react/features/chat/components/GeneratedImageCard";

createRoot(document.getElementById("root")!).render(
  <ConfigProvider theme={{ token: { colorPrimary: "#ed6792", borderRadius: 12 } }}>
    <div style={{ padding: 32, fontFamily: "Segoe UI, Microsoft YaHei, sans-serif" }}>
      <div style={{ fontSize: 14, color: "#80707a", marginBottom: 12 }}>订阅生图 · 图片已恢复，没有再次生成</div>
      <GeneratedImageCard image={{ kind: "cyrene.generated-image", id: "11111111-1111-4111-8111-111111111111", provider: "ChatGPT", reused: true }} />
    </div>
  </ConfigProvider>,
);
