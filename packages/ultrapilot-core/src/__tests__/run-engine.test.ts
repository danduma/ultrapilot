import { describe, expect, it } from "bun:test";
import { createUltraPilot } from "../assistant";
import type { ModelAdapter } from "../provider";
import { createInMemoryStorage } from "../storage";
import type { AssistantMessage, ImageToolResult } from "../types";

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

		const ultrapilot = createUltraPilot({
			provider,
			storage: createInMemoryStorage(),
			systemPrompt: "Be concise.",
			tools: {},
			retries: {
				maxAttempts: 3,
				delayMs: () => 0,
			},
		});

		const result = await ultrapilot.send({ text: "Hi" });
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

		const ultrapilot = createUltraPilot({
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

		const result = await ultrapilot.send({ text: "What is 2 + 3?" });
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

	it("persists an image tool result as an acknowledgement followed by a user image message", async () => {
		let step = 0;
		let replayedMessages: AssistantMessage[] = [];
		const provider: ModelAdapter = {
			id: "multimodal-tool-provider",
			capabilities: { reasoning: false, toolCalls: true },
			async generate(input) {
				step += 1;
				if (step === 1) {
					return {
						id: "response-1",
						text: "",
						reasoning: [],
						toolCalls: [
							{
								toolCallId: "call-frame-1",
								toolName: "render_frame",
								args: { timeSeconds: 2.5 },
							},
						],
						usage: { inputTokens: 1, outputTokens: 1 },
						providerMetadata: {},
					};
				}

				replayedMessages = input.messages;
				return {
					id: "response-2",
					text: "I can see the rendered frame.",
					reasoning: [],
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					providerMetadata: {},
				};
			},
		};

		const ultrapilot = createUltraPilot({
			provider,
			storage: createInMemoryStorage(),
			systemPrompt: "Inspect rendered frames.",
			tools: {
				render_frame: {
					description: "Renders one timeline frame.",
					inputSchema: { type: "object" },
					execute() {
						return {
							type: "image-tool-result",
							result: { rendered: true, timeSeconds: 2.5 },
							imageParts: [
								{
									image: "data:image/png;base64,REAL_FRAME_BYTES",
									mediaType: "image/png",
								},
							],
						} satisfies ImageToolResult;
					},
				},
			},
		});

		const result = await ultrapilot.send({ text: "Show me frame 2.5." });

		expect(result.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"tool",
			"user",
			"assistant",
		]);
		expect(result.messages[2]?.parts).toEqual([
			{
				type: "tool-result",
				toolCallId: "call-frame-1",
				toolName: "render_frame",
				result: { rendered: true, timeSeconds: 2.5 },
				isError: false,
			},
		]);
		expect(result.messages[3]?.parts).toEqual([
			{
				type: "image",
				image: "data:image/png;base64,REAL_FRAME_BYTES",
				mediaType: "image/png",
			},
		]);
		expect(
			replayedMessages.slice(-2).map((message) => ({
				role: message.role,
				parts: message.parts,
			})),
		).toEqual([
			{
				role: "tool",
				parts: result.messages[2]?.parts,
			},
			{
				role: "user",
				parts: result.messages[3]?.parts,
			},
		]);
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
		const ultrapilot = createUltraPilot({
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

		await ultrapilot.generateStep({
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
