import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "bun:test";
import { createSqliteStorage } from "../sqlite-storage";

describe("sqlite storage", () => {
	it("creates and lists threads", async () => {
		const storage = createSqliteStorage({ url: "file::memory:" });

		const thread = await storage.createThread({ title: "First thread" });
		const threads = await storage.listThreads();

		expect(thread.title).toBe("First thread");
		expect(threads).toHaveLength(1);
		expect(threads[0]?.id).toBe(thread.id);
	});

	it("ignores caller supplied thread ids and uses numeric autoincrement ids", async () => {
		const storage = createSqliteStorage({ url: "file::memory:" });

		const firstThread = await storage.createThread({
			id: "pending-thread",
			title: "First thread",
		});
		const secondThread = await storage.createThread({
			id: "another-client-value",
			title: "Second thread",
		});

		expect(firstThread.id).toBe("1");
		expect(secondThread.id).toBe("2");
	});

	it("migrates legacy text thread ids to numeric ids for existing databases", async () => {
		const tempDir = await mkdtemp(path.join(tmpdir(), "ultrapilot-sqlite-"));
		const databaseUrl = pathToFileURL(path.join(tempDir, "legacy.db")).toString();
		const client = createClient({ url: databaseUrl });

		try {
			await client.executeMultiple(`
CREATE TABLE ultrapilot_threads (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  active_branch_id TEXT,
  metadata_json TEXT NOT NULL
);
CREATE TABLE ultrapilot_branches (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_branch_id TEXT,
  source_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE ultrapilot_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE TABLE ultrapilot_checkpoints (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
			`);
			await client.execute(
				`INSERT INTO ultrapilot_threads
					(id, title, created_at, updated_at, active_branch_id, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[
					"pending-thread",
					"Legacy thread",
					"2026-04-21T00:00:00.000Z",
					"2026-04-21T00:00:00.000Z",
					"branch-1",
					"{}",
				],
			);
			await client.execute(
				`INSERT INTO ultrapilot_branches
					(id, thread_id, name, parent_branch_id, source_message_id, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"branch-1",
					"pending-thread",
					"main",
					null,
					null,
					"2026-04-21T00:00:00.000Z",
					"2026-04-21T00:00:00.000Z",
				],
			);
			await client.execute(
				`INSERT INTO ultrapilot_messages
					(id, thread_id, branch_id, role, created_at, parts_json, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					"message-1",
					"pending-thread",
					"branch-1",
					"user",
					"2026-04-21T00:00:00.000Z",
					'[{"type":"text","text":"Legacy message"}]',
					"{}",
				],
			);

			const storage = createSqliteStorage({ url: databaseUrl });
			const threads = await storage.listThreads();
			const branch = await storage.getBranch("1", "branch-1");
			const messages = await storage.getMessages({
				threadId: "1",
				branchId: "branch-1",
			});
			const nextThread = await storage.createThread({ title: "Next thread" });

			expect(threads[0]?.id).toBe("1");
			expect(threads[0]?.title).toBe("Legacy thread");
			expect(branch?.threadId).toBe("1");
			expect(messages[0]?.threadId).toBe("1");
			expect(nextThread.id).toBe("2");
		} finally {
			client.close();
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("appends messages and reconstructs branch state", async () => {
		const storage = createSqliteStorage({ url: "file::memory:" });
		const thread = await storage.createThread({ title: "History" });
		if (!thread.activeBranchId) {
			throw new Error("Expected the thread to create an active branch");
		}
		const branch = await storage.getBranch(thread.id, thread.activeBranchId);
		expect(branch).toBeDefined();
		if (!branch) {
			throw new Error("Expected the branch to exist");
		}

		await storage.appendMessages({
			threadId: thread.id,
			branchId: branch.id,
			messages: [
				{
					id: "message-1",
					threadId: thread.id,
					branchId: branch.id,
					role: "user",
					createdAt: new Date().toISOString(),
					parts: [{ type: "text", text: "Hello" }],
					metadata: {},
				},
			],
		});

		const messages = await storage.getMessages({
			threadId: thread.id,
			branchId: branch.id,
		});

		expect(messages).toHaveLength(1);
		expect(messages[0]?.parts[0]).toEqual({ type: "text", text: "Hello" });
	});

	it("creates branches and stores checkpoints", async () => {
		const storage = createSqliteStorage({ url: "file::memory:" });
		const thread = await storage.createThread({ title: "Branching" });
		if (!thread.activeBranchId) {
			throw new Error("Expected the thread to create an active branch");
		}
		const mainBranch = await storage.getBranch(
			thread.id,
			thread.activeBranchId,
		);
		if (!mainBranch) {
			throw new Error("Expected the main branch to exist");
		}
		const branch = await storage.createBranch({
			threadId: thread.id,
			parentBranchId: mainBranch.id,
			sourceMessageId: null,
			name: "forked",
		});

		await storage.saveCheckpoint({
			id: "checkpoint-1",
			threadId: thread.id,
			branchId: branch.id,
			messageId: "message-1",
			summary: "Previous context",
			createdAt: new Date().toISOString(),
			metadata: {},
		});

		const branches = await storage.listBranches(thread.id);
		const checkpoints = await storage.listCheckpoints({
			threadId: thread.id,
			branchId: branch.id,
		});

		expect(branches).toHaveLength(2);
		expect(checkpoints[0]?.summary).toBe("Previous context");
	});
});
