import { TokenJS } from "token.js";
import type {
	GenerateRequest,
	ModelAdapter,
} from "@ultrapilot/core/provider";
import type {
	AssistantMessage,
	AssistantToolCall,
} from "@ultrapilot/core/types";

type TokenLike = {
	chat: {
		completions: {
			create: (args: unknown) => Promise<unknown>;
		};
	};
};

type TokenCompletionResponse = {
	id?: string;
	choices?: Array<{
		message?: Record<string, unknown>;
		finish_reason?: string;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		reasoning_tokens?: number;
	};
};

type OpenAIProviderOptions = {
	apiKey: string;
	model: string;
	tokenjsFactory?: (apiKey: string) => TokenLike;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toToolCalls(raw: unknown): AssistantToolCall[] {
	if (!Array.isArray(raw)) {
		return [];
	}

	return raw
		.map((entry) => {
			if (!isRecord(entry) || !isRecord(entry.function)) {
				return null;
			}
			let args: Record<string, unknown> = {};
			const rawArgs = entry.function.arguments;
			if (typeof rawArgs === "string" && rawArgs.length > 0) {
				try {
					const parsed = JSON.parse(rawArgs);
					if (isRecord(parsed)) {
						args = parsed;
					}
				} catch {
					args = {};
				}
			}

			return {
				toolCallId:
					typeof entry.id === "string" ? entry.id : crypto.randomUUID(),
				toolName:
					typeof entry.function.name === "string"
						? entry.function.name
						: "unknown_tool",
				args,
			};
		})
		.filter((value): value is AssistantToolCall => value != null);
}

function toTokenMessages(messages: AssistantMessage[]) {
	return messages.map((message) => ({
		role: message.role,
		content: message.parts
			.map((part) => {
				if (part.type === "text" || part.type === "reasoning") {
					return part.text;
				}
				if (part.type === "tool-result") {
					return JSON.stringify(part.result);
				}
				if (part.type === "tool-call") {
					return `Tool request: ${part.toolName} ${JSON.stringify(part.args)}`;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n"),
	}));
}

function toTokenTools(tools: GenerateRequest["tools"]) {
	return Object.entries(tools).map(([name, definition]) => ({
		type: "function",
		function: {
			name,
			description: definition.description,
			parameters: definition.inputSchema,
		},
	}));
}

export function normalizeOpenAIMessage(message: Record<string, unknown>) {
	return {
		text: typeof message.content === "string" ? message.content : "",
		reasoning: typeof message.reasoning === "string" ? [message.reasoning] : [],
		toolCalls: toToolCalls(message.tool_calls),
	};
}

export function createOpenAIProvider(
	options: OpenAIProviderOptions,
): ModelAdapter & { options: OpenAIProviderOptions } {
	const tokenjsFactory =
		options.tokenjsFactory ??
		((apiKey: string) => new TokenJS({ apiKey }) as unknown as TokenLike);

	return {
		id: `openai:${options.model}`,
		options,
		capabilities: {
			reasoning: true,
			toolCalls: true,
		},
		classifyError(error) {
			const message =
				error instanceof Error
					? error.message
					: "Unknown OpenAI provider error";
			const lower = message.toLowerCase();
			return {
				retryable:
					lower.includes("429") ||
					lower.includes("rate limit") ||
					lower.includes("timeout") ||
					lower.includes("temporar"),
				message,
			};
		},
		async generate(input) {
			const client = tokenjsFactory(options.apiKey);
			const response = (await client.chat.completions.create({
				provider: "openai",
				model: options.model,
				messages: toTokenMessages(input.messages),
				tools: toTokenTools(input.tools),
			})) as TokenCompletionResponse;
			const message = response?.choices?.[0]?.message ?? {};
			const normalized = normalizeOpenAIMessage(message);
			return {
				id:
					typeof response?.id === "string" ? response.id : crypto.randomUUID(),
				text: normalized.text,
				reasoning: normalized.reasoning,
				toolCalls: normalized.toolCalls,
				usage: {
					inputTokens: response?.usage?.prompt_tokens,
					outputTokens: response?.usage?.completion_tokens,
					reasoningTokens: response?.usage?.reasoning_tokens,
				},
				providerMetadata: {
					finishReason: response?.choices?.[0]?.finish_reason,
				},
			};
		},
	};
}
