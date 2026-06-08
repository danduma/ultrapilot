// UltraPilot one-shot generation APIs (Task 7).
//
// These wrap a `ModelAdapter` for single-turn product generation calls
// (scene descriptions, media facts, scene views, consolidation) that do NOT
// need the full thread/branch/storage machinery of `createUltraPilot`. They
// own request formatting (build a single user message from text+image parts),
// retries (mirroring provider-mastra's generateWithProviderRetry semantics via
// `provider.classifyError`), raw-response preservation, and — for
// `generateObject` — running a caller-provided `parse` over the returned text
// and surfacing parse failures as a typed error/event.
//
// The product owns the schema/parse; core owns the request lifecycle. This
// module imports only from sibling core modules — no provider-mastra, no app.

import {
	emitEvent,
	createSequence,
	type EventSink,
} from "./control-plane";
import type {
	GenerateResult,
	ModelAdapter,
	ProviderErrorClassification,
	ProviderUsage,
} from "./provider";
import type {
	AssistantMessage,
	AssistantToolDefinition,
} from "./types";

// ---------------------------------------------------------------------------
// Input/output shapes
// ---------------------------------------------------------------------------

/** A text content part for a generation request. */
export type GenerationTextPart = {
	type: "text";
	text: string;
};

/** An image content part (URL or `data:` URI), mirroring `ImagePart`. */
export type GenerationImagePart = {
	type: "image";
	image: string;
	mediaType?: string;
};

export type GenerationContentPart = GenerationTextPart | GenerationImagePart;

export type GenerationRetryConfig = {
	maxAttempts?: number;
	delayMs?: (attempt: number) => number;
};

export type GenerationInput = {
	provider: ModelAdapter;
	/**
	 * System prompt threaded into the GenerateRequest. NOTE: the Mastra
	 * ModelAdapter sets its system prompt at construction (agent instructions),
	 * so callers using that adapter should build the provider with
	 * `instructions = systemPrompt`. We still pass it through so providers that
	 * read `GenerateRequest.systemPrompt` honor it and so it appears in records.
	 */
	systemPrompt?: string;
	/** The single user turn's content (mix of text and image parts). */
	parts: GenerationContentPart[];
	tools?: Record<string, AssistantToolDefinition>;
	retries?: GenerationRetryConfig;
	events?: EventSink;
	/** Correlation ids for emitted control-plane events. */
	runId?: string;
	threadId?: string;
	branchId?: string;
};

export type GenerationResult = {
	text: string;
	reasoning: string[];
	usage: ProviderUsage;
	providerMetadata: Record<string, unknown>;
	/** The raw provider result, preserved for callers that need verbatim parts. */
	raw: GenerateResult;
};

export type GenerateObjectInput<T> = GenerationInput & {
	/**
	 * Caller-owned parser. Receives the model's text and returns the typed
	 * object (or throws). The product owns schema/JSON-extraction leniency; core
	 * only runs this and reports failures.
	 */
	parse: (text: string) => T;
};

export type GenerateObjectResult<T> = GenerationResult & {
	object: T;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by `generateObject` when the caller's `parse` rejects the model text.
 * Carries the raw text and the underlying parse error so callers can log/inspect
 * the model output that failed to parse.
 */
export class GenerationParseError extends Error {
	readonly text: string;
	readonly cause: unknown;

	constructor(message: string, options: { text: string; cause: unknown }) {
		super(message);
		this.name = "GenerationParseError";
		this.text = options.text;
		this.cause = options.cause;
	}
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTEMPTS = 3;

function defaultDelayMs(attempt: number): number {
	return Math.min(250 * 2 ** Math.max(attempt - 1, 0), 1000);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function classify(
	provider: ModelAdapter,
	error: unknown,
): ProviderErrorClassification {
	return (
		provider.classifyError?.(error) ?? {
			retryable: false,
			message: error instanceof Error ? error.message : "Unknown error",
		}
	);
}

function now(): string {
	return new Date().toISOString();
}

function createId(): string {
	return crypto.randomUUID();
}

/**
 * Builds the single user `AssistantMessage` carrying the request's content.
 * Text parts become `TextPart`s; image parts become `ImagePart`s.
 */
function buildUserMessage(parts: GenerationContentPart[]): AssistantMessage {
	return {
		id: createId(),
		threadId: "generation",
		branchId: "generation",
		role: "user",
		createdAt: now(),
		parts: parts.map((part) =>
			part.type === "image"
				? {
						type: "image" as const,
						image: part.image,
						...(part.mediaType ? { mediaType: part.mediaType } : {}),
					}
				: { type: "text" as const, text: part.text },
		),
		metadata: {},
	};
}

/**
 * Prefer the provider's verbatim `assistantParts` text when present (consistent
 * with how the assistant runner treats GenerateResult); otherwise fall back to
 * the flattened `text`.
 */
function textFromResult(result: GenerateResult): string {
	if (result.assistantParts && result.assistantParts.length > 0) {
		const text = result.assistantParts
			.flatMap((part) =>
				part.type === "text" ? [part.text] : [],
			)
			.join("\n");
		if (text.length > 0) {
			return text;
		}
	}
	return result.text;
}

/**
 * Runs `provider.generate` with the retry loop, emitting control-plane events
 * through `input.events`. Mirrors provider-mastra's generateWithProviderRetry:
 * retry while the classification is retryable and attempts remain; otherwise
 * throw the original error.
 */
async function generateWithRetry(
	input: GenerationInput,
	operation: string,
): Promise<GenerateResult> {
	const { provider } = input;
	const maxAttempts = input.retries?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
	const delayMs = input.retries?.delayMs ?? defaultDelayMs;
	const nextSeq = createSequence();
	const correlation = {
		runId: input.runId,
		threadId: input.threadId,
		branchId: input.branchId,
	};

	emitEvent(input.events, nextSeq, {
		type: "ultrapilot.run.started",
		operation,
		...correlation,
	});

	const userMessage = buildUserMessage(input.parts);
	const request = {
		systemPrompt: input.systemPrompt ?? "",
		messages: [userMessage],
		tools: input.tools ?? {},
	};

	let attempt = 0;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		attempt += 1;
		emitEvent(input.events, nextSeq, {
			type: "ultrapilot.provider.request_started",
			providerId: provider.id,
			attempt,
			...correlation,
		});

		try {
			const result = await provider.generate(request);
			emitEvent(input.events, nextSeq, {
				type: "ultrapilot.provider.response_received",
				providerId: provider.id,
				attempt,
				usage: result.usage,
				...correlation,
			});
			emitEvent(input.events, nextSeq, {
				type: "ultrapilot.run.finished",
				operation,
				status: "completed",
				...correlation,
			});
			return result;
		} catch (error) {
			const classification = classify(provider, error);
			emitEvent(input.events, nextSeq, {
				type: "ultrapilot.provider.failed",
				providerId: provider.id,
				attempt,
				classification,
				...correlation,
			});

			if (!classification.retryable || attempt >= maxAttempts) {
				emitEvent(input.events, nextSeq, {
					type: "ultrapilot.provider.terminal_failure",
					providerId: provider.id,
					attempt,
					message: classification.message,
					...correlation,
				});
				emitEvent(input.events, nextSeq, {
					type: "ultrapilot.run.finished",
					operation,
					status: "failed",
					...correlation,
				});
				throw error;
			}

			const delay = delayMs(attempt);
			emitEvent(input.events, nextSeq, {
				type: "ultrapilot.provider.retry_scheduled",
				providerId: provider.id,
				attempt,
				delayMs: delay,
				classification,
				...correlation,
			});
			await sleep(delay);
		}
	}
}

function toGenerationResult(raw: GenerateResult): GenerationResult {
	return {
		text: textFromResult(raw),
		reasoning: raw.reasoning,
		usage: raw.usage,
		providerMetadata: raw.providerMetadata,
		raw,
	};
}

// ---------------------------------------------------------------------------
// Public APIs
// ---------------------------------------------------------------------------

/**
 * One-shot text generation. Builds a single user message from `parts`, runs the
 * provider with retries, and returns the flattened text plus reasoning/usage/
 * providerMetadata and the raw result.
 */
export async function generateText(
	input: GenerationInput,
): Promise<GenerationResult> {
	const raw = await generateWithRetry(input, "generateText");
	return toGenerationResult(raw);
}

/**
 * Same as `generateText` but the documented intent is that `parts` includes
 * image parts. Identical request path; named for call-site clarity.
 */
export async function generateMultimodal(
	input: GenerationInput,
): Promise<GenerationResult> {
	const raw = await generateWithRetry(input, "generateMultimodal");
	return toGenerationResult(raw);
}

/**
 * One-shot structured generation. Runs the model, then applies the caller's
 * `parse` to the returned text. A `parse` throw is surfaced as a
 * `GenerationParseError` (carrying the raw text) so callers can distinguish a
 * model/transport failure from a schema-mismatch.
 */
export async function generateObject<T>(
	input: GenerateObjectInput<T>,
): Promise<GenerateObjectResult<T>> {
	const raw = await generateWithRetry(input, "generateObject");
	const result = toGenerationResult(raw);
	try {
		const object = input.parse(result.text);
		return { ...result, object };
	} catch (error) {
		throw new GenerationParseError(
			`Failed to parse model output: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ text: result.text, cause: error },
		);
	}
}
