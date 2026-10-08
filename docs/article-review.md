# Article review criteria

Use these criteria when reviewing the engineering articles in this repository. Review the whole article first, then read the collection together to catch repeated structures. Preserve technical facts, code, links, measured results, and uncertainty about the implementation or evidence.

## 1. Give each conclusion one home

Explain a finding in the section that contains its evidence. Later sections should add a consequence, a different failure mode, or a concrete next step. Remove summaries that repeat the same finding in different words.

For example, explain the TiFlash IOPS incident with the production diagnosis. Describe per-user partitioning with the ordering design, and the idempotent primary key with retry behavior. Revisit them only when the new detail changes the reader's understanding.

## 2. State the behavior directly

Prefer a concrete subject, action, and consequence. Use a contrast such as “not X, but Y” only when correcting a likely misunderstanding. Read the collection for repeated rhetorical patterns as well as repeated words.

Keep evidence boundaries explicit: distinguish throughput from latency, logical separation from resource isolation, and implemented guarantees from proposed changes. Express those limits in ordinary sentences.

## 3. Make emphasis selective

Use headings for navigation, code formatting for identifiers, and tables for comparisons. Reserve bold for a small number of details that need to be found quickly. Do not bold ordinary sentences or every list item's opening phrase.

## 4. Remove prose about the prose

Delete sentences that announce the article's intentions, defend its relevance, or tell readers how to value it. Put implementation boundaries, ownership, and measurement limitations next to the facts they qualify.

## 5. End with evidence or a specific unresolved issue

Avoid slogans, promotional claims, and repeated statements of project value. A result, an operational limit, or a concrete follow-up can end an article without an additional closing line.

Explain team size and costs where they affected a decision. Keep factual adoption and delivery outcomes; remove sections whose main purpose is defending the project.

## 6. Let the material determine the structure

Combine Context, Constraints, and Requirements when they repeat the same information. Keep separate sections when each has distinct evidence or decisions. Remove empty sections and headings that merely paraphrase their first sentence.

“What I Learned” and “What I Would Change Today” are optional. Move useful lessons and future changes next to the relevant incident or design limitation. Label proposed work clearly and retain a separate retrospective only when it adds information.

## Review completion

- Read every published article and draft; leave missing draft facts marked as missing.
- Check that edits preserve technical claims and metric definitions.
- Read headings and endings across the collection for formulaic repetition.
- Check front matter, code blocks, links, and image references after editing.
- Build the site and inspect the generated article pages.
