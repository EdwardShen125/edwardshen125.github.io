# Edward Shen — Career Portfolio Blog

This is a separate Hexo project from the local archived Chinese technical blog. It is dedicated to overseas-job-focused engineering write-ups, real project summaries, and system design case studies.

It deploys from the `career` branch of `EdwardShen125/blog` to:

```text
https://edwardshen125.github.io/blog/
```

## Local Development

```bash
npm run server
```

Visit:

```text
http://localhost:4000
```

## Build

```bash
npm run clean && npm run build
```

## Content Strategy

Keep this blog small and high-signal. Prefer 3–5 strong English articles over a large incomplete series.

Recommended article types:

1. Production incident postmortem
2. Distributed systems design decision
3. High-availability architecture deep dive
4. Performance optimization with measurable impact
5. Open-source or personal project case study

Review articles against [the article review criteria](docs/article-review.md). Explain the problem, decisions, production behavior, and results with concrete evidence. Choose sections that fit the case, combine overlapping context and constraints, and discuss trade-offs next to the decisions they qualify. A retrospective is useful when it adds a new finding or a specific follow-up.

The [draft writing aid](source/_drafts/portfolio-post-template.md) provides an optional starting structure.

## Publishing Workflow

```bash
hexo new post "short-english-slug"
```

Write in English. Keep the title specific and interview-friendly. Add diagrams when the architecture is non-obvious.

## Automatic Deployment

Every push to the `career` branch runs the GitHub Actions workflow at:

```text
.github/workflows/deploy.yml
```

The workflow:

1. Installs dependencies with `npm ci`
2. Installs Pandoc
3. Builds the Hexo site
4. Publishes `public/` to the `gh-pages` branch

GitHub Pages is configured to publish from `gh-pages` and `/ (root)`.
