#!/usr/bin/env python3
import argparse
import html.parser
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request


BASE_URL = "https://www.cga.ct.gov"
START_URL = "https://www.cga.ct.gov/current/pub/titles.htm"
ALLOWED_PREFIX = "/current/pub/"


class LinkParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        for key, value in attrs:
            if key == "href" and value:
                self.links.append(value)


def fetch_url(url, timeout=20, ssl_context=None):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "cga-statutes-mirror/1.0"},
    )
    with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as resp:
        return resp.read()


def normalize_link(href, base_url):
    if href.startswith("mailto:") or href.startswith("javascript:"):
        return None
    full_url = urllib.parse.urljoin(base_url, href)
    parsed = urllib.parse.urlparse(full_url)
    if parsed.scheme not in {"http", "https"}:
        return None
    if parsed.netloc != urllib.parse.urlparse(BASE_URL).netloc:
        return None
    if not parsed.path.startswith(ALLOWED_PREFIX):
        return None
    # Strip fragment to avoid duplicate fetches.
    clean = parsed._replace(fragment="").geturl()
    return clean


def local_path_for_url(url, out_dir):
    parsed = urllib.parse.urlparse(url)
    rel_path = parsed.path.lstrip("/")
    if rel_path.endswith("/"):
        rel_path = os.path.join(rel_path, "index.html")
    return os.path.join(out_dir, rel_path)


def ensure_parent_dir(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)


def parse_links(html_bytes, base_url):
    parser = LinkParser()
    try:
        parser.feed(html_bytes.decode("utf-8", errors="ignore"))
    except html.parser.HTMLParseError:
        return []
    links = []
    for href in parser.links:
        normalized = normalize_link(href, base_url)
        if normalized:
            links.append(normalized)
    return links


def crawl(start_url, out_dir, delay=0.5, ssl_context=None):
    seen = set()
    queue = [start_url]

    while queue:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)

        try:
            content = fetch_url(url, ssl_context=ssl_context)
        except urllib.error.URLError as exc:
            print(f"Failed to fetch {url}: {exc}")
            continue

        dest_path = local_path_for_url(url, out_dir)
        ensure_parent_dir(dest_path)
        with open(dest_path, "wb") as f:
            f.write(content)
        print(f"Saved {url} -> {dest_path}")

        links = parse_links(content, url)
        for link in links:
            if link not in seen:
                queue.append(link)

        time.sleep(delay)


def main():
    parser = argparse.ArgumentParser(
        description="Mirror Connecticut General Statutes HTML pages."
    )
    parser.add_argument(
        "--out",
        default="cga_mirror",
        help="Output directory for the mirrored files.",
    )
    parser.add_argument(
        "--start",
        default=START_URL,
        help="Start URL for crawl (default: titles.htm).",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.5,
        help="Delay in seconds between requests.",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable TLS certificate verification.",
    )
    args = parser.parse_args()

    ssl_context = None
    if args.insecure:
        ssl_context = ssl._create_unverified_context()

    crawl(args.start, args.out, delay=args.delay, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
