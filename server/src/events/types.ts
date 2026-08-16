// The run_events vocabulary, per plan §1.

export interface RunStartedPayload {
  runId: string;
  model: string;
}

export interface AssistantDeltaPayload {
  runId: string;
  text: string;
}

export interface ReasoningDeltaPayload {
  runId: string;
  text: string;
}

export interface ToolCallPayload {
  runId: string;
  tool: string;
  query: string;
}

export interface ToolResultPayload {
  runId: string;
  tool: string;
  summary: string;
  citations?: Array<{ url: string; title?: string }>;
}

export interface AssistantMessageFinalPayload {
  runId: string;
  messageId: string;
  content: string;
  citations?: Array<{ url: string; title?: string }>;
}

export interface RunFinishedPayload {
  runId: string;
  status: "completed" | "cancelled";
  usage?: { promptTokens: number; completionTokens: number; costUsd: number } | null;
}

export interface RunErrorPayload {
  runId: string;
  message: string;
  code?: string;
}

export type RunEventType =
  | "run_started"
  | "assistant_delta"
  | "reasoning_delta"
  | "tool_call"
  | "tool_result"
  | "assistant_message_final"
  | "run_finished"
  | "run_error";

export type RunEventPayload =
  | RunStartedPayload
  | AssistantDeltaPayload
  | ReasoningDeltaPayload
  | ToolCallPayload
  | ToolResultPayload
  | AssistantMessageFinalPayload
  | RunFinishedPayload
  | RunErrorPayload;
