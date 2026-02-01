import { A } from "@solidjs/router";

export function Header() {
	return (
		<header class="site-header">
			<A href="/" class="logo">
				FastLaw
			</A>
			<nav class="nav">
				<A href="/#method">Method</A>
				<A href="/#data">Data</A>
				<A href="/search">Search</A>
				<A href="/statutes/cgs">Titles</A>
			</nav>
		</header>
	);
}
