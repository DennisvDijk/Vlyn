export type ToolCall = { id: string; name: string; arguments: Record<string, unknown>; argumentsText: string };
export type ReasoningBlock = { id?: string; text: string; signature?: string };
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
};
export type ModelTurn = {
  text: string;
  toolCalls: ToolCall[];
  reasoning: ReasoningBlock[];
  /** Provider output items, replayed in order on the next Responses request. */
  outputItems: unknown[];
  usage: ModelUsage;
  incomplete: boolean;
};

export type TurnHooks = {
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolDelta?: (delta: { id: string; name?: string; text: string }) => void;
};

export const emptyUsage = (): ModelUsage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: null });
