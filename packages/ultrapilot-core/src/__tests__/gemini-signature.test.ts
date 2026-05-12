import { describe, expect, it } from "bun:test";
import {
	enforceGeminiSignatureInvariant,
	findToolCallsMissingGoogleSignature,
	hasGoogleThoughtSignature,
	type GeminiSignatureLogEvent,
} from "../gemini-signature";
import type { AssistantMessage } from "../types";

function assistant(
	id: string,
	parts: AssistantMessage["parts"],
): AssistantMessage {
	return {
		id,
		threadId: "t",
		branchId: "b",
		role: "assistant",
		createdAt: "2026-05-12T00:00:00Z",
		parts,
		metadata: {},
	};
}

function tool(
	id: string,
	parts: AssistantMessage["parts"],
): AssistantMessage {
	return {
		id,
		threadId: "t",
		branchId: "b",
		role: "tool",
		createdAt: "2026-05-12T00:00:00Z",
		parts,
		metadata: {},
	};
}

function user(id: string, text: string): AssistantMessage {
	return {
		id,
		threadId: "t",
		branchId: "b",
		role: "user",
		createdAt: "2026-05-12T00:00:00Z",
		parts: [{ type: "text", text }],
		metadata: {},
	};
}

describe("hasGoogleThoughtSignature", () => {
	it("returns true for a present non-empty signature", () => {
		expect(
			hasGoogleThoughtSignature({
				google: { thoughtSignature: "sig" },
			}),
		).toBe(true);
	});

	it("returns false for missing providerOptions", () => {
		expect(hasGoogleThoughtSignature(undefined)).toBe(false);
	});

	it("returns false for empty-string signature", () => {
		expect(
			hasGoogleThoughtSignature({ google: { thoughtSignature: "" } }),
		).toBe(false);
	});

	it("returns false for non-google providerOptions only", () => {
		expect(
			hasGoogleThoughtSignature({ openai: { reasoning: "blah" } }),
		).toBe(false);
	});
});

describe("findToolCallsMissingGoogleSignature", () => {
	it("flags assistant tool-calls without google.thoughtSignature", () => {
		const missing = findToolCallsMissingGoogleSignature([
			assistant("a1", [
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "get_timeline_state",
					args: {},
					providerOptions: { google: { thoughtSignature: "sig" } },
				},
				{
					type: "tool-call",
					toolCallId: "call-2",
					toolName: "find_scenes",
					args: { q: "panda" },
				},
			]),
		]);
		expect([...missing]).toEqual(["call-2"]);
	});

	it("respects the excludedToolCallIds set", () => {
		const missing = findToolCallsMissingGoogleSignature(
			[
				assistant("a1", [
					{
						type: "tool-call",
						toolCallId: "local-planner",
						toolName: "set_conversation_title",
						args: { title: "Panda" },
					},
				]),
			],
			new Set(["local-planner"]),
		);
		expect(missing.size).toBe(0);
	});
});

describe("enforceGeminiSignatureInvariant", () => {
	it("returns the input unchanged when nothing violates the invariant", () => {
		const messages = [
			user("u1", "hi"),
			assistant("a1", [
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "get_timeline_state",
					args: {},
					providerOptions: { google: { thoughtSignature: "sig" } },
				},
			]),
		];
		const out = enforceGeminiSignatureInvariant(messages);
		expect(out).toBe(messages);
	});

	it("drops an assistant turn whose tool-calls miss signatures and the matching tool results", () => {
		const events: GeminiSignatureLogEvent[] = [];
		const messages = [
			user("u1", "hi"),
			assistant("a-broken", [
				{
					type: "tool-call",
					toolCallId: "call-signed",
					toolName: "get_timeline_state",
					args: {},
					providerOptions: { google: { thoughtSignature: "sig" } },
				},
				{
					type: "tool-call",
					toolCallId: "call-unsigned",
					toolName: "find_scenes",
					args: { q: "panda" },
				},
			]),
			tool("t-broken", [
				{
					type: "tool-result",
					toolCallId: "call-signed",
					toolName: "get_timeline_state",
					result: {},
					isError: false,
				},
				{
					type: "tool-result",
					toolCallId: "call-unsigned",
					toolName: "find_scenes",
					result: { results: [] },
					isError: false,
				},
			]),
			user("u2", "continue"),
		];
		const out = enforceGeminiSignatureInvariant(messages, {
			logger: (event) => events.push(event),
		});
		expect(out.map((m) => m.id)).toEqual(["u1", "u2"]);
		expect(events).toEqual([
			{
				type: "dropped-turn",
				reason: "missing-google-thought-signature",
				toolCallIds: ["call-signed", "call-unsigned"],
				offendingToolCallIds: ["call-unsigned"],
				messageId: "a-broken",
			},
			{
				type: "dropped-tool-results",
				reason: "orphaned-by-turn-drop",
				toolCallIds: ["call-signed", "call-unsigned"],
				messageId: "t-broken",
			},
		]);
	});

	it("trims partial tool-result messages when only some tool-call ids were dropped", () => {
		const messages = [
			user("u1", "hi"),
			assistant("a-good", [
				{
					type: "tool-call",
					toolCallId: "good-1",
					toolName: "get_timeline_state",
					args: {},
					providerOptions: { google: { thoughtSignature: "sig" } },
				},
			]),
			assistant("a-bad", [
				{
					type: "tool-call",
					toolCallId: "bad-1",
					toolName: "find_scenes",
					args: { q: "panda" },
				},
			]),
			tool("t-mixed", [
				{
					type: "tool-result",
					toolCallId: "good-1",
					toolName: "get_timeline_state",
					result: { tracks: [] },
					isError: false,
				},
				{
					type: "tool-result",
					toolCallId: "bad-1",
					toolName: "find_scenes",
					result: { results: [] },
					isError: false,
				},
			]),
		];
		const out = enforceGeminiSignatureInvariant(messages, {
			logger: () => undefined,
		});
		expect(out.map((m) => m.id)).toEqual(["u1", "a-good", "t-mixed"]);
		const toolMessage = out.find((m) => m.id === "t-mixed");
		expect(toolMessage?.parts).toEqual([
			{
				type: "tool-result",
				toolCallId: "good-1",
				toolName: "get_timeline_state",
				result: { tracks: [] },
				isError: false,
			},
		]);
	});

	it("never drops tool-calls listed in excludedToolCallIds, even without a signature", () => {
		const messages = [
			user("u1", "hi"),
			assistant("a-planner", [
				{
					type: "tool-call",
					toolCallId: "local-call",
					toolName: "set_conversation_title",
					args: { title: "Panda" },
				},
			]),
		];
		const out = enforceGeminiSignatureInvariant(messages, {
			excludedToolCallIds: new Set(["local-call"]),
			logger: () => undefined,
		});
		expect(out).toBe(messages);
	});
});
