// AssistantMessage <-> Mastra message/UI-message conversion and response
// normalization (text, reasoning, tool calls, provider metadata, multimodal
// user parts).
//
// Ported verbatim (behavior-preserving) from
// apps/web/src/lib/ultrapilot/mastra-provider.ts plus the framework-agnostic
// message sanitizers (model-message-sanitizer.ts / assistant-message-sanitizer.ts).
// This module knows the Mastra wire shape but pulls in NO @mastra/* runtime; it
// is pure data transformation over @ultrapilot/core types.

import type {
	AssistantMessage,
	AssistantMessagePart,
	AssistantToolCall,
	PartProviderOptions,
} from "@ultrapilot/core/types";

// ---------------------------------------------------------------------------
// Mastra wire types
// ---------------------------------------------------------------------------

export type MastraProviderOptions = Record<string, Record<string, unknown>>;

export type MastraToolCall = {
	toolCallId?: string;
	toolName?: string;
	args?: Record<string, unknown>;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

export type MastraImageContentPart = {
	type: "image";
	/** URL or `data:` URI, mirroring AI SDK / Mastra image content. */
	image: string;
	mediaType?: string;
	providerOptions?: MastraProviderOptions;
	providerMetadata?: MastraProviderOptions;
};

export type MastraTextContentPart = {
	type: "text";
	text: string;
	providerOptions?: MastraProviderOptions;
	providerMetadata?: MastraProviderOptions;
};

export type MastraUserContentPart = MastraTextContentPart | MastraImageContentPart;

export type MastraAssistantContentPart =
	| {
			type: "text" | "reasoning";
			text: string;
			providerOptions?: MastraProviderOptions;
			providerMetadata?: MastraProviderOptions;
	  }
	| MastraImageContentPart
	| {
			type: "tool-call";
			toolCallId: string;
			toolName: string;
			input?: Record<string, unknown>;
			args?: Record<string, unknown>;
			providerOptions?: MastraProviderOptions;
			providerMetadata?: MastraProviderOptions;
			callProviderMetadata?: MastraProviderOptions;
	  };

export type MastraUiMessage =
	| {
			id?: string;
			role: "user";
			parts: Array<
				| {
						type: "text";
						text: string;
						providerMetadata?: MastraProviderOptions;
				  }
				| {
						type: "image";
						image: string;
						mediaType?: string;
						providerMetadata?: MastraProviderOptions;
				  }
			>;
			metadata?: { providerMetadata?: MastraProviderOptions };
	  }
	| {
			id?: string;
			role: "assistant";
			parts: Array<
				| {
						type: "text" | "reasoning";
						text: string;
						providerMetadata?: MastraProviderOptions;
				  }
				| {
						type: `tool-${string}`;
						toolCallId: string;
						state: "input-available";
						input: Record<string, unknown>;
						callProviderMetadata?: MastraProviderOptions;
						providerExecuted?: boolean;
				  }
				| {
						type: `tool-${string}`;
						toolCallId: string;
						state: "output-available";
						input: Record<string, unknown>;
						output: unknown;
						callProviderMetadata?: MastraProviderOptions;
				  }
			>;
			metadata?: { providerMetadata?: MastraProviderOptions };
	  };

export type MastraGenerateResult = {
	text?: string;
	reasoning?: unknown;
	toolCalls?: MastraToolCall[];
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		reasoningTokens?: number;
	};
	providerMetadata?: Record<string, unknown>;
	experimental_providerMetadata?: Record<string, unknown>;
	response?: {
		messages?: MastraMessage[];
	};
};

export type MastraMessage =
	| {
			id?: string;
			role: "user" | "system";
			/**
			 * String for text-only turns; an array of content parts when a user
			 * message carries images (mixed text + image content). System messages
			 * are always string content.
			 */
			content: string | MastraUserContentPart[];
			providerOptions?: MastraProviderOptions;
	  }
	| {
			id?: string;
			role: "assistant";
			content: string | MastraAssistantContentPart[];
			toolCalls?: Array<{
				toolCallId: string;
				toolName: string;
				args: Record<string, unknown>;
			}>;
			providerOptions?: MastraProviderOptions;
	  }
	| {
			id?: string;
			role: "tool";
			content: Array<{
				type: "tool-result";
				toolCallId: string;
				toolName: string;
				result: unknown;
				isError?: boolean;
			}>;
			providerOptions?: MastraProviderOptions;
	  };

export type MastraGenerateOptions = {
	activeTools?: string[];
	providerOptions?: {
		google?: {
			thinkingConfig?: {
				thinkingLevel?: "minimal" | "low" | "medium" | "high";
			};
		};
	};
};

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isMastraAssistantMessage(
	message: MastraMessage,
): message is Extract<MastraMessage, { role: "assistant" }> {
	return message.role === "assistant";
}

export function isMastraAssistantContentPart(
	value: unknown,
): value is MastraAssistantContentPart {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}

	if (
		(value.type === "text" || value.type === "reasoning") &&
		typeof value.text === "string"
	) {
		return true;
	}

	if (value.type === "image" && typeof value.image === "string") {
		return true;
	}

	return (
		value.type === "tool-call" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		(isRecord(value.input) || isRecord(value.args))
	);
}

/**
 * Returns true if a content part is structurally usable by Mastra (text,
 * reasoning, or tool-call). Unknown part shapes (e.g. provider-specific
 * thought blocks Mastra adds in newer SDKs) are filtered out without
 * discarding the whole assistant turn. That keeps recognized sibling
 * tool-call parts and their `thoughtSignature`s alive.
 */
export function partHasUsableShape(value: unknown): boolean {
	return isMastraAssistantContentPart(value);
}

// ---------------------------------------------------------------------------
// Provider-options normalization
// ---------------------------------------------------------------------------

export function normalizeProviderOptions(
	value: unknown,
): PartProviderOptions | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const cloned: PartProviderOptions = {};
	let hasEntry = false;
	for (const [providerId, providerValue] of Object.entries(value)) {
		if (isRecord(providerValue)) {
			cloned[providerId] = { ...providerValue };
			hasEntry = true;
		}
	}
	return hasEntry ? cloned : undefined;
}

/**
 * Reads provider-specific per-part metadata into the canonical
 * `PartProviderOptions` shape. The ecosystem uses all three field names in
 * different places:
 * - AI SDK model messages send `providerOptions`
 * - AI SDK response content returns `providerMetadata`
 * - AI SDK UI tool parts store call metadata as `callProviderMetadata`
 */
export function pickPartProviderOptions(
	value: unknown,
): PartProviderOptions | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return (
		normalizeProviderOptions(value.providerOptions) ??
		normalizeProviderOptions(value.providerMetadata) ??
		normalizeProviderOptions(value.callProviderMetadata)
	);
}

// ---------------------------------------------------------------------------
// AssistantMessage -> Mastra wire conversion
// ---------------------------------------------------------------------------

export function assistantMessageToText(message: AssistantMessage): string {
	return message.parts
		.flatMap((part) => {
			if (part.type === "text" || part.type === "reasoning") {
				return [part.text];
			}
			return [];
		})
		.join("\n");
}

/**
 * Builds Mastra user-message content. Text-only user turns collapse to a
 * single string (the historical shape). When the message carries any image
 * parts, content becomes an array of `{ type: "text" }` / `{ type: "image" }`
 * parts so the image survives to the wire.
 */
export function toMastraUserContent(
	message: AssistantMessage,
): string | MastraUserContentPart[] {
	const hasImage = message.parts.some((part) => part.type === "image");
	if (!hasImage) {
		return assistantMessageToText(message);
	}
	return message.parts.flatMap<MastraUserContentPart>((part) => {
		if (part.type === "text" || part.type === "reasoning") {
			if (part.text.length === 0) {
				return [];
			}
			const textPart: MastraUserContentPart = {
				type: "text",
				text: part.text,
				...(part.providerOptions
					? { providerOptions: part.providerOptions }
					: {}),
			};
			return [textPart];
		}
		if (part.type === "image") {
			const imagePart: MastraUserContentPart = {
				type: "image",
				image: part.image,
				...(part.mediaType ? { mediaType: part.mediaType } : {}),
				...(part.providerOptions
					? { providerOptions: part.providerOptions }
					: {}),
			};
			return [imagePart];
		}
		return [];
	});
}

export function toMastraAssistantContent(
	message: AssistantMessage,
): MastraAssistantContentPart[] {
	return message.parts.flatMap<MastraAssistantContentPart>((part) => {
		if (part.type === "text" || part.type === "reasoning") {
			return [
				{
					type: part.type,
					text: part.text,
					...(part.providerOptions
						? { providerOptions: part.providerOptions }
						: {}),
				},
			];
		}
		if (part.type === "image") {
			return [
				{
					type: "image" as const,
					image: part.image,
					...(part.mediaType ? { mediaType: part.mediaType } : {}),
					...(part.providerOptions
						? { providerOptions: part.providerOptions }
						: {}),
				},
			];
		}
		if (part.type === "tool-call") {
			return [
				{
					type: "tool-call" as const,
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					input: part.args,
					...(part.providerOptions
						? { providerOptions: part.providerOptions }
						: {}),
				},
			];
		}
		return [];
	});
}

export function rawResponseMessagesFromMetadata(
	metadata: AssistantMessage["metadata"],
): MastraMessage[] | null {
	const providerMetadata = metadata.providerMetadata;
	if (!isRecord(providerMetadata)) {
		return null;
	}
	const rawResponseMessages = providerMetadata.rawResponseMessages;
	if (!Array.isArray(rawResponseMessages)) {
		return null;
	}

	const normalized = rawResponseMessages.filter(isRecord).flatMap((message) => {
		if (message.role !== "assistant") {
			return [];
		}
		if (!("content" in message)) {
			return [];
		}
		const content = message.content;
		if (typeof content !== "string" && !Array.isArray(content)) {
			return [];
		}

		// Keep the envelope even when it contains unknown part shapes. Dropping
		// the whole message strips Gemini thoughtSignatures from sibling
		// tool-call parts and re-creates the "position N" replay error.
		const filteredContent = Array.isArray(content)
			? content.filter((part) => {
					if (partHasUsableShape(part)) {
						return true;
					}
					if (typeof console !== "undefined") {
						console.warn(
							"[mastra-provider] dropping unrecognized assistant part shape from history replay",
							{ part },
						);
					}
					return false;
				})
			: content;

		const providerOptions = pickPartProviderOptions(message);
		return [
			{
				id: typeof message.id === "string" ? message.id : undefined,
				role: "assistant" as const,
				content: filteredContent,
				...(providerOptions ? { providerOptions } : {}),
			},
		];
	});

	return normalized.length > 0 ? normalized : null;
}

// ---------------------------------------------------------------------------
// Echo-stripping
// ---------------------------------------------------------------------------

export function stableSerializeForEchoComparison(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableSerializeForEchoComparison(entry)).join(",")}]`;
	}
	return `{${Object.keys(value)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${stableSerializeForEchoComparison((value as Record<string, unknown>)[key])}`,
		)
		.join(",")}}`;
}

export function assistantContentParts(message: MastraMessage) {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return [];
	}
	return message.content.filter(isMastraAssistantContentPart);
}

export function toolCallInputForEchoComparison(part: MastraAssistantContentPart) {
	if (part.type !== "tool-call") {
		return {};
	}
	return (
		(isRecord(part.input) ? part.input : null) ??
		(isRecord(part.args) ? part.args : null) ??
		{}
	);
}

export function assistantContentPartsMatchForEcho(
	left: MastraAssistantContentPart,
	right: MastraAssistantContentPart,
) {
	if (left.type !== right.type) {
		return false;
	}
	if (left.type === "text") {
		return right.type === "text" && left.text === right.text;
	}
	if (left.type === "reasoning") {
		return right.type === "reasoning" && left.text === right.text;
	}
	if (left.type !== "tool-call" || right.type !== "tool-call") {
		return false;
	}
	return (
		left.toolCallId === right.toolCallId &&
		left.toolName === right.toolName &&
		stableSerializeForEchoComparison(toolCallInputForEchoComparison(left)) ===
			stableSerializeForEchoComparison(toolCallInputForEchoComparison(right))
	);
}

/**
 * Mastra/AI SDK can return an assistant response envelope that begins with
 * prompt assistant parts, especially when the prompt contains synthetic
 * context-window summaries. Persisting that echo makes prompt-only summaries
 * visible in chat and can replay already-satisfied tool calls as if they were
 * new model output. Strip only an exact leading echo of the assistant prompt.
 */
export function stripEchoedAssistantPromptParts(
	responseMessages: MastraMessage[],
	promptMessages: MastraMessage[],
): MastraMessage[] {
	const promptParts = promptMessages.flatMap(assistantContentParts);
	if (promptParts.length === 0 || responseMessages.length === 0) {
		return responseMessages;
	}

	let promptPartIndex = 0;
	let didStrip = false;
	const stripped: MastraMessage[] = [];

	for (const message of responseMessages) {
		if (
			message.role !== "assistant" ||
			!Array.isArray(message.content) ||
			promptPartIndex >= promptParts.length
		) {
			stripped.push(message);
			continue;
		}

		let stripCount = 0;
		for (const part of message.content) {
			const promptPart = promptParts[promptPartIndex];
			if (
				!isMastraAssistantContentPart(part) ||
				!promptPart ||
				!assistantContentPartsMatchForEcho(part, promptPart)
			) {
				break;
			}
			stripCount += 1;
			promptPartIndex += 1;
		}

		if (stripCount === 0) {
			stripped.push(message);
			continue;
		}

		didStrip = true;
		const content = message.content.slice(stripCount);
		if (content.length > 0) {
			stripped.push({ ...message, content });
		}
	}

	return didStrip ? stripped : responseMessages;
}

// ---------------------------------------------------------------------------
// Tool-call extraction from AssistantMessage parts
// ---------------------------------------------------------------------------

export function toMastraToolCalls(message: AssistantMessage) {
	return message.parts.flatMap((part) => {
		if (part.type !== "tool-call") {
			return [];
		}
		return [
			{
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				args: part.args,
			},
		];
	});
}

export function toolPartType(toolName: string): `tool-${string}` {
	return `tool-${toolName}` as `tool-${string}`;
}

export function toMastraUiMessages(messages: MastraMessage[]): MastraUiMessage[] {
	const toolInputsByCallId = new Map<string, Record<string, unknown>>();
	const toolMetadataByCallId = new Map<string, MastraProviderOptions>();

	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			if (!isRecord(part) || part.type !== "tool-call") {
				continue;
			}
			if (
				typeof part.toolCallId !== "string" ||
				typeof part.toolName !== "string"
			) {
				continue;
			}
			const input =
				(isRecord(part.input) ? part.input : null) ??
				(isRecord(part.args) ? part.args : null) ??
				{};
			toolInputsByCallId.set(part.toolCallId, input);
			const providerMetadata = pickPartProviderOptions(part);
			if (providerMetadata) {
				toolMetadataByCallId.set(part.toolCallId, providerMetadata);
			}
		}
	}

	return messages.flatMap<MastraUiMessage>((message) => {
		const messageProviderMetadata = pickPartProviderOptions(message);
		const metadata = messageProviderMetadata
			? { providerMetadata: messageProviderMetadata }
			: undefined;

		if (message.role === "user") {
			type UserPart = Extract<MastraUiMessage, { role: "user" }>["parts"][number];
			const userParts: UserPart[] = Array.isArray(message.content)
				? message.content.flatMap<UserPart>((part) => {
						if (part.type === "text") {
							const providerMetadata =
								part.providerOptions ?? part.providerMetadata;
							const textPart: UserPart = {
								type: "text",
								text: part.text,
								...(providerMetadata ? { providerMetadata } : {}),
							};
							return [textPart];
						}
						if (part.type === "image") {
							const providerMetadata =
								part.providerOptions ?? part.providerMetadata;
							const imagePart: UserPart = {
								type: "image",
								image: part.image,
								...(part.mediaType ? { mediaType: part.mediaType } : {}),
								...(providerMetadata ? { providerMetadata } : {}),
							};
							return [imagePart];
						}
						return [];
					})
				: [
						{
							type: "text",
							text: message.content,
							...(messageProviderMetadata
								? { providerMetadata: messageProviderMetadata }
								: {}),
						},
					];
			const userMessage: MastraUiMessage = {
				id: message.id,
				role: "user",
				parts: userParts,
				...(metadata ? { metadata } : {}),
			};
			return [userMessage];
		}

		if (message.role === "assistant") {
			type AssistantPart = Extract<
				MastraUiMessage,
				{ role: "assistant" }
			>["parts"][number];
			const parts: AssistantPart[] =
				typeof message.content === "string"
					? message.content.length > 0
						? [{ type: "text" as const, text: message.content }]
						: []
					: message.content.flatMap<AssistantPart>(
							(part) => {
								const providerMetadata = pickPartProviderOptions(part);
								if (part.type === "text" || part.type === "reasoning") {
									if (part.text.length === 0) {
										return [];
									}
									return [
										{
											type: part.type,
											text: part.text,
											...(providerMetadata ? { providerMetadata } : {}),
										},
									];
								}
								if (part.type === "tool-call") {
									const input = part.input ?? part.args ?? {};
									return [
										{
											type: toolPartType(part.toolName),
											toolCallId: part.toolCallId,
											state: "input-available",
											input,
											...(providerMetadata
												? { callProviderMetadata: providerMetadata }
												: {}),
										},
									];
								}
								return [];
							},
						);

			if (parts.length === 0) {
				return [];
			}
			const assistantMessage: MastraUiMessage = {
				id: message.id,
				role: "assistant",
				parts,
				...(metadata ? { metadata } : {}),
			};
			return [assistantMessage];
		}

		if (message.role !== "tool") {
			return [];
		}

		const parts = message.content.map((entry) => {
			const callProviderMetadata = toolMetadataByCallId.get(entry.toolCallId);
			return {
				type: toolPartType(entry.toolName),
				toolCallId: entry.toolCallId,
				state: "output-available" as const,
				input: toolInputsByCallId.get(entry.toolCallId) ?? {},
				output: entry.result,
				...(callProviderMetadata ? { callProviderMetadata } : {}),
			};
		});

		if (parts.length === 0) {
			return [];
		}
		const toolMessage: MastraUiMessage = {
			id: message.id,
			role: "assistant",
			parts,
			...(metadata ? { metadata } : {}),
		};
		return [toolMessage];
	});
}

// ---------------------------------------------------------------------------
// Response-message normalization (inbound)
// ---------------------------------------------------------------------------

/**
 * Inbound counterpart: builds AssistantMessagePart[] for the runner to
 * persist verbatim, carrying per-part `providerOptions` from Mastra's
 * response so signatures survive storage and outbound replay without
 * relying on the `rawResponseMessages` envelope.
 */
export function buildAssistantPartsFromResponseMessages(
	messages: MastraMessage[],
): AssistantMessagePart[] {
	const parts: AssistantMessagePart[] = [];

	for (const message of messages) {
		if (!isMastraAssistantMessage(message) || !Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			if (!isRecord(part)) {
				continue;
			}
			const providerOptions = pickPartProviderOptions(part);
			if (part.type === "text" && typeof part.text === "string") {
				parts.push({
					type: "text",
					text: part.text,
					...(providerOptions ? { providerOptions } : {}),
				});
				continue;
			}
			if (part.type === "reasoning" && typeof part.text === "string") {
				parts.push({
					type: "reasoning",
					text: part.text,
					...(providerOptions ? { providerOptions } : {}),
				});
				continue;
			}
			if (
				part.type === "tool-call" &&
				typeof part.toolCallId === "string" &&
				typeof part.toolName === "string"
			) {
				const args =
					(isRecord(part.input) ? part.input : null) ??
					(isRecord(part.args) ? part.args : null) ??
					{};
				parts.push({
					type: "tool-call",
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					args,
					...(providerOptions ? { providerOptions } : {}),
				});
			}
		}
	}

	return parts;
}

export function normalizeToolCalls(
	raw: MastraToolCall[] | undefined,
): AssistantToolCall[] {
	return (raw ?? []).map((toolCall) => ({
		toolCallId: toolCall.toolCallId ?? toolCall.id ?? crypto.randomUUID(),
		toolName: toolCall.toolName ?? toolCall.name ?? "unknown_tool",
		args: toolCall.args ?? toolCall.arguments ?? {},
	}));
}

export function normalizeToolCallsFromResponseMessages(
	messages: MastraMessage[] | undefined,
): AssistantToolCall[] {
	if (!messages) {
		return [];
	}

	return messages.flatMap((message) => {
		if (!isMastraAssistantMessage(message) || !Array.isArray(message.content)) {
			return [];
		}

		return message.content.flatMap((part) => {
			if (part.type !== "tool-call") {
				return [];
			}

			return [
				{
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					args: part.input ?? part.args ?? {},
				},
			];
		});
	});
}

export function normalizeTextAndReasoningFromResponseMessages(
	messages: MastraMessage[] | undefined,
) {
	const text: string[] = [];
	const reasoning: string[] = [];

	for (const message of messages ?? []) {
		if (!isMastraAssistantMessage(message)) {
			continue;
		}
		if (typeof message.content === "string") {
			if (message.content.length > 0) {
				text.push(message.content);
			}
			continue;
		}

		for (const part of message.content) {
			if (part.type === "text" && part.text.length > 0) {
				text.push(part.text);
			}
			if (part.type === "reasoning" && part.text.length > 0) {
				reasoning.push(part.text);
			}
		}
	}

	return {
		text: text.join("\n"),
		reasoning,
	};
}

export function normalizeReasoning(reasoning: unknown): string[] {
	if (typeof reasoning === "string" && reasoning.length > 0) {
		return [reasoning];
	}
	if (Array.isArray(reasoning)) {
		return reasoning.flatMap((entry) => {
			if (typeof entry === "string" && entry.length > 0) {
				return [entry];
			}
			if (
				entry &&
				typeof entry === "object" &&
				"text" in entry &&
				typeof entry.text === "string" &&
				entry.text.length > 0
			) {
				return [entry.text];
			}
			return [];
		});
	}
	return [];
}

export function assertHasConversationMessages(messages: readonly unknown[]) {
	if (messages.length === 0) {
		throw new Error(
			"Cannot generate without at least one conversation message.",
		);
	}
}

// ---------------------------------------------------------------------------
// Message sanitizers (ported from model-message-sanitizer.ts /
// assistant-message-sanitizer.ts — framework-agnostic, core-types only)
// ---------------------------------------------------------------------------

function summarizePreviewFromContext({
	key,
	parent,
}: {
	key: string;
	parent: Record<string, unknown> | null;
}) {
	if (key === "posterUrl" || key === "thumbnailUrl") {
		return "[image preview omitted]";
	}

	if (key === "mediaUrl" || key === "url") {
		if (parent?.mediaType === "video" || parent?.type === "video") {
			return "[video preview omitted]";
		}
		if (parent?.mediaType === "audio" || parent?.type === "audio") {
			return "[audio preview omitted]";
		}
		return "[media preview omitted]";
	}

	if (key === "browserUrl") {
		return "[blob URL omitted]";
	}

	return null;
}

function sanitizeString(
	value: string,
	{
		key,
		parent,
	}: {
		key: string | null;
		parent: Record<string, unknown> | null;
	},
) {
	if (value.startsWith("data:image/")) {
		return "[image preview omitted]";
	}
	if (value.startsWith("data:video/")) {
		return "[video preview omitted]";
	}
	if (value.startsWith("data:audio/")) {
		return "[audio preview omitted]";
	}
	if (value.startsWith("blob:")) {
		return "[blob URL omitted]";
	}

	if (key) {
		const previewSummary = summarizePreviewFromContext({ key, parent });
		if (previewSummary) {
			return previewSummary;
		}
	}

	return value;
}

function sanitizeValueForModel(
	value: unknown,
	context: {
		key?: string | null;
		parent?: Record<string, unknown> | null;
	} = {},
): unknown {
	if (typeof value === "string") {
		return sanitizeString(value, {
			key: context.key ?? null,
			parent: context.parent ?? null,
		});
	}

	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeValueForModel(entry));
	}

	if (!isRecord(value)) {
		return value;
	}

	const sanitized: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		sanitized[key] = sanitizeValueForModel(entry, {
			key,
			parent: value,
		});
	}
	return sanitized;
}

export function sanitizeMessagesForModel(
	messages: AssistantMessage[],
): AssistantMessage[] {
	let didChange = false;
	const nextMessages = messages.map((message) => {
		let partsChanged = false;
		const nextParts = message.parts.map((part) => {
			if (part.type === "tool-result") {
				const result = sanitizeValueForModel(part.result);
				if (result !== part.result) {
					didChange = true;
					partsChanged = true;
					return { ...part, result };
				}
			}

			if (part.type === "tool-call") {
				const args = sanitizeValueForModel(part.args);
				if (args !== part.args) {
					didChange = true;
					partsChanged = true;
					return { ...part, args: args as Record<string, unknown> };
				}
			}

			return part;
		});

		return partsChanged ? { ...message, parts: nextParts } : message;
	});

	return didChange ? nextMessages : messages;
}

type RoleLike = {
	role: string;
};

export function selectTerminalAssistantMessages<T extends RoleLike>(
	messages: T[] | undefined,
): T[] {
	if (!messages) {
		return [];
	}

	const assistantMessages = messages.filter(
		(message) => message.role === "assistant",
	);
	if (assistantMessages.length <= 1) {
		return assistantMessages;
	}

	const terminalAssistantMessage = assistantMessages.at(-1);
	return terminalAssistantMessage ? [terminalAssistantMessage] : [];
}
