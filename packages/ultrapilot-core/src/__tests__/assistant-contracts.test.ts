import { describe, expect, it } from "bun:test";
import { createUltraPilot } from "../assistant";
import type {
	AssistantBranch,
	AssistantEvent,
	AssistantMessage,
	AssistantThread,
} from "../types";
import type { ModelAdapter } from "../provider";
import type { AssistantStorage } from "../storage";

function createProvider(): ModelAdapter {
	return {
		id: "mock-provider",
		capabilities: {
			reasoning: true,
			toolCalls: true,
		},
		async generate() {
			return {
				id: "response-1",
				text: "hello",
				toolCalls: [],
				reasoning: [],
				usage: {
					inputTokens: 1,
					outputTokens: 1,
				},
				providerMetadata: {},
			};
		},
	};
}

function createStorage(): AssistantStorage {
	const thread: AssistantThread = {
		id: "thread-1",
		title: "Test Thread",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		activeBranchId: "branch-1",
		metadata: {},
	};

	const branch: AssistantBranch = {
		id: "branch-1",
		threadId: thread.id,
		name: "main",
		parentBranchId: null,
		sourceMessageId: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};

	return {
		async createThread() {
			return thread;
		},
		async getThread() {
			return thread;
		},
		async listThreads() {
			return [thread];
		},
		async getBranch() {
			return branch;
		},
		async listBranches() {
			return [branch];
		},
		async getMessages() {
			return [];
		},
		async appendMessages() {},
		async createBranch() {
			return branch;
		},
		async truncateBranch() {},
		async updateThread() {
			return thread;
		},
		async saveCheckpoint() {},
		async listCheckpoints() {
			return [];
		},
	};
}

describe("createUltraPilot", () => {
	it("returns an assistant runtime with the expected public APIs", () => {
		const ultrapilot = createUltraPilot({
			provider: createProvider(),
			storage: createStorage(),
			systemPrompt: "You are helpful.",
			tools: {},
		});

		expect(typeof ultrapilot.send).toBe("function");
		expect(typeof ultrapilot.generateStep).toBe("function");
		expect(typeof ultrapilot.regenerate).toBe("function");
		expect(typeof ultrapilot.editMessage).toBe("function");
		expect(typeof ultrapilot.forkBranch).toBe("function");
		expect(typeof ultrapilot.truncateBranch).toBe("function");
		expect(typeof ultrapilot.listThreads).toBe("function");
	});

	it("supports message parts and events for reasoning and tool calls", () => {
		const message: AssistantMessage = {
			id: "message-1",
			threadId: "thread-1",
			branchId: "branch-1",
			role: "assistant",
			createdAt: new Date().toISOString(),
			parts: [
				{ type: "reasoning", text: "Thinking..." },
				{
					type: "tool-call",
					toolCallId: "tool-1",
					toolName: "lookup_weather",
					args: { city: "Hanoi" },
				},
			],
			metadata: {},
		};

		const event: AssistantEvent = {
			id: "event-1",
			type: "run.retrying",
			timestamp: Date.now(),
			data: { attempt: 1 },
		};

		expect(message.parts[0]?.type).toBe("reasoning");
		expect(message.parts[1]?.type).toBe("tool-call");
		expect(event.type).toBe("run.retrying");
	});
});
