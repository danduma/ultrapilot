import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@ultrapilot/core/types";
import {
	collectSatisfiedToolCallIds,
	createToolResultCacheKey,
	executeToolCallBatch,
	filterUncachedToolCalls,
	filterUnsatisfiedToolCalls,
	stripCachedToolCallsFromLatestAssistant,
} from "../tool-loop";

describe("tool loop", () => {
	it("reuses cached results for duplicate read-only tool calls within one run", async () => {
		const calls: string[] = [];
		let cache = new Map<string, unknown>();

		const executeTool = async (
			toolName: string,
			args: Record<string, unknown>,
		) => {
			calls.push(`${toolName}:${JSON.stringify(args)}`);
			if (toolName === "set_conversation_title") {
				return { title: args.title };
			}
			if (toolName === "get_media_assets") {
				return { assets: [{ id: "panda-1" }] };
			}
			if (toolName === "get_timeline_state") {
				return { tracks: { main: { elements: [] } } };
			}
			return { manifest: { prompt: args.prompt } };
		};

		const getToolResultCacheKey = (
			toolName: string,
			args: Record<string, unknown>,
		) =>
			toolName === "get_media_assets" ||
			toolName === "get_timeline_state" ||
			toolName === "set_conversation_title" ||
			toolName === "analyze_project_media" ||
			toolName === "rank_media_candidates"
				? createToolResultCacheKey(toolName, args)
				: null;

		const firstBatch = await executeToolCallBatch({
			toolCalls: [
				{
					type: "tool-call",
					toolCallId: "call-0",
					toolName: "set_conversation_title",
					args: {
						title: "Cute Panda Edit",
					},
				},
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "get_media_assets",
					args: {},
				},
				{
					type: "tool-call",
					toolCallId: "call-2",
					toolName: "get_timeline_state",
					args: {},
				},
			],
			executeTool,
			threadId: "thread-1",
			branchId: "branch-1",
			cache,
			getToolResultCacheKey,
		});
		cache = firstBatch.cache;

		const secondBatch = await executeToolCallBatch({
			toolCalls: [
				{
					type: "tool-call",
					toolCallId: "call-3",
					toolName: "set_conversation_title",
					args: {
						title: "Cute Panda Edit",
					},
				},
				{
					type: "tool-call",
					toolCallId: "call-4",
					toolName: "get_media_assets",
					args: {},
				},
				{
					type: "tool-call",
					toolCallId: "call-5",
					toolName: "get_timeline_state",
					args: {},
				},
				{
					type: "tool-call",
					toolCallId: "call-6",
					toolName: "analyze_project_media",
					args: {
						mediaIds: ["panda-1"],
						prompt:
							"select the cutest 7 segments of pandas and put them on the timeline. Start with walking, then eating bamboo.",
					},
				},
			],
			executeTool,
			threadId: "thread-1",
			branchId: "branch-1",
			cache,
			getToolResultCacheKey,
		});

		expect(calls).toEqual([
			'set_conversation_title:{"title":"Cute Panda Edit"}',
			"get_media_assets:{}",
			"get_timeline_state:{}",
			'analyze_project_media:{"mediaIds":["panda-1"],"prompt":"select the cutest 7 segments of pandas and put them on the timeline. Start with walking, then eating bamboo."}',
		]);
		expect(secondBatch.toolMessages.map((message) => message.parts[0])).toEqual(
			[
				{
					type: "tool-result",
					toolCallId: "call-3",
					toolName: "set_conversation_title",
					result: { title: "Cute Panda Edit" },
					isError: false,
				},
				{
					type: "tool-result",
					toolCallId: "call-4",
					toolName: "get_media_assets",
					result: { assets: [{ id: "panda-1" }] },
					isError: false,
				},
				{
					type: "tool-result",
					toolCallId: "call-5",
					toolName: "get_timeline_state",
					result: { tracks: { main: { elements: [] } } },
					isError: false,
				},
				{
					type: "tool-result",
					toolCallId: "call-6",
					toolName: "analyze_project_media",
					result: {
						manifest: {
							prompt:
								"select the cutest 7 segments of pandas and put them on the timeline. Start with walking, then eating bamboo.",
						},
					},
					isError: false,
				},
			],
		);
	});

	it("emits observability events for tool starts, cache hits, successes, and errors", async () => {
		const events: Array<{
			phase: string;
			toolName: string;
			toolCallId: string;
			durationMs?: number;
			error?: string;
		}> = [];

		const batch = await executeToolCallBatch({
			toolCalls: [
				{
					type: "tool-call",
					toolCallId: "call-1",
					toolName: "get_media_assets",
					args: {},
				},
				{
					type: "tool-call",
					toolCallId: "call-2",
					toolName: "rank_media_candidates",
					args: { prompt: "pandas", sceneIds: ["scene-1"] },
				},
				{
					type: "tool-call",
					toolCallId: "call-3",
					toolName: "render_frame",
					args: { time: 0 },
				},
			],
			executeTool: async (toolName) => {
				if (toolName === "rank_media_candidates") {
					return { candidates: [{ scene_id: "scene-1", score: 0.9 }] };
				}
				if (toolName === "render_frame") {
					throw new Error("Render failed");
				}
				throw new Error(`Unexpected tool: ${toolName}`);
			},
			threadId: "thread-1",
			branchId: "branch-1",
			cache: new Map([
				[
					createToolResultCacheKey("get_media_assets", {}),
					{ assets: [{ id: "panda-1" }] },
				],
			]),
			getToolResultCacheKey: (toolName, args) =>
				toolName === "get_media_assets" || toolName === "rank_media_candidates"
					? createToolResultCacheKey(toolName, args)
					: null,
			onToolEvent: (event) => {
				events.push({
					phase: event.phase,
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					durationMs: "durationMs" in event ? event.durationMs : undefined,
					error: "error" in event ? event.error : undefined,
				});
			},
		});

		expect(batch.toolMessages).toHaveLength(3);
		expect(events).toEqual([
			{
				phase: "cache-hit",
				toolName: "get_media_assets",
				toolCallId: "call-1",
				durationMs: 0,
				error: undefined,
			},
			{
				phase: "start",
				toolName: "rank_media_candidates",
				toolCallId: "call-2",
				durationMs: undefined,
				error: undefined,
			},
			{
				phase: "success",
				toolName: "rank_media_candidates",
				toolCallId: "call-2",
				durationMs: expect.any(Number),
				error: undefined,
			},
			{
				phase: "start",
				toolName: "render_frame",
				toolCallId: "call-3",
				durationMs: undefined,
				error: undefined,
			},
			{
				phase: "error",
				toolName: "render_frame",
				toolCallId: "call-3",
				durationMs: expect.any(Number),
				error: "Render failed",
			},
		]);
	});

	it("treats a fully cached repeat batch as non-executable and strips repeated tool calls from the latest assistant message", () => {
		const cache = new Map<string, unknown>([
			[
				createToolResultCacheKey("set_conversation_title", {
					title: "Cute Panda Edit",
				}),
				{ title: "Cute Panda Edit" },
			],
			[createToolResultCacheKey("get_media_assets", {}), { assets: [] }],
			[
				createToolResultCacheKey("get_timeline_state", {}),
				{ tracks: { main: { elements: [] } } },
			],
			[
				createToolResultCacheKey("analyze_project_media", {
					mediaIds: ["panda-1"],
					prompt:
						"select the cutest 7 segments of pandas and put them on the timeline. Start with walking, then eating bamboo.",
				}),
				{ manifest: { scenes: [{ scene_id: "scene-1" }] } },
			],
			[
				createToolResultCacheKey("rank_media_candidates", {
					prompt:
						"select the cutest 7 segments of pandas and put them on the timeline. Start with walking, then eating bamboo.",
					sceneIds: ["scene-1"],
					maxCandidates: 7,
				}),
				{
					candidates: [
						{
							scene_id: "scene-1",
							score: 0.9,
						},
					],
				},
			],
		]);
		const assistantMessage: AssistantMessage = {
			id: "assistant-2",
			threadId: "thread-1",
			branchId: "branch-1",
			role: "assistant",
			createdAt: new Date().toISOString(),
			parts: [
				{
					type: "text",
					text: "There are no panda clips imported yet.",
				},
				{
					type: "tool-call",
					toolCallId: "call-3",
					toolName: "set_conversation_title",
					args: { title: "Cute Panda Edit" },
				},
				{
					type: "tool-call",
					toolCallId: "call-4",
					toolName: "get_media_assets",
					args: {},
				},
				{
					type: "tool-call",
					toolCallId: "call-5",
					toolName: "get_timeline_state",
					args: {},
				},
				{
					type: "tool-call",
					toolCallId: "call-6",
					toolName: "analyze_project_media",
					args: {
						mediaIds: ["panda-1"],
						prompt:
							"select the cutest 7 segments of pandas and put them on the timeline. Start with walking, then eating bamboo.",
					},
				},
				{
					type: "tool-call",
					toolCallId: "call-7",
					toolName: "rank_media_candidates",
					args: {
						prompt:
							"select the cutest 7 segments of pandas and put them on the timeline. Start with walking, then eating bamboo.",
						sceneIds: ["scene-1"],
						maxCandidates: 7,
					},
				},
			],
			metadata: {},
		};
		const getToolResultCacheKey = (
			toolName: string,
			args: Record<string, unknown>,
		) =>
			toolName === "get_media_assets" ||
			toolName === "get_timeline_state" ||
			toolName === "set_conversation_title" ||
			toolName === "analyze_project_media" ||
			toolName === "rank_media_candidates"
				? createToolResultCacheKey(toolName, args)
				: null;

		const uncachedToolCalls = filterUncachedToolCalls(
			assistantMessage.parts.filter(
				(
					part,
				): part is Extract<
					AssistantMessage["parts"][number],
					{ type: "tool-call" }
				> => part.type === "tool-call",
			),
			cache,
			getToolResultCacheKey,
		);
		const normalizedMessages = stripCachedToolCallsFromLatestAssistant(
			[assistantMessage],
			cache,
			getToolResultCacheKey,
		);

		expect(uncachedToolCalls).toEqual([]);
		expect(normalizedMessages[0]?.parts).toEqual([
			{
				type: "text",
				text: "There are no panda clips imported yet.",
			},
		]);
	});

	it("ignores replayed tool calls whose toolCallIds were already satisfied earlier in the thread", () => {
		const messages: AssistantMessage[] = [
			{
				id: "assistant-1",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "assistant",
				createdAt: new Date().toISOString(),
				parts: [
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "get_media_assets",
						args: {},
					},
				],
				metadata: {},
			},
			{
				id: "tool-1",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "tool",
				createdAt: new Date().toISOString(),
				parts: [
					{
						type: "tool-result",
						toolCallId: "call-1",
						toolName: "get_media_assets",
						result: { assets: [{ id: "panda-1" }] },
						isError: false,
					},
				],
				metadata: {},
			},
			{
				id: "assistant-2",
				threadId: "thread-1",
				branchId: "branch-1",
				role: "assistant",
				createdAt: new Date().toISOString(),
				parts: [
					{
						type: "text",
						text: "Replayed planner state",
					},
					{
						type: "tool-call",
						toolCallId: "call-1",
						toolName: "get_media_assets",
						args: {},
					},
					{
						type: "tool-call",
						toolCallId: "call-2",
						toolName: "apply_candidate_to_timeline",
						args: { candidateId: "cand-1" },
					},
				],
				metadata: {},
			},
		];

		const latestAssistantToolCalls = messages[2]?.parts.filter(
			(
				part,
			): part is Extract<
				AssistantMessage["parts"][number],
				{ type: "tool-call" }
			> => part.type === "tool-call",
		);
		const satisfiedToolCallIds = collectSatisfiedToolCallIds(messages);
		const unsatisfiedToolCalls = filterUnsatisfiedToolCalls(
			latestAssistantToolCalls ?? [],
			satisfiedToolCallIds,
		);
		const normalizedMessages = stripCachedToolCallsFromLatestAssistant(
			messages,
			new Map(),
			undefined,
			satisfiedToolCallIds,
		);

		expect([...satisfiedToolCallIds]).toEqual(["call-1"]);
		expect(unsatisfiedToolCalls).toEqual([
			{
				type: "tool-call",
				toolCallId: "call-2",
				toolName: "apply_candidate_to_timeline",
				args: { candidateId: "cand-1" },
			},
		]);
		expect(normalizedMessages[2]?.parts).toEqual([
			{
				type: "text",
				text: "Replayed planner state",
			},
			{
				type: "tool-call",
				toolCallId: "call-2",
				toolName: "apply_candidate_to_timeline",
				args: { candidateId: "cand-1" },
			},
		]);
	});
});
