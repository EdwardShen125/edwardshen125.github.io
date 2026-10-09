# Edward Shen — Career Portfolio Blog

This is a separate Hexo project from the local archived Chinese technical blog. It is dedicated to overseas-job-focused engineering write-ups, real project summaries, and system design case studies.

It deploys from the `career` branch of `EdwardShen125/edwardshen125.github.io` to:

```text
https://edwardshen125.github.io/
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

Articles should explain the problem, decisions, production behavior, and results with concrete evidence. Choose sections that fit the case, combine overlapping context and constraints, and discuss trade-offs next to the decisions they qualify.

The [draft writing aid](source/_drafts/portfolio-post-template.md) provides an optional starting structure.

## Publishing Workflow

```bash
hexo new post "short-english-slug"
```

Write in English. Keep the title specific and interview-friendly. Add diagrams when the architecture is non-obvious.

## Search and AI discovery

`scripts/seo.js` generates `sitemap.xml`, `robots.txt`, and an optional `llms.txt` article directory. It adds Person, WebSite, BlogPosting, ProfilePage, and breadcrumb JSON-LD through the NexT head injection hook. The theme continues to generate canonical and Open Graph tags.

Homepage previews use the opening body paragraphs before `<!-- more -->`. The `description` field is reserved for search and sharing metadata and is not displayed above the article body. Add the marker after the introduction when publishing a new article.

Set a concise `description` and a post-relative `seo_image` filename in article front matter. Keep summaries consistent with the evidence and measurement scope in the article. Modification dates use each file’s Git history unless front matter explicitly sets `updated`; deployment checks out the full history.

After deployment, submit `https://edwardshen125.github.io/sitemap.xml` in Google Search Console and Bing Webmaster Tools. Account ownership verification is configured through NexT’s `google_site_verification` and `bing_site_verification` settings. `llms.txt` is an optional navigation aid, not a guarantee of indexing or AI citations.

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
