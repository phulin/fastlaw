import { Title } from "@solidjs/meta";
import { Footer } from "~/components/Footer";
import { Header } from "~/components/Header";

interface NotFoundPageProps {
	pathname: string;
}

export default function NotFoundPage(props: NotFoundPageProps) {
	return (
		<>
			<Title>404 - fast.law</Title>
			<Header />
			<main class="not-found-page">
				<section class="section-heading">
					<p class="eyebrow">404</p>
					<h1>Page not found</h1>
					<p class="lead">
						No page exists at <code>{props.pathname}</code>.
					</p>
				</section>
				<section class="not-found-actions">
					<a class="button" href="/">
						Back home
					</a>
					<a class="button ghost" href="/search">
						Open search
					</a>
					<a class="button ghost" href="/statutes/cgs">
						Browse statutes
					</a>
				</section>
			</main>
			<Footer />
		</>
	);
}
