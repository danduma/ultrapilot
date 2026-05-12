/**
 * Gemini history-replay invariant — see
 * `docs/notes/2026-05-12-gemini-thought-signature-invariant.md`.
 *
 * Google's Gemini API requires every replayed tool-call to carry the
 * opaque `providerOptions.google.thoughtSignature` that the model
 * returned on its original turn. Missing it → 400 with "Function call
 * is missing a thought_signature in functionCall parts".
 *
 * The helpers in this module enforce that invariant on the canonical
 * `AssistantMessage[]` history, regardless of which provider runtime
 * (Mastra, AI SDK, custom) ultimately serializes the history to the
 * wire. Keeping the logic here makes it reusable across adapters and
 * keeps any future provider that targets Gemini honest.
 */

import type {
	AssistantMessage,
	AssistantMessagePart,
	PartProviderOptions,
} from "./types";

export type GeminiSignatureLogEvent =
	| {
			type: "dropped-turn";
			reason: "missing-google-thought-signature";
			toolCallIds: string[];
			offendingToolCallIds: string[];
			messageId?: string;
	  }
	| {
			type: "dropped-tool-results";
			reason: "orphaned-by-turn-drop";
			toolCallIds: string[];
			messageId?: string;
	  };

export type EnforceGeminiSignatureOptions = {
	/**
	 * Tool-call ids that are allowed to lack a signature (typically
	 * locally-planned calls that never reached the model). The invariant
	 * check skips these entirely.
	 */
	excludedToolCallIds?: ReadonlySet<string>;
	/**
	 * Optional structured logger for invariant violations. Defaults to
	 * `console.error` so failures surface loudly in dev.
	 */
	logger?: (event: GeminiSignatureLogEvent) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function hasGoogleThoughtSignature(
	providerOptions: PartProviderOptions | undefined,
): boolean {
	if (!providerOptions) {
		return false;
	}
	const google = providerOptions.google;
	if (!isRecord(google)) {
		return false;
	}
	return (
		typeof google.thoughtSignature === "string" &&
		google.thoughtSignature.length > 0
	);
}

function isToolCallPart(
	part: AssistantMessagePart,
): part is Extract<AssistantMessagePart, { type: "tool-call" }> {
	return part.type === "tool-call";
}

function isToolResultPart(
	part: AssistantMessagePart,
): part is Extract<AssistantMessagePart, { type: "tool-result" }> {
	return part.type === "tool-result";
}

/**
 * Walks `messages` and returns the set of tool-call ids that would
 * violate the Gemini invariant if replayed — i.e. tool-call parts on an
 * assistant message whose `providerOptions.google.thoughtSignature` is
 * missing, excluding any ids in `excludedToolCallIds`.
 */
export function findToolCallsMissingGoogleSignature(
	messages: readonly AssistantMessage[],
	excludedToolCallIds: ReadonlySet<string> = new Set(),
): Set<string> {
	const missing = new Set<string>();

	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const part of message.parts) {
			if (!isToolCallPart(part)) {
				continue;
			}
			if (excludedToolCallIds.has(part.toolCallId)) {
				continue;
			}
			if (!hasGoogleThoughtSignature(part.providerOptions)) {
				missing.add(part.toolCallId);
			}
		}
	}

	return missing;
}

function defaultLogger(event: GeminiSignatureLogEvent) {
	if (typeof console === "undefined") {
		return;
	}
	console.error("[ultrapilot:gemini-signature]", event);
}

/**
 * Returns a copy of `messages` with every assistant turn whose tool-calls
 * violate the Gemini invariant removed, along with the tool-result
 * messages that referenced those dropped tool-calls. The remaining
 * history is structurally valid for Gemini replay by construction.
 *
 * If no offending tool-call is found, the input array is returned
 * unchanged (referential equality preserved).
 */
export function enforceGeminiSignatureInvariant(
	messages: readonly AssistantMessage[],
	options: EnforceGeminiSignatureOptions = {},
): AssistantMessage[] {
	const excluded = options.excludedToolCallIds ?? new Set<string>();
	const offending = findToolCallsMissingGoogleSignature(messages, excluded);
	if (offending.size === 0) {
		return messages as AssistantMessage[];
	}

	const log = options.logger ?? defaultLogger;
	const droppedToolCallIds = new Set<string>();

	const filtered: AssistantMessage[] = [];

	for (const message of messages) {
		if (message.role === "assistant") {
			const toolCallIdsOnTurn = message.parts
				.filter(isToolCallPart)
				.map((part) => part.toolCallId);
			const turnIsOffending = toolCallIdsOnTurn.some((id) =>
				offending.has(id),
			);
			if (turnIsOffending) {
				log({
					type: "dropped-turn",
					reason: "missing-google-thought-signature",
					toolCallIds: toolCallIdsOnTurn,
					offendingToolCallIds: toolCallIdsOnTurn.filter((id) =>
						offending.has(id),
					),
					messageId: message.id,
				});
				for (const id of toolCallIdsOnTurn) {
					droppedToolCallIds.add(id);
				}
				continue;
			}
			filtered.push(message);
			continue;
		}

		if (message.role === "tool") {
			const remainingParts = message.parts.filter(
				(part) => !isToolResultPart(part) || !droppedToolCallIds.has(part.toolCallId),
			);
			if (remainingParts.length === 0) {
				log({
					type: "dropped-tool-results",
					reason: "orphaned-by-turn-drop",
					toolCallIds: message.parts.flatMap((part) =>
						isToolResultPart(part) ? [part.toolCallId] : [],
					),
					messageId: message.id,
				});
				continue;
			}
			if (remainingParts.length === message.parts.length) {
				filtered.push(message);
				continue;
			}
			filtered.push({ ...message, parts: remainingParts });
			continue;
		}

		filtered.push(message);
	}

	return filtered;
}
