import type {
	AssistantMessage,
	AssistantMessagePart,
	AssistantToolCall,
	AssistantToolDefinition,
} from "./types";

export type ProviderCapabilities = {
	reasoning: boolean;
	toolCalls: boolean;
};

export type ProviderUsage = {
	inputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
};

export type ProviderErrorClassification = {
	retryable: boolean;
	message: string;
};

export type GenerateRequest = {
	systemPrompt: string;
	messages: AssistantMessage[];
	tools: Record<string, AssistantToolDefinition>;
};

export type GenerateResult = {
	id: string;
	text: string;
	reasoning: string[];
	toolCalls: AssistantToolCall[];
	usage: ProviderUsage;
	providerMetadata: Record<string, unknown>;
	/**
	 * Optional, preferred over (text, reasoning, toolCalls) when present.
	 * Lets adapters return the model's parts verbatim, carrying per-part
	 * `providerOptions` (e.g. Gemini's `thoughtSignature`) so they survive
	 * storage and history replay without depending on a metadata envelope.
	 */
	assistantParts?: AssistantMessagePart[];
};

export interface ModelAdapter {
	readonly id: string;
	readonly capabilities: ProviderCapabilities;
	generate(input: GenerateRequest): Promise<GenerateResult>;
	classifyError?(error: unknown): ProviderErrorClassification;
}
