/**
 * Shared robots.txt fixtures used by crawler tests and the security
 * suite. Real-world shaped: multi-agent groups, wildcards, delays.
 */

export const ROBOTS_STANDARD = `User-agent: *
Disallow: /admin
Disallow: /private/
Allow: /private/allowed
Crawl-delay: 2
Sitemap: https://example.com/sitemap.xml`;

export const ROBOTS_AGENT_SPECIFIC = `User-agent: *
Disallow: /

User-agent: QuerynxBot
Disallow: /search
Allow: /search/help
Crawl-delay: 1`;

export const ROBOTS_MULTI_GROUP = `User-agent: crawler-a
User-agent: crawler-b
Disallow: /shared

User-agent: *
Disallow: /wildcard`;

export const ROBOTS_WILDCARD_PATHS = `User-agent: *
Disallow: /*/session/
Disallow: /*.pdf$
Allow: /*/public/`;

export const ROBOTS_EMPTY = '';

export const ROBOTS_MALFORMED = `this is not robots
: novalue
User-agent
Disallow`;

export const HTML_ARTICLE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Fitness Routine Guide</title>
  <meta name="description" content="A structured weekly training plan.">
  <meta property="og:site_name" content="Health Portal">
  <link rel="canonical" href="https://health.example/routines">
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Article",
     "author":{"name":"Dr. Kim"},"datePublished":"2025-02-10T09:00:00Z"}
  </script>
</head>
<body>
  <nav><a href="/home">Home</a></nav>
  <article>
    <h1>Weekly Training Plan</h1>
    <p>Strength training on Monday, Wednesday and Friday. Cardio on
       Tuesday and Thursday with active recovery on weekends.</p>
    <h2>Nutrition</h2>
    <p>Protein target is 1.6 grams per kilogram of body weight daily
       spread across four meals.</p>
  </article>
</body>
</html>`;

export const HTML_PRODUCT = `<!DOCTYPE html>
<html>
<head>
  <title>Ergonomic Keyboard X100 — Shop</title>
  <meta property="product:price:amount" content="129.99">
</head>
<body>
  <h1>Ergonomic Keyboard X100</h1>
  <p>Split design keyboard with mechanical switches.</p>
  <table>
    <tr><th>Spec</th><th>Value</th></tr>
    <tr><td>Switches</td><td>Hot-swappable</td></tr>
    <tr><td>Layout</td><td>75%</td></tr>
  </table>
</body>
</html>`;

export const SITEMAP_INDEX = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-pages.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-posts.xml</loc></sitemap>
</sitemapindex>`;

export const SITEMAP_URLSET = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page-a</loc></url>
  <url><loc>https://example.com/page-b</loc></url>
</urlset>`;
