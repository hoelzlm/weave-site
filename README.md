# weave2-site

Marketing site + privacy policy for the Weave iOS app. Plain HTML/CSS, no build step.

## Structure

- `index.html` — landing page (animated headline, screenshot strip, TestFlight beta signup, features, Pro)
- `privacy.html` — privacy policy (linked from the App Store listing and the beta form)
- `support.html` — support page (linked from the App Store listing)
- `de/` — German copies of the three pages; the root redirects German browsers here (see `docs/adr/0001-german-under-de-path-with-root-redirect.md`). A copy change goes in both languages by hand.
- `styles.css` — shared styles
- `script.js` — headline word-cycle animation and the language-switch choice
- `assets/` — logo, favicon, screenshots (copied from `Weave 2/docs/marketing/`)
- `CNAME` — custom domain for GitHub Pages (`weave.rinnebuehl.de`)

## Local preview

Just open the files directly, no server needed:

```bash
open index.html
```

## Checks

Run before committing, from the repo root (Node 18+, no dependencies):

```bash
node scripts/check-site.mjs
```

It exits non-zero and prints `FAIL <page> [<check>] <reason>` for each problem. It checks that every local `href`/`src` (including `#anchor` targets) resolves; every page has an English/German twin with a matching canonical, reciprocal `hreflang` alternates and a language switch that leads to the twin; `sitemap.xml` and the pages agree; both index pages have the same ids, `<section>`s and `.card` blocks; and the root redirect script, run as-is against stubbed browsers, sends only German-first browsers to `de/` and respects `?lang=en` and a stored choice.

Until the German screenshots land (ticket 02), it fails on the four missing `assets/screenshots/de/screen-*.png` files referenced by `de/index.html`. That is expected; any other failure is a real bug.

## Status

Live at `weave.rinnebuehl.de` via GitHub Pages, custom domain + HTTPS working. Beta signup form posts to Formspree (`mppazblp`).

## Outlook — what's next

- **Swap the TestFlight CTA for the real App Store link** once the listing is live: replace the `#beta` hero button and retire the beta-signup section (or repurpose it as a "you're in" confirmation) in `index.html` and drop the matching paragraph in `privacy.html`.
- **Verify the Formspree flow end-to-end**: submit a real address on the production site and confirm the notification arrives at the configured destination before pointing any traffic at the beta.

## SEO

- `robots.txt` and `sitemap.xml` at the repo root — 2-page site, `Allow: /`, no `lastmod` (goes stale, not worth tracking).
- Open Graph / Twitter Card meta tags on both pages, reusing each page's existing `<title>`/`<meta description>`. Share image is `assets/og-image.png` (1200×630, logo centered on the site's gradient) — regenerate by rendering `og-render.html`-style markup through headless Chrome if the logo or gradient ever changes.
- Canonical URL tag on both pages.
