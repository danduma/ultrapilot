// Framework-agnostic tool definitions -> Mastra `createTool` wrapping.
//
// The app builds tool definitions with @opencut/assistant (framework-agnostic
// `AssistantToolDefinition`s: name + description + JSON-Schema `inputSchema`,
// and an optional `execute`). The Mastra `Agent` needs proper tool *schemas* so
// the model can emit tool-calls, but it does NOT need to execute them in this
// path: UltraPilot's core tool loop executes tools application-side and replays
// the results back into the conversation. So the Mastra-wrapped tools carry only
// id/description/inputSchema; execution is intentionally NOT forwarded to Mastra.
//
// Mastra's `createTool` accepts a plain JSON Schema 7 object for `inputSchema`
// (its `PublicSchema` union includes `JSONSchema7`), so the framework-agnostic
// `inputSchema` is passed through verbatim — no Zod construction needed.
//
// NOTE: `@mastra/core` is imported lazily (dynamic import) for the same reason
// `createMastraAgentConfig` defers `@mastra/core/agent`: importing any
// `@mastra/*` symbol eagerly crashes module load where the Mastra dependency
// chain's `zod/v4` subpath is not resolvable. Deferring keeps this package and
// its tests loadable and only pulls Mastra in when tools are actually wrapped.

import type { AssistantToolDefinition } from "@ultrapilot/core/types";

/**
 * Converts framework-agnostic UltraPilot tool definitions into Mastra tools the
 * agent can advertise to the model. Returns a `Record<toolName, MastraTool>`
 * suitable for `new Agent({ tools })`.
 *
 * Execution is deliberately omitted: the UltraPilot core tool loop runs each
 * tool app-side and feeds the result back, so the Mastra agent only needs the
 * name/description/schema to emit a tool-call. (If a future provider path needs
 * Mastra to execute tools directly, forward `definition.execute` here.)
 */
export async function createMastraToolsFromDefinitions(
	definitions: Record<string, AssistantToolDefinition>,
): Promise<Record<string, unknown>> {
	const { createTool } = await import("@mastra/core/tools");
	return Object.fromEntries(
		Object.entries(definitions).map(([name, definition]) => [
			name,
			createTool({
				id: name,
				description: definition.description,
				// Mastra accepts a JSON Schema object directly (PublicSchema includes
				// JSONSchema7). Cast through `unknown` so this package never re-exports
				// Mastra's schema types onto its public surface.
				inputSchema:
					definition.inputSchema as unknown as Parameters<
						typeof createTool
					>[0]["inputSchema"],
			}),
		]),
	);
}

/**
 * Type guard: returns true when the opaque `tools` bag is the framework-agnostic
 * `AssistantToolDefinition` shape (every value has a `description` string and an
 * `inputSchema` object) rather than already-wrapped Mastra tools. Lets
 * `createMastraAgentConfig` accept either and only wrap when necessary.
 */
export function isAssistantToolDefinitions(
	tools: Record<string, unknown>,
): tools is Record<string, AssistantToolDefinition> {
	const values = Object.values(tools);
	if (values.length === 0) {
		return false;
	}
	return values.every((value) => {
		if (typeof value !== "object" || value === null) {
			return false;
		}
		const candidate = value as Record<string, unknown>;
		return (
			typeof candidate.description === "string" &&
			typeof candidate.inputSchema === "object" &&
			candidate.inputSchema !== null
		);
	});
}
