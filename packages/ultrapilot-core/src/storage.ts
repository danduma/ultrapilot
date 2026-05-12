import type {
	AssistantBranch,
	AssistantCheckpoint,
	AssistantMessage,
	AssistantThread,
} from "./types";

export interface AssistantStorage {
	createThread(input: {
		id?: string;
		title?: string | null;
		metadata?: Record<string, unknown>;
	}): Promise<AssistantThread>;
	getThread(threadId: string): Promise<AssistantThread | null>;
	listThreads(): Promise<AssistantThread[]>;
	updateThread(
		threadId: string,
		patch: Partial<AssistantThread>,
	): Promise<AssistantThread>;
	getBranch(
		threadId: string,
		branchId: string,
	): Promise<AssistantBranch | null>;
	listBranches(threadId: string): Promise<AssistantBranch[]>;
	createBranch(input: {
		threadId: string;
		name?: string;
		parentBranchId?: string | null;
		sourceMessageId?: string | null;
		messages?: AssistantMessage[];
	}): Promise<AssistantBranch>;
	getMessages(input: {
		threadId: string;
		branchId: string;
	}): Promise<AssistantMessage[]>;
	appendMessages(input: {
		threadId: string;
		branchId: string;
		messages: AssistantMessage[];
	}): Promise<void>;
	truncateBranch(input: {
		threadId: string;
		branchId: string;
		messageId: string;
	}): Promise<void>;
	saveCheckpoint(checkpoint: AssistantCheckpoint): Promise<void>;
	listCheckpoints(input: {
		threadId: string;
		branchId: string;
	}): Promise<AssistantCheckpoint[]>;
}

type InMemoryState = {
	threads: Map<string, AssistantThread>;
	branches: Map<string, AssistantBranch>;
	threadBranches: Map<string, string[]>;
	messages: Map<string, AssistantMessage[]>;
	checkpoints: Map<string, AssistantCheckpoint[]>;
};

function now() {
	return new Date().toISOString();
}

function createId() {
	return crypto.randomUUID();
}

function getKey(threadId: string, branchId: string) {
	return `${threadId}:${branchId}`;
}

export function createInMemoryStorage(): AssistantStorage {
	const state: InMemoryState = {
		threads: new Map(),
		branches: new Map(),
		threadBranches: new Map(),
		messages: new Map(),
		checkpoints: new Map(),
	};

	return {
		async createThread(input) {
			const createdAt = now();
			const threadId = input.id ?? createId();
			const branchId = createId();
			const thread: AssistantThread = {
				id: threadId,
				title: input.title ?? null,
				createdAt,
				updatedAt: createdAt,
				activeBranchId: branchId,
				metadata: input.metadata ?? {},
			};
			const branch: AssistantBranch = {
				id: branchId,
				threadId,
				name: "main",
				parentBranchId: null,
				sourceMessageId: null,
				createdAt,
				updatedAt: createdAt,
			};
			state.threads.set(threadId, thread);
			state.branches.set(branchId, branch);
			state.threadBranches.set(threadId, [branchId]);
			state.messages.set(getKey(threadId, branchId), []);
			state.checkpoints.set(getKey(threadId, branchId), []);
			return thread;
		},
		async getThread(threadId) {
			return state.threads.get(threadId) ?? null;
		},
		async listThreads() {
			return Array.from(state.threads.values()).sort((a, b) =>
				b.updatedAt.localeCompare(a.updatedAt),
			);
		},
		async updateThread(threadId, patch) {
			const current = state.threads.get(threadId);
			if (!current) {
				throw new Error(`Thread not found: ${threadId}`);
			}
			const updated: AssistantThread = {
				...current,
				...patch,
				id: current.id,
				updatedAt: patch.updatedAt ?? now(),
			};
			state.threads.set(threadId, updated);
			return updated;
		},
		async getBranch(_threadId, branchId) {
			return state.branches.get(branchId) ?? null;
		},
		async listBranches(threadId) {
			return (state.threadBranches.get(threadId) ?? [])
				.map((branchId) => state.branches.get(branchId))
				.filter((value): value is AssistantBranch => value != null);
		},
		async createBranch(input) {
			const createdAt = now();
			const branchId = createId();
			const branch: AssistantBranch = {
				id: branchId,
				threadId: input.threadId,
				name:
					input.name ??
					`branch-${(state.threadBranches.get(input.threadId)?.length ?? 0) + 1}`,
				parentBranchId: input.parentBranchId ?? null,
				sourceMessageId: input.sourceMessageId ?? null,
				createdAt,
				updatedAt: createdAt,
			};
			state.branches.set(branchId, branch);
			const existing = state.threadBranches.get(input.threadId) ?? [];
			state.threadBranches.set(input.threadId, [...existing, branchId]);
			state.messages.set(
				getKey(input.threadId, branchId),
				(input.messages ?? []).map((message) => ({
					...message,
					branchId,
				})),
			);
			state.checkpoints.set(getKey(input.threadId, branchId), []);
			await this.updateThread(input.threadId, {
				activeBranchId: branchId,
				updatedAt: createdAt,
			});
			return branch;
		},
		async getMessages(input) {
			return [
				...(state.messages.get(getKey(input.threadId, input.branchId)) ?? []),
			];
		},
		async appendMessages(input) {
			const key = getKey(input.threadId, input.branchId);
			const current = state.messages.get(key) ?? [];
			const byId = new Map(current.map((message) => [message.id, message]));
			for (const message of input.messages) {
				byId.set(message.id, message);
			}
			state.messages.set(key, Array.from(byId.values()));
			state.messages.set(
				key,
				(state.messages.get(key) ?? []).sort((a, b) =>
					a.createdAt.localeCompare(b.createdAt),
				),
			);
			await this.updateThread(input.threadId, { updatedAt: now() });
		},
		async truncateBranch(input) {
			const key = getKey(input.threadId, input.branchId);
			const current = state.messages.get(key) ?? [];
			const index = current.findIndex(
				(message) => message.id === input.messageId,
			);
			if (index === -1) {
				throw new Error(`Message not found: ${input.messageId}`);
			}
			state.messages.set(key, current.slice(0, index + 1));
			await this.updateThread(input.threadId, { updatedAt: now() });
		},
		async saveCheckpoint(checkpoint) {
			const key = getKey(checkpoint.threadId, checkpoint.branchId);
			const current = state.checkpoints.get(key) ?? [];
			state.checkpoints.set(key, [...current, checkpoint]);
		},
		async listCheckpoints(input) {
			return [
				...(state.checkpoints.get(getKey(input.threadId, input.branchId)) ??
					[]),
			];
		},
	};
}
