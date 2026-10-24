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
  // Hand the finished results to the larger window so it doesn't re-audit everything.
  // chrome.storage.session is memory-only; the new window deletes the entry as soon as it reads it.
  // The current image always carries over; audit results only when the audit has finished.
  let key = 'handoff-' + Date.now();
  try { await chrome.storage.session.set({ [key]: snapshotState() }); } catch { key = ''; }
  await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html') + '?tab=' + tab.id + (key ? '&state=' + key : ''),
    type: 'popup', width: 1280, height: 860
  });
  window.close();
});

function snapshotState() {
  const stamp = t => document.getElementById('pt-' + t)?.textContent || '';
  return {
    rows: mainBusy ? [] : rows, live, siteOrigin, activeTab, pic: current,
    selected: [...selected],
    stamps: { seo: stamp('seo'), nbh: stamp('nbh'), agent: stamp('agent') },
    groups: Object.fromEntries(Object.entries(dyn).map(([k, g]) => [k, { on: g.on, rows: g.rows }]))
  };
}

// In the Expand window: show the handed-over results instead of auditing again.
async function restoreState(key) {
  let s;
  try {
    s = (await chrome.storage.session.get(key))[key];
    await chrome.storage.session.remove(key);
  } catch { /* fall through */ }
  if (!s) { loadPic(); return false; }
  if (s.pic) showPic(s.pic); else loadPic();   // same image as the small popup, no reload
  if (!s.rows?.length) return false;            // audit was still running: start it fresh

  rows = s.rows;
  live = s.live;
  siteOrigin = s.siteOrigin;
  s.selected.forEach(u => selected.add(u));
  $('site').textContent = new URL(siteOrigin).host;
  resultsEl.innerHTML = '';
  renderHeaderCard();
  rows.forEach(r => render(r));
  fillEl.style.width = '100%';
  copyBtn.disabled = rerunBtn.disabled = $('selall').disabled = paneBtn('seo').disabled = false;

  for (const [k, g] of Object.entries(dyn)) {
    const saved = s.groups?.[k];
    g.toggle.disabled = false;
    if (!saved?.on) continue;
    g.on = true;
    g.toggle.checked = true;
    tabButton(g).hidden = false;
    if (saved.rows.length) {
      g.rows = saved.rows;
      g.el.innerHTML = '';
      g.rows.forEach(r => render(r, g.el));
      tabButton(g).textContent = `${g.label} (${g.rows.length})`;
    } else {
      auditGroup(k);   // it was still auditing when Expand was clicked
    }
  }
  Object.entries(s.stamps || {}).forEach(([t, txt]) => { const el = document.getElementById('pt-' + t); if (el && txt) el.textContent = txt; });

  showTab(s.activeTab && document.querySelector(`.tab[data-tab="${s.activeTab}"]:not([hidden])`) ? s.activeTab : 'seo');
  updateSummary();
  updateSelection();
  return true;
}

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
                status: null, title: '', description: '', parts: [], error: '', flags: [] };
  try {
    // Always hit the network: no HTTP cache, nothing stored by the extension.
    const res = await fetch(link.href, {
      credentials: 'include', redirect: 'follow', cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
    row.status = res.status;
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    decodeCfEmails(doc);   // Cloudflare hides emails as "[email protected]" in the served HTML
    row.title = clean(doc.querySelector('title')?.textContent);
    row.description = clean(doc.querySelector('meta[name="description" i]')?.getAttribute('content'));

    const contact = [...doc.querySelectorAll('a[href^="mailto:" i], a[href^="tel:" i], a[href^="sms:" i]')]
      .map(a => ({ href: a.getAttribute('href'), text: a.textContent }));
    // Visible text of the page, kept for the sitewide word search.
    // Colours first: they live in the <style> blocks that are stripped for keyword search below.
    row.colorParts = collectColorParts(doc, elementMap);
    row.linkInv = collectLinkInventory(doc, link.href, elementMap);   // for "Check links"
    row.designCss = [...doc.querySelectorAll('link[rel~="stylesheet"][href]')].map(l => l.href).find(h => /styles\.luxury(presence|coders)\.com\//.test(h)) || '';
    doc.querySelectorAll('script, style, noscript, template').forEach(n => n.remove());
    // Testimonial sections (sliders, lists, cards, modals) are always left out of the word search.
    // Skips <body>/<html> and any wrapper that also holds the header, footer or nav, so a class like
    // "testimonials-page" on a layout wrapper can't wipe out the whole page.
    doc.querySelectorAll('[class*="testimonial" i], [id*="testimonial" i]').forEach(n => {
      if (n === doc.body || n === doc.documentElement || n.querySelector('header, footer, nav, #global-navbar, #global-sidemenu')) return;
      n.remove();
    });
    row.parts = collectSearchParts(doc, false, elementMap);
    row.visibleParts = collectSearchParts(doc, true, elementMap);
    row.detailLinks = detailLinksIn(doc, link.href);
    if (link.useH1) row.label = clean(doc.querySelector('h1')?.textContent).slice(0, 60) || row.label;   // agent / neighborhood name
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

// SEO criteria: title 45–60 chars, meta description 145–160 chars.
const TITLE_MIN = 45, TITLE_MAX = 60, DESC_MIN = 145, DESC_MAX = 160;
function seoProblems(row) {
  const p = [];
  const check = (name, len, min, max) => {
    if (!len) p.push(`${name} MISSING`);
    else if (len < min) p.push(`${name} too short: ${len} chars (needs ${min}–${max})`);
    else if (len > max) p.push(`${name} too long: ${len} chars (needs ${min}–${max})`);
  };
  check('Title', row.title.length, TITLE_MIN, TITLE_MAX);
  check('Description', row.description.length, DESC_MIN, DESC_MAX);
  return p;
}

function render(row, container = resultsEl) {
  const div = document.createElement('div');
  const seo = seoProblems(row);
  const broken = row.flags.length > 0 || seo.length > 0;
  div.className = 'page' + (broken ? ' broken' : '') + (selected.has(row.url) ? ' selected' : '');
  const statusOk = row.probe ? row.status === 404 : row.status === 200;
  const flags = row.flags.map(f => `<span class="flag">⚠ ${esc(f)}</span>`).join('');
  div.dataset.url = row.url;
  div.innerHTML = `
    <div class="head">
      <input type="checkbox" class="sel" title="Select for Copy selected" ${selected.has(row.url) ? 'checked' : ''}>
      <div class="ttl"><span class="name">${esc(row.label)}</span><span class="src">${esc(row.source)}</span></div>
      <span class="seobadge ${seo.length ? 'bad' : ''}" title="${esc(seo.join('\n') || 'Title and description meet the criteria')}">${seo.length ? `SEO ✗ ${seo.length}` : 'SEO ✓'}</span>
      <span class="badge ${statusOk ? '' : 'bad'}">${row.status ?? 'ERR'}</span>
      <button class="rerun1" title="Re-run this page"><svg class="ico"><use href="#i-refresh"/></svg></button></div>
    <a class="url" href="${esc(row.url)}" title="${esc(row.url)}" target="_blank">${esc(row.url)}</a>
    ${seo.length ? `<div class="seoflags">${seo.map(f => `<span class="seoflag">✗ ${esc(f)}</span>`).join('')}</div>` : ''}
    ${flags ? `<div class="flags">${flags}</div>` : ''}
    ${field('Title', row.title, row.title.length, TITLE_MIN, TITLE_MAX)}
    ${field('Description', row.description, row.description.length, DESC_MIN, DESC_MAX)}`;
  container.appendChild(div);
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

// ---------- neighborhood / agent groups: each has its own toggle and tab ----------
const dyn = {
  Neighborhood: { tab: 'nbh', label: 'Neighborhoods', el: $('res-nbh'), toggle: $('tog-nbh'), rows: [], on: false, token: 0 },
  Agent: { tab: 'agent', label: 'Agents', el: $('res-agent'), toggle: $('tog-agent'), rows: [], on: false, token: 0 }
};
const groupByTab = name => Object.values(dyn).find(g => g.tab === name);
// Rows shown on the current tab (Copy all / Copy selected / Select all / summary use these).
const tabRows = () => groupByTab(activeTab)?.rows || rows;
const tabPaneEl = () => groupByTab(activeTab)?.el || resultsEl;
// Every audited row (keyword search uses these).
const allRows = () => [...rows, ...dyn.Neighborhood.rows, ...dyn.Agent.rows];
const probeTitle = () => rows.find(r => r.probe)?.title;
function locateRow(url) {
  for (const arr of [rows, dyn.Neighborhood.rows, dyn.Agent.rows]) {
    const i = arr.findIndex(r => r.url === url);
    if (i >= 0) return { arr, i };
  }
  return null;
}

// ---------- results interactions (all result panes) ----------
const layoutEl = $('layout');
layoutEl.addEventListener('click', async e => {
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
  const loc = locateRow(card.dataset.url);
  if (!loc) return;
  const old = loc.arr[loc.i];
  btn.disabled = true;
  btn.classList.add('spin');
  const fresh = await audit({ href: old.url, text: old.label, source: old.source, probe: old.probe },
                            old.probe ? undefined : probeTitle());
  loc.arr[loc.i] = fresh;
  card.replaceWith(render(fresh, card.parentElement));
  updateSummary();
  refreshFind();
});

layoutEl.addEventListener('change', e => {
  const cb = e.target.closest('.sel');
  if (!cb) return;
  const card = cb.closest('.page');
  cb.checked ? selected.add(card.dataset.url) : selected.delete(card.dataset.url);
  card.classList.toggle('selected', cb.checked);
  updateSelection();
});

$('selall').addEventListener('change', e => {
  tabRows().forEach(r => e.target.checked ? selected.add(r.url) : selected.delete(r.url));
  tabPaneEl().querySelectorAll('.page[data-url]').forEach(card => {
    const on = selected.has(card.dataset.url);
    card.classList.toggle('selected', on);
    card.querySelector('.sel').checked = on;
  });
  updateSelection();
});

function updateSelection() {
  const list = tabRows();
  const n = list.filter(r => selected.has(r.url)).length;
  $('copysel').textContent = `Copy selected (${n})`;
  $('copysel').disabled = n === 0;
  $('selall').checked = list.length > 0 && n === list.length;
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
// ---------- notes added after "Copy selected" (several saved notes, pick one; all saved permanently) ----------
const DEFAULT_TEMPLATE = 'Analyze these seo titles and description, find the pattern on how they were formed,. the charater reqirement is 46-60 in title and 146-160 in description. And then after analyzing, build me seo title and description for these pages: ';
let notes = [];            // [{ id, name, text }]
let activeNoteId = '';     // '' = add no note
let editNoteId = '';       // note shown in the editor
const newNoteId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const noteById = id => notes.find(n => n.id === id);

chrome.storage.local.get(['copyNotes', 'activeNoteId', 'copyTemplate']).then(s => {
  if (Array.isArray(s.copyNotes) && s.copyNotes.length) {
    notes = s.copyNotes;
    activeNoteId = s.activeNoteId ?? notes[0].id;
  } else {
    // first run after the update: the old single template becomes note 1
    notes = [{ id: newNoteId(), name: 'SEO analysis prompt', text: typeof s.copyTemplate === 'string' ? s.copyTemplate : DEFAULT_TEMPLATE }];
    activeNoteId = notes[0].id;
    persistNotes();
  }
  editNoteId = noteById(activeNoteId) ? activeNoteId : notes[0]?.id || '';
  renderNotes();
});

function persistNotes(msg) {
  Promise.resolve(chrome.storage.local.set({ copyNotes: notes, activeNoteId })).then(() => { if (msg) $('tplsaved').textContent = msg; });
}

function renderNotes() {
  const opts = notes.map(n => `<option value="${esc(n.id)}">${esc(n.name || 'Untitled note')}</option>`).join('');
  $('notesel').innerHTML = `<option value="">No note</option>${opts}`;
  $('notesel').value = noteById(activeNoteId) ? activeNoteId : '';
  $('noteedit').innerHTML = opts;
  const n = noteById(editNoteId);
  $('noteedit').value = n ? n.id : '';
  $('notename').value = n ? n.name : '';
  $('tpltext').value = n ? n.text : '';
  $('notename').disabled = $('tpltext').disabled = $('notedel').disabled = !n;
  $('tplreset').hidden = !(n && n === notes[0]);   // "Reset" only restores the original analysis prompt (note 1)
}

// pick which note Copy selected adds
$('notesel').addEventListener('change', () => { activeNoteId = $('notesel').value; persistNotes(); });

// editor
$('tplbtn').addEventListener('click', () => {
  const box = $('tplbox');
  box.hidden = !box.hidden;
  $('tplbtn').classList.toggle('on', !box.hidden);
  if (!box.hidden) { if (noteById(activeNoteId)) editNoteId = activeNoteId; renderNotes(); $('tpltext').focus(); }
});
$('noteedit').addEventListener('change', () => { editNoteId = $('noteedit').value; $('tplsaved').textContent = ''; renderNotes(); });
let tplTimer;
const saveSoon = () => {
  $('tplsaved').textContent = 'Saving…';
  clearTimeout(tplTimer);
  tplTimer = setTimeout(() => persistNotes('Saved ✓'), 300);
};
$('tpltext').addEventListener('input', () => { const n = noteById(editNoteId); if (n) { n.text = $('tpltext').value; saveSoon(); } });
$('notename').addEventListener('input', () => {
  const n = noteById(editNoteId);
  if (!n) return;
  n.name = $('notename').value;
  // keep both dropdowns' labels in sync without re-rendering the field being typed in
  [...document.querySelectorAll(`#notesel option[value="${n.id}"], #noteedit option[value="${n.id}"]`)].forEach(o => { o.textContent = n.name || 'Untitled note'; });
  saveSoon();
});
$('noteadd').addEventListener('click', () => {
  const n = { id: newNoteId(), name: `Note ${notes.length + 1}`, text: '' };
  notes.push(n);
  editNoteId = n.id;
  persistNotes('Note added ✓');
  renderNotes();
  $('notename').select();
});
$('notedel').addEventListener('click', () => {
  const n = noteById(editNoteId);
  if (!n || !confirm(`Delete the note “${n.name || 'Untitled note'}”?`)) return;
  notes = notes.filter(x => x !== n);
  if (activeNoteId === n.id) activeNoteId = '';
  editNoteId = notes[0]?.id || '';
  persistNotes('Deleted ✓');
  renderNotes();
});
$('tplreset').addEventListener('click', () => {
  const n = noteById(editNoteId);
  if (!n) return;
  n.text = DEFAULT_TEMPLATE;
  persistNotes('Reset to the original prompt ✓');
  renderNotes();
});

// Copy all: SEO only. Copy selected: SEO of the ticked pages + the picked note.
copyBtn.addEventListener('click', () => copyWithFeedback(copyBtn, () => 'Copy all', formatRows(tabRows())));
$('copysel').addEventListener('click', () => {
  const seo = formatRows(tabRows().filter(r => selected.has(r.url)));
  const note = noteById(activeNoteId)?.text || '';
  copyWithFeedback($('copysel'), () => `Copy selected (${tabRows().filter(r => selected.has(r.url)).length})`,
    note.trim() ? seo + '\n\n' + note : seo);
});
rerunBtn.addEventListener('click', () => run());

// ---------- per-tab refresh bars ----------
const paneBtn = tab => document.querySelector(`.pbrefresh[data-refresh="${tab}"]`);
function stampPane(tab) {
  const t = document.getElementById('pt-' + tab);
  if (t) t.textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
document.querySelectorAll('.pbrefresh').forEach(b => b.addEventListener('click', () => {
  const g = groupByTab(b.dataset.refresh);
  if (!g) return run({ mainOnly: true });   // SEO audit tab: menu, navbar & footer pages only
  dynPathsPromise = null;                   // re-read the sitemap so new pages show up
  auditGroup(Object.keys(dyn).find(k => dyn[k] === g));
}));

let mainBusy = false;   // while the main audit runs, the status line shows its progress
function updateSummary() {
  if (mainBusy) return;
  const list = tabRows();
  const broken = list.filter(r => !r.probe && r.flags.some(f => /404|HTTP|failed/i.test(f))).length;
  const seoIssues = list.filter(r => !r.probe && seoProblems(r).length).length;
  const contact = list.filter(r => r.flags.some(f => /mismatch|invalid/i.test(f))).length;
  const hdr = live && !groupByTab(activeTab) ? live.headerIssues.length : 0;
  const stat = (n, label, plural) => `<span class="stat ${n ? 'bad' : ''}">${n ? '' : '✓ '}${n} ${label}${n === 1 || !plural ? '' : 's'}</span>`;
  statusEl.innerHTML = `<span class="stat neutral">${list.length} pages</span>` +
    stat(broken, 'broken link', true) + stat(seoIssues, seoIssues === 1 ? 'page failing SEO' : 'pages failing SEO', false) +
    stat(contact, 'phone/email issue', true) + (groupByTab(activeTab) ? '' : stat(hdr, 'empty header/footer link', true)) +
    ($('tog-links').checked ? stat(list.filter(r => !r.probe).reduce((n, r) => n + deadItemsFor(r).items.filter(d => d.state === 'dead').length, 0), 'dead link/button', true) : '') +
    '<span id="linkprog" class="stat neutral" style="font-weight:500"></span>';
}

// "Check links" toggle: off by default; checks every link and button on all audited pages.
$('tog-links').addEventListener('change', () => { if ($('tog-links').checked) runLinkCheck(); else { linkCheckRun++; setLinkProg(''); rerenderCards(); } });

// ---------- dynamic pages: neighborhood and agent detail pages ----------
// /neighborhoods and /team list these with JavaScript pagination, so the HTML only holds page 1.
// The sitemap (sitemap-neighborhoods-dpages.xml, sitemap-agents-dpages.xml / sitemap-agent-dpages.xml)
// lists all of them; links found on the audited pages are added as a fallback.
const DETAIL_PATH = /^\/(neighborhoods|agents?)\/[^/{}?#]+\/?$/i;
const pathKey = p => (p.replace(/\/+$/, '') || '/').toLowerCase();
const slugTitle = p => decodeURIComponent(pathKey(p).split('/').pop()).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function detailLinksIn(doc, base) {
  const origin = new URL(base).origin, out = new Set();
  doc.querySelectorAll('a[href]').forEach(a => {
    try {
      const u = new URL(a.getAttribute('href'), base);
      if (u.origin === origin && DETAIL_PATH.test(u.pathname)) out.add(pathKey(u.pathname));
    } catch { /* bad href */ }
  });
  return [...out];
}

async function sitemapDetailPaths(origin) {
  const getXml = async url => new DOMParser().parseFromString(await (await fetch(url, { cache: 'no-store' })).text(), 'text/xml');
  const locs = d => [...d.getElementsByTagName('loc')].map(l => l.textContent.trim());
  const toPath = u => { try { return new URL(u).pathname; } catch { return null; } };
  try {
    const top = locs(await getXml(origin + '/sitemap.xml'));
    const paths = top.map(toPath).filter(p => p && DETAIL_PATH.test(p));   // plain sitemap (no index)
    for (const sub of top.filter(u => /sitemap-(neighborhoods?|agents?)-dpages/i.test(u))) {
      const subPath = toPath(sub);
      if (!subPath) continue;
      // fetch from the site being audited (preview hosts may list the production domain)
      locs(await getXml(origin + subPath)).map(toPath).forEach(p => { if (p && DETAIL_PATH.test(p)) paths.push(p); });
    }
    return paths.map(pathKey);
  } catch {
    return [];
  }
}

let siteOrigin = null;
let dynPathsPromise = null;   // sitemap + page-link discovery, cached until the next full audit
function getDynPaths() {
  if (!dynPathsPromise) {
    dynPathsPromise = sitemapDetailPaths(siteOrigin).then(list => {
      const found = new Set(list);
      rows.forEach(r => (r.detailLinks || []).forEach(p => found.add(p)));
      return found;
    });
  }
  return dynPathsPromise;
}

function tabButton(g) { return document.querySelector(`.tab[data-tab="${g.tab}"]`); }

// Turn a group on (open its tab and audit it) or off (close the tab, drop its rows).
async function setGroup(key, on) {
  const g = dyn[key];
  g.on = on;
  g.token++;
  if (!on) {
    g.rows = [];
    g.el.innerHTML = '';
    tabButton(g).hidden = true;
    if (activeTab === g.tab) showTab('seo');
    refreshFind();
    return;
  }
  tabButton(g).hidden = false;
  tabButton(g).textContent = g.label;
  showTab(g.tab);
  await auditGroup(key);
}

async function auditGroup(key) {
  const b = paneBtn(dyn[key].tab);
  b.disabled = true;
  try { await auditGroupInner(key); } finally { b.disabled = false; stampPane(dyn[key].tab); }
}

async function auditGroupInner(key) {
  const g = dyn[key];
  const token = ++g.token;
  g.rows = [];
  g.el.innerHTML = '<div class="dynstatus">Finding pages (sitemap + page links)…</div>';
  const st = g.el.querySelector('.dynstatus');
  const isMine = key === 'Neighborhood' ? p => /^\/neighborhoods\//.test(p) : p => /^\/agents?\//.test(p);
  const audited = new Set(rows.map(r => pathKey(new URL(r.url).pathname)));
  const list = [...await getDynPaths()].filter(p => isMine(p) && !audited.has(p))
    .map(p => ({ href: siteOrigin + p, text: slugTitle(p), useH1: true, source: key }));
  if (token !== g.token) return;
  if (!list.length) {
    st.textContent = `No ${key.toLowerCase()} pages found on this site (checked the sitemap and page links).`;
    tabButton(g).textContent = `${g.label} (0)`;
    if (activeTab === g.tab) { updateSummary(); updateSelection(); }
    return;
  }
  let d = 0, j = 0;
  const out = [];
  const tick = () => { st.textContent = `Auditing ${key.toLowerCase()} pages ${d}/${list.length}…`; };
  tick();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (j < list.length && token === g.token) {
      const k = j++;
      out[k] = await audit(list[k], probeTitle());
      d++;
      if (token === g.token) tick();
    }
  }));
  if (token !== g.token || !g.on) return;   // toggled off or re-run meanwhile
  out.sort((a, b) => a.label.localeCompare(b.label));
  g.rows = out;
  setTimeout(runLinkCheck, 0);   // new pages' links (only when Check links is on)
  g.el.innerHTML = '';
  out.forEach(r => render(r, g.el));
  tabButton(g).textContent = `${g.label} (${out.length})`;
  if (activeTab === g.tab) { updateSummary(); updateSelection(); }
  refreshFind();
}

Object.entries(dyn).forEach(([key, g]) => g.toggle.addEventListener('change', () => setGroup(key, g.toggle.checked)));

// ---------- official LP element names (same source as the LP Identifier extension) ----------
// LP marks every block with data-el-id (section[data-el-id], #global-navbar, #global-sidemenu, #global-footer, modals).
// The LP Identifier maps those IDs to element + template names in data/element-data.json, which it exposes to web pages.
// 1) read it live from the installed LP Identifier (fetched from inside the audited tab, so it is always current)
// 2) otherwise use the snapshot bundled with this extension (data/lp-elements.json)
const LP_IDENTIFIER_ID = 'pcknhfiipohlegjbokamnifkafoijonh';
let elementMap = null;
let elementMapPromise = null;
function getElementMap(tabId) {
  if (!elementMapPromise) elementMapPromise = (async () => {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [LP_IDENTIFIER_ID],
        func: async id => {
          try {
            const res = await fetch(`chrome-extension://${id}/data/element-data.json`);
            if (!res.ok) return null;
            const map = {};
            for (const e of (await res.json()).elements || []) {
              if (e.elementID) map[e.elementID] = [String(e.elementName || '').trim(), String(e.templateName || '').trim()];
            }
            return map;
          } catch { return null; }
        }
      });
      if (r?.result && Object.keys(r.result).length) return { map: r.result, source: 'LP Identifier (live)' };
    } catch { /* LP Identifier not installed, or the page can't be scripted */ }
    try {
      const j = await (await fetch(chrome.runtime.getURL('data/lp-elements.json'))).json();
      return { map: j.elements || {}, source: 'bundled snapshot' };
    } catch {
      return { map: {}, source: 'none' };
    }
  })();
  return elementMapPromise;
}

async function run(opts = {}) {
  const mainOnly = !!opts.mainOnly;   // per-tab refresh of the SEO audit tab leaves the group tabs alone
  paneBtn('seo').disabled = true;
  rows = [];
  resultsEl.innerHTML = '';
  mainBusy = true;
  if (!mainOnly) dynPathsPromise = null;
  linkStatus.clear();   // links are re-checked live after every audit
  if (!mainOnly) Object.values(dyn).forEach(g => { g.token++; g.rows = []; g.el.innerHTML = g.on ? '<div class="dynstatus">Waiting for the main audit…</div>' : ''; g.toggle.disabled = true; });
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
    rerunBtn.disabled = paneBtn('seo').disabled = false;
    mainBusy = false;
    return;
  }
  if (data.error) { statusEl.textContent = data.error; rerunBtn.disabled = paneBtn('seo').disabled = false; mainBusy = false; return; }
  live = data;
  elementMap = (await getElementMap(tab.id)).map;   // official LP element names, keyed by data-el-id
  siteOrigin = data.origin;

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
  rows.forEach(r => render(r));

  mainBusy = false;
  renderLinks();
  runLinkCheck();
  updateSummary();
  updateSelection();
  refreshFind();
  copyBtn.disabled = rerunBtn.disabled = $('selall').disabled = false;
  // Neighborhood / agent tabs that are switched on get re-audited too.
  paneBtn('seo').disabled = false;
  stampPane('seo');
  // Neighborhood / agent tabs that are switched on get re-audited too (not on a per-tab refresh).
  Object.entries(dyn).forEach(([key, g]) => { g.toggle.disabled = false; if (g.on && !mainOnly) auditGroup(key); });
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

// Every searchable piece of a page as [where, text, element path, component], e.g.
// ['alt', 'Home valuation chart', 'div.hero__media › img.hero__img', { name: 'Gallery component', … }].
//
// Self-contained on purpose: it also runs inside rendered pages via chrome.scripting.
//   visibleOnly = false → everything in the HTML: any text, alt text, title/aria attributes, link URLs, meta tags
//   visibleOnly = true  → only text inside text elements (h1–h6, p, span, li, ol, links, buttons …), modals included
// Testimonial sections and slider clones are always skipped.
// Shared element labelling for keyword and colour search: official LP name via data-el-id, else a class-name guess.
function makeLabeler(doc, elMap) {
  const body = doc.body;
  const clean = s => (s || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  // ---- component naming: <section id="section-…"> <div class="gallery-component …"> ----
  const GENERIC = /^(section|redesign|parallax|hidable|modal|collection|lp-[\w-]*|js-[\w-]*|is-[\w-]*|video-wrapper|overlay-component|height-class-[\w-]*)$/i;
  const ABBR = { hv: 'home valuation', ig: 'Instagram', cta: 'CTA' };
  const humanize = c => c.split(/[-_]+/).map(w => ABBR[w.toLowerCase()] || w).join(' ').replace(/^\w/, ch => ch.toUpperCase());
  const secCache = new Map();
  const componentOf = el => {
    // 1) Official LP element name: like the LP Identifier, read data-el-id on the section / global element
    //    (section[data-el-id], #global-navbar, #global-sidemenu, #global-footer, modals) and look it up.
    const host = elMap && el.closest("[data-el-id]");
    const known = host && elMap[host.getAttribute("data-el-id")];
    if (known) {
      if (secCache.has(host)) return secCache.get(host);
      const isSection = host.matches("section");
      const info = { name: known[0] || "Element", template: known[1] || "", elId: host.getAttribute("data-el-id"), id: host.id,
                     heading: isSection ? clean(host.querySelector("h1, h2, h3")?.textContent).slice(0, 40) : "", global: !isSection };
      secCache.set(host, info);
      return info;
    }
    // 2) Fallback: guess from the class names
    const sec = el.closest('section[id^="section-"]');
    if (!sec) {
      // Site-wide parts: the same on every page, so search results show them only once.
      if (el.closest('#global-navbar, header')) return { name: 'Header / navbar', global: true };
      if (el.closest('#global-sidemenu')) return { name: 'Side menu', global: true };
      if (el.closest('#lp-consent-banner, [class*="consent" i]')) return { name: 'Cookie banner', global: true };
      if (el.closest('#global-footer, footer')) return { name: 'Footer', global: true };
      // Outermost popup/widget, so inner ids like "qualifying-questions-modal-title" still name the whole popup.
      // Checked before the loose footer match: popups contain classes like "contact-form__footer".
      let holder = null;
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
        if (e.matches('[id^="global-"], [id*="modal" i], [class*="floating-contact" i]')) holder = e;
      }
      if (holder) {
        const raw = holder.id || [...holder.classList].find(c => /floating-contact/i.test(c));
        const isPopup = /modal|pop-?up/i.test(raw);
        const name = humanize(raw.replace(/^(modal-)?(global-)?/i, '').replace(/-?modal$/i, ''));
        return { name: name + (isPopup ? ' (popup)' : ''), id: holder.id, global: true };
      }
      if (el.closest('[class*="footer" i]')) return { name: 'Footer', global: true };
      return { name: 'Page (outside sections)' };
    }
    if (secCache.has(sec)) return secCache.get(sec);
    let cls = null;
    for (const child of sec.children) {
      if (/^(SCRIPT|LINK|STYLE|TEMPLATE|NOSCRIPT)$/.test(child.tagName)) continue;
      cls = [...child.classList].find(c => !GENERIC.test(c) && !c.includes('__') && !c.includes('--'));
      if (cls) break;
    }
    const info = { name: cls ? humanize(cls) : 'Section', cls: cls || '', heading: clean(sec.querySelector('h1, h2, h3')?.textContent).slice(0, 40), id: sec.id };
    secCache.set(sec, info);
    return info;
  };

  // ---- element path inside its section (max 4 levels) ----
  const desc = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = [...el.classList].filter(c => !/^(js-|is-|slick-|splide)/.test(c)).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };
  const pathOf = el => {
    const out = [];
    for (let e = el; e && e !== body && e.nodeType === 1 && out.length < 4; e = e.parentElement) {
      if (e.matches('section[id^="section-"]')) break;
      out.unshift(desc(e));
    }
    return out.join(' › ');
  };

  return { componentOf, pathOf };
}

function collectSearchParts(doc, visibleOnly, elMap) {
  doc = doc || document;
  const body = doc.body;
  const parts = [];
  if (!body) return parts;
  const clean = s => (s || '').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

  const { componentOf, pathOf } = makeLabeler(doc, elMap);

  // ---- what to skip ----
  const testiSel = '[class*="testimonial" i], [id*="testimonial" i]';
  const testi = [...doc.querySelectorAll(testiSel)]
    .filter(n => n !== body && n !== doc.documentElement && !n.querySelector('header, footer, nav, #global-navbar, #global-sidemenu'));
  const inTesti = el => !!el.closest(testiSel) && testi.some(t => t.contains(el));
  const isClone = el => !!el.closest('.slick-cloned, .splide__slide--clone, .swiper-slide-duplicate');
  // "Visible text" = text inside text elements (headings, p, span, li, links, buttons …), read from the raw HTML,
  // so text in modals and popups still counts. Attributes (alt, title, aria-label, URLs, meta) are not visible text.
  const TEXT_TAGS = 'h1, h2, h3, h4, h5, h6, p, span, li, ol, ul, a, button, label, blockquote, q, td, th, dt, dd, figcaption, strong, em, b, i, small, cite';
  const isVisible = el => !visibleOnly || !!el.closest(TEXT_TAGS);
  const add = (where, s, el, path) => {
    s = clean(s);
    if (!s) return;
    if (el && (inTesti(el) || isClone(el) || !isVisible(el))) return;
    parts.push([where, s, path || pathOf(el), el ? componentOf(el) : null]);
  };

  // ---- collect ----
  if (!visibleOnly) {   // not visible on screen: only searched in "Search everything" mode
    doc.querySelectorAll('meta[property^="og:" i], meta[name^="twitter:" i], meta[name="keywords" i]').forEach(m => {
      const attr = m.hasAttribute('property') ? 'property' : 'name';
      add('meta tag', m.getAttribute('content'), null, `head › meta[${attr}="${m.getAttribute(attr)}"]`);
    });
    body.querySelectorAll('img[alt]').forEach(e => add('alt', e.getAttribute('alt'), e));
    body.querySelectorAll('[title]').forEach(e => add('title attribute', e.getAttribute('title'), e));
    body.querySelectorAll('[aria-label]').forEach(e => add('aria-label', e.getAttribute('aria-label'), e));
    body.querySelectorAll('a[href]').forEach(e => add('link URL', e.getAttribute('href'), e));
    body.querySelectorAll('[placeholder]').forEach(e => add('placeholder', e.getAttribute('placeholder'), e));
  }
  body.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(e => add(e.tagName, e.textContent, e));
  body.querySelectorAll('a').forEach(e => add('link text', e.textContent, e));
  body.querySelectorAll('button').forEach(e => add('button', e.textContent, e));

  // Plain text, grouped by the element that directly holds it (p, span, li, div …).
  const skip = 'h1, h2, h3, h4, h5, h6, a, button, script, style, noscript, template';
  const byParent = new Map();
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || !n.nodeValue.trim() || p.closest(skip)) continue;
    byParent.set(p, (byParent.get(p) || '') + ' ' + n.nodeValue);
  }
  byParent.forEach((t, p) => add('body text', t, p));
  return parts;
}


const SEO_WHERE = new Set(['title', 'description', 'meta tag']);
// Text fragments (#:~:text=) only scroll to text that is visible on the page.
const VISIBLE_WHERE = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'link text', 'button', 'body text']);
const MAX_HITS_SHOWN = 6;

function hitHtml(url, h, re, once) {
  const open = VISIBLE_WHERE.has(h.where)
    ? `<a class="fopen" href="${esc(url + '#:~:text=' + encodeURIComponent(once.exec(h.text)[0]))}" target="_blank" title="Open the page scrolled to this text">↗</a>` : '';
  const c = h.comp;
  const comp = c ? `<span class="fsec" title="${esc([c.template && "Template: " + c.template, c.elId && "Element ID: " + c.elId, c.id && "#" + c.id, c.cls && "div." + c.cls].filter(Boolean).join("\n") || c.name)}">${esc(c.name)}</span>${c.template ? ` <span class="ftpl">${esc(c.template)}</span>` : ""}${c.heading ? ` <span class="fhead">“${esc(c.heading)}”</span>` : ""} › ` : "";
  const onPages = h.pages ? ` <span class="fcount" title="${esc(h.pages.join('\n'))}">· same on ${h.pages.length} page${h.pages.length === 1 ? '' : 's'}</span>` : '';
  return `<div class="fitem">${comp}<span class="fwhere">${esc(h.where)}</span>${h.path ? ` in <code class="fel" title="${esc(h.path)}">${esc(h.path)}</code>` : ''}${h.n > 1 ? ` <span class="fcount">×${h.n}</span>` : ''}${onPages} ${open}
    <div class="fsnip">${snippet(re, h.text)}</div></div>`;
}

// One result card: title line with location tags, first MAX_HITS_SHOWN elements, the rest behind "Show all".
function resultCard(title, sub, url, hits, re, once) {
  const byWhere = new Map();
  hits.forEach(h => byWhere.set(h.where, (byWhere.get(h.where) || 0) + h.n));
  const el = document.createElement('div');
  el.className = 'fhit';
  if (url) el.dataset.url = url;
  el.innerHTML = `<div class="fh"><b>${esc(title)}</b> <span class="fpath">${esc(sub)}</span>
      ${[...byWhere].map(([w, n]) => `<span class="ftag ${SEO_WHERE.has(w) ? 'seo' : 'body'}">${SEO_WHERE.has(w) ? 'seo · ' : ''}${esc(w)} ×${n}</span>`).join('')}</div>
    ${hits.slice(0, MAX_HITS_SHOWN).map(h => hitHtml(h.url || url, h, re, once)).join('')}
    ${hits.length > MAX_HITS_SHOWN ? `<div class="fmore" hidden>${hits.slice(MAX_HITS_SHOWN).map(h => hitHtml(h.url || url, h, re, once)).join('')}</div>
      <button class="fmore-btn" data-more="${hits.length - MAX_HITS_SHOWN}">Show all ${hits.length} elements (+${hits.length - MAX_HITS_SHOWN} more)</button>` : ''}`;
  return el;
}

function runFind() {
  const re = buildRegex();
  const res = $('fres'), sum = $('fsum');
  if (!re) { res.innerHTML = ''; sum.textContent = ''; return; }
  const list = allRows().filter(r => !r.probe);
  if (!list.length) { res.innerHTML = ''; sum.textContent = 'Run the audit first — nothing to search yet.'; return; }

  // Default: visible text only (text elements). "Search everything" adds attributes, alt text, URLs, meta and loose text.
  const everything = $('fall').checked;

  res.innerHTML = '';
  const scope = $('fscope').value;
  const once = new RegExp(re.source, re.flags.replace('g', ''));
  let pages = 0, total = 0;
  const shared = new Map();   // header / side menu / footer / site-wide popups: identical on every page → listed once
  const cards = [];
  for (const r of list) {
    const pieces = [['title', r.title, 'head › title'], ['description', r.description, 'head › meta[name="description"]'],
      ...((everything ? r.parts : r.visibleParts) || [])];
    const hits = [];
    for (const [where, text, path, comp] of pieces) {
      const isSeo = SEO_WHERE.has(where);
      if ((scope === 'seo' && !isSeo) || (scope === 'body' && isSeo)) continue;
      const n = countMatches(re, text);
      if (!n) continue;
      if (comp?.global) {
        const key = [comp.name, where, path, text].join('\u0001');
        const s = shared.get(key) || { where, text, path, comp, n, isSeo, url: r.url, pages: [] };
        s.pages.push(new URL(r.url).pathname || '/');
        shared.set(key, s);
        continue;
      }
      hits.push({ where, text, path, comp, n, isSeo });
    }
    if (!hits.length) continue;
    pages++;
    hits.sort((a, b) => b.isSeo - a.isSeo);   // SEO places first
    total += hits.reduce((s, h) => s + h.n, 0);
    cards.push(resultCard(r.label, new URL(r.url).pathname || '/', r.url, hits, re, once));
  }

  const sharedHits = [...shared.values()];
  if (sharedHits.length) {
    const names = [...new Set(sharedHits.map(h => h.comp.name))].join(' · ');
    res.appendChild(resultCard('Site-wide (same on every page)', names, null, sharedHits, re, once)).classList.add('shared');
  }
  cards.forEach(c => res.appendChild(c));

  const sharedN = sharedHits.reduce((s, h) => s + h.n, 0);
  sum.innerHTML = (pages || sharedHits.length
    ? `<b>${pages}</b> of ${list.length} pages contain it (${total} match${total === 1 ? '' : 'es'})` +
      (sharedHits.length ? ` + ${sharedN} in the header / side menu / footer` : '')
    : `Not found on any of the ${list.length} audited pages.`) +
    ` · ${everything ? 'searching everything (alt text, attributes, link URLs, meta tags, loose text)' : 'visible text only (headings, paragraphs, spans, lists, links, buttons)'}`;
}
function refreshFind() { if (activeTab === 'search') runFind(); else if (activeTab === 'color') runColor(); else if (activeTab === 'spell') renderSpell(); else if (activeTab === 'links') renderLinks(); }

// ---------- tabs: SEO audit / Keyword search ----------
let activeTab = 'seo';
function showTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
  document.querySelectorAll('[data-pane]').forEach(p => { p.hidden = !p.dataset.pane.split(" ").includes(name); });
  $('layout').scrollTop = 0;
  if (name === 'search') { $('fq').focus(); runFind(); }
  else if (name === 'color') { $('cq').focus(); runColor(); }
  else if (name === 'spell') renderSpell();
  else if (name === 'links') { renderLinks(); updateSummary(); }
  else { updateSummary(); updateSelection(); }   // summary, Select all and copy follow the tab
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));

let findTimer;
['input', 'change'].forEach(ev => $('finder').addEventListener(ev, () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 150); }));
function resultsClick(e) {
  if (e.target.closest('a')) return;   // the ↗ link opens the page instead
  // "Show all N elements" expands / collapses the rest of that page's matches
  const more = e.target.closest('.fmore-btn');
  if (more) {
    const box = more.previousElementSibling;
    box.hidden = !box.hidden;
    more.textContent = box.hidden ? `Show all elements (+${more.dataset.more} more)` : 'Show fewer';
    return;
  }
  // Clicking the page name jumps to its card (SEO audit, Neighborhoods or Agents tab)
  if (!e.target.closest('.fh')) return;
  const hit = e.target.closest('.fhit');
  const card = [...layoutEl.querySelectorAll('.page[data-url]')].find(c => c.dataset.url === hit.dataset.url);
  if (!card) return;
  const pane = card.closest('[data-pane]');
  showTab(pane ? pane.dataset.pane.split(' ')[0] : 'seo');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
}
// Same behaviour for keyword and colour results: "Show all", ↗ links, click the page name to jump to its card.
$('fres').addEventListener('click', resultsClick);
$('cres').addEventListener('click', resultsClick);

// ================= colour search =================
// Where LP sites keep colours (checked on real sites):
//   <style id="website-css">       site palette (:root --primary-dark …) and site-wide rules
//   <style id="custom-style-css">  style presets (hyperlink / button / social icon styles)
//   <style id="global-css">        global body styles
//   <style id="page-css">          per-element settings + custom CSS, keyed by #section-<id>
//   style="" attributes            element colour pickers (--bgColor, --textColor …) and hard-coded styles
//   fill / stroke attributes       SVG icons and logos
// Every colour is normalised to RGBA, so #023, #002349, rgb(0 35 73), rgba(0,35,73,.5) and hsl(…) all match.

const NAMED_COLORS = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ');
const NAMED_RE = new RegExp(`(?<![\\w-])(${NAMED_COLORS.join('|')})(?![\\w-])`, 'gi');
const COLOR_PROP = /color|background|border|fill|stroke|outline|shadow|caret|column-rule|text-decoration|^--/i;
const _cctx = document.createElement('canvas').getContext('2d');

// Any CSS colour → [r, g, b, a] (null if it isn't a colour).
function toRGBA(token) {
  let v = null;
  for (const probe of ['#000001', '#000002']) {
    _cctx.fillStyle = probe;
    _cctx.fillStyle = token;
    if (_cctx.fillStyle !== probe) { v = _cctx.fillStyle; break; }
  }
  if (!v) return null;
  if (v[0] === '#') return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1];
  const m = v.match(/[\d.]+/g);
  return m ? [+m[0], +m[1], +m[2], m[3] !== undefined ? +m[3] : 1] : null;
}
const rgbHex = c => '#' + c.slice(0, 3).map(n => Math.round(n).toString(16).padStart(2, '0')).join('');

// Colour tokens inside one CSS value.
function extractColors(prop, value) {
  const out = [], seen = new Set();
  const push = t => {
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    const c = toRGBA(t);
    if (c) { seen.add(k); out.push({ t, c }); }
  };
  (value.match(/#[0-9a-f]{3,8}(?![\w-])/gi) || []).forEach(t => { if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)) push(t); });
  (value.match(/(?:rgba?|hsla?)\([^()]*\)/gi) || []).forEach(t => { if (!/\bfrom\b|var\(/i.test(t)) push(t); });  // relative colours: their #hex is caught above
  if (COLOR_PROP.test(prop)) (value.match(NAMED_RE) || []).forEach(push);
  return out;
}

// Walk every declaration in a CSS text: cb(selector, property, value, media).
// LP stores some colours as split HSL custom properties (--fontColor_H / _S / _L); those are recombined.
function walkCss(text, cb) {
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(text.replace(/@import[^;]+;/gi, ''));
  } catch { return; }
  const visit = (rules, media) => {
    for (const r of rules) {
      if (r.style && r.selectorText !== undefined) {
        const hsl = {};
        for (let i = 0; i < r.style.length; i++) {
          const prop = r.style[i], value = r.style.getPropertyValue(prop).trim();
          const m = prop.match(/^(--[\w-]+?)_([HSL])$/);
          if (m) (hsl[m[1]] = hsl[m[1]] || {})[m[2]] = value;
          cb(r.selectorText, prop, value, media);
        }
        for (const [base, v] of Object.entries(hsl)) {
          if (v.H !== undefined && v.S !== undefined && v.L !== undefined) cb(r.selectorText, `${base} (H/S/L)`, `hsl(${parseFloat(v.H) || 0}, ${v.S}, ${v.L})`, media);
        }
      }
      if (r.cssRules) visit(r.cssRules, r.media ? r.media.mediaText : (r.conditionText || media));
    }
  };
  visit(sheet.cssRules, '');
}

const SITE_STYLE_BLOCKS = { 'website-css': 'Site palette & styles', 'custom-style-css': 'Style presets', 'global-css': 'Site global CSS' };

// Every colour on one page, labelled with its LP element. Runs before scripts/styles are stripped for keyword search.
function collectColorParts(doc, elMap) {
  const parts = [];
  if (!doc.body) return parts;
  const { componentOf, pathOf } = makeLabeler(doc, elMap);
  const styles = [...doc.querySelectorAll('style')];

  // Sections switched off by the page's own CSS (#section-…{display:none}).
  const hiddenIds = new Set();
  styles.forEach(st => walkCss(st.textContent, (sel, prop, value) => {
    const m = sel.trim().match(/^#(section-[0-9a-f-]{36})$/i);
    if (m && ((prop === 'display' && /none/.test(value)) || (prop === 'visibility' && /hidden/.test(value)))) hiddenIds.add(m[1]);
  }));
  const isHidden = el => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.hasAttribute('hidden') || hiddenIds.has(e.id)) return true;
      if (/(?:^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(e.getAttribute('style') || '')) return true;
      if (e.classList && ['d-none', 'is-hidden', 'hidden'].some(c => e.classList.contains(c))) return true;
    }
    return false;
  };
  const add = (src, where, prop, value, el, extra = {}) => {
    const colors = extractColors(prop, value);
    if (!colors.length) return;
    const comp = extra.comp || (el ? componentOf(el) : null);
    parts.push({
      s: src, w: where, p: prop, v: value.length > 260 ? value.slice(0, 257) + '…' : value, m: extra.media || '',
      c: colors, comp, site: !!extra.site,
      h: el && !comp?.global ? isHidden(el) : false,
      absent: !!extra.absent
    });
  };

  // 1) <style> blocks
  styles.forEach(st => {
    const siteLabel = SITE_STYLE_BLOCKS[st.id];
    const src = siteLabel || (st.id === 'page-css' ? 'Element styles (page CSS)' : 'Page <style> block');
    walkCss(st.textContent, (sel, prop, value, media) => {
      if (siteLabel) return add(src, sel, prop, value, null, { site: true, comp: { name: siteLabel, global: true }, media });
      // tie the rule to its element by the first #id in the selector (#section-…, #global-navbar, #modal-…)
      const id = (sel.match(/#([A-Za-z][\w-]*)/) || [])[1];
      const el = id && doc.getElementById(id);
      if (el) return add(src, sel, prop, value, el, { media });
      add(src, sel, prop, value, null, {
        media, absent: !!id,
        comp: id ? { name: 'Element not on this page', heading: '#' + id } : { name: 'Page custom CSS (not tied to an element)' }
      });
    });
  });

  // 2) style="" attributes: element colour settings (--bgColor …) and hard-coded inline styles
  doc.querySelectorAll('[style]').forEach(el => {
    (el.getAttribute('style') || '').split(/;(?![^(]*\))/).forEach(decl => {
      const i = decl.indexOf(':');
      if (i < 0) return;
      const prop = decl.slice(0, i).trim(), value = decl.slice(i + 1).trim();
      if (!prop || !value) return;
      add(prop.startsWith('--') ? 'Element setting' : 'Inline style', pathOf(el) || el.tagName.toLowerCase(), prop, value, el);
    });
  });

  // 3) colour attributes (SVG fill/stroke, legacy color/bgcolor)
  doc.querySelectorAll('[fill], [stroke], [stop-color], [bgcolor], font[color]').forEach(el => {
    for (const a of ['fill', 'stroke', 'stop-color', 'bgcolor', 'color']) {
      const v = el.getAttribute(a);
      if (v) add(el.closest('svg') ? 'SVG attribute' : 'HTML attribute', pathOf(el) || el.tagName.toLowerCase(), a, v, el);
    }
  });
  return parts;
}

// The template's design stylesheet (styles.luxurypresence.com/<design>/index.css): only when asked for, fetched once.
const designCssCache = new Map();
function designCssParts(url) {
  if (!designCssCache.has(url)) designCssCache.set(url, (async () => {
    try {
      const text = await (await fetch(url)).text();
      const slug = (new URL(url).pathname.split('/')[1] || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const parts = [];
      walkCss(text, (sel, prop, value, media) => {
        const colors = extractColors(prop, value);
        if (colors.length) parts.push({ s: 'Template design stylesheet', w: sel, p: prop, v: value.length > 260 ? value.slice(0, 257) + '…' : value, m: media || '',
                                        c: colors, comp: { name: 'Template design stylesheet', template: slug, global: true }, site: true });
      });
      return parts;
    } catch { return []; }
  })());
  return designCssCache.get(url);
}

function parseColorInput(s) {
  s = (s || '').trim();
  if (!s) return null;
  if (/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(s)) s = '#' + s;   // "002349" without the #
  return toRGBA(s);
}

function colorValueHtml(p, isMatch) {
  // highlight the matching tokens and show a swatch for each colour found in the value
  let html = esc(p.v);
  const toks = [...p.c].sort((a, b) => b.t.length - a.t.length);
  for (const k of toks) {
    const re = new RegExp(k.t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, m => `<span class="cswatch" style="background:${esc(k.t)}"></span>${isMatch(k.c) ? `<mark>${m}</mark>` : m}`);
  }
  return html;
}

function compLabel(c) {
  if (!c) return '';
  return `<span class="fsec" title="${esc([c.template && 'Template: ' + c.template, c.elId && 'Element ID: ' + c.elId, c.id && '#' + c.id, c.cls && 'div.' + c.cls].filter(Boolean).join('\n') || c.name)}">${esc(c.name)}</span>` +
    `${c.template ? ` <span class="ftpl">${esc(c.template)}</span>` : ''}${c.heading ? ` <span class="fhead">“${esc(c.heading)}”</span>` : ''} › `;
}

function colorHitHtml(p, isMatch, note = '') {
  const same = p.comp && p.comp.name === p.s;   // site settings: the source already is the label
  return `<div class="fitem">${same ? '' : compLabel(p.comp)}<span class="${same ? 'fsec' : 'fwhere'}">${esc(p.s)}</span>` +
    ` <code class="fel">${esc(p.p)}</code> in <code class="fel" title="${esc(p.w)}">${esc(p.w.length > 90 ? p.w.slice(0, 87) + '…' : p.w)}</code>` +
    `${p.m ? ` <span class="ftpl" title="Media query">@${esc(p.m)}</span>` : ''}${p.h ? ' <span class="chidden" title="This element is hidden on the page (hidden attribute, display:none, or switched off in the page CSS)">hidden</span>' : ''}${note}` +
    `<div class="fsnip cval">${colorValueHtml(p, isMatch)}</div></div>`;
}

function colorCard(title, sub, url, items, isMatch, extraClass = '') {
  const el = document.createElement('div');
  el.className = 'fhit ' + extraClass;
  if (url) el.dataset.url = url;
  const html = items.map(x => colorHitHtml(x.p, isMatch, x.note || ''));
  el.innerHTML = `<div class="fh"><b>${esc(title)}</b> <span class="fpath">${esc(sub)}</span> <span class="ftag body">${items.length} place${items.length === 1 ? '' : 's'}</span></div>
    ${html.slice(0, MAX_HITS_SHOWN).join('')}
    ${html.length > MAX_HITS_SHOWN ? `<div class="fmore" hidden>${html.slice(MAX_HITS_SHOWN).join('')}</div>
      <button class="fmore-btn" data-more="${html.length - MAX_HITS_SHOWN}">Show all ${html.length} places (+${html.length - MAX_HITS_SHOWN} more)</button>` : ''}`;
  return el;
}

let lastColorReport = '';
let colorRun = 0;
async function runColor() {
  const run = ++colorRun;
  const res = $('cres'), sum = $('csum');
  const target = parseColorInput($('cq').value);
  $('cswatch').style.background = target ? `rgba(${target.join(',')})` : 'transparent';
  if (target) $('cpick').value = rgbHex(target);
  res.innerHTML = '';
  lastColorReport = '';
  $('ccopy').disabled = true;
  if (!target) { sum.textContent = $('cq').value.trim() ? 'Not a colour. Use #002349, 002349, rgb(0, 35, 73), hsl(…) or a colour name.' : 'Enter the old colour to find every place it is used.'; return; }
  const list = allRows().filter(r => !r.probe && r.colorParts);
  if (!list.length) { sum.textContent = 'Run the audit first — nothing to search yet.'; return; }

  const tol = +$('ctol').value;
  const isMatch = c => Math.max(Math.abs(c[0] - target[0]), Math.abs(c[1] - target[1]), Math.abs(c[2] - target[2])) <= tol;   // alpha ignored: rgba(…, .5) of the same colour still counts
  const hits = p => p.c.some(k => isMatch(k.c));
  const pathOfUrl = u => new URL(u).pathname || '/';

  // site-wide settings + global elements (header, side menu, footer, popups): identical on every page → listed once
  const shared = new Map();
  const addShared = (p, page) => {
    const key = [p.s, p.comp?.name, p.w, p.p, p.v].join('\u0001');
    const e = shared.get(key) || { p, pages: new Set() };
    e.pages.add(page);
    shared.set(key, e);
  };
  if ($('cdesign').checked) {
    const url = rows.find(r => r.designCss)?.designCss;
    if (url) {
      sum.textContent = 'Reading the template design stylesheet…';
      const parts = await designCssParts(url);
      if (run !== colorRun) return;
      parts.filter(hits).forEach(p => addShared(p, 'template'));
    }
  }

  const report = [];
  const pageCards = [];
  let pageHits = 0, pagesWith = 0;
  for (const r of rows.filter(r => !r.probe && r.colorParts)) {
    const mine = [];
    for (const p of r.colorParts) {
      if (!hits(p)) continue;
      if (p.site || p.comp?.global) addShared(p, pathOfUrl(r.url));
      else mine.push({ p });
    }
    if (!mine.length) continue;
    pagesWith++;
    pageHits += mine.length;
    pageCards.push(colorCard(r.label, pathOfUrl(r.url), r.url, mine, isMatch));
    report.push(`\n${r.label} (${r.url})`, ...mine.map(x => `  - ${x.p.comp?.name || ''}${x.p.comp?.template ? ' [' + x.p.comp.template + ']' : ''} › ${x.p.s}: ${x.p.p} in ${x.p.w} = ${x.p.v}${x.p.h ? '  (hidden)' : ''}`));
  }

  // Neighborhood / agent pages share one page template, but their content differs per page: an element can be
  // shown on one page and hidden or missing on another. One card per group, each place says where it applies.
  const groupCards = [];
  for (const [gkey, g] of Object.entries(dyn)) {
    const gl = g.rows.filter(r => r.colorParts);
    if (!g.on || !gl.length) continue;
    const agg = new Map();
    for (const r of gl) {
      for (const p of r.colorParts) {
        if (!hits(p)) continue;
        if (p.site || p.comp?.global) { addShared(p, pathOfUrl(r.url)); continue; }
        if (p.absent) continue;   // CSS left for an element this page doesn't have: counted as "not on" below
        const key = [p.comp?.name, p.comp?.template, p.s, p.p, p.w.replace(/section-[0-9a-f-]{36}/gi, 'section'), p.v].join('\u0001');
        const e = agg.get(key) || { p, shown: [], hidden: [] };
        (p.h ? e.hidden : e.shown).push(r.label);
        agg.set(key, e);
      }
    }
    if (!agg.size) continue;
    const items = [...agg.values()].map(e => {
      const absent = gl.length - e.shown.length - e.hidden.length;
      const note = ` <span class="cpages" title="${esc(['Shown on: ' + (e.shown.join(', ') || '—'), e.hidden.length ? 'Hidden on: ' + e.hidden.join(', ') : '', absent ? 'Not on the other ' + absent + ' page(s)' : ''].filter(Boolean).join('\n'))}">` +
        `shown on ${e.shown.length}/${gl.length}${e.hidden.length ? ` · <b>hidden on ${e.hidden.length}</b>` : ''}${absent ? ` · not on ${absent}` : ''}</span>`;
      return { p: { ...e.p, h: false }, note, e, absent };
    });
    groupCards.push(colorCard(`${gkey} pages`, `${gl.length} pages · ${items.length} place${items.length === 1 ? '' : 's'}`, null, items, isMatch, 'dyngroup'));
    pageHits += items.length;
    report.push(`\n${gkey} pages (${gl.length})`, ...items.map(x => `  - ${x.p.comp?.name || ''}${x.p.comp?.template ? ' [' + x.p.comp.template + ']' : ''} › ${x.p.s}: ${x.p.p} in ${x.p.w} = ${x.p.v}  — shown on ${x.e.shown.length}/${gl.length}${x.e.hidden.length ? ', hidden on: ' + x.e.hidden.join(', ') : ''}${x.absent ? ', not on ' + x.absent + ' page(s)' : ''}`));
  }

  if (run !== colorRun) return;
  const sharedItems = [...shared.values()].map(e => ({ p: e.p, note: e.pages.has('template') ? '' : ` <span class="cpages" title="${esc([...e.pages].join('\n'))}">same on ${e.pages.size} page${e.pages.size === 1 ? '' : 's'}</span>` }));
  sharedItems.sort((a, b) => (b.p.site - a.p.site));
  if (sharedItems.length) {
    res.appendChild(colorCard('Site-wide settings & shared elements', 'palette · style presets · header · side menu · footer · popups', null, sharedItems, isMatch, 'shared'));
    report.unshift('Site-wide settings & shared elements', ...sharedItems.map(x => `  - ${x.p.comp?.name || ''}${x.p.comp?.template ? ' [' + x.p.comp.template + ']' : ''} › ${x.p.s}: ${x.p.p} in ${x.p.w} = ${x.p.v}`));
  }
  pageCards.forEach(c => res.appendChild(c));
  groupCards.forEach(c => res.appendChild(c));

  const total = sharedItems.length + pageHits;
  const hex = rgbHex(target).toUpperCase();
  sum.innerHTML = total
    ? `<b>${total}</b> place${total === 1 ? '' : 's'} use ${esc(hex)}${tol ? ' (or a near shade)' : ''}: ${sharedItems.length} site-wide · ${pagesWith} page${pagesWith === 1 ? '' : 's'}` +
      `${groupCards.length ? ` · ${groupCards.length} neighborhood/agent group${groupCards.length === 1 ? '' : 's'}` : ''}`
    : `${esc(hex)} isn't used on any of the ${list.length} audited pages${$('cdesign').checked ? ' or in the template stylesheet' : ''}.`;
  if (total) {
    lastColorReport = `Colour ${hex}${tol ? ` (±${tol})` : ''} — ${total} place(s)\n${report.join('\n')}`;
    $('ccopy').disabled = false;
  }
}

let colorTimer;
['input', 'change'].forEach(ev => $('cfinder').addEventListener(ev, e => {
  if (e.target.id === 'cpick') $('cq').value = $('cpick').value;
  clearTimeout(colorTimer);
  colorTimer = setTimeout(runColor, 200);
}));
$('ccopy').addEventListener('click', () => copyWithFeedback($('ccopy'), () => 'Copy report', lastColorReport));

// ---------- Cloudflare email protection ----------
// LP sites are served through Cloudflare, which replaces every email in the HTML with "[email protected]"
// (<span class="__cf_email__" data-cfemail="…"> and href="/cdn-cgi/l/email-protection#…") and decodes it with
// JavaScript in the browser. The audit reads raw HTML, so decode them the same way.
function cfDecode(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let s = '';
    for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return decodeURIComponent(escape(s));
  } catch { return ''; }
}
function decodeCfEmails(doc) {
  doc.querySelectorAll('[data-cfemail]').forEach(el => {
    const email = cfDecode(el.getAttribute('data-cfemail'));
    if (email) el.replaceWith(doc.createTextNode(email));
  });
  doc.querySelectorAll('a[href*="/cdn-cgi/l/email-protection"]').forEach(a => {
    const email = cfDecode(a.getAttribute('href').split('#')[1] || '');
    if (email) a.setAttribute('href', 'mailto:' + email);
  });
}

// ---------- dead links & buttons (optional: "Check links" toggle) ----------
// Every link and button on each audited page is collected during the audit (cheap); the HTTP checks
// only run when the toggle is on. Links in the header / side menu / footer / popups are checked once.
const WIRED_ATTRS = ['data-type', 'data-toggle', 'data-bs-toggle', 'data-target', 'data-bs-target', 'onclick', 'aria-controls',
  'aria-haspopup', 'aria-expanded', 'data-modal', 'data-href', 'data-url', 'data-action', 'data-dismiss', 'data-bs-dismiss', 'data-slide', 'data-filter', 'data-num'];
const WIRED_CLASS = /(^|[\s_-])(js|toggle|close|slick|splide|swiper|lp-arrow|arrow|read-more|btn-more|btn-expand|btn-collapse|load-more|pagination|paginationjs|tab|accordion|dropdown|sub-nav|menu|hamburger|play|filter|search|sort|consent|modal|prev|next)([\s_-]|$)/i;

function collectLinkInventory(doc, base, elMap) {
  const { componentOf, pathOf } = makeLabeler(doc, elMap);
  const origin = new URL(base).origin;
  const links = [], dead = [];
  // A JavaScript-driven control (opens a menu, slider arrow, modal, read more …): not dead even without a URL.
  const isWired = el => WIRED_ATTRS.some(a => el.hasAttribute(a)) ||
    [el, el.parentElement].some(e => e && WIRED_CLASS.test(e.className || '')) ||
    [el, el.parentElement].some(e => e && [...(e.classList || [])].some(c => /^js[A-Z_-]/.test(c))) ||   // jsIGLink, js-btn … filled in by scripts
    !!el.closest('form, [class*="pagination" i], [class*="logo" i], .slick-slider, .splide, .swiper');
  const label = el => clean(el.textContent) || clean(el.getAttribute('aria-label')) || clean(el.getAttribute('title')) ||
    clean(el.querySelector('img[alt]')?.getAttribute('alt')) || '(no text)';
  doc.querySelectorAll('a, button').forEach(el => {
    if (el.closest('template, noscript')) return;
    const base_ = { text: label(el).slice(0, 80), comp: componentOf(el), path: pathOf(el) };
    if (el.tagName === 'BUTTON') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (type === 'submit' || type === 'reset' || isWired(el)) return;
      dead.push({ ...base_, href: '', why: 'Button with no link or action found', maybe: true });
      return;
    }
    if (!el.hasAttribute('href')) {
      if (!isWired(el)) dead.push({ ...base_, href: '', why: 'Link has no href', maybe: true });
      return;
    }
    const raw = el.getAttribute('href').trim();
    if (/^(mailto|tel|sms):/i.test(raw)) return;   // checked by the phone / email check
    if (!raw || raw === '#' || /^javascript:\s*(void\(0\))?;?\s*$/i.test(raw)) {
      if (!isWired(el)) dead.push({ ...base_, href: raw || '(empty)', why: 'Empty link (goes nowhere)' });
      return;
    }
    if (raw.startsWith('#')) return;   // jump within the page
    let u;
    try { u = new URL(raw, base); } catch { dead.push({ ...base_, href: raw, why: 'Malformed URL' }); return; }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    if (u.origin === origin && /^\/home-search(\/|$)/.test(u.pathname)) return;   // LP Home Search app: behind bot protection, excluded from the audit too
    links.push({ ...base_, href: u.href, ext: u.origin !== origin });
  });
  return { links, dead };
}

const linkStatus = new Map();   // url → { state: 'pending' | 'ok' | 'dead' | 'warn', code, note }
let linkCheckRun = 0;
// progress text inside the summary line (that line is rebuilt often, so the element may not exist yet)
function setLinkProg(t) { const el = document.getElementById('linkprog'); if (el) el.textContent = t; }

async function checkUrl(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  // same-site links use your browser session (like the audit); other sites get an anonymous request
  const sameSite = siteOrigin && url.startsWith(siteOrigin);
  const opts = { redirect: 'follow', cache: 'no-store', credentials: sameSite ? 'include' : 'omit', signal: ctl.signal };
  try {
    let res = await fetch(url, { ...opts, method: 'HEAD' });
    if (res.status >= 400) res = await fetch(url, { ...opts, method: 'GET' });   // many servers reject HEAD
    const c = res.status;
    if (c < 400) return { state: 'ok', code: c };
    if (c === 404 || c === 410) return { state: 'dead', code: c, note: 'not found' };
    // Social networks refuse automated / logged-out requests even for pages that exist:
    // LinkedIn answers 999, Facebook 400, Instagram / X 403 or 429. Never call those dead.
    const host = new URL(res.url || url).hostname.replace(/^www\./, '');
    if (/(^|\.)(linkedin|facebook|fb|instagram|twitter|x|tiktok|pinterest|youtube|threads)\.com$/.test(host) && c !== 404 && c !== 410) {
      return { state: 'warn', code: c, note: `${host.split('.')[0]} blocks automatic checks (logged-out); open it to confirm` };
    }
    if (c >= 500 && c <= 599) return { state: 'dead', code: c, note: 'server error' };
    // 400, 401, 403, 429, 999 …: bot protection refuses automated requests even for pages that exist
    return { state: 'warn', code: c, note: c === 999 ? 'request refused (code 999); open it to confirm' : 'the site refused the automatic check, open it to confirm' };
  } catch (e) {
    return { state: 'warn', code: 0, note: e.name === 'AbortError' ? 'timed out' : 'could not connect' };
  } finally {
    clearTimeout(timer);
  }
}

// Check every not-yet-checked link on all audited pages (main + group tabs), then refresh the cards.
async function runLinkCheck() {
  if (!$('tog-links').checked) return;
  const run = ++linkCheckRun;
  // pages we already audited answer for themselves
  allRows().forEach(r => { if (r.status) linkStatus.set(r.url, r.status < 400 ? { state: 'ok', code: r.status } : { state: 'dead', code: r.status, note: r.status === 404 ? 'not found' : 'error' }); });
  const todo = [...new Set(allRows().flatMap(r => (r.linkInv?.links || []).map(l => l.href)))].filter(u => !linkStatus.has(u));
  todo.forEach(u => linkStatus.set(u, { state: 'pending' }));
  rerenderCards();
  let done = 0, i = 0;
  const tick = () => { if (!mainBusy) setLinkProg(todo.length ? `Checking links ${done}/${todo.length}…` : ''); };
  tick();
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < todo.length && run === linkCheckRun) {
      const u = todo[i++];
      linkStatus.set(u, await checkUrl(u));
      done++;
      tick();
      if (done % 15 === 0) rerenderCards();
    }
  }));
  if (run !== linkCheckRun) return;
  setLinkProg('');
  rerenderCards();
}

// Links and buttons of one page with their check result. Page-specific only (wantGlobal = false) or only the
// shared header / side menu / footer / popup ones (wantGlobal = true). includeOk adds the links that work.
function deadItemsFor(r, wantGlobal = false, includeOk = false) {
  const inv = r.linkInv;
  if (!inv) return { items: [], checked: 0, pending: 0 };
  const items = [];
  let checked = 0, pending = 0;
  for (const d of inv.dead) if (!!d.comp?.global === wantGlobal) items.push({ ...d, state: d.maybe ? 'warn' : 'dead' });
  for (const l of inv.links) {
    if (!!l.comp?.global !== wantGlobal) continue;
    const st = linkStatus.get(l.href);
    if (!st || st.state === 'pending') { pending++; if (includeOk) items.push({ ...l, state: 'pending', why: 'checking…' }); continue; }
    checked++;
    if (st.state !== 'ok') items.push({ ...l, state: st.state, why: `${st.code ? 'HTTP ' + st.code + ' · ' : ''}${st.note || ''}` });
    else if (includeOk) items.push({ ...l, state: 'ok', why: `HTTP ${st.code}` });
  }
  const rank = { dead: 0, warn: 1, pending: 2, ok: 3 };
  items.sort((a, b) => rank[a.state] - rank[b.state]);
  return { items, checked, pending };
}

const LINK_ICON = { dead: '✗', warn: '⚠', ok: '✓', pending: '…' };
function linkItemHtml(d) {
  return `<div class="fitem dlitem ${d.state}">${LINK_ICON[d.state]} ${compLabel(d.comp)}<b>${esc(d.text)}</b>` +
    `${d.href ? ` → <a class="dlhref" href="${esc(d.href)}" target="_blank" title="${esc(d.href)}">${esc(d.href.length > 80 ? d.href.slice(0, 77) + '…' : d.href)}</a>` : ''}` +
    `${d.ext ? ' <span class="ftpl">external</span>' : ''} <span class="dlwhy">${esc(d.why)}</span>` +
    `${d.pages ? ` <span class="cpages" title="${esc(d.pages.join('\n'))}">on ${d.pages.length} page${d.pages.length === 1 ? '' : 's'}</span>` : ''}` +
    `${d.path ? `<div class="fsnip"><code class="fel">${esc(d.path)}</code></div>` : ''}</div>`;
}

function linkCard(title, sub, url, items, counts, extraClass = '') {
  const el = document.createElement('div');
  el.className = 'fhit ' + extraClass;
  if (url) el.dataset.url = url;
  const dead = items.filter(d => d.state === 'dead').length, warn = items.filter(d => d.state === 'warn').length;
  const html = items.map(linkItemHtml);
  el.innerHTML = `<div class="fh"><b>${esc(title)}</b> <span class="fpath">${esc(sub)}</span>` +
    `${dead ? `<span class="ftag seo-bad">${dead} dead</span>` : ''}${warn ? `<span class="ftag lwarn">${warn} to check</span>` : ''}` +
    `<span class="ftag body">${counts.checked} checked${counts.pending ? ` · ${counts.pending} pending` : ''}</span></div>
    ${html.slice(0, 12).join('')}
    ${html.length > 12 ? `<div class="fmore" hidden>${html.slice(12).join('')}</div>
      <button class="fmore-btn" data-more="${html.length - 12}">Show all ${html.length} (+${html.length - 12} more)</button>` : ''}`;
  return el;
}

// ---------- Links tab ----------
let lastLinkReport = '';
function renderLinks() {
  if (activeTab !== 'links') return;
  const res = $('lres'), sum = $('lsum');
  res.innerHTML = '';
  lastLinkReport = '';
  $('lcopy').disabled = true;
  if (!rows.length) { sum.textContent = 'Run the audit first.'; return; }
  if (!$('tog-links').checked) {
    sum.innerHTML = 'Turn on <b>Check links</b> to test every link and button on all audited pages (including Neighborhoods / Agents when those tabs are on).';
    return;
  }
  const showAll = $('lfilter').value === 'all';
  const report = [];
  const line = d => `  - [${d.state === 'dead' ? 'DEAD' : d.state === 'warn' ? 'CHECK' : d.state.toUpperCase()}] ${d.comp?.name ? d.comp.name + ' › ' : ''}"${d.text}"${d.href ? ' → ' + d.href : ''} — ${d.why}`;
  let dead = 0, warn = 0, checked = 0, pending = 0, pagesWithProblems = 0;

  // shared header / side menu / footer / popups: checked once
  const shared = new Map();
  let sc = { checked: 0, pending: 0 };
  for (const r of allRows()) {
    const d = deadItemsFor(r, true, showAll);
    for (const it of d.items) {
      const k = [it.comp?.name, it.text, it.href, it.why].join('\u0001');
      const e = shared.get(k) || { ...it, pages: [] };
      e.pages.push(new URL(r.url).pathname || '/');
      shared.set(k, e);
    }
  }
  const sharedItems = [...shared.values()];
  const sharedLinks = new Set(allRows().flatMap(r => (r.linkInv?.links || []).filter(l => l.comp?.global).map(l => l.href)));
  sharedLinks.forEach(u => { const st = linkStatus.get(u); if (!st || st.state === 'pending') sc.pending++; else sc.checked++; });
  const sharedProblems = sharedItems.filter(d => d.state === 'dead' || d.state === 'warn');
  dead += sharedProblems.filter(d => d.state === 'dead').length;
  warn += sharedProblems.filter(d => d.state === 'warn').length;
  checked += sc.checked; pending += sc.pending;
  if (sharedItems.length || showAll) {
    res.appendChild(linkCard('Site-wide links', 'header · side menu · footer · popups', null, sharedItems, sc, sharedProblems.length ? 'broken-links shared' : 'shared'));
  }
  if (sharedProblems.length) report.push('Site-wide (header, side menu, footer, popups)', ...sharedProblems.map(line));

  // every audited page: main pages, then the Neighborhood / Agent tabs that are on
  const groups = [['', rows.filter(r => !r.probe)], ...Object.entries(dyn).filter(([, g]) => g.on).map(([k, g]) => [k, g.rows])];
  for (const [gname, list] of groups) {
    let headerAdded = false;
    for (const r of list) {
      const d = deadItemsFor(r, false, showAll);
      checked += d.checked; pending += d.pending;
      const problems = d.items.filter(x => x.state === 'dead' || x.state === 'warn');
      dead += problems.filter(x => x.state === 'dead').length;
      warn += problems.filter(x => x.state === 'warn').length;
      if (!d.items.length && !(showAll && r.linkInv)) continue;
      if (gname && !headerAdded) {
        const h = document.createElement('div');
        h.className = 'grouph';
        h.textContent = `${gname} pages`;
        res.appendChild(h);
        headerAdded = true;
      }
      if (problems.length) pagesWithProblems++;
      res.appendChild(linkCard(r.label, new URL(r.url).pathname || '/', r.url, d.items, d, problems.length ? 'broken-links' : ''));
      if (problems.length) report.push(`\n${r.label} (${r.url})`, ...problems.map(line));
    }
  }

  sum.innerHTML = (pending ? `Checking… ${checked} done, ${pending} to go · ` : '') +
    (dead || warn
      ? `<b>${dead}</b> dead · <b>${warn}</b> to check by hand · ${pagesWithProblems} page${pagesWithProblems === 1 ? '' : 's'} affected${sharedProblems.length ? ' + site-wide' : ''} · ${checked} links checked`
      : pending ? '' : `✓ No dead links or buttons · ${checked} links checked`);
  if (!res.children.length && !pending) res.innerHTML = '<div class="dynstatus">Nothing to show. Choose “All links” to list every link that was checked.</div>';
  if (report.length) { lastLinkReport = `Dead links & buttons — ${dead} dead, ${warn} to check by hand\n${report.join('\n')}`; $('lcopy').disabled = false; }
}

$('lfilter').addEventListener('change', renderLinks);
$('lcopy').addEventListener('click', () => copyWithFeedback($('lcopy'), () => 'Copy report', lastLinkReport));
$('lres').addEventListener('click', resultsClick);

// After link checks progress: refresh the Links tab and the summary line.
function rerenderCards() {
  renderLinks();
  updateSummary();
}


// ================= spelling check =================
// Same text as Keyword search (visible text + SEO title/description, same element labels, testimonials skipped).
// Spelling comes from LanguageTool's free public API (spelling rules only). Free limits: about 20 requests and
// 75 KB of text per minute, so text is de-duplicated across pages and sent in throttled batches.
const LT_URL = 'https://api.languagetool.org/v2/check';
const spellCache = new Map();   // `${lang}\u0001${text}` → [{ offset, length, word, sugs }]
let spellIgnore = new Set();
chrome.storage.local.get('spellIgnore').then(s => { spellIgnore = new Set(s.spellIgnore || []); updateIgnoreCount(); });
function updateIgnoreCount() { $('signored').textContent = `Ignored words (${spellIgnore.size})`; $('signored').disabled = !spellIgnore.size; }
const persistIgnore = () => { chrome.storage.local.set({ spellIgnore: [...spellIgnore] }); updateIgnoreCount(); };

// All text pieces to check, grouped like keyword search.
function spellPieces() {
  const out = [];
  for (const r of allRows().filter(r => !r.probe)) {
    out.push({ r, where: 'title', text: r.title, path: 'head › title', comp: null, seo: true });
    out.push({ r, where: 'description', text: r.description, path: 'head › meta[name="description"]', comp: null, seo: true });
    for (const [where, text, path, comp] of (r.visibleParts || [])) out.push({ r, where, text, path, comp });
  }
  return out.filter(p => p.text && /[a-z]{3}/i.test(p.text));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ltWindow = [];   // [time, bytes] of recent requests, for the free-tier limits

async function ltCheckBatch(texts, lang) {
  // join unique texts with a blank line; remember where each one starts
  const SEP = '\n\n';
  let body = '', starts = [];
  for (const t of texts) { starts.push(body.length); body += t + SEP; }
  const bytes = new Blob([body]).size;
  // stay under ~18 requests and ~70 KB per rolling minute
  for (;;) {
    const now = Date.now();
    ltWindow = ltWindow.filter(([t]) => now - t < 60000);
    const used = ltWindow.reduce((s, [, b]) => s + b, 0);
    if (ltWindow.length < 18 && used + bytes <= 70000) break;
    $('ssum').textContent = 'Waiting for the free spelling-check limit (resets every minute)…';
    await sleep(3000);
  }
  ltWindow.push([Date.now(), bytes]);
  const form = new URLSearchParams({ text: body, language: lang, enabledOnly: 'true', enabledCategories: 'TYPOS' });
  const res = await fetch(LT_URL, { method: 'POST', body: form });
  if (res.status === 429) { await sleep(20000); return ltCheckBatch(texts, lang); }
  if (!res.ok) throw new Error('LanguageTool HTTP ' + res.status);
  const data = await res.json();
  const perText = texts.map(() => []);
  for (const m of data.matches || []) {
    if (m.rule?.issueType && m.rule.issueType !== 'misspelling') continue;
    let k = starts.length - 1;
    while (k > 0 && starts[k] > m.offset) k--;
    const off = m.offset - starts[k];
    perText[k].push({ offset: off, length: m.length, word: texts[k].substr(off, m.length), sugs: (m.replacements || []).slice(0, 3).map(x => x.value) });
  }
  texts.forEach((t, k) => spellCache.set(`${lang}\u0001${t}`, perText[k]));
}

let spellRunning = false;
async function runSpellCheck() {
  if (spellRunning) return;
  const lang = $('slang').value;
  const texts = [...new Set(spellPieces().map(p => p.text))].filter(t => !spellCache.has(`${lang}\u0001${t}`));
  if (!allRows().length) { $('ssum').textContent = 'Run the audit first — nothing to check yet.'; return; }
  spellRunning = true;
  $('scheck').disabled = true;
  try {
    // batches of up to ~15 KB
    const batches = [];
    let cur = [], size = 0;
    for (const t of texts) {
      if (size + t.length > 15000 && cur.length) { batches.push(cur); cur = []; size = 0; }
      cur.push(t); size += t.length + 2;
    }
    if (cur.length) batches.push(cur);
    for (let b = 0; b < batches.length; b++) {
      $('ssum').textContent = `Checking spelling… batch ${b + 1} of ${batches.length} (text is sent to LanguageTool)`;
      await ltCheckBatch(batches[b], lang);
      if (activeTab === 'spell') renderSpell();
    }
  } catch (e) {
    $('ssum').textContent = 'Spelling check failed: ' + e.message + '. Try again in a minute.';
    return;
  } finally {
    spellRunning = false;
    $('scheck').disabled = false;
  }
  renderSpell();
}

// A flagged word we should skip: ignored, names/places (capitalised), acronyms, emails, URLs, words with digits.
function skipWord(word, text, offset) {
  const w = word.trim();
  if (!w || spellIgnore.has(w.toLowerCase())) return true;
  if (/\d|@|\.\w|^www/i.test(w) || /^[A-Z0-9&]{2,}$/.test(w)) return true;
  if ($('scaps').checked && /^[A-Z]/.test(w)) {
    // keep capitalised words only at the start of a sentence, where a capital says nothing about being a name
    const before = text.slice(0, offset).trimEnd();
    if (before && !/[.!?:]$/.test(before)) return true;
  }
  return false;
}

function spellSnippet(text, m) {
  const a = Math.max(0, m.offset - 50), b = Math.min(text.length, m.offset + m.length + 50);
  return (a ? '…' : '') + esc(text.slice(a, m.offset)) + `<mark class="miss">${esc(text.substr(m.offset, m.length))}</mark>` + esc(text.slice(m.offset + m.length, b)) + (b < text.length ? '…' : '');
}

function spellHitHtml(h) {
  const sugg = h.m.sugs.length ? ` <span class="ssug">→ ${h.m.sugs.map(s => `<b>${esc(s)}</b>`).join(', ')}</span>` : '';
  const pages = h.pages ? ` <span class="cpages" title="${esc(h.pages.join('\n'))}">same on ${h.pages.length} page${h.pages.length === 1 ? '' : 's'}</span>` : '';
  return `<div class="fitem">${compLabel(h.comp)}<span class="fwhere">${esc(h.where)}</span>${h.path ? ` in <code class="fel" title="${esc(h.path)}">${esc(h.path)}</code>` : ''}${pages}` +
    ` <button class="signore" data-word="${esc(h.m.word.toLowerCase())}" title="Not a mistake: ignore this word everywhere">Ignore “${esc(h.m.word)}”</button>${sugg}` +
    `<div class="fsnip">${spellSnippet(h.text, h.m)}</div></div>`;
}

function spellCard(title, sub, url, hits, extraClass = '') {
  const el = document.createElement('div');
  el.className = 'fhit ' + extraClass;
  if (url) el.dataset.url = url;
  const words = [...new Set(hits.map(h => h.m.word))];
  const html = hits.map(spellHitHtml);
  el.innerHTML = `<div class="fh"><b>${esc(title)}</b> <span class="fpath">${esc(sub)}</span> ${words.slice(0, 8).map(w => `<span class="ftag seo-bad">${esc(w)}</span>`).join('')}${words.length > 8 ? `<span class="ftag body">+${words.length - 8}</span>` : ''}</div>
    ${html.slice(0, MAX_HITS_SHOWN).join('')}
    ${html.length > MAX_HITS_SHOWN ? `<div class="fmore" hidden>${html.slice(MAX_HITS_SHOWN).join('')}</div>
      <button class="fmore-btn" data-more="${html.length - MAX_HITS_SHOWN}">Show all ${html.length} (+${html.length - MAX_HITS_SHOWN} more)</button>` : ''}`;
  return el;
}

let lastSpellReport = '';
function renderSpell() {
  const res = $('sres'), sum = $('ssum');
  const lang = $('slang').value;
  res.innerHTML = '';
  lastSpellReport = '';
  $('scopy').disabled = true;
  const pieces = spellPieces();
  if (!pieces.length) { sum.textContent = 'Run the audit first — nothing to check yet.'; return; }
  const unchecked = pieces.filter(p => !spellCache.has(`${lang}\u0001${p.text}`)).length;
  const shared = new Map();
  const byPage = new Map();
  for (const p of pieces) {
    const ms = spellCache.get(`${lang}\u0001${p.text}`);
    if (!ms) continue;
    for (const m of ms) {
      if (skipWord(m.word, p.text, m.offset)) continue;
      const h = { ...p, m };
      if (p.comp?.global) {
        const key = [p.comp.name, p.where, p.path, p.text, m.offset].join('\u0001');
        const s = shared.get(key) || { ...h, pages: [] };
        s.pages.push(new URL(p.r.url).pathname || '/');
        shared.set(key, s);
      } else {
        (byPage.get(p.r) || byPage.set(p.r, []).get(p.r)).push(h);
      }
    }
  }
  const report = [];
  const line = h => `  - "${h.m.word}"${h.m.sugs.length ? ' → ' + h.m.sugs.join(' / ') : ''}  (${h.comp ? h.comp.name + ' › ' : ''}${h.where}${h.seo ? ' [SEO]' : ''})`;
  const sharedHits = [...shared.values()];
  if (sharedHits.length) {
    res.appendChild(spellCard('Site-wide (same on every page)', 'header · side menu · footer · popups', null, sharedHits, 'shared'));
    report.push('Site-wide', ...sharedHits.map(line));
  }
  let total = sharedHits.length, pagesWith = 0;
  for (const [r, hits] of byPage) {
    hits.sort((a, b) => (b.seo ? 1 : 0) - (a.seo ? 1 : 0));
    pagesWith++;
    total += hits.length;
    res.appendChild(spellCard(r.label, new URL(r.url).pathname || '/', r.url, hits));
    report.push(`\n${r.label} (${r.url})`, ...hits.map(line));
  }
  const words = new Set([...sharedHits, ...[...byPage.values()].flat()].map(h => h.m.word.toLowerCase())).size;
  sum.innerHTML = (total
    ? `<b>${words}</b> possible misspelling${words === 1 ? '' : 's'} in ${total} place${total === 1 ? '' : 's'}: ${sharedHits.length} site-wide · ${pagesWith} page${pagesWith === 1 ? '' : 's'}`
    : unchecked === pieces.length ? 'Press <b>Check spelling</b> to check every audited page.' : '✓ No spelling mistakes found.') +
    (unchecked && unchecked < pieces.length ? ` · ${unchecked} text pieces not checked yet` : '');
  if (total) { lastSpellReport = `Spelling (${lang})\n${report.join('\n')}`; $('scopy').disabled = false; }
}

$('scheck').addEventListener('click', runSpellCheck);
$('slang').addEventListener('change', renderSpell);
$('scaps').addEventListener('change', renderSpell);
$('scopy').addEventListener('click', () => copyWithFeedback($('scopy'), () => 'Copy report', lastSpellReport));
$('sres').addEventListener('click', e => {
  const ig = e.target.closest('.signore');
  if (ig) { spellIgnore.add(ig.dataset.word); persistIgnore(); renderSpell(); return; }
  resultsClick(e);
});
$('signored').addEventListener('click', () => {
  const list = [...spellIgnore].sort();
  const keep = prompt('Ignored words (comma-separated). Remove a word to check it again:', list.join(', '));
  if (keep === null) return;
  spellIgnore = new Set(keep.split(',').map(w => w.trim().toLowerCase()).filter(Boolean));
  persistIgnore();
  renderSpell();
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

// styleTags: saved tags that are switched on; an image must have any / all of them (tagMatch).
// opts.waifu: default random picks look like the other sites' "waifu" images: one girl as the subject (1girl + solo).
async function danbooru(keyword, styleTags = [], opts = {}) {
  const tag = keyword.trim().toLowerCase().replace(/\s+/g, '_');
  const want = styleTags.filter(t => t !== tag);   // the searched tag is already guaranteed
  for (let n = 0; n < (want.length ? 30 : 20); n++) {
    const res = await fetch(`${DANBOORU}/posts/random.json?tags=${tag ? encodeURIComponent(tag) + '+' : ''}rating:g`, { cache: 'no-store' });
    if (res.status === 404) return null;                       // no SFW posts for that tag
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    if (p.rating !== 'g' || !p.file_url || !/^(jpe?g|png|webp|gif)$/.test(p.file_ext)) continue;
    const tags = `${p.tag_string_general || ''} ${p.tag_string_meta || ''}`.split(' ');
    if (tags.some(t => SKIP_TAGS.has(t))) continue;
    // Female characters only: must have a "girl" tag and no boy / male-focus / other-gender tag.
    if (!tags.some(t => GIRL_TAG.test(t)) || tags.some(t => NOT_FEMALE_TAG.test(t))) continue;
    if (opts.waifu && !(tags.includes('1girl') && tags.includes('solo'))) continue;
    if (want.length && !(tagMatch === 'all' ? want.every(t => tags.includes(t)) : (want.some(t => tags.includes(t)) || styleTags.includes(tag)))) continue;
    const artist = (p.tag_string_artist || '').split(' ')[0].replace(/_/g, ' ');
    // Source series = Danbooru's "copyright" tags (the franchise). Skip "original"; show up to two.
    const series = (p.tag_string_copyright || '').split(' ').filter(t => t && t !== 'original').slice(0, 2)
      .map(t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())).join(' · ');
    return { url: p.large_file_url || p.file_url, full: p.file_url, credit: artist || null, series,
             creditHref: `${DANBOORU}/posts/${p.id}`, site: 'Danbooru',
             tags: (p.tag_string_general || '').split(' ').filter(Boolean) };   // general tags only (no series/character/artist)
  }
  return null;
}

// No keyword: random pick from three SFW sources, falling back to the others.
// Default Danbooru picks are "waifu" style (one girl, solo), matching the other sites.
// Danbooru is listed twice so about half of the random picks come from it: it is the only source that reports the series.
const randomDanbooru = async () => danbooru('1girl', [], { waifu: true });
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
      if (!$('tagmodal').hidden) renderTagPanel();   // tag panel open: show the new image's tags
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
  const style = [...activeTags];   // saved image tags that are switched on
  $('picroll').disabled = true;
  if (!current) picMessage('Loading image…');

  if (kw || style.length) {
    // Danbooru's free tier allows 2 search tags (one tag + rating:g). Without a series, search one of the saved tags;
    // the rest are checked on each result.
    const searchTag = kw || style[Math.floor(Math.random() * style.length)];
    try {
      const pic = await danbooru(searchTag, style);
      if (!pic) picMessage(kw
        ? `No suitable images found for “${kw}”${style.length ? ' with your saved tags' : ''} (SFW, female characters, non-manga). Try again${style.length ? ', use Match: any, or turn some tags off' : ' or another tag'}.`
        : `No images matched your saved tags. Try again, use Match: any, or turn some tags off.`);
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

// ---------- image tags: pick tags from the current image (or search any tag), save them, filter new images ----------
// Only general tags (hair, clothes, pose, setting …). Series / character tags stay in the search box above.
let savedTags = [];            // e.g. "long_hair"
const activeTags = new Set();  // saved tags that are switched on
let tagMatch = 'any';          // 'any' | 'all'
chrome.storage.local.get(['styleTags', 'styleActive', 'styleMatch']).then(s => {
  savedTags = s.styleTags || [];
  (s.styleActive || []).forEach(t => savedTags.includes(t) && activeTags.add(t));
  tagMatch = s.styleMatch === 'all' ? 'all' : 'any';
  $('tmatch').value = tagMatch;
  updateTagButton();
});
function persistTags() {
  chrome.storage.local.set({ styleTags: savedTags, styleActive: [...activeTags], styleMatch: tagMatch });
  updateTagButton();
}
function updateTagButton() {
  $('tagscount').textContent = activeTags.size || '';
  $('tagsbtn').classList.toggle('on', activeTags.size > 0);
}
const tagName = t => t.replace(/_/g, ' ');

function saveTag(t, on = true) {
  if (!savedTags.includes(t)) savedTags.push(t);
  if (on) activeTags.add(t);
  persistTags();
  renderTagPanel();
}
function unsaveTag(t) {
  savedTags = savedTags.filter(x => x !== t);
  activeTags.delete(t);
  persistTags();
  renderTagPanel();
}

function renderTagPanel() {
  const cur = current?.tags || [];
  $('tcur').innerHTML = cur.length
    ? cur.map(t => `<span class="tchip ${savedTags.includes(t) ? 'saved' : ''}" data-cur="${esc(t)}" title="${savedTags.includes(t) ? 'Saved: click to remove' : 'Click to save'}">${savedTags.includes(t) ? '✓ ' : '+ '}${esc(tagName(t))}</span>`).join('')
    : `<span class="tnone">${current ? `This image is from ${esc(current.site)}, which doesn't provide tags. Press 🎲 for a Danbooru image, or search below.` : 'No image yet.'}</span>`;
  $('tcurcount').textContent = cur.length ? `(${cur.length})` : '';
  $('tsaved').innerHTML = savedTags.length
    ? savedTags.map(t => `<span class="tchip ${activeTags.has(t) ? 'on' : ''}" data-saved="${esc(t)}" title="Click to turn on/off">${esc(tagName(t))}<span class="tx" data-del="${esc(t)}" title="Delete">✕</span></span>`).join('')
    : '<span class="tnone">No saved tags yet. Click tags on the image above, or search below.</span>';
}

$('tagsbtn').addEventListener('click', () => { renderTagPanel(); $('tagmodal').hidden = false; });
$('tclose').addEventListener('click', () => { $('tagmodal').hidden = true; });
$('tagmodal').addEventListener('click', e => { if (e.target === $('tagmodal')) $('tagmodal').hidden = true; });
$('tcur').addEventListener('click', e => {
  const c = e.target.closest('[data-cur]');
  if (!c) return;
  const t = c.dataset.cur;
  savedTags.includes(t) ? unsaveTag(t) : saveTag(t);
});
$('tsaved').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if (del) { unsaveTag(del.dataset.del); return; }
  const c = e.target.closest('[data-saved]');
  if (!c) return;
  const t = c.dataset.saved;
  activeTags.has(t) ? activeTags.delete(t) : activeTags.add(t);
  persistTags();
  renderTagPanel();
});
$('tmatch').addEventListener('change', () => { tagMatch = $('tmatch').value; persistTags(); });
$('tapply').addEventListener('click', () => { $('tagmodal').hidden = true; loadPic(); });

// Find any general tag (Danbooru autocomplete, category 0 = general).
const addFound = () => {
  const t = $('tfind').value.trim().toLowerCase().replace(/\s+/g, '_');
  if (!t) return;
  saveTag(t);
  $('tfind').value = '';
};
$('tadd').addEventListener('click', addFound);
$('tfind').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFound(); } });
let tfTimer;
$('tfind').addEventListener('input', () => {
  clearTimeout(tfTimer);
  const q = $('tfind').value.trim();
  if (q.length < 2) return;
  tfTimer = setTimeout(async () => {
    try {
      const url = `${DANBOORU}/autocomplete.json?search[query]=${encodeURIComponent(q.toLowerCase().replace(/\s+/g, '_'))}&search[type]=tag_query&limit=15`;
      const list = await (await fetch(url)).json();
      $('tfindopts').innerHTML = list
        .filter(t => t.category == null || Number(t.category) === 0)
        .map(t => `<option value="${esc(t.value)}">${esc(t.label || t.value)}${t.post_count ? ' (' + t.post_count + ')' : ''}</option>`)
        .join('');
    } catch { /* suggestions are optional */ }
  }, 250);
});

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
  $('lbsave').textContent = 'Save image';
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeLightbox(); $('settings').hidden = true; $('tagmodal').hidden = true; } });

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
  b.textContent = inp.type === 'password' ? 'Show' : 'Hide';
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
// Expand window with handed-over results → show them; otherwise audit now.
const HANDOFF = new URLSearchParams(location.search).get('state');
(HANDOFF ? restoreState(HANDOFF) : Promise.resolve(false)).then(ok => { if (!ok) run(); });
chrome.storage.local.get(['kwList', 'kwActive']).then(s => {
  savedKw = s.kwList || [];
  (s.kwActive || []).forEach(t => savedKw.includes(t) && activeKw.add(t));
  renderChips();
}).finally(() => { if (!HANDOFF) loadPic(); });   // Expand window: restoreState() shows the handed-over image
