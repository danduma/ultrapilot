import { describe, expect, it, mock } from "bun:test";
import { createAssistant } from "@ultrapilot/core/assistant";
import { createInMemoryStorage } from "@ultrapilot/core/storage";
import { createSqliteStorage } from "@ultrapilot/storage-sqlite";
import {
	createNextRoute,
	createThreadHistoryHandler,
} from "../create-next-route";
import type { ModelAdapter } from "@ultrapilot/core/provider";

describe("createNextRoute", () => {
	it("resolves request context and returns generated assistant messages", async () => {
		const provider: ModelAdapter = {
			id: "route-provider",
			capabilities: { reasoning: true, toolCalls: true },
			async generate() {
				return {
					id: "response-1",
					text: "Assistant reply",
					reasoning: ["quick analysis"],
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					providerMetadata: {},
				};
			},
		};
		const assistant = createAssistant({
			provider,
			storage: createInMemoryStorage(),
			systemPrompt: "Be helpful.",
			tools: {},
		});
		const resolveContext = mock(async () => ({ userId: "user-1" }));
		const { POST, GET } = createNextRoute({ assistant, resolveContext });

		const postResponse = await POST(
			new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "append-and-generate",
					newMessages: [
						{
							id: "message-1",
							threadId: "thread-1",
							branchId: "branch-1",
							role: "user",
							createdAt: new Date().toISOString(),
							parts: [{ type: "text", text: "Hello there" }],
							metadata: {},
						},
					],
				}),
			}),
		);
		const postBody = await postResponse.json();
		expect(resolveContext).toHaveBeenCalled();
		expect(postBody.messages.at(-1).parts[1]).toEqual({
			type: "text",
			text: "Assistant reply",
		});

		const getResponse = await GET(
			new Request(
				`http://localhost/api/chat?threadId=${postBody.thread.id}&branchId=${postBody.branch.id}`,
			),
		);
		const getBody = await getResponse.json();
		expect(getBody.messages).toHaveLength(2);
	});

	it("lists thread history with nested messages", async () => {
		const provider: ModelAdapter = {
			id: "history-provider",
			capabilities: { reasoning: false, toolCalls: true },
			async generate() {
				return {
					id: "response-1",
					text: "Saved reply",
					reasoning: [],
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					providerMetadata: {},
				};
			},
		};
		const assistant = createAssistant({
			provider,
			storage: createInMemoryStorage(),
			systemPrompt: "Be helpful.",
			tools: {},
		});
		await assistant.send({ text: "Keep this thread" });

		const historyHandler = createThreadHistoryHandler({ assistant });
		const response = await historyHandler(
			new Request("http://localhost/api/chat/history"),
		);
		const body = await response.json();

		expect(body.history).toHaveLength(1);
		expect(body.history[0].messages.length).toBeGreaterThan(0);
	});

	it("creates distinct threads when optimistic placeholder ids are posted", async () => {
		const provider: ModelAdapter = {
			id: "sqlite-route-provider",
			capabilities: { reasoning: false, toolCalls: true },
			async generate() {
				return {
					id: "response-1",
					text: "Assistant reply",
					reasoning: [],
					toolCalls: [],
					usage: { inputTokens: 1, outputTokens: 1 },
					providerMetadata: {},
				};
			},
		};
		const assistant = createAssistant({
			provider,
			storage: createSqliteStorage({ url: "file::memory:" }),
			systemPrompt: "Be helpful.",
			tools: {},
		});
		const { POST } = createNextRoute({ assistant });

		const firstResponse = await POST(
			new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "append-and-generate",
					newMessages: [
						{
							id: "message-1",
							threadId: "pending-thread",
							branchId: "pending-branch",
							role: "user",
							createdAt: new Date().toISOString(),
							parts: [{ type: "text", text: "First chat" }],
							metadata: {},
						},
					],
				}),
			}),
		);
		const secondResponse = await POST(
			new Request("http://localhost/api/chat", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "append-and-generate",
					newMessages: [
						{
							id: "message-2",
							threadId: "pending-thread",
							branchId: "pending-branch",
							role: "user",
							createdAt: new Date().toISOString(),
							parts: [{ type: "text", text: "Second chat" }],
							metadata: {},
						},
					],
				}),
			}),
		);

		const firstBody = await firstResponse.json();
		const secondBody = await secondResponse.json();

		expect(firstResponse.ok).toBe(true);
		expect(secondResponse.ok).toBe(true);
		expect(firstBody.thread.id).not.toBe("pending-thread");
		expect(secondBody.thread.id).not.toBe("pending-thread");
		expect(firstBody.thread.id).not.toBe(secondBody.thread.id);
	});
});
