/* global hexo */

'use strict';

// Vendored NexT's next_url helper ends with htmlTag(tag, attrs, decodeURI(text), false).
// A title carrying a bare percent sign ("Cutting Firestore Reads 58% by ...") makes decodeURI
// throw URIError: URI malformed, and the homepage (index.swig -> _macro/post.swig) fails to render.
// Re-register the helper on `ready` (after theme scripts) with a round-trip-safe text argument:
// decodeURI(encodeURI(text)) === text for every valid string, including a bare '%'.
hexo.on('ready', () => {
  const themeHelper = hexo.extend.helper.get('next_url');
  if (typeof themeHelper !== 'function') return;
  hexo.extend.helper.register('next_url', function(path, text, options) {
    return themeHelper.call(this, path, typeof text === 'string' ? encodeURI(text) : text, options);
  });
});
