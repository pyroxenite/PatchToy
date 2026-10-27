/**
 * Standard API response helpers. Every response (errors included) carries the
 * CORS headers: the API is called cross-origin from the site and from localhost.
 * No Allow-Credentials: auth is a bearer header, never a cookie. `handle()`
 * (shared/http.ts) narrows Allow-Origin when ALLOWED_ORIGINS is configured.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
};

export interface Result {
  statusCode: number;
  headers: Record<string, string | boolean>;
  body: string;
}

export function success(data: any, statusCode = 200, extraHeaders: Record<string, string> = {}): Result {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
    body: JSON.stringify(data),
  };
}

export function error(message: string, statusCode = 400, extra: Record<string, any> = {}): Result {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
    body: JSON.stringify({ error: message, ...extra }),
  };
}
