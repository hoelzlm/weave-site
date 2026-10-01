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
    checkImages(loaded);
  }
  checkSitemap(pages);
  checkIndexStructure(pagesByFile);
  checkRedirect();
  report();
}

main();
