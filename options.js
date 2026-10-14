const $ = id => document.getElementById(id);

function showProvider() {
  const p = $('provider').value;
  $('gemini').classList.toggle('off', p !== 'gemini');
  $('claude').classList.toggle('off', p !== 'claude');
}

chrome.storage.local.get(['provider', 'geminiKey', 'geminiModel', 'apiKey', 'model']).then(s => {
  $('provider').value = s.provider || 'gemini';
  $('gkey').value = s.geminiKey || '';
  $('gmodel').value = s.geminiModel || 'gemini-flash-lite-latest';
  $('key').value = s.apiKey || '';
  $('model').value = s.model || 'claude-opus-5-5';
  showProvider();
});

$('provider').addEventListener('change', showProvider);

$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({
    provider: $('provider').value,
    geminiKey: $('gkey').value.trim(),
    geminiModel: $('gmodel').value,
    apiKey: $('key').value.trim(),
    model: $('model').value
  });
  $('saved').textContent = 'Saved ✓';
  setTimeout(() => ($('saved').textContent = ''), 1500);
});
