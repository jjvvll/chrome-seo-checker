const $ = id => document.getElementById(id);
const statusEl = $('status'), resultsEl = $('results'), copyBtn = $('copy'), rerunBtn = $('rerun'), fillEl = $('fill');
const CONCURRENCY = 4;
const ALWAYS_AUDIT = [{ path: '/terms-and-conditions', label: 'Terms & Conditions' }];
let rows = [];

// Runs inside the page: collects sidemenu + footer links (whichever exist).
function extractLinks() {
  const sources = [
    ['Navbar', '#global-navbar a[href]'],
    ['Menu', '#global-sidemenu a[href]'],
    ['Footer', '.footer-navigation a[href], .footer-navigation-row a[href]']
  ];
  const out = [];
  let found = false;
  for (const [source, sel] of sources) {
    const els = document.querySelectorAll(sel);
    if (els.length) found = true;
    els.forEach(a => {
      const raw = a.getAttribute('href').trim();
      if (!raw || raw.startsWith('#') || /^(tel|mailto|javascript):/i.test(raw)) return;
      let u;
      try { u = new URL(raw, location.href); } catch { return; }
      if (u.origin !== location.origin) return;
      const text = a.textContent.replace(/\s+/g, ' ').trim();
      if (/search portal|^home search$/i.test(text) || /^\/home-search(\/|$)/.test(u.pathname)) return; // skip Home Search + My Search Portal
      out.push({ href: u.href, text, source });
    });
  }
  if (!found) return { error: 'No #global-navbar, #global-sidemenu or footer navigation found on this page.' };
  return { origin: location.origin, links: out };
}

function buildList(links, origin) {
  const extra = ALWAYS_AUDIT.map(e => ({ href: origin + e.path, text: e.label, source: 'Default' }));
  const seen = new Set();
  return [{ href: origin + '/', text: 'Home', source: 'Default' }, ...links, ...extra]
    .map(l => { const u = new URL(l.href); u.search = ''; u.hash = ''; return { ...l, href: u.href }; })
    .filter(l => {
      const key = new URL(l.href).pathname.replace(/\/$/, '') || '/';
      if (seen.has(key)) return false; // footer links already in the menu are only checked once
      seen.add(key);
      return true;
    });
}

const clean = s => (s || '').replace(/\s+/g, ' ').trim();

async function audit(link, probeTitle) {
  const row = { url: link.href, label: link.text, source: link.source, probe: !!link.probe,
                status: null, title: '', description: '', error: '', flags: [] };
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
  return `<div class="field"><span class="k">${key}</span>
    <span class="v ${val ? '' : 'missing'}">${val ? esc(val) : 'MISSING'}</span>
    <span class="len ${bad ? 'bad' : ''}">${bad ? '✗' : '✓'} ${len}</span></div>`;
}

function render(row) {
  const div = document.createElement('div');
  const broken = row.flags.length > 0;
  div.className = 'page' + (broken ? ' broken' : '');
  const statusOk = row.probe ? row.status === 404 : row.status === 200;
  const flags = row.flags.map(f => `<span class="flag">⚠ ${esc(f)}</span>`).join('');
  div.innerHTML = `
    <div class="head"><span class="name">${esc(row.label)}</span><span class="src">${esc(row.source)}</span>
      <a class="url" href="${esc(row.url)}" target="_blank">${esc(row.url)}</a>
      <span class="badge ${statusOk ? '' : 'bad'}">${row.status ?? 'ERR'}</span></div>
    ${flags ? `<div class="flags">${flags}</div>` : ''}
    ${field('Title', row.title, row.title.length, 45, 60)}
    ${field('Description', row.description, row.description.length, 145, 160)}`;
  resultsEl.appendChild(div);
}

copyBtn.addEventListener('click', async () => {
  const text = rows.map(r =>
    `${r.url}${r.flags.length ? '  [' + r.flags.join('; ') + ']' : ''}\nTitle: ${r.title || '(missing)'}\nDescription: ${r.description || '(missing)'}`
  ).join('\n\n');
  await navigator.clipboard.writeText(text);
  copyBtn.textContent = 'Copied!';
  setTimeout(() => (copyBtn.textContent = 'Copy all'), 1500);
});
rerunBtn.addEventListener('click', run);

async function run() {
  rows = [];
  resultsEl.innerHTML = '';
  copyBtn.disabled = rerunBtn.disabled = true;
  fillEl.style.width = '0';
  statusEl.textContent = 'Reading page…';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let data;
  try {
    [{ result: data }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractLinks });
  } catch (e) {
    statusEl.textContent = 'Cannot run on this page: ' + e.message;
    rerunBtn.disabled = false;
    return;
  }
  if (data.error) { statusEl.textContent = data.error; rerunBtn.disabled = false; return; }

  $('site').textContent = new URL(data.origin).host;
  const links = buildList(data.links, data.origin);
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
  rows.forEach(render);

  const broken = results.filter(r => r.flags.some(f => /404|HTTP|failed/i.test(f))).length;
  const seoIssues = rows.filter(r => !r.title || !r.description).length;
  statusEl.innerHTML = `Done — ${rows.length} pages. <b class="${broken ? 'redtxt' : ''}">${broken} broken link${broken === 1 ? '' : 's'}</b>, ${seoIssues} missing title/description. Fetched live just now.`;
  copyBtn.disabled = rerunBtn.disabled = false;
}

run();
