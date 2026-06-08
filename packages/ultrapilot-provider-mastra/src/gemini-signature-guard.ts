// Adapter-local raw-envelope hoisting and final wire-shape Gemini
// thought-signature guard, plus the local-planner replay back-compat
// (isLocalPlannerMessage / collectLocalPlannerToolCallIds) that excludes legacy
// local-planner tool-call IDs from signature replay.
//
// The canonical AssistantMessage[] guard `enforceGeminiSignatureInvariant`
// stays in @ultrapilot/core; this module imports it. Everything here is the
// Mastra-wire-shape last line of defense plus the back-compat that lets stored
// threads with providerMetadata.localTimelineSegmentPlanner === true replay
// without a Gemini thought signature.

import type {
	AssistantMessage,
	PartProviderOptions,
} from "@ultrapilot/core/types";
import {
	type MastraMessage,
	assistantMessageToText,
	isRecord,
	pickPartProviderOptions,
	rawResponseMessagesFromMetadata,
	toMastraAssistantContent,
	toMastraToolCalls,
	toMastraUserContent,
} from "./message-codec";
import type { UltraPilotProviderProfile } from "./mastra-runtime";

/**
 * Back-compat shim: messages saved before per-part `providerOptions`
 * landed on `AssistantMessagePart` stored their Gemini signatures inside
 * `metadata.providerMetadata.rawResponseMessages`. Hoist them onto the
 * matching `tool-call` parts in-memory so the canonical lib invariant
 * (`enforceGeminiSignatureInvariant`) sees a uniform shape.
 *
 * Returns a new array (with shallow-cloned parts) only when a hoist
 * actually occurs; otherwise the input array is returned by reference.
 */
export function hoistEnvelopeSignaturesOntoParts(
	messages: readonly AssistantMessage[],
): AssistantMessage[] {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "assistant") {
			return message;
		}
		const envelope = rawResponseMessagesFromMetadata(message.metadata);
		if (!envelope) {
			return message;
		}
		const signaturesByToolCallId = new Map<string, PartProviderOptions>();
		for (const envelopeMessage of envelope) {
			if (
				envelopeMessage.role !== "assistant" ||
				!Array.isArray(envelopeMessage.content)
			) {
				continue;
			}
			for (const envelopePart of envelopeMessage.content) {
				if (
					!isRecord(envelopePart) ||
					envelopePart.type !== "tool-call" ||
					typeof envelopePart.toolCallId !== "string"
				) {
					continue;
				}
				const opts = pickPartProviderOptions(envelopePart);
				if (opts) {
					signaturesByToolCallId.set(envelopePart.toolCallId, opts);
				}
			}
		}
		if (signaturesByToolCallId.size === 0) {
			return message;
		}
		let partsChanged = false;
		const nextParts = message.parts.map((part) => {
			if (part.type !== "tool-call") {
				return part;
			}
			if (part.providerOptions) {
				return part;
			}
			const opts = signaturesByToolCallId.get(part.toolCallId);
			if (!opts) {
				return part;
			}
			partsChanged = true;
			return { ...part, providerOptions: opts };
		});
		if (!partsChanged) {
			return message;
		}
		changed = true;
		return { ...message, parts: nextParts };
	});
	return changed ? next : (messages as AssistantMessage[]);
}

export function isLocalPlannerMessage(message: AssistantMessage) {
	const providerMetadata = message.metadata.providerMetadata;
	return (
		isRecord(providerMetadata) &&
		providerMetadata.localTimelineSegmentPlanner === true
	);
}

export function collectLocalPlannerToolCallIds(messages: AssistantMessage[]) {
	const toolCallIds = new Set<string>();
	for (const message of messages) {
		if (!isLocalPlannerMessage(message)) {
			continue;
		}
		for (const part of message.parts) {
			if (part.type === "tool-call") {
				toolCallIds.add(part.toolCallId);
			}
		}
	}
	return toolCallIds;
}

/**
 * Canonical AssistantMessage[] -> Mastra wire-message conversion. Lives with
 * the signature guard because it embeds the local-planner replay back-compat:
 * local-planner assistant turns drop their synthetic tool-calls (which never
 * carried a Gemini thought signature) and local-planner tool-results are never
 * replayed. Stored threads tagged
 * `providerMetadata.localTimelineSegmentPlanner === true` still replay safely.
 */
export function toMastraMessages(
	messages: AssistantMessage[],
): MastraMessage[] {
	const normalized: MastraMessage[] = [];
	const localPlannerToolCallIds = collectLocalPlannerToolCallIds(messages);

	for (const message of messages) {
		if (message.role === "system") {
			continue;
		}

		if (message.role === "assistant" && isLocalPlannerMessage(message)) {
			const content = toMastraAssistantContent(message).filter(
				(part) => part.type !== "tool-call",
			);
			if (content.length > 0) {
				normalized.push({
					role: "assistant",
					content,
				});
			}
			continue;
		}

		const rawResponseMessages = rawResponseMessagesFromMetadata(
			message.metadata,
		);
		if (rawResponseMessages) {
			normalized.push(...rawResponseMessages);
			continue;
		}

		if (message.role === "tool") {
			const toolResults = message.parts.flatMap((part) => {
				if (part.type !== "tool-result") {
					return [];
				}
				if (localPlannerToolCallIds.has(part.toolCallId)) {
					return [];
				}
				return [
					{
						type: "tool-result" as const,
						toolCallId: part.toolCallId,
						toolName: part.toolName,
						result: part.result,
						isError: part.isError,
					},
				];
			});

			if (toolResults.length > 0) {
				normalized.push({ role: "tool", content: toolResults });
			}
			continue;
		}

		if (message.role === "assistant") {
			normalized.push({
				role: "assistant",
				content: toMastraAssistantContent(message),
				toolCalls: toMastraToolCalls(message),
			});
			continue;
		}

		if (message.role === "user") {
			// User turns carry multimodal content: text-only collapses to a
			// string, image-bearing turns become an array of text/image parts.
			normalized.push({
				role: "user",
				content: toMastraUserContent(message),
			});
			continue;
		}

		normalized.push({
			role: message.role,
			content: assistantMessageToText(message),
		});
	}

	return normalized;
}

/**
 * Wire-shape last line of defense for the Gemini signature invariant.
 *
 * The canonical AssistantMessage[] guard in `@ultrapilot/core` runs
 * BEFORE serialization and protects against missing signatures on
 * stored parts. But `toMastraMessages` short-circuits to
 * `metadata.providerMetadata.rawResponseMessages` verbatim when present,
 * which means the wire-shape that actually reaches Gemini can still
 * carry a tool-call without a `thoughtSignature` (e.g. if a future
 * Mastra SDK starts returning new envelope shapes whose signatures land
 * on a sibling part rather than the tool-call itself).
 *
 * This pass scans the final MastraMessage[] right before send. Any assistant
 * turn whose first non-local-planner tool-call lacks
 * `providerOptions.google.thoughtSignature` is dropped wholesale, along with
 * any tool-result message entries it would have orphaned. Later parallel
 * tool-calls in the same assistant message may legitimately omit the
 * signature; Gemini validates the first function call in each step.
 * Logs a structured error so we can trace which message slipped past the
 * canonical guard.
 */
export function enforceGeminiWireSignatureInvariant(
	messages: MastraMessage[],
	{ excludedToolCallIds }: { excludedToolCallIds: ReadonlySet<string> },
): MastraMessage[] {
	const missing = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			if (!isRecord(part) || part.type !== "tool-call") {
				continue;
			}
			const toolCallId =
				typeof part.toolCallId === "string" ? part.toolCallId : null;
			if (!toolCallId || excludedToolCallIds.has(toolCallId)) {
				continue;
			}
			const providerOptions = pickPartProviderOptions(part);
			const google = providerOptions?.google;
			const sig =
				isRecord(google) && typeof google.thoughtSignature === "string"
					? google.thoughtSignature
					: "";
			if (!sig) {
				missing.add(toolCallId);
			}
			break;
		}
	}

	if (missing.size === 0) {
		return messages;
	}

	const droppedToolCallIds = new Set<string>();
	const cleaned: MastraMessage[] = [];
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const turnToolCallIds = message.content.flatMap((part) =>
				isRecord(part) &&
				part.type === "tool-call" &&
				typeof part.toolCallId === "string"
					? [part.toolCallId]
					: [],
			);
			if (turnToolCallIds.some((id) => missing.has(id))) {
				if (typeof console !== "undefined") {
					console.error(
						"[mastra-provider] wire-shape guard dropped assistant turn missing google.thoughtSignature",
						{
							toolCallIds: turnToolCallIds,
							offendingToolCallIds: turnToolCallIds.filter((id) =>
								missing.has(id),
							),
						},
					);
				}
				for (const id of turnToolCallIds) {
					droppedToolCallIds.add(id);
				}
				continue;
			}
			cleaned.push(message);
			continue;
		}

		if (message.role === "tool") {
			const remaining = message.content.filter(
				(entry) => !droppedToolCallIds.has(entry.toolCallId),
			);
			if (remaining.length === 0) {
				continue;
			}
			if (remaining.length === message.content.length) {
				cleaned.push(message);
				continue;
			}
			cleaned.push({ ...message, content: remaining });
			continue;
		}

		cleaned.push(message);
	}

	return cleaned;
}

export function providerRequiresGoogleSignature(
	profile: UltraPilotProviderProfile | undefined,
): boolean {
	// Tests inject `generate` without a profile; in that case we still enforce
	// the invariant because the historical default model is Gemini and the
	// test suite verifies this behavior.
	if (!profile) {
		return true;
	}
	return profile.provider === "gemini";
}
