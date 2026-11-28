'use strict';

// Category vocabulary (references/taxonomy.md in the hexo-blog skill).
// A published post carries exactly one category, and it must be one of these;
// anything else fails the build instead of silently creating a new category.
// Drafts are not rendered and are not checked. Open a category by adding it
// here together with a scaffold in scaffolds/<name>.md.
// The Post model is read directly on purpose: hexo.locals caches an empty
// posts query whenever something touches it before source processing, which
// made this check see nothing under `hexo generate`.
const allowed = ['Case Study', 'Essays', 'Notes', 'Design'];
const published = post => post.published !== false && !post.source.startsWith('_drafts/');

hexo.extend.filter.register('before_generate', () => {
  const problems = hexo.model('Post').toArray().filter(published).flatMap(post => {
    const names = post.categories.toArray().map(category => category.name);
    if (names.length !== 1) return [`${post.source}: ${names.length} categories (${names.join(', ') || 'none'}), expected exactly one`];
    return allowed.includes(names[0]) ? [] : [`${post.source}: unknown category "${names[0]}", allowed: ${allowed.join(' | ')}`];
  });
  if (problems.length) throw new Error(`taxonomy check failed:\n${problems.join('\n')}`);
});
