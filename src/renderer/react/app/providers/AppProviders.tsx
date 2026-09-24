import type { ReactNode } from "react";
import { ConfigProvider, theme } from "antd";
import { FeedbackProvider } from "../../components/feedback/FeedbackProvider";
import { useChatAppearance } from "../../hooks/useChatAppearance";

interface AppProvidersProps {
  children: ReactNode;
}

// 跟随昔涟主题：主色和次色都换粉色，组件库默认蓝换成项目色。
// 粉值与 --cy-accent / --rb-accent 保持一致（#FF5B8A），详见 react-root.css 与 pearl-white.css。
const ANTD_THEME = {
  token: {
    colorPrimary: "#FF5B8A",
    colorInfo: "#FF5B8A",
    colorLink: "#FF5B8A",
    borderRadius: 10,
  },
  algorithm: theme.defaultAlgorithm,
};

export function AppProviders({ children }: AppProvidersProps) {
  // 主题状态初始化后再挂反馈层，保证 Token 就绪
  useChatAppearance();
  return (
    <ConfigProvider theme={ANTD_THEME}>
      <FeedbackProvider>{children}</FeedbackProvider>
    </ConfigProvider>
  );
}
