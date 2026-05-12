import {
	fitMessagesToContextWindow,
	type ContextWindowConfig,
} from "./context-window";
import type { ModelAdapter } from "./provider";
import type { AssistantStorage } from "./storage";
import type {
	AssistantBranch,
	AssistantCheckpoint,
	AssistantMessage,
	AssistantMessagePart,
	AssistantToolCall,
	AssistantToolDefinition,
	AssistantThread,
} from "./types";

type AssistantConfig = {
	provider: ModelAdapter;
	storage: AssistantStorage;
	systemPrompt: string;
	tools: Record<string, AssistantToolDefinition>;
	retries?: {
		maxAttempts?: number;
		delayMs?: (attempt: number) => number;
	};
	contextWindow?: ContextWindowConfig;
};

type SendInput = {
	threadId?: string;
	branchId?: string;
	text: string;
};

type GenerateStepInput = {
	threadId: string;
	branchId: string;
	messages?: AssistantMessage[];
};

type EditMessageInput = {
	threadId: string;
	branchId: string;
	messageId: string;
	text: string;
};

type ForkBranchInput = {
	threadId: string;
	branchId: string;
	messageId?: string;
	name?: string;
};

type TruncateBranchInput = {
	threadId: string;
	branchId: string;
	messageId: string;
};

type OperationResult = {
	thread: AssistantThread;
	branch: AssistantBranch;
	messages: AssistantMessage[];
	checkpoints: AssistantCheckpoint[];
};

function now() {
	return new Date().toISOString();
}

function createId() {
	return crypto.randomUUID();
}

function expectPresent<T>(value: T | null | undefined, message: string): T {
	if (value == null) {
		throw new Error(message);
	}
	return value;
}

function isToolCallPart(
	part: AssistantMessagePart,
): part is Extract<AssistantMessagePart, { type: "tool-call" }> {
	return part.type === "tool-call";
}

function textContent(parts: AssistantMessage["parts"]) {
	return parts
		.filter((part) => part.type === "text" || part.type === "reasoning")
		.map((part) => part.text)
		.join("\n");
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMessage(input: {
	threadId: string;
	branchId: string;
	role: AssistantMessage["role"];
	parts: AssistantMessage["parts"];
	metadata?: Record<string, unknown>;
}): AssistantMessage {
	return {
		id: createId(),
		threadId: input.threadId,
		branchId: input.branchId,
		role: input.role,
		createdAt: now(),
		parts: input.parts,
		metadata: input.metadata ?? {},
	};
}

function cloneMessagesForNewBranch(
	messages: AssistantMessage[],
	threadId: string,
): AssistantMessage[] {
	return messages.map((message) => ({
		...message,
		id: createId(),
		threadId,
	}));
}

async function ensureThreadAndBranch(
	storage: AssistantStorage,
	threadId?: string,
	branchId?: string,
) {
	let thread: AssistantThread | null = null;
	if (threadId) {
		thread = await storage.getThread(threadId);
	}
	if (!thread) {
		thread = await storage.createThread({});
	}

	let resolvedBranchId = branchId ?? thread.activeBranchId;
	if (!resolvedBranchId) {
		const createdBranch = await storage.createBranch({
			threadId: thread.id,
			name: "main",
		});
		resolvedBranchId = createdBranch.id;
		thread = await storage.updateThread(thread.id, {
			activeBranchId: resolvedBranchId,
		});
	}

	const branch = await storage.getBranch(thread.id, resolvedBranchId);
	if (!branch) {
		throw new Error(`Branch not found: ${resolvedBranchId}`);
	}

	return { thread, branch };
}

function buildAssistantMessage(
	threadId: string,
	branchId: string,
	response: Awaited<ReturnType<ModelAdapter["generate"]>>,
) {
	const parts: AssistantMessage["parts"] =
		response.assistantParts && response.assistantParts.length > 0
			? response.assistantParts
			: synthesizeAssistantParts(response);

	return createMessage({
		threadId,
		branchId,
		role: "assistant",
		parts,
		metadata: {
			providerMetadata: response.providerMetadata,
			usage: response.usage,
		},
	});
}

function synthesizeAssistantParts(
	response: Awaited<ReturnType<ModelAdapter["generate"]>>,
): AssistantMessage["parts"] {
	const parts: AssistantMessage["parts"] = [];

	for (const reasoning of response.reasoning) {
		parts.push({ type: "reasoning", text: reasoning });
	}

	if (response.text) {
		parts.push({ type: "text", text: response.text });
	}

	for (const toolCall of response.toolCalls) {
		parts.push({
			type: "tool-call",
			toolCallId: toolCall.toolCallId,
			toolName: toolCall.toolName,
			args: toolCall.args,
		});
	}

	return parts;
}

function toProviderMessages(
	systemPrompt: string,
	messages: AssistantMessage[],
): AssistantMessage[] {
	return [
		createMessage({
			threadId: messages[0]?.threadId ?? "system-thread",
			branchId: messages[0]?.branchId ?? "system-branch",
			role: "system",
			parts: [{ type: "text", text: systemPrompt }],
		}),
		...messages,
	];
}

async function executeToolCall(
	threadId: string,
	branchId: string,
	toolCall: AssistantToolCall,
	tools: Record<string, AssistantToolDefinition>,
) {
	const definition = tools[toolCall.toolName];
	if (!definition?.execute) {
		return createMessage({
			threadId,
			branchId,
			role: "tool",
			parts: [
				{
					type: "tool-result",
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					result: { error: `Tool not implemented: ${toolCall.toolName}` },
					isError: true,
				},
			],
		});
	}

	try {
		const result = await definition.execute(toolCall.args);
		return createMessage({
			threadId,
			branchId,
			role: "tool",
			parts: [
				{
					type: "tool-result",
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					result,
					isError: false,
				},
			],
		});
	} catch (error) {
		return createMessage({
			threadId,
			branchId,
			role: "tool",
			parts: [
				{
					type: "tool-result",
					toolCallId: toolCall.toolCallId,
					toolName: toolCall.toolName,
					result: {
						error:
							error instanceof Error ? error.message : "Tool execution failed",
					},
					isError: true,
				},
			],
		});
	}
}

export function createAssistant(config: AssistantConfig) {
	const maxAttempts = config.retries?.maxAttempts ?? 1;
	const delayMs = config.retries?.delayMs ?? (() => 0);

	async function generateOnce(
		input: GenerateStepInput,
	): Promise<OperationResult> {
		const { thread, branch } = await ensureThreadAndBranch(
			config.storage,
			input.threadId,
			input.branchId,
		);
		const existingMessages =
			input.messages ??
			(await config.storage.getMessages({
				threadId: thread.id,
				branchId: branch.id,
			}));

		let attempt = 0;
		// eslint-disable-next-line no-constant-condition
		while (true) {
			try {
				const response = await config.provider.generate({
					systemPrompt: config.systemPrompt,
					messages: fitMessagesToContextWindow(
						toProviderMessages(config.systemPrompt, existingMessages),
						config.contextWindow,
					),
					tools: config.tools,
				});

				const assistantMessage = buildAssistantMessage(
					thread.id,
					branch.id,
					response,
				);
				await config.storage.appendMessages({
					threadId: thread.id,
					branchId: branch.id,
					messages: [assistantMessage],
				});

				const messages = await config.storage.getMessages({
					threadId: thread.id,
					branchId: branch.id,
				});

				return {
					thread: (await config.storage.getThread(thread.id)) ?? thread,
					branch,
					messages,
					checkpoints: await config.storage.listCheckpoints({
						threadId: thread.id,
						branchId: branch.id,
					}),
				};
			} catch (error) {
				attempt += 1;
				const classification = config.provider.classifyError?.(error) ?? {
					retryable: false,
					message: error instanceof Error ? error.message : "Unknown error",
				};
				if (!classification.retryable || attempt >= maxAttempts) {
					throw error;
				}
				await sleep(delayMs(attempt));
			}
		}
	}

	return {
		async send(input: SendInput): Promise<OperationResult> {
			const { thread, branch } = await ensureThreadAndBranch(
				config.storage,
				input.threadId,
				input.branchId,
			);

			const userMessage = createMessage({
				threadId: thread.id,
				branchId: branch.id,
				role: "user",
				parts: [{ type: "text", text: input.text }],
			});
			await config.storage.appendMessages({
				threadId: thread.id,
				branchId: branch.id,
				messages: [userMessage],
			});

			let result = await generateOnce({
				threadId: thread.id,
				branchId: branch.id,
			});

			// Continue the loop while the latest assistant message contains tool calls.
			// This allows core-level tests to exercise the full tool loop, while client
			// environments can still use `generateStep` for local tool execution.
			// eslint-disable-next-line no-constant-condition
			while (true) {
				const latest = result.messages.at(-1);
				const toolCalls = latest?.parts.filter(isToolCallPart) ?? [];
				if (toolCalls.length === 0) {
					break;
				}

				const toolMessages = [];
				for (const toolCall of toolCalls) {
					const toolMessage = await executeToolCall(
						thread.id,
						branch.id,
						toolCall,
						config.tools,
					);
					toolMessages.push(toolMessage);
				}

				await config.storage.appendMessages({
					threadId: thread.id,
					branchId: branch.id,
					messages: toolMessages,
				});

				for (const toolMessage of toolMessages) {
					const titlePart = toolMessage.parts.find(
						(part) =>
							part.type === "tool-result" &&
							part.toolName === "set_conversation_title" &&
							!part.isError &&
							typeof part.result === "object" &&
							part.result !== null &&
							"title" in (part.result as Record<string, unknown>),
					);
					if (titlePart?.type === "tool-result") {
						const title = (titlePart.result as Record<string, unknown>).title;
						if (typeof title === "string") {
							await config.storage.updateThread(thread.id, { title });
						}
					}
				}

				result = await generateOnce({
					threadId: thread.id,
					branchId: branch.id,
				});
			}

			return result;
		},
		async generateStep(input: GenerateStepInput) {
			return generateOnce(input);
		},
		async regenerate(input: { threadId: string; branchId: string }) {
			const messages = await config.storage.getMessages(input);
			const trimmed = [...messages];
			while (trimmed.length > 0 && trimmed.at(-1)?.role !== "user") {
				trimmed.pop();
			}
			const fallbackMessage = expectPresent(
				messages[0],
				"No messages available for regeneration",
			);
			await config.storage.truncateBranch({
				threadId: input.threadId,
				branchId: input.branchId,
				messageId: trimmed.at(-1)?.id ?? fallbackMessage.id,
			});
			return generateOnce(input);
		},
		async editMessage(input: EditMessageInput) {
			const baseMessages = await config.storage.getMessages({
				threadId: input.threadId,
				branchId: input.branchId,
			});
			const index = baseMessages.findIndex(
				(message) => message.id === input.messageId,
			);
			if (index === -1) {
				throw new Error(`Message not found: ${input.messageId}`);
			}
			const cloned = cloneMessagesForNewBranch(
				baseMessages.slice(0, index + 1),
				input.threadId,
			);
			const target = expectPresent(
				cloned[index],
				`Edited message not found in cloned branch: ${input.messageId}`,
			);
			target.parts = [{ type: "text", text: input.text }];
			target.createdAt = now();
			const branch = await config.storage.createBranch({
				threadId: input.threadId,
				parentBranchId: input.branchId,
				sourceMessageId: input.messageId,
				messages: cloned,
			});
			const thread = expectPresent(
				await config.storage.getThread(input.threadId),
				`Thread not found: ${input.threadId}`,
			);
			const messages = await config.storage.getMessages({
				threadId: input.threadId,
				branchId: branch.id,
			});
			return {
				thread,
				branch,
				messages,
				checkpoints: await config.storage.listCheckpoints({
					threadId: input.threadId,
					branchId: branch.id,
				}),
			};
		},
		async forkBranch(input: ForkBranchInput) {
			const baseMessages = await config.storage.getMessages({
				threadId: input.threadId,
				branchId: input.branchId,
			});
			const index = input.messageId
				? baseMessages.findIndex((message) => message.id === input.messageId)
				: baseMessages.length - 1;
			const messages = cloneMessagesForNewBranch(
				baseMessages.slice(0, index + 1),
				input.threadId,
			);
			const branch = await config.storage.createBranch({
				threadId: input.threadId,
				parentBranchId: input.branchId,
				sourceMessageId: input.messageId ?? null,
				name: input.name,
				messages,
			});
			const thread = expectPresent(
				await config.storage.getThread(input.threadId),
				`Thread not found: ${input.threadId}`,
			);
			const branchMessages = await config.storage.getMessages({
				threadId: input.threadId,
				branchId: branch.id,
			});
			return {
				thread,
				branch,
				messages: branchMessages,
				checkpoints: await config.storage.listCheckpoints({
					threadId: input.threadId,
					branchId: branch.id,
				}),
			};
		},
		async truncateBranch(input: TruncateBranchInput) {
			const messages = await config.storage.getMessages(input);
			const index = messages.findIndex(
				(message) => message.id === input.messageId,
			);
			if (index === -1) {
				throw new Error(`Message not found: ${input.messageId}`);
			}
			const truncatedMessages = messages.slice(index + 1);
			if (truncatedMessages.length > 0) {
				await config.storage.saveCheckpoint({
					id: createId(),
					threadId: input.threadId,
					branchId: input.branchId,
					messageId: input.messageId,
					summary: truncatedMessages
						.map((message) => textContent(message.parts))
						.join("\n"),
					createdAt: now(),
					metadata: {},
				});
			}
			await config.storage.truncateBranch(input);
			const thread = expectPresent(
				await config.storage.getThread(input.threadId),
				`Thread not found: ${input.threadId}`,
			);
			const branch = expectPresent(
				await config.storage.getBranch(input.threadId, input.branchId),
				`Branch not found: ${input.branchId}`,
			);
			return {
				thread,
				branch,
				messages: await config.storage.getMessages(input),
				checkpoints: await config.storage.listCheckpoints(input),
			};
		},
		async listThreads() {
			return config.storage.listThreads();
		},
		async createThread(input?: {
			id?: string;
			title?: string | null;
			metadata?: Record<string, unknown>;
		}) {
			return config.storage.createThread(input ?? {});
		},
		async getThread(threadId: string) {
			return config.storage.getThread(threadId);
		},
		async listBranches(threadId: string) {
			return config.storage.listBranches(threadId);
		},
		async getMessages(input: { threadId: string; branchId: string }) {
			return config.storage.getMessages(input);
		},
		async appendMessages(input: {
			threadId: string;
			branchId: string;
			messages: AssistantMessage[];
		}) {
			await config.storage.appendMessages(input);
			const thread = expectPresent(
				await config.storage.getThread(input.threadId),
				`Thread not found: ${input.threadId}`,
			);
			const branch = expectPresent(
				await config.storage.getBranch(input.threadId, input.branchId),
				`Branch not found: ${input.branchId}`,
			);
			return {
				thread,
				branch,
				messages: await config.storage.getMessages(input),
				checkpoints: await config.storage.listCheckpoints(input),
			};
		},
		async renameThread(threadId: string, title: string) {
			return config.storage.updateThread(threadId, { title });
		},
	};
}
