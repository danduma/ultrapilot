import { describe, expect, it } from "bun:test";
import { createAssistant } from "../assistant";
import type { ModelAdapter } from "../provider";
import { createInMemoryStorage } from "../storage";
import type { AssistantMessage } from "../types";

function message({
	id,
	role,
	text,
	threadId = "thread-1",
	branchId = "branch-1",
}: {
	id: string;
	role: AssistantMessage["role"];
	text: string;
	threadId?: string;
	branchId?: string;
}): AssistantMessage {
	return {
		id,
		threadId,
		branchId,
		role,
		createdAt: new Date().toISOString(),
		parts: [{ type: "text", text }],
		metadata: {},
	};
}

describe("run engine", () => {
	it("retries retryable provider errors and succeeds within policy", async () => {
		let attempts = 0;
		const provider: ModelAdapter = {
			id: "retrying-provider",
			capabilities: { reasoning: false, toolCalls: true },
			classifyError(error) {
				return {
					retryable:
						error instanceof Error && error.message.includes("temporary"),
					message: error instanceof Error ? error.message : "unknown",
				};
			},
			async generate() {
				attempts += 1;
				if (attempts < 3) {
					throw new Error("temporary upstream failure");
				}

				return {
					id: `response-${attempts}`,
					text: "Recovered response",
					reasoning: [],
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					providerMetadata: {},
				};
			},
		};

		const assistant = createAssistant({
			provider,
			storage: createInMemoryStorage(),
			systemPrompt: "Be concise.",
			tools: {},
			retries: {
				maxAttempts: 3,
				delayMs: () => 0,
			},
		});

		const result = await assistant.send({ text: "Hi" });
		const assistantMessage = result.messages.find(
			(message) => message.role === "assistant",
		);

		expect(attempts).toBe(3);
		expect(assistantMessage?.parts[0]).toEqual({
			type: "text",
			text: "Recovered response",
		});
	});

	it("records tool call and tool result messages in order", async () => {
		let firstStep = true;
		const provider: ModelAdapter = {
			id: "tool-provider",
			capabilities: { reasoning: false, toolCalls: true },
			async generate() {
				if (firstStep) {
					firstStep = false;
					return {
						id: "response-1",
						text: "",
						reasoning: [],
						toolCalls: [
							{
								toolCallId: "call-1",
								toolName: "add",
								args: { a: 2, b: 3 },
							},
						],
						usage: { inputTokens: 1, outputTokens: 1 },
						providerMetadata: {},
					};
				}

				return {
					id: "response-2",
					text: "The sum is 5",
					reasoning: [],
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					providerMetadata: {},
				};
			},
		};

		const assistant = createAssistant({
			provider,
			storage: createInMemoryStorage(),
			systemPrompt: "Use tools when needed.",
			tools: {
				add: {
					description: "Adds two numbers.",
					inputSchema: {
						type: "object",
						properties: {
							a: { type: "number" },
							b: { type: "number" },
						},
						required: ["a", "b"],
					},
					async execute(args) {
						return { total: args.a + args.b };
					},
				},
			},
		});

		const result = await assistant.send({ text: "What is 2 + 3?" });
		const roles = result.messages.map((message) => message.role);

		expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
		expect(result.messages[2]?.parts[0]).toEqual({
			type: "tool-result",
			toolCallId: "call-1",
			toolName: "add",
			result: { total: 5 },
			isError: false,
		});
		expect(result.messages[3]?.parts[0]).toEqual({
			type: "text",
			text: "The sum is 5",
		});
	});

	it("summarizes older messages before provider calls when the input would exceed the context budget", async () => {
		let providerMessages: AssistantMessage[] = [];
		const provider: ModelAdapter = {
			id: "context-aware-provider",
			capabilities: { reasoning: false, toolCalls: true },
			async generate(input) {
				providerMessages = input.messages;
				return {
					id: "response-1",
					text: "I can continue from the compacted context.",
					reasoning: [],
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					providerMetadata: {},
				};
			},
		};
		const storage = createInMemoryStorage();
		const thread = await storage.createThread({});
		expect(thread.activeBranchId).not.toBeNull();
		const branchId = thread.activeBranchId as string;
		const assistant = createAssistant({
			provider,
			storage,
			systemPrompt: "Be concise.",
			tools: {},
			contextWindow: {
				maxInputTokens: 140,
				reservedOutputTokens: 20,
				summaryMaxTokens: 40,
				recentMessageCount: 2,
			},
		});
		const longContext = "old context ".repeat(140);
		const latestUserMessage = message({
			id: "latest-user",
			role: "user",
			text: "Please finish the panda extinction story.",
			threadId: thread.id,
			branchId,
		});

		await assistant.generateStep({
			threadId: thread.id,
			branchId,
			messages: [
				message({
					id: "old-user",
					role: "user",
					text: longContext,
					threadId: thread.id,
					branchId,
				}),
				message({
					id: "old-assistant",
					role: "assistant",
					text: longContext,
					threadId: thread.id,
					branchId,
				}),
				message({
					id: "recent-assistant",
					role: "assistant",
					text: "Ready.",
					threadId: thread.id,
					branchId,
				}),
				latestUserMessage,
			],
		});

		expect(providerMessages.map((entry) => entry.role)).toEqual([
			"system",
			"assistant",
			"user",
		]);
		expect(providerMessages[1]?.metadata).toMatchObject({
			contextWindowSummary: true,
			omittedMessageCount: 3,
		});
		expect(providerMessages[1]?.parts[0]).toMatchObject({
			type: "text",
		});
		expect(providerMessages[1]?.parts[0]).not.toMatchObject({
			text: longContext,
		});
		expect(providerMessages.at(-1)).toMatchObject({
			id: latestUserMessage.id,
			role: "user",
			parts: latestUserMessage.parts,
		});
	});
});
