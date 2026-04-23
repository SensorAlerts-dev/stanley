import crypto from 'crypto';

// ── URL canonicalization ──────────────────────────────────────────────
// Produces a stable string for dedup. Lower-case scheme+host, strip trailing
// slash, remove known noise query parameters, trim whitespace.
//
// Noise params are separated into a global set (always stripped) and
// domain-scoped sets (stripped only on matching hostnames). This avoids
// clobbering params that are noise on one platform but canonical on
// another. e.g. `t=` is a tiktok share token but a youtube playback
// timestamp; `ref=` is tracking on most sites but canonical on github.

const GLOBAL_NOISE_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'igshid', 'gclid', 'ref_src', 'si',
]);

const DOMAIN_NOISE_PARAMS: Array<{ hostSuffix: string; params: string[] }> = [
  { hostSuffix: 'tiktok.com', params: ['t'] },
];

// 'ref' is tracking on most sites (e.g. newsletter click-throughs) but
// canonical on GitHub (?ref=branch). Default: strip. Exception: github.com.
const REF_STRIP_EXCEPTIONS = new Set(['github.com', 'www.github.com']);

export function canonicalizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    // Non-parseable input returned verbatim. Callers that persist this
    // through urlHash will store a stable hash, but downstream dedup
    // quality for malformed URLs is inherently limited.
    return trimmed;
  }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();

  const host = u.hostname;

  // Collect domain-scoped noise params that apply to this host
  const domainScoped = new Set<string>();
  for (const rule of DOMAIN_NOISE_PARAMS) {
    if (host === rule.hostSuffix || host.endsWith('.' + rule.hostSuffix)) {
      for (const p of rule.params) domainScoped.add(p);
    }
  }
  // Strip `ref` globally except for github.com
  const stripRef = !REF_STRIP_EXCEPTIONS.has(host);

  const cleanedParams = new URLSearchParams();
  for (const [k, v] of u.searchParams.entries()) {
    const key = k.toLowerCase();
    if (GLOBAL_NOISE_PARAMS.has(key)) continue;
    if (domainScoped.has(key)) continue;
    if (stripRef && key === 'ref') continue;
    cleanedParams.append(k, v);
  }
  u.search = cleanedParams.toString();

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}

export function urlHash(canonical: string): string {
  return crypto.createHash('sha1').update(canonical).digest('hex');
}
