// recto API client. Vanilla fetch wrapper. No framework.
//
// Base URL resolution:
//   - localhost / 127.0.0.1 → http://localhost:8787
//   - *.pages.dev preview → the workers.dev sibling URL
//   - rectoapp.com (or www.) production → https://api.rectoapp.com
//
// Cookies are credentials:'include' so the signed session cookie on
// .rectoapp.com works cross-subdomain. Local dev uses same-origin cookie.

(function () {
  var loc = window.location;
  var isLocal = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
  var BASE;
  if (isLocal) {
    BASE = 'http://localhost:8787';
  } else if (/\.pages\.dev$/.test(loc.hostname)) {
    BASE = 'https://recto-api.syedmosayebalam.workers.dev';
  } else {
    // Strip leading www. so api.www.rectoapp.com never happens.
    var apex = loc.hostname.replace(/^www\./, '');
    BASE = loc.protocol + '//api.' + apex;
  }

  // Allow override via <meta name="recto-api" content="https://api.staging.recto.so">
  var meta = document.querySelector('meta[name="recto-api"]');
  if (meta && meta.content) BASE = meta.content;

  function url(path) {
    return BASE + (path.indexOf('/') === 0 ? path : '/' + path);
  }

  function request(method, path, body) {
    var opts = {
      method: method,
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url(path), opts).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var pBody = ct.indexOf('application/json') === 0
        ? res.json().catch(function () { return {}; })
        : res.text();
      return pBody.then(function (data) {
        if (!res.ok) {
          var err = new Error(typeof data === 'object' && data && data.error ? data.error : 'http_' + res.status);
          err.status = res.status;
          err.body = data;
          throw err;
        }
        return data;
      });
    });
  }

  // High-level surface.
  window.rectoApi = {
    base: BASE,

    // Auth
    requestMagicLink: function (email) { return request('POST', '/api/auth/magic', { email: email }); },
    me: function () { return request('GET', '/api/auth/me'); },
    logout: function () { return request('POST', '/api/auth/logout'); },

    // Sites
    listSites: function () { return request('GET', '/api/sites'); },
    connectSite: function (payload) { return request('POST', '/api/sites', payload); },
    deleteSite: function (id) { return request('DELETE', '/api/sites/' + encodeURIComponent(id)); },
    updateCreds: function (id, payload) { return request('PUT', '/api/sites/' + encodeURIComponent(id) + '/credentials', payload); },
    recrawl: function (id) { return request('POST', '/api/sites/' + encodeURIComponent(id) + '/recrawl'); },
    crawlState: function (siteId, crawlId) {
      return request('GET', '/api/sites/' + encodeURIComponent(siteId) + '/crawl/' + encodeURIComponent(crawlId) + '/state');
    },
    crawlSSE: function (siteId, crawlId, onEvent, onError) {
      var es = new EventSource(
        url('/api/sites/' + encodeURIComponent(siteId) + '/crawl/' + encodeURIComponent(crawlId) + '/events'),
        { withCredentials: true }
      );
      function handle(ev) {
        try { onEvent(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
      }
      // The DO emits NAMED events (progress, complete) — onmessage only catches
      // unnamed ones, so listen for both names too or the UI never updates.
      es.onmessage = handle;
      es.addEventListener('progress', handle);
      es.addEventListener('complete', handle);
      // EventSource NEVER throws synchronously and auto-reconnects forever on a
      // dead endpoint — without onerror a broken stream looks like a frozen page.
      es.onerror = function () { if (onError) onError(); };
      return es;
    },

    // Workbench
    workbenchSince: function () { return request('GET', '/api/workbench/since'); },
    workbenchSites: function () { return request('GET', '/api/workbench/sites'); },
    publishingGap: function (siteId) { return request('GET', '/api/workbench/publishing-gap?siteId=' + encodeURIComponent(siteId)); },

    // Orphans + candidates
    listOrphans: function (siteId, limit) {
      var q = limit ? '?limit=' + limit : '';
      return request('GET', '/api/sites/' + encodeURIComponent(siteId) + '/orphans' + q);
    },
    listCandidates: function (siteId, orphanId) {
      return request('GET', '/api/sites/' + encodeURIComponent(siteId) + '/orphans/' + encodeURIComponent(orphanId) + '/candidates');
    },
    regenerateAnchor: function (candidateId) {
      return request('POST', '/api/candidates/' + encodeURIComponent(candidateId) + '/regenerate-anchor');
    },
    setAnchor: function (candidateId, anchorText) {
      return request('PUT', '/api/candidates/' + encodeURIComponent(candidateId) + '/anchor', { anchorText: anchorText });
    },
    // Source prose for hand-pick: the post's sentences so the user can select
    // their own existing phrase to wrap. PUT /anchor validates the substring.
    getSource: function (candidateId) {
      return request('GET', '/api/candidates/' + encodeURIComponent(candidateId) + '/source');
    },

    // Pushes (audit log)
    push: function (candidateId) { return request('POST', '/api/pushes', { candidateId: candidateId }); },
    listPushes: function (filter) {
      var q = '';
      if (filter) {
        var parts = [];
        if (filter.status) parts.push('status=' + encodeURIComponent(filter.status));
        if (filter.limit) parts.push('limit=' + filter.limit);
        if (parts.length) q = '?' + parts.join('&');
      }
      return request('GET', '/api/pushes' + q);
    },
    retryPush: function (id) { return request('POST', '/api/pushes/' + encodeURIComponent(id) + '/retry'); },

    // GSC
    gscConnect: function (siteId) { return request('GET', '/api/gsc/connect?siteId=' + encodeURIComponent(siteId)); },
    gscSelect: function (siteId, property) { return request('POST', '/api/gsc/select', { siteId: siteId, property: property }); },
    gscDisconnect: function (siteId) { return request('DELETE', '/api/gsc/disconnect?siteId=' + encodeURIComponent(siteId)); },

    // Errors lookup
    errorMessages: function () { return request('GET', '/api/errors/messages'); },

    // Profile + BYOK
    getMe: function () { return request('GET', '/api/users/me'); },
    updateMe: function (body) { return request('PUT', '/api/users/me', body); },
    deleteByok: function (vendor) { return request('DELETE', '/api/users/me/byok/' + encodeURIComponent(vendor)); },

    // First-run onboarding: captures name + optional pending website URL.
    onboard: function (body) { return request('POST', '/api/users/onboard', body); },
  };

  // Cached error-message map. UI calls window.rectoErrors.describe(code).
  var _msgs = null;
  window.rectoErrors = {
    load: function () {
      if (_msgs) return Promise.resolve(_msgs);
      return window.rectoApi.errorMessages().then(function (r) { _msgs = r.messages || {}; return _msgs; });
    },
    describe: function (code) {
      if (_msgs && _msgs[code]) return _msgs[code];
      return { what: 'Something failed.', fix: 'Retry, then send the error code if it persists.', retryable: true };
    },
  };
})();
