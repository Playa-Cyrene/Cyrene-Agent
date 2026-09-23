export type AskFieldType = "single_select" | "multi_select" | "text";

export interface AskOption {
  value: string;
  label: string;
  description?: string;
}

export interface AskMissingField {
  field: string;
  reason: string;
  required: boolean;
  questionHint?: string;
  typeHint?: AskFieldType;
  allowedOptions?: AskOption[];
  candidateHints?: string[];
  allowCustom?: boolean;
}

export interface TrustedAskUserProfile {
  callPreference?: string;
  nickname?: string;
  gender?: "male" | "female" | "nonbinary" | "unknown" | "secret";
}

export interface AskClarificationInput {
  userRequest: string;
  missingFields: AskMissingField[];
  trustedUserProfile?: TrustedAskUserProfile;
  recentAddressedUser?: boolean;
}

export interface AskQuestion {
  field: string;
  question: string;
  type: AskFieldType;
  options: AskOption[];
  allowCustom: boolean;
  freeTextPlaceholder: string;
}

export interface AskClarificationOutput {
  intro: string;
  questions: AskQuestion[];
  deferredFields: string[];
}

export interface AskClarificationCard {
  mode?: AskCardMode;
  intro: string;
  questions: AskQuestion[];
  deferredFields: string[];
  /**
   * 等待档位：缺省走询问卡的快问快答超时（userChoiceTimeout）；
   * "plan_approval" 走审批专用超时（planApprovalTimeout）——审批是重决策，等待时长独立配置。
   */
  waitTimeoutTone?: "plan_approval";
}

export interface AskUserAnswer {
  requestId: string;
  answers: Array<{
    field: string;
    selectedValues?: string[];
    customText?: string;
  }>;
}

export type AskCardMode = "action_parameters" | "semantic_clarification";

/** Renderer-visible Ask contract. It intentionally contains no tool binding or canonical value. */
export interface AskCardPayload {
  interactionId: string;
  runId: string;
  revision: number;
  mode: AskCardMode;
  intro: string;
  questions: AskQuestionView[];
}

export interface AskQuestionView {
  id: string;
  prompt: string;
  required: true;
  multiple: boolean;
  options: AskOptionView[];
  customInput: {
    enabled: boolean;
    placeholder?: string;
  };
}

export interface AskOptionView {
  id: string;
  label: string;
  description?: string;
}

export type AskAnswerSubmission =
  | {
      questionId: string;
      source: "option";
      optionId?: string;
      optionIds?: string[];
    }
  | {
      questionId: string;
      source: "custom";
      text: string;
    };

export interface AskCardSubmission {
  interactionId: string;
  runId: string;
  revision: number;
  answers: AskAnswerSubmission[];
}
