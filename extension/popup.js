'use strict';
(async () => {
  const $ = id => document.getElementById(id);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
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
  show();
  showStatus();
})();
