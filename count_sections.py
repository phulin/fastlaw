#!/usr/bin/env python3
import argparse
import os
import re


SECTION_HREF_RE = re.compile(r'href="#(sec_[^"\\s]+)"', re.IGNORECASE)


def count_sections_in_file(path):
    with open(path, "rb") as f:
        data = f.read().decode("utf-8", errors="ignore")
    section_ids = set(match.group(1) for match in SECTION_HREF_RE.finditer(data))
    return len(section_ids)


def main():
    parser = argparse.ArgumentParser(
        description="Count CT General Statutes sections across chapter files."
    )
    parser.add_argument(
        "--root",
        default="cga_mirror/current/pub",
        help="Root directory containing chapter HTML files.",
    )
    parser.add_argument(
        "--pattern",
        default="chap_*.htm",
        help="Glob pattern for chapter files (default: chap_*.htm).",
    )
    args = parser.parse_args()

    total = 0
    per_file = []

    for root, _, files in os.walk(args.root):
        for name in files:
            if not fnmatch(name, args.pattern):
                continue
            path = os.path.join(root, name)
            count = count_sections_in_file(path)
            per_file.append((path, count))
            total += count

    per_file.sort()
    for path, count in per_file:
        print(f"{count}\t{path}")
    print(f"TOTAL\t{total}")


def fnmatch(filename, pattern):
    # Minimal fnmatch to avoid importing the full module.
    # Supports "*" and "?" wildcards.
    if pattern == "*":
        return True
    regex = "^" + re.escape(pattern).replace(r"\*", ".*").replace(r"\?", ".") + "$"
    return re.match(regex, filename) is not None


if __name__ == "__main__":
    main()
