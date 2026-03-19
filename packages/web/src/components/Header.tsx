import type { JSX } from "solid-js";
import { Show } from "solid-js";

interface HeaderProps {
	heading?: string;
	rightContent?: JSX.Element;
}

export function Header(props: HeaderProps) {
	return (
		<header
			classList={{
				"site-header": true,
				"site-header-centered": !props.heading,
			}}
		>
			<div class="site-header-left">
				<a href="/" class="logo">
					fast.law
				</a>
			</div>
			<Show when={props.heading}>
				<h2 class="site-header-heading">{props.heading}</h2>
			</Show>
			<Show when={props.rightContent}>
				<div class="site-header-right">{props.rightContent}</div>
			</Show>
		</header>
	);
}
