// User-facing error messages.
//
// Two columns per failure code:
//   - what failed (one sentence, ≤14 words, on-voice BRAND-VOICE §7.3)
//   - what you can do (one sentence, action verb first)
//
// The API returns the code; the UI looks up the strings here. Keep the
// table in sync with @recto/shared FailureCode enum + integrations/wordpress
// PushErrorCode.

export type ErrorMessage = {
  what: string;
  fix: string;
  retryable: boolean;
};

export const ERROR_MESSAGES: Record<string, ErrorMessage> = {
  // WordPress push errors
  wp_auth_failed: {
    what: 'WordPress rejected the credentials on file.',
    fix: 'Re-enter the application password in the site settings.',
    retryable: false,
  },
  wp_no_edit_access: {
    what: 'Those credentials authenticate but cannot edit posts.',
    fix: 'Use an account with Editor or Administrator role, then connect again.',
    retryable: false,
  },
  wp_post_not_found: {
    what: 'WordPress could not find the post at that slug.',
    fix: 'Re-crawl the site to refresh the slug-to-post mapping.',
    retryable: true,
  },
  wp_rest_disabled: {
    what: 'WordPress REST API is disabled on this site.',
    fix: 'Ask the host to re-enable /wp-json, or switch to the JWT plugin.',
    retryable: false,
  },
  wp_security_blocked: {
    what: 'Wordfence or a similar plugin blocked the request.',
    fix: 'Allow-list rectoapp.com in the firewall, or add the JWT plugin and re-connect.',
    retryable: false,
  },
  wp_already_linked: {
    what: 'A link to this orphan already exists in the source paragraph.',
    fix: 'Pick a different source page or candidate.',
    retryable: false,
  },
  wp_anchor_not_found: {
    what: 'The anchor phrase is no longer in the post, word for word.',
    fix: 'Pick a phrase that exists in the post — re-crawl if it was edited recently.',
    retryable: false,
  },
  wp_post_failed: {
    what: 'WordPress accepted the request but the update did not stick.',
    fix: 'Retry. If it fails a second time, check the post for a content lock.',
    retryable: true,
  },
  wp_network: {
    what: 'Network call to WordPress did not complete.',
    fix: 'Retry in a minute.',
    retryable: true,
  },
  wp_invalid_response: {
    what: 'WordPress returned a response we could not read as JSON.',
    fix: 'A caching or security plugin may be interfering — retry, then check /wp-json returns JSON.',
    retryable: true,
  },
  wp_unknown: {
    what: 'WordPress returned an unexpected response.',
    fix: 'Retry. If it persists, send the push id and we will investigate.',
    retryable: true,
  },

  // GSC errors
  gsc_reauth_required: {
    what: 'Google revoked the Search Console connection.',
    fix: 'Reconnect Google Search Console in site settings.',
    retryable: false,
  },
  gsc_quota_exceeded: {
    what: 'Daily Search Console quota reached.',
    fix: 'Wait until tomorrow. The pull resumes automatically.',
    retryable: true,
  },

  // Crawl errors
  crawl_no_sitemap: {
    what: 'No sitemap was reachable and the homepage produced no internal links.',
    fix: 'Add a /sitemap.xml or check that the homepage links to your content.',
    retryable: true,
  },
  crawl_blocked: {
    what: 'The site blocked the crawl with a 403 or 429.',
    fix: 'Allow-list recto-crawler/1.0 in the host firewall.',
    retryable: false,
  },

  // Auth errors
  magic_link_expired: {
    what: 'This sign-in link has already been used or expired.',
    fix: 'Request a new one from the sign-in page.',
    retryable: false,
  },
  invalid_or_expired_token: {
    what: 'This sign-in link has already been used or expired.',
    fix: 'Request a new one from the sign-in page.',
    retryable: false,
  },
  missing_token: {
    what: 'The sign-in link is missing its token.',
    fix: 'Request a new sign-in link from the email form.',
    retryable: false,
  },
  invalid_email: {
    what: 'That does not look like a valid email address.',
    fix: 'Check for typos and try again.',
    retryable: true,
  },
  rate_limited: {
    what: 'Too many sign-in requests from this network.',
    fix: 'Wait a few minutes, then request a new link.',
    retryable: true,
  },
  unauthenticated: {
    what: 'Your session expired or you are not signed in.',
    fix: 'Sign in again from the sign-in page.',
    retryable: false,
  },
  invalid_name: {
    what: 'The name field was empty or too long.',
    fix: 'Enter a name between 1 and 80 characters.',
    retryable: true,
  },
  invalid_website: {
    what: 'The website URL is not a valid http(s) address.',
    fix: 'Check the URL — it should look like https://your-site.com.',
    retryable: true,
  },
  not_found: {
    what: 'We could not find the resource you asked for.',
    fix: 'Refresh the page. If it persists, sign out and back in.',
    retryable: false,
  },
  user_gone: {
    what: 'Your account is no longer on file.',
    fix: 'Sign in again with your email to create a fresh session.',
    retryable: false,
  },

  // Site connect
  wp_credentials_required: {
    what: 'WordPress needs a username and an application password to connect.',
    fix: 'Add both, then connect again.',
    retryable: true,
  },
  webflow_key_required: {
    what: 'Webflow needs an API key to connect.',
    fix: 'Paste your Webflow API key, then connect again.',
    retryable: true,
  },
  already_connected: {
    what: 'This site is already connected to your account.',
    fix: 'Open it from your sites list instead of connecting again.',
    retryable: false,
  },

  anchor_required: {
    what: 'This candidate has no anchor phrase selected yet.',
    fix: 'Hand-pick a phrase from the source post, then push.',
    retryable: false,
  },

  // BYOK / AI provider
  byok_required: {
    what: 'No AI provider is available to generate this anchor.',
    fix: 'Enable Workers AI on your Cloudflare account, or add an OpenAI/Anthropic key in Settings.',
    retryable: false,
  },
};

export function describe(code: string): ErrorMessage {
  return (
    ERROR_MESSAGES[code] ?? {
      what: 'Something failed and we did not recognize it.',
      fix: 'Retry, then send the error code if it persists.',
      retryable: true,
    }
  );
}
