// UltraPilot control-plane events (Task 8).
//
// A control-plane event is a structured, named record emitted at well-defined
// points in a run (provider request lifecycle, retries, tool calls, history
// guard actions). Events carry a monotonic `seq` so a recorded stream can be
// asserted in order, and optional run/thread/branch identifiers so a consumer
// can correlate events with a specific run. The `EventSink` interface is the
// only coupling point: generation APIs (and, optionally, the full assistant
// run) take an optional sink and emit through it. A default in-memory sink is
// provided for tests and scriptable inspection.
//
// This module is pure data + a tiny sink contract; it imports nothing from
// providers, frameworks, or app code.

import type { ProviderErrorClassification, ProviderUsage } from "./provider";

// ---------------------------------------------------------------------------
// Event type names
// ---------------------------------------------------------------------------

export type UltraPilotEventType =
	| "ultrapilot.run.started"
	| "ultrapilot.provider.request_started"
	| "ultrapilot.provider.retry_scheduled"
	| "ultrapilot.provider.response_received"
	| "ultrapilot.provider.failed"
	| "ultrapilot.provider.terminal_failure"
	| "ultrapilot.tool.call_started"
	| "ultrapilot.tool.call_finished"
	| "ultrapilot.tool.call_failed"
	| "ultrapilot.history.gemini_signature_hoisted"
	| "ultrapilot.history.gemini_turn_dropped"
	| "ultrapilot.run.finished";

/**
 * Fields every control-plane event carries. `seq` is monotonic per sink and
 * lets recorded streams be asserted in order. Identifiers are optional so the
 * generation APIs (which may not run inside a thread/branch) can still emit.
 */
export type UltraPilotEventBase = {
	type: UltraPilotEventType;
	seq: number;
	timestamp: number;
	runId?: string;
	threadId?: string;
	branchId?: string;
};

export type UltraPilotRunStartedEvent = UltraPilotEventBase & {
	type: "ultrapilot.run.started";
	/** Free-form label for the run, e.g. "generateObject" / "assistant.send". */
	operation?: string;
};

export type UltraPilotProviderRequestStartedEvent = UltraPilotEventBase & {
	type: "ultrapilot.provider.request_started";
	providerId: string;
	attempt: number;
};

export type UltraPilotProviderRetryScheduledEvent = UltraPilotEventBase & {
	type: "ultrapilot.provider.retry_scheduled";
	providerId: string;
	/** The attempt that just failed (1-based). */
	attempt: number;
	delayMs: number;
	classification: ProviderErrorClassification;
};

export type UltraPilotProviderResponseReceivedEvent = UltraPilotEventBase & {
	type: "ultrapilot.provider.response_received";
	providerId: string;
	attempt: number;
	usage?: ProviderUsage;
};

export type UltraPilotProviderFailedEvent = UltraPilotEventBase & {
	type: "ultrapilot.provider.failed";
	providerId: string;
	attempt: number;
	classification: ProviderErrorClassification;
};

export type UltraPilotProviderTerminalFailureEvent = UltraPilotEventBase & {
	type: "ultrapilot.provider.terminal_failure";
	providerId: string;
	attempt: number;
	message: string;
};

export type UltraPilotToolCallStartedEvent = UltraPilotEventBase & {
	type: "ultrapilot.tool.call_started";
	toolCallId: string;
	toolName: string;
};

export type UltraPilotToolCallFinishedEvent = UltraPilotEventBase & {
	type: "ultrapilot.tool.call_finished";
	toolCallId: string;
	toolName: string;
};

export type UltraPilotToolCallFailedEvent = UltraPilotEventBase & {
	type: "ultrapilot.tool.call_failed";
	toolCallId: string;
	toolName: string;
	message: string;
};

export type UltraPilotGeminiSignatureHoistedEvent = UltraPilotEventBase & {
	type: "ultrapilot.history.gemini_signature_hoisted";
	messageId?: string;
	toolCallIds: string[];
};

export type UltraPilotGeminiTurnDroppedEvent = UltraPilotEventBase & {
	type: "ultrapilot.history.gemini_turn_dropped";
	messageId?: string;
	toolCallIds: string[];
	offendingToolCallIds: string[];
};

export type UltraPilotRunFinishedEvent = UltraPilotEventBase & {
	type: "ultrapilot.run.finished";
	operation?: string;
	status: "completed" | "failed";
};

export type UltraPilotEvent =
	| UltraPilotRunStartedEvent
	| UltraPilotProviderRequestStartedEvent
	| UltraPilotProviderRetryScheduledEvent
	| UltraPilotProviderResponseReceivedEvent
	| UltraPilotProviderFailedEvent
	| UltraPilotProviderTerminalFailureEvent
	| UltraPilotToolCallStartedEvent
	| UltraPilotToolCallFinishedEvent
	| UltraPilotToolCallFailedEvent
	| UltraPilotGeminiSignatureHoistedEvent
	| UltraPilotGeminiTurnDroppedEvent
	| UltraPilotRunFinishedEvent;

// ---------------------------------------------------------------------------
// Sink contract
// ---------------------------------------------------------------------------

/**
 * Where control-plane events are delivered. Callers pass an `EventSink` into
 * the generation APIs (and, optionally, the assistant run) to observe the run
 * without coupling to a transport.
 */
export interface EventSink {
	emit(event: UltraPilotEvent): void;
}

/**
 * Fields the emitter fills in; `seq` and `timestamp` are assigned by the
 * emitter helper so callers never have to track the sequence counter.
 */
export type EmitInput =
	| Omit<UltraPilotRunStartedEvent, "seq" | "timestamp">
	| Omit<UltraPilotProviderRequestStartedEvent, "seq" | "timestamp">
	| Omit<UltraPilotProviderRetryScheduledEvent, "seq" | "timestamp">
	| Omit<UltraPilotProviderResponseReceivedEvent, "seq" | "timestamp">
	| Omit<UltraPilotProviderFailedEvent, "seq" | "timestamp">
	| Omit<UltraPilotProviderTerminalFailureEvent, "seq" | "timestamp">
	| Omit<UltraPilotToolCallStartedEvent, "seq" | "timestamp">
	| Omit<UltraPilotToolCallFinishedEvent, "seq" | "timestamp">
	| Omit<UltraPilotToolCallFailedEvent, "seq" | "timestamp">
	| Omit<UltraPilotGeminiSignatureHoistedEvent, "seq" | "timestamp">
	| Omit<UltraPilotGeminiTurnDroppedEvent, "seq" | "timestamp">
	| Omit<UltraPilotRunFinishedEvent, "seq" | "timestamp">;

/**
 * Stamps `seq` (monotonic, allocated by `nextSeq`) and `timestamp` onto an
 * event payload and emits it through `sink`. A `null`/`undefined` sink is a
 * no-op, so call sites can stay branch-free: `emitEvent(events, nextSeq, {...})`.
 */
export function emitEvent(
	sink: EventSink | null | undefined,
	nextSeq: () => number,
	input: EmitInput,
): void {
	if (!sink) {
		return;
	}
	const event = {
		...input,
		seq: nextSeq(),
		timestamp: Date.now(),
	} as UltraPilotEvent;
	sink.emit(event);
}

// ---------------------------------------------------------------------------
// In-memory / test sink
// ---------------------------------------------------------------------------

/**
 * Records every emitted event in order. Used by tests and scriptable
 * inspection: assert `events`, filter by `type`, or check `seq` monotonicity.
 */
export class InMemoryEventSink implements EventSink {
	readonly events: UltraPilotEvent[] = [];

	emit(event: UltraPilotEvent): void {
		this.events.push(event);
	}

	/** Returns the recorded events whose `type` matches. */
	byType<T extends UltraPilotEventType>(
		type: T,
	): Extract<UltraPilotEvent, { type: T }>[] {
		return this.events.filter(
			(event): event is Extract<UltraPilotEvent, { type: T }> =>
				event.type === type,
		);
	}

	/** Ordered list of event type names, for compact assertions. */
	types(): UltraPilotEventType[] {
		return this.events.map((event) => event.type);
	}

	clear(): void {
		this.events.length = 0;
	}
}

/**
 * Creates a monotonic sequence generator. Each sink/run gets its own counter so
 * `seq` is monotonic within the stream a sink records. Starts at 0.
 */
export function createSequence(): () => number {
	let seq = 0;
	return () => seq++;
}
