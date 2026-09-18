import type { ReactNode } from "react";
import { FeedbackProvider } from "../../components/feedback/FeedbackProvider";
import { useChatAppearance } from "../../hooks/useChatAppearance";

interface AppProvidersProps {
  children: ReactNode;
}

export function AppProviders({ children }: AppProvidersProps) {
  // 主题状态初始化后再挂反馈层，保证 Token 就绪
  useChatAppearance();
  return <FeedbackProvider>{children}</FeedbackProvider>;
}
