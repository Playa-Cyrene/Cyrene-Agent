export type ToolOutputOutcome = "success" | "failure" | "unknown";

export interface ToolOutputRef {
  recordId: string;
  resultRef: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  bytes: number;
  codePoints: number;
  truncatedForModel: boolean;
  createdAt: number;
}

export interface PutToolOutputInput {
  conversationId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  outcome: ToolOutputOutcome;
  output: string;
  truncatedForModel: boolean;
}

export interface ReadToolOutputInput {
  conversationId: string;
  resultRef: string;
  canReadTool?: (toolName: string) => boolean;
  offset: number;
  length: number;
}

export interface ReadToolOutputResult {
  content: string;
  offset: number;
  totalCodePoints: number;
  resultRef: string;
  toolName: string;
}

export interface FindToolOutputInput {
  conversationId: string;
  resultRef: string;
  canReadTool?: (toolName: string) => boolean;
  query: string;
}

export interface FindToolOutputMatch {
  offset: number;
  preview: string;
}

export interface FindToolOutputResult {
  resultRef: string;
  toolName: string;
  totalCodePoints: number;
  matches: FindToolOutputMatch[];
}

export interface ToolOutputStore {
  put(input: PutToolOutputInput): Promise<ToolOutputRef>;
  read(input: ReadToolOutputInput): Promise<ReadToolOutputResult | null>;
  find(input: FindToolOutputInput): Promise<FindToolOutputResult | null>;
  deleteConversation(conversationId: string): Promise<void>;
}
