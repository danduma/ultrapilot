import { describe, expect, it, mock } from "bun:test";
import type { AssistantMessage } from "@ultrapilot/core/types";
import {
	buildMastraModelConfig,
	createMastraProvider,
	selectAgentMessageInput,
	type UltraPilotProviderProfile,
} from "../index";

function profile(
	overrides: Partial<UltraPilotProviderProfile> = {},
): UltraPilotProviderProfile {
	return {
		provider: "openai",
		model: "gpt-4o-mini",
		apiKey: "placeholder-key",
		...overrides,
	};
}

describe("buildMastraModelConfig provider mapping", () => {
	it("maps gemini -> google/<model> through the provider registry", () => {
		const cfg = buildMastraModelConfig(profile({ provider: "gemini" }));
		expect(cfg.id).toBe("google/gpt-4o-mini");
		expect(cfg.url).toBeUndefined();
	});

	it("maps openai -> openai/<model> with no base", () => {
		const cfg = buildMastraModelConfig(profile({ provider: "openai" }));
		expect(cfg.id).toBe("openai/gpt-4o-mini");
		expect(cfg.url).toBeUndefined();
	});

	it("maps openai_compatible -> openai-compatible/<model> with explicit baseUrl", () => {
		const cfg = buildMastraModelConfig(
			profile({
				provider: "openai_compatible",
				baseUrl: "http://localhost:1234/v1",
			}),
		);
		expect(cfg.id).toBe("openai-compatible/gpt-4o-mini");
		expect(cfg.url).toBe("http://localhost:1234/v1");
	});

	it("maps anthropic -> anthropic/<model> with no base", () => {
		const cfg = buildMastraModelConfig(profile({ provider: "anthropic" }));
		expect(cfg.id).toBe("anthropic/gpt-4o-mini");
		expect(cfg.url).toBeUndefined();
	});

	it("maps openrouter -> openai-compatible/<model> with default openrouter base", () => {
		const cfg = buildMastraModelConfig(profile({ provider: "openrouter" }));
		expect(cfg.id).toBe("openai-compatible/gpt-4o-mini");
		expect(cfg.url).toBe("https://openrouter.ai/api/v1");
	});

	it("maps Codex login to the subscription Responses endpoint and account", () => {
		const cfg = buildMastraModelConfig(
			profile({
				provider: "codex_openai",
				accountId: "account-123",
			}),
		);
		expect(cfg.id).toBe("openai/gpt-4o-mini");
		expect(cfg.url).toBe("https://chatgpt.com/backend-api/codex");
		expect(cfg.headers).toEqual({ "ChatGPT-Account-ID": "account-123" });
		expect(cfg.api).toBe("responses");
	});

	it("lets an explicit baseUrl override the provider default", () => {
		const cfg = buildMastraModelConfig(
			profile({
				provider: "openrouter",
				baseUrl: "https://custom.openrouter.example/v1",
			}),
		);
		expect(cfg.url).toBe("https://custom.openrouter.example/v1");
	});

	it("keeps Codex multimodal messages in model-message form", () => {
		const messages = [
			{
				role: "user" as const,
				content: [
					{ type: "text" as const, text: "Describe this image" },
					{
						type: "image" as const,
						image: "data:image/jpeg;base64,REAL_FRAME_BYTES",
						mediaType: "image/jpeg",
					},
				],
			},
		];

		const selected = selectAgentMessageInput(
			messages,
			profile({ provider: "codex_openai" }),
		);

		expect(selected).toBe(messages);
		expect(selected[0]).toEqual(messages[0]);
	});
});

const GEMINI_THINKING_OPTIONS = {
	providerOptions: {
		google: { thinkingConfig: { thinkingLevel: "low" } },
	},
};

function buildUserMessage(text = "hello"): AssistantMessage {
	return {
		id: "user-1",
		threadId: "thread-1",
		branchId: "branch-1",
		role: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		parts: [{ type: "text", text }],
		metadata: {},
	};
}

type CapturedMastraMessage = {
	role: string;
	content?: unknown;
};

function firstCalledMessages(
	calls: readonly unknown[],
): CapturedMastraMessage[] {
	const call = calls[0];
	expect(call).toBeDefined();
	if (!Array.isArray(call)) {
		throw new Error("Expected mock to be called");
	}
	const messages = call[0];
	expect(Array.isArray(messages)).toBe(true);
	return messages as CapturedMastraMessage[];
}

describe("createMastraProvider (injected generate override)", () => {
	it("exposes the @ultrapilot/core ModelAdapter shape", () => {
		const provider = createMastraProvider({
			generate: async () => ({ text: "", reasoning: [], toolCalls: [] }),
		});
		expect(provider.id).toBe("mastra:copilot-agent");
		expect(provider.capabilities).toEqual({ reasoning: true, toolCalls: true });
		expect(typeof provider.classifyError).toBe("function");
		expect(provider.classifyError?.(new Error("timeout")).retryable).toBe(true);
	});

	it("normalizes tool calls from raw response messages and preserves replay metadata", async () => {
		const rawAssistantMessage = {
			id: "assistant-msg-1",
			role: "assistant" as const,
			content: [
				{
					type: "tool-call" as const,
					toolCallId: "call-1",
					toolName: "set_conversation_title",
					input: { title: "Panda Timeline" },
					providerOptions: { google: { thoughtSignature: "sig-1" } },
				},
			],
		};
		const generate = mock(async () => ({
			text: "",
			reasoning: [],
			toolCalls: [{ toolCallId: "call-1" }],
			usage: { inputTokens: 10, outputTokens: 4 },
			providerMetadata: { finishReason: "tool-calls" },
			response: { messages: [rawAssistantMessage] },
		}));
		const provider = createMastraProvider({ generate });

		const result = await provider.generate({
			systemPrompt: "Be helpful",
			messages: [buildUserMessage("Title this conversation")],
			tools: {},
		});

		expect(result.toolCalls).toEqual([
			{
				toolCallId: "call-1",
				toolName: "set_conversation_title",
				args: { title: "Panda Timeline" },
			},
		]);
		expect(result.providerMetadata).toEqual({
			finishReason: "tool-calls",
			rawResponseMessages: [rawAssistantMessage],
		});
		expect(result.usage).toEqual({
			inputTokens: 10,
			outputTokens: 4,
			reasoningTokens: undefined,
		});
	});

	it("requests low Gemini 3 thinking and drops stored system messages", async () => {
		const generate = mock(async () => ({
			text: "done",
			reasoning: [],
			toolCalls: [],
			providerMetadata: {},
		}));
		const provider = createMastraProvider({ generate });

		await provider.generate({
			systemPrompt: "ignored",
			messages: [
				{
					id: "system-1",
					threadId: "thread-1",
					branchId: "branch-1",
					role: "system",
					createdAt: "2026-01-01T00:00:00.000Z",
					parts: [{ type: "text", text: "duplicate system" }],
					metadata: {},
				},
				buildUserMessage("hello"),
			],
			tools: {},
		});

		expect(generate).toHaveBeenCalledWith(
			[{ role: "user", content: "hello" }],
			GEMINI_THINKING_OPTIONS,
		);
	});

	it("disables response storage for Codex subscription requests", async () => {
		const generate = mock(async () => ({
			text: "OK",
			reasoning: [],
			toolCalls: [],
			providerMetadata: {},
		}));
		const provider = createMastraProvider({
			generate,
			profile: profile({ provider: "codex_openai" }),
		});

		await provider.generate({
			systemPrompt: "Be helpful",
			messages: [buildUserMessage("hello")],
			tools: {},
		});

		expect(generate.mock.calls[0]?.[1]).toMatchObject({
			providerOptions: { openai: { store: false } },
		});
	});

	it("replays stored raw assistant messages so provider tool metadata survives", async () => {
		const generate = mock(async () => ({
			text: "done",
			reasoning: [],
			toolCalls: [],
			providerMetadata: {},
		}));
		const provider = createMastraProvider({ generate });
		const assistantMessage: AssistantMessage = {
			id: "assistant-local-1",
			threadId: "thread-1",
			branchId: "branch-1",
			role: "assistant",
			createdAt: "2026-01-01T00:00:00.000Z",
			parts: [
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "set_conversation_title",
					args: { title: "Panda Timeline" },
				},
			],
			metadata: {
				providerMetadata: {
					rawResponseMessages: [
						{
							id: "assistant-msg-1",
							role: "assistant",
							content: [
								{
									type: "tool-call",
									toolCallId: "call-1",
									toolName: "set_conversation_title",
									input: { title: "Panda Timeline" },
									providerOptions: {
										google: { thoughtSignature: "sig-1" },
									},
								},
							],
						},
					],
				},
			},
		};

		await provider.generate({
			systemPrompt: "Be helpful",
			messages: [assistantMessage],
			tools: {},
		});

		expect(generate).toHaveBeenCalledWith(
			[
				{
					id: "assistant-msg-1",
					role: "assistant",
					content: [
						{
							type: "tool-call",
							toolCallId: "call-1",
							toolName: "set_conversation_title",
							input: { title: "Panda Timeline" },
							providerOptions: { google: { thoughtSignature: "sig-1" } },
						},
					],
				},
			],
			GEMINI_THINKING_OPTIONS,
		);
	});

	it("does not replay local planner tool calls without provider thought signatures", async () => {
		const generate = mock(async () => ({
			text: "done",
			reasoning: [],
			toolCalls: [],
			providerMetadata: {},
		}));
		const provider = createMastraProvider({ generate });
		const localPlannerAssistant: AssistantMessage = {
			id: "assistant-local-planner",
			threadId: "thread-1",
			branchId: "branch-1",
			role: "assistant",
			createdAt: "2026-01-01T00:00:00.000Z",
			parts: [
				{
					type: "tool-call",
					toolCallId: "local-title-call",
					toolName: "set_conversation_title",
					args: { title: "Panda Segments" },
				},
			],
			metadata: {
				providerMetadata: {
					localTimelineSegmentPlanner: true,
					stage: "discover",
				},
			},
		};
		const localPlannerToolResult: AssistantMessage = {
			id: "tool-local-title",
			threadId: "thread-1",
			branchId: "branch-1",
			role: "tool",
			createdAt: "2026-01-01T00:00:00.000Z",
			parts: [
				{
					type: "tool-result",
					toolCallId: "local-title-call",
					toolName: "set_conversation_title",
					result: { title: "Panda Segments" },
					isError: false,
				},
			],
			metadata: {},
		};

		await provider.generate({
			systemPrompt: "Be helpful",
			messages: [
				buildUserMessage("Using these assets, tell me a dramatic story."),
				localPlannerAssistant,
				localPlannerToolResult,
				{ ...buildUserMessage("what happened?"), id: "user-2" },
			],
			tools: {},
		});

		expect(generate).toHaveBeenCalledWith(
			[
				{
					role: "user",
					content: "Using these assets, tell me a dramatic story.",
				},
				{ role: "user", content: "what happened?" },
			],
			GEMINI_THINKING_OPTIONS,
		);
	});

	it("rejects empty conversations before calling the upstream model", async () => {
		const generate = mock(async () => ({
			text: "should not be used",
			reasoning: [],
			toolCalls: [],
			providerMetadata: {},
		}));
		const provider = createMastraProvider({ generate });

		await expect(
			provider.generate({ systemPrompt: "Be helpful", messages: [], tools: {} }),
		).rejects.toThrow(
			"Cannot generate without at least one conversation message.",
		);
		expect(generate).not.toHaveBeenCalled();
	});

	it("sanitizes heavyweight tool preview payloads before sending wire input", async () => {
		const generate = mock(async () => ({
			text: "done",
			reasoning: [],
			toolCalls: [],
			providerMetadata: {},
		}));
		const provider = createMastraProvider({ generate });

		await provider.generate({
			systemPrompt: "Be helpful",
			messages: [
				buildUserMessage("inspect media"),
				{
					id: "tool-1",
					threadId: "thread-1",
					branchId: "branch-1",
					role: "tool",
					createdAt: "2026-01-01T00:00:00.000Z",
					parts: [
						{
							type: "tool-result",
							toolCallId: "call-1",
							toolName: "get_media_assets",
							result: {
								assets: [
									{
										id: "asset-1",
										type: "video",
										mediaUrl: "data:video/mp4;base64,large-video",
										thumbnailUrl: "data:image/png;base64,large-thumb",
										browserUrl: "blob:http://localhost/video",
									},
								],
							},
							isError: false,
						},
					],
					metadata: {},
				},
			],
			tools: {},
		});

		const serialized = JSON.stringify(firstCalledMessages(generate.mock.calls));
		expect(serialized).not.toContain("large-video");
		expect(serialized).not.toContain("large-thumb");
		expect(serialized).toContain("[video preview omitted]");
		expect(serialized).toContain("[image preview omitted]");
		expect(serialized).toContain("[blob URL omitted]");
	});

	describe("active tool selection", () => {
		const titleToolResult: AssistantMessage = {
			id: "tool-1",
			threadId: "thread-1",
			branchId: "branch-1",
			role: "tool",
			createdAt: "2026-01-01T00:00:00.000Z",
			parts: [
				{
					type: "tool-result",
					toolCallId: "call-1",
					toolName: "set_conversation_title",
					result: { title: "T" },
					isError: false,
				},
			],
			metadata: {},
		};

		it("narrows to no tools for a greeting-only follow-up", async () => {
			const generate = mock(async () => ({
				text: "done",
				reasoning: [],
				toolCalls: [],
				providerMetadata: {},
			}));
			const provider = createMastraProvider({ generate });

			await provider.generate({
				systemPrompt: "ignored",
				messages: [
					buildUserMessage("Say hello and title this conversation."),
					titleToolResult,
				],
				tools: {
					get_timeline_state: { description: "", inputSchema: { type: "object" } },
					set_conversation_title: {
						description: "",
						inputSchema: { type: "object" },
					},
				},
			});

			expect(generate).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({ activeTools: [] }),
			);
		});

		it("keeps transition tools active for follow-up transition requests", async () => {
			const generate = mock(async () => ({
				text: "done",
				reasoning: [],
				toolCalls: [],
				providerMetadata: {},
			}));
			const provider = createMastraProvider({ generate });

			await provider.generate({
				systemPrompt: "ignored",
				messages: [
					buildUserMessage("Add a wipe transition between the first two clips."),
					titleToolResult,
				],
				tools: {
					get_timeline_state: { description: "", inputSchema: { type: "object" } },
					list_transition_types: {
						description: "",
						inputSchema: { type: "object" },
					},
					add_transition: { description: "", inputSchema: { type: "object" } },
					update_transition: { description: "", inputSchema: { type: "object" } },
					remove_transition: { description: "", inputSchema: { type: "object" } },
				},
			});

			expect(generate).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					activeTools: [
						"get_timeline_state",
						"list_transition_types",
						"add_transition",
						"update_transition",
						"remove_transition",
					],
				}),
			);
		});

		it("keeps music sync + anchor tools active for follow-up anchor requests", async () => {
			const generate = mock(async () => ({
				text: "done",
				reasoning: [],
				toolCalls: [],
				providerMetadata: {},
			}));
			const provider = createMastraProvider({ generate });

			await provider.generate({
				systemPrompt: "ignored",
				messages: [
					buildUserMessage("What music anchors are available right now?"),
					titleToolResult,
				],
				tools: {
					get_timeline_state: { description: "", inputSchema: { type: "object" } },
					get_timeline_anchors: {
						description: "",
						inputSchema: { type: "object" },
					},
					resolve_timeline_anchor: {
						description: "",
						inputSchema: { type: "object" },
					},
					plan_anchor_placement: {
						description: "",
						inputSchema: { type: "object" },
					},
					apply_anchor_placement: {
						description: "",
						inputSchema: { type: "object" },
					},
				},
			});

			expect(generate).toHaveBeenCalledWith(
				expect.any(Array),
				expect.objectContaining({
					activeTools: expect.arrayContaining([
						"get_timeline_state",
						"get_timeline_anchors",
						"resolve_timeline_anchor",
						"plan_anchor_placement",
						"apply_anchor_placement",
					]),
				}),
			);
		});
	});

	describe("gemini thoughtSignature invariant", () => {
		it("emits assistantParts with per-part providerOptions from raw response", async () => {
			const generate = mock(async () => ({
				text: "",
				reasoning: [],
				toolCalls: [],
				providerMetadata: {},
				response: {
					messages: [
						{
							id: "assistant-msg-1",
							role: "assistant" as const,
							content: [
								{
									type: "tool-call" as const,
									toolCallId: "call-1",
									toolName: "get_timeline_state",
									input: {},
									providerOptions: { google: { thoughtSignature: "sig-A" } },
								},
								{
									type: "tool-call" as const,
									toolCallId: "call-2",
									toolName: "find_scenes",
									input: { query: "panda" },
									providerOptions: { google: { thoughtSignature: "sig-B" } },
								},
							],
						},
					],
				},
			}));
			const provider = createMastraProvider({ generate });

			const result = await provider.generate({
				systemPrompt: "be helpful",
				messages: [buildUserMessage("find pandas")],
				tools: {},
			});

			expect(result.assistantParts).toEqual([
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "get_timeline_state",
					args: {},
					providerOptions: { google: { thoughtSignature: "sig-A" } },
				},
				{
					type: "tool-call",
					toolCallId: "call-2",
					toolName: "find_scenes",
					args: { query: "panda" },
					providerOptions: { google: { thoughtSignature: "sig-B" } },
				},
			]);
		});

		it("strips echoed prompt assistant parts before persisting response parts", async () => {
			const summaryText =
				"Earlier conversation summary (5 messages omitted):\n1. user: make a video";
			const echoedToolCall = {
				type: "tool-call" as const,
				toolCallId: "old-call-1",
				toolName: "find_scenes",
				input: { query: "panda" },
				providerOptions: { google: { thoughtSignature: "old-sig" } },
			};
			const newToolCall = {
				type: "tool-call" as const,
				toolCallId: "new-call-1",
				toolName: "get_media_assets",
				input: {},
				providerOptions: { google: { thoughtSignature: "new-sig" } },
			};
			const generate = mock(async () => ({
				text: "",
				reasoning: [],
				toolCalls: [],
				providerMetadata: {},
				response: {
					messages: [
						{
							id: "assistant-merged-response",
							role: "assistant" as const,
							content: [
								{ type: "text" as const, text: summaryText },
								echoedToolCall,
								newToolCall,
							],
						},
					],
				},
			}));
			const provider = createMastraProvider({ generate });
			const summaryMessage: AssistantMessage = {
				id: "context-summary-old-user",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "assistant",
				createdAt: "2026-01-01T00:00:00.000Z",
				parts: [{ type: "text", text: summaryText }],
				metadata: { contextWindowSummary: true, omittedMessageCount: 5 },
			};
			const previousAssistantMessage: AssistantMessage = {
				id: "assistant-old-call",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "assistant",
				createdAt: "2026-01-01T00:00:00.000Z",
				parts: [
					{
						type: "tool-call",
						toolCallId: echoedToolCall.toolCallId,
						toolName: echoedToolCall.toolName,
						args: echoedToolCall.input,
						providerOptions: echoedToolCall.providerOptions,
					},
				],
				metadata: {},
			};

			const result = await provider.generate({
				systemPrompt: "be helpful",
				messages: [
					summaryMessage,
					previousAssistantMessage,
					{ ...buildUserMessage("continue"), id: "user-2" },
				],
				tools: {},
			});

			expect(result.assistantParts).toEqual([
				{
					type: "tool-call",
					toolCallId: newToolCall.toolCallId,
					toolName: newToolCall.toolName,
					args: {},
					providerOptions: newToolCall.providerOptions,
				},
			]);
			expect(result.toolCalls).toEqual([
				{
					toolCallId: newToolCall.toolCallId,
					toolName: newToolCall.toolName,
					args: {},
				},
			]);
			expect(result.providerMetadata.rawResponseMessages).toEqual([
				{
					id: "assistant-merged-response",
					role: "assistant",
					content: [newToolCall],
				},
			]);
		});

		it("replays per-part providerOptions on outbound history when envelope is absent", async () => {
			const generate = mock(async () => ({
				text: "ok",
				reasoning: [],
				toolCalls: [],
				providerMetadata: {},
			}));
			const provider = createMastraProvider({ generate });

			const assistantMessage: AssistantMessage = {
				id: "assistant-1",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "assistant",
				createdAt: "2026-01-01T00:00:00.000Z",
				parts: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "get_timeline_state",
						args: {},
						providerOptions: { google: { thoughtSignature: "sig-A" } },
					},
					{
						type: "tool-call",
						toolCallId: "call-2",
						toolName: "find_scenes",
						args: { query: "panda" },
						providerOptions: { google: { thoughtSignature: "sig-B" } },
					},
				],
				metadata: {},
			};
			const toolMessage: AssistantMessage = {
				id: "tool-1",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "tool",
				createdAt: "2026-01-01T00:00:00.000Z",
				parts: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "get_timeline_state",
						result: {},
						isError: false,
					},
					{
						type: "tool-result",
						toolCallId: "call-2",
						toolName: "find_scenes",
						result: { results: [] },
						isError: false,
					},
				],
				metadata: {},
			};

			await provider.generate({
				systemPrompt: "be helpful",
				messages: [
					buildUserMessage("find pandas"),
					assistantMessage,
					toolMessage,
					{ ...buildUserMessage("ok next?"), id: "user-2" },
				],
				tools: {},
			});

			const assistantTurn = firstCalledMessages(generate.mock.calls).find(
				(message) => message.role === "assistant",
			);
			const content = assistantTurn?.content as
				| Array<{ providerOptions?: unknown }>
				| undefined;
			expect(content?.[0]?.providerOptions).toEqual({
				google: { thoughtSignature: "sig-A" },
			});
			expect(content?.[1]?.providerOptions).toEqual({
				google: { thoughtSignature: "sig-B" },
			});
		});

		it("drops a turn from history when a tool-call lacks a Gemini signature", async () => {
			const generate = mock(async () => ({
				text: "ok",
				reasoning: [],
				toolCalls: [],
				providerMetadata: {},
			}));
			const provider = createMastraProvider({ generate });

			const assistantMessage: AssistantMessage = {
				id: "assistant-broken",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "assistant",
				createdAt: "2026-01-01T00:00:00.000Z",
				parts: [
					{
						type: "tool-call",
						toolCallId: "call-unsigned",
						toolName: "get_timeline_state",
						args: {},
					},
					{
						type: "tool-call",
						toolCallId: "call-signed",
						toolName: "find_scenes",
						args: { query: "panda" },
						providerOptions: { google: { thoughtSignature: "sig-A" } },
					},
				],
				metadata: {},
			};
			const toolMessage: AssistantMessage = {
				id: "tool-broken",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "tool",
				createdAt: "2026-01-01T00:00:00.000Z",
				parts: [
					{
						type: "tool-result",
						toolCallId: "call-unsigned",
						toolName: "get_timeline_state",
						result: {},
						isError: false,
					},
					{
						type: "tool-result",
						toolCallId: "call-signed",
						toolName: "find_scenes",
						result: { results: [] },
						isError: false,
					},
				],
				metadata: {},
			};

			await provider.generate({
				systemPrompt: "be helpful",
				messages: [
					buildUserMessage("status"),
					assistantMessage,
					toolMessage,
					{ ...buildUserMessage("continue"), id: "user-2" },
				],
				tools: {},
			});

			const called = firstCalledMessages(generate.mock.calls);
			expect(called.filter((m) => m.role === "assistant")).toHaveLength(0);
			expect(called.filter((m) => m.role === "tool")).toHaveLength(0);
		});

		it("wire-shape guard catches a broken rawResponseMessages envelope that bypassed the canonical check", async () => {
			const generate = mock(async () => ({
				text: "ok",
				reasoning: [],
				toolCalls: [],
				providerMetadata: {},
			}));
			const provider = createMastraProvider({ generate });

			const assistantMessage: AssistantMessage = {
				id: "assistant-broken-envelope",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "assistant",
				createdAt: "2026-01-01T00:00:00.000Z",
				parts: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "find_scenes",
						args: { query: "panda" },
						providerOptions: { google: { thoughtSignature: "sig-1" } },
					},
				],
				metadata: {
					providerMetadata: {
						rawResponseMessages: [
							{
								id: "raw-1",
								role: "assistant",
								content: [
									{
										type: "tool-call",
										toolCallId: "call-1",
										toolName: "find_scenes",
										input: { query: "panda" },
									},
									{
										type: "tool-call",
										toolCallId: "call-2",
										toolName: "get_media_assets",
										input: {},
										providerOptions: {
											google: { thoughtSignature: "sig-2" },
										},
									},
								],
							},
						],
					},
				},
			};
			const toolMessage: AssistantMessage = {
				id: "tool-broken-envelope",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "tool",
				createdAt: "2026-01-01T00:00:00.000Z",
				parts: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "find_scenes",
						result: { results: [] },
						isError: false,
					},
					{
						type: "tool-result",
						toolCallId: "call-2",
						toolName: "get_media_assets",
						result: { assets: [] },
						isError: false,
					},
				],
				metadata: {},
			};

			await provider.generate({
				systemPrompt: "be helpful",
				messages: [
					buildUserMessage("find pandas"),
					assistantMessage,
					toolMessage,
					{ ...buildUserMessage("continue"), id: "user-2" },
				],
				tools: {},
			});

			const called = firstCalledMessages(generate.mock.calls);
			expect(called.filter((m) => m.role === "assistant")).toHaveLength(0);
			expect(called.filter((m) => m.role === "tool")).toHaveLength(0);
		});

		it("does not drop a known-good envelope when an unknown part shape is mixed in", async () => {
			const generate = mock(async () => ({
				text: "ok",
				reasoning: [],
				toolCalls: [],
				providerMetadata: {},
			}));
			const provider = createMastraProvider({ generate });

			const assistantMessage: AssistantMessage = {
				id: "assistant-1",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "assistant",
				createdAt: "2026-01-01T00:00:00.000Z",
				parts: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "get_timeline_state",
						args: {},
					},
				],
				metadata: {
					providerMetadata: {
						rawResponseMessages: [
							{
								id: "raw-1",
								role: "assistant",
								content: [
									{ type: "thought", reasoning_blob: "opaque-future-shape" },
									{
										type: "tool-call",
										toolCallId: "call-1",
										toolName: "get_timeline_state",
										input: {},
										providerOptions: {
											google: { thoughtSignature: "sig-A" },
										},
									},
								],
							},
						],
					},
				},
			};
			const toolMessage: AssistantMessage = {
				id: "tool-1",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "tool",
				createdAt: "2026-01-01T00:00:00.000Z",
				parts: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "get_timeline_state",
						result: {},
						isError: false,
					},
				],
				metadata: {},
			};

			await provider.generate({
				systemPrompt: "be helpful",
				messages: [
					buildUserMessage("status"),
					assistantMessage,
					toolMessage,
					{ ...buildUserMessage("ok next?"), id: "user-2" },
				],
				tools: {},
			});

			const assistantTurn = firstCalledMessages(generate.mock.calls).find(
				(m) => m.role === "assistant",
			);
			const toolCallPart = (
				assistantTurn?.content as Array<{
					type: string;
					providerOptions?: unknown;
				}>
			).find((part) => part.type === "tool-call");
			expect(toolCallPart?.providerOptions).toEqual({
				google: { thoughtSignature: "sig-A" },
			});
		});
	});
});
