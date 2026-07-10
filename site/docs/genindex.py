#!/usr/bin/env python3
"""Regenerate docs-index.json (client-side search index for docs.js).

Run from site/docs/ after adding or editing any docs page:

    python3 genindex.py

The page list below is the sidebar order — keep it in sync with the
sidebar nav in every docs page and with prev/next pagination.
"""
import json
import re
import html

ORDER = [
    "quickstart.html",
    "onboard-your-repo.html",
    "k8s-attach.html",
    "ci.html",
    "headless-agents.html",
    "manifest.html",
    "configuration.html",
    "cli.html",
    "evidence-format.html",
    "spec.html",
    "proof-ladder.html",
    "evidence.html",
]


def index_page(path):
    src = open(path).read()
    title = re.search(r"<title>(.*?)(?: · Proofbench docs)?</title>", src).group(1)
    heads = [
        html.unescape(re.sub(r"<[^>]+>", "", h)).strip()
        for h in re.findall(r"<h[23][^>]*>(.*?)</h[23]>", src, re.S)
    ]
    body = re.search(
        r'<main id="content".*?>(.*?)</main>',
        re.sub(r"<script.*?</script>", "", src, flags=re.S),
        re.S,
    )
    words = set()
    if body:
        text = html.unescape(re.sub(r"<[^>]+>", " ", body.group(1))).lower()
        words = set(re.findall(r"[a-z][a-z0-9_.\-]{2,}", text))
    return {
        "href": path,
        "title": html.unescape(title),
        "headings": heads,
        "keywords": " ".join(sorted(words)),
    }


if __name__ == "__main__":
    pages = [index_page(f) for f in ORDER]
    json.dump(pages, open("docs-index.json", "w"))
    total = sum(len(p["keywords"].split()) for p in pages)
    print(f"docs-index.json: {len(pages)} pages, {total} unique words")
