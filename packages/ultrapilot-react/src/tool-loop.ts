import type { AssistantMessage } from "@ultrapilot/core/types";

type ToolCallPart = Extract<
	AssistantMessage["parts"][number],
	{ type: "tool-call" }
>;

export type ToolExecutionEvent =
	| {
			phase: "start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
	  }
	| {
			phase: "cache-hit";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			result: unknown;
			durationMs: number;
	  }
	| {
			phase: "success";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			result: unknown;
			durationMs: number;
	  }
	| {
			phase: "error";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			error: string;
			durationMs: number;
	  };

function createToolResultMessage(
	toolCallId: string,
	toolName: string,
	result: unknown,
	isError: boolean,
	threadId: string,
	branchId: string,
): AssistantMessage {
	return {
		id: crypto.randomUUID(),
		threadId,
		branchId,
		role: "tool",
		createdAt: new Date().toISOString(),
		parts: [
			{
				type: "tool-result",
				toolCallId,
				toolName,
				result,
				isError,
			},
		],
		metadata: {},
	};
}

function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}

	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
	}

	return `{${Object.keys(value)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${stableSerialize((value as Record<string, unknown>)[key])}`,
		)
		.join(",")}}`;
}

export function createToolResultCacheKey(
	toolName: string,
	args: Record<string, unknown>,
) {
	return `${toolName}:${stableSerialize(args)}`;
}

export function getCachedToolCallKey(
	toolCall: ToolCallPart,
	cache: Map<string, unknown>,
	getToolResultCacheKey?: (
		toolName: string,
		args: Record<string, unknown>,
	) => string | null,
) {
	const cacheKey =
		getToolResultCacheKey?.(toolCall.toolName, toolCall.args) ?? null;
	return cacheKey && cache.has(cacheKey) ? cacheKey : null;
}

export function filterUncachedToolCalls(
	toolCalls: ToolCallPart[],
	cache: Map<string, unknown>,
	getToolResultCacheKey?: (
		toolName: string,
		args: Record<string, unknown>,
	) => string | null,
) {
	return toolCalls.filter(
		(toolCall) => !getCachedToolCallKey(toolCall, cache, getToolResultCacheKey),
	);
}

export function collectSatisfiedToolCallIds(messages: AssistantMessage[]) {
	const satisfiedToolCallIds = new Set<string>();

	for (const message of messages) {
		if (message.role !== "tool") {
			continue;
		}

		for (const part of message.parts) {
			if (part.type === "tool-result") {
				satisfiedToolCallIds.add(part.toolCallId);
			}
		}
	}

	return satisfiedToolCallIds;
}

export function filterUnsatisfiedToolCalls(
	toolCalls: ToolCallPart[],
	satisfiedToolCallIds: Set<string>,
) {
	return toolCalls.filter(
		(toolCall) => !satisfiedToolCallIds.has(toolCall.toolCallId),
	);
}

export function stripCachedToolCallsFromLatestAssistant(
	messages: AssistantMessage[],
	cache: Map<string, unknown>,
	getToolResultCacheKey?: (
		toolName: string,
		args: Record<string, unknown>,
	) => string | null,
	satisfiedToolCallIds?: Set<string>,
) {
	const latestAssistantIndex = [...messages]
		.map((message, index) => ({ message, index }))
		.reverse()
		.find(({ message }) => message.role === "assistant")?.index;
	if (latestAssistantIndex === undefined) {
		return messages;
	}

	const latestAssistant = messages[latestAssistantIndex];
	const nextParts = latestAssistant.parts.filter((part) => {
		if (part.type !== "tool-call") {
			return true;
		}
		if (satisfiedToolCallIds?.has(part.toolCallId)) {
			return false;
		}
		return !getCachedToolCallKey(part, cache, getToolResultCacheKey);
	});

	if (nextParts.length === latestAssistant.parts.length) {
		return messages;
	}

	return messages.map((message, index) =>
		index === latestAssistantIndex
			? {
					...message,
					parts: nextParts,
				}
			: message,
	);
}

export async function executeToolCallBatch({
	toolCalls,
	executeTool,
	threadId,
	branchId,
	cache,
	getToolResultCacheKey,
	onToolEvent,
}: {
	toolCalls: ToolCallPart[];
	executeTool: (
		toolName: string,
		args: Record<string, unknown>,
	) => Promise<unknown> | unknown;
	threadId: string;
	branchId: string;
	cache: Map<string, unknown>;
	getToolResultCacheKey?: (
		toolName: string,
		args: Record<string, unknown>,
	) => string | null;
	onToolEvent?: (event: ToolExecutionEvent) => void;
}) {
	const nextCache = new Map(cache);
	const toolMessages: AssistantMessage[] = [];

	for (const toolCall of toolCalls) {
		const cacheKey = getCachedToolCallKey(
			toolCall,
			nextCache,
			getToolResultCacheKey,
		);
		if (cacheKey) {
			onToolEvent?.({
				phase: "cache-hit",
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				args: toolCall.args,
				result: nextCache.get(cacheKey),
				durationMs: 0,
			});
			toolMessages.push(
				createToolResultMessage(
					toolCall.toolCallId,
					toolCall.toolName,
					nextCache.get(cacheKey),
					false,
					threadId,
					branchId,
				),
			);
			continue;
		}

		const startedAt = Date.now();
		onToolEvent?.({
			phase: "start",
			toolCallId: toolCall.toolCallId,
			toolName: toolCall.toolName,
			args: toolCall.args,
		});

		try {
			const result = await executeTool(toolCall.toolName, toolCall.args);
			const nextCacheKey =
				getToolResultCacheKey?.(toolCall.toolName, toolCall.args) ?? null;
			if (nextCacheKey) {
				nextCache.set(nextCacheKey, result);
			}
			onToolEvent?.({
				phase: "success",
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				args: toolCall.args,
				result,
				durationMs: Date.now() - startedAt,
			});
			toolMessages.push(
				createToolResultMessage(
					toolCall.toolCallId,
					toolCall.toolName,
					result,
					false,
					threadId,
					branchId,
				),
			);
		} catch (toolError) {
			toolMessages.push(
				createToolResultMessage(
					toolCall.toolCallId,
					toolCall.toolName,
					{
						error:
							toolError instanceof Error
								? toolError.message
								: "Tool execution failed",
					},
					true,
					threadId,
					branchId,
				),
			);
			onToolEvent?.({
				phase: "error",
				toolCallId: toolCall.toolCallId,
				toolName: toolCall.toolName,
				args: toolCall.args,
				error:
					toolError instanceof Error
						? toolError.message
						: "Tool execution failed",
				durationMs: Date.now() - startedAt,
			});
		}
	}

	return { toolMessages, cache: nextCache };
}
