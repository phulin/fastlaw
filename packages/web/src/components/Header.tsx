import type { JSX } from "solid-js";
import { Show } from "solid-js";

interface HeaderProps {
	heading?: string;
	rightContent?: JSX.Element;
}

export function Header(props: HeaderProps) {
	return (
		<header class="site-header">
			<div class="site-header-left">
				<a href="/" class="logo">
					fast.law
				</a>
			</div>
			<Show when={props.heading}>
				<h2 class="site-header-heading">{props.heading}</h2>
			</Show>
			<div class="site-header-right">
				<Show
					when={props.rightContent}
					fallback={
						<nav class="nav">
							<a href="/statutes/cgs">CGA</a>
							<a href="/statutes/usc">USC</a>
							<a href="/ingest/jobs">Ingest</a>
						</nav>
					}
				>
					{props.rightContent}
				</Show>
			</div>
		</header>
	);
}
