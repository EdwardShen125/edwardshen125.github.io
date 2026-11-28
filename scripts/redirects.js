'use strict';

// Permanent URL moves. GitHub Pages cannot issue HTTP 301s, so each old path
// is served as a static meta-refresh page that points at the new location.
// The mapping is append-only: an entry never leaves this list, otherwise
// external links and search-engine indexes break.
const absolute = path => new URL(path, `${hexo.config.url.replace(/\/$/, '')}/`).href;
const moves = [
  // 2026-11-28: category "Engineering Case Study" renamed to "Case Study";
  // posts moved out of the category folder, URLs no longer carry a category.
  ['/categories/Engineering-Case-Study/', '/categories/Case-Study/'],
  ...[
    'building-a-predicate-driven-audience-pipeline-for-lifecycle-email',
    'building-a-production-go-scheduler-for-200k-delayed-jobs-per-second',
    'building-a-real-time-data-platform-with-tidb-cdc-and-flink',
    'cutting-firestore-reads-by-moving-a-scan-off-the-request-path',
    'debugging-a-sporadic-go-oom-in-a-recursive-json-encode-path',
    'migrating-a-billion-elasticsearch-documents-without-stopping-writes',
    'one-queue-for-every-state-change-fixing-silent-over-assignment-in-a-live-qr-code-system',
    'running-a-million-dau-casual-game-on-go-rooms-as-the-concurrency-boundary',
    'scaling-four-engineers-to-eighteen-go-services-with-generated-contracts',
  ].map(slug => [`/posts/engineering-case-study/${slug}/`, `/posts/${slug}/`]),
];

hexo.extend.generator.register('redirects', () => moves.map(([from, to]) => ({
  path: `${from.replace(/^\//, '')}index.html`,
  layout: false,
  data: '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="robots" content="noindex">\n'
    + `<meta http-equiv="refresh" content="0; url=${to}">\n<link rel="canonical" href="${absolute(to)}">\n`
    + `<title>Moved: ${to}</title>\n</head>\n<body>\n<p>This page moved to <a href="${to}">${to}</a>.</p>\n</body>\n</html>\n`,
})));
