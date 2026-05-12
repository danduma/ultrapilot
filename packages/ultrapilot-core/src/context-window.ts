import type { AssistantMessage, AssistantMessagePart } from "./types";

export type ContextWindowConfig = {
	maxInputTokens: number;
	reservedOutputTokens?: number;
	summaryMaxTokens?: number;
	recentMessageCount?: number;
};

export type ContextWindowOverflowDetails = {
	estimatedTokens: number;
	tokenBudget: number;
	maxInputTokens: number;
	reservedOutputTokens: number;
	retainedMessageCount: number;
};

export class ContextWindowOverflowError extends Error {
	readonly estimatedTokens: number;
	readonly tokenBudget: number;
	readonly maxInputTokens: number;
	readonly reservedOutputTokens: number;
	readonly retainedMessageCount: number;

	constructor(details: ContextWindowOverflowDetails) {
		super(
			`Conversation is too large for the configured context window (${details.estimatedTokens}/${details.tokenBudget} estimated input tokens).`,
		);
		this.name = "ContextWindowOverflowError";
		this.estimatedTokens = details.estimatedTokens;
		this.tokenBudget = details.tokenBudget;
		this.maxInputTokens = details.maxInputTokens;
		this.reservedOutputTokens = details.reservedOutputTokens;
		this.retainedMessageCount = details.retainedMessageCount;
	}
}

function stringifyForEstimate(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function estimateTextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function estimateValueTokens(value: unknown): number {
	return estimateTextTokens(stringifyForEstimate(value));
}

function estimatePartTokens(part: AssistantMessagePart): number {
	if (part.type === "text" || part.type === "reasoning") {
		return estimateTextTokens(part.text);
	}

	if (part.type === "tool-call") {
		return (
			estimateTextTokens(part.toolName) + estimateValueTokens(part.args) + 8
		);
	}

	return (
		estimateTextTokens(part.toolName) + estimateValueTokens(part.result) + 8
	);
}

export function estimateMessageTokens(message: AssistantMessage): number {
	return (
		8 +
		estimateTextTokens(message.role) +
		message.parts.reduce((total, part) => total + estimatePartTokens(part), 0)
	);
}

export function estimateMessagesTokens(messages: AssistantMessage[]): number {
	return messages.reduce(
		(total, message) => total + estimateMessageTokens(message),
		0,
	);
}

function partToSummaryText(part: AssistantMessagePart): string {
	if (part.type === "text" || part.type === "reasoning") {
		return part.text;
	}

	if (part.type === "tool-call") {
		return `Tool call ${part.toolName}: ${stringifyForEstimate(part.args)}`;
	}

	return `Tool result ${part.toolName}${part.isError ? " error" : ""}: ${stringifyForEstimate(part.result)}`;
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
	const maxChars = Math.max(32, maxTokens * 4);
	if (text.length <= maxChars) {
		return text;
	}

	return `${text.slice(0, maxChars).trimEnd()}\n[summary truncated]`;
}

function summarizeMessages(
	messages: AssistantMessage[],
	summaryMaxTokens: number,
): string {
	const lines = messages.map((message, index) => {
		const text = message.parts.map(partToSummaryText).join("\n");
		return `${index + 1}. ${message.role}: ${text}`;
	});

	return truncateToTokenBudget(lines.join("\n"), summaryMaxTokens);
}

function createSummaryMessage({
	messages,
	fallback,
	summaryMaxTokens,
}: {
	messages: AssistantMessage[];
	fallback: AssistantMessage | undefined;
	summaryMaxTokens: number;
}): AssistantMessage | null {
	if (messages.length === 0) {
		return null;
	}

	const anchor = messages[0] ?? fallback;
	return {
		id: `context-summary-${messages[0]?.id ?? "root"}`,
		threadId: anchor?.threadId ?? "context-summary-thread",
		branchId: anchor?.branchId ?? "context-summary-branch",
		role: "assistant",
		createdAt: anchor?.createdAt ?? new Date().toISOString(),
		parts: [
			{
				type: "text",
				text: `Earlier conversation summary (${messages.length} messages omitted to fit the context window):\n${summarizeMessages(messages, summaryMaxTokens)}`,
			},
		],
		metadata: {
			contextWindowSummary: true,
			omittedMessageCount: messages.length,
		},
	};
}

function candidateMessages({
	systemMessages,
	summarizedMessages,
	retainedMessages,
	summaryMaxTokens,
}: {
	systemMessages: AssistantMessage[];
	summarizedMessages: AssistantMessage[];
	retainedMessages: AssistantMessage[];
	summaryMaxTokens: number;
}) {
	const summary = createSummaryMessage({
		messages: summarizedMessages,
		fallback: retainedMessages[0],
		summaryMaxTokens,
	});

	return [
		...systemMessages,
		...(summary ? [summary] : []),
		...retainedMessages,
	];
}

export function fitMessagesToContextWindow(
	messages: AssistantMessage[],
	config: ContextWindowConfig | undefined,
): AssistantMessage[] {
	if (!config) {
		return messages;
	}

	const reservedOutputTokens = config.reservedOutputTokens ?? 0;
	const tokenBudget = Math.max(1, config.maxInputTokens - reservedOutputTokens);
	if (estimateMessagesTokens(messages) <= tokenBudget) {
		return messages;
	}

	const summaryMaxTokens = config.summaryMaxTokens ?? 2_000;
	const recentMessageCount = Math.max(1, config.recentMessageCount ?? 12);
	const systemMessages = messages.filter(
		(message) => message.role === "system",
	);
	const conversationMessages = messages.filter(
		(message) => message.role !== "system",
	);

	let retainedMessages = conversationMessages.slice(-recentMessageCount);
	let summarizedMessages = conversationMessages.slice(
		0,
		Math.max(0, conversationMessages.length - retainedMessages.length),
	);
	let candidate = candidateMessages({
		systemMessages,
		summarizedMessages,
		retainedMessages,
		summaryMaxTokens,
	});

	while (estimateMessagesTokens(candidate) > tokenBudget) {
		if (retainedMessages.length <= 1) {
			break;
		}

		const nextSummarized = retainedMessages[0];
		if (!nextSummarized) {
			break;
		}
		summarizedMessages = [...summarizedMessages, nextSummarized];
		retainedMessages = retainedMessages.slice(1);
		candidate = candidateMessages({
			systemMessages,
			summarizedMessages,
			retainedMessages,
			summaryMaxTokens,
		});
	}

	const estimatedTokens = estimateMessagesTokens(candidate);
	if (estimatedTokens > tokenBudget) {
		throw new ContextWindowOverflowError({
			estimatedTokens,
			tokenBudget,
			maxInputTokens: config.maxInputTokens,
			reservedOutputTokens,
			retainedMessageCount: retainedMessages.length,
		});
	}

	return candidate;
}
