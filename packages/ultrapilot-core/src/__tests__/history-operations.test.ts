import { describe, expect, it } from "bun:test";
import { createAssistant } from "../assistant";
import { createInMemoryStorage } from "../storage";
import type { ModelAdapter } from "../provider";
import { createSqliteStorage } from "@ultrapilot/storage-sqlite";

function createProvider(): ModelAdapter {
	return {
		id: "history-provider",
		capabilities: { reasoning: false, toolCalls: true },
		async generate() {
			return {
				id: "response-1",
				text: "Ready.",
				reasoning: [],
				toolCalls: [],
				usage: { inputTokens: 1, outputTokens: 1 },
				providerMetadata: {},
			};
		},
	};
}

describe("history operations", () => {
	it("edits a prior user message by creating a new branch", async () => {
		const assistant = createAssistant({
			provider: createProvider(),
			storage: createInMemoryStorage(),
			systemPrompt: "Be helpful.",
			tools: {},
		});

		const original = await assistant.send({ text: "Original question" });
		const userMessage = original.messages.find(
			(message) => message.role === "user",
		);
		expect(userMessage).toBeDefined();
		if (!userMessage) {
			throw new Error("User message was not created");
		}

		const edited = await assistant.editMessage({
			threadId: original.thread.id,
			branchId: original.branch.id,
			messageId: userMessage.id,
			text: "Edited question",
		});

		expect(edited.branch.id).not.toBe(original.branch.id);
		expect(edited.messages[0]?.parts[0]).toEqual({
			type: "text",
			text: "Edited question",
		});
	});

	it("truncates a branch while keeping a checkpoint record", async () => {
		const assistant = createAssistant({
			provider: createProvider(),
			storage: createInMemoryStorage(),
			systemPrompt: "Be helpful.",
			tools: {},
		});

		const original = await assistant.send({ text: "Keep only the first turn" });
		const assistantMessage = original.messages.find(
			(message) => message.role === "assistant",
		);
		expect(assistantMessage).toBeDefined();
		const firstMessage = original.messages[0];
		if (!firstMessage) {
			throw new Error(
				"Expected the original branch to contain at least one message",
			);
		}

		const truncated = await assistant.truncateBranch({
			threadId: original.thread.id,
			branchId: original.branch.id,
			messageId: firstMessage.id,
		});

		expect(truncated.messages.map((message) => message.role)).toEqual(["user"]);
		expect(truncated.checkpoints).toHaveLength(1);
	});

	it("forks a prior message into a new sqlite-backed branch without reusing message ids", async () => {
		const assistant = createAssistant({
			provider: createProvider(),
			storage: createSqliteStorage({ url: "file::memory:" }),
			systemPrompt: "Be helpful.",
			tools: {},
		});

		const original = await assistant.send({ text: "Try again from here" });
		const userMessage = original.messages.find(
			(message) => message.role === "user",
		);
		expect(userMessage).toBeDefined();
		if (!userMessage) {
			throw new Error("User message was not created");
		}

		const forked = await assistant.forkBranch({
			threadId: original.thread.id,
			branchId: original.branch.id,
			messageId: userMessage.id,
			name: "rerun",
		});

		expect(forked.branch.id).not.toBe(original.branch.id);
		expect(forked.messages).toHaveLength(1);
		expect(forked.messages[0]?.id).not.toBe(userMessage.id);
		expect(forked.messages[0]?.parts[0]).toEqual({
			type: "text",
			text: "Try again from here",
		});
	});

	it("edits a prior message into a new sqlite-backed branch without reusing message ids", async () => {
		const assistant = createAssistant({
			provider: createProvider(),
			storage: createSqliteStorage({ url: "file::memory:" }),
			systemPrompt: "Be helpful.",
			tools: {},
		});

		const original = await assistant.send({ text: "Original wording" });
		const userMessage = original.messages.find(
			(message) => message.role === "user",
		);
		expect(userMessage).toBeDefined();
		if (!userMessage) {
			throw new Error("User message was not created");
		}

		const edited = await assistant.editMessage({
			threadId: original.thread.id,
			branchId: original.branch.id,
			messageId: userMessage.id,
			text: "Edited wording",
		});

		expect(edited.branch.id).not.toBe(original.branch.id);
		expect(edited.messages[0]?.id).not.toBe(userMessage.id);
		expect(edited.messages[0]?.parts[0]).toEqual({
			type: "text",
			text: "Edited wording",
		});
	});
});
