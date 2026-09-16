---
name: citations-and-references
description: 查找真实文献、核验其存在并按规范排版引用。当需要写参考文献、整理 book.bib、核对引用格式，或用户说"文献""引用""参考文献格式""BibTeX"时使用。核心纪律：绝不凭记忆写引用，DOI 逐个验证，GB/T 7714 与 IEEE 格式，引用与列表双向核对。
---

# Citations and References

Use this skill for the 参考文献 section and in-text citations. The governing rule:
**every reference must be real, retrievable, and actually support the sentence it is
attached to.** Fabricated citations are the single most damaging error in these papers.

## Step 1 — Never write a reference from memory

Language models produce plausible-looking citations that do not exist. For every
reference:

1. Search it (`paper-search` covers OpenAlex and Crossref, both keyless).
2. Confirm the **DOI resolves** and the metadata matches what you claim.
3. Record title, authors, venue, year, and DOI from the retrieved record.

```bash
curl -s "https://api.crossref.org/works/10.1016/j.ejor.2019.06.017" \
  | python -c "import json,sys; m=json.load(sys.stdin)['message']; print(m['title'][0], m['author'][0]['family'], m['container-title'][0], m['issued']['date-parts'][0][0])"
```

If a search returns nothing that supports the claim, **change the claim** — do not invent
a source.

## Step 2 — Cite the right kind of source

| Claim | Cite |
|---|---|
| a standard method you applied | the original method paper, not a textbook blog |
| a specific numerical value you reuse | the source of that value, with the table/page |
| a general statement of fact | a review or textbook |
| a competitor's approach | their paper, accurately described |
| software you used | the software's own citation (many publish one) |

Prefer **primary sources**. A blog post is not a citation for a method; it may be a pointer
to one. Do not cite a source you have not at least read the abstract of.

## Step 3 — Place citations where they belong

- Citation goes **immediately after the claim**, before the full stop: `... 如文献[3]所述。`
- One citation per specific claim; do not attach five references to one vague sentence.
- Do not cite for common knowledge ("线性规划由 Dantzig 提出" needs no citation in a
  modelling paper, though the method's original paper is fine to cite).
- Never cite a source for a result **you** produced.
- Every reference in the list must be cited in the text. Every in-text citation must be in
  the list.

## Step 4 — Format consistently

**Chinese contests (GB/T 7714)**

```bibtex
@article{zhang2023,
  author  = {张三 and 李四},
  title   = {基于改进遗传算法的选址优化},
  journal = {系统工程理论与实践},
  year    = {2023},
  volume  = {43},
  number  = {5},
  pages   = {1201--1212},
  doi     = {10.12011/SETP2022-1234}
}
```

Rendered:

```
[1] 张三, 李四. 基于改进遗传算法的选址优化[J]. 系统工程理论与实践, 2023, 43(5): 1201-1212.
```

**English venues (IEEE / numeric)**

```
[2] J. Smith, A. Lee, "Robust optimisation of facility location," European Journal of
    Operational Research, vol. 275, no. 3, pp. 812-825, 2019.
```

Rules that apply to both:

- consistent author format throughout (all names or `et al.` after n — pick one);
- consistent venue style (full journal name or standard abbreviation — pick one);
- page ranges with an en dash and no repeated prefix where the style says so;
- DOI or stable URL for everything retrieved online;
- sorted by citation order (numeric styles) or alphabetically (author–year) — never mixed.

Use the teX template's `\bibliographystyle` where one is provided: the CUMCM template
ships `gbt7714-numerical`, which expects a `refs.bib` and produces GB/T 7714 output — let
it do the formatting rather than hand-writing the list.

## Step 5 — Keep the BibTeX clean

- **Keys** meaningful and unique: `authorYearKeyword`, never `ref1`, `temp2`.
- **Fields** complete: an entry with no year or venue is a red flag to a reviewer.
- **Escape correctly**: `&` and `%` need escaping in BibTeX; Chinese in `bibtex` needs the
  right encoding, so prefer `biblatex` + `biber` or a UTF-8 aware toolchain.
- **No duplicate entries** for the same work under different keys — check before building.
- Use the entry type that matches the item (`@article`, `@inproceedings`, `@book`,
  `@misc` for software/reports with a URL and access date).

## Step 6 — Verify the list mechanically

Before submitting:

1. Extract every DOI from the `.bib` and check each resolves (a script over the file is
   enough).
2. Build the PDF and confirm there are **no undefined-reference warnings**.
3. Diff the cited keys against the entries: no orphans, no missing.
4. Confirm the citation **order in the list matches first appearance** for numeric styles.
5. Re-read each in-text citation and check the surrounding sentence is actually supported
   by that source.

```bash
# collect DOIs and confirm they resolve
grep -o 'doi *= *{[^}]*}' refs.bib | sed 's/.*{\(.*\)}/\1/' | while read -r d; do
  code=$(curl -s -o /dev/null -w "%{http_code}" "https://doi.org/$d")
  echo "$code $d"
done
```

## Rules

- Never write a citation from memory; retrieve and verify it.
- Never cite a source you have not confirmed exists (DOI or stable URL resolves).
- Never attach a citation to a claim the source does not support.
- Never cite for a result you produced yourself.
- Never leave an entry in the list that is not cited, or a citation that is not in the
  list.
- Never write "参考文献" entries by hand when the template provides a bibliography style.
- Report the access date for anything web-only; URLs rot.
- If you cannot find a source for a claim, weaken or drop the claim — do not invent one.
