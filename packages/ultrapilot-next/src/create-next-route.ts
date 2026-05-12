import type { AssistantMessage } from "@ultrapilot/core/types";

type ThreadLike = {
	id: string;
	title: string | null;
	activeBranchId: string | null;
	updatedAt?: string;
};

type BranchLike = {
	id: string;
	name: string;
};

type OperationLike = {
	thread: ThreadLike;
	branch: BranchLike | null;
	messages: AssistantMessage[];
	checkpoints?: unknown[];
};

type AssistantLike = {
	createThread(input?: {
		id?: string;
		title?: string | null;
		metadata?: Record<string, unknown>;
	}): Promise<ThreadLike>;
	getThread(threadId: string): Promise<ThreadLike | null>;
	getMessages(input: {
		threadId: string;
		branchId: string;
	}): Promise<AssistantMessage[]>;
	appendMessages(input: {
		threadId: string;
		branchId: string;
		messages: AssistantMessage[];
	}): Promise<OperationLike>;
	renameThread(threadId: string, title: string): Promise<ThreadLike>;
	generateStep(input: {
		threadId: string;
		branchId: string;
	}): Promise<OperationLike>;
	send(input: {
		threadId?: string;
		branchId?: string;
		text: string;
	}): Promise<OperationLike>;
	editMessage(input: {
		threadId: string;
		branchId: string;
		messageId: string;
		text: string;
	}): Promise<OperationLike>;
	forkBranch(input: {
		threadId: string;
		branchId: string;
		messageId?: string;
		name?: string;
	}): Promise<OperationLike>;
	truncateBranch(input: {
		threadId: string;
		branchId: string;
		messageId: string;
	}): Promise<OperationLike>;
	regenerate(input: {
		threadId: string;
		branchId: string;
	}): Promise<OperationLike>;
	listThreads(): Promise<ThreadLike[]>;
	listBranches(threadId: string): Promise<BranchLike[]>;
};

type CreateNextRouteOptions = {
	assistant: AssistantLike;
	resolveContext?: (request: Request) => Promise<Record<string, unknown>>;
};

type AppendAndGenerateBody = {
	action?: "append-and-generate";
	threadId?: string;
	branchId?: string;
	newMessages?: AssistantMessage[];
};

type MutationBody =
	| {
			action: "send";
			threadId?: string;
			branchId?: string;
			text: string;
	  }
	| {
			action: "edit-message";
			threadId: string;
			branchId: string;
			messageId: string;
			text: string;
	  }
	| {
			action: "fork-branch";
			threadId: string;
			branchId: string;
			messageId?: string;
			name?: string;
	  }
	| {
			action: "truncate-branch";
			threadId: string;
			branchId: string;
			messageId: string;
	  }
	| {
			action: "regenerate";
			threadId: string;
			branchId: string;
	  };

type RouteBody = AppendAndGenerateBody | MutationBody;

function json(body: unknown, status = 200) {
	return Response.json(body, { status });
}

async function appendAndGenerate(
	assistant: AssistantLike,
	body: AppendAndGenerateBody,
) {
	const existingThread =
		body.threadId != null ? await assistant.getThread(body.threadId) : null;
	const thread =
		existingThread ??
		(body.newMessages?.length
			? await assistant.createThread(
					body.threadId ? { id: body.threadId } : undefined,
				)
			: null);
	const threadId =
		thread?.id ?? body.threadId ?? body.newMessages?.[0]?.threadId;
	const branchId =
		body.branchId ?? thread?.activeBranchId ?? body.newMessages?.[0]?.branchId;

	if (!threadId || !branchId) {
		throw new Error(
			"threadId and branchId are required for append-and-generate",
		);
	}

	if (body.newMessages?.length) {
		const normalizedMessages = body.newMessages.map((message) => ({
			...message,
			threadId,
			branchId,
		}));
		await assistant.appendMessages({
			threadId,
			branchId,
			messages: normalizedMessages,
		});
		for (const message of normalizedMessages) {
			for (const part of message.parts) {
				if (
					part.type === "tool-result" &&
					part.toolName === "set_conversation_title" &&
					!part.isError &&
					typeof part.result === "object" &&
					part.result !== null &&
					"title" in part.result
				) {
					const title = (part.result as Record<string, unknown>).title;
					if (typeof title === "string" && title.length > 0) {
						await assistant.renameThread(threadId, title);
					}
				}
			}
		}
	}

	return assistant.generateStep({ threadId, branchId });
}

export function createNextRoute(options: CreateNextRouteOptions) {
	async function POST(request: Request) {
		await options.resolveContext?.(request);
		const body = (await request.json()) as RouteBody;

		try {
			if (body.action === "send") {
				return json(
					await options.assistant.send({
						threadId: body.threadId,
						branchId: body.branchId,
						text: body.text,
					}),
				);
			}
			if (body.action === "edit-message") {
				return json(await options.assistant.editMessage(body));
			}
			if (body.action === "fork-branch") {
				return json(await options.assistant.forkBranch(body));
			}
			if (body.action === "truncate-branch") {
				return json(await options.assistant.truncateBranch(body));
			}
			if (body.action === "regenerate") {
				return json(await options.assistant.regenerate(body));
			}

			return json(
				await appendAndGenerate(
					options.assistant,
					body as AppendAndGenerateBody,
				),
			);
		} catch (error) {
			return json(
				{
					error:
						error instanceof Error
							? error.message
							: "Ultrapilot request failed",
				},
				500,
			);
		}
	}

	async function GET(request: Request) {
		await options.resolveContext?.(request);
		const { searchParams } = new URL(request.url);
		const threadId = searchParams.get("threadId");
		if (!threadId) {
			return json({ error: "threadId is required" }, 400);
		}
		const thread = await options.assistant.getThread(threadId);
		if (!thread) {
			return json({ error: "thread not found" }, 404);
		}
		const branchId = searchParams.get("branchId") ?? thread.activeBranchId;
		if (!branchId) {
			return json({ thread, branch: null, messages: [] });
		}
		const branches = await options.assistant.listBranches(threadId);
		const branch = branches.find((entry) => entry.id === branchId) ?? null;
		const messages = await options.assistant.getMessages({
			threadId,
			branchId,
		});
		return json({ thread, branch, messages });
	}

	return { POST, GET };
}

export function createThreadHistoryHandler(options: {
	assistant: AssistantLike;
	resolveContext?: (request: Request) => Promise<Record<string, unknown>>;
}) {
	return async function GET(request: Request) {
		await options.resolveContext?.(request);
		const threads = await options.assistant.listThreads();
		const history = await Promise.all(
			threads.map(async (thread) => {
				const branchId = thread.activeBranchId;
				const messages = branchId
					? await options.assistant.getMessages({
							threadId: thread.id,
							branchId,
						})
					: [];
				return {
					...thread,
					messages,
				};
			}),
		);
		return json({ history });
	};
}
