"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AssistantMessage } from "@ultrapilot/core/types";
import {
	collectSatisfiedToolCallIds,
	executeToolCallBatch,
	filterUncachedToolCalls,
	filterUnsatisfiedToolCalls,
	stripCachedToolCallsFromLatestAssistant,
	type ToolExecutionEvent,
} from "./tool-loop";

type ThreadResponse = {
	thread: {
		id: string;
		title: string | null;
		activeBranchId: string | null;
	};
	branch: {
		id: string;
		name: string;
	} | null;
	messages: AssistantMessage[];
};

type OperationResponse = ThreadResponse & {
	checkpoints?: unknown[];
	error?: string;
};

type UseAssistantThreadOptions = {
	api: string;
	initialThreadId?: string | null;
	initialBranchId?: string | null;
	executeTool?: (
		toolName: string,
		args: Record<string, unknown>,
	) => Promise<unknown> | unknown;
	getToolResultCacheKey?: (
		toolName: string,
		args: Record<string, unknown>,
	) => string | null;
};

type AssistantStatus =
	| "idle"
	| "loading"
	| "sending"
	| "running-tools"
	| "error";

function createMessage(
	role: AssistantMessage["role"],
	text: string,
	threadId?: string | null,
	branchId?: string | null,
): AssistantMessage {
	return {
		id: crypto.randomUUID(),
		threadId: threadId ?? "pending-thread",
		branchId: branchId ?? "pending-branch",
		role,
		createdAt: new Date().toISOString(),
		parts: [{ type: "text", text }],
		metadata: {},
	};
}

function createEditedMessage(
	message: AssistantMessage,
	text: string,
	threadId: string,
	branchId: string,
): AssistantMessage {
	return {
		...message,
		threadId,
		branchId,
		createdAt: new Date().toISOString(),
		parts: [{ type: "text", text }],
	};
}

function getLatestAssistantToolCalls(messages: AssistantMessage[]) {
	const latestAssistant = [...messages]
		.reverse()
		.find((message) => message.role === "assistant");
	if (!latestAssistant) {
		return [];
	}
	return latestAssistant.parts.filter(
		(
			part,
		): part is Extract<
			AssistantMessage["parts"][number],
			{ type: "tool-call" }
		> => part.type === "tool-call",
	);
}

function summarizeToolValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return {
			type: "array",
			length: value.length,
		};
	}

	if (value && typeof value === "object") {
		return {
			type: "object",
			keys: Object.keys(value as Record<string, unknown>).slice(0, 12),
		};
	}

	return value;
}

function logToolEvent(event: ToolExecutionEvent) {
	const payload = {
		toolCallId: event.toolCallId,
		args: summarizeToolValue(event.args),
		...("durationMs" in event ? { durationMs: event.durationMs } : {}),
		...("result" in event ? { result: summarizeToolValue(event.result) } : {}),
		...("error" in event ? { error: event.error } : {}),
	};

	if (event.phase === "error") {
		console.error(`[ultrapilot] ${event.phase} ${event.toolName}`, payload);
		return;
	}

	console.info(`[ultrapilot] ${event.phase} ${event.toolName}`, payload);
}

export function useAssistantThread(options: UseAssistantThreadOptions) {
	const [threadId, setThreadId] = useState<string | null>(
		options.initialThreadId ?? null,
	);
	const [branchId, setBranchId] = useState<string | null>(
		options.initialBranchId ?? null,
	);
	const [messages, setMessages] = useState<AssistantMessage[]>([]);
	const [status, setStatus] = useState<AssistantStatus>("idle");
	const [error, setError] = useState<string | null>(null);
	const [title, setTitle] = useState<string>("New conversation");

	const loadThread = useCallback(
		async (nextThreadId: string, nextBranchId?: string | null) => {
			setStatus("loading");
			setError(null);
			const params = new URLSearchParams({ threadId: nextThreadId });
			if (nextBranchId) {
				params.set("branchId", nextBranchId);
			}
			const response = await fetch(`${options.api}?${params.toString()}`);
			const data = (await response.json()) as ThreadResponse & {
				error?: string;
			};
			if (!response.ok) {
				setError(data.error ?? "Failed to load thread");
				setStatus("error");
				return;
			}
			setThreadId(data.thread.id);
			setBranchId(data.branch?.id ?? data.thread.activeBranchId ?? null);
			setTitle(data.thread.title ?? "New conversation");
			setMessages(data.messages);
			setStatus("idle");
		},
		[options.api],
	);

	useEffect(() => {
		if (options.initialThreadId) {
			void loadThread(options.initialThreadId, options.initialBranchId);
		}
	}, [loadThread, options.initialBranchId, options.initialThreadId]);

	const post = useCallback(
		async (body: Record<string, unknown>) => {
			const response = await fetch(options.api, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			const data = (await response.json()) as OperationResponse;
			if (!response.ok) {
				throw new Error(data.error ?? "Ultrapilot request failed");
			}
			return data;
		},
		[options.api],
	);

	const syncResponse = useCallback((data: OperationResponse) => {
		setThreadId(data.thread.id);
		setBranchId(data.branch?.id ?? data.thread.activeBranchId ?? null);
		setTitle(data.thread.title ?? "New conversation");
		setMessages(data.messages);
	}, []);

	const runToolLoop = useCallback(
		async (initial: OperationResponse) => {
			let current = initial;
			let toolResultCache = new Map<string, unknown>();
			syncResponse(current);
			if (!options.executeTool) {
				return current;
			}

			// eslint-disable-next-line no-constant-condition
			while (true) {
				const toolCalls = getLatestAssistantToolCalls(current.messages);
				if (toolCalls.length === 0) {
					return current;
				}
				const satisfiedToolCallIds = collectSatisfiedToolCallIds(
					current.messages,
				);
				const unsatisfiedToolCalls = filterUnsatisfiedToolCalls(
					toolCalls,
					satisfiedToolCallIds,
				);
				const uncachedToolCalls = filterUncachedToolCalls(
					unsatisfiedToolCalls,
					toolResultCache,
					options.getToolResultCacheKey,
				);
				if (
					unsatisfiedToolCalls.length === 0 ||
					uncachedToolCalls.length === 0
				) {
					const normalizedMessages = stripCachedToolCallsFromLatestAssistant(
						current.messages,
						toolResultCache,
						options.getToolResultCacheKey,
						satisfiedToolCallIds,
					);
					if (normalizedMessages !== current.messages) {
						setMessages(normalizedMessages);
						return {
							...current,
							messages: normalizedMessages,
						};
					}
					return current;
				}

				setStatus("running-tools");
				const activeThreadId = current.thread.id;
				const activeBranchId =
					current.branch?.id ?? current.thread.activeBranchId ?? branchId;
				if (!activeBranchId) {
					throw new Error("Missing active branch during tool execution");
				}

				const batch = await executeToolCallBatch({
					toolCalls: unsatisfiedToolCalls,
					executeTool: options.executeTool,
					threadId: activeThreadId,
					branchId: activeBranchId,
					cache: toolResultCache,
					getToolResultCacheKey: options.getToolResultCacheKey,
					onToolEvent: logToolEvent,
				});
				toolResultCache = batch.cache;
				const toolMessages = batch.toolMessages;

				setMessages((previous) => [...previous, ...toolMessages]);
				current = await post({
					action: "append-and-generate",
					threadId: activeThreadId,
					branchId: activeBranchId,
					newMessages: toolMessages,
				});
				syncResponse(current);
			}
		},
		[
			branchId,
			options.executeTool,
			options.getToolResultCacheKey,
			post,
			syncResponse,
		],
	);

	const sendMessage = useCallback(
		async ({ text }: { text: string }) => {
			if (!text.trim()) {
				return null;
			}
			setStatus("sending");
			setError(null);
			const userMessage = createMessage("user", text, threadId, branchId);
			setMessages((previous) => [...previous, userMessage]);
			try {
				const response = await post({
					action: "append-and-generate",
					threadId: threadId ?? undefined,
					branchId: branchId ?? undefined,
					newMessages: [userMessage],
				});
				const finalResponse = await runToolLoop(response);
				setStatus("idle");
				return finalResponse;
			} catch (sendError) {
				setStatus("error");
				setError(
					sendError instanceof Error
						? sendError.message
						: "Failed to send message",
				);
				throw sendError;
			}
		},
		[branchId, post, runToolLoop, threadId],
	);

	const regenerate = useCallback(
		async (overrides?: {
			threadId?: string | null;
			branchId?: string | null;
		}) => {
			const activeThreadId = overrides?.threadId ?? threadId;
			const activeBranchId = overrides?.branchId ?? branchId;
			if (!activeThreadId || !activeBranchId) {
				return null;
			}
			setStatus("sending");
			setError(null);
			try {
				const response = await post({
					action: "regenerate",
					threadId: activeThreadId,
					branchId: activeBranchId,
				});
				const finalResponse = await runToolLoop(response);
				setStatus("idle");
				return finalResponse;
			} catch (regenerateError) {
				setStatus("error");
				setError(
					regenerateError instanceof Error
						? regenerateError.message
						: "Failed to regenerate response",
				);
				throw regenerateError;
			}
		},
		[branchId, post, runToolLoop, threadId],
	);

	const editMessage = useCallback(
		async (messageId: string, text: string) => {
			if (!threadId || !branchId) {
				return null;
			}
			const response = await post({
				action: "edit-message",
				threadId,
				branchId,
				messageId,
				text,
			});
			syncResponse(response);
			return response;
		},
		[branchId, post, syncResponse, threadId],
	);

	const forkBranch = useCallback(
		async (messageId?: string, name?: string) => {
			if (!threadId || !branchId) {
				return null;
			}
			const response = await post({
				action: "fork-branch",
				threadId,
				branchId,
				messageId,
				name,
			});
			syncResponse(response);
			return response;
		},
		[branchId, post, syncResponse, threadId],
	);

	const truncateBranch = useCallback(
		async (messageId: string) => {
			if (!threadId || !branchId) {
				return null;
			}
			const response = await post({
				action: "truncate-branch",
				threadId,
				branchId,
				messageId,
			});
			syncResponse(response);
			return response;
		},
		[branchId, post, syncResponse, threadId],
	);

	const replaceMessageAndGenerate = useCallback(
		async (messageId: string, text: string) => {
			if (!threadId || !branchId) {
				return null;
			}
			const target = messages.find(
				(message) => message.id === messageId && message.role === "user",
			);
			if (!target) {
				throw new Error(`Message not found: ${messageId}`);
			}

			setStatus("sending");
			setError(null);
			try {
				const replacement = createEditedMessage(
					target,
					text,
					threadId,
					branchId,
				);
				const response = await post({
					action: "append-and-generate",
					threadId,
					branchId,
					newMessages: [replacement],
				});
				const finalResponse = await runToolLoop(response);
				setStatus("idle");
				return finalResponse;
			} catch (replaceError) {
				setStatus("error");
				setError(
					replaceError instanceof Error
						? replaceError.message
						: "Failed to rerun from edited message",
				);
				throw replaceError;
			}
		},
		[branchId, messages, post, runToolLoop, threadId],
	);

	const rerunFromMessage = useCallback(
		async (messageId: string) => {
			if (!threadId || !branchId) {
				return null;
			}

			setStatus("sending");
			setError(null);
			try {
				const truncated = await post({
					action: "truncate-branch",
					threadId,
					branchId,
					messageId,
				});
				syncResponse(truncated);
				const response = await post({
					action: "regenerate",
					threadId,
					branchId,
				});
				const finalResponse = await runToolLoop(response);
				setStatus("idle");
				return finalResponse;
			} catch (rerunError) {
				setStatus("error");
				setError(
					rerunError instanceof Error
						? rerunError.message
						: "Failed to rerun from message",
				);
				throw rerunError;
			}
		},
		[branchId, post, runToolLoop, syncResponse, threadId],
	);

	const resetThread = useCallback(() => {
		setThreadId(null);
		setBranchId(null);
		setMessages([]);
		setTitle("New conversation");
		setError(null);
		setStatus("idle");
	}, []);

	return useMemo(
		() => ({
			threadId,
			branchId,
			title,
			messages,
			status,
			error,
			setError,
			sendMessage,
			regenerate,
			editMessage,
			forkBranch,
			truncateBranch,
			replaceMessageAndGenerate,
			rerunFromMessage,
			loadThread,
			resetThread,
		}),
		[
			branchId,
			editMessage,
			error,
			forkBranch,
			loadThread,
			messages,
			regenerate,
			replaceMessageAndGenerate,
			rerunFromMessage,
			resetThread,
			sendMessage,
			status,
			threadId,
			title,
			truncateBranch,
		],
	);
}
