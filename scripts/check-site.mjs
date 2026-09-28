#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import vm from 'node:vm';

const BASE_URL = 'https://weave.rinnebuehl.de';
const ROOT = process.cwd();

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

function fileOfUrl(url) {
  if (!url.startsWith(`${BASE_URL}/`)) return null;
  const path = url.slice(BASE_URL.length + 1).replace(/[?#].*$/, '');
  return path === '' || path.endsWith('/') ? `${path}index.html` : path;
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
  const [pathAndQuery, fragment = ''] = reference.split('#');
  const path = pathAndQuery.split('?')[0];
  if (path === '') return { file: page, fragment };
  const joined = path.startsWith('/') ? path.slice(1) : join(dirname(page), path);
  const file = normalize(joined).replace(/\\/g, '/');
  const target = file === '.' || path.endsWith('/') ? join(file, 'index.html') : file;
  return { file: target.replace(/\\/g, '/'), fragment: decodeURIComponent(fragment) };
}

function referencesOf(loaded) {
  const references = loaded.tags.flatMap((tag) =>
    ['href', 'src'].filter((name) => tag.attributes[name] !== undefined).map((name) => tag.attributes[name].trim()),
  );
  return [...new Set(references)];
}

function checkLinks(loaded, pagesByFile) {
  for (const reference of referencesOf(loaded)) {
    if (reference === '' || isExternal(reference)) continue;
    const { file, fragment } = resolveReference(loaded.page, reference);
    if (file.startsWith('..')) {
      fail(loaded.page, 'links', `${reference} points outside the site`);
      continue;
    }
    if (!isFile(file)) {
      fail(loaded.page, 'links', `${reference} does not exist (${file})`);
      continue;
    }
    if (fragment === '' || !file.endsWith('.html')) continue;
    const target = pagesByFile.get(file) ?? loadPage(file);
    if (!target.ids.has(fragment)) fail(loaded.page, 'links', `${reference} has no element with id "${fragment}" in ${file}`);
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
  for (const url of locations) {
    const file = fileOfUrl(url);
    if (!file || !isFile(file)) fail('sitemap.xml', 'sitemap', `${url} has no matching file`);
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

function createStorage({ saved, throws }) {
  const entries = new Map(saved ? [['weave-lang', saved]] : []);
  const guard = () => {
    if (throws) throw new Error('SecurityError: storage is blocked');
  };
  return {
    entries,
    getItem: (key) => (guard(), entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => (guard(), entries.set(key, String(value))),
    removeItem: (key) => (guard(), entries.delete(key)),
  };
}

function runRedirect(script, { languages, language, search = '', hash = '', saved, throws = false }) {
  const redirects = [];
  const storage = createStorage({ saved, throws });
  const context = {
    location: { search, hash, replace: (url) => redirects.push(url), assign: (url) => redirects.push(url) },
    navigator: { languages, language },
    localStorage: storage,
    URLSearchParams,
  };
  vm.runInNewContext(script, context, { timeout: 1000 });
  return { redirects, stored: storage.entries.get('weave-lang') };
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
  report();
}

main();
