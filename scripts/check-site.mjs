#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const BASE_URL = 'https://workoutstories.app';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];

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

// Structured data: each home page carries exactly one JSON-LD block describing the app.
// Its offers must be priced in the page's currency, and the Weave Pro offer must state
// the same price the visitor sees in the Pro band.

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

function textOfElement(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
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
  if (pro.length !== 1) {
    fail(page, 'structured data', `expected one offer named "Weave Pro", found ${pro.length}`);
    return;
  }
  const shown = visiblePrices(read(page));
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

function report() {
  for (const { page, check, message } of failures) console.log(`FAIL ${page} [${check}] ${message}`);
  console.log(failures.length === 0 ? 'All site checks passed.' : `\n${failures.length} failure(s).`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

function main() {
  const pages = discoverPages();
  const pagesByFile = new Map(pages.map((page) => [page, loadPage(page)]));
  for (const loaded of pagesByFile.values()) {
    checkLinks(loaded, pagesByFile);
    checkTwin(loaded);
  }
  checkSitemap(pages);
  checkIndexStructure(pagesByFile);
  checkRedirect();
  checkStructuredData();
  report();
}

main();
