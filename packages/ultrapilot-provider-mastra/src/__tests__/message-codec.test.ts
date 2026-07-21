import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@ultrapilot/core/types";
import {
	type MastraMessage,
	buildAssistantPartsFromResponseMessages,
	normalizeReasoning,
	normalizeTextAndReasoningFromResponseMessages,
	normalizeToolCalls,
	normalizeToolCallsFromResponseMessages,
	sanitizeMessagesForModel,
	selectTerminalAssistantMessages,
	stripEchoedAssistantPromptParts,
	toMastraUiMessages,
	toMastraUserContent,
} from "../message-codec";
import { toMastraMessages } from "../gemini-signature-guard";

function assistant(parts: AssistantMessage["parts"]): AssistantMessage {
	return {
		id: "assistant-1",
		threadId: "thread-1",
		branchId: "branch-1",
		role: "assistant",
		createdAt: "2026-01-01T00:00:00.000Z",
		parts,
		metadata: {},
	};
}

function user(text: string): AssistantMessage {
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

describe("toMastraMessages round-trip", () => {
	it("converts a user message to a string-content wire message", () => {
		const wire = toMastraMessages([user("hello there")]);
		expect(wire).toEqual([{ role: "user", content: "hello there" }]);
	});

	it("drops stored system messages because the agent owns its instructions", () => {
		const system: AssistantMessage = {
			id: "system-1",
			threadId: "thread-1",
			branchId: "branch-1",
			role: "system",
			createdAt: "2026-01-01T00:00:00.000Z",
			parts: [{ type: "text", text: "duplicate system" }],
			metadata: {},
		};
		const wire = toMastraMessages([system, user("hello")]);
		expect(wire).toEqual([{ role: "user", content: "hello" }]);
	});

	it("carries text, reasoning, and tool-call parts (with providerOptions) onto assistant content", () => {
		const wire = toMastraMessages([
			assistant([
				{ type: "reasoning", text: "thinking" },
				{ type: "text", text: "answer" },
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "find_scenes",
					args: { query: "panda" },
					providerOptions: { google: { thoughtSignature: "sig-A" } },
				},
			]),
		]);

		expect(wire).toHaveLength(1);
		const message = wire[0];
		expect(message.role).toBe("assistant");
		expect(message.content).toEqual([
			{ type: "reasoning", text: "thinking" },
			{ type: "text", text: "answer" },
			{
				type: "tool-call",
				toolCallId: "call-1",
				toolName: "find_scenes",
				input: { query: "panda" },
				providerOptions: { google: { thoughtSignature: "sig-A" } },
			},
		]);
		if (message.role === "assistant") {
			expect(message.toolCalls).toEqual([
				{ toolCallId: "call-1", toolName: "find_scenes", args: { query: "panda" } },
			]);
		}
	});

	it("converts tool-result parts to a tool wire message", () => {
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
					toolName: "find_scenes",
					result: { results: [] },
					isError: false,
				},
			],
			metadata: {},
		};
		const wire = toMastraMessages([toolMessage]);
		expect(wire).toEqual([
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "find_scenes",
						result: { results: [] },
						isError: false,
					},
				],
			},
		]);
	});

	it("replays stored rawResponseMessages verbatim (preserving provider metadata)", () => {
		const rawAssistant = {
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
		const stored: AssistantMessage = {
			...assistant([
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "set_conversation_title",
					args: { title: "Panda Timeline" },
				},
			]),
			metadata: { providerMetadata: { rawResponseMessages: [rawAssistant] } },
		};

		const wire = toMastraMessages([stored]);
		expect(wire).toEqual([rawAssistant]);
	});
});

describe("multimodal user content", () => {
	function imageUser(parts: AssistantMessage["parts"]): AssistantMessage {
		return {
			id: "user-img-1",
			threadId: "thread-1",
			branchId: "branch-1",
			role: "user",
			createdAt: "2026-01-01T00:00:00.000Z",
			parts,
			metadata: {},
		};
	}

	it("collapses a text-only user message to string content", () => {
		expect(toMastraUserContent(user("just text"))).toBe("just text");
	});

	it("round-trips an image part into Mastra image content (mixed text + image)", () => {
		const content = toMastraUserContent(
			imageUser([
				{ type: "text", text: "describe this:" },
				{
					type: "image",
					image: "data:image/png;base64,AAAA",
					mediaType: "image/png",
				},
			]),
		);

		expect(content).toEqual([
			{ type: "text", text: "describe this:" },
			{
				type: "image",
				image: "data:image/png;base64,AAAA",
				mediaType: "image/png",
			},
		]);
	});

	it("carries the image through toMastraMessages user-role conversion", () => {
		const wire = toMastraMessages([
			imageUser([
				{ type: "text", text: "what is in this frame?" },
				{ type: "image", image: "https://example.com/frame.png" },
			]),
		]);

		expect(wire).toEqual([
			{
				role: "user",
				content: [
					{ type: "text", text: "what is in this frame?" },
					{ type: "image", image: "https://example.com/frame.png" },
				],
			},
		]);
	});

	it("serializes an ordered image tool acknowledgement and follow-up as real wire content", () => {
		const toolAcknowledgement: AssistantMessage = {
			id: "tool-frame-1",
			threadId: "thread-1",
			branchId: "branch-1",
			role: "tool",
			createdAt: "2026-01-01T00:00:00.000Z",
			parts: [
				{
					type: "tool-result",
					toolCallId: "call-frame-1",
					toolName: "render_frame",
					result: { rendered: true, timeSeconds: 2.5 },
					isError: false,
				},
			],
			metadata: {},
		};
		const imageFollowUp = imageUser([
			{
				type: "image",
				image: "data:image/png;base64,REAL_FRAME_BYTES",
				mediaType: "image/png",
			},
		]);

		expect(toMastraMessages([toolAcknowledgement, imageFollowUp])).toEqual([
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-frame-1",
						toolName: "render_frame",
						result: { rendered: true, timeSeconds: 2.5 },
						isError: false,
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "image",
						image: "data:image/png;base64,REAL_FRAME_BYTES",
						mediaType: "image/png",
					},
				],
			},
		]);
	});

	it("maps array user content to UI image parts in toMastraUiMessages", () => {
		const ui = toMastraUiMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "caption this" },
					{
						type: "image",
						image: "data:image/jpeg;base64,BBBB",
						mediaType: "image/jpeg",
					},
				],
			},
		]);

		expect(ui).toEqual([
			{
				id: undefined,
				role: "user",
				parts: [
					{ type: "text", text: "caption this" },
					{
						type: "image",
						image: "data:image/jpeg;base64,BBBB",
						mediaType: "image/jpeg",
					},
				],
			},
		]);
	});
});

describe("toMastraUiMessages", () => {
	it("maps a user message to a UI text part", () => {
		const ui = toMastraUiMessages([{ role: "user", content: "hi" }]);
		expect(ui).toEqual([
			{ id: undefined, role: "user", parts: [{ type: "text", text: "hi" }] },
		]);
	});

	it("maps assistant tool-calls to tool-<name> UI parts carrying callProviderMetadata", () => {
		const ui = toMastraUiMessages([
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "get_timeline_state",
						input: {},
						providerOptions: { google: { thoughtSignature: "sig-A" } },
					},
				],
			},
		]);
		expect(ui[0]?.role).toBe("assistant");
		expect(ui[0]?.parts?.[0]).toEqual({
			type: "tool-get_timeline_state",
			toolCallId: "call-1",
			state: "input-available",
			input: {},
			callProviderMetadata: { google: { thoughtSignature: "sig-A" } },
		});
	});

	it("pairs a tool-result with the matching tool-call input and renders an output-available part", () => {
		const ui = toMastraUiMessages([
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "find_scenes",
						input: { query: "panda" },
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "find_scenes",
						result: { results: [] },
					},
				],
			},
		]);
		const outputPart = ui
			.flatMap((m) => (m.role === "assistant" ? m.parts : []))
			.find(
				(p) => "state" in p && p.state === "output-available",
			);
		expect(outputPart).toEqual({
			type: "tool-find_scenes",
			toolCallId: "call-1",
			state: "output-available",
			input: { query: "panda" },
			output: { results: [] },
		});
	});
});

describe("response normalization", () => {
	it("normalizes loosely-shaped tool calls onto the canonical shape", () => {
		const normalized = normalizeToolCalls([
			{ id: "call-1", name: "find_scenes", arguments: { query: "panda" } },
			{ toolCallId: "call-2", toolName: "get_media_assets", args: {} },
		]);
		expect(normalized).toEqual([
			{ toolCallId: "call-1", toolName: "find_scenes", args: { query: "panda" } },
			{ toolCallId: "call-2", toolName: "get_media_assets", args: {} },
		]);
	});

	it("extracts tool calls (input or args) from response messages", () => {
		const messages: MastraMessage[] = [
			{
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
						args: { limit: 5 },
					},
				],
			},
		];
		expect(normalizeToolCallsFromResponseMessages(messages)).toEqual([
			{ toolCallId: "call-1", toolName: "find_scenes", args: { query: "panda" } },
			{ toolCallId: "call-2", toolName: "get_media_assets", args: { limit: 5 } },
		]);
	});

	it("splits text and reasoning out of response messages", () => {
		const messages: MastraMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "thinking" },
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
		];
		expect(normalizeTextAndReasoningFromResponseMessages(messages)).toEqual({
			text: "first\nsecond",
			reasoning: ["thinking"],
		});
	});

	it("normalizes reasoning from strings, arrays, and { text } entries", () => {
		expect(normalizeReasoning("plain")).toEqual(["plain"]);
		expect(normalizeReasoning(["a", "", { text: "b" }, { text: "" }])).toEqual([
			"a",
			"b",
		]);
		expect(normalizeReasoning(null)).toEqual([]);
	});

	it("builds assistant parts carrying per-part providerOptions from response", () => {
		const parts = buildAssistantPartsFromResponseMessages([
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "find_scenes",
						input: { query: "panda" },
						providerMetadata: { google: { thoughtSignature: "sig-A" } },
					},
					{ type: "text", text: "ok" },
				],
			},
		]);
		expect(parts).toEqual([
			{
				type: "tool-call",
				toolCallId: "call-1",
				toolName: "find_scenes",
				args: { query: "panda" },
				providerOptions: { google: { thoughtSignature: "sig-A" } },
			},
			{ type: "text", text: "ok" },
		]);
	});
});

describe("selectTerminalAssistantMessages", () => {
	it("returns only the last assistant message when more than one is present", () => {
		const messages: MastraMessage[] = [
			{ role: "assistant", content: "first" },
			{ role: "user", content: "mid" },
			{ role: "assistant", content: "last" },
		];
		expect(selectTerminalAssistantMessages(messages)).toEqual([
			{ role: "assistant", content: "last" },
		]);
	});

	it("returns the single assistant message untouched", () => {
		const messages: MastraMessage[] = [{ role: "assistant", content: "only" }];
		expect(selectTerminalAssistantMessages(messages)).toEqual(messages);
	});
});

describe("sanitizeMessagesForModel", () => {
	it("omits heavyweight data/blob previews from tool results", () => {
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
		};

		const sanitized = sanitizeMessagesForModel([toolMessage]);
		const serialized = JSON.stringify(sanitized);
		expect(serialized).not.toContain("large-video");
		expect(serialized).not.toContain("large-thumb");
		expect(serialized).not.toContain("blob:http://localhost/video");
		expect(serialized).toContain("[video preview omitted]");
		expect(serialized).toContain("[image preview omitted]");
		expect(serialized).toContain("[blob URL omitted]");
	});

	it("returns the same array reference when nothing needs sanitizing", () => {
		const messages = [user("nothing heavy here")];
		expect(sanitizeMessagesForModel(messages)).toBe(messages);
	});
});

describe("stripEchoedAssistantPromptParts", () => {
	it("strips an exact leading echo of the assistant prompt", () => {
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
		const promptMessages: MastraMessage[] = [
			{ role: "assistant", content: [echoedToolCall] },
		];
		const responseMessages: MastraMessage[] = [
			{
				role: "assistant",
				content: [echoedToolCall, newToolCall],
			},
		];

		const stripped = stripEchoedAssistantPromptParts(
			responseMessages,
			promptMessages,
		);
		expect(stripped).toEqual([
			{ role: "assistant", content: [newToolCall] },
		]);
	});

	it("returns the response unchanged when there is no leading echo", () => {
		const responseMessages: MastraMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "fresh" }] },
		];
		const promptMessages: MastraMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "different" }] },
		];
		expect(
			stripEchoedAssistantPromptParts(responseMessages, promptMessages),
		).toBe(responseMessages);
	});
});
