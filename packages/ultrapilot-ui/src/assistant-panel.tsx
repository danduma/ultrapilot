import type { AssistantMessage } from "@ultrapilot/core/types";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { ThreadList } from "./thread-list";

type ThreadItem = {
	id: string;
	title: string | null;
	updatedAt: string;
};

export function AssistantPanel({
	title,
	messages,
	threads,
	status,
	error,
	onSend,
	onSelectThread,
}: {
	title: string;
	messages: AssistantMessage[];
	threads: ThreadItem[];
	status: string;
	error: string | null;
	onSend: (text: string) => Promise<unknown> | unknown;
	onSelectThread: (threadId: string) => void;
}) {
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "280px 1fr",
				gap: 16,
				height: "100%",
			}}
		>
			<ThreadList threads={threads} onSelect={onSelectThread} />
			<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
				<div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
				{error ? <div style={{ color: "#b91c1c" }}>{error}</div> : null}
				<div style={{ color: "#6b7280", fontSize: 12 }}>Status: {status}</div>
				<MessageList messages={messages} />
				<Composer onSend={onSend} disabled={status !== "idle"} />
			</div>
		</div>
	);
}
