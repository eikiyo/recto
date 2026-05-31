// Per-page wiring. The dispatcher reads body[data-page] and runs the
// matching handler. Each page handler is small and tied to data-testid
// hooks already present in the mockup HTML.

(function () {
  var api = window.rectoApi;
  var toast = (window.recto && window.recto.toast) || function (m) { console.log('[toast]', m); };

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function setText(sel, value) { var el = $(sel); if (el) el.textContent = String(value); }
  function escape(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  // WordPress encodes titles with HTML entities (e.g. &#8211; for em dash).
  // Decode for display only; encode again before re-inserting into HTML.
  function decodeEntities(s) {
    if (!s) return '';
    var el = document.createElement('textarea');
    el.innerHTML = String(s);
    return el.value;
  }
  function showError(e) {
    // 401 from any /api/* call on an auth-gated page means the session expired
    // (or never existed). Redirect to the auth page silently rather than
    // logging a console error and toasting at the user.
    if (e && e.status === 401) {
      var bare = document.body.getAttribute('data-page');
      if (bare && bare !== 'auth') {
        window.location.replace('/app/auth.html?next=' + encodeURIComponent(window.location.pathname + window.location.search));
        return;
      }
    }
    var code = (e && e.body && e.body.error) || (e && e.message) || 'unknown';
    var msg = window.rectoErrors.describe(code);
    toast(msg.what + ' ' + msg.fix);
    console.error('[recto]', code, e);
  }

  function go(path) { window.location.href = path; }

  // ─── auth ─────────────────────────────────────────────────────────────
  function pageAuth() {
    var form = $('#auth-form');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = (form.email && form.email.value || '').trim();
      if (!email) { toast('Enter your email.'); return; }
      api.requestMagicLink(email).then(function (r) {
        toast('Check your inbox.');
        if (r && r.devToken) {
          // Dev mode shortcut: paste the magic-link token straight in.
          setTimeout(function () {
            var t = prompt('Dev token (auto-paste):', r.devToken);
            if (t) window.location.href = api.base + '/api/auth/callback?token=' + encodeURIComponent(t);
          }, 100);
        }
      }).catch(showError);
    });
  }

  // ─── sites-new ────────────────────────────────────────────────────────
  function pageSitesNew() {
    var form = $('#connect-form') || $('#site-form') || $$('form')[0];
    if (!form) return;
    // Pre-fill the URL from ?url= (set by the onboarding card on workbench).
    var prefill = new URLSearchParams(window.location.search).get('url');
    if (prefill) {
      var urlField = form.querySelector('[name="site_url"], [name="url"], #site-url');
      if (urlField && !urlField.value) urlField.value = prefill;
    }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      function get(names) {
        for (var i = 0; i < names.length; i++) {
          var el = form.querySelector('[name="' + names[i] + '"]');
          if (el) return el.value;
        }
        return '';
      }
      var checkedCms = form.querySelector('input[name="cms"]:checked');
      var data = {
        url: get(['url', 'site_url', 'site-url']).trim(),
        cms: (checkedCms && checkedCms.value) || 'wordpress',
      };
      var user = get(['wp_username', 'wp_user']); if (user) data.wp_username = user;
      var pass = get(['wp_app_password', 'wp_pass']); if (pass) data.wp_app_password = pass;
      var wf = get(['webflow_api_key']); if (wf) data.webflow_api_key = wf;
      api.connectSite(data).then(function (site) {
        toast('Site connected. Crawling.');
        return api.recrawl(site.id).then(function (r) {
          go('/app/crawl.html?siteId=' + encodeURIComponent(site.id) + '&crawlId=' + encodeURIComponent(r.crawlId));
        });
      }).catch(showError);
    });
  }

  // ─── post-site-connect summary ────────────────────────────────────────
  // Reachable two ways:
  //   1. /app/setup-summary.html?siteId=<id>            — just connected a site
  //   2. /app/setup-summary.html?siteId=<id>&gsc=connected — after GSC OAuth
  //   3. /app/setup-summary.html?gsc_error=<code>        — GSC OAuth failed
  // The previous build hardcoded "Connected as mira" + miranotes.com etc.; we
  // now hydrate everything from /api/workbench/sites for the active site.
  function pageSetupSummary() {
    var params = new URLSearchParams(window.location.search);
    var siteId = params.get('siteId');
    var gscFlag = params.get('gsc');
    var gscError = params.get('gsc_error');

    if (gscError) {
      var banner = document.getElementById('gsc-error-banner');
      if (banner) {
        banner.hidden = false;
        setText('[data-testid="summary-gsc-error-code"]', gscError);
      }
      setText('[data-testid="summary-status"]', 'Search Console — connection failed');
      setText('[data-testid="summary-host"]', 'Try again.');
    }

    var gscBtn = document.getElementById('cta-gsc');
    var crawlBtn = document.getElementById('cta-skip-gsc');
    if (gscBtn) gscBtn.href = siteId ? '/app/gsc-connect.html?siteId=' + encodeURIComponent(siteId) : '/app/gsc-connect.html';
    if (crawlBtn) {
      crawlBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!siteId) { toast('Connect a site first.'); go('/app/sites-new.html'); return; }
        api.recrawl(siteId).then(function (r) {
          go('/app/crawl.html?siteId=' + encodeURIComponent(siteId) + '&crawlId=' + encodeURIComponent(r.crawlId));
        }).catch(showError);
      });
    }

    if (!siteId) return;

    api.workbenchSites().then(function (rs) {
      var site = (rs.sites || []).find(function (s) { return s.id === siteId; });
      if (!site) return;
      var host = '';
      try { host = new URL(site.url).hostname; } catch (e) { host = site.url; }
      setText('[data-testid="summary-host"]', host);
      setText('[data-testid="summary-cms"]', (site.cms || 'wordpress').toLowerCase());
      if (site.last_crawl_at || site.lastCrawlAt) {
        var ts = site.last_crawl_at || site.lastCrawlAt;
        setText('[data-testid="summary-last-crawl"]', new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');
      }
      if (typeof site.crawlPages === 'number' || typeof site.crawl_pages === 'number') {
        setText('[data-testid="summary-pages"]', String(site.crawlPages ?? site.crawl_pages));
      }
      if (gscFlag === 'connected') {
        setText('[data-testid="summary-gsc"]', 'connected');
        setText('[data-testid="summary-status"]', 'Search Console connected');
      } else if (!gscError) {
        setText('[data-testid="summary-status"]', 'Site connected');
      }
    }).catch(showError);
  }

  // ─── crawl progress ───────────────────────────────────────────────────
  function pageCrawl() {
    var params = new URLSearchParams(window.location.search);
    var siteId = params.get('siteId');
    var crawlId = params.get('crawlId');
    if (!siteId || !crawlId) {
      // Reaching /app/crawl.html with no siteId means navigation got dropped
      // somewhere. We leave the static page as-is (it already says "Waiting
      // for the first page" / "You can close this tab. We will email you
      // when done.") instead of redirecting away — preserves microcopy on
      // the page for tests + linkable canonical state.
      return;
    }

    // Replace the placeholder h1 with the actual hostname.
    api.workbenchSites().then(function (rs) {
      var site = (rs.sites || []).find(function (s) { return s.id === siteId; });
      if (!site) return;
      var host = '';
      try { host = new URL(site.url).hostname; } catch (e) { host = site.url; }
      setText('[data-testid="crawl-host"]', host);
    }).catch(function () { /* silent — show "…" until we know */ });

    var statusEl = $('[data-testid="crawl-status"]') || document.body;
    var progressEl = $('[data-testid="crawl-progress"]');
    var barEl = document.getElementById('bar');
    function render(state) {
      if (statusEl) statusEl.textContent = state.complete ? 'Crawl complete.' : 'Reading your site.';
      if (progressEl) progressEl.textContent = (state.done || 0) + ' / ' + (state.total || '?') + ' pages';
      if (barEl && state.total) {
        var pct = Math.min(100, Math.round((state.done / state.total) * 100));
        barEl.style.width = pct + '%';
        barEl.setAttribute('aria-valuenow', String(pct));
      }
      if (state.complete) setTimeout(function () { go('/app/workbench.html'); }, 1500);
    }
    // Try SSE first; fall back to polling.
    try {
      var es = api.crawlSSE(siteId, crawlId, render);
      window.addEventListener('beforeunload', function () { es.close(); });
    } catch (e) {
      var iv = setInterval(function () {
        api.crawlState(siteId, crawlId).then(render).catch(function () { clearInterval(iv); });
      }, 2000);
    }
  }

  // First-time onboarding card. Shown on workbench iff the user has not yet
  // submitted their name + first site URL. After submit, we POST to
  // /api/users/onboard then forward to sites-new with the URL pre-filled.
  function setupOnboarding() {
    var card = document.getElementById('onboarding-card');
    if (!card) return;
    api.getMe().then(function (me) {
      if (me && me.onboarded) return;
      card.hidden = false;
      var form = document.getElementById('onboarding-form');
      if (!form) return;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var name = (form.name && form.name.value || '').trim();
        var website = (form.website && form.website.value || '').trim();
        if (!name) { toast('Tell us what to call you.'); return; }
        if (!website) { toast('We need your site URL to pre-fill the next step.'); return; }
        var btn = form.querySelector('button[type="submit"]');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        api.onboard({ name: name, website: website }).then(function (r) {
          var prefill = (r && r.website) || website;
          go('/app/sites-new.html?url=' + encodeURIComponent(prefill));
        }).catch(function (err) {
          if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }
          showError(err);
        });
      });
    }).catch(function () { /* silent — workbench still renders */ });
  }

  // ─── workbench ────────────────────────────────────────────────────────
  function pageWorkbench() {
    setupOnboarding();
    api.workbenchSince().then(function (r) {
      setText('[data-testid="num-pages"]', r.pages || 0);
      setText('[data-testid="num-orphans"]', r.orphans || 0);
      setText('[data-testid="num-candidates"]', r.candidates || 0);
      var ts = $('[data-testid="since-ts"]');
      if (ts && r.since) {
        var d = new Date(r.since);
        var pad = function (n) { return String(n).padStart(2, '0'); };
        ts.textContent = 'Since you were last here · ' +
          d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
          ' · ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' local';
      }
    }).catch(showError);

    api.workbenchSites().then(function (r) {
      var list = $('[data-testid="sites-list"]');
      if (!list) return;
      list.innerHTML = '';
      var sites = r.sites || [];
      if (!sites.length) {
        list.innerHTML = '<li class="muted">No sites yet. <a href="/app/sites-new.html">Connect your first site →</a></li>';
        return;
      }
      sites.forEach(function (s) {
        var hostname = '';
        try { hostname = new URL(s.url).hostname; } catch (e) { hostname = s.url; }
        var lastRead = s.last_crawl_at
          ? new Date(s.last_crawl_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
          : 'never crawled';
        var a = document.createElement('a');
        a.className = 'site-row';
        a.href = '/app/orphans.html?siteId=' + encodeURIComponent(s.id);
        a.innerHTML =
          '<div>' +
            '<div class="site-row__name">' + escape(hostname) + '</div>' +
            '<div class="muted" style="font-size: 13px;">' + escape((s.cms || 'wordpress').toLowerCase()) + ' · last read ' + escape(lastRead) + '</div>' +
          '</div>' +
          '<div class="site-row__stat">' + (s.open_orphans || 0) + ' orphans</div>' +
          '<div class="site-row__stat">' + (s.verified_pushes || 0) + ' verified</div>' +
          '<div class="site-row__stat">→</div>';
        list.appendChild(a);
      });
    }).catch(function () { /* silent — page renders skeleton */ });

    // Recent activity = last 5 pushes.
    api.listPushes({ limit: 5 }).then(function (r) {
      var list = $('[data-testid="recent-activity"]');
      if (!list) return;
      var pushes = r.pushes || [];
      if (!pushes.length) {
        list.innerHTML = '<li class="muted">No recent activity yet. Approve a candidate to get started.</li>';
        return;
      }
      list.innerHTML = '';
      pushes.forEach(function (p) {
        var t = p.pushed_at ? new Date(p.pushed_at).toISOString().substr(11, 5) : '';
        var host = '';
        try { host = new URL(p.site_url).hostname; } catch (e) { host = p.site_url; }
        var status = p.status === 'verified' ? 'Pushed' : p.status === 'failed' ? 'Failed' : 'Pending';
        var li = document.createElement('li');
        li.style = 'padding: var(--s-2) 0; border-bottom: 1px solid var(--rule);';
        li.innerHTML = '<span class="mono muted">' + escape(t) + '</span> ' + escape(status) +
          ' link on <span class="mono">' + escape(host) + '</span>';
        list.appendChild(li);
      });
    }).catch(function () { /* silent */ });
  }

  // ─── orphans ──────────────────────────────────────────────────────────
  function pageOrphans() {
    var params = new URLSearchParams(window.location.search);
    var siteId = params.get('siteId');
    if (!siteId) {
      // No site selected. If user has sites → auto-route to the first one.
      // If user has zero sites → show the in-page empty state instead of
      // silently bouncing to /app/sites-new.html (which had the side effect
      // of highlighting the Workbench nav tab and confusing the user about
      // where they were).
      api.listSites().then(function (rs) {
        var first = (rs.sites || [])[0];
        if (first) {
          window.location.replace('/app/orphans.html?siteId=' + encodeURIComponent(first.id));
          return;
        }
        var empty = document.getElementById('orphans-empty');
        if (empty) empty.hidden = false;
        $$('[data-orphans-loaded]').forEach(function (el) { el.style.display = 'none'; });
      }).catch(showError);
      return;
    }

    // Header bits — host + last-read.
    api.workbenchSites().then(function (rs) {
      var match = (rs.sites || []).find(function (s) { return s.id === siteId; });
      if (!match) return;
      var host = '';
      try { host = new URL(match.url).hostname; } catch (e) { host = match.url; }
      setText('[data-testid="orphans-host"]', host);
      if (match.last_crawl_at) {
        var ago = humanAgo(match.last_crawl_at);
        setText('[data-testid="orphans-last-read"]', 'Last read ' + ago);
      }
    }).catch(function () { /* silent */ });

    api.listOrphans(siteId, 50).then(function (r) {
      var list = $('[data-testid="orphan-list"]');
      if (!list) return;
      list.innerHTML = '';
      var rows = r.orphans || [];
      setText('[data-testid="orphan-count"]', rows.length);
      if (!rows.length) {
        list.innerHTML = '<tr><td colspan="4" class="muted" style="padding: var(--s-3); text-align:center;">No orphans found. Either every page has inbound links, or the crawl is still running.</td></tr>';
        return;
      }
      rows.forEach(function (o, idx) {
        var imp = (o.gsc && o.gsc.impressions28d) || 0;
        var tr = document.createElement('tr');
        if (idx < 5) tr.classList.add('top-five');
        tr.dataset.testid = 'orphan-row-' + idx;
        // WordPress titles often arrive entity-encoded ("Title &#8211; Site").
        // Decode for display, then re-escape so XSS attempts in titles can't
        // inject HTML.
        var displayTitle = decodeEntities(o.title || o.h1 || o.slug);
        // Strip the common WP "post — site" suffix to give Mira a clean scan.
        displayTitle = displayTitle.replace(/\s+[–—-]\s+[^–—]+$/, '').trim() || displayTitle;
        tr.innerHTML =
          '<td>' +
            '<div style="font-family: var(--font-display); font-size: 16px; color: var(--ink-deep);">' + escape(displayTitle) + '</div>' +
            '<div class="mono muted" style="font-size: 12px;">' + escape(o.slug) + '</div>' +
          '</td>' +
          '<td class="num">' + imp.toLocaleString() + '</td>' +
          '<td class="num">' + (o.score || 0) + '</td>' +
          '<td><a class="btn btn--sm" href="/app/insertion.html?siteId=' + encodeURIComponent(siteId) + '&orphanId=' + encodeURIComponent(o.id) + '">Fix this →</a></td>';
        tr.addEventListener('click', function (e) {
          if (e.target.closest('a')) return;
          window.location.href = '/app/insertion.html?siteId=' + encodeURIComponent(siteId) + '&orphanId=' + encodeURIComponent(o.id);
        });
        list.appendChild(tr);
      });
    }).catch(showError);
  }

  function humanAgo(ts) {
    var diff = Date.now() - ts;
    var m = Math.round(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.round(h / 24);
    return d + 'd ago';
  }

  // ─── insertion ────────────────────────────────────────────────────────
  function pageInsertion() {
    var params = new URLSearchParams(window.location.search);
    var siteId = params.get('siteId');
    var orphanId = params.get('orphanId');
    if (!siteId || !orphanId) {
      if (siteId) window.location.replace('/app/orphans.html?siteId=' + encodeURIComponent(siteId));
      else window.location.replace('/app/orphans.html');
      return;
    }

    // Header bits — host context.
    api.workbenchSites().then(function (rs) {
      var match = (rs.sites || []).find(function (s) { return s.id === siteId; });
      if (!match) return;
      try { setText('[data-testid="insertion-host"]', new URL(match.url).hostname); }
      catch (e) { setText('[data-testid="insertion-host"]', match.url); }
    }).catch(function () { /* silent */ });

    api.listCandidates(siteId, orphanId).then(function (r) {
      if (r.orphan) {
        var headText = decodeEntities(r.orphan.title || r.orphan.slug);
        setText('[data-testid="orphan-head"]', headText);
        // Legacy spec hook — the old mockup used #orphan-h. Keep both targets
        // in sync so persona specs don't need to know about the rename.
        var legacy = document.getElementById('orphan-h');
        if (legacy) legacy.textContent = headText;
        setText('[data-testid="orphan-slug"]', r.orphan.slug + ' · 0 inbound internal links');
      }
      var list = $('[data-testid="candidate-list"]');
      if (!list) return;
      list.innerHTML = '';
      var cands = r.candidates || [];
      if (!cands.length) {
        list.innerHTML = r.embeddingPending
          ? '<li class="muted" style="padding: var(--s-3);">Embedding still in progress. Refresh in a moment.</li>'
          : '<li class="muted" style="padding: var(--s-3);">No source candidates surfaced. Try a re-crawl or pick a different orphan.</li>';
        return;
      }
      cands.slice(0, 3).forEach(function (c, idx) {
        var li = document.createElement('li');
        li.className = 'candidate' + (idx === 0 ? ' candidate--selected' : '');
        li.setAttribute('data-testid', 'candidate-' + (idx + 1));
        li.style = 'margin-bottom: var(--s-4); padding: var(--s-4); border: 1px solid var(--rule); border-radius: 4px;';
        // Stable IDs for specs only on the first candidate (the focused one).
        var anchorIdAttr = idx === 0 ? ' data-testid="anchor-input"' : '';
        var insertIdAttr = idx === 0 ? ' data-testid="insert-btn"' : '';
        var skipIdAttr = idx === 0 ? ' data-testid="skip-btn"' : '';
        li.innerHTML =
          '<div class="candidate__head" style="display:flex; justify-content:space-between; gap: var(--s-3); margin-bottom: var(--s-2);">' +
            '<div style="font-family: var(--font-display); font-size: 18px;">' + escape(decodeEntities(c.sourceTitle || c.sourceSlug)) + '</div>' +
            '<div>' +
              '<span class="badge badge--info" title="Semantic similarity, 0-100">similarity ' + Math.round((c.similarity || 0) * 100) + '</span> ' +
              '<span class="badge" title="Source authority">authority ' + (c.sourceAuthority || 0) + '</span>' +
            '</div>' +
          '</div>' +
          '<p class="mono muted" style="font-size: 12px;">' + escape(c.sourceSlug) + '</p>' +
          '<div class="candidate__paragraph" style="font-family: var(--font-display); font-size: 15px; line-height: 1.6; color: var(--ink-mid); margin: var(--s-3) 0; padding: var(--s-2); background: var(--cream-soft); border-left: 2px solid var(--rule);">' +
            escape(c.paragraphExcerpt).slice(0, 360) + (c.paragraphExcerpt && c.paragraphExcerpt.length > 360 ? '…' : '') +
          '</div>' +
          '<div style="margin-bottom: var(--s-3);">' +
            '<label class="mono muted" for="anchor-' + escape(c.id) + '" style="font-size: 12px; display:block; margin-bottom: var(--s-1);">Anchor text</label>' +
            '<input id="anchor-' + escape(c.id) + '" class="anchor-input"' + anchorIdAttr + ' data-id="' + escape(c.id) + '" value="' + escape(c.anchorText) + '" style="width:100%; padding: var(--s-2); border: 1px solid var(--rule); font-family: var(--font-display); font-size: 16px;">' +
          '</div>' +
          '<div style="display:flex; gap: var(--s-3);">' +
            '<button class="btn btn--primary"' + insertIdAttr + ' data-action="push" data-id="' + escape(c.id) + '">Approve and push</button>' +
            '<button class="btn"' + skipIdAttr + ' data-action="regen" data-id="' + escape(c.id) + '">Regenerate anchor</button>' +
          '</div>';
        list.appendChild(li);
      });
      if (r.embeddingPending) toast('Embedding still in progress. Refresh in a moment.');
    }).catch(showError);

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      var row = btn.closest('.candidate, .candidate-row');
      var input = row && row.querySelector('.anchor-input');
      if (btn.getAttribute('data-action') === 'push') {
        btn.disabled = true;
        // If the anchor was edited inline, persist the override before pushing.
        var override = input ? input.value.trim() : '';
        var current = input ? input.getAttribute('value') : '';
        var saveAnchor = (override && override !== current)
          ? api.setAnchor(id, override)
          : Promise.resolve(null);
        saveAnchor
          .then(function () { return api.push(id); })
          .then(function () {
            toast('Pushed. Verifying now.');
            setTimeout(function () { go('/app/audit.html'); }, 1200);
          })
          .catch(function (err) { btn.disabled = false; showError(err); });
      } else if (btn.getAttribute('data-action') === 'regen') {
        btn.disabled = true;
        api.regenerateAnchor(id).then(function (r) {
          if (input) { input.value = r.anchorText; input.setAttribute('value', r.anchorText); }
          toast('New anchor: ' + r.anchorText);
        }).catch(showError).then(function () { btn.disabled = false; });
      }
    });
  }

  // ─── audit ────────────────────────────────────────────────────────────
  // Renders into either a <ul data-testid="audit-list"> (legacy) or the
  // table <tbody data-testid="audit-list"> on /app/audit.html. We detect
  // tag and emit <tr> vs <li> accordingly.
  function pageAudit() {
    api.listPushes({ limit: 100 }).then(function (r) {
      var list = $('[data-testid="audit-list"]');
      if (!list) return;
      list.innerHTML = '';
      var isTable = list.tagName === 'TBODY';
      var pushes = r.pushes || [];
      if (!pushes.length) {
        list.innerHTML = isTable
          ? '<tr><td colspan="6" class="muted" style="padding: var(--s-3); text-align:center;">No pushes yet — approve a candidate from the Orphans page to start.</td></tr>'
          : '<li class="muted">No pushes yet — approve a candidate from the Orphans page to start.</li>';
        return;
      }
      pushes.forEach(function (p) {
        var statusClass = p.status === 'verified' ? 'ok' : p.status === 'failed' ? 'risk' : 'warn';
        var badgeGlyph = p.status === 'verified' ? '✓' : p.status === 'failed' ? '✕' : '!';
        var statusLabel = p.status === 'verified'
          ? 'verified live' + (p.verified_via ? ' · ' + escape(p.verified_via) : '')
          : (p.status === 'failed' ? 'push failed' + (p.failure_code ? ' (' + escape(p.failure_code) + ')' : '') : 'pending');
        var when = p.pushed_at ? new Date(p.pushed_at).toISOString().replace('T', ' ').slice(0, 16) : '';
        var site = '';
        try { site = new URL(p.site_url).hostname; } catch (e) { site = p.site_url || ''; }
        var failureNote = '';
        if (p.failure_code && window.rectoErrors && window.rectoErrors.describe) {
          var msg = window.rectoErrors.describe(p.failure_code);
          failureNote = '<div class="muted" style="font-size:11px; margin-top:2px;">' + escape(msg.what || '') + '</div>';
        }
        // Only emit a real action when the row has a real backend operation
        // available. Retry exists (POST /api/pushes/:id/retry). Undo + Verify
        // do not exist in the worker — we render nothing rather than a
        // dead-link stub.
        var retryLink = p.status === 'failed'
          ? '<button type="button" class="btn btn--sm" data-action="retry" data-id="' + escape(p.id) + '">Retry</button>'
          : '';

        if (isTable) {
          var tr = document.createElement('tr');
          tr.setAttribute('data-testid', 'audit-row-' + (list.children.length + 1));
          tr.innerHTML =
            '<td class="mono muted">' + escape(when) + '</td>' +
            '<td class="mono">' + escape(site) + '</td>' +
            '<td class="mono" style="font-size:12px;">' + escape(p.source_slug) + '<br>→ ' + escape(p.orphan_slug) + '</td>' +
            '<td>' + escape(p.anchor_text) + failureNote + '</td>' +
            '<td><span class="badge badge--' + statusClass + '"><span class="badge__glyph" aria-hidden="true">' + badgeGlyph + '</span>' + statusLabel + '</span></td>' +
            '<td>' + retryLink + '</td>';
          list.appendChild(tr);
        } else {
          var li = document.createElement('li');
          li.className = 'audit-row audit-row--' + (p.status === 'verified' ? 'ok' : p.status === 'failed' ? 'err' : 'pending');
          li.innerHTML =
            '<div class="audit-row__where"><code>' + escape(p.source_slug) + '</code> → <code>' + escape(p.orphan_slug) + '</code></div>' +
            '<div class="audit-row__anchor"><em>' + escape(p.anchor_text) + '</em></div>' +
            '<div class="audit-row__status">' + escape(p.status) + (p.verified_via ? ' · ' + escape(p.verified_via) : '') + '</div>' +
            failureNote + retryLink;
          list.appendChild(li);
        }
      });
    }).catch(showError);

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action="retry"]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      btn.disabled = true;
      api.retryPush(id).then(function () { toast('Queued for retry.'); setTimeout(function () { window.location.reload(); }, 800); }).catch(function (e) { btn.disabled = false; showError(e); });
    });
  }

  // ─── gsc-connect ──────────────────────────────────────────────────────
  function pageGscConnect() {
    var btn = $('[data-testid="gsc-connect"]');
    if (!btn) return;
    var params = new URLSearchParams(window.location.search);
    var siteId = params.get('siteId');
    btn.addEventListener('click', function () {
      var pick = siteId
        ? Promise.resolve(siteId)
        : api.listSites().then(function (rs) { return (rs.sites || [])[0] && (rs.sites || [])[0].id; });
      pick.then(function (id) {
        if (!id) { toast('Connect a site first.'); window.location.href = '/app/sites-new.html'; return; }
        return api.gscConnect(id).then(function (r) {
          if (r && r.url) window.location.href = r.url;
          else toast('GSC connect returned no URL.');
        });
      }).catch(showError);
    });
  }

  // ─── settings-byok ────────────────────────────────────────────────────
  function pageSettingsByok() {
    var form = $('#byok-form');
    if (!form) return;

    function refresh() {
      api.getMe().then(function (me) {
        setText('[data-testid="license-email"]', me.email);
        var codes = me.license.codes || 0;
        var codeLabel = codes === 0
          ? 'no codes redeemed yet'
          : codes + ' code' + (codes === 1 ? '' : 's') + ' · ' + me.license.sitesAllowed + ' site' + (me.license.sitesAllowed === 1 ? '' : 's');
        setText('[data-testid="license-tier"]', codeLabel);
        setText('[data-testid="license-sites"]', me.license.sitesUsed + ' of ' + me.license.sitesAllowed + ' used');
        var monthly = me.monthlyCreditsTotal || 0;
        var resetLabel = me.nextResetAt ? formatResetDate(me.nextResetAt) : '';
        var creditsLine = monthly === 0
          ? me.anchorCredits + ' remaining'
          : me.anchorCredits + ' of ' + monthly + ' this month' + (resetLabel ? ' · resets ' + resetLabel : '');
        setText('[data-testid="license-credits"]', creditsLine);
        setText('[data-testid="openai-state"]', me.byok.openai ? '· key on file' : '');
        setText('[data-testid="anthropic-state"]', me.byok.anthropic ? '· key on file' : '');
        var digestCheckbox = $('[data-testid="digest-opt-in"]');
        if (digestCheckbox) digestCheckbox.checked = !!me.digestOptIn;
      }).catch(showError);
    }

    function formatResetDate(ms) {
      var d = new Date(ms);
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return months[d.getUTCMonth()] + ' ' + d.getUTCDate();
    }
    refresh();

    // Site/GSC integrations panel.
    api.listSites().then(function (rs) {
      var sites = rs.sites || [];
      setText('[data-testid="wp-state"]', sites.length + ' site' + (sites.length === 1 ? '' : 's') + ' connected');
      var gscOn = sites.some(function (s) { return !!s.gsc_property; });
      var el = $('[data-testid="gsc-state"]');
      if (el) {
        el.textContent = gscOn ? 'connected' : 'not connected';
        if (gscOn) el.classList.add('badge--ok');
      }
    }).catch(function () { /* silent */ });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = {};
      var oa = form.querySelector('[name="openai_key"]').value.trim();
      var an = form.querySelector('[name="anthropic_key"]').value.trim();
      var digest = $('[data-testid="digest-opt-in"]').checked;
      if (oa) payload.byokOpenaiKey = oa;
      if (an) payload.byokAnthropicKey = an;
      payload.digestOptIn = digest;
      api.updateMe(payload).then(function () {
        toast('Saved.');
        form.querySelector('[name="openai_key"]').value = '';
        form.querySelector('[name="anthropic_key"]').value = '';
        refresh();
      }).catch(showError);
    });

    var clearOA = $('#clear-openai');
    if (clearOA) clearOA.addEventListener('click', function () {
      api.deleteByok('openai').then(function () { toast('OpenAI key removed.'); refresh(); }).catch(showError);
    });
    var clearAN = $('#clear-anthropic');
    if (clearAN) clearAN.addEventListener('click', function () {
      api.deleteByok('anthropic').then(function () { toast('Anthropic key removed.'); refresh(); }).catch(showError);
    });
  }

  // ─── gaps ─────────────────────────────────────────────────────────────
  function pageGaps() {
    var params = new URLSearchParams(window.location.search);
    var siteId = params.get('siteId');
    if (!siteId) {
      // Same pattern as pageOrphans — auto-route to the first site if there
      // is one, otherwise reveal the empty state on this very page so the
      // nav indicator does not appear to bounce the user.
      api.listSites().then(function (rs) {
        var first = (rs.sites || [])[0];
        if (first) {
          window.location.replace('/app/gaps.html?siteId=' + encodeURIComponent(first.id));
          return;
        }
        var empty = document.getElementById('gaps-empty');
        if (empty) empty.hidden = false;
        $$('[data-gaps-loaded]').forEach(function (el) { el.style.display = 'none'; });
      }).catch(showError);
      return;
    }
    api.workbenchSites().then(function (rs) {
      var m = (rs.sites || []).find(function (s) { return s.id === siteId; });
      if (m) {
        try { setText('[data-testid="gaps-host"]', new URL(m.url).hostname); }
        catch (e) { setText('[data-testid="gaps-host"]', m.url); }
      }
    }).catch(showError);
    api.publishingGap(siteId).then(function (r) {
      var list = $('[data-testid="gap-list"]');
      if (!list) return;
      var gaps = r.gaps || [];
      if (!gaps.length) {
        list.innerHTML = '<li class="muted">No gaps detected. Your site has source pages for every orphan cluster.</li>';
        return;
      }
      list.innerHTML = '';
      gaps.forEach(function (g) {
        var li = document.createElement('li');
        li.className = 'card';
        li.style = 'margin-bottom: var(--s-4);';
        var samples = (g.samples || []).map(function (t) { return '<li>' + escape(decodeEntities(t)) + '</li>'; }).join('');
        li.innerHTML =
          '<p class="mono" style="font-size: 12px; color: var(--ochre-text); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: var(--s-2);">Gap · ' + g.orphanCount + ' orphans</p>' +
          '<h3 style="margin-bottom: var(--s-2);">' + escape(g.cluster) + '</h3>' +
          '<p class="muted" style="font-size: 14px; margin-bottom: var(--s-3);">No source page strongly tied to this cluster. Consider a pillar piece.</p>' +
          (samples ? '<ul style="padding-left: var(--s-5); color: var(--ink-mid); font-size: 14px; margin: 0;">' + samples + '</ul>' : '');
        list.appendChild(li);
      });
    }).catch(showError);
  }

  var routes = {
    auth: pageAuth,
    'sites-new': pageSitesNew,
    crawl: pageCrawl,
    workbench: pageWorkbench,
    orphans: pageOrphans,
    insertion: pageInsertion,
    audit: pageAudit,
    'gsc-connect': pageGscConnect,
    'setup-summary': pageSetupSummary,
    'settings-byok': pageSettingsByok,
    gaps: pageGaps,
  };

  function dispatch() {
    var page = document.body.getAttribute('data-page');
    var handler = routes[page];
    window.rectoErrors.load().catch(function () { /* ignore */ });
    if (handler) handler();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', dispatch);
  } else {
    dispatch();
  }
})();
