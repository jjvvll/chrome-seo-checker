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

// tel:/sms:/mailto: links whose visible number or email doesn't match the href.
function checkContactLinks(doc) {
  const flags = new Set();
  const digits = s => {
    let d = s.replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1); // drop US country code
    return d;
  };
  doc.querySelectorAll('a[href^="tel:" i], a[href^="sms:" i], a[href^="mailto:" i]').forEach(a => {
    const href = a.getAttribute('href').trim();
    const scheme = href.slice(0, href.indexOf(':')).toLowerCase();
    const target = decodeURIComponent(href.slice(scheme.length + 1)).split(/[?;]/)[0].trim();
    const text = clean(a.textContent);
    if (scheme === 'mailto') {
      const shown = text.match(/[^\s<>()"',;]+@[^\s<>()"',;]+\.[^\s<>()"',;]+/);
      if (shown && shown[0].toLowerCase() !== target.toLowerCase())
        flags.add(`Email mismatch: shows ${shown[0]} but href is mailto:${target}`);
    } else {
      const shown = text.match(/\+?[\d(][\d\s().\-]{6,}\d/);
      if (shown && digits(shown[0]) !== digits(target))
        flags.add(`${scheme === 'tel' ? 'Phone' : 'SMS'} mismatch: shows ${shown[0].trim()} but href is ${scheme}:${target}`);
    }
  });
  return [...flags];
}

const clean = s =>(s || '').replace(/\s+/g, ' ').trim();

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

    row.flags.push(...checkContactLinks(doc));

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

// Quick copy for a single title or description.
resultsEl.addEventListener('click', async e => {
  const btn = e.target.closest('.qcopy');
  if (!btn || btn.disabled) return;
  await navigator.clipboard.writeText(btn.dataset.text);
  btn.textContent = 'Copied ✓';
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1200);
});

function render(row) {
  const div = document.createElement('div');
  const broken = row.flags.length > 0;
  div.className = 'page' + (broken ? ' broken' : '');
  const statusOk = row.probe ? row.status === 404 : row.status === 200;
  const flags = row.flags.map(f => `<span class="flag">⚠ ${esc(f)}</span>`).join('');
  div.dataset.url = row.url;
  div.innerHTML = `
    <div class="head"><span class="name">${esc(row.label)}</span><span class="src">${esc(row.source)}</span>
      <a class="url" href="${esc(row.url)}" target="_blank">${esc(row.url)}</a>
      <span class="badge ${statusOk ? '' : 'bad'}">${row.status ?? 'ERR'}</span>
      <button class="rerun1" title="Re-run this page">↻</button></div>
    ${flags ? `<div class="flags">${flags}</div>` : ''}
    ${field('Title', row.title, row.title.length, 45, 60)}
    ${field('Description', row.description, row.description.length, 145, 160)}`;
  resultsEl.appendChild(div);
  return div;
}

// Re-run a single page, replacing its card in place.
resultsEl.addEventListener('click', async e => {
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
});

function updateSummary() {
  const broken = rows.filter(r => !r.probe && r.flags.some(f => /404|HTTP|failed/i.test(f))).length;
  const seoIssues = rows.filter(r => !r.title || !r.description).length;
  const contact = rows.filter(r => r.flags.some(f => /mismatch/i.test(f))).length;
  statusEl.innerHTML = `Done — ${rows.length} pages. <b class="${broken ? 'redtxt' : ''}">${broken} broken link${broken === 1 ? '' : 's'}</b>, ${seoIssues} missing title/description, <b class="${contact ? 'redtxt' : ''}">${contact} with phone/email mismatches</b>. Fetched live just now.`;
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

  updateSummary();
  copyBtn.disabled = rerunBtn.disabled = false;
}

// ---- Random SFW anime image (nekos.best, waifu.pics, waifu.im; picked at random, falls back to the others) ----
const IMAGE_SOURCES = [
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
    return { url: r.url, credit: r.artists?.[0]?.name, creditHref: r.source, site: 'waifu.im' };
  }
];

async function loadPic() {
  const rollBtn = $('picroll');
  rollBtn.disabled = true;
  const order = [...IMAGE_SOURCES].sort(() => Math.random() - 0.5);
  for (const src of order) {
    try {
      const pic = await src();
      if (!/^https:\/\//.test(pic.url)) continue;
      await new Promise((ok, fail) => {
        $('picimg').onload = ok; $('picimg').onerror = fail; $('picimg').src = pic.url;
      });
      const who = pic.credit
        ? (/^https?:\/\//.test(pic.creditHref || '') ? `<a href="${esc(pic.creditHref)}" target="_blank">${esc(pic.credit)}</a>` : esc(pic.credit))
        : 'unknown artist';
      $('piccredit').innerHTML = `Art by ${who}<br>via ${esc(pic.site)}`;
      $('pic').hidden = false;
      break;
    } catch { /* try the next source */ }
  }
  rollBtn.disabled = false;
}
$('picroll').addEventListener('click', loadPic);

loadPic();
run();
