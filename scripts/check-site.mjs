#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const BASE_URL = 'https://workoutstories.app';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];

// Pages GitHub Pages serves outside the bilingual page set: no twin, no sitemap entry.
const NOT_FOUND_PAGE = '404.html';
const UNPAIRED_PAGES = new Set([NOT_FOUND_PAGE]);

function fail(page, check, message) {
  failures.push({ page, check, message });
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function isFile(path) {
  const full = join(ROOT, path);
  return existsSync(full) && statSync(full).isFile();
}

function htmlFilesIn(dir) {
  const full = join(ROOT, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((name) => name.endsWith('.html') && isFile(join(dir, name)))
    .map((name) => (dir === '.' ? name : `${dir}/${name}`))
    .sort();
}

function discoverPages() {
  return [...htmlFilesIn('.'), ...htmlFilesIn('de')];
}

function languageOf(page) {
  return page.startsWith('de/') ? 'de' : 'en';
}

function twinOf(page) {
  return languageOf(page) === 'de' ? page.slice('de/'.length) : `de/${page}`;
}

function englishPageOf(page) {
  return languageOf(page) === 'en' ? page : twinOf(page);
}

function urlOf(page) {
  const path = page.replace(/(^|\/)index\.html$/, '$1');
  return `${BASE_URL}/${path}`;
}

function isSiteUrl(url) {
  return url.startsWith(BASE_URL) && /^([/?#]|$)/.test(url.slice(BASE_URL.length));
}

function fileOfUrl(url) {
  if (!isSiteUrl(url)) return null;
  const path = url.slice(BASE_URL.length).replace(/^\//, '').replace(/[?#].*$/, '');
  return path === '' || path.endsWith('/') ? `${path}index.html` : path;
}

function fragmentOf(reference) {
  const index = reference.indexOf('#');
  return index === -1 ? '' : reference.slice(index + 1);
}

function queryOf(reference) {
  const [beforeFragment] = reference.split('#');
  const index = beforeFragment.indexOf('?');
  return new URLSearchParams(index === -1 ? '' : beforeFragment.slice(index + 1));
}

function stripScriptsAndComments(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, '<script$1></script>');
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([^\s=\/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  for (const [, name, double, single, bare] of source.matchAll(pattern)) {
    attributes[name.toLowerCase()] = double ?? single ?? bare ?? '';
  }
  return attributes;
}

function parseTags(html) {
  const markup = stripScriptsAndComments(html);
  const tags = [];
  for (const [, name, source] of markup.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    tags.push({ name: name.toLowerCase(), attributes: parseAttributes(source) });
  }
  return tags;
}

function hasToken(value, token) {
  return (value ?? '').split(/\s+/).includes(token);
}

function loadPage(page) {
  const html = read(page);
  const tags = parseTags(html);
  const ids = new Set(tags.map((tag) => tag.attributes.id).filter(Boolean));
  return { page, html, tags, ids };
}

function isExternal(reference) {
  return /^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('//');
}

function resolveReference(page, reference) {
  const fragment = fragmentOf(reference);
  const path = reference.split('#')[0].split('?')[0];
  if (path === '') return { file: page, fragment };
  const joined = path.startsWith('/') ? path.slice(1) : join(dirname(page), path);
  const file = normalize(joined).replace(/\\/g, '/');
  const target = file === '.' || path.endsWith('/') ? join(file, 'index.html') : file;
  return { file: target.replace(/\\/g, '/'), fragment };
}

function targetOf(page, reference) {
  if (isSiteUrl(reference)) return { file: fileOfUrl(reference), fragment: fragmentOf(reference) };
  if (isExternal(reference)) return null;
  return resolveReference(page, reference);
}

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return null;
  }
}

function referencesOf(loaded) {
  const references = loaded.tags.flatMap((tag) => [
    ...['href', 'src'].filter((name) => tag.attributes[name] !== undefined).map((name) => tag.attributes[name].trim()),
    ...(tag.name === 'meta' && isSiteUrl(tag.attributes.content?.trim() ?? '') ? [tag.attributes.content.trim()] : []),
  ]);
  return [...new Set(references)];
}

function checkLinks(loaded, pagesByFile) {
  for (const reference of referencesOf(loaded)) {
    if (reference === '') continue;
    const target = targetOf(loaded.page, reference);
    if (!target) continue;
    const { file } = target;
    const fragment = decodeFragment(target.fragment);
    if (fragment === null) {
      fail(loaded.page, 'links', `${reference} has a malformed fragment`);
      continue;
    }
    if (file.startsWith('..')) {
      fail(loaded.page, 'links', `${reference} points outside the site`);
      continue;
    }
    if (!isFile(file)) {
      fail(loaded.page, 'links', `${reference} does not exist (${file})`);
      continue;
    }
    if (fragment === '' || !file.endsWith('.html')) continue;
    const linked = pagesByFile.get(file) ?? loadPage(file);
    if (!linked.ids.has(fragment)) fail(loaded.page, 'links', `${reference} has no element with id "${fragment}" in ${file}`);
  }
}

function linkTagsWithRel(loaded, rel) {
  return loaded.tags.filter((tag) => tag.name === 'link' && hasToken(tag.attributes.rel?.toLowerCase(), rel));
}

function expectedAlternates(page) {
  const english = englishPageOf(page);
  return { en: urlOf(english), de: urlOf(twinOf(english)), 'x-default': urlOf(english) };
}

function checkCanonical(loaded) {
  const canonicals = linkTagsWithRel(loaded, 'canonical').map((tag) => tag.attributes.href);
  const expected = urlOf(loaded.page);
  if (canonicals.length !== 1) fail(loaded.page, 'canonical', `expected one canonical link, found ${canonicals.length}`);
  else if (canonicals[0] !== expected) fail(loaded.page, 'canonical', `canonical is ${canonicals[0]}, expected ${expected}`);
}

function checkOpenGraphUrl(loaded) {
  const urls = loaded.tags.filter((tag) => tag.name === 'meta' && tag.attributes.property === 'og:url').map((tag) => tag.attributes.content);
  const expected = urlOf(loaded.page);
  for (const url of urls) {
    if (url !== expected) fail(loaded.page, 'canonical', `og:url is ${url}, expected ${expected}`);
  }
}

function checkAlternates(loaded) {
  const declared = new Map();
  for (const tag of linkTagsWithRel(loaded, 'alternate')) {
    const lang = tag.attributes.hreflang?.toLowerCase();
    if (!lang) continue;
    if (declared.has(lang)) fail(loaded.page, 'hreflang', `hreflang="${lang}" is declared more than once`);
    declared.set(lang, tag.attributes.href);
  }
  const expected = expectedAlternates(loaded.page);
  for (const [lang, url] of Object.entries(expected)) {
    if (!declared.has(lang)) fail(loaded.page, 'hreflang', `missing hreflang="${lang}" alternate (expected ${url})`);
    else if (declared.get(lang) !== url) fail(loaded.page, 'hreflang', `hreflang="${lang}" points at ${declared.get(lang)}, expected ${url}`);
  }
  for (const lang of declared.keys()) {
    if (!(lang in expected)) fail(loaded.page, 'hreflang', `unexpected hreflang="${lang}" alternate`);
  }
}

function checkDocumentLanguage(loaded) {
  const html = loaded.tags.find((tag) => tag.name === 'html');
  const expected = languageOf(loaded.page);
  if (html?.attributes.lang !== expected) fail(loaded.page, 'lang', `<html lang="${html?.attributes.lang ?? ''}">, expected "${expected}"`);
}

function checkLanguageSwitch(loaded) {
  const switches = loaded.tags.filter((tag) => tag.attributes['data-set-lang'] !== undefined);
  const twin = twinOf(loaded.page);
  if (switches.length === 0) fail(loaded.page, 'language switch', 'no link with data-set-lang');
  for (const tag of switches) {
    const { href = '', 'data-set-lang': lang } = tag.attributes;
    if (lang !== languageOf(twin)) fail(loaded.page, 'language switch', `data-set-lang="${lang}", expected "${languageOf(twin)}"`);
    const target = resolveReference(loaded.page, href).file;
    if (target !== twin) fail(loaded.page, 'language switch', `${href} leads to ${target}, expected ${twin}`);
    if (twin === 'index.html' && queryOf(href).get('lang') !== 'en') {
      fail(loaded.page, 'language switch', `${href} leads to the redirecting root without ?lang=en`);
    }
  }
}

function checkTwin(loaded) {
  const twin = twinOf(loaded.page);
  if (!isFile(twin)) {
    fail(loaded.page, 'twin', `no ${languageOf(twin) === 'de' ? 'German' : 'English'} twin at ${twin}`);
    return;
  }
  checkDocumentLanguage(loaded);
  checkCanonical(loaded);
  checkOpenGraphUrl(loaded);
  checkAlternates(loaded);
  checkLanguageSwitch(loaded);
}

function checkSitemap(pages) {
  if (!isFile('sitemap.xml')) {
    fail('sitemap.xml', 'sitemap', 'sitemap.xml does not exist');
    return;
  }
  const locations = [...read('sitemap.xml').matchAll(/<loc>\s*([^<]*?)\s*<\/loc>/g)].map(([, url]) => url);
  for (const page of pages) {
    if (!locations.includes(urlOf(page))) fail(page, 'sitemap', `${urlOf(page)} is not listed in sitemap.xml`);
  }
  const seen = new Set();
  for (const url of locations) {
    if (seen.has(url)) fail('sitemap.xml', 'sitemap', `${url} is listed more than once`);
    seen.add(url);
    const file = fileOfUrl(url);
    if (UNPAIRED_PAGES.has(file)) fail('sitemap.xml', 'sitemap', `${url} is a page outside the bilingual set (${file}) and must not be listed`);
    if (!file || !isFile(file)) fail('sitemap.xml', 'sitemap', `${url} has no matching file`);
    else if (file.endsWith('.html') && urlOf(file) !== url) fail('sitemap.xml', 'sitemap', `${url} is not the canonical URL ${urlOf(file)}`);
  }
}

function sectionCount(loaded) {
  return loaded.tags.filter((tag) => tag.name === 'section').length;
}

function cardCount(loaded) {
  return loaded.tags.filter((tag) => hasToken(tag.attributes.class, 'card')).length;
}

function checkIndexStructure(pagesByFile) {
  const english = pagesByFile.get('index.html');
  const german = pagesByFile.get('de/index.html');
  if (!english || !german) return;
  const page = german.page;
  for (const id of english.ids) if (!german.ids.has(id)) fail(page, 'structure', `missing id "${id}" that index.html has`);
  for (const id of german.ids) if (!english.ids.has(id)) fail(page, 'structure', `has id "${id}" that index.html lacks`);
  for (const [label, count] of [['<section> elements', sectionCount], ['.card blocks', cardCount]]) {
    const [en, de] = [count(english), count(german)];
    if (en !== de) fail(page, 'structure', `${de} ${label}, index.html has ${en}`);
  }
}

function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => parseAttributes(attributes).src === undefined)
    .map(([, , body]) => body);
}

const BLOCK_STORAGE = `Object.defineProperty(globalThis, 'localStorage', {
  get() { throw new Error('SecurityError: storage is blocked'); },
});`;

function createStorage(entries) {
  return {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

function runRedirect(script, { languages, language, search = '', hash = '', saved, throws = false }) {
  const redirects = [];
  const entries = new Map(saved ? [['weave-lang', saved]] : []);
  const context = {
    location: { search, hash, replace: (url) => redirects.push(url), assign: (url) => redirects.push(url) },
    navigator: { languages, language },
    URLSearchParams,
  };
  if (!throws) context.localStorage = createStorage(entries);
  vm.createContext(context);
  if (throws) vm.runInContext(BLOCK_STORAGE, context);
  vm.runInContext(script, context, { timeout: 1000 });
  return { redirects, stored: entries.get('weave-lang') };
}

const REDIRECT_CASES = [
  { name: 'German-first browser', browser: { languages: ['de-DE', 'en'] }, redirect: 'de/' },
  { name: 'German-first browser keeps the hash', browser: { languages: ['de', 'en'], hash: '#pro' }, redirect: 'de/#pro' },
  { name: 'German navigator.language without languages', browser: { language: 'de-AT' }, redirect: 'de/' },
  { name: 'English-first browser', browser: { languages: ['en-US', 'de-DE'] }, redirect: null },
  { name: '?lang=en on a German browser', browser: { languages: ['de-DE'], search: '?lang=en' }, redirect: null, stored: 'en' },
  { name: 'stored English on a German browser', browser: { languages: ['de-DE'], saved: 'en' }, redirect: null },
  { name: 'stored German on an English browser', browser: { languages: ['en-US'], saved: 'de' }, redirect: 'de/' },
  { name: 'throwing storage on a German browser', browser: { languages: ['de-DE'], throws: true }, redirect: 'de/' },
  { name: 'throwing storage with ?lang=en', browser: { languages: ['de-DE'], search: '?lang=en', throws: true }, redirect: null },
  { name: '"dev" is not German', browser: { languages: ['dev'] }, redirect: null },
];

function checkRedirectCase(script, { name, browser, redirect, stored }) {
  let result;
  try {
    result = runRedirect(script, browser);
  } catch (error) {
    fail('index.html', 'redirect', `${name}: script threw ${error.message}`);
    return;
  }
  const actual = result.redirects[0] ?? null;
  if (result.redirects.length > 1) fail('index.html', 'redirect', `${name}: redirected ${result.redirects.length} times`);
  if (actual !== redirect) fail('index.html', 'redirect', `${name}: redirected to ${actual ?? 'nothing'}, expected ${redirect ?? 'no redirect'}`);
  if (stored !== undefined && result.stored !== stored) fail('index.html', 'redirect', `${name}: stored ${result.stored ?? 'nothing'}, expected "${stored}"`);
}

function checkRedirect() {
  if (!isFile('index.html')) return;
  const scripts = inlineScripts(read('index.html')).filter((body) => /location\.replace/.test(body));
  if (scripts.length !== 1) {
    fail('index.html', 'redirect', `expected one inline redirect script, found ${scripts.length}`);
    return;
  }
  for (const testCase of REDIRECT_CASES) checkRedirectCase(scripts[0], testCase);
}

function checkNoIndexHtmlLinks(loaded) {
  for (const reference of referencesOf(loaded)) {
    if (isExternal(reference) && !isSiteUrl(reference)) continue;
    const path = reference.split('#')[0].split('?')[0];
    if (/(^|\/)index\.html$/.test(path)) {
      fail(loaded.page, 'index links', `${reference} targets index.html; link to the directory (e.g. ./ or ../) instead`);
    }
  }
}

// Structured data: each home page carries exactly one JSON-LD block describing the app.
// Its offers must be priced in the page's currency. A page that shows a price (.amount) must
// carry exactly one "Weave Pro" offer stating that same price; while the site states no Pro price,
// no page shows one and Weave Pro has no offer.

const HOME_PAGES = ['index.html', 'de/index.html'];
const CURRENCY_BY_LANGUAGE = { en: 'USD', de: 'EUR' };

function jsonLdBlocks(html) {
  return [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attributes]) => (parseAttributes(attributes).type ?? '').trim().toLowerCase() === 'application/ld+json')
    .map(([, , body]) => body);
}

function parseJsonLd(page, body) {
  try {
    return JSON.parse(body);
  } catch (error) {
    fail(page, 'structured data', `JSON-LD is not valid JSON: ${error.message}`);
    return null;
  }
}

function jsonLdNodes(data) {
  const nodes = Array.isArray(data) ? data : [data];
  return nodes.flatMap((node) => (node && Array.isArray(node['@graph']) ? node['@graph'] : [node])).filter(Boolean);
}

function typesOf(node) {
  return [node?.['@type']].flat().filter(Boolean);
}

// Inline elements do not break a word or a sentence ("<strong>Metric</strong>: distance" reads
// "Metric: distance"); every other tag does.
const INLINE_TAG = /<\/?(?:a|abbr|b|bdi|bdo|cite|code|data|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function textOfElement(html) {
  return decodeEntities(html.replace(INLINE_TAG, '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// "$6.99" -> { amount: "6.99", currency: "USD" }; "6,99 €" -> { amount: "6.99", currency: "EUR" }
function parseVisiblePrice(text) {
  const currency = /\$|US\s?D/.test(text) ? 'USD' : /€|EUR/.test(text) ? 'EUR' : null;
  const number = text.match(/\d+(?:[.,]\d{1,2})?/);
  if (!currency || !number) return null;
  return { amount: Number(number[0].replace(',', '.')).toFixed(2), currency };
}

function visiblePrices(html) {
  return [...stripScriptsAndComments(html).matchAll(/<div\b[^>]*\bclass="[^"]*\bamount\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)]
    .map(([, inner]) => textOfElement(inner));
}

function requireText(page, node, field, label) {
  const value = node?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    fail(page, 'structured data', `${label} has no "${field}"`);
    return false;
  }
  return true;
}

function checkOffers(page, app, language) {
  const offers = [app.offers].flat().filter(Boolean);
  const currency = CURRENCY_BY_LANGUAGE[language];
  if (offers.length === 0) {
    fail(page, 'structured data', 'MobileApplication has no "offers"');
    return;
  }
  for (const offer of offers) {
    const label = `offer "${offer.name ?? '(unnamed)'}"`;
    if (!typesOf(offer).includes('Offer')) fail(page, 'structured data', `${label} is not an Offer`);
    if (typeof offer.price !== 'string' && typeof offer.price !== 'number') fail(page, 'structured data', `${label} has no "price"`);
    else if (!/^\d+(\.\d+)?$/.test(String(offer.price))) fail(page, 'structured data', `${label} price "${offer.price}" is not a plain decimal number`);
    if (offer.priceCurrency !== currency) fail(page, 'structured data', `${label} priceCurrency is ${offer.priceCurrency ?? 'missing'}, expected ${currency} on a ${language} page`);
  }
  const pro = offers.filter((offer) => offer.name === 'Weave Pro');
  const shown = visiblePrices(read(page));
  if (shown.length === 0 && pro.length === 0) return;
  if (pro.length !== 1) {
    fail(page, 'structured data', `the page shows a price, so expected one offer named "Weave Pro", found ${pro.length}`);
    return;
  }
  if (shown.length !== 1) {
    fail(page, 'structured data', `expected one visible Pro price (.amount), found ${shown.length}`);
    return;
  }
  const visible = parseVisiblePrice(shown[0]);
  if (!visible) {
    fail(page, 'structured data', `cannot read a price and currency from the visible price "${shown[0]}"`);
    return;
  }
  if (visible.currency !== currency) fail(page, 'structured data', `visible price "${shown[0]}" is in ${visible.currency}, expected ${currency} on a ${language} page`);
  if (Number(pro[0].price).toFixed(2) !== visible.amount || pro[0].priceCurrency !== visible.currency) {
    fail(page, 'structured data', `Weave Pro offer is ${pro[0].price} ${pro[0].priceCurrency}, but the page shows "${shown[0]}"`);
  }
}

function checkApplicationNode(page, app) {
  const language = languageOf(page);
  const label = 'MobileApplication';
  for (const field of ['name', 'description', 'operatingSystem', 'applicationCategory']) requireText(page, app, field, label);
  if (app.name !== undefined && app.name !== 'Weave') fail(page, 'structured data', `${label} name is "${app.name}", expected "Weave"`);
  if (typeof app.operatingSystem === 'string' && !/\biOS\b/.test(app.operatingSystem)) fail(page, 'structured data', `${label} operatingSystem "${app.operatingSystem}" does not name iOS`);
  if (app.url !== urlOf(page)) fail(page, 'structured data', `${label} url is ${app.url ?? 'missing'}, expected ${urlOf(page)}`);
  if (app.inLanguage !== language) fail(page, 'structured data', `${label} inLanguage is ${app.inLanguage ?? 'missing'}, expected "${language}"`);
  if (app.image !== undefined) {
    const file = fileOfUrl(app.image);
    if (!file || !isFile(file)) fail(page, 'structured data', `${label} image ${app.image} does not resolve to a site file`);
  }
  if (app.aggregateRating !== undefined || app.review !== undefined) {
    fail(page, 'structured data', `${label} declares ratings or reviews; add them only once the App Store has real ones`);
  }
  const publisher = app.publisher;
  if (!publisher || !typesOf(publisher).includes('Organization')) fail(page, 'structured data', `${label} has no Organization "publisher"`);
  else {
    if (publisher.name !== 'Rinnebühl Labs') fail(page, 'structured data', `publisher name is "${publisher.name ?? ''}", expected "Rinnebühl Labs"`);
    if (!/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(publisher.email ?? '')) fail(page, 'structured data', 'publisher has no valid "email"');
  }
  checkOffers(page, app, language);
}

// App Store: each home page's hero links to the live listing (the radio spot sends phone users to the
// home page, so the button must be on the first screen), and every Smart App Banner names the app.
// English pages use the locale-neutral listing URL, German pages the /de/ one.
const APP_ID = '6798253561';
const APP_STORE_URL = { en: `https://apps.apple.com/app/id${APP_ID}`, de: `https://apps.apple.com/de/app/weave-workout-stories/id${APP_ID}` };

function checkAppStore(pagesByFile) {
  for (const loaded of pagesByFile.values()) {
    const expected = APP_STORE_URL[languageOf(loaded.page)];
    for (const reference of referencesOf(loaded).filter((reference) => /apps\.apple\.com/.test(reference))) {
      if (reference !== expected) fail(loaded.page, 'app store', `App Store link ${reference}, expected ${expected}`);
    }
    for (const tag of loaded.tags.filter((tag) => tag.name === 'meta' && tag.attributes.name === 'apple-itunes-app')) {
      if (tag.attributes.content !== `app-id=${APP_ID}`) fail(loaded.page, 'app store', `apple-itunes-app is "${tag.attributes.content}", expected "app-id=${APP_ID}"`);
    }
  }
  for (const page of HOME_PAGES) {
    const loaded = pagesByFile.get(page);
    if (!loaded) continue;
    const hero = stripScriptsAndComments(loaded.html).match(/<header\b[^>]*\bclass="[^"]*\bhero\b[^"]*"[^>]*>([\s\S]*?)<\/header>/i);
    if (!hero || !hero[1].includes(`href="${APP_STORE_URL[languageOf(page)]}"`)) fail(page, 'app store', 'the hero has no link to the App Store listing');
    if (!loaded.tags.some((tag) => tag.name === 'meta' && tag.attributes.name === 'apple-itunes-app')) fail(page, 'app store', 'missing <meta name="apple-itunes-app">');
  }
}

function checkStructuredData() {
  for (const page of HOME_PAGES) {
    if (!isFile(page)) continue;
    const blocks = jsonLdBlocks(read(page));
    if (blocks.length !== 1) {
      fail(page, 'structured data', `expected exactly one JSON-LD block, found ${blocks.length}`);
      if (blocks.length === 0) continue;
    }
    const data = parseJsonLd(page, blocks[0]);
    if (!data) continue;
    if (!/^https?:\/\/schema\.org\/?$/.test([data['@context']].flat()[0] ?? '')) fail(page, 'structured data', `@context is ${JSON.stringify(data['@context'])}, expected "https://schema.org"`);
    const apps = jsonLdNodes(data).filter((node) => typesOf(node).some((type) => type === 'MobileApplication' || type === 'SoftwareApplication'));
    if (apps.length !== 1) {
      fail(page, 'structured data', `expected one MobileApplication node, found ${apps.length}`);
      continue;
    }
    if (!typesOf(apps[0]).includes('MobileApplication')) fail(page, 'structured data', 'the app node should be typed MobileApplication');
    checkApplicationNode(page, apps[0]);
  }
}

// FAQ: the visible FAQ (#faq, one .faq-item per question: an <h3> question, then <p> answers)
// and the FAQPage node in the page's JSON-LD must say the same thing, in the same order,
// and both home pages must ask the same number of questions.

function visibleFaq(html) {
  const markup = stripScriptsAndComments(html);
  const section = markup.match(/<section\b[^>]*\bid="faq"[^>]*>([\s\S]*?)<\/section>/i);
  if (!section) return null;
  return section[1]
    .split(/<div\b[^>]*\bclass="[^"]*\bfaq-item\b[^"]*"[^>]*>/i)
    .slice(1)
    .map((item) => ({
      question: textOfElement(item.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? ''),
      answer: [...item.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(([, inner]) => textOfElement(inner)).join(' '),
    }));
}

function markedUpFaq(page, html) {
  const blocks = jsonLdBlocks(html);
  if (blocks.length !== 1) return null;
  let data;
  try {
    data = JSON.parse(blocks[0]);
  } catch {
    return null;
  }
  const faqs = jsonLdNodes(data).filter((node) => typesOf(node).includes('FAQPage'));
  if (faqs.length === 0) return null;
  if (faqs.length > 1) fail(page, 'faq', `expected one FAQPage node, found ${faqs.length}`);
  return [faqs[0].mainEntity].flat().filter(Boolean).map((entry, index) => {
    if (!typesOf(entry).includes('Question')) fail(page, 'faq', `FAQPage entry ${index + 1} is not a Question`);
    if (!typesOf(entry.acceptedAnswer).includes('Answer')) fail(page, 'faq', `FAQPage entry ${index + 1} has no Answer`);
    return {
      question: textOfElement(String(entry.name ?? '')),
      answer: textOfElement(String(entry.acceptedAnswer?.text ?? '')),
    };
  });
}

function checkFaq() {
  const counts = new Map();
  for (const page of HOME_PAGES) {
    if (!isFile(page)) continue;
    const html = read(page);
    const visible = visibleFaq(html);
    const marked = markedUpFaq(page, html);
    if (!visible) {
      fail(page, 'faq', 'no visible FAQ section with id="faq"');
      continue;
    }
    if (!marked) {
      fail(page, 'faq', 'the JSON-LD block has no FAQPage node for the visible FAQ');
      continue;
    }
    counts.set(page, visible.length);
    if (visible.length < 5 || visible.length > 7) fail(page, 'faq', `${visible.length} visible questions, expected 5 to 7`);
    if (marked.length !== visible.length) fail(page, 'faq', `FAQPage has ${marked.length} questions, the visible FAQ has ${visible.length}`);
    visible.forEach((item, index) => {
      const entry = marked[index];
      if (!item.question || !item.answer) fail(page, 'faq', `visible question ${index + 1} has no question or no answer text`);
      if (!entry) return;
      if (entry.question !== item.question) fail(page, 'faq', `question ${index + 1} is "${item.question}" on the page but "${entry.question}" in FAQPage`);
      if (entry.answer !== item.answer) fail(page, 'faq', `answer ${index + 1} ("${item.question}") differs between the page and FAQPage`);
    });
  }
  const [english, german] = HOME_PAGES.map((page) => counts.get(page));
  if (english !== undefined && german !== undefined && english !== german) {
    fail('de/index.html', 'faq', `${german} FAQ questions, index.html has ${english}`);
  }
}

// Titles: "Weave" alone collides with unrelated brands, so each home page's title and at
// least one visible heading must name Weave together with "app" and what it does (workouts),
// the title must fit a search result, and share titles/descriptions must repeat the page's own.

const TITLE_MAX_LENGTH = 60;

function namesTheApp(text) {
  return /\bWeave\b/.test(text) && /\bapp\b/i.test(text) && /workout/i.test(text);
}

function metaContent(loaded, key, value) {
  return loaded.tags
    .filter((tag) => tag.name === 'meta' && tag.attributes[key] === value)
    .map((tag) => textOfElement(tag.attributes.content ?? ''));
}

function checkAppTitles(pagesByFile) {
  for (const page of HOME_PAGES) {
    const loaded = pagesByFile.get(page);
    if (!loaded) continue;
    const markup = stripScriptsAndComments(loaded.html);
    const titles = [...markup.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map(([, inner]) => textOfElement(inner));
    if (titles.length !== 1) {
      fail(page, 'title', `expected one <title>, found ${titles.length}`);
      continue;
    }
    const [title] = titles;
    if (!namesTheApp(title)) fail(page, 'title', `"${title}" must name "Weave", "app" and what it does (workout …)`);
    if ([...title].length > TITLE_MAX_LENGTH) fail(page, 'title', `"${title}" is ${[...title].length} characters, keep it within ${TITLE_MAX_LENGTH}`);

    const headings = [...markup.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map(([, , inner]) => textOfElement(inner));
    if (!headings.some(namesTheApp)) fail(page, 'title', 'no <h1>–<h3> names "Weave", "app" and what it does (workout …)');

    const description = metaContent(loaded, 'name', 'description');
    if (description.length !== 1 || description[0] === '') fail(page, 'title', `expected one non-empty meta description, found ${description.length}`);
    for (const [key, value, expected] of [
      ['property', 'og:title', title],
      ['name', 'twitter:title', title],
      ['property', 'og:description', description[0]],
      ['name', 'twitter:description', description[0]],
    ]) {
      const found = metaContent(loaded, key, value);
      if (found.length !== 1) fail(page, 'title', `expected one ${value}, found ${found.length}`);
      else if (found[0] !== expected) fail(page, 'title', `${value} is "${found[0]}", expected it to match the page's ${value.split(':')[1]}`);
    }
  }
}

// Images: what a visitor's browser downloads, and whether it can reserve the space before it arrives.

const IMAGE_BUDGET_BYTES = 150 * 1024;
const FIRST_LOAD_IMAGE_BUDGET_BYTES = 400 * 1024;
const IMAGE_SOURCES_DIR = 'assets/source/';

function pngSize(bytes) {
  const signature = '89504e470d0a1a0a';
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== signature) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function webpSize(bytes) {
  if (bytes.length < 30 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  return null;
}

function intrinsicSize(file) {
  const bytes = readFileSync(join(ROOT, file));
  return pngSize(bytes) ?? webpSize(bytes);
}

function srcsetFiles(srcset) {
  return (srcset ?? '')
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

// Every <img> in document order, with the <source>s of its <picture> and whether it comes after the
// page's first <section>: the hero (nav, header, screenshot strip) is the first screen, the rest is below it.
function imagesOf(loaded) {
  const markup = stripScriptsAndComments(loaded.html);
  const images = [];
  let sources = null;
  let pastFirstSection = false;
  for (const [, closing, name, source] of markup.matchAll(/<(\/?)(picture|source|img|section)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const tag = name.toLowerCase();
    const attributes = parseAttributes(source);
    if (tag === 'section' && !closing) pastFirstSection = true;
    else if (tag === 'picture') sources = closing ? null : [];
    else if (tag === 'source' && sources) sources.push(attributes);
    else if (tag === 'img') images.push({ attributes, sources: sources ?? [], pastFirstSection });
  }
  return images;
}

function localFile(page, reference) {
  const target = reference ? targetOf(page, reference) : null;
  return target && isFile(target.file) ? target.file : null;
}

// The file a current browser fetches for an image: the first <source> of its <picture>, else the <img> itself.
function fetchedFile(page, image) {
  const [first] = image.sources;
  const candidates = first ? srcsetFiles(first.srcset) : [image.attributes.src];
  const files = candidates.map((reference) => localFile(page, reference)).filter(Boolean);
  return files.sort((a, b) => statSync(join(ROOT, b)).size - statSync(join(ROOT, a)).size)[0] ?? null;
}

function checkImageDimensions(loaded) {
  for (const image of imagesOf(loaded)) {
    const { src = '', width, height } = image.attributes;
    const declared = { width: Number(width), height: Number(height) };
    if (!/^[1-9]\d*$/.test(width ?? '') || !/^[1-9]\d*$/.test(height ?? '')) {
      fail(loaded.page, 'images', `${src} does not declare its width and height`);
      continue;
    }
    const file = localFile(loaded.page, src);
    const actual = file && intrinsicSize(file);
    if (actual && (actual.width !== declared.width || actual.height !== declared.height)) {
      fail(loaded.page, 'images', `${src} declares ${width}×${height}, the file is ${actual.width}×${actual.height}`);
    }
    for (const reference of image.sources.flatMap((source) => srcsetFiles(source.srcset))) {
      const sourceFile = localFile(loaded.page, reference);
      const size = sourceFile && intrinsicSize(sourceFile);
      if (size && Math.abs(size.width / size.height - declared.width / declared.height) > 0.005) {
        fail(loaded.page, 'images', `${reference} is ${size.width}×${size.height}, not the ${width}×${height} shape its <img> declares`);
      }
    }
  }
}

function checkImageWeight(loaded) {
  const images = imagesOf(loaded);
  const icons = linkTagsWithRel(loaded, 'icon').map((tag) => localFile(loaded.page, tag.attributes.href));
  const referenced = new Set([
    ...images.flatMap((image) => [
      image.attributes.src,
      ...image.sources.flatMap((source) => srcsetFiles(source.srcset)),
    ]).map((reference) => localFile(loaded.page, reference)),
    ...icons,
  ].filter(Boolean));
  for (const file of referenced) {
    const bytes = statSync(join(ROOT, file)).size;
    if (bytes > IMAGE_BUDGET_BYTES) fail(loaded.page, 'image weight', `${file} is ${Math.round(bytes / 1024)} KB, over the ${IMAGE_BUDGET_BYTES / 1024} KB budget per image`);
  }
  const firstLoad = new Set([
    ...images.filter((image) => image.attributes.loading !== 'lazy').map((image) => fetchedFile(loaded.page, image)),
    ...icons,
  ].filter(Boolean));
  const total = [...firstLoad].reduce((sum, file) => sum + statSync(join(ROOT, file)).size, 0);
  if (total > FIRST_LOAD_IMAGE_BUDGET_BYTES) {
    fail(loaded.page, 'image weight', `first load fetches ${Math.round(total / 1024)} KB of images, over the ${FIRST_LOAD_IMAGE_BUDGET_BYTES / 1024} KB budget`);
  }
}

function checkLazyLoading(loaded) {
  for (const { attributes, pastFirstSection } of imagesOf(loaded)) {
    const lazy = attributes.loading === 'lazy';
    if (pastFirstSection && !lazy) fail(loaded.page, 'lazy loading', `${attributes.src} is below the first screen but not loading="lazy"`);
    if (!pastFirstSection && lazy) fail(loaded.page, 'lazy loading', `${attributes.src} is on the first screen but loading="lazy"`);
  }
}

function checkImageSourcesUnreferenced(loaded) {
  for (const reference of referencesOf(loaded)) {
    const file = localFile(loaded.page, reference);
    if (file?.startsWith(IMAGE_SOURCES_DIR)) fail(loaded.page, 'images', `${reference} is a full-resolution original; reference the resized copy`);
  }
  for (const image of imagesOf(loaded)) {
    for (const reference of image.sources.flatMap((source) => srcsetFiles(source.srcset))) {
      const file = localFile(loaded.page, reference);
      if (file?.startsWith(IMAGE_SOURCES_DIR)) fail(loaded.page, 'images', `${reference} is a full-resolution original; reference the resized copy`);
      if (!file && !isExternal(reference)) fail(loaded.page, 'links', `srcset ${reference} does not exist`);
    }
  }
}

function checkImages(loaded) {
  checkImageDimensions(loaded);
  checkImageWeight(loaded);
  checkLazyLoading(loaded);
  checkImageSourcesUnreferenced(loaded);
}

// Headline: the rotating word is visual only. Its words are drawn from data-word by CSS, inside an
// aria-hidden box, so the heading's text is one sentence for crawlers and screen readers alike.

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
    ndash: '–', mdash: '—', hellip: '…', euro: '€', middot: '·', rarr: '→', times: '×',
  };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    return named[code.toLowerCase()] ?? entity;
  });
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// The heading's text two ways: as a crawler reads the markup (text nodes, <br> as a break), and as a
// screen reader gets it (aria-hidden subtrees dropped, CSS-drawn data-word text included). Also the
// rotating words: the data-word or text of each .word-track item.
function readHeading(innerHtml) {
  let crawled = '';
  let spoken = '';
  const rotating = [];
  const stack = [];
  const hidden = () => stack.some((element) => element.hidden);
  const inTrack = () => stack.at(-2)?.track;
  for (const [, text, closing, name, source] of innerHtml.matchAll(/([^<]+)|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    if (text !== undefined) {
      const decoded = decodeEntities(text);
      crawled += decoded;
      if (!hidden()) spoken += decoded;
      if (inTrack()) stack.at(-1).words.push(decoded);
      continue;
    }
    const tag = name.toLowerCase();
    if (closing) {
      const element = stack.pop();
      if (element && stack.at(-1)?.track) rotating.push(collapse(element.words.join('')));
      continue;
    }
    if (tag === 'br') {
      crawled += ' ';
      if (!hidden()) spoken += ' ';
      continue;
    }
    if (VOID_ELEMENTS.has(tag) || source.trim().endsWith('/')) continue;
    const attributes = parseAttributes(source);
    const element = { hidden: attributes['aria-hidden'] === 'true', track: hasToken(attributes.class, 'word-track'), words: [] };
    stack.push(element);
    if (attributes['data-word'] !== undefined) {
      const word = decodeEntities(attributes['data-word']);
      if (!hidden()) spoken += word;
      if (inTrack()) element.words.push(word);
    }
  }
  return { crawled: collapse(crawled), spoken: collapse(spoken), rotating: [...new Set(rotating.filter(Boolean))] };
}

function occurrences(text, word) {
  return text.split(word).length - 1;
}

// Each home page leads with one <h1>, and it is the one with the rotating word.
function checkHomeHeadline(pagesByFile) {
  for (const page of HOME_PAGES) {
    const loaded = pagesByFile.get(page);
    if (!loaded) continue;
    const headings = [...stripScriptsAndComments(loaded.html).matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
    if (headings.length !== 1) {
      fail(page, 'headline', `expected exactly one <h1>, found ${headings.length}`);
      continue;
    }
    if (!/class="[^"]*\bword-track\b/.test(headings[0][1])) fail(page, 'headline', 'the <h1> has no rotating word (.word-track)');
  }
}

function checkHeadlineText(loaded) {
  const markup = stripScriptsAndComments(loaded.html);
  for (const [, innerHtml] of markup.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)) {
    const { crawled, spoken, rotating } = readHeading(innerHtml);
    if (crawled !== spoken) fail(loaded.page, 'headline', `<h1> reads "${crawled}" to crawlers but "${spoken}" to screen readers`);
    if (/[.!?,:;][^\s.!?,:;"'”“)]/u.test(crawled)) fail(loaded.page, 'headline', `<h1> runs words together: "${crawled}"`);
    if (rotating.length === 0) continue;
    const [first, ...others] = rotating;
    const count = occurrences(crawled, first);
    if (count !== 1) fail(loaded.page, 'headline', `<h1> text "${crawled}" contains its first rotating word "${first}" ${count} times, expected once`);
    for (const word of others.filter((other) => !first.includes(other))) {
      if (occurrences(crawled, word) > 0) fail(loaded.page, 'headline', `<h1> text "${crawled}" contains the rotating word "${word}"; draw it from data-word`);
    }
  }
}

function checkNotFoundPage(pagesByFile) {
  const loaded = pagesByFile.get(NOT_FOUND_PAGE);
  if (!loaded) {
    fail(NOT_FOUND_PAGE, '404', `${NOT_FOUND_PAGE} does not exist`);
    return;
  }
  const robots = loaded.tags.filter((tag) => tag.name === 'meta' && tag.attributes.name?.toLowerCase() === 'robots');
  if (!robots.some((tag) => /\bnoindex\b/i.test(tag.attributes.content ?? ''))) {
    fail(NOT_FOUND_PAGE, '404', 'missing <meta name="robots" content="noindex">');
  }
  // GitHub Pages serves 404.html at the missing path (e.g. /de/foo), so relative URLs would break.
  for (const reference of referencesOf(loaded)) {
    if (reference === '' || reference.startsWith('#') || isExternal(reference)) continue;
    if (!reference.startsWith('/')) fail(NOT_FOUND_PAGE, '404', `${reference} is relative; use a root-absolute URL`);
  }
  const homes = new Set(loaded.tags.filter((tag) => tag.name === 'a' && tag.attributes.href !== undefined)
    .map((tag) => targetOf(NOT_FOUND_PAGE, tag.attributes.href.trim())?.file));
  for (const home of ['index.html', 'de/index.html']) {
    if (!homes.has(home)) fail(NOT_FOUND_PAGE, '404', `no link to the ${home === 'index.html' ? 'English' : 'German'} home page`);
  }
}

function report() {
  for (const { page, check, message } of failures) console.log(`FAIL ${page} [${check}] ${message}`);
  console.log(failures.length === 0 ? 'All site checks passed.' : `\n${failures.length} failure(s).`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

function main() {
  const pages = discoverPages();
  const pagesByFile = new Map(pages.map((page) => [page, loadPage(page)]));
  const pairedPages = pages.filter((page) => !UNPAIRED_PAGES.has(page));
  for (const loaded of pagesByFile.values()) {
    checkLinks(loaded, pagesByFile);
    checkNoIndexHtmlLinks(loaded);
    if (!UNPAIRED_PAGES.has(loaded.page)) checkTwin(loaded);
    checkImages(loaded);
    checkHeadlineText(loaded);
  }
  checkSitemap(pairedPages);
  checkNotFoundPage(pagesByFile);
  checkHomeHeadline(pagesByFile);
  checkIndexStructure(pagesByFile);
  checkRedirect();
  checkStructuredData();
  checkAppStore(pagesByFile);
  checkFaq();
  checkAppTitles(pagesByFile);
  report();
}

main();
