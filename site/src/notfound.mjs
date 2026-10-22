// 404.

export function notFoundPage() {
  return `
<section class="page-hero notfound">
  <div class="container">
    <span class="eyebrow">404</span>
    <h1>This page swam off</h1>
    <p>The page you're looking for isn't here. It may have moved when the docs were reorganised.</p>
    <div class="hero-ctas" style="justify-content:flex-start">
      <a class="btn btn-primary" href="/docs/introduction/">Browse the docs</a>
      <button class="btn" type="button" data-search-open>Search</button>
      <a class="btn btn-ghost" href="/">Home</a>
    </div>
  </div>
</section>`;
}
