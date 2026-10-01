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
- `CNAME` — custom domain for GitHub Pages (`workoutstories.app`)

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

It exits non-zero and prints `FAIL <page> [<check>] <reason>` for each problem. It checks that every local or same-domain `href`/`src`/`<meta content>` URL (including `#anchor` targets) resolves; every page has an English/German twin with a matching canonical and `og:url`, reciprocal `hreflang` alternates and a language switch that leads to the twin (with `?lang=en` when it leads to the redirecting root); `sitemap.xml` and the pages agree; both index pages have the same ids, `<section>`s and `.card` blocks; and the root redirect script, run as-is against stubbed browsers, sends only German-first browsers to `de/` and respects `?lang=en` and a stored choice.

Structured data: each home page must carry exactly one JSON-LD block that parses, describes a `MobileApplication` (name, description, iOS, category, the page's own URL and language, publisher with email, no ratings), and prices every offer in the page's currency (USD on English, EUR on German), with the "Weave Pro" offer equal to the price shown in the Pro band. Change the visible price and the JSON-LD together.

FAQ: both home pages must have a visible `#faq` section (one `.faq-item` per question: an `<h3>` question, then `<p>` answer) with 5 to 7 questions, a `FAQPage` node in that same JSON-LD block with the same questions and answers in the same order, and the same number of questions in English and German. Edit the visible text and the JSON-LD together; keep answers plain text (no links), so the two can match word for word.

Until the German screenshots land (ticket 02), it fails on the four missing `assets/screenshots/de/screen-*.png` files referenced by `de/index.html`. That is expected; any other failure is a real bug.

## Status

Live at `workoutstories.app` via GitHub Pages (moved from `weave.rinnebuehl.de` on 2026-09-30, which redirects here). Beta signup form posts to Formspree (`mppazblp`).

## Outlook — what's next

- **Swap the TestFlight CTA for the real App Store link** once the listing is live: replace the `#beta` hero button and retire the beta-signup section (or repurpose it as a "you're in" confirmation) in `index.html` and drop the matching paragraph in `privacy.html`.
- **Verify the Formspree flow end-to-end**: submit a real address on the production site and confirm the notification arrives at the configured destination before pointing any traffic at the beta.

## SEO

- `robots.txt` and `sitemap.xml` at the repo root — 2-page site, `Allow: /`, no `lastmod` (goes stale, not worth tracking).
- Open Graph / Twitter Card meta tags on both pages, reusing each page's existing `<title>`/`<meta description>`. Share image is `assets/og-image.png` (1200×630, logo centered on the site's gradient) — regenerate by rendering `og-render.html`-style markup through headless Chrome if the logo or gradient ever changes.
- Canonical URL tag on both pages.

### Measuring

Lighthouse (mobile) on both live home pages, before and after SEO work. Needs Node and Chrome; not part of `check-site.mjs`, because it depends on the network.

```bash
for page in "" de/; do
  npx -y lighthouse@12 "https://workoutstories.app/$page" --quiet --form-factor=mobile \
    --only-categories=performance,accessibility,best-practices,seo \
    --chrome-flags="--headless=new" --output=json --output-path="lh-${page:-en}.json"
done
```

| Date | Page | Perf | A11y | Best pr. | SEO | LCP | CLS | Weight |
|---|---|---|---|---|---|---|---|---|
| 2026-09-30 (baseline) | `/` | 72 | 95 | 100 | 100 | 10.0 s | 0.02 | 1,858 KiB |
| 2026-09-30 (baseline) | `/de/` | 99 | 95 | 100 | 100 | 0.9 s | 0.083 | 2,816 KiB |

Baseline measured on `weave.rinnebuehl.de`, before the domain move. Targets: LCP under 2.5 s, CLS under 0.1, performance 90+, accessibility 100.
