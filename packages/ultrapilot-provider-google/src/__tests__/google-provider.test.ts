import { describe, expect, it, mock } from "bun:test";
import {
	createGoogleProvider,
	normalizeGoogleMessage,
} from "../google-provider";

describe("google provider", () => {
	it("normalizes text, reasoning, and tool calls from a provider message", () => {
		const normalized = normalizeGoogleMessage({
			content: "Hello there",
			reasoning: "Used retrieval",
			tool_calls: [
				{
					id: "call-1",
					function: {
						name: "lookup_weather",
						arguments: JSON.stringify({ city: "Hanoi" }),
					},
				},
			],
		});

		expect(normalized.text).toBe("Hello there");
		expect(normalized.reasoning).toEqual(["Used retrieval"]);
		expect(normalized.toolCalls).toEqual([
			{
				toolCallId: "call-1",
				toolName: "lookup_weather",
				args: { city: "Hanoi" },
			},
		]);
	});

	it("marks transport-style connection failures as retryable", () => {
		const provider = createGoogleProvider({
			apiKey: "test-key",
			model: "gemini-2.5-pro",
		});

		const classification = provider.classifyError?.(
			new Error("Cannot connect to API: other side closed"),
		);

		expect(classification).toEqual({
			retryable: true,
			message: "Cannot connect to API: other side closed",
		});
	});

	it("uses token.js to generate a normalized response", async () => {
		const extendModelList = mock(() => undefined);
		const create = mock(async () => ({
			choices: [
				{
					message: {
						content: "Hello from Gemini",
						reasoning: "brief chain",
						tool_calls: [],
					},
				},
			],
			usage: {
				prompt_tokens: 11,
				completion_tokens: 5,
			},
		}));
		const provider = createGoogleProvider({
			apiKey: "test-key",
			model: "gemini-2.5-pro",
			tokenjsFactory: () =>
				({
					extendModelList,
					chat: {
						completions: {
							create,
						},
					},
				}) as {
					chat: {
						completions: {
							create: typeof create;
						};
					};
					extendModelList: typeof extendModelList;
				},
		});

		const result = await provider.generate({
			systemPrompt: "Be helpful",
			messages: [],
			tools: {},
		});

		expect(create).toHaveBeenCalled();
		expect(extendModelList).toHaveBeenCalledWith(
			"gemini",
			"gemini-2.5-pro",
			"gemini-1.5-pro",
		);
		expect(result.text).toBe("Hello from Gemini");
		expect(result.reasoning).toEqual(["brief chain"]);
		expect(result.usage).toEqual({
			inputTokens: 11,
			outputTokens: 5,
			reasoningTokens: undefined,
		});
	});
});
