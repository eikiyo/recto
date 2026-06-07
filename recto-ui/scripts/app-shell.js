// recto — minimal app behavior. No framework. No telemetry.
(function () {
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function mountNav() {
    if (document.querySelector('header.nav')) return;
    const nav = el(
      '<header class="nav" role="banner">' +
        '<div class="nav__inner">' +
          '<a class="nav__brand" href="/" aria-label="recto, home">recto</a>' +
          '<nav class="nav__links" aria-label="App">' +
            '<label class="site-switch" data-testid="site-switch-wrap" hidden>' +
              '<span class="sr-only">Active site</span>' +
              '<select data-testid="site-switch" aria-label="Switch site"></select>' +
            '</label>' +
            '<a href="/app/workbench.html" data-nav="workbench">Home</a>' +
            '<a href="/app/quick-wins.html" data-nav="quick-wins">Quick wins</a>' +
            '<a href="/app/audit.html" data-nav="audit">Audit</a>' +
            '<a href="/app/settings-byok.html" data-nav="settings">Settings</a>' +
            '<a href="#" data-nav-signout data-testid="nav-signout">Sign out</a>' +
          '</nav>' +
        '</div>' +
      '</header>'
    );
    document.body.insertBefore(nav, document.body.firstChild);
    var here = document.body.dataset.nav;
    if (here) {
      var a = nav.querySelector('[data-nav="' + here + '"]');
      if (a) a.setAttribute('aria-current', 'page');
    }
    var signout = nav.querySelector('[data-nav-signout]');
    if (signout) {
      signout.addEventListener('click', function (e) {
        e.preventDefault();
        // Fire-and-forget logout — even if the call fails (e.g., already
        // expired), we still want to land the user on the marketing site so
        // they get a clean state.
        var done = function () { window.location.href = '/'; };
        if (window.rectoApi && window.rectoApi.logout) {
          window.rectoApi.logout().then(done, done);
        } else {
          done();
        }
      });
    }
    mountSiteSwitcher(nav);
  }

  // Site switcher: surfaces on any page where the current URL carries a
  // `siteId` query param. Lets a multi-code user jump between sites without
  // returning to the workbench. Selecting a site rewrites siteId in-place so
  // the per-page handler (orphans, insertion, audit, etc.) re-runs against
  // the new site_id. Hidden on single-site accounts to keep the chrome quiet.
  function mountSiteSwitcher(nav) {
    var params = new URLSearchParams(window.location.search);
    var currentSiteId = params.get('siteId');
    if (!currentSiteId) return; // page has no site context — nothing to switch
    var wrap = nav.querySelector('[data-testid="site-switch-wrap"]');
    var select = nav.querySelector('[data-testid="site-switch"]');
    if (!wrap || !select || !window.rectoApi) return;
    window.rectoApi.workbenchSites().then(function (r) {
      var sites = (r && r.sites) || [];
      if (sites.length < 2) return; // only one site → no need for a switcher
      sites.forEach(function (s) {
        var host = '';
        try { host = new URL(s.url).hostname; } catch (e) { host = s.url; }
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = host;
        if (s.id === currentSiteId) opt.selected = true;
        select.appendChild(opt);
      });
      wrap.hidden = false;
      select.addEventListener('change', function () {
        var next = new URLSearchParams(window.location.search);
        next.set('siteId', select.value);
        // Drop any orphan-scoped params (orphanId) when jumping sites — they
        // belong to the previous site's pages and would 404.
        next.delete('orphanId');
        window.location.search = '?' + next.toString();
      });
    }).catch(function () { /* silent — switcher just stays hidden */ });
  }

  function toast(message, undoFn) {
    var host = document.querySelector('.toast-host');
    if (!host) { host = el('<div class="toast-host" role="status" aria-live="polite"></div>'); document.body.appendChild(host); }
    // Build the structure WITHOUT interpolating the message — el() parses its
    // argument as HTML (template.innerHTML), so concatenating `message` made the
    // toast an HTML-injection sink (e.g. toast('New anchor: '+anchorText), where
    // anchorText is verbatim crawled page content). The message is set via
    // textContent below so it can never be parsed as markup. (XSS hardened 2026-06-07.)
    var t = el(
      '<div class="toast" role="status">' +
        '<span data-testid="toast-msg"></span>' +
        (undoFn ? '<button class="toast__undo" data-testid="toast-undo">Undo</button>' : '') +
      '</div>'
    );
    t.querySelector('[data-testid="toast-msg"]').textContent = String(message == null ? '' : message);
    host.appendChild(t);
    if (undoFn) {
      t.querySelector('.toast__undo').addEventListener('click', function () { undoFn(); t.remove(); });
    }
    setTimeout(function () { t.remove(); }, 5000);
  }

  window.recto = { toast: toast };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (!document.body.classList.contains('no-nav')) mountNav();
    });
  } else {
    if (!document.body.classList.contains('no-nav')) mountNav();
  }
})();
