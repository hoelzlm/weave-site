# weave2-site

Marketing site + privacy policy for the Weave iOS app. Plain HTML/CSS, no build step.

## Structure

- `index.html` — landing page
- `privacy.html` — privacy policy (linked from the App Store listing)
- `styles.css` — shared styles
- `assets/` — logo, favicon, screenshots (copied from `Weave 2/docs/marketing/`)
- `CNAME` — custom domain for GitHub Pages (`weave.rinnebuehl.de`)

## Local preview

Just open the files directly, no server needed:

```bash
open index.html
```

## Deploy (GitHub Pages)

1. Create a GitHub repo and push this directory to it.
2. In the repo's Settings → Pages, set source to the default branch (root).
3. Add a custom domain of `weave.rinnebuehl.de` in the same Pages settings (the `CNAME` file already contains this).
4. At the domain registrar for `rinnebuehl.de`, add a `CNAME` DNS record: `weave` → `<github-username>.github.io`.
5. Create a Formspree form and verify its notification destination.
6. Replace `REPLACE_WITH_FORM_ID` in the beta form action in `index.html` with the Formspree form ID.
7. Deploy over HTTPS and submit a test address from the production site. Confirm the notification arrives and the privacy-page wording matches the Formspree account configuration.
8. Once the App Store listing is live, update the beta CTA and form copy in `index.html` with the real App Store link and release details.
