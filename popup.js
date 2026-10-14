const $ = id => document.getElementById(id);
const statusEl = $('status'), resultsEl = $('results'), copyBtn = $('copy'), rerunBtn = $('rerun'), fillEl = $('fill');
const CONCURRENCY = 4;
const ALWAYS_AUDIT = [{ path: '/terms-and-conditions', label: 'Terms & Conditions' }];
let rows = [];
let live = null;                 // snapshot of the open tab: contact-link flags + header issues
const selected = new Set();      // urls ticked for "Copy selected"

// Opened in the larger window (via the ⤢ button) the page to audit is passed as ?tab=<id>.
const TARGET_TAB = +new URLSearchParams(location.search).get('tab') || null;
if (TARGET_TAB) { document.body.classList.add('full'); $('expand').hidden = true; }
$('expand').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.windows.create({ url: chrome.runtime.getURL('popup.html') + '?tab=' + tab.id, type: 'popup', width: 1280, height: 860 });
  window.close();
});

// ---------- runs inside the page (must be self-contained) ----------
function extractLinks() {
  const sources = [
    ['Navbar', '#global-navbar a[href]'],
    ['Menu', '#global-sidemenu a[href]'],
    ['Footer', '.footer-navigation a[href], .footer-navigation-row a[href]']
  ];
  const txt = el => el.textContent.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  const out = [];
  let found = false;
  for (const [source, sel] of sources) {
    const els = document.querySelectorAll(sel);
    if (els.length) found = true;
    els.forEach(a => {
      const raw = a.getAttribute('href').trim();
      if (!raw || raw.startsWith('#') || /^(tel|mailto|sms|javascript):/i.test(raw)) return;
      let u;
      try { u = new URL(raw, location.href); } catch { return; }
      if (u.origin !== location.origin) return;
      const text = txt(a);
      if (/search portal|^home search$/i.test(text) || /^\/home-search(\/|$)/.test(u.pathname)) return; // skip Home Search + My Search Portal
      out.push({ href: u.href, text, source });
    });
  }

  // Header + footer: empty links (no href / "#" / javascript:) and links with no text or label.
  const areas = [
    ['Header', '#global-navbar a, header a'],
    ['Footer', 'footer a, [id*="footer" i] a, [class*="footer" i] a']
  ];
  const headerEls = [];
  const areaOf = new Map();
  const areaCounts = {};
  for (const [area, sel] of areas) {
    areaCounts[area] = 0;
    document.querySelectorAll(sel).forEach(a => {
      if (areaOf.has(a)) return;
      areaOf.set(a, area); headerEls.push(a); areaCounts[area]++;
    });
  }
  const headerIssues = [];
  for (const a of headerEls) {
    const area = areaOf.get(a);
    const href = (a.getAttribute('href') || '').trim();
    const text = txt(a);
    const label = (a.getAttribute('aria-label') || a.getAttribute('title') || a.querySelector('img[alt]')?.getAttribute('alt')
      || a.querySelector('svg title')?.textContent || '').trim();
    const li = a.closest('li');
    const sub = li && li.querySelector('ul, .sub-nav, .dropdown-menu');
    const isTrigger = (sub && !sub.contains(a)) ||
      ['data-type', 'data-toggle', 'data-bs-toggle', 'data-target', 'onclick', 'aria-haspopup', 'aria-controls', 'aria-expanded']
        .some(n => a.hasAttribute(n)) || a.getAttribute('role') === 'button' || a.classList.contains('toggle');
    const emptyHref = !href || href === '#' || /^javascript:\s*(void\(0\))?;?\s*$/i.test(href);
    const snippet = a.outerHTML.replace(/\s+/g, ' ').slice(0, 130);
    // Exemption: logo links (an image link to the home page, e.g. <a class="logo__link"><img alt=""></a>)
    // Exemption: cookie / privacy consent trigger (<a class="lp-consent-link" href="#">Your Privacy Choices</a>)
    if (/consent/i.test(a.className) || /^your privacy choices$/i.test(text)) continue;
    if (/logo/i.test(a.className) || a.closest('[class*="logo" i]') || (/^\/?$/.test(href) && a.querySelector('img, svg'))) continue;
    if (emptyHref && !isTrigger) headerIssues.push({ area, kind: `Empty link (href="${href}")`, name: text || label || '(no text)', snippet });
    else if (!text && !label && !a.querySelector('img, svg')) headerIssues.push({ area, kind: 'Empty link: no text, label or icon', name: '(no text)', snippet });
    else if (!text && !label) headerIssues.push({ area, kind: 'Link has no text or aria-label (icon only)', name: '(icon only)', snippet });
  }

  // Contact links in the live DOM (catches menus/footers rendered by JavaScript).
  const contacts = [...document.querySelectorAll('a[href^="mailto:" i], a[href^="tel:" i], a[href^="sms:" i]')]
    .map(a => ({ href: a.getAttribute('href'), text: txt(a) }));

  if (!found && !headerEls.length) return { error: 'No #global-navbar, #global-sidemenu, header or footer navigation found on this page.' };
  return { origin: location.origin, pageUrl: location.href, links: out, headerIssues, headerCount: headerEls.length, areaCounts, contacts };
}

const clean = s => (s || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
const samePath = (a, b) => {
  const p = u => new URL(u).pathname.replace(/\/$/, '') || '/';
  return p(a) === p(b);
};

function buildList(links, origin, pageUrl) {
  const extra = ALWAYS_AUDIT.map(e => ({ href: origin + e.path, text: e.label, source: 'Default' }));
  const seen = new Set();
  return [{ href: origin + '/', text: 'Home', source: 'Default' },
          { href: pageUrl, text: 'Current page', source: 'Current' }, ...links, ...extra]
    .map(l => { const u = new URL(l.href); u.search = ''; u.hash = ''; return { ...l, href: u.href }; })
    .filter(l => {
      const key = new URL(l.href).pathname.replace(/\/$/, '') || '/';
      if (seen.has(key)) return false; // links repeated in menu/footer are only checked once
      seen.add(key);
      return true;
    });
}

// tel:/sms:/mailto: links whose visible number or email doesn't match the href.
function checkContactLinks(items) {
  const flags = new Set();
  const digits = s => {
    let d = s.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1); // drop US country code
    return d;
  };
  const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };
  for (const it of items) {
    const href = (it.href || '').trim();
    const m = href.match(/^(mailto|tel|sms):(.*)$/i);
    if (!m) continue;
    const scheme = m[1].toLowerCase();
    const target = decode(m[2]).split('?')[0].split(';')[0].trim();
    const text = clean(it.text);
    if (scheme === 'mailto') {
      const targets = target.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      if (!targets.length || !targets.every(t => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)))
        flags.add(`Invalid mailto: href is "${href}"`);
      const shown = (text.match(/[^\s<>()"',;:]+@[^\s<>()"',;]+\.[^\s<>()"',;]+/g) || []).map(s => s.replace(/[.]+$/, ''));
      if (shown.length && !shown.some(s => targets.includes(s.toLowerCase())))
        flags.add(`Email mismatch: shows ${shown[0]} but href is mailto:${target}`);
    } else {
      if (!digits(target)) flags.add(`Invalid ${scheme}: href is "${href}"`);
      const shown = text.match(/\+?[\d(][\d\s().\-]{6,}\d/);
      if (shown && digits(shown[0]) !== digits(target))
        flags.add(`${scheme === 'tel' ? 'Phone' : 'SMS'} mismatch: shows ${shown[0].trim()} but href is ${scheme}:${target}`);
    }
  }
  return [...flags];
}

async function audit(link, probeTitle) {
  const row = { url: link.href, label: link.text, source: link.source, probe: !!link.probe,
                status: null, title: '', description: '', text: '', error: '', flags: [] };
  try {
    // Always hit the network: no HTTP cache, nothing stored by the extension.
    const res = await fetch(link.href, {
      credentials: 'include', redirect: 'follow', cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
    row.status = res.status;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    row.title = clean(doc.querySelector('title')?.textContent);
    row.description = clean(doc.querySelector('meta[name="description" i]')?.getAttribute('content'));

    const contact = [...doc.querySelectorAll('a[href^="mailto:" i], a[href^="tel:" i], a[href^="sms:" i]')]
      .map(a => ({ href: a.getAttribute('href'), text: a.textContent }));
    // Visible text of the page, kept for the sitewide word search.
    doc.querySelectorAll('script, style, noscript, template').forEach(n => n.remove());
    // Testimonial sections (sliders, lists, cards, modals) are always left out of the word search.
    // Skips <body>/<html> and any wrapper that also holds the header, footer or nav, so a class like
    // "testimonials-page" on a layout wrapper can't wipe out the whole page.
    doc.querySelectorAll('[class*="testimonial" i], [id*="testimonial" i]').forEach(n => {
      if (n === doc.body || n === doc.documentElement || n.querySelector('header, footer, nav, #global-navbar, #global-sidemenu')) return;
      n.remove();
    });
    row.text = clean(doc.body?.textContent);
    // For the open page, also use the live DOM (covers contact links added by JavaScript).
    if (live && !link.probe && samePath(link.href, live.pageUrl)) contact.push(...live.contacts);
    row.flags.push(...checkContactLinks(contact));

    const wantPath = new URL(link.href).pathname.replace(/\/$/, '');
    const gotPath = new URL(res.url).pathname.replace(/\/$/, '');

    if (row.probe) {
      if (res.status !== 404) row.flags.push(`No real 404: server returned ${res.status}`);
    } else {
      if (res.status === 404 || res.status === 410) row.flags.push('404 NOT FOUND');
      else if (res.status >= 400) row.flags.push(`HTTP ${res.status}`);
      else if (probeTitle && res.status === 200 && row.title === probeTitle) row.flags.push('Soft 404 (same title as 404 page)');
      if (wantPath !== gotPath) row.flags.push(`Redirects to ${gotPath || '/'}`);
    }
  } catch (e) {
    row.error = e.message;
    row.flags.push('Request failed: ' + e.message);
  }
  return row;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function field(key, val, len, min, max) {
  const bad = len < min || len > max;
  return `<div class="field"><span class="k"><span class="kl">${key}</span>
      <button class="qcopy" title="Copy ${key.toLowerCase()}" ${val ? '' : 'disabled'} data-text="${esc(val)}">Copy</button></span>
    <span class="v ${val ? '' : 'missing'}">${val ? esc(val) : 'MISSING'}</span>
    <span class="len ${bad ? 'bad' : ''}">${bad ? '✗' : '✓'} ${len}</span></div>`;
}

function render(row) {
  const div = document.createElement('div');
  const broken = row.flags.length > 0;
  div.className = 'page' + (broken ? ' broken' : '') + (selected.has(row.url) ? ' selected' : '');
  const statusOk = row.probe ? row.status === 404 : row.status === 200;
  const flags = row.flags.map(f => `<span class="flag">⚠ ${esc(f)}</span>`).join('');
  div.dataset.url = row.url;
  div.innerHTML = `
    <div class="head">
      <input type="checkbox" class="sel" title="Select for Copy selected" ${selected.has(row.url) ? 'checked' : ''}>
      <div class="ttl"><span class="name">${esc(row.label)}</span><span class="src">${esc(row.source)}</span></div>
      <span class="badge ${statusOk ? '' : 'bad'}">${row.status ?? 'ERR'}</span>
      <button class="rerun1" title="Re-run this page">↻</button></div>
    <a class="url" href="${esc(row.url)}" title="${esc(row.url)}" target="_blank">${esc(row.url)}</a>
    ${flags ? `<div class="flags">${flags}</div>` : ''}
    ${field('Title', row.title, row.title.length, 45, 60)}
    ${field('Description', row.description, row.description.length, 145, 160)}`;
  resultsEl.appendChild(div);
  return div;
}

function renderHeaderCard() {
  const div = document.createElement('div');
  const issues = live.headerIssues;
  div.className = 'page hdr' + (issues.length ? ' broken' : '');
  let body = '';
  for (const area of ['Header', 'Footer']) {
    const n = live.areaCounts?.[area] || 0;
    const mine = issues.filter(i => i.area === area);
    if (!n) body += `<div class="okline muted">No ${area.toLowerCase()} found on this page.</div>`;
    else if (!mine.length) body += `<div class="okline">✓ ${area}: no empty links (${n} links checked)</div>`;
    else body += mine.map(i => `<span class="flag">⚠ ${area}: ${esc(i.kind)}: ${esc(i.name)}</span><code class="snip">${esc(i.snippet)}</code>`).join('');
  }
  div.innerHTML = `<div class="head"><span class="name">Header &amp; footer links</span><span class="src">Live page</span></div>${body}`;
  resultsEl.appendChild(div);
}

// ---------- results interactions ----------
resultsEl.addEventListener('click', async e => {
  // quick copy of a single title / description
  const qc = e.target.closest('.qcopy');
  if (qc && !qc.disabled) {
    await navigator.clipboard.writeText(qc.dataset.text);
    qc.textContent = 'Copied ✓';
    qc.classList.add('done');
    setTimeout(() => { qc.textContent = 'Copy'; qc.classList.remove('done'); }, 1200);
    return;
  }
  // re-run a single page, replacing its card in place
  const btn = e.target.closest('.rerun1');
  if (!btn) return;
  const card = btn.closest('.page');
  const idx = rows.findIndex(r => r.url === card.dataset.url);
  if (idx < 0) return;
  const old = rows[idx];
  btn.disabled = true;
  btn.classList.add('spin');
  const fresh = await audit({ href: old.url, text: old.label, source: old.source, probe: old.probe },
                            old.probe ? undefined : (rows.find(r => r.probe)?.title));
  rows[idx] = fresh;
  const next = render(fresh);
  card.replaceWith(next);
  updateSummary();
  refreshFind();
});

resultsEl.addEventListener('change', e => {
  const cb = e.target.closest('.sel');
  if (!cb) return;
  const card = cb.closest('.page');
  cb.checked ? selected.add(card.dataset.url) : selected.delete(card.dataset.url);
  card.classList.toggle('selected', cb.checked);
  updateSelection();
});

$('selall').addEventListener('change', e => {
  rows.forEach(r => e.target.checked ? selected.add(r.url) : selected.delete(r.url));
  resultsEl.querySelectorAll('.page[data-url]').forEach(card => {
    const on = selected.has(card.dataset.url);
    card.classList.toggle('selected', on);
    card.querySelector('.sel').checked = on;
  });
  updateSelection();
});

function updateSelection() {
  const n = rows.filter(r => selected.has(r.url)).length;
  $('copysel').textContent = `Copy selected (${n})`;
  $('copysel').disabled = n === 0;
  $('selall').checked = rows.length > 0 && n === rows.length;
}

function formatRows(list) {
  const mode = $('fmt').value;
  return list.map(r => {
    const lines = [`${r.url}${r.flags.length ? '  [' + r.flags.join('; ') + ']' : ''}`];
    if (mode !== 'desc') lines.push(`Title: ${r.title || '(missing)'}`);
    if (mode !== 'title') lines.push(`Description: ${r.description || '(missing)'}`);
    return lines.join('\n');
  }).join('\n\n');
}

async function copyWithFeedback(btn, label, text) {
  await navigator.clipboard.writeText(text);
  btn.textContent = 'Copied!';
  setTimeout(() => (btn.textContent = label()), 1500);
}
// Appended after the copied SEO when "Copy all" is clicked.
const AI_PROMPT = 'Analyze these seo titles and description, find the pattern on how they were formed,. the charater reqirement is 46-60 in title and 146-160 in description. And then after analyzing, build me seo title and description for these pages: ';
copyBtn.addEventListener('click', () => copyWithFeedback(copyBtn, () => 'Copy all', formatRows(rows) + '\n\n' + AI_PROMPT));
$('copysel').addEventListener('click', () =>
  copyWithFeedback($('copysel'), () => `Copy selected (${rows.filter(r => selected.has(r.url)).length})`,
    formatRows(rows.filter(r => selected.has(r.url)))));
rerunBtn.addEventListener('click', run);

function updateSummary() {
  const broken = rows.filter(r => !r.probe && r.flags.some(f => /404|HTTP|failed/i.test(f))).length;
  const seoIssues = rows.filter(r => !r.title || !r.description).length;
  const contact = rows.filter(r => r.flags.some(f => /mismatch|invalid/i.test(f))).length;
  const hdr = live ? live.headerIssues.length : 0;
  const stat = (n, label, plural) => `<span class="stat ${n ? 'bad' : ''}">${n ? '' : '✓ '}${n} ${label}${n === 1 || !plural ? '' : 's'}</span>`;
  statusEl.innerHTML = `<span class="stat neutral">${rows.length} pages</span>` +
    stat(broken, 'broken link', true) + stat(seoIssues, 'missing SEO tag', true) +
    stat(contact, 'phone/email issue', true) + stat(hdr, 'empty header/footer link', true);
}

async function run() {
  rows = [];
  resultsEl.innerHTML = '';
  copyBtn.disabled = rerunBtn.disabled = $('selall').disabled = true;
  fillEl.style.width = '0';
  statusEl.textContent = 'Reading page…';
  updateSelection();

  const tab = TARGET_TAB ? await chrome.tabs.get(TARGET_TAB) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  let data;
  try {
    [{ result: data }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractLinks });
  } catch (e) {
    statusEl.textContent = 'Cannot run on this page: ' + e.message;
    rerunBtn.disabled = false;
    return;
  }
  if (data.error) { statusEl.textContent = data.error; rerunBtn.disabled = false; return; }
  live = data;

  $('site').textContent = new URL(data.origin).host;
  const links = buildList(data.links, data.origin, data.pageUrl);
  const probe = { href: `${data.origin}/seo-audit-404-check-${Date.now()}`, text: '404 Page', source: 'Default', probe: true };
  const total = links.length + 1;
  let done = 0, i = 0;
  const tick = () => {
    statusEl.textContent = `Auditing ${++done}/${total}…`;
    fillEl.style.width = (done / total * 100) + '%';
  };
  statusEl.textContent = `Auditing 0/${total}…`;

  // 404 page first, so we can detect soft 404s (200 status, 404 page content).
  const probeRow = await audit(probe);
  tick();

  const results = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < links.length) {
      results.push(await audit(links[i++], probeRow.title));
      tick();
    }
  }));

  const order = new Map(links.map((l, n) => [l.href, n]));
  results.sort((a, b) => order.get(a.url) - order.get(b.url));
  rows = [...results, probeRow];
  renderHeaderCard();
  rows.forEach(render);

  updateSummary();
  updateSelection();
  refreshFind();
  copyBtn.disabled = rerunBtn.disabled = $('selall').disabled = false;
}

// ---------- sitewide word search (hidden until the 🔍 Find button is pressed) ----------
function buildRegex() {
  const q = $('fq').value.trim();
  if (!q) return null;
  let src = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  if ($('fword').checked) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, 'gu' + ($('fcase').checked ? '' : 'i'));
}

const countMatches = (re, s) => (s ? (s.match(re) || []).length : 0);

function snippet(re, s) {
  const m = new RegExp(re.source, re.flags.replace('g', '')).exec(s);
  if (!m) return '';
  const a = Math.max(0, m.index - 50), b = Math.min(s.length, m.index + m[0].length + 50);
  return (a ? '…' : '') + esc(s.slice(a, m.index)) + '<mark>' + esc(m[0]) + '</mark>' + esc(s.slice(m.index + m[0].length, b)) + (b < s.length ? '…' : '');
}

// Green "seo" label when the match is in the title and/or meta description (hover for which).
function seoTag(found) {
  const seo = found.filter(f => f.label !== 'Page text');
  if (!seo.length) return '';
  const n = seo.reduce((s, f) => s + f.n, 0);
  return `<span class="ftag seo" title="${seo.map(f => `${f.label} ×${f.n}`).join(', ')}">seo ×${n}</span>`;
}

function runFind() {
  const re = buildRegex();
  const res = $('fres'), sum = $('fsum');
  res.innerHTML = '';
  if (!re) { sum.textContent = ''; return; }
  const list = rows.filter(r => !r.probe);
  if (!list.length) { sum.textContent = 'Run the audit first — nothing to search yet.'; return; }
  const scope = $('fscope').value;
  let pages = 0, total = 0;
  for (const r of list) {
    const found = [];
    if (scope !== 'body') {
      const t = countMatches(re, r.title), d = countMatches(re, r.description);
      if (t) found.push({ label: 'Title', n: t, text: r.title });
      if (d) found.push({ label: 'Description', n: d, text: r.description });
    }
    if (scope !== 'seo') {
      const b = countMatches(re, r.text);
      if (b) found.push({ label: 'Page text', n: b, text: r.text });
    }
    if (!found.length) continue;
    pages++;
    total += found.reduce((s, f) => s + f.n, 0);
    const path = new URL(r.url).pathname || '/';
    const el = document.createElement('div');
    el.className = 'fhit';
    el.dataset.url = r.url;
    el.innerHTML = `<div class="fh"><b>${esc(r.label)}</b> <span class="fpath">${esc(path)}</span>
        ${seoTag(found)}${found.some(f => f.label === 'Page text') ? `<span class="ftag body">page ×${found.find(f => f.label === 'Page text').n}</span>` : ''}</div>
      <div class="fsnip">${snippet(re, found[0].text)}</div>`;
    res.appendChild(el);
  }
  sum.innerHTML = pages
    ? `<b>${pages}</b> of ${list.length} pages contain it (${total} match${total === 1 ? '' : 'es'})`
    : `Not found on any of the ${list.length} audited pages.`;
}

function refreshFind() { if (!$('finder').hidden) runFind(); }

$('findtoggle').addEventListener('click', () => {
  const f = $('finder');
  f.hidden = !f.hidden;
  $('findtoggle').classList.toggle('on', !f.hidden);
  if (!f.hidden) { $('fq').focus(); runFind(); }
});
let findTimer;
['input', 'change'].forEach(ev => $('finder').addEventListener(ev, () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 150); }));
$('fres').addEventListener('click', e => {
  const hit = e.target.closest('.fhit');
  if (!hit) return;
  const card = [...resultsEl.querySelectorAll('.page[data-url]')].find(c => c.dataset.url === hit.dataset.url);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
});

// ---------- random SFW anime image ----------
const DANBOORU = 'https://danbooru.donmai.us';
let current = null;

// Keyword mode: Danbooru, "general" rating only (SFW). Keyword is a series or character tag.
// Manga pages, black-and-white scans and text-heavy images are skipped. Danbooru's free tier only allows two
// search tags (keyword + rating), so these are filtered here instead of with "-comic -monochrome ...".
const SKIP_TAGS = new Set(['comic', '4koma', 'manga', 'monochrome', 'greyscale', 'speech_bubble', 'translated',
  'translation_request', 'text_focus', 'english_text', 'doujin_cover', 'page_number', 'scan', 'spot_color']);

const GIRL_TAG = /^(1girl|[2-9]\+?girls|multiple_girls)$/;
const NOT_FEMALE_TAG = /^([1-9]\+?boys?|multiple_boys|male_focus|[1-9]\+?others?|trap|otoko_no_ko|reverse_trap)$/;

async function danbooru(keyword) {
  const tag = keyword.trim().toLowerCase().replace(/\s+/g, '_');
  for (let n = 0; n < 20; n++) {
    const res = await fetch(`${DANBOORU}/posts/random.json?tags=${tag ? encodeURIComponent(tag) + '+' : ''}rating:g`, { cache: 'no-store' });
    if (res.status === 404) return null;                       // no SFW posts for that tag
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    if (p.rating !== 'g' || !p.file_url || !/^(jpe?g|png|webp|gif)$/.test(p.file_ext)) continue;
    const tags = `${p.tag_string_general || ''} ${p.tag_string_meta || ''}`.split(' ');
    if (tags.some(t => SKIP_TAGS.has(t))) continue;
    // Female characters only: must have a "girl" tag and no boy / male-focus / other-gender tag.
    if (!tags.some(t => GIRL_TAG.test(t)) || tags.some(t => NOT_FEMALE_TAG.test(t))) continue;
    const artist = (p.tag_string_artist || '').split(' ')[0].replace(/_/g, ' ');
    // Source series = Danbooru's "copyright" tags (the franchise). Skip "original"; show up to two.
    const series = (p.tag_string_copyright || '').split(' ').filter(t => t && t !== 'original').slice(0, 2)
      .map(t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())).join(' · ');
    return { url: p.large_file_url || p.file_url, full: p.file_url, credit: artist || null, series,
             creditHref: `${DANBOORU}/posts/${p.id}`, site: 'Danbooru' };
  }
  return null;
}

// No keyword: random pick from three SFW sources, falling back to the others.
// Danbooru is listed twice so about half of the random picks come from it: it is the only source that reports the series.
const randomDanbooru = async () => danbooru('1girl');
const IMAGE_SOURCES = [
  randomDanbooru,
  randomDanbooru,
  async () => {
    const d = await (await fetch('https://nekos.best/api/v2/' + ['neko', 'waifu', 'kitsune'][Math.floor(Math.random() * 3)], { cache: 'no-store' })).json();
    const r = d.results[0];
    return { url: r.url, credit: r.artist_name, creditHref: r.artist_href, site: 'nekos.best' };
  },
  async () => {
    const d = await (await fetch('https://api.waifu.pics/sfw/' + ['waifu', 'neko', 'shinobu', 'megumin'][Math.floor(Math.random() * 4)], { cache: 'no-store' })).json();
    return { url: d.url, site: 'waifu.pics' };
  },
  async () => {
    const d = await (await fetch('https://api.waifu.im/images?IsNsfw=false&PageSize=1&OrderBy=RANDOM', { cache: 'no-store' })).json();
    const r = d.items[0];
    if ((r.tags || []).some(t => /^(husbando|male|males|boy|boys)$/i.test(t.slug || t.name || ''))) throw new Error('not female');
    return { url: r.url, credit: r.artists?.[0]?.name, creditHref: r.source, site: 'waifu.im' };
  }
];

function showPic(pic) {
  return new Promise(ok => {
    const img = $('picimg');
    img.onload = () => {
      current = pic;
      const who = pic.credit
        ? (/^https?:\/\//.test(pic.creditHref || '') ? `<a href="${esc(pic.creditHref)}" target="_blank">${esc(pic.credit)}</a>` : esc(pic.credit))
        : 'unknown artist';
      // Source series first (when the API provides it), then artist and site.
      const serie = pic.series ? `<span class="pserie">${esc(pic.series)}</span>`
        : pic.site === 'Danbooru' ? '' : '<span class="pnone">series: not provided by this site</span>';
      $('piccredit').innerHTML = `${serie}Art by ${who}<br>via ${esc(pic.site)}`;
      $('picmsg').textContent = '';
      $('picmsg').classList.remove('over');
      ok(true);
    };
    img.onerror = () => ok(false);
    img.src = pic.url;
  });
}

function picMessage(text) {
  const m = $('picmsg');
  m.textContent = text;
  m.classList.toggle('over', !!current);   // keep the old image, show the message over it
}

// ---- Saved keywords: stored permanently in chrome.storage.local ----
let savedKw = [];            // normalized tags, e.g. "genshin_impact"
const activeKw = new Set();  // tags that are switched on
const normTag = s => s.trim().toLowerCase().replace(/\s+/g, '_');
const showTag = t => t.replace(/_/g, ' ');

function persistKeywords() {
  chrome.storage.local.set({ kwList: savedKw, kwActive: [...activeKw] });
}

function renderChips() {
  $('chips').innerHTML = savedKw.map(t =>
    `<span class="chip ${activeKw.has(t) ? 'on' : ''}" data-tag="${esc(t)}">${esc(showTag(t))}<span class="x" data-x="1" title="Remove">✕</span></span>`
  ).join('');
}

function addKeyword() {
  const t = normTag($('kw').value);
  if (!t) return false;
  if (!savedKw.includes(t)) savedKw.push(t);
  activeKw.add(t);
  $('kw').value = '';
  persistKeywords();
  renderChips();
  return true;
}

$('chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const t = chip.dataset.tag;
  if (e.target.dataset.x) { savedKw = savedKw.filter(k => k !== t); activeKw.delete(t); }
  else activeKw.has(t) ? activeKw.delete(t) : activeKw.add(t);
  persistKeywords();
  renderChips();
});

async function loadPic() {
  // Priority: text typed in the box (one-off) > a random pick from the keywords switched on > random sources.
  const typed = $('kw').value.trim();
  const on = [...activeKw];
  const kw = typed || (on.length ? showTag(on[Math.floor(Math.random() * on.length)]) : '');
  $('picroll').disabled = true;
  if (!current) picMessage('Loading image…');

  if (kw) {
    try {
      const pic = await danbooru(kw);
      if (!pic) picMessage(`No suitable images found for “${kw}” (SFW, female characters, non-manga). Try again or another tag.`);
      else if (!(await showPic(pic))) picMessage('Image failed to load. Try again.');
    } catch (e) {
      picMessage('Search failed: ' + e.message);
    }
  } else {
    let shown = false;
    for (const src of [...IMAGE_SOURCES].sort(() => Math.random() - 0.5)) {
      try {
        const pic = await src();
        if (/^https:\/\//.test(pic.url) && await showPic(pic)) { shown = true; break; }
      } catch { /* try the next source */ }
    }
    if (!shown) picMessage('Could not load an image right now.');
  }
  $('picroll').disabled = false;
}

$('picroll').addEventListener('click', loadPic);
$('kwadd').addEventListener('click', () => { if (addKeyword()) loadPic(); });
$('kw').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addKeyword(); loadPic(); } });

// Tag suggestions (series + characters) as you type.
let acTimer;
$('kw').addEventListener('input', () => {
  clearTimeout(acTimer);
  const q = $('kw').value.trim();
  if (q.length < 2) return;
  acTimer = setTimeout(async () => {
    try {
      const url = `${DANBOORU}/autocomplete.json?search[query]=${encodeURIComponent(q.toLowerCase().replace(/\s+/g, '_'))}&search[type]=tag_query&limit=10`;
      const list = await (await fetch(url)).json();
      $('tagopts').innerHTML = list
        .filter(t => t.category == null || [3, 4].includes(Number(t.category)))
        .map(t => `<option value="${esc(t.value)}">${esc(t.label || t.value)}${t.post_count ? ' (' + t.post_count + ')' : ''}</option>`)
        .join('');
    } catch { /* suggestions are optional */ }
  }, 250);
});

// ---------- click to enlarge + save ----------
function openLightbox() {
  if (!current) return;
  const pic = current;
  $('lbimg').src = pic.url;
  $('lbopen').href = pic.full || pic.url;
  $('lbnote').textContent = pic.full && pic.full !== pic.url ? 'Loading full size…' : '';
  $('lbsave').textContent = '⬇ Save';
  $('lightbox').hidden = false;
  if (pic.full && pic.full !== pic.url) {
    const big = new Image();
    big.onload = () => { if (current === pic && !$('lightbox').hidden) { $('lbimg').src = pic.full; $('lbnote').textContent = 'Full size'; } };
    big.onerror = () => { $('lbnote').textContent = ''; };
    big.src = pic.full;
  }
}
function closeLightbox() { $('lightbox').hidden = true; }

async function savePic() {
  if (!current) return;
  const btn = $('lbsave');
  const url = current.full || current.url;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const blob = await (await fetch(url)).blob();
    const base = new URL(url).pathname.split('/').pop() || 'anime.jpg';
    const ext = /\.\w+$/.test(base) ? '' : '.' + (blob.type.split('/')[1] || 'jpg');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${current.site.toLowerCase().replace(/\W/g, '')}-${base}${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    btn.textContent = 'Saved ✓ (Downloads)';
  } catch {
    btn.textContent = 'Save failed — use Open original';
  }
  btn.disabled = false;
}

$('picimg').addEventListener('click', openLightbox);
$('lbclose').addEventListener('click', closeLightbox);
$('lbsave').addEventListener('click', savePic);
$('lightbox').addEventListener('click', e => { if (e.target === $('lightbox') || e.target === $('lbimg')) closeLightbox(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLightbox(); $('settings').hidden = true; } });

// ---------- AI rewrite settings (API keys for the right-click "Rewrite with AI" menu) ----------
const KEY_FIELDS = ['provider', 'geminiKey', 'geminiModel', 'apiKey', 'model'];

function settingsMsg(text, cls) { const m = $('smsg'); m.textContent = text; m.className = cls || ''; }
function showProviderFields() {
  const gem = $('sprovider').value === 'gemini';
  $('sgemini').hidden = !gem;
  $('sclaude').hidden = gem;
  settingsMsg('');
}
async function refreshKeyBadge() {
  const s = await chrome.storage.local.get(KEY_FIELDS);
  const has = (s.provider || 'gemini') === 'gemini' ? s.geminiKey : s.apiKey;
  $('settingsbtn').classList.toggle('nokey', !has);
  $('settingsbtn').title = has ? 'AI rewrite settings (API keys)' : 'AI rewrite settings: no API key saved yet';
}

$('settingsbtn').addEventListener('click', async () => {
  const s = await chrome.storage.local.get(KEY_FIELDS);
  $('sprovider').value = s.provider || 'gemini';
  $('sgkey').value = s.geminiKey || '';
  $('sgmodel').value = s.geminiModel || 'gemini-flash-lite-latest';
  $('sckey').value = s.apiKey || '';
  $('scmodel').value = s.model || 'claude-opus-5-5';
  showProviderFields();
  $('settings').hidden = false;
});
$('sclose').addEventListener('click', () => { $('settings').hidden = true; });
$('settings').addEventListener('click', e => { if (e.target === $('settings')) $('settings').hidden = true; });
$('sprovider').addEventListener('change', showProviderFields);
document.querySelectorAll('.seye').forEach(b => b.addEventListener('click', () => {
  const inp = $(b.dataset.for);
  inp.type = inp.type === 'password' ? 'text' : 'password';
}));

$('ssave').addEventListener('click', async () => {
  await chrome.storage.local.set({
    provider: $('sprovider').value,
    geminiKey: $('sgkey').value.trim(),
    geminiModel: $('sgmodel').value,
    apiKey: $('sckey').value.trim(),
    model: $('scmodel').value
  });
  settingsMsg('Saved ✓', 'ok');
  refreshKeyBadge();
});

// Checks the key by listing models (free, no text is sent).
$('stest').addEventListener('click', async () => {
  const gem = $('sprovider').value === 'gemini';
  const key = (gem ? $('sgkey') : $('sckey')).value.trim();
  if (!key) { settingsMsg('Enter a key first', 'bad'); return; }
  settingsMsg('Testing…');
  try {
    const res = gem
      ? await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } })
      : await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: {
          'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
    if (res.ok) settingsMsg('Key works ✓', 'ok');
    else if (res.status === 400 || res.status === 401 || res.status === 403) settingsMsg('Key rejected (invalid or not allowed)', 'bad');
    else settingsMsg('Error: HTTP ' + res.status, 'bad');
  } catch (e) {
    settingsMsg('Could not reach the API: ' + e.message, 'bad');
  }
});

refreshKeyBadge();
run();
chrome.storage.local.get(['kwList', 'kwActive']).then(s => {
  savedKw = s.kwList || [];
  (s.kwActive || []).forEach(t => savedKw.includes(t) && activeKw.add(t));
  renderChips();
}).finally(loadPic);
