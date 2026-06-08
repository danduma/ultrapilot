// Mastra/provider error classifier (maps provider/transport errors to
// ProviderErrorClassification { retryable, message }) plus the generic
// retry-with-backoff wrapper.
//
// Ported from apps/web/src/lib/ultrapilot/retryable-error.ts and
// apps/web/src/lib/ultrapilot/provider-retry.ts.

import type {
	GenerateRequest,
	GenerateResult,
	ModelAdapter,
	ProviderErrorClassification,
} from "@ultrapilot/core/provider";

export function classifyRetryableMastraError(
	error: unknown,
): ProviderErrorClassification {
	const message =
		error instanceof Error ? error.message : "Unknown Mastra provider error";
	const lower = message.toLowerCase();
	return {
		retryable:
			lower.includes("cannot connect") ||
			lower.includes("other side closed") ||
			lower.includes("timeout") ||
			lower.includes("timed out") ||
			lower.includes("network") ||
			lower.includes("503") ||
			lower.includes("429"),
		message,
	};
}

const DEFAULT_MAX_ATTEMPTS = 3;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultDelayMs(attempt: number) {
	return Math.min(250 * 2 ** Math.max(attempt - 1, 0), 1000);
}

export async function generateWithProviderRetry(
	provider: ModelAdapter,
	input: GenerateRequest,
	{
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		delayMs = defaultDelayMs,
	}: {
		maxAttempts?: number;
		delayMs?: (attempt: number) => number;
	} = {},
): Promise<GenerateResult> {
	let attempt = 0;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			return await provider.generate(input);
		} catch (error) {
			attempt += 1;
			const classification = provider.classifyError?.(error) ?? {
				retryable: false,
				message: error instanceof Error ? error.message : "Unknown error",
			};
			if (!classification.retryable || attempt >= maxAttempts) {
				throw error;
			}
			await sleep(delayMs(attempt));
		}
	}
}
