import type { ModelAdapter } from "@ultrapilot/core";
import {
	createMastraProvider,
	type UltraPilotProviderProfile,
} from "@ultrapilot/provider-mastra";

/**
 * App-provided settings that select and configure the active provider. The
 * provider profile is framework-agnostic (no Mastra types); `instructions` is
 * the product system prompt that becomes the agent's instructions, and `tools`
 * are the (opaque) provider tool definitions.
 */
export type ConfiguredProviderInput = {
	profile: UltraPilotProviderProfile;
	instructions?: string;
	tools?: Record<string, unknown>;
};

/**
 * Selects the active UltraPilot provider implementation and returns it as a core
 * `ModelAdapter`. Mastra-backed today (via @ultrapilot/provider-mastra), but the
 * return type never reveals that — the provider is swappable without touching
 * app code. App code imports this through @ultrapilot/runtime and never names
 * the provider package.
 */
export function createConfiguredUltraPilotProvider(
	input: ConfiguredProviderInput,
): ModelAdapter {
	return createMastraProvider({
		profile: input.profile,
		instructions: input.instructions,
		tools: input.tools,
	});
}
