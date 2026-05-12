import { describe, expect, it } from "bun:test";
import {
	editAndRegenerateFromMessage,
	rerunFromMessage,
} from "../thread-message-actions";

describe("thread message actions", () => {
	it("truncates then replaces a message before regenerating", async () => {
		const calls: string[] = [];

		const result = await editAndRegenerateFromMessage({
			messageId: "message-1",
			text: "Updated prompt",
			truncateBranch: async (messageId) => {
				calls.push(`truncate:${messageId}`);
			},
			replaceMessageAndGenerate: async (messageId, text) => {
				calls.push(`replace:${messageId}:${text}`);
				return { ok: true };
			},
		});

		expect(calls).toEqual([
			"truncate:message-1",
			"replace:message-1:Updated prompt",
		]);
		expect(result).toEqual({ ok: true });
	});

	it("truncates then regenerates from the active branch", async () => {
		const calls: string[] = [];

		const result = await rerunFromMessage({
			messageId: "message-1",
			truncateBranch: async (messageId) => {
				calls.push(`truncate:${messageId}`);
			},
			regenerate: async () => {
				calls.push("regenerate");
				return { ok: true };
			},
		});

		expect(calls).toEqual(["truncate:message-1", "regenerate"]);
		expect(result).toEqual({ ok: true });
	});
});
