# weave2-site

Marketing site + privacy policy for the Weave iOS app. Plain HTML/CSS, no build step.

## Structure

- `index.html` — landing page (animated headline, screenshot strip, TestFlight beta signup, features, Pro)
- `privacy.html` — privacy policy (linked from the App Store listing and the beta form)
- `support.html` — support page (linked from the App Store listing)
- `de/` — German copies of the three pages; the root redirects German browsers here (see `docs/adr/0001-german-under-de-path-with-root-redirect.md`). A copy change goes in both languages by hand.
- `styles.css` — shared styles
- `script.js` — headline word-cycle animation (visual only; the heading text keeps the first word) and the language-switch choice
- `assets/` — logo, favicon, screenshots (copied from `Weave 2/docs/marketing/`), resized for the web; the full-resolution originals live in `assets/source/` and no page references them (see [Images](#images))
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

It also checks images: every `<img>` declares a `width` and `height` equal to its file's pixels (and every `<source>` in its `<picture>` has the same shape); no image a page references (including `<source srcset>` and the favicon) is over 150 KB; the images a current browser fetches on first load (the first `<source>` of each `<picture>`, lazy images excluded) add up to at most 400 KB per page; images before a page's first `<section>` (nav, hero, screenshot strip) load eagerly and every image after it has `loading="lazy"`; and nothing references `assets/source/`. Share images (`og:image`) and `apple-touch-icon` are not fetched by visitors and are exempt from the budgets.

It also checks each `<h1>`'s text: as a crawler reads the markup and as a screen reader gets it (with `aria-hidden` parts dropped and CSS-drawn `data-word` text included), the two must be the same sentence, with no words run together (`runs.Share`). A heading with a rotating word (`.word-track`) must contain the first word exactly once and none of the others. The rotating words live in `data-word` attributes inside the `aria-hidden` viewport, are drawn by `::before { content: attr(data-word) }`, and the `.sr-only` word stays the first word; `script.js` only moves the track.

Until the German screenshots land (ticket 02), it fails on the four missing `assets/screenshots/de/screen-*.png` files referenced by `de/index.html`. That is expected; any other failure is a real bug.

## Images

Screenshots ship at 600 px wide (twice the ~300 px they are shown at) as WebP, with an indexed-colour PNG as fallback for browsers without WebP, through a `<picture>` element. The logo ships at 192 px (shown at 96 px and 30 px). The full-resolution originals (1179×2556 screenshots, the 1024 px logo) are kept in `assets/source/`, mirroring the paths under `assets/`; pages never reference them.

There is no build step. After adding or replacing an original, regenerate the web copies once from the repo root and commit them (needs `cwebp` and `ffmpeg`, e.g. `brew install webp ffmpeg`; `sips` ships with macOS):

```bash
for src in assets/source/screenshots/screen-*.png assets/source/screenshots/de/screen-*.png; do
  out="assets/${src#assets/source/}"
  cwebp -quiet -q 80 -m 6 -resize 600 0 "$src" -o "${out%.png}.webp"
  ffmpeg -loglevel error -y -i "$src" -vf "scale=600:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a" "$out"
done
sips --resampleWidth 192 assets/source/logo.png --out assets/logo.png
```

The PNG fallback is reduced to 256 colours because a full-colour 600 px PNG is 160–340 KB, over the per-image budget. Mark up a new screenshot like the existing ones:

```html
<picture>
  <source srcset="assets/screenshots/screen-1.webp" type="image/webp">
  <img src="assets/screenshots/screen-1.png" width="600" height="1301" alt="…">
</picture>
```

Add `loading="lazy" decoding="async"` to the `<img>` when it sits below the first screen (after the page's first `<section>`). Screenshots on the first screen carry `fetchpriority="low"` instead: the home pages' largest paint is the headline text, and Lighthouse's simulated LCP counts every image fetched at medium or high priority before that paint against it (that is what made the English page's LCP 10 s). The logo, the only first-screen image that is part of the hero itself, keeps its normal priority and ships as a 4 KB WebP on the home pages (`assets/logo.webp`, `cwebp -q 85 -m 6 -resize 192 0 assets/source/logo.png -o assets/logo.webp`). `node scripts/check-site.mjs` enforces the dimensions, budgets and lazy loading.

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
    --chrome-flags="--headless=new --lang=en-US" --output=json --output-path="lh-${page:-en}.json"
done
```

| Date | Page | Perf | A11y | Best pr. | SEO | LCP | CLS | Weight |
|---|---|---|---|---|---|---|---|---|
| 2026-09-30 (baseline) | `/` | 72 | 95 | 100 | 100 | 10.0 s | 0.02 | 1,858 KiB |
| 2026-09-30 (baseline) | `/de/` | 99 | 95 | 100 | 100 | 0.9 s | 0.083 | 2,816 KiB |
| 2026-10-01 (local, before ticket 04) | `/` | 75 | 95 | 100 | 100 | 10.5 s | 0 | 1,870 KiB |
| 2026-10-01 (local, before ticket 04) | `/de/` | 75 | 95 | 100 | 100 | 15.2 s | 0.001 | 2,828 KiB |
| 2026-10-01 (local, lighter images) | `/` | 100 | 95 | 100 | 100 | 1.9 s | 0 | 170 KiB |
| 2026-10-01 (local, lighter images) | `/de/` | 100 | 95 | 100 | 100 | 1.9 s | 0 | 173 KiB |
| 2026-10-01 (local, LCP fix) | `/` | 100 | 95 | 100 | 100 | 1.0 s | 0 | 139 KiB |
| 2026-10-01 (local, LCP fix) | `/de/` | 100 | 95 | 100 | 100 | 1.0 s | 0 | 141 KiB |

Baseline measured on `weave.rinnebuehl.de`, before the domain move. "Local" rows were measured against `python3 -m http.server` in the repo root, because the live site had no HTTPS certificate yet; they share the live runs' simulated throttling but not the live server's latency, so compare local with local:

```bash
python3 -m http.server 8741 --bind 127.0.0.1 &
npx -y lighthouse@12 "http://127.0.0.1:8741/?lang=en" --quiet --form-factor=mobile \
  --only-categories=performance,accessibility,best-practices,seo \
  --chrome-flags="--headless=new --lang=en-US" --output=json --output-path=lh-en.json
```

The root page sends a German-first browser to `de/`, and headless Chrome takes the machine's language: always pass `--lang=en-US` (or measure `/?lang=en`, as above) for the English page, and check the report’s final URL.

Targets: LCP under 2.5 s, CLS under 0.1, performance 90+, accessibility 100.
