<header class="post-header">

<h1 class="post-title" itemprop="name headline">
  {{- page.title }}
  {{- post_edit(page.source) }}
</h1>

<div class="post-meta">
  {# Page descriptions are metadata, not visible header copy. #}
  {% include '_partials/page/breadcrumb.swig' %}
</div>

</header>
