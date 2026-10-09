'use strict';

const { execFileSync } = require('node:child_process');

// Pandoc versions installed by Homebrew and Ubuntu support different flags.
// Preserve the renderer's existing Markdown options and select only math syntax.
hexo.extend.filter.register('before_post_render', data => {
  const config = hexo.config.pandoc || (hexo.config.pandoc = {});
  if (config.args || config.mathEngine) return data;
  const help = execFileSync(config.pandoc_path || 'pandoc', ['--help'], {
    encoding: 'utf8'
  });
  config.mathEngine = help.includes('--math-method=') ? 'math-method=mathjax' : 'mathjax';
  return data;
}, 1);
