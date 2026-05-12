import { createClient } from "@libsql/client";
import type { AssistantStorage } from "@ultrapilot/core/storage";
import type {
	AssistantBranch,
	AssistantCheckpoint,
	AssistantMessage,
	AssistantThread,
} from "@ultrapilot/core/types";
import { SQLITE_SCHEMA } from "./schema";

type SqliteStorageOptions = {
	url: string;
};

function now() {
	return new Date().toISOString();
}

function createId() {
	return crypto.randomUUID();
}

async function migrateLegacyThreadIds(client: ReturnType<typeof createClient>) {
	const result = await client.execute("PRAGMA table_info(ultrapilot_threads)");
	if (result.rows.length === 0) {
		return;
	}

	const idColumn = result.rows.find((row) => String(row.name) === "id");
	if (String(idColumn?.type ?? "").toUpperCase() !== "TEXT") {
		return;
	}

	await client.executeMultiple(`
BEGIN;
ALTER TABLE ultrapilot_threads RENAME TO ultrapilot_threads_legacy;
CREATE TABLE ultrapilot_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_id TEXT UNIQUE,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  active_branch_id TEXT,
  metadata_json TEXT NOT NULL
);
INSERT INTO ultrapilot_threads
  (legacy_id, title, created_at, updated_at, active_branch_id, metadata_json)
SELECT
  id,
  title,
  created_at,
  updated_at,
  active_branch_id,
  metadata_json
FROM ultrapilot_threads_legacy
ORDER BY created_at ASC, id ASC;
UPDATE ultrapilot_branches
SET thread_id = (
  SELECT CAST(ultrapilot_threads.id AS TEXT)
  FROM ultrapilot_threads
  WHERE ultrapilot_threads.legacy_id = ultrapilot_branches.thread_id
);
UPDATE ultrapilot_messages
SET thread_id = (
  SELECT CAST(ultrapilot_threads.id AS TEXT)
  FROM ultrapilot_threads
  WHERE ultrapilot_threads.legacy_id = ultrapilot_messages.thread_id
);
UPDATE ultrapilot_checkpoints
SET thread_id = (
  SELECT CAST(ultrapilot_threads.id AS TEXT)
  FROM ultrapilot_threads
  WHERE ultrapilot_threads.legacy_id = ultrapilot_checkpoints.thread_id
);
DROP TABLE ultrapilot_threads_legacy;
COMMIT;
	`);
}

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string") {
		return fallback;
	}
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export function createSqliteStorage(
	options: SqliteStorageOptions,
): AssistantStorage {
	const client = createClient({ url: options.url });
	const ready = (async () => {
		await migrateLegacyThreadIds(client);
		await client.executeMultiple(SQLITE_SCHEMA);
	})();

	async function ensureReady() {
		await ready;
	}

	return {
		async createThread(input) {
			await ensureReady();
			const createdAt = now();
			const branchId = createId();
			const insertThreadResult = await client.execute(
				`INSERT INTO ultrapilot_threads
					(title, created_at, updated_at, active_branch_id, metadata_json)
				 VALUES (?, ?, ?, ?, ?)
				 RETURNING id`,
				[
					input.title ?? null,
					createdAt,
					createdAt,
					branchId,
					JSON.stringify(input.metadata ?? {}),
				],
			);
			const threadId = String(insertThreadResult.rows[0]?.id ?? "");
			if (!threadId) {
				throw new Error("Failed to create thread id");
			}
			await client.execute(
				`INSERT INTO ultrapilot_branches
					(id, thread_id, name, parent_branch_id, source_message_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[branchId, threadId, "main", null, null, createdAt, createdAt],
			);

			return {
				id: threadId,
				title: input.title ?? null,
				createdAt,
				updatedAt: createdAt,
				activeBranchId: branchId,
				metadata: input.metadata ?? {},
			};
		},
		async getThread(threadId) {
			await ensureReady();
			const result = await client.execute(
				"SELECT * FROM ultrapilot_threads WHERE id = ?",
				[threadId],
			);
			const row = result.rows[0];
			if (!row) {
				return null;
			}
			return {
				id: String(row.id),
				title: row.title == null ? null : String(row.title),
				createdAt: String(row.created_at),
				updatedAt: String(row.updated_at),
				activeBranchId:
					row.active_branch_id == null ? null : String(row.active_branch_id),
				metadata: parseJson(row.metadata_json, {}),
			} satisfies AssistantThread;
		},
		async listThreads() {
			await ensureReady();
			const result = await client.execute(
				"SELECT * FROM ultrapilot_threads ORDER BY updated_at DESC",
			);
			return result.rows.map(
				(row) =>
					({
						id: String(row.id),
						title: row.title == null ? null : String(row.title),
						createdAt: String(row.created_at),
						updatedAt: String(row.updated_at),
						activeBranchId:
							row.active_branch_id == null
								? null
								: String(row.active_branch_id),
						metadata: parseJson(row.metadata_json, {}),
					}) satisfies AssistantThread,
			);
		},
		async updateThread(threadId, patch) {
			await ensureReady();
			const current = await this.getThread(threadId);
			if (!current) {
				throw new Error(`Thread not found: ${threadId}`);
			}
			const updated: AssistantThread = {
				...current,
				...patch,
				id: current.id,
				updatedAt: patch.updatedAt ?? now(),
			};
			await client.execute(
				`UPDATE ultrapilot_threads
				 SET title = ?, updated_at = ?, active_branch_id = ?, metadata_json = ?
				 WHERE id = ?`,
				[
					updated.title,
					updated.updatedAt,
					updated.activeBranchId,
					JSON.stringify(updated.metadata),
					threadId,
				],
			);
			return updated;
		},
		async getBranch(threadId, branchId) {
			await ensureReady();
			const result = await client.execute(
				"SELECT * FROM ultrapilot_branches WHERE thread_id = ? AND id = ?",
				[threadId, branchId],
			);
			const row = result.rows[0];
			if (!row) {
				return null;
			}
			return {
				id: String(row.id),
				threadId: String(row.thread_id),
				name: String(row.name),
				parentBranchId:
					row.parent_branch_id == null ? null : String(row.parent_branch_id),
				sourceMessageId:
					row.source_message_id == null ? null : String(row.source_message_id),
				createdAt: String(row.created_at),
				updatedAt: String(row.updated_at),
			} satisfies AssistantBranch;
		},
		async listBranches(threadId) {
			await ensureReady();
			const result = await client.execute(
				"SELECT * FROM ultrapilot_branches WHERE thread_id = ? ORDER BY created_at ASC",
				[threadId],
			);
			return result.rows.map(
				(row) =>
					({
						id: String(row.id),
						threadId: String(row.thread_id),
						name: String(row.name),
						parentBranchId:
							row.parent_branch_id == null
								? null
								: String(row.parent_branch_id),
						sourceMessageId:
							row.source_message_id == null
								? null
								: String(row.source_message_id),
						createdAt: String(row.created_at),
						updatedAt: String(row.updated_at),
					}) satisfies AssistantBranch,
			);
		},
		async createBranch(input) {
			await ensureReady();
			const createdAt = now();
			const branchId = createId();
			await client.execute(
				`INSERT INTO ultrapilot_branches
					(id, thread_id, name, parent_branch_id, source_message_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					branchId,
					input.threadId,
					input.name ?? "branch",
					input.parentBranchId ?? null,
					input.sourceMessageId ?? null,
					createdAt,
					createdAt,
				],
			);
			if (input.messages?.length) {
				for (const message of input.messages) {
					await client.execute(
						`INSERT INTO ultrapilot_messages
							(id, thread_id, branch_id, role, created_at, parts_json, metadata_json)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
						[
							message.id,
							input.threadId,
							branchId,
							message.role,
							message.createdAt,
							JSON.stringify(message.parts),
							JSON.stringify(message.metadata),
						],
					);
				}
			}
			await this.updateThread(input.threadId, {
				activeBranchId: branchId,
				updatedAt: createdAt,
			});
			return {
				id: branchId,
				threadId: input.threadId,
				name: input.name ?? "branch",
				parentBranchId: input.parentBranchId ?? null,
				sourceMessageId: input.sourceMessageId ?? null,
				createdAt,
				updatedAt: createdAt,
			};
		},
		async getMessages(input) {
			await ensureReady();
			const result = await client.execute(
				`SELECT * FROM ultrapilot_messages
				 WHERE thread_id = ? AND branch_id = ?
				 ORDER BY created_at ASC`,
				[input.threadId, input.branchId],
			);
			return result.rows.map(
				(row) =>
					({
						id: String(row.id),
						threadId: String(row.thread_id),
						branchId: String(row.branch_id),
						role: row.role as AssistantMessage["role"],
						createdAt: String(row.created_at),
						parts: parseJson(row.parts_json, []),
						metadata: parseJson(row.metadata_json, {}),
					}) satisfies AssistantMessage,
			);
		},
		async appendMessages(input) {
			await ensureReady();
			for (const message of input.messages) {
				await client.execute(
					`INSERT OR REPLACE INTO ultrapilot_messages
						(id, thread_id, branch_id, role, created_at, parts_json, metadata_json)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[
						message.id,
						input.threadId,
						input.branchId,
						message.role,
						message.createdAt,
						JSON.stringify(message.parts),
						JSON.stringify(message.metadata),
					],
				);
			}
			await this.updateThread(input.threadId, { updatedAt: now() });
		},
		async truncateBranch(input) {
			await ensureReady();
			const messages = await this.getMessages(input);
			const message = messages.find((entry) => entry.id === input.messageId);
			if (!message) {
				throw new Error(`Message not found: ${input.messageId}`);
			}
			await client.execute(
				`DELETE FROM ultrapilot_messages
				 WHERE thread_id = ? AND branch_id = ? AND created_at > ?`,
				[input.threadId, input.branchId, message.createdAt],
			);
			await this.updateThread(input.threadId, { updatedAt: now() });
		},
		async saveCheckpoint(checkpoint) {
			await ensureReady();
			await client.execute(
				`INSERT OR REPLACE INTO ultrapilot_checkpoints
					(id, thread_id, branch_id, message_id, summary, created_at, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					checkpoint.id,
					checkpoint.threadId,
					checkpoint.branchId,
					checkpoint.messageId,
					checkpoint.summary,
					checkpoint.createdAt,
					JSON.stringify(checkpoint.metadata),
				],
			);
		},
		async listCheckpoints(input) {
			await ensureReady();
			const result = await client.execute(
				`SELECT * FROM ultrapilot_checkpoints
				 WHERE thread_id = ? AND branch_id = ?
				 ORDER BY created_at ASC`,
				[input.threadId, input.branchId],
			);
			return result.rows.map(
				(row) =>
					({
						id: String(row.id),
						threadId: String(row.thread_id),
						branchId: String(row.branch_id),
						messageId: String(row.message_id),
						summary: String(row.summary),
						createdAt: String(row.created_at),
						metadata: parseJson(row.metadata_json, {}),
					}) satisfies AssistantCheckpoint,
			);
		},
	};
}
