# German lives under /de/, and the English root redirects German browsers there

The site ships in English and German as separate static pages: English at the root (`index.html`, `privacy.html`, `support.html`), German under `/de/` with the same file names. Each page carries `hreflang` alternates and a language switch. An inline script in the root `index.html` sends a browser whose first language is German to `/de/`, unless the visitor already chose English — through the switch's `?lang=en` query or a `weave-lang` value in `localStorage`. The redirect runs on the root page only, so deep links to the English privacy or support page are never rewritten.

The redirect exists because of the radio spot that prompted the German site: a listener types the bare domain, and GitHub Pages cannot negotiate language on the server. The switch writes both the query and the stored choice because storage can throw in private windows, and without the query an English click would bounce straight back to `/de/`.

**Considered and rejected: German at the root, English under `/en/`.** It serves the radio audience without a redirect, but makes the audience arriving from Reddit, Product Hunt and Hacker News the secondary one, and moves every English URL already in circulation.

**Considered and rejected: `/de/` with no redirect.** Simplest and friendliest to crawlers, but a spoken domain would land German listeners on the English page. Revisit if the site moves to a host that can negotiate `Accept-Language` itself.

**Consequence — every page is written twice.** There is no build step and no templating, so a copy change touches both languages by hand. The release-day change that swaps the TestFlight CTA for the App Store link, and drops the beta form, has to be made in `index.html` and `de/index.html` together.

**Consequence — product vocabulary stays English on the German pages**, as in the app (Weave, Pro, Clean, Bold, Route First, Recap, Lift); see the app repo's ADR 0002. German copy is informal ("du") and uses the app's own words for card (*Karte*), template (*Vorlage*) and merge (*zusammenführen*).
