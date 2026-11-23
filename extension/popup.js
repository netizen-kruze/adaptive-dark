'use strict';
(async () => {
  const $ = id => document.getElementById(id);
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  // The tests open this page in a tab of its own and name the tab it should act on.
  const forUrl = new URLSearchParams(location.search).get('for');
  if (forUrl) tab = (await browser.tabs.query({})).find(t => t.url === forUrl) || tab;
  let host = '';
  try { const u = new URL(tab.url); if (/^https?:$/.test(u.protocol)) host = u.hostname; } catch (e) {}

  const s = await browser.runtime.sendMessage({ type: 'get' });
  const settings = { enabledByDefault: s.enabledByDefault !== false, followSystem: s.followSystem === true, sites: Object.assign({}, s.sites), force: Object.assign({}, s.force) };

  const site = $('site'), all = $('all'), sys = $('sys'), force = $('force'), status = $('status');
  $('host').textContent = host || 'Firefox does not let add-ons change this page (settings, new tab, add-ons store). Open a normal website to use this switch.';

  const WHY = {
    disabled: 'Off for this site.',
    system: 'Paused: Windows or Firefox is in light mode ("Follow light / dark mode" is on).',
    declares: 'Left alone: this site says it has its own dark design. Tick the box below to darken it anyway.',
    dark: 'Left alone: this page looks dark already. Tick the box below if that is wrong.',
    print: 'Paused while printing.',
    unsupported: 'Not a web page.',
    slow: 'Switched itself off on this page: darkening it was slowing the page down. Reload the page to try again.',
  };
  const showStatus = async () => {
    let text = host ? 'Reload the page to apply.' : '';
    try {
      const r = await browser.tabs.sendMessage(tab.id, { type: 'status' }, { frameId: 0 });
      if (r) text = r.on ? (r.forced ? 'Darkening this page (forced).' : 'Darkening this page.') : (WHY[r.reason] || 'Off.');
    } catch (e) { /* no content script here (about:, addons.mozilla.org, ...) */ }
    status.textContent = text;
  };
  const show = () => {
    all.checked = settings.enabledByDefault;
    sys.checked = settings.followSystem;
    site.disabled = !host;
    site.checked = !!host && (host in settings.sites ? settings.sites[host] : settings.enabledByDefault);
    force.disabled = !host || !site.checked;
    force.checked = !!host && site.checked && settings.force[host] === true;
  };
  const save = async () => {
    await browser.runtime.sendMessage({ type: 'set', settings });   // background applies it to every tab live
    setTimeout(showStatus, 250);
  };

  site.addEventListener('change', () => {
    if (site.checked === settings.enabledByDefault) delete settings.sites[host];
    else settings.sites[host] = site.checked;
    if (!site.checked) delete settings.force[host];
    show(); save();
  });
  force.addEventListener('change', () => {
    if (force.checked) settings.force[host] = true; else delete settings.force[host];
    save();
  });
  all.addEventListener('change', () => { settings.enabledByDefault = all.checked; show(); save(); });
  sys.addEventListener('change', () => { settings.followSystem = sys.checked; save(); });

  // ---- "Copy a problem report": everything needed to look into a page, as plain text.
  // It only goes to the clipboard; the query part of the address (after "?") is left out.
  $('report').addEventListener('click', async () => {
    const lines = ['Adaptive Dark problem report'];
    let page = '';
    try { const u = new URL(tab.url); page = /^https?:$/.test(u.protocol) ? u.origin + u.pathname : u.protocol + ' page'; } catch (e) {}
    let st = null;
    try { st = await browser.tabs.sendMessage(tab.id, { type: 'status', detail: true }, { frameId: 0 }); } catch (e) {}
    lines.push('Page: ' + (page || 'unknown'));
    lines.push('Status: ' + (status.textContent || 'no answer from the page'));
    let fx = '', os = '';
    try { const b = await browser.runtime.getBrowserInfo(); fx = b.name + ' ' + b.version; } catch (e) {}
    try { os = (await browser.runtime.getPlatformInfo()).os; } catch (e) {}
    lines.push(`Version: Adaptive Dark ${browser.runtime.getManifest().version}, ${fx || 'Firefox'}${os ? ', ' + os : ''}`);
    lines.push(`Settings: every site ${settings.enabledByDefault ? 'on' : 'off'}, follow light/dark ${settings.followSystem ? 'on' : 'off'}, forced here ${host && settings.force[host] ? 'yes' : 'no'}`);
    const d = st && st.detail;
    if (d) {
      lines.push(`Details: ${d.elements} elements, ${d.sheets} style sheets, ${d.shadows} shadow roots, ${d.frames} frames, window ${d.view}, ${d.ready}`);
      lines.push(`Work: ${d.restyles} restyles, ${d.workMs} ms in total, longest ${d.longestMs} ms, ${d.cssChars} characters of CSS, ${d.vars} colour variables, ${d.leftToPage} elements left to the page${d.viaApi ? ', CSS applied by the browser' : ''}${d.restarts ? ', restarted ' + d.restarts + ' times' : ''}`);
    }
    lines.push('What looks wrong: ');
    const text = lines.join('\n');
    const box = $('report-text');
    box.value = text;
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch (e) {}
    if (!copied) { box.hidden = false; box.select(); try { copied = document.execCommand('copy'); } catch (e) {} }
    $('report-hint').textContent = copied
      ? 'Copied. Paste it into your message and say what looks wrong; a screenshot helps.'
      : 'Could not copy automatically. Select the text below and copy it.';
    if (!copied) box.hidden = false;
  });
  show();
  showStatus();
})();
