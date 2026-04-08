import { useEffect, useRef, useState } from "react";

interface SearchResult {
	url: string;
	title: string;
	excerpt: string;
}

export default function Search() {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SearchResult[]>([]);
	const [isOpen, setIsOpen] = useState(false);
	// biome-ignore lint/suspicious/noExplicitAny: Pagefind has no published types
	const pagefindRef = useRef<any>(null);

	useEffect(() => {
		async function loadPagefind() {
			if (typeof window === "undefined") return;
			try {
				// Dynamic import with string concat to prevent Vite from bundling
				// Pagefind files only exist in dist/ after build
				const pagefindPath = "/pagefind/pagefind.js";
				pagefindRef.current = await import(/* @vite-ignore */ pagefindPath);
				await pagefindRef.current.init();
			} catch {
				// Pagefind not available (dev mode) — search silently disabled
			}
		}
		loadPagefind();
	}, []);

	async function handleSearch(value: string) {
		setQuery(value);
		if (!value.trim() || !pagefindRef.current) {
			setResults([]);
			return;
		}
		const search = await pagefindRef.current.search(value);
		const loaded = await Promise.all(
			// biome-ignore lint/suspicious/noExplicitAny: Pagefind result type is untyped
			search.results.slice(0, 8).map((r: any) => r.data()),
		);
		setResults(
			// biome-ignore lint/suspicious/noExplicitAny: Pagefind data type is untyped
			loaded.map((r: any) => ({
				url: r.url,
				title: r.meta?.title || r.url,
				excerpt: r.excerpt,
			})),
		);
	}

	return (
		<div data-search>
			<input
				type="search"
				placeholder="Search..."
				value={query}
				onChange={(e) => handleSearch(e.target.value)}
				onFocus={() => setIsOpen(true)}
				onBlur={() => setTimeout(() => setIsOpen(false), 200)}
			/>
			{isOpen && results.length > 0 && (
				<ul data-search-results>
					{results.map((r) => (
						<li key={r.url}>
							<a href={r.url}>
								<strong>{r.title}</strong>
								{/* biome-ignore lint/security/noDangerouslySetInnerHtml: Pagefind excerpts contain safe highlighted HTML */}
								<span dangerouslySetInnerHTML={{ __html: r.excerpt }} />
							</a>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
