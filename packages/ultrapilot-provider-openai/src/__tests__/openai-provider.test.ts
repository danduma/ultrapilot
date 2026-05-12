import { describe, expect, it, mock } from "bun:test";
import {
	createOpenAIProvider,
	normalizeOpenAIMessage,
} from "../openai-provider";

describe("openai provider", () => {
	it("normalizes text, reasoning, and tool calls from a provider message", () => {
		const normalized = normalizeOpenAIMessage({
			content: "OpenAI reply",
			reasoning: "analyzed request",
			tool_calls: [
				{
					id: "call-1",
					function: {
						name: "search_docs",
						arguments: JSON.stringify({ query: "ultrapilot" }),
					},
				},
			],
		});

		expect(normalized.text).toBe("OpenAI reply");
		expect(normalized.reasoning).toEqual(["analyzed request"]);
		expect(normalized.toolCalls[0]).toEqual({
			toolCallId: "call-1",
			toolName: "search_docs",
			args: { query: "ultrapilot" },
		});
	});

	it("marks rate-limit style failures as retryable", () => {
		const provider = createOpenAIProvider({
			apiKey: "test-key",
			model: "gpt-4.1",
		});

		const classification = provider.classifyError?.(
			new Error("429 rate limit exceeded"),
		);

		expect(classification).toEqual({
			retryable: true,
			message: "429 rate limit exceeded",
		});
	});

	it("uses token.js to generate a normalized response", async () => {
		const create = mock(async () => ({
			choices: [
				{
					message: {
						content: "Hello from OpenAI",
						reasoning: "brief reasoning",
						tool_calls: [],
					},
				},
			],
			usage: {
				prompt_tokens: 9,
				completion_tokens: 4,
			},
		}));
		const provider = createOpenAIProvider({
			apiKey: "test-key",
			model: "gpt-4.1",
			tokenjsFactory: () =>
				({
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
				},
		});

		const result = await provider.generate({
			systemPrompt: "Be helpful",
			messages: [],
			tools: {},
		});

		expect(create).toHaveBeenCalled();
		expect(result.text).toBe("Hello from OpenAI");
		expect(result.usage.inputTokens).toBe(9);
		expect(result.usage.outputTokens).toBe(4);
	});
});
