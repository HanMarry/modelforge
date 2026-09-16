#!/usr/bin/env python3
"""双引擎真实文献检索与 BibTeX 生成（OpenAlex + Crossref，仅标准库，无需 API key）。

子命令：
  search  并行查询 OpenAlex 与 Crossref，按 DOI / 标题交叉验证后融合输出候选文献
  bib     按 DOI 从 doi.org / Crossref 反查权威 BibTeX 条目（禁止手写 bib 的替代品）
  verify  按 DOI 拉取权威元数据，供引用前核对作者 / 题名 / 年份 / 期刊

示例：
  python paper_search.py search --query "robust optimization vehicle routing" --limit 8
  python paper_search.py bib --doi 10.1287/opre.1030.0065 --key ref01
  python paper_search.py verify --doi 10.1287/opre.1030.0065
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

MAILTO = os.environ.get("PAPER_SEARCH_MAILTO", "paper-search@mathmodel.local")
USER_AGENT = f"mathmodel-paper-search/1.0 (mailto:{MAILTO})"
TIMEOUT = 20

STOPWORDS = {
    "a", "an", "the", "of", "for", "and", "or", "in", "on", "with", "based",
    "using", "via", "to", "by", "from", "at", "is", "are", "its",
}


def http_get(url: str, accept: str = "application/json") -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    last_err = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read()
        except urllib.error.HTTPError as err:
            if err.code in (429, 500, 502, 503) and attempt == 0:
                last_err = err
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as err:
            last_err = err
    raise last_err


def norm_doi(doi):
    if not doi:
        return None
    doi = doi.strip().lower()
    doi = re.sub(r"^https?://(dx\.)?doi\.org/", "", doi)
    return doi or None


def norm_title(title: str) -> str:
    return re.sub(r"[^a-z0-9一-鿿]+", "", title.lower())


def query_terms(query: str):
    terms = [t.lower() for t in re.findall(r"[A-Za-z0-9\-]{2,}|[一-鿿]{2,}", query)]
    return [t for t in terms if t not in STOPWORDS]


# ---------- 引擎 1：OpenAlex ----------

def search_openalex(query: str, limit: int, year_from, year_to):
    filters = []
    if year_from:
        filters.append(f"from_publication_date:{year_from}-01-01")
    if year_to:
        filters.append(f"to_publication_date:{year_to}-12-31")
    params = {
        "search": query,
        "per-page": str(min(limit * 2, 50)),
        "mailto": MAILTO,
        "select": "doi,title,display_name,publication_year,cited_by_count,authorships,primary_location,type",
    }
    if filters:
        params["filter"] = ",".join(filters)
    url = "https://api.openalex.org/works?" + urllib.parse.urlencode(params)
    data = json.loads(http_get(url))
    papers = []
    for w in data.get("results", []):
        title = w.get("title") or w.get("display_name") or ""
        if not title:
            continue
        authors = [
            a.get("author", {}).get("display_name", "")
            for a in (w.get("authorships") or [])[:8]
        ]
        venue = ((w.get("primary_location") or {}).get("source") or {}).get("display_name") or ""
        papers.append({
            "title": title,
            "authors": [a for a in authors if a],
            "year": w.get("publication_year"),
            "venue": venue,
            "doi": norm_doi(w.get("doi")),
            "citations": w.get("cited_by_count") or 0,
            "type": w.get("type") or "",
            "sources": ["openalex"],
        })
    return papers


# ---------- 引擎 2：Crossref ----------

def search_crossref(query: str, limit: int, year_from, year_to):
    filters = []
    if year_from:
        filters.append(f"from-pub-date:{year_from}-01-01")
    if year_to:
        filters.append(f"until-pub-date:{year_to}-12-31")
    params = {
        "query.bibliographic": query,
        "rows": str(min(limit * 2, 50)),
        "mailto": MAILTO,
        "select": "DOI,title,author,issued,container-title,is-referenced-by-count,type",
    }
    if filters:
        params["filter"] = ",".join(filters)
    url = "https://api.crossref.org/works?" + urllib.parse.urlencode(params)
    data = json.loads(http_get(url))
    papers = []
    for w in data.get("message", {}).get("items", []):
        titles = w.get("title") or []
        if not titles:
            continue
        authors = [
            " ".join(filter(None, [a.get("given"), a.get("family")]))
            for a in (w.get("author") or [])[:8]
        ]
        issued = ((w.get("issued") or {}).get("date-parts") or [[None]])[0]
        venue = (w.get("container-title") or [""])[0]
        papers.append({
            "title": titles[0],
            "authors": [a for a in authors if a],
            "year": issued[0] if issued else None,
            "venue": venue,
            "doi": norm_doi(w.get("DOI")),
            "citations": w.get("is-referenced-by-count") or 0,
            "type": w.get("type") or "",
            "sources": ["crossref"],
        })
    return papers


# ---------- 融合 / 过滤 ----------

def merge_papers(openalex, crossref):
    merged = []
    by_doi = {}
    by_title = {}
    for p in openalex + crossref:
        key = p["doi"]
        hit = by_doi.get(key) if key else None
        if hit is None:
            tkey = (norm_title(p["title"]), p["year"])
            hit = by_title.get(tkey)
        if hit:
            for s in p["sources"]:
                if s not in hit["sources"]:
                    hit["sources"].append(s)
            hit["citations"] = max(hit["citations"], p["citations"])
            # 补全字段：优先保留信息更完整的一侧
            for field in ("doi", "venue", "year"):
                if not hit.get(field) and p.get(field):
                    hit[field] = p[field]
            if len(p["authors"]) > len(hit["authors"]):
                hit["authors"] = p["authors"]
            continue
        merged.append(p)
        if key:
            by_doi[key] = p
        by_title[(norm_title(p["title"]), p["year"])] = p
    for p in merged:
        p["cross_validated"] = len(p["sources"]) >= 2
    return merged


def coverage_filter(papers, query: str):
    terms = query_terms(query)
    if not terms:
        return papers
    need = min(2, len(terms))
    kept = []
    for p in papers:
        haystack = " ".join([p["title"], p["venue"], " ".join(p["authors"])]).lower()
        hits = sum(1 for t in terms if t in haystack)
        if hits >= need:
            p["term_hits"] = hits
            kept.append(p)
    return kept


def cmd_search(args):
    engines = []
    if not args.crossref_only:
        engines.append(("openalex", search_openalex))
    if not args.openalex_only:
        engines.append(("crossref", search_crossref))
    results, errors = [], []
    for name, fn in engines:
        try:
            results.append(fn(args.query, args.limit, args.year_from, args.year_to))
        except Exception as err:  # noqa: BLE001 —— 单引擎失败降级为另一引擎
            results.append([])
            errors.append(f"{name}: {err}")
    for e in errors:
        print(f"[warn] 引擎失败 {e}", file=sys.stderr)
    if all(not r for r in results):
        print("[error] 所有引擎均失败或无结果；不要据此编造文献。", file=sys.stderr)
        sys.exit(1)
    merged = merge_papers(results[0] if len(results) > 0 else [], results[1] if len(results) > 1 else [])
    filtered = coverage_filter(merged, args.query)
    if not filtered:
        print("[warn] 查询词覆盖率过滤后无结果，输出未过滤候选；请人工判断相关性。", file=sys.stderr)
        filtered = merged
    filtered.sort(key=lambda p: (p["cross_validated"], p.get("term_hits", 0), p["citations"]), reverse=True)
    filtered = filtered[: args.limit]
    if args.json:
        print(json.dumps(filtered, ensure_ascii=False, indent=2))
        return
    for i, p in enumerate(filtered, 1):
        mark = "✓交叉验证" if p["cross_validated"] else "/".join(p["sources"])
        authors = ", ".join(p["authors"][:3]) + (" et al." if len(p["authors"]) > 3 else "")
        print(f"{i}. [{mark}] {p['title']}")
        print(f"   {authors} ({p['year']}) — {p['venue'] or '(未知来源)'} — 被引 {p['citations']}")
        print(f"   DOI: {p['doi'] or '(无 DOI，引用前必须另行核验)'}")


# ---------- BibTeX / 核验 ----------

def fetch_bibtex(doi: str) -> str:
    doi = norm_doi(doi)
    try:
        raw = http_get(f"https://doi.org/{urllib.parse.quote(doi)}", accept="application/x-bibtex")
    except Exception:
        raw = http_get(
            f"https://api.crossref.org/works/{urllib.parse.quote(doi)}/transform/application/x-bibtex",
            accept="application/x-bibtex",
        )
    return raw.decode("utf-8", errors="replace").strip()


def cmd_bib(args):
    try:
        entry = fetch_bibtex(args.doi)
    except urllib.error.HTTPError as err:
        if err.code == 404:
            print(f"[error] DOI 不存在：{args.doi}。该文献可能是编造的，禁止引用。", file=sys.stderr)
        else:
            print(f"[error] 获取 BibTeX 失败（HTTP {err.code}）：{args.doi}", file=sys.stderr)
        sys.exit(1)
    if args.key:
        entry = re.sub(r"^(@\w+\{)[^,]+,", rf"\g<1>{args.key},", entry, count=1)
    print(entry)


def cmd_verify(args):
    doi = norm_doi(args.doi)
    try:
        data = json.loads(http_get(f"https://api.crossref.org/works/{urllib.parse.quote(doi)}"))
        w = data["message"]
        info = {
            "doi": doi,
            "title": (w.get("title") or [""])[0],
            "authors": [
                " ".join(filter(None, [a.get("given"), a.get("family")]))
                for a in (w.get("author") or [])
            ],
            "year": ((w.get("issued") or {}).get("date-parts") or [[None]])[0][0],
            "venue": (w.get("container-title") or [""])[0],
            "volume": w.get("volume"),
            "issue": w.get("issue"),
            "pages": w.get("page"),
            "publisher": w.get("publisher"),
            "url": f"https://doi.org/{doi}",
        }
    except urllib.error.HTTPError as err:
        if err.code == 404:
            print(f"[error] Crossref 无此 DOI：{doi}。禁止引用未核验文献。", file=sys.stderr)
            sys.exit(1)
        raise
    print(json.dumps(info, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_search = sub.add_parser("search", help="双引擎检索候选文献")
    p_search.add_argument("--query", required=True)
    p_search.add_argument("--limit", type=int, default=10)
    p_search.add_argument("--year-from", type=int, default=None)
    p_search.add_argument("--year-to", type=int, default=None)
    p_search.add_argument("--json", action="store_true")
    p_search.add_argument("--openalex-only", action="store_true", help="仅诊断用")
    p_search.add_argument("--crossref-only", action="store_true", help="仅诊断用")
    p_search.set_defaults(fn=cmd_search)

    p_bib = sub.add_parser("bib", help="按 DOI 反查权威 BibTeX")
    p_bib.add_argument("--doi", required=True)
    p_bib.add_argument("--key", default=None, help="替换生成条目的引用 key")
    p_bib.set_defaults(fn=cmd_bib)

    p_verify = sub.add_parser("verify", help="按 DOI 核对元数据")
    p_verify.add_argument("--doi", required=True)
    p_verify.set_defaults(fn=cmd_verify)

    args = parser.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
