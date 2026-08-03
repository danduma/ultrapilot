// Mastra runtime/agent construction and provider-profile -> model config mapping.
//
// UltraPilot owns the model-id prefixing and base-URL defaults that used to live
// in apps/web/src/lib/ai-settings/provider-adapter.ts. The app maps its resolved
// provider settings into the framework-agnostic DTO below and never sees Mastra
// types. Mastra agent/runtime construction is added in Task 6.
//
// Provider -> Mastra `model.id` prefix mapping:
//   - gemini             -> google/<model>
//   - openai             -> openai/<model>
//   - openai_compatible  -> openai-compatible/<model> (requires baseUrl)
//   - anthropic          -> anthropic/<model>
//   - openrouter         -> openai-compatible/<model> w/ openrouter baseUrl
//   - codex_openai       -> OpenAI Responses model w/ Codex subscription base URL

import { enforceGeminiSignatureInvariant } from "@ultrapilot/core/gemini-signature";
import type { ModelAdapter } from "@ultrapilot/core/provider";
import {
	collectLocalPlannerToolCallIds,
	enforceGeminiWireSignatureInvariant,
	hoistEnvelopeSignaturesOntoParts,
	providerRequiresGoogleSignature,
	toMastraMessages,
} from "./gemini-signature-guard";
import {
	type MastraGenerateOptions,
	type MastraGenerateResult,
	type MastraMessage,
	type MastraUiMessage,
	assertHasConversationMessages,
	buildAssistantPartsFromResponseMessages,
	isMastraAssistantMessage,
	normalizeReasoning,
	normalizeTextAndReasoningFromResponseMessages,
	normalizeToolCalls,
	normalizeToolCallsFromResponseMessages,
	sanitizeMessagesForModel,
	selectTerminalAssistantMessages,
	stripEchoedAssistantPromptParts,
	toMastraUiMessages,
} from "./message-codec";
import { classifyRetryableMastraError } from "./retryable-error";
import {
	createMastraToolsFromDefinitions,
	isAssistantToolDefinitions,
} from "./tool-conversion";
import { selectActiveMastraTools } from "./tool-routing";

/** Provider kinds UltraPilot can map to a Mastra model id. */
export type UltraPilotProviderKind =
	| "gemini"
	| "openai"
	| "anthropic"
	| "openai_compatible"
	| "openrouter"
	| "codex_openai";

/**
 * Stable, framework-agnostic provider profile. App settings resolution converts
 * its resolved profile into this DTO; nothing here exposes Mastra types, so app
 * code can depend on it through the @ultrapilot/runtime facade.
 */
export type UltraPilotProviderProfile = {
	provider: UltraPilotProviderKind;
	model: string;
	apiKey: string;
	baseUrl?: string;
	accountId?: string;
};

/** Internal Mastra model config shape consumed by the model factory. */
export type MastraModelConfig = {
	id: string;
	apiKey: string;
	url?: string;
	headers?: Record<string, string>;
	api?: "responses";
};

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

function modelIdPrefix(provider: UltraPilotProviderKind): string {
	switch (provider) {
		case "gemini":
			return "google";
		case "openai":
			return "openai";
		case "anthropic":
			return "anthropic";
		case "openai_compatible":
		case "openrouter":
			return "openai-compatible";
		case "codex_openai":
			return "openai";
	}
}

function effectiveBaseUrl(
	profile: UltraPilotProviderProfile,
): string | undefined {
	if (profile.baseUrl && profile.baseUrl.length > 0) {
		return profile.baseUrl;
	}
	switch (profile.provider) {
		case "openrouter":
			return OPENROUTER_BASE_URL;
		case "codex_openai":
			return CODEX_BASE_URL;
		default:
			return undefined;
	}
}

/** Maps an UltraPilot provider profile to a Mastra model config. */
export function buildMastraModelConfig(
	profile: UltraPilotProviderProfile,
): MastraModelConfig {
	const prefix = modelIdPrefix(profile.provider);
	const baseURL = effectiveBaseUrl(profile);
	const config: MastraModelConfig = {
		id: `${prefix}/${profile.model}`,
		apiKey: profile.apiKey,
	};
	if (baseURL) {
		config.url = baseURL;
	}
	if (profile.provider === "codex_openai") {
		config.api = "responses";
		if (profile.accountId) {
			config.headers = { "ChatGPT-Account-ID": profile.accountId };
		}
	}
	return config;
}

async function createMastraModel(profile: UltraPilotProviderProfile) {
	const config = buildMastraModelConfig(profile);
	if (config.api === "responses") {
		const { createOpenAI } = await import("@ai-sdk/openai-v5");
		return createOpenAI({
			apiKey: config.apiKey,
			baseURL: config.url,
			headers: config.headers,
		}).responses(profile.model);
	}
	return config;
}

const GEMINI_3_PROVIDER_OPTIONS = {
	providerOptions: {
		google: {
			thinkingConfig: {
				thinkingLevel: "low" as const,
			},
		},
	},
};

const CODEX_PROVIDER_OPTIONS = {
	providerOptions: {
		openai: {
			store: false,
			reasoningEffort: "medium" as const,
		},
	},
};

export interface CreateMastraAgentConfigInput {
	instructions: string;
	/**
	 * Either framework-agnostic `AssistantToolDefinition`s (name + description +
	 * JSON-Schema `inputSchema`, the shape `@opencut/assistant` produces) or tools
	 * already wrapped for Mastra. Definitions are wrapped internally with
	 * `createTool`; pre-wrapped tools are passed through unchanged.
	 */
	tools: Record<string, unknown>;
	id?: string;
	name?: string;
}

/**
 * Minimal structural view of a Mastra `Agent` the provider relies on: a
 * `generate(messages, options?)` method. Returned as an opaque generator so
 * the package never re-exports `@mastra/core` types into the public surface.
 */
export type MastraAgentLike = {
	generate: (
		messages: unknown,
		options?: MastraGenerateOptions,
	) => Promise<unknown>;
};

/**
 * Builds a Mastra `Agent` from an UltraPilot provider profile.
 *
 * NOTE: this is async because `@mastra/core/agent` is loaded lazily via a
 * dynamic import. The app's legacy `createMastraAgentConfig`
 * (apps/web/src/lib/ai-settings/provider-adapter.ts) was synchronous and
 * imported `Agent` at module top-level; importing any `@mastra/*` symbol
 * eagerly is not viable inside this workspace package (it crashes module load
 * in environments where the Mastra dependency chain's `zod/v4` subpath is not
 * resolvable). Deferring the import keeps the package and its tests loadable
 * and only pulls Mastra in when an agent is actually constructed.
 */
export async function createMastraAgentConfig(
	profile: UltraPilotProviderProfile,
	{ instructions, tools, id, name }: CreateMastraAgentConfigInput,
): Promise<MastraAgentLike> {
	const { Agent } = await import("@mastra/core/agent");
	const model = await createMastraModel(profile);
	// Accept framework-agnostic AssistantToolDefinitions (the @opencut/assistant
	// shape) and wrap them with Mastra `createTool` so the agent advertises proper
	// schemas to the model. Tools already in Mastra shape pass through unchanged.
	const agentTools = isAssistantToolDefinitions(tools)
		? await createMastraToolsFromDefinitions(tools)
		: tools;
	const agent = new Agent({
		id: id ?? "opencut-copilot",
		name: name ?? "Copilot",
		instructions,
		// Cast to satisfy Mastra's DynamicArgument wrapper around the static
		// config shape. Codex uses a concrete Responses model; other providers use
		// the model-router configuration.
		model: model as unknown as ConstructorParameters<typeof Agent>[0]["model"],
		tools: agentTools as unknown as ConstructorParameters<
			typeof Agent
		>[0]["tools"],
	});
	if (profile.provider === "codex_openai") {
		const streamingAgent = agent as unknown as {
			stream: (
				messages: unknown,
				options?: MastraGenerateOptions,
			) => Promise<{ getFullOutput: () => Promise<unknown> }>;
		};
		return {
			async generate(messages, options) {
				const output = options
					? await streamingAgent.stream(messages, options)
					: await streamingAgent.stream(messages);
				return output.getFullOutput();
			},
		};
	}
	return agent as unknown as MastraAgentLike;
}

export type MastraProviderDependencies = {
	/**
	 * Direct generate override. When provided, the provider never constructs a
	 * Mastra `Agent`; used by tests to avoid real network/API keys.
	 */
	generate?: (
		messages: MastraMessage[],
		options?: MastraGenerateOptions,
	) => Promise<MastraGenerateResult>;
	/**
	 * Framework-agnostic provider profile. When supplied (and `generate` is
	 * not), the provider lazily constructs a Mastra `Agent` per provider via
	 * `createMastraAgentConfig` on first call. Mutually exclusive with
	 * `generate`.
	 */
	profile?: UltraPilotProviderProfile;
	/** System instructions the constructed agent owns. Required for the agent path. */
	instructions?: string;
	/**
	 * Pre-wrapped Mastra tools, passed opaquely to the agent. The provider does
	 * not re-express app tool definitions.
	 */
	tools?: Record<string, unknown>;
};

/**
 * Codex uses an AI SDK v5 Responses model. Preserve model-message image parts
 * for that path; converting them to the legacy UI-message shape causes Mastra
 * to discard the images before the provider request.
 */
export function selectAgentMessageInput(
	messages: MastraMessage[],
	profile?: UltraPilotProviderProfile,
): MastraMessage[] | MastraUiMessage[] {
	return profile?.provider === "codex_openai"
		? messages
		: toMastraUiMessages(messages);
}

/**
 * Builds a @ultrapilot/core `ModelAdapter` backed by Mastra.
 *
 * Either inject `generate` (tests / custom transports) or supply
 * `profile` + `instructions` + `tools` to have the adapter lazily construct a
 * Mastra `Agent`. Unlike the app's original `createMastraProvider`, there is
 * NO `copilotAgent` fallback: the agent path requires a `profile`.
 */
export function createMastraProvider(
	dependencies: MastraProviderDependencies = {},
): ModelAdapter {
	let agentPromise: Promise<MastraAgentLike> | null = null;

	const getAgent = (): Promise<MastraAgentLike> => {
		if (!dependencies.profile) {
			throw new Error(
				"createMastraProvider requires either a `generate` override or a `profile` to construct an agent.",
			);
		}
		if (!agentPromise) {
			agentPromise = createMastraAgentConfig(dependencies.profile, {
				instructions: dependencies.instructions ?? "",
				tools: dependencies.tools ?? {},
			});
		}
		return agentPromise;
	};

	const generateForAgent = async (
		messages: MastraMessage[] | MastraUiMessage[],
		options?: MastraGenerateOptions,
	): Promise<MastraGenerateResult> => {
		const agent = await getAgent();
		const result = options
			? await agent.generate(messages, options)
			: await agent.generate(messages);
		return result as MastraGenerateResult;
	};

	return {
		id: "mastra:copilot-agent",
		capabilities: {
			reasoning: true,
			toolCalls: true,
		},
		classifyError: classifyRetryableMastraError,
		async generate(input) {
			const modelMessages = sanitizeMessagesForModel(input.messages);
			const modelInput =
				modelMessages === input.messages
					? input
					: { ...input, messages: modelMessages };
			// The model/tool loop owns creative-edit orchestration. We no longer
			// short-circuit subject-specific montage/segment prompts through a local
			// planner; the model searches, selects, times, and applies via tools.
			// The local-planner replay machinery below stays only so stored threads
			// that already contain planner-tagged assistant turns keep replaying
			// safely (their synthetic tool calls carry no Gemini thought signature).
			const localPlannerToolCallIds = collectLocalPlannerToolCallIds(
				modelInput.messages,
			);
			const requiresGoogleSignature = providerRequiresGoogleSignature(
				dependencies.profile,
			);
			const hoistedMessages = requiresGoogleSignature
				? hoistEnvelopeSignaturesOntoParts(modelInput.messages)
				: modelInput.messages;
			const sanitizedAssistantMessages = requiresGoogleSignature
				? enforceGeminiSignatureInvariant(hoistedMessages, {
						excludedToolCallIds: localPlannerToolCallIds,
					})
				: hoistedMessages;
			const wireMessages = toMastraMessages(sanitizedAssistantMessages);
			// Belt-and-braces: the canonical guard above checks AssistantMessage
			// parts, but toMastraMessages can short-circuit to the `rawResponseMessages`
			// envelope verbatim. Re-check the actual wire shape so a broken
			// envelope cannot reach Gemini.
			const messages = requiresGoogleSignature
				? enforceGeminiWireSignatureInvariant(wireMessages, {
						excludedToolCallIds: localPlannerToolCallIds,
					})
				: wireMessages;
			assertHasConversationMessages(messages);
			const activeTools = selectActiveMastraTools(input);
			const providerOptions =
				dependencies.profile?.provider === "codex_openai"
					? CODEX_PROVIDER_OPTIONS
					: !dependencies.profile || dependencies.profile.provider === "gemini"
						? GEMINI_3_PROVIDER_OPTIONS
						: {};
			const generateOptions = {
				...providerOptions,
				...(activeTools ? { activeTools } : {}),
			};
			const response = dependencies.generate
				? await dependencies.generate(messages, generateOptions)
				: await generateForAgent(
						selectAgentMessageInput(messages, dependencies.profile),
						generateOptions,
					);
			const rawResponseMessages = stripEchoedAssistantPromptParts(
				response.response?.messages?.filter(isMastraAssistantMessage) ?? [],
				messages,
			);
			const terminalAssistantMessages =
				selectTerminalAssistantMessages(rawResponseMessages);
			const normalizedMessages =
				terminalAssistantMessages.length > 0
					? normalizeTextAndReasoningFromResponseMessages(
							terminalAssistantMessages,
						)
					: null;
			const normalizedToolCalls =
				terminalAssistantMessages.length > 0
					? normalizeToolCallsFromResponseMessages(terminalAssistantMessages)
					: [];
			const assistantParts =
				terminalAssistantMessages.length > 0
					? buildAssistantPartsFromResponseMessages(terminalAssistantMessages)
					: [];

			return {
				id: crypto.randomUUID(),
				text: normalizedMessages?.text ?? response.text ?? "",
				reasoning: normalizedMessages?.reasoning.length
					? normalizedMessages.reasoning
					: normalizeReasoning(response.reasoning),
				toolCalls:
					normalizedToolCalls.length > 0
						? normalizedToolCalls
						: normalizeToolCalls(response.toolCalls),
				usage: {
					inputTokens: response.usage?.inputTokens,
					outputTokens: response.usage?.outputTokens,
					reasoningTokens: response.usage?.reasoningTokens,
				},
				providerMetadata: {
					...(response.providerMetadata ??
						response.experimental_providerMetadata ??
						{}),
					...(rawResponseMessages.length > 0 ? { rawResponseMessages } : {}),
				},
				...(assistantParts.length > 0 ? { assistantParts } : {}),
			};
		},
	};
}
