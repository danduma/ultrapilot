import { describe, expect, it } from "bun:test";
import {
	GenerationParseError,
	generateMultimodal,
	generateObject,
	generateText,
} from "../generation";
import { InMemoryEventSink } from "../control-plane";
import type {
	GenerateRequest,
	GenerateResult,
	ModelAdapter,
	ProviderErrorClassification,
} from "../provider";

function result(overrides: Partial<GenerateResult> = {}): GenerateResult {
	return {
		id: "response-1",
		text: "hello",
		reasoning: [],
		toolCalls: [],
		usage: { inputTokens: 3, outputTokens: 5 },
		providerMetadata: {},
		...overrides,
	};
}

type FakeAdapterOptions = {
	id?: string;
	responses?: GenerateResult[];
	errors?: unknown[];
	classify?: (error: unknown) => ProviderErrorClassification;
	onRequest?: (request: GenerateRequest) => void;
};

/**
 * A fake ModelAdapter driven by a script of errors-then-responses. Each call
 * shifts the next scripted error (thrown) or response (returned). No network.
 */
function createFakeAdapter(options: FakeAdapterOptions = {}): {
	adapter: ModelAdapter;
	requests: GenerateRequest[];
	calls: () => number;
} {
	const errors = [...(options.errors ?? [])];
	const responses = [...(options.responses ?? [])];
	const requests: GenerateRequest[] = [];
	let calls = 0;

	const adapter: ModelAdapter = {
		id: options.id ?? "fake-provider",
		capabilities: { reasoning: true, toolCalls: true },
		classifyError: options.classify,
		async generate(request) {
			calls += 1;
			requests.push(request);
			options.onRequest?.(request);
			if (errors.length > 0) {
				throw errors.shift();
			}
			return responses.shift() ?? result();
		},
	};

	return { adapter, requests, calls: () => calls };
}

describe("generateText", () => {
	it("builds a single user message from text parts and returns the text", async () => {
		const { adapter, requests } = createFakeAdapter({
			responses: [result({ text: "the answer", reasoning: ["thought"] })],
		});

		const out = await generateText({
			provider: adapter,
			systemPrompt: "You are helpful.",
			parts: [{ type: "text", text: "what is 2+2?" }],
		});

		expect(out.text).toBe("the answer");
		expect(out.reasoning).toEqual(["thought"]);
		expect(out.usage).toEqual({ inputTokens: 3, outputTokens: 5 });

		expect(requests).toHaveLength(1);
		const request = requests[0];
		expect(request.systemPrompt).toBe("You are helpful.");
		expect(request.messages).toHaveLength(1);
		const message = request.messages[0];
		expect(message.role).toBe("user");
		expect(message.parts).toEqual([{ type: "text", text: "what is 2+2?" }]);
	});

	it("prefers assistantParts text over the flattened text when present", async () => {
		const { adapter } = createFakeAdapter({
			responses: [
				result({
					text: "flat",
					assistantParts: [{ type: "text", text: "from parts" }],
				}),
			],
		});

		const out = await generateText({
			provider: adapter,
			parts: [{ type: "text", text: "hi" }],
		});

		expect(out.text).toBe("from parts");
		expect(out.raw.text).toBe("flat");
	});
});

describe("generateMultimodal", () => {
	it("builds an image part on the user message", async () => {
		const { adapter, requests } = createFakeAdapter({
			responses: [result({ text: "a cat on a sofa" })],
		});

		const out = await generateMultimodal({
			provider: adapter,
			systemPrompt: "Describe the image.",
			parts: [
				{ type: "text", text: "describe this:" },
				{
					type: "image",
					image: "data:image/png;base64,AAAA",
					mediaType: "image/png",
				},
			],
		});

		expect(out.text).toBe("a cat on a sofa");
		const message = requests[0].messages[0];
		expect(message.parts).toEqual([
			{ type: "text", text: "describe this:" },
			{
				type: "image",
				image: "data:image/png;base64,AAAA",
				mediaType: "image/png",
			},
		]);
	});
});

describe("generateObject", () => {
	it("runs the caller-provided parse over the returned text", async () => {
		const { adapter } = createFakeAdapter({
			responses: [result({ text: '{"caption":"a dog"}' })],
		});

		const out = await generateObject<{ caption: string }>({
			provider: adapter,
			parts: [{ type: "text", text: "describe" }],
			parse: (text) => JSON.parse(text) as { caption: string },
		});

		expect(out.object).toEqual({ caption: "a dog" });
		expect(out.text).toBe('{"caption":"a dog"}');
	});

	it("supports caller-side JSON-from-text leniency (code fences / substring)", async () => {
		const { adapter } = createFakeAdapter({
			responses: [
				result({ text: 'prose before ```json\n{"ok":true}\n``` prose after' }),
			],
		});

		const lenientParse = (text: string): { ok: boolean } => {
			const start = text.indexOf("{");
			const end = text.lastIndexOf("}");
			return JSON.parse(text.slice(start, end + 1)) as { ok: boolean };
		};

		const out = await generateObject<{ ok: boolean }>({
			provider: adapter,
			parts: [{ type: "text", text: "go" }],
			parse: lenientParse,
		});

		expect(out.object).toEqual({ ok: true });
	});

	it("surfaces a parse failure as a typed GenerationParseError carrying the raw text", async () => {
		const { adapter } = createFakeAdapter({
			responses: [result({ text: "not json at all" })],
		});

		const events = new InMemoryEventSink();
		let thrown: unknown;
		try {
			await generateObject({
				provider: adapter,
				parts: [{ type: "text", text: "go" }],
				events,
				parse: (text) => JSON.parse(text),
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(GenerationParseError);
		const parseError = thrown as GenerationParseError;
		expect(parseError.text).toBe("not json at all");
		// The provider call itself succeeded — response_received fired.
		expect(events.types()).toContain("ultrapilot.provider.response_received");
	});
});

describe("retry", () => {
	it("retries a retryable error then succeeds", async () => {
		const retryable = new Error("timeout while connecting");
		const { adapter, calls } = createFakeAdapter({
			errors: [retryable],
			responses: [result({ text: "recovered" })],
			classify: (error) => ({
				retryable: true,
				message: error instanceof Error ? error.message : "x",
			}),
		});

		const out = await generateText({
			provider: adapter,
			parts: [{ type: "text", text: "hi" }],
			retries: { maxAttempts: 3, delayMs: () => 0 },
		});

		expect(out.text).toBe("recovered");
		expect(calls()).toBe(2);
	});

	it("throws the original error once retries are exhausted", async () => {
		const boom = new Error("persistent 503 from upstream");
		const { adapter, calls } = createFakeAdapter({
			errors: [boom, boom, boom],
			classify: () => ({ retryable: true, message: "503" }),
		});

		let thrown: unknown;
		try {
			await generateText({
				provider: adapter,
				parts: [{ type: "text", text: "hi" }],
				retries: { maxAttempts: 3, delayMs: () => 0 },
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(boom);
		expect(calls()).toBe(3);
	});

	it("does not retry a non-retryable error", async () => {
		const fatal = new Error("invalid api key");
		const { adapter, calls } = createFakeAdapter({
			errors: [fatal],
			classify: () => ({ retryable: false, message: "invalid api key" }),
		});

		let thrown: unknown;
		try {
			await generateText({
				provider: adapter,
				parts: [{ type: "text", text: "hi" }],
				retries: { maxAttempts: 3, delayMs: () => 0 },
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(fatal);
		expect(calls()).toBe(1);
	});
});
