import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@ultrapilot/core/types";
import { enforceGeminiSignatureInvariant } from "@ultrapilot/core/gemini-signature";
import {
	type MastraMessage,
	pickPartProviderOptions,
} from "../message-codec";
import {
	collectLocalPlannerToolCallIds,
	enforceGeminiWireSignatureInvariant,
	hoistEnvelopeSignaturesOntoParts,
	isLocalPlannerMessage,
	providerRequiresGoogleSignature,
	toMastraMessages,
} from "../gemini-signature-guard";

function assistantToolCall(
	overrides: Partial<AssistantMessage> & {
		toolCallId: string;
		toolName: string;
		args?: Record<string, unknown>;
		signature?: string;
	},
): AssistantMessage {
	const { toolCallId, toolName, args = {}, signature, ...rest } = overrides;
	return {
		id: "assistant-1",
		threadId: "thread-1",
		branchId: "branch-1",
		role: "assistant",
		createdAt: "2026-01-01T00:00:00.000Z",
		parts: [
			{
				type: "tool-call",
				toolCallId,
				toolName,
				args,
				...(signature
					? { providerOptions: { google: { thoughtSignature: signature } } }
					: {}),
			},
		],
		metadata: {},
		...rest,
	};
}

function toolResult(
	id: string,
	toolCallId: string,
	toolName: string,
): AssistantMessage {
	return {
		id,
		threadId: "thread-1",
		branchId: "branch-1",
		role: "tool",
		createdAt: "2026-01-01T00:00:00.000Z",
		parts: [
			{ type: "tool-result", toolCallId, toolName, result: {}, isError: false },
		],
		metadata: {},
	};
}

describe("providerRequiresGoogleSignature", () => {
	it("requires the signature when no profile is injected (tests / default Gemini)", () => {
		expect(providerRequiresGoogleSignature(undefined)).toBe(true);
	});

	it("requires the signature only for the gemini provider", () => {
		expect(
			providerRequiresGoogleSignature({
				provider: "gemini",
				model: "x",
				apiKey: "k",
			}),
		).toBe(true);
		expect(
			providerRequiresGoogleSignature({
				provider: "openai",
				model: "x",
				apiKey: "k",
			}),
		).toBe(false);
	});
});

describe("hoistEnvelopeSignaturesOntoParts", () => {
	it("hoists legacy raw-envelope signatures onto bare tool-call parts", () => {
		const stored: AssistantMessage = {
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
								{
									type: "tool-call",
									toolCallId: "call-1",
									toolName: "get_timeline_state",
									input: {},
									providerOptions: { google: { thoughtSignature: "sig-A" } },
								},
							],
						},
					],
				},
			},
		};

		const hoisted = hoistEnvelopeSignaturesOntoParts([stored]);
		const part = hoisted[0]?.parts[0];
		expect(part?.type).toBe("tool-call");
		if (part?.type === "tool-call") {
			expect(part.providerOptions).toEqual({
				google: { thoughtSignature: "sig-A" },
			});
		}
	});

	it("returns the input array by reference when there is nothing to hoist", () => {
		const messages = [
			assistantToolCall({
				toolCallId: "call-1",
				toolName: "find_scenes",
				signature: "sig-A",
			}),
		];
		expect(hoistEnvelopeSignaturesOntoParts(messages)).toBe(messages);
	});

	it("does not overwrite a signature already on the part", () => {
		const stored: AssistantMessage = {
			...assistantToolCall({
				toolCallId: "call-1",
				toolName: "get_timeline_state",
				signature: "already-here",
			}),
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
									toolName: "get_timeline_state",
									input: {},
									providerOptions: { google: { thoughtSignature: "envelope" } },
								},
							],
						},
					],
				},
			},
		};
		const part = hoistEnvelopeSignaturesOntoParts([stored])[0]?.parts[0];
		if (part?.type === "tool-call") {
			expect(part.providerOptions).toEqual({
				google: { thoughtSignature: "already-here" },
			});
		}
	});
});

describe("enforceGeminiSignatureInvariant (canonical) preserves first-call signatures", () => {
	it("keeps a turn whose first tool-call is signed (later parallel calls may be unsigned)", () => {
		const messages: AssistantMessage[] = [
			{
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
					},
				],
				metadata: {},
			},
		];
		expect(enforceGeminiSignatureInvariant(messages)).toBe(messages);
	});

	it("drops a non-local-planner turn whose first tool-call lacks a signature, and orphaned results", () => {
		const broken = assistantToolCall({
			toolCallId: "call-unsigned",
			toolName: "get_timeline_state",
		});
		const result = toolResult("tool-1", "call-unsigned", "get_timeline_state");
		const filtered = enforceGeminiSignatureInvariant([broken, result]);
		expect(filtered).toHaveLength(0);
	});
});

describe("local-planner replay exclusion", () => {
	it("recognizes a local-planner-tagged assistant message", () => {
		const planner: AssistantMessage = {
			...assistantToolCall({
				toolCallId: "local-call",
				toolName: "set_conversation_title",
			}),
			metadata: { providerMetadata: { localTimelineSegmentPlanner: true } },
		};
		expect(isLocalPlannerMessage(planner)).toBe(true);
		expect(collectLocalPlannerToolCallIds([planner])).toEqual(
			new Set(["local-call"]),
		);
	});

	it("keeps an unsigned local-planner turn in the canonical guard via excludedToolCallIds", () => {
		const planner: AssistantMessage = {
			...assistantToolCall({
				toolCallId: "local-call",
				toolName: "set_conversation_title",
			}),
			metadata: { providerMetadata: { localTimelineSegmentPlanner: true } },
		};
		const excluded = collectLocalPlannerToolCallIds([planner]);
		// Without exclusion the unsigned first tool-call would be dropped.
		expect(enforceGeminiSignatureInvariant([planner])).toHaveLength(0);
		// With exclusion it survives.
		const kept = enforceGeminiSignatureInvariant([planner], {
			excludedToolCallIds: excluded,
		});
		expect(kept).toHaveLength(1);
	});

	it("toMastraMessages strips local-planner tool-calls and never replays their tool-results", () => {
		const originalUser: AssistantMessage = {
			id: "user-1",
			threadId: "thread-1",
			branchId: "branch-1",
			role: "user",
			createdAt: "2026-01-01T00:00:00.000Z",
			parts: [{ type: "text", text: "tell me a story" }],
			metadata: {},
		};
		const planner: AssistantMessage = {
			...assistantToolCall({
				toolCallId: "local-call",
				toolName: "set_conversation_title",
			}),
			metadata: {
				providerMetadata: {
					localTimelineSegmentPlanner: true,
					stage: "discover",
				},
			},
		};
		const plannerResult = toolResult(
			"tool-local",
			"local-call",
			"set_conversation_title",
		);

		const wire = toMastraMessages([originalUser, planner, plannerResult]);
		expect(wire).toEqual([{ role: "user", content: "tell me a story" }]);
	});
});

describe("enforceGeminiWireSignatureInvariant", () => {
	it("drops an assistant wire turn whose first tool-call lacks a signature, plus orphaned tool results", () => {
		const wire: MastraMessage[] = [
			{ role: "user", content: "find pandas" },
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
						input: {},
						providerOptions: { google: { thoughtSignature: "sig-2" } },
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
			},
		];

		const cleaned = enforceGeminiWireSignatureInvariant(wire, {
			excludedToolCallIds: new Set(),
		});
		expect(cleaned.filter((m) => m.role === "assistant")).toHaveLength(0);
		expect(cleaned.filter((m) => m.role === "tool")).toHaveLength(0);
		expect(cleaned).toEqual([{ role: "user", content: "find pandas" }]);
	});

	it("keeps a signed first tool-call turn untouched (referential equality)", () => {
		const wire: MastraMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "find_scenes",
						input: { query: "panda" },
						providerOptions: { google: { thoughtSignature: "sig-1" } },
					},
				],
			},
		];
		const cleaned = enforceGeminiWireSignatureInvariant(wire, {
			excludedToolCallIds: new Set(),
		});
		expect(cleaned).toBe(wire);
	});

	it("excludes local-planner tool-call ids from the wire-shape check", () => {
		const wire: MastraMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "local-call",
						toolName: "set_conversation_title",
						input: {},
					},
				],
			},
		];
		const cleaned = enforceGeminiWireSignatureInvariant(wire, {
			excludedToolCallIds: new Set(["local-call"]),
		});
		expect(cleaned).toBe(wire);
	});

	it("reads signatures via pickPartProviderOptions across option/metadata field names", () => {
		// Sanity check that the guard's signature detection matches the codec helper.
		expect(
			pickPartProviderOptions({
				providerMetadata: { google: { thoughtSignature: "sig" } },
			}),
		).toEqual({ google: { thoughtSignature: "sig" } });
	});
});
