/** 聊天界面保存的每条命令输出尾窗。 */
export const SHELL_VISIBLE_OUTPUT_LIMIT = 64_000;

export interface ShellOutputUpdate {
  action: "append" | "replace";
  text: string;
  truncated?: boolean;
}
