# Edward Shen — Career Portfolio Blog

This is a separate Hexo project from the original Chinese technical blog. It is dedicated to overseas-job-focused engineering write-ups, real project summaries, and system design case studies.

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

Every strong post should include:

- Business or technical context
- Failure mode / constraint
- Options considered
- Trade-offs
- Final design
- Observability / rollout plan
- Quantified result, if available
- Retrospective

## Publishing Workflow

```bash
hexo new post "short-english-slug"
```

Write in English. Keep the title specific and interview-friendly. Add diagrams when the architecture is non-obvious.

## Automatic Deployment

Every push to `main` runs the GitHub Actions workflow at:

```text
.github/workflows/deploy.yml
```

The workflow:

1. Installs dependencies with `npm ci`
2. Builds the Hexo site
3. Deploys `public/` to GitHub Pages

After the repository is created on GitHub, enable **Settings → Pages → Source → GitHub Actions**. The first push to `main` will deploy the site.
