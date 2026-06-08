import { describe, expect, it } from "bun:test";
import type { AssistantToolDefinition } from "@ultrapilot/core/types";
import {
	createMastraToolsFromDefinitions,
	isAssistantToolDefinitions,
} from "../tool-conversion";

const findScenes: AssistantToolDefinition = {
	description: "Search scenes by keyword.",
	inputSchema: {
		type: "object",
		properties: {
			query: { type: "string", description: "Keyword query." },
			limit: { type: "number" },
		},
		required: ["query"],
	},
};

const getTimelineState: AssistantToolDefinition = {
	description: "Returns the current timeline state.",
	inputSchema: { type: "object", properties: {} },
};

describe("isAssistantToolDefinitions", () => {
	it("recognizes framework-agnostic AssistantToolDefinitions", () => {
		expect(
			isAssistantToolDefinitions({ find_scenes: findScenes, get_timeline_state: getTimelineState }),
		).toBe(true);
	});

	it("returns false for an empty bag (nothing to wrap)", () => {
		expect(isAssistantToolDefinitions({})).toBe(false);
	});

	it("returns false when values are already-wrapped Mastra tools (no inputSchema object/description)", () => {
		// A Mastra-wrapped tool exposes a function-bearing object rather than the
		// plain { description, inputSchema } definition shape.
		expect(
			isAssistantToolDefinitions({
				find_scenes: { execute: () => undefined } as unknown as Record<
					string,
					unknown
				>,
			}),
		).toBe(false);
	});
});

describe("createMastraToolsFromDefinitions", () => {
	it("wraps each definition with createTool, preserving id/description/schema", async () => {
		const tools = await createMastraToolsFromDefinitions({
			find_scenes: findScenes,
			get_timeline_state: getTimelineState,
		});

		expect(Object.keys(tools).sort()).toEqual([
			"find_scenes",
			"get_timeline_state",
		]);

		const wrapped = tools.find_scenes as {
			id: string;
			description: string;
			inputSchema: unknown;
		};
		expect(wrapped.id).toBe("find_scenes");
		expect(wrapped.description).toBe("Search scenes by keyword.");
		// Mastra accepts the JSON Schema directly; the wrapped tool carries a schema
		// the agent advertises so the model can emit a tool-call.
		expect(wrapped.inputSchema).toBeDefined();
	});

	it("does NOT forward execution to Mastra (execution is app-side in the core tool loop)", async () => {
		let executed = false;
		const definition: AssistantToolDefinition = {
			description: "Has an app-side executor that must not run via Mastra.",
			inputSchema: { type: "object", properties: {} },
			execute: () => {
				executed = true;
				return { ok: true };
			},
		};

		const tools = await createMastraToolsFromDefinitions({ do_thing: definition });
		const wrapped = tools.do_thing as { execute?: unknown };

		// The wrapped Mastra tool carries no app executor: the core tool loop runs
		// the real tool and replays the result, so Mastra never executes it.
		expect(wrapped.execute).toBeUndefined();
		expect(executed).toBe(false);
	});

	it("returns an empty record for empty input", async () => {
		expect(await createMastraToolsFromDefinitions({})).toEqual({});
	});
});
