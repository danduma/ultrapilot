import { describe, expect, it } from "bun:test";
import {
	InMemoryEventSink,
	createSequence,
	emitEvent,
	type UltraPilotEvent,
} from "../control-plane";
import { generateText } from "../generation";
import type {
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
		usage: { inputTokens: 1, outputTokens: 1 },
		providerMetadata: {},
		...overrides,
	};
}

function adapterWith(
	script: { errors?: unknown[]; responses?: GenerateResult[] },
	classify?: (error: unknown) => ProviderErrorClassification,
): ModelAdapter {
	const errors = [...(script.errors ?? [])];
	const responses = [...(script.responses ?? [])];
	return {
		id: "fake-provider",
		capabilities: { reasoning: true, toolCalls: true },
		classifyError: classify,
		async generate() {
			if (errors.length > 0) {
				throw errors.shift();
			}
			return responses.shift() ?? result();
		},
	};
}

function assertMonotonicSeq(events: UltraPilotEvent[]) {
	for (let i = 0; i < events.length; i++) {
		expect(events[i].seq).toBe(i);
	}
}

describe("InMemoryEventSink", () => {
	it("records events and assigns monotonic seq through emitEvent", () => {
		const sink = new InMemoryEventSink();
		const nextSeq = createSequence();

		emitEvent(sink, nextSeq, {
			type: "ultrapilot.run.started",
			operation: "test",
		});
		emitEvent(sink, nextSeq, {
			type: "ultrapilot.run.finished",
			operation: "test",
			status: "completed",
		});

		expect(sink.types()).toEqual([
			"ultrapilot.run.started",
			"ultrapilot.run.finished",
		]);
		assertMonotonicSeq(sink.events);
	});

	it("is a no-op for a null sink", () => {
		const nextSeq = createSequence();
		expect(() =>
			emitEvent(null, nextSeq, {
				type: "ultrapilot.run.started",
				operation: "test",
			}),
		).not.toThrow();
	});

	it("filters by type", () => {
		const sink = new InMemoryEventSink();
		const nextSeq = createSequence();
		emitEvent(sink, nextSeq, {
			type: "ultrapilot.provider.request_started",
			providerId: "p",
			attempt: 1,
		});
		emitEvent(sink, nextSeq, {
			type: "ultrapilot.provider.response_received",
			providerId: "p",
			attempt: 1,
		});
		expect(sink.byType("ultrapilot.provider.request_started")).toHaveLength(1);
	});
});

describe("generation control-plane events", () => {
	it("fires the named events in order for a successful run", async () => {
		const sink = new InMemoryEventSink();
		await generateText({
			provider: adapterWith({ responses: [result()] }),
			parts: [{ type: "text", text: "hi" }],
			events: sink,
		});

		expect(sink.types()).toEqual([
			"ultrapilot.run.started",
			"ultrapilot.provider.request_started",
			"ultrapilot.provider.response_received",
			"ultrapilot.run.finished",
		]);
		assertMonotonicSeq(sink.events);
		expect(
			sink.byType("ultrapilot.run.finished")[0].status,
		).toBe("completed");
	});

	it("fires failed + retry_scheduled + a second request for a retried run", async () => {
		const sink = new InMemoryEventSink();
		await generateText({
			provider: adapterWith(
				{
					errors: [new Error("timeout")],
					responses: [result()],
				},
				() => ({ retryable: true, message: "timeout" }),
			),
			parts: [{ type: "text", text: "hi" }],
			retries: { maxAttempts: 3, delayMs: () => 0 },
			events: sink,
		});

		expect(sink.types()).toEqual([
			"ultrapilot.run.started",
			"ultrapilot.provider.request_started",
			"ultrapilot.provider.failed",
			"ultrapilot.provider.retry_scheduled",
			"ultrapilot.provider.request_started",
			"ultrapilot.provider.response_received",
			"ultrapilot.run.finished",
		]);
		assertMonotonicSeq(sink.events);
		const retry = sink.byType("ultrapilot.provider.retry_scheduled")[0];
		expect(retry.attempt).toBe(1);
		expect(retry.classification.retryable).toBe(true);
		const requestStarts = sink.byType(
			"ultrapilot.provider.request_started",
		);
		expect(requestStarts.map((event) => event.attempt)).toEqual([1, 2]);
	});

	it("fires failed + terminal_failure for an exhausted/terminal run", async () => {
		const sink = new InMemoryEventSink();
		const boom = new Error("invalid key");
		let thrown: unknown;
		try {
			await generateText({
				provider: adapterWith({ errors: [boom] }, () => ({
					retryable: false,
					message: "invalid key",
				})),
				parts: [{ type: "text", text: "hi" }],
				events: sink,
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(boom);
		expect(sink.types()).toEqual([
			"ultrapilot.run.started",
			"ultrapilot.provider.request_started",
			"ultrapilot.provider.failed",
			"ultrapilot.provider.terminal_failure",
			"ultrapilot.run.finished",
		]);
		assertMonotonicSeq(sink.events);
		expect(sink.byType("ultrapilot.run.finished")[0].status).toBe("failed");
		expect(
			sink.byType("ultrapilot.provider.terminal_failure")[0].message,
		).toBe("invalid key");
	});
});
