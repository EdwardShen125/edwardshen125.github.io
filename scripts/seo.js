'use strict';

const { execFileSync } = require('node:child_process');

const absolute = path => new URL((path || '/').replace(/index\.html$/, ''), `${hexo.config.url.replace(/\/$/, '')}/`).href;
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const published = post => post.published !== false && !post.source.startsWith('_drafts/');

hexo.extend.filter.register('theme_inject', injects => {
  injects.head.raw('seo.swig', '<meta name="robots" content="{% if page.path == "404/index.html" or page.path == "404.html" %}noindex, follow{% else %}index, follow, max-image-preview:large{% endif %}">\n<script type="application/ld+json">{{ seo_json_ld() | safe }}</script>');
});

// Use content history instead of checkout time for search metadata.
hexo.extend.filter.register('before_post_render', data => {
  if (!data.source || (data.raw || '').split('---')[1]?.match(/^updated:/m)) return data;
  try {
    const date = execFileSync('git', ['log', '-1', '--format=%cI', '--', `source/${data.source}`], { cwd: hexo.base_dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (date) data.updated = date;
  } catch (_) {
    // Files without Git history retain Hexo's date handling.
  }
  return data;
});

hexo.extend.helper.register('seo_json_ld', function() {
  const page = this.page;
  const authorId = `${absolute('about/')}#person`;
  const author = { '@type': 'Person', '@id': authorId, name: hexo.config.author, url: absolute('about/'), sameAs: ['https://github.com/EdwardShen125'] };
  const website = { '@type': 'WebSite', '@id': `${absolute('/')}#website`, url: absolute('/'), name: hexo.config.title, inLanguage: hexo.config.language, publisher: { '@id': authorId } };
  const graph = [author, website];
  if (this.is_post()) {
    const url = absolute(page.path);
    const article = { '@type': 'BlogPosting', '@id': `${url}#article`, mainEntityOfPage: url, url, headline: page.title, description: page.description, datePublished: page.date.toISOString(), dateModified: page.updated.toISOString(), inLanguage: hexo.config.language, author: { '@id': authorId }, publisher: { '@id': authorId }, keywords: page.tags.map(tag => tag.name).join(', ') };
    if (page.seo_image) article.image = [new URL(page.seo_image, url).href];
    graph.push(article, { '@type': 'BreadcrumbList', itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: absolute('/') }, { '@type': 'ListItem', position: 2, name: page.title, item: url }] });
  } else if (page.path === 'about/index.html') {
    graph.push({ '@type': 'ProfilePage', '@id': absolute(page.path), url: absolute(page.path), mainEntity: { '@id': authorId } });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
});

hexo.extend.generator.register('discovery', locals => {
  const posts = locals.posts.toArray().filter(published).sort((a, b) => b.date.valueOf() - a.date.valueOf());
  const entries = [{ url: absolute('/') }, { url: absolute('about/') }, ...posts.map(post => ({ url: absolute(post.path), modified: post.updated.toISOString() }))];
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + entries.map(entry => `  <url><loc>${xml(entry.url)}</loc>${entry.modified ? `<lastmod>${xml(entry.modified)}</lastmod>` : ''}</url>`).join('\n') + '\n</urlset>\n';
  const llms = `# ${hexo.config.author}\n\n> Engineering case studies on Go backends, distributed scheduling, data platforms, and lifecycle audience pipelines.\n\nThese articles describe project decisions, production observations, and implementation limits. Proposed changes are identified in the articles.\n\n## Author\n\n- [About ${hexo.config.author}](${absolute('about/')}): Career background and systems owned.\n\n## Engineering case studies\n\n` + posts.map(post => `- [${post.title}](${absolute(post.path)}): ${post.description}`).join('\n') + '\n';
  return [{ path: 'sitemap.xml', data: sitemap }, { path: 'robots.txt', data: `User-agent: *\nAllow: /\n\nSitemap: ${absolute('sitemap.xml')}\n` }, { path: 'llms.txt', data: llms }];
});
