import type { ChatPagePanel } from "./ChatPageNavigation";
import { MomentsPanel } from "../../moments/MomentsPanel";

export function ChatPagePanelHost({ panel }: { panel: ChatPagePanel }) {
  switch (panel) {
    case "moments": return <MomentsPanel />;
  }
}
