/* global hexo */

'use strict';

hexo.extend.filter.register('after_post_render', data => {
  const { config } = hexo;
  const theme = hexo.theme.config;
  if (!theme.exturl && !theme.lazyload) return;
  if (theme.lazyload) {
    data.content = data.content.replace(/(<img[^>]*) src=/img, '$1 data-src=');
  }
  if (theme.exturl) {
    const siteHost = new URL(config.url).hostname;
    data.content = data.content.replace(/<a[^>]* href="([^"]+)"[^>]*>([^<]+)<\/a>/img, (match, href, html) => {
      // Exit if the href attribute doesn't exists.
      if (!href) return match;

      // Exit if the url has same host with `config.url`, which means it's an internal link.
      if (!/^[a-z][a-z\d+.-]*:/i.test(href)) return match;
      let link;
      try { link = new URL(href); } catch (_) { return match; }
      if (link.hostname === siteHost) return match;

      return `<span class="exturl" data-url="${Buffer.from(href).toString('base64')}">${html}<i class="fa fa-external-link-alt"></i></span>`;
    });
  }

}, 0);
