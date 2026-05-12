type ThreadItem = {
	id: string;
	title: string | null;
	updatedAt: string;
};

export function ThreadList({
	threads,
	onSelect,
}: {
	threads: ThreadItem[];
	onSelect: (threadId: string) => void;
}) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			{threads.map((thread) => (
				<button
					key={thread.id}
					type="button"
					onClick={() => onSelect(thread.id)}
					style={{
						textAlign: "left",
						border: "1px solid #e5e7eb",
						borderRadius: 10,
						padding: 10,
						background: "#fff",
					}}
				>
					<div style={{ fontWeight: 600 }}>
						{thread.title ?? "New conversation"}
					</div>
					<div style={{ fontSize: 12, color: "#6b7280" }}>
						{thread.updatedAt}
					</div>
				</button>
			))}
		</div>
	);
}
