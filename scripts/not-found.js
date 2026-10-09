'use strict';

const { createReadStream } = require('node:fs');
const { join } = require('node:path');

// Run after Hexo's route, static-file, and redirect middleware.
hexo.extend.filter.register('server_middleware', function(app) {
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const page = this.env.args.static || this.env.args.s
      ? createReadStream(join(this.public_dir, '404.html'))
      : this.route.get('404.html');
    if (!page) return next();
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'HEAD') {
      page.destroy();
      return res.end();
    }
    page.on('error', next).pipe(res);
  });
}, 100);
