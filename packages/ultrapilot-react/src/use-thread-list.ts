"use client";

import { useCallback, useEffect, useState } from "react";

type ThreadHistoryEntry = {
	id: string;
	title: string | null;
	updatedAt: string;
	messages: Array<{ parts?: unknown[] }>;
};

export function useThreadList(historyApi: string) {
	const [threads, setThreads] = useState<ThreadHistoryEntry[]>([]);
	const [loading, setLoading] = useState(false);

	const reload = useCallback(async () => {
		setLoading(true);
		try {
			const response = await fetch(historyApi);
			const data = (await response.json()) as {
				history?: ThreadHistoryEntry[];
			};
			setThreads(data.history ?? []);
		} finally {
			setLoading(false);
		}
	}, [historyApi]);

	useEffect(() => {
		void reload();
	}, [reload]);

	return { threads, loading, reload };
}
