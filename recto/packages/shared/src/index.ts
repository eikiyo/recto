// Shared zod schemas, constants, types. Used by the API and by future packages.
// Anything that crosses a process boundary should be defined here.

import { z } from 'zod';

// ====== Constants from PRD/TRD ======

// Self-hosted: unlimited sites, no credits, no billing. Connect as many sites as
// your own Cloudflare account can handle and generate as many anchors as you like
// (you bring your own AI — Workers AI on your account, or your own OpenAI/
// Anthropic key via BYOK). There is no metering layer in the open-source edition.
export const CRAWL_MAX_PAGES = 10_000;
export const SIMILARITY_TOP_K = 3;
export const SIMILARITY_TOP_K_ALL = 20; // "View all 14 →"
export const GAP_MIN_ORPHANS = 5;
export const GAP_MAX_SIMILARITY = 60;

// ====== Shared zod schemas ======

export const SiteIdSchema = z.string().min(1);
export const UserIdSchema = z.string().min(1);

export const ConnectSiteBody = z.object({
  url: z.string().url(),
  cms: z.enum(['wordpress', 'webflow']),
  wp_username: z.string().min(1).optional(),
  wp_app_password: z.string().min(1).optional(),
  webflow_api_key: z.string().min(1).optional(),
});
export type ConnectSiteBody = z.infer<typeof ConnectSiteBody>;

export const PushStatus = z.enum(['pending', 'verified', 'failed', 'undone']);
export type PushStatus = z.infer<typeof PushStatus>;

export const LlmProvider = z.enum(['workers-ai', 'byok-openai', 'byok-anthropic']);
export type LlmProvider = z.infer<typeof LlmProvider>;

// ====== Failure codes (one per row in TRD §9.1 failure-mode table) ======

export const FailureCode = z.enum([
  'wp-app-pwd-disabled',
  'wp-app-pwd-stale',
  'wordfence-403',
  'ithemes-403',
  'wp-rate-limit',
  'wp-500-plugin',
  'wp-timeout',
  'content-drifted',
  'paragraph-drifted',
  'byok-required',
]);
export type FailureCode = z.infer<typeof FailureCode>;
