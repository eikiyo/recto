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
    // CMS radio selection highlight (visual only). Lives here, not as an inline
    // <script>, so it complies with the page CSP (script-src 'self').
    Array.prototype.forEach.call(document.querySelectorAll('input[name="cms"]'), function (r) {
      r.addEventListener('change', function (e) {
        Array.prototype.forEach.call(document.querySelectorAll('.radio'), function (l) { l.classList.remove('radio--selected'); });
        var lab = e.target.closest('.radio');
        if (lab) lab.classList.add('radio--selected');
      });
    });
    var params = new URLSearchParams(window.location.search);
    // EDIT MODE: ?siteId=<id> turns this into "update credentials" for an
    // existing site — verify + re-encrypt the app password WITHOUT re-crawling.
    // This is how a user fixes a wp_auth_failed push without losing the crawl.
    var editSiteId = params.get('siteId');
    var urlField = form.querySelector('[name="site_url"], [name="url"], #site-url');

    if (editSiteId) {
      var submitBtn = form.querySelector('[type="submit"], [data-testid="connect-btn"]');
      if (submitBtn) submitBtn.textContent = 'Update credentials';
      // Lock the URL (creds-only update) and hydrate it from the API.
      if (urlField) { urlField.readOnly = true; urlField.style.opacity = '0.6'; }
      api.workbenchSites().then(function (rs) {
        var s = (rs.sites || []).find(function (x) { return x.id === editSiteId; });
        if (s && urlField) urlField.value = s.url;
      }).catch(function () {});
    } else {
      // Pre-fill the URL from ?url= (set by the onboarding card on workbench).
      var prefill = params.get('url');
      if (prefill && urlField && !urlField.value) urlField.value = prefill;
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

      if (editSiteId) {
        // Update-credentials path: verify + save, then back to audit so the user
        // can Retry the failed push immediately. No re-crawl.
        api.updateCreds(editSiteId, {
          wp_username: data.wp_username,
          wp_app_password: data.wp_app_password,
          webflow_api_key: data.webflow_api_key,
        }).then(function () {
          toast('Credentials verified and saved.');
          go('/app/audit.html');
        }).catch(showError);
        return;
      }

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
    var etaEl = $('[data-testid="crawl-eta"]');
    var barEl = document.getElementById('bar');

    // ETA: sample the first (done, time) pair, then extrapolate pages/sec from
    // it. Cheap, no server support needed; "estimating…" until we have a rate.
    var t0 = null, done0 = null;
    function nowMs() {
      return (window.performance && performance.now) ? performance.now() : (+new Date());
    }
    function etaText(state) {
      var done = state.done || 0, total = state.total || 0;
      if (!total || done >= total) return '';
      var now = nowMs();
      if (t0 === null && done > 0) { t0 = now; done0 = done; }
      if (t0 === null || done <= done0) return ' · estimating…';
      var rate = (done - done0) / ((now - t0) / 1000); // pages/sec
      if (!(rate > 0)) return ' · estimating…';
      var secs = Math.ceil((total - done) / rate);
      if (secs >= 90) return ' · ~' + Math.ceil(secs / 60) + ' min left';
      return ' · ~' + secs + 's left';
    }

    var pendingPolls = 0;
    function render(state) {
      // The poll/SSE can hand us null (DO not yet initialized), an error shape,
      // or a {pending:true} placeholder. render MUST tolerate all of them — a
      // throw here used to be swallowed by the poller and freeze the page on the
      // static "Starting…" copy. (Learning 2026-06-06: progress must never lie.)
      if (!state || typeof state !== 'object') state = { done: 0, total: 0, complete: false, pending: true };
      var total = state.total || 0;
      var done = state.done || 0;
      var waiting = !total && !state.complete;

      if (statusEl) statusEl.textContent = state.complete ? 'Crawl complete.' : (waiting ? 'Starting…' : 'Reading your site.');
      if (progressEl) progressEl.textContent = waiting ? 'Waiting for the first page…' : (done + ' / ' + (total || '?') + ' pages');
      if (etaEl) etaEl.textContent = state.complete ? '' : etaText(state);
      if (barEl && total) {
        var pct = Math.min(100, Math.round((done / total) * 100));
        barEl.style.width = pct + '%';
        barEl.setAttribute('aria-valuenow', String(pct));
      }
      if (state.complete) { stop(); setTimeout(function () { go('/app/workbench.html'); }, 1500); return; }

      // Self-heal a stale/dead crawlId: if we stay "pending" with no progress for
      // ~15s, this tab is pointed at a crawl that isn't reporting. Check whether
      // the site already finished a crawl and, if so, move on instead of
      // pretending to wait forever.
      if (waiting) {
        pendingPolls += 1;
        if (pendingPolls === 8) {
          api.workbenchSites().then(function (rs) {
            var site = (rs.sites || []).find(function (s) { return s.id === siteId; });
            if (site && site.crawlPages > 0) {
              if (statusEl) statusEl.textContent = 'Crawl finished earlier.';
              if (progressEl) progressEl.textContent = site.crawlPages + ' pages indexed';
              stop();
              setTimeout(function () { go('/app/workbench.html'); }, 1500);
            }
          }).catch(function () { /* keep waiting */ });
        }
      } else {
        pendingPolls = 0;
      }
    }

    // ALWAYS poll — it is the source of truth and never silently dies. SSE (when
    // it works) is a live bonus on top. EventSource never throws synchronously
    // and auto-reconnects forever, so it can NEVER be the only signal: a frozen
    // page with no progress is the worst possible UX. (Learning 2026-06-06.)
    var stopped = false;
    var es = null;
    function poll() {
      api.crawlState(siteId, crawlId).then(render).catch(function () { /* keep polling */ });
    }
    function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(iv);
      if (es) { try { es.close(); } catch (e) {} }
    }
    poll(); // immediate first paint — no 2s "Starting…" dead air
    var iv = setInterval(poll, 2000);
    try {
      es = api.crawlSSE(siteId, crawlId, render, function () { /* onerror: polling already covers us */ });
    } catch (e) { /* SSE unsupported — polling carries it */ }
    window.addEventListener('beforeunload', stop);
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

      // Hero CTA: total open orphans across sites = quick wins waiting. Deep-link
      // straight into the guided spine for the site with the most to do.
      var totalOrphans = sites.reduce(function (n, s) { return n + (s.open_orphans || 0); }, 0);
      var hero = $('[data-testid="qw-hero"]');
      if (hero && totalOrphans > 0) {
        setText('[data-testid="qw-hero-count"]', totalOrphans);
        var busiest = sites.slice().sort(function (a, b) { return (b.open_orphans || 0) - (a.open_orphans || 0); })[0];
        var cta = $('[data-testid="qw-hero-cta"]');
        if (cta && busiest) cta.href = '/app/quick-wins.html?siteId=' + encodeURIComponent(busiest.id);
        hero.hidden = false;
      }

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
        // Per-site "update credentials" link (can't nest inside the row anchor).
        // Discoverable entry point to fix a stale/wrong app password without a
        // delete + re-crawl. (2026-06-06.)
        var creds = document.createElement('div');
        creds.style = 'margin: -4px 0 12px; padding-left: 2px; font-size: 12px;';
        creds.innerHTML = '<a class="muted" href="/app/sites-new.html?siteId=' + encodeURIComponent(s.id) + '">⚙ Update credentials</a>';
        list.appendChild(creds);
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
        var status = p.status === 'verified' ? 'Pushed' : p.status === 'failed' ? 'Failed' : p.status === 'pushed' ? 'Verifying' : 'Pending';
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

      // PREWARM: warm the server-side candidate cache for the orphans the user
      // is most likely to click, so "Fix this" reads from cache and renders
      // instantly instead of computing on click. Bounded to the top few to cap
      // Workers-AI cost; cache makes each a one-time spend. (2026-06-06.)
      rows.slice(0, 5).forEach(function (o) {
        api.listCandidates(siteId, o.id).catch(function () { /* best-effort warm */ });
      });
    }).catch(showError);

    // Re-read button — kick off a fresh crawl, then go to the progress page.
    // Lives here (not in an inline <script>) because the page CSP is
    // script-src 'self', which blocks inline handlers outright. (Hardened 2026-06-06.)
    var recrawlBtn = document.getElementById('recrawl-btn');
    if (recrawlBtn) {
      recrawlBtn.addEventListener('click', function () {
        if (!siteId) return;
        recrawlBtn.disabled = true;
        api.recrawl(siteId).then(function (r) {
          go('/app/crawl.html?siteId=' + encodeURIComponent(siteId) + '&crawlId=' + encodeURIComponent(r.crawlId));
        }).catch(function (err) { recrawlBtn.disabled = false; showError(err); });
      });
    }

    // GSC banner dismiss.
    var dismissBanner = document.getElementById('dismiss-banner');
    if (dismissBanner) {
      dismissBanner.addEventListener('click', function (e) {
        e.preventDefault();
        var banner = document.getElementById('gsc-banner');
        if (banner) banner.remove();
      });
    }
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

    // Render the orphan target IMMEDIATELY from the (fast, no-LLM) orphans list
    // instead of waiting on the candidate computation. The orphan title/slug is
    // known the moment the user clicks "Fix this" — there is no reason to show a
    // blank "…" header while candidates compute. (2026-06-06 UX fix.)
    function fillHead(title, slug) {
      var headText = decodeEntities(title || slug || '');
      setText('[data-testid="orphan-head"]', headText);
      var legacy = document.getElementById('orphan-h');
      if (legacy) legacy.textContent = headText;
      if (slug) setText('[data-testid="orphan-slug"]', slug + ' · 0 inbound internal links');
    }
    api.listOrphans(siteId, 200).then(function (lr) {
      var o = ((lr && lr.orphans) || []).find(function (x) { return x.id === orphanId; });
      if (o) fillHead(o.title, o.slug);
    }).catch(function () { /* candidates response will fill it as a fallback */ });

    api.listCandidates(siteId, orphanId).then(function (r) {
      if (r.orphan) {
        fillHead(r.orphan.title, r.orphan.slug);
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

    // Back-link carries the siteId so "← Orphans" returns to the right list.
    // (Moved out of an inline <script> — blocked by CSP script-src 'self' — and
    // off the non-existent window.api global it used. Hardened 2026-06-06.)
    var backLink = document.getElementById('back-link');
    if (backLink && siteId) {
      backLink.href = '/app/orphans.html?siteId=' + encodeURIComponent(siteId);
    }

    // "Move to next orphan" — advance within the insertion view instead of
    // bouncing to the list. Falls back to the list on the last orphan or error.
    var nextLink = document.getElementById('next-orphan');
    if (nextLink) {
      nextLink.addEventListener('click', function (e) {
        e.preventDefault();
        function backToList() {
          go('/app/orphans.html' + (siteId ? '?siteId=' + encodeURIComponent(siteId) : ''));
        }
        if (!siteId || !orphanId) return backToList();
        api.listOrphans(siteId, 200).then(function (r) {
          var rows = (r && r.orphans) || [];
          var i = rows.findIndex(function (o) { return o.id === orphanId; });
          if (i === -1) return backToList();
          var next = rows[i + 1];
          if (!next) return backToList(); // already on the last orphan
          go('/app/insertion.html?siteId=' + encodeURIComponent(siteId) + '&orphanId=' + encodeURIComponent(next.id));
        }).catch(backToList);
      });
    }
  }

  // ─── audit ────────────────────────────────────────────────────────────
  // Renders into either a <ul data-testid="audit-list"> (legacy) or the
  // table <tbody data-testid="audit-list"> on /app/audit.html. We detect
  // tag and emit <tr> vs <li> accordingly.
  function pageAudit() {
    var auditTimer = null;

    // Build a clickable live URL from a site root + a slug so the user can open
    // the actual page and SEE the change, instead of staring at plain text.
    function liveUrl(siteUrl, slug) {
      try { return new URL(slug, siteUrl).toString(); } catch (e) { return null; }
    }
    function slugLink(siteUrl, slug) {
      var href = liveUrl(siteUrl, slug);
      var text = escape(slug || '');
      if (!href) return text;
      return '<a href="' + escape(href) + '" target="_blank" rel="noopener" title="Open the live page in a new tab">' + text + '</a>';
    }

    function render(pushes, isTable, list) {
      list.innerHTML = '';
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
          : (p.status === 'failed' ? 'push failed' + (p.failure_code ? ' (' + escape(p.failure_code) + ')' : '')
            : (p.status === 'pushed' ? 'pushed · verifying' : 'pending'));
        var when = p.pushed_at ? new Date(p.pushed_at).toISOString().replace('T', ' ').slice(0, 16) : '';
        var site = '';
        try { site = new URL(p.site_url).hostname; } catch (e) { site = p.site_url || ''; }
        var failureNote = '';
        if (p.failure_code && window.rectoErrors && window.rectoErrors.describe) {
          var msg = window.rectoErrors.describe(p.failure_code);
          failureNote = '<div class="muted" style="font-size:11px; margin-top:2px;">' + escape(msg.what || '') + '</div>';
        }
        // On a verified row, offer a direct "View link" to the source page where
        // the link now lives — proof the change happened. Failed rows get Retry,
        // plus a "Fix credentials" shortcut when the failure is an auth problem
        // (the fix is to re-enter a valid app password, not to retry the same
        // bad creds). 2026-06-06.
        var isAuthFail = p.failure_code === 'wp_auth_failed' || p.failure_code === 'wp_no_edit_access';
        var fixCreds = (p.status === 'failed' && isAuthFail && p.site_id)
          ? '<a class="btn btn--sm btn--primary" href="/app/sites-new.html?siteId=' + encodeURIComponent(p.site_id) + '">Fix credentials →</a> '
          : '';
        var rowAction = p.status === 'failed'
          ? fixCreds + '<button type="button" class="btn btn--sm" data-action="retry" data-id="' + escape(p.id) + '">Retry</button>'
          : (liveUrl(p.site_url, p.source_slug)
              ? '<a class="btn btn--sm" href="' + escape(liveUrl(p.site_url, p.source_slug)) + '" target="_blank" rel="noopener">View link ↗</a>'
              : '');

        if (isTable) {
          var tr = document.createElement('tr');
          tr.setAttribute('data-testid', 'audit-row-' + (list.children.length + 1));
          tr.innerHTML =
            '<td class="mono muted">' + escape(when) + '</td>' +
            '<td class="mono">' + escape(site) + '</td>' +
            '<td class="mono" style="font-size:12px;">' + slugLink(p.site_url, p.source_slug) + '<br>→ ' + slugLink(p.site_url, p.orphan_slug) + '</td>' +
            '<td>' + escape(p.anchor_text) + failureNote + '</td>' +
            '<td><span class="badge badge--' + statusClass + '"><span class="badge__glyph" aria-hidden="true">' + badgeGlyph + '</span>' + statusLabel + '</span></td>' +
            '<td>' + rowAction + '</td>';
          list.appendChild(tr);
        } else {
          var li = document.createElement('li');
          li.className = 'audit-row audit-row--' + (p.status === 'verified' ? 'ok' : p.status === 'failed' ? 'err' : 'pending');
          li.innerHTML =
            '<div class="audit-row__where">' + slugLink(p.site_url, p.source_slug) + ' → ' + slugLink(p.site_url, p.orphan_slug) + '</div>' +
            '<div class="audit-row__anchor"><em>' + escape(p.anchor_text) + '</em></div>' +
            '<div class="audit-row__status">' + escape(p.status) + (p.verified_via ? ' · ' + escape(p.verified_via) : '') + '</div>' +
            failureNote + rowAction;
          list.appendChild(li);
        }
      });
    }

    function load() {
      var list = $('[data-testid="audit-list"]');
      if (!list) return;
      var isTable = list.tagName === 'TBODY';
      api.listPushes({ limit: 100 }).then(function (r) {
        var pushes = r.pushes || [];
        render(pushes, isTable, list);
        // AUTO-REFRESH: pushes flip pending → verified/failed in the background
        // (q-verify checks the live page within ~60s). Poll until every row is
        // terminal so the user never has to manually reload to see the result.
        // (Platform-wide live-update gap flagged 2026-06-06.)
        var anyPending = pushes.some(function (p) { return p.status !== 'verified' && p.status !== 'failed'; });
        if (anyPending && !auditTimer) {
          auditTimer = setInterval(load, 4000);
        } else if (!anyPending && auditTimer) {
          clearInterval(auditTimer); auditTimer = null;
        }
      }).catch(showError);
    }

    load();
    window.addEventListener('beforeunload', function () { if (auditTimer) clearInterval(auditTimer); });

    document.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action="retry"]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      btn.disabled = true;
      api.retryPush(id).then(function () { toast('Queued for retry.'); setTimeout(load, 800); }).catch(function (e) { btn.disabled = false; showError(e); });
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
        setText('[data-testid="account-email"]', me.email);
        setText('[data-testid="account-sites"]', (me.sitesConnected || 0) + ' site' + (me.sitesConnected === 1 ? '' : 's') + ' connected');
        setText('[data-testid="openai-state"]', me.byok.openai ? '· key on file' : '');
        setText('[data-testid="anthropic-state"]', me.byok.anthropic ? '· key on file' : '');
        var digestCheckbox = $('[data-testid="digest-opt-in"]');
        if (digestCheckbox) digestCheckbox.checked = !!me.digestOptIn;
      }).catch(showError);
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

  // ─── quick wins (the guided spine) ─────────────────────────────────────
  // One orphan at a time. We show the user's OWN paragraph with the existing
  // phrase we'd wrap highlighted in place — the value prop made visible: we
  // link your words, we never write new ones. One primary action: Link it.
  function pageQuickWins() {
    var els = {
      loading: $('[data-testid="qw-loading"]'),
      card: $('[data-testid="qw-card"]'),
      done: $('[data-testid="qw-done"]'),
      nosite: $('[data-testid="qw-nosite"]'),
      count: $('[data-testid="qw-count"]'),
      dots: $('[data-testid="qw-dots"]'),
      orphanTitle: $('[data-testid="qw-orphan-title"]'),
      orphanView: $('[data-testid="qw-orphan-view"]'),
      sourceTitle: $('[data-testid="qw-source-title"]'),
      para: $('[data-testid="qw-paragraph"]'),
      error: $('[data-testid="qw-error"]'),
      linkBtn: $('[data-testid="qw-link"]'),
      pickwrap: $('[data-testid="qw-pickwrap"]'),
      pickbody: $('[data-testid="qw-pickbody"]'),
      pickerr: $('[data-testid="qw-pickerr"]'),
    };
    if (!els.card) return;

    var state = { siteId: null, siteUrl: '', orphans: [], idx: 0, cands: [], candIdx: 0 };

    function show(which) {
      [els.loading, els.card, els.done, els.nosite].forEach(function (e) { if (e) e.hidden = true; });
      if (which) which.hidden = false;
    }
    function liveUrlOf(slug) { try { return new URL(slug, state.siteUrl).toString(); } catch (e) { return null; } }
    function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    // Whitespace-flexible highlight of the matched phrase inside the paragraph.
    // We escape first (XSS-safe), then build a tolerant regex from the escaped
    // tokens so a newline/double-space in the source still matches.
    function highlight(paragraph, phrase) {
      var safe = escape(paragraph || '');
      if (!phrase) return safe;
      var tokens = String(phrase).trim().split(/\s+/).map(function (t) { return escapeRegex(escape(t)); });
      if (!tokens.length || !tokens[0]) return safe;
      try {
        var re = new RegExp(tokens.join('\\s+'), 'i');
        return safe.replace(re, function (m) { return '<mark>' + m + '</mark>'; });
      } catch (e) { return safe; }
    }
    // Extract the sentence around a phrase from a longer body (hand-pick render).
    function snippetAround(fullText, phrase) {
      if (!fullText) return phrase || '';
      var lo = fullText.toLowerCase().indexOf(String(phrase || '').toLowerCase());
      if (lo === -1) return phrase || fullText.slice(0, 240);
      var start = fullText.lastIndexOf('.', lo); start = start === -1 ? 0 : start + 1;
      var end = fullText.indexOf('.', lo + phrase.length); end = end === -1 ? fullText.length : end + 1;
      return fullText.slice(start, end).trim();
    }

    function setBusy(b) { var a = els.card.querySelector('.qw__actions'); if (a) a.setAttribute('data-busy', b ? '1' : '0'); }
    function clearError() { if (els.error) { els.error.hidden = true; els.error.textContent = ''; } }
    function showCardError(t) { if (els.error) { els.error.textContent = t; els.error.hidden = false; } }

    function renderDots() {
      var total = state.orphans.length, idx = state.idx;
      var win = Math.min(total, 7);
      var start = Math.max(0, Math.min(idx - 3, total - win));
      var html = '';
      for (var j = start; j < start + win; j++) {
        var cls = j < idx ? 'qw__dot--done' : (j === idx ? 'qw__dot--now' : '');
        html += '<span class="qw__dot ' + cls + '"></span>';
      }
      els.dots.innerHTML = html;
    }

    function renderCard() {
      var orphan = state.orphans[state.idx];
      var active = state.cands[state.candIdx];
      show(els.card);
      clearError();
      els.linkBtn.innerHTML = 'Link it<span class="qw__kbd">↵</span>';
      els.linkBtn.style.color = '';
      els.count.textContent = (state.idx + 1) + ' of ' + state.orphans.length;
      renderDots();

      var title = decodeEntities(orphan.title || orphan.slug);
      title = title.replace(/\s+[–—-]\s+[^–—]+$/, '').trim() || title;
      els.orphanTitle.textContent = title;
      var href = liveUrlOf(orphan.slug);
      if (href) els.orphanView.href = href; else els.orphanView.removeAttribute('href');
      els.sourceTitle.textContent = decodeEntities(active.sourceTitle || active.sourceSlug || 'a related post');

      if (active.needsHandpick || !active.anchorText) {
        els.para.innerHTML = '<span class="muted">We couldn\'t find an obvious phrase to wrap automatically — pick the words to link from below.</span>';
        els.linkBtn.disabled = true;
        openPick();
      } else {
        els.linkBtn.disabled = false;
        hidePick();
        els.para.innerHTML = highlight(active.paragraphExcerpt, active.anchorText);
      }
    }

    function advance() { state.idx += 1; state.candIdx = 0; loadCurrent(); }

    function loadCurrent() {
      hidePick();
      clearError();
      if (state.idx >= state.orphans.length) { show(els.done); return; }
      var orphan = state.orphans[state.idx];
      show(els.loading);
      api.listCandidates(state.siteId, orphan.id).then(function (r) {
        var cands = r.candidates || [];
        if (!cands.length) { advance(); return; } // nothing to link from → next
        // Prefer candidates that already have a ready phrase; handpick ones last.
        cands.sort(function (a, b) { return (a.needsHandpick === b.needsHandpick) ? 0 : (a.needsHandpick ? 1 : -1); });
        state.cands = cands;
        state.candIdx = 0;
        renderCard();
      }).catch(function (e) {
        if (e && e.status === 401) return showError(e);
        // A single orphan failing shouldn't dead-end the stream.
        advance();
      });
    }

    function doLink() {
      var active = state.cands[state.candIdx];
      clearError();
      setBusy(true);
      api.push(active.id).then(function () {
        els.linkBtn.innerHTML = 'Linked ✓';
        els.linkBtn.style.color = 'var(--forest)';
        setTimeout(function () { setBusy(false); advance(); }, 700);
      }).catch(function (e) {
        setBusy(false);
        var code = (e && e.body && e.body.error) || (e && e.message) || 'unknown';
        if (code === 'wp_anchor_not_found') {
          showCardError('That phrase wasn\'t found in the live post. Pick other words to link.');
          openPick();
        } else {
          var msg = window.rectoErrors.describe(code);
          showCardError(msg.what + ' ' + msg.fix);
        }
      });
    }

    function differentPage() {
      clearError();
      if (state.candIdx + 1 < state.cands.length) {
        state.candIdx += 1;
        renderCard();
        return;
      }
      // No other source page — re-roll a phrase on the current candidate.
      var active = state.cands[state.candIdx];
      setBusy(true);
      api.regenerateAnchor(active.id).then(function (r) {
        active.anchorText = r.anchorText;
        if (r.paragraphExcerpt) active.paragraphExcerpt = r.paragraphExcerpt;
        active.needsHandpick = !!r.needsHandpick;
        setBusy(false);
        renderCard();
      }).catch(function (e) { setBusy(false); showError(e); });
    }

    function openPick() {
      if (els.error) els.error.hidden = true;
      els.pickwrap.hidden = false;
      els.pickerr.textContent = '';
      var active = state.cands[state.candIdx];
      els.pickbody.textContent = 'Loading the post…';
      api.getSource(active.id).then(function (r) {
        els.pickbody.textContent = (r.sentences || []).join(' ') || 'No readable text in this post.';
      }).catch(function () { els.pickbody.textContent = 'Could not load the source post.'; });
    }
    function hidePick() { if (els.pickwrap) els.pickwrap.hidden = true; }

    function useSelection() {
      var active = state.cands[state.candIdx];
      var sel = window.getSelection ? String(window.getSelection()) : '';
      sel = sel.replace(/\s+/g, ' ').trim();
      if (!sel) { els.pickerr.textContent = 'Highlight the words you want to link first.'; return; }
      if (sel.split(' ').length > 12) { els.pickerr.textContent = 'Pick a shorter phrase — a few words works best.'; return; }
      els.pickerr.textContent = '';
      api.setAnchor(active.id, sel).then(function (r) {
        active.anchorText = r.anchorText;
        active.needsHandpick = false;
        hidePick();
        els.linkBtn.disabled = false;
        var base = active.paragraphExcerpt && active.paragraphExcerpt.toLowerCase().indexOf(r.anchorText.toLowerCase()) !== -1
          ? active.paragraphExcerpt
          : snippetAround(els.pickbody.textContent || '', r.anchorText);
        els.para.innerHTML = highlight(base, r.anchorText);
      }).catch(function (e) {
        var code = (e && e.body && e.body.error) || (e && e.message);
        if (code === 'anchor_not_in_source') {
          els.pickerr.textContent = 'Those exact words aren\'t in the post — select text directly from the passage above.';
        } else {
          var m = window.rectoErrors.describe(code);
          els.pickerr.textContent = m.what + ' ' + m.fix;
        }
      });
    }

    function onAction(action) {
      if (action === 'link') return doLink();
      if (action === 'skip') return advance();
      if (action === 'different') return differentPage();
      if (action === 'pick') return openPick();
      if (action === 'pick-cancel') return hidePick();
      if (action === 'use-selection') return useSelection();
    }

    els.card.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (btn) onAction(btn.getAttribute('data-action'));
    });
    document.addEventListener('keydown', function (e) {
      if (els.card.hidden || !els.pickwrap.hidden) return; // not while picking text
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Enter') { e.preventDefault(); if (!els.linkBtn.disabled) onAction('link'); }
      else if (e.key === 's' || e.key === 'S' || e.key === 'ArrowRight') { onAction('skip'); }
    });

    // Resolve the site (explicit ?siteId, else the user's first site).
    var params = new URLSearchParams(window.location.search);
    state.siteId = params.get('siteId');
    function afterSite() {
      api.workbenchSites().then(function (rs) {
        var m = (rs.sites || []).find(function (s) { return s.id === state.siteId; });
        if (m) state.siteUrl = m.url;
      }).catch(function () { /* live-url links just won't resolve */ });
      api.listOrphans(state.siteId, 50).then(function (r) {
        state.orphans = r.orphans || [];
        if (!state.orphans.length) { show(els.done); return; }
        state.idx = 0;
        loadCurrent();
      }).catch(showError);
    }
    if (!state.siteId) {
      api.listSites().then(function (rs) {
        var first = (rs.sites || [])[0];
        if (first) { state.siteId = first.id; afterSite(); }
        else show(els.nosite);
      }).catch(showError);
    } else {
      afterSite();
    }
  }

  var routes = {
    auth: pageAuth,
    'sites-new': pageSitesNew,
    crawl: pageCrawl,
    workbench: pageWorkbench,
    'quick-wins': pageQuickWins,
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
