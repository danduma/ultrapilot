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
	extendModelList?: (
		provider: string,
		model: string,
		featureSupport: string,
	) => unknown;
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

type GoogleProviderOptions = {
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
			const rawArgs = entry.function.arguments;
			let args: Record<string, unknown> = {};
			if (typeof rawArgs === "string" && rawArgs.length > 0) {
				try {
					const parsed = JSON.parse(rawArgs);
					if (isRecord(parsed)) {
						args = parsed;
					}
				} catch {
					args = {};
				}
			} else if (isRecord(rawArgs)) {
				args = rawArgs;
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

function toReasoning(raw: unknown): string[] {
	if (typeof raw === "string" && raw.length > 0) {
		return [raw];
	}
	if (Array.isArray(raw)) {
		return raw.filter((entry): entry is string => typeof entry === "string");
	}
	return [];
}

function toTokenMessages(messages: AssistantMessage[]) {
	return messages.map((message) => {
		if (message.role === "tool") {
			return {
				role: "tool",
				content: message.parts
					.map((part) =>
						part.type === "tool-result" ? JSON.stringify(part.result) : "",
					)
					.join("\n"),
			};
		}

		return {
			role: message.role,
			content: message.parts
				.map((part) => {
					if (part.type === "text" || part.type === "reasoning") {
						return part.text;
					}
					if (part.type === "tool-call") {
						return `Tool request: ${part.toolName} ${JSON.stringify(part.args)}`;
					}
					if (part.type === "tool-result") {
						return `Tool result for ${part.toolName}: ${JSON.stringify(part.result)}`;
					}
					return "";
				})
				.filter(Boolean)
				.join("\n"),
		};
	});
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

function registerGoogleModel(client: TokenLike, model: string) {
	if (!client.extendModelList) {
		return;
	}

	try {
		client.extendModelList("gemini", model, "gemini-1.5-pro");
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes("conflicts with an existing pre-defined model name")
		) {
			return;
		}
		throw error;
	}
}

export function normalizeGoogleMessage(message: Record<string, unknown>) {
	return {
		text: typeof message.content === "string" ? message.content : "",
		reasoning: toReasoning(message.reasoning),
		toolCalls: toToolCalls(message.tool_calls),
	};
}

export function createGoogleProvider(
	options: GoogleProviderOptions,
): ModelAdapter & { options: GoogleProviderOptions } {
	const tokenjsFactory =
		options.tokenjsFactory ??
		((apiKey: string) => new TokenJS({ apiKey }) as unknown as TokenLike);

	return {
		id: `google:${options.model}`,
		options,
		capabilities: {
			reasoning: true,
			toolCalls: true,
		},
		classifyError(error) {
			const message =
				error instanceof Error
					? error.message
					: "Unknown Google provider error";
			const lower = message.toLowerCase();
			return {
				retryable:
					lower.includes("cannot connect") ||
					lower.includes("other side closed") ||
					lower.includes("timeout") ||
					lower.includes("timed out") ||
					lower.includes("network"),
				message,
			};
		},
		async generate(input) {
			const client = tokenjsFactory(options.apiKey);
			registerGoogleModel(client, options.model);
			const response = (await client.chat.completions.create({
				provider: "gemini",
				model: options.model,
				messages: toTokenMessages(input.messages),
				tools: toTokenTools(input.tools),
			})) as TokenCompletionResponse;
			const message = response?.choices?.[0]?.message ?? {};
			const normalized = normalizeGoogleMessage(message);
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
