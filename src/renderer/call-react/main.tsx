import { createRoot } from "react-dom/client";
import "../ui/theme";
import { CallWindow } from "./CallWindow";
import "./call-window.css";

const root = document.getElementById("cy-call-root");
if (!root) throw new Error("Call window root not found");
createRoot(root).render(<CallWindow />);
