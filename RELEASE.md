# Releasing PatchToy 2.0

Checklist for shipping 2.0 (community features) to patchtoy.com. **Order matters:
backend stack first, then the site.** The new backend is backward compatible with the
1.x site, but the 2.0 site needs the new endpoints.

Nothing here has been run against AWS yet; every command below is for the person doing
the release.

## 0. Prerequisites

- AWS credentials for the account that hosts PatchToy (`AWS_PROFILE=...`), region of the
  existing stacks (the API is in `eu-west-3`; `CDK_DEFAULT_REGION` comes from the profile).
- CDK bootstrapped in that account / region (it is, from 1.x).
- `infra/.env` (see `infra/.env.example`):

  | Variable | Value |
  |---|---|
  | `hostedZoneId`, `zoneName`, `siteSubdomain` | unchanged from 1.x |
  | `DEPLOY_BACKEND` | `true` |
  | `JWT_SECRET` | **the same secret as the current deployment** (>= 32 characters). A different value signs everyone out. There is no default any more: synth fails without it (or without `JWT_SECRET_PARAM`). |
  | `JWT_SECRET_PARAM` | optional, recommended: name of an SSM SecureString holding that same secret (e.g. `/patchtoy/jwt-secret`). Then `JWT_SECRET` is unused and the secret is in neither the template nor the Lambda configuration. See "Security settings". |
  | `ENABLE_WAF` | optional, default off (costs money). `true` attaches an AWS WAF web ACL with per-IP rate rules. `WAF_AUTH_RATE_LIMIT` (default 100 / 5 min on `/api/auth/*`) and `WAF_GENERAL_RATE_LIMIT` (default 2000 / 5 min) tune it. |
  | `API_ALLOWED_ORIGINS` | optional, e.g. `https://patchtoy.com,https://www.patchtoy.com,http://localhost:5200` (default `*`). CORS never allows credentials. |
  | `FROM_EMAIL`, `FRONTEND_URL` | optional (defaults `noreply@patchtoy.com`, `https://patchtoy.com`). Sender and link target of the sign-up and password reset mails. The SES permission is scoped to this sender and its domain. **SES must be out of the sandbox** (see "Email-verification sign-up"). |
  | `SIGNUP_EMAIL_VERIFICATION` | optional, default on. `false` turns the email-verification sign-up off (immediate accounts, "Email already in use" again). Only for while SES can't mail everyone yet; see step 3. |
  | `ENABLE_SOCIAL_PREVIEWS` | optional, **default off**, site stack. `true` adds the Lambda@Edge function for link previews of `/p/<id>` and `/u/<name>` (us-east-1, see step 8). Needs `SOCIAL_PREVIEW_API_URL`. |
  | `SOCIAL_PREVIEW_API_URL` | with `ENABLE_SOCIAL_PREVIEWS`: the public API base URL (the backend `ApiUrl` output, e.g. `https://7c11mva4zg.execute-api.eu-west-3.amazonaws.com/prod`). |
  | `SOCIAL_PREVIEWS_UNLISTED` | optional, default `true`: link-only (unlisted) projects get previews too. `false` limits previews to public projects. Private projects never get one. |
  | `SOCIAL_PREVIEW_IMAGE_ORIGINS`, `SOCIAL_PREVIEW_DEFAULT_IMAGE` | optional: allowed `og:image` origins (default: `CSP_THUMBNAIL_ORIGINS` when set, else any https URL) and an https image for pages without a thumbnail. |
  | `CSP_API_ORIGINS`, `CSP_THUMBNAIL_ORIGINS`, `CSP_UPLOAD_ORIGINS` | optional, site stack: narrow the CSP to the real origins once the backend outputs are known (defaults are the wildcards `https://*.execute-api.eu-west-3.amazonaws.com`, `https://*.cloudfront.net`, `https://*.s3[.eu-west-3].amazonaws.com`). |
  | `ENABLE_USER_PUBLIC_INDEX` | **leave unset for this release** (later deployment, see step 6) |
  | `REQUIRE_API_KEY` | unchanged (normally unset / `false`) |
  | `THUMBNAIL_UPLOAD_ORIGINS` | optional, e.g. `https://patchtoy.com,https://www.patchtoy.com` (default `*`; uploads are authorised by the presigned policy either way) |
  | `ENABLE_POPULAR_INDEX` | **leave unset for this release** (see step 6) |

## 1. Local checks (no AWS)

```bash
npm install
node scripts/check-definitions.mjs
npm run build                                   # -> dist/
(cd infra/lambda && npm ci && npm test)         # handler unit tests, in-memory DynamoDB
(cd infra && npm ci && npx tsc --noEmit && npx ts-node test/synth-check.ts)
npm run test:community                          # headless Chrome end-to-end against the mock API
npm run test:mcp
```

Local development against local data: `npm run mock-api` (port 8787) and `npm run dev:mock`
(the dev server with `VITE_API_URL=http://localhost:8787`), or `?api=http://localhost:8787`.
Plain `npm run dev` still talks to the **production** API (unchanged behaviour); the console
says so at start-up. The mock sends no mail: sign-up links (and reset links) are printed in its
log and listed at `http://localhost:8787/__mock/outbox` (`?to=<email>`); they point at
`http://localhost:5200` (`FRONTEND_URL` changes that). The seeded accounts are already verified. Tokens are stored per API URL, so a mock never receives a production token.

## 2. Review the backend diff

```bash
cd infra
npm run build:lambda
npx cdk diff PatchToyBackendStack
```

Expect, and nothing destructive:
- `AWS::DynamoDB::Table` PatchToy-Projects: **one** new GSI `public-updatedAt-index`
  (no table replacement, the tables are `RETAIN`).
- New: `ThumbnailsBucket` (S3), `ThumbnailsDistribution` (CloudFront + Origin Access Control),
  5 Lambda functions (public feed, record view, thumbnail upload, get user, update me),
  API resources `/api/projects/public`, `/api/projects/{id}/view`, `/api/projects/{id}/thumbnail`,
  `/api/users/me`, `/api/users/{username}`, two Gateway Responses (CORS on 4xx/5xx).
- New: `PatchToy-Security` DynamoDB table (partition `pk`, TTL `ttl`: rate counters,
  single-use reset tokens, pending sign-ups, view / fork claims). Optional:
  `AWS::WAFv2::WebACL` + association when `ENABLE_WAF=true`.
- New: email-verification sign-up: `VerifyEmailFunction`, `ResendVerificationFunction`, API
  resources `/api/auth/verify-email` and `/api/auth/resend-verification` (POST). The register
  function gets `FROM_EMAIL`, `FRONTEND_URL`, `SIGNUP_VERIFICATION` and the SES permission
  (register, resend and reset are the only functions that may send mail).
- Changed: environment of all functions (index, thumbnail, security table, CORS settings);
  every function can read the users table (tokenVersion check); register / login / reset run
  with 1024 MB (bcrypt cost 12); the thumbnails CDN gets its own response headers policy
  (CORS GET, nosniff, HSTS); the SES permission is scoped to the sender identity; the
  visibility / update / delete / thumbnail functions may delete thumbnails and create
  CloudFront invalidations on the thumbnails distribution.

DynamoDB only allows **one GSI creation per table per update**; this deployment creates
exactly one. Don't combine it with `ENABLE_POPULAR_INDEX=true`.

## 3. Deploy the backend

```bash
cd infra
npx cdk deploy PatchToyBackendStack
```

**Sign-up between the backend and the site deploy.** The 2.0 backend answers sign-ups with
"check your email" and no session token; the 1.x site expects a token, so a sign-up on the
1.x site in that window looks broken (the emailed link still works once the 2.0 site is live:
links are valid 24 hours). Either deploy the site (step 5) right after, or, for no window
at all: deploy the backend with `SIGNUP_EMAIL_VERIFICATION=false`, deploy the site, then
deploy the backend again without it. The 2.0 site handles both modes.

The new GSI is backfilled by DynamoDB during the update (minutes for a small table; the
stack waits). Note the outputs: `ApiUrl` (should be unchanged:
`https://7c11mva4zg.execute-api.eu-west-3.amazonaws.com/prod/`, as in `src/core/config.js`),
`ThumbnailsUrl`, `ThumbnailsBucketName`.

If `ApiUrl` changed, update `src/core/config.js` before building the site.

## 4. Backfill existing data

**1.x "Share link" projects (`isPublic: true`) stay link-only (unlisted).** 1.x had no public
listing, so publishing them would expose projects that were shared privately by link. The
backfill never sets `visibility`; owners list a project with **Publish to Community**. It
adds search / card fields, username reservations and per-user project counts (`projectCount`,
for the 500-project quota). It doesn't write `tokenVersion` (missing = 0).

```bash
AWS_REGION=eu-west-3 node infra/scripts/backfill-community.mjs          # dry run: prints what would change
AWS_REGION=eu-west-3 node infra/scripts/backfill-community.mjs --apply  # writes
```

Idempotent. It lists any user without a username (they get one derived from their email
on next login, and are asked to keep or change it).

**Usernames are case-preserving, case-insensitive.** The stored `username` keeps the
spelling the user chose (`SirKitBoi`); lookups (`/u/sirkitboi`, sign-in) and uniqueness go
through the reservation item named after the lowercase key (`username#sirkitboi`). The
backfill writes those key items, deletes mixed-case items an earlier run wrote
(`username#SirKitBoi`) once the same user holds the key, reports names that collide only by
case between two users, and adds `usernameLower` to projects. Re-run it after deploying a
backend that has this change; accounts it hasn't reached are fixed on their next sign-in.

API smoke test:

```bash
API=https://7c11mva4zg.execute-api.eu-west-3.amazonaws.com/prod
curl -s "$API/api/projects/public?limit=3" | head -c 600; echo
curl -s -o /dev/null -w "%{http_code}\n" "$API/api/users/nobody-xyz"     # 404
curl -s -i -X OPTIONS "$API/api/projects/public" | grep -i access-control
```

## 5. Deploy the site

```bash
npm run build                      # from the repo root -> dist/
cd infra
npx cdk diff PatchToyStack         # expect: CSP change (img-src thumbnails, connect-src S3, media-src) + new assets
npx cdk deploy PatchToyStack       # uploads dist/ and invalidates CloudFront /*
```

The distribution already maps 403/404 to `/index.html` (200), which the `/p/<id>`,
`/u/<name>` and `/explore` routes need.

(`npm run deploy` in `infra/` builds and deploys **both** stacks with `--all`; avoid it for
this release so the order above is kept.)

## 6. Later, optional: the "popular" and "user pages" indexes

Without it, "Popular" ranks the 500 most recently updated public projects in the Lambda,
which is fine for now. When the catalogue grows, in a **separate** deployment:

```bash
ENABLE_POPULAR_INDEX=true npx cdk deploy PatchToyBackendStack    # or set it in infra/.env
```

This adds `public-views-index` and switches the functions to it.

In another separate deployment, `ENABLE_USER_PUBLIC_INDEX=true` adds `user-public-index`
(sparse, `publicOwner` + `updatedAt`, card attributes) and switches user pages to it. Run the
backfill again first if projects were published before 2.0's `publicOwner` existed (it adds
`publicOwner` to listed projects).

## 7. Smoke tests on patchtoy.com

Use two browsers (or a normal and a private window) as two users.

- [ ] Home loads; the top bar **Open** button (and ⌘O) shows the panel on My projects; its Demos tab opens a demo.
- [ ] Sign in (existing account) works; account menu has My page / My projects / Edit profile.
- [ ] Save a patch with ⌘S: URL becomes `/p/<id>`; My projects shows it with a thumbnail.
- [ ] My projects card menu: **Share by link only** → the badge says "Link only", Community and
      `/u/<you>` don't list it, the link opens it for others. **Publish to Community** → Community
      lists it; search by title and by `@author` finds it.
- [ ] A 1.x project that was shared by link shows as "Link only" (not in Community).
- [ ] Second browser, signed out: open the `/p/<id>` link. The project opens with the
      "Viewing … by @you · read-only" banner. A project with a JS node asks "This project
      contains JavaScript nodes. Run them?".
- [ ] Reload a deep link (`/p/<id>`, `/u/<name>`, `/explore/community`): no 403 / blank page.
- [ ] Second browser, signed in as another user: **Save a copy** saves a fork; its card shows
      "Forked from @you"; the original's fork count goes up.
- [ ] `/u/<you>` shows your public projects and display name, never your email.
- [ ] Make the project private: the link now shows "This project is private or doesn't
      exist" to the other user.
- [ ] Thumbnails load (no CSP errors in the console); views increase when someone else opens a project.
- [ ] Sign up with a new address: the dialog says "Check your email"; signing in before
      confirming fails with the usual message plus "Didn’t confirm your email?"; the email
      ("Confirm your email to finish signing up for PatchToy") arrives with a
      `https://patchtoy.com/#verify=…` link that opens the site signed in (the address bar
      shows no token). Opening the link again says "Sign-up link expired".
- [ ] Sign up with the address of an existing account: the same "Check your email" dialog;
      that mailbox gets "Someone tried to sign up for PatchToy with your email"; the existing
      password still works.
- [ ] An existing (1.x) account signs in as before (no verification needed).
- [ ] Password reset: the email arrives, the link is `https://patchtoy.com/#reset=…`, it works once
      (a second use is refused), and afterwards the other browser's session says "Session expired".
- [ ] Six wrong passwords in a row: the sixth answer is "Too many failed sign-in attempts".
- [ ] Opening a code editor loads Monaco (no CSP errors); a page load alone makes no cdnjs request.

## 8. Optional: social link previews (Lambda@Edge)

Share links `/p/<id>` and user pages `/u/<name>` unfurl in Slack, Discord, iMessage and X
with title, author, description and thumbnail. Off by default (`ENABLE_SOCIAL_PREVIEWS`),
because Lambda@Edge has deploy-time implications.

**How it works.** A Lambda@Edge **origin-request** function on two new cache behaviours
(`/p/*`, `/u/*`) of the site distribution (`infra/lambda/edge/social-preview.ts`). On a cache
miss it fetches `https://<site>/index.html` and, without credentials, the project
(`GET /api/projects/{id}`) or user (`GET /api/users/{name}`) from the public API (1.5 s budget,
per-container cache), and returns index.html with `og:title`, `og:description`, `og:image`
(the thumbnail on the thumbnails CDN), `og:url`, `twitter:card=summary_large_image` and a
matching `<title>`. All values are HTML-escaped. It serves every visitor (no user-agent
sniffing): the page is the normal SPA with better tags, and CloudFront caches it per path
for 5 minutes (path only: no query strings, headers or cookies in the key).
- **Private projects never get a preview**: the API answers 404 to an anonymous caller, and
  the function also refuses any card that isn't link-readable. They get the generic tags.
- **Unlisted (link-only) projects get a preview by default**: the owner shared the link, and
  the people they share it with expect a preview. Those pages carry `robots: noindex`.
  `SOCIAL_PREVIEWS_UNLISTED=false` turns them off.
- **Fallbacks**: API error, timeout, unknown project or user → generic PatchToy tags
  (cached 60 s). index.html unreachable → the request goes to S3 as today (403 → index.html).
- Changing a project to private: a preview already cached by CloudFront can stay up to
  5 minutes, and Slack / Discord / X keep their own copy of an unfurl for longer.

**Deploy.**

```bash
# Once: Lambda@Edge is created in us-east-1, which needs a CDK bootstrap there
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1

# infra/.env
ENABLE_SOCIAL_PREVIEWS=true
SOCIAL_PREVIEW_API_URL=https://7c11mva4zg.execute-api.eu-west-3.amazonaws.com/prod
# optional: SOCIAL_PREVIEWS_UNLISTED=false, SOCIAL_PREVIEW_IMAGE_ORIGINS=https://dXXXX.cloudfront.net,
#           SOCIAL_PREVIEW_DEFAULT_IMAGE=https://patchtoy.com/og.png

cd infra
npx cdk diff PatchToyStack      # expect: 2 cache behaviours (/p/*, /u/*) with an origin-request
                                # association, a cache policy, a cross-region SSM reader;
                                # plus a new stack edge-lambda-stack-… (us-east-1)
npx cdk deploy PatchToyStack    # deploys the us-east-1 edge stack first (a dependency)
```

The site stack needs a concrete region (`CDK_DEFAULT_REGION` from the profile, as today).
The settings are compiled into the function (Lambda@Edge has no environment variables);
changing one publishes a new function version. CloudFront then propagates it (a few minutes).

**Check:**

```bash
curl -s -A 'Slackbot-LinkExpanding 1.0' https://patchtoy.com/p/<public-id> | grep -E 'og:|twitter:'
curl -s https://patchtoy.com/p/<private-id> | grep og:title     # the generic "PatchToy — …" title
```

Then paste a link in Slack / Discord, or use the X card validator / Facebook sharing debugger.

**Cost / operations.** Invocations happen only on cache misses (per path, per edge location,
at most every 5 minutes): about $0.60 per million requests + duration, negligible here.
Logs go to CloudWatch in the region nearest the viewer (`/aws/lambda/us-east-1.<function>`).
**Turning it off** (`ENABLE_SOCIAL_PREVIEWS` unset, deploy): the behaviours go away at once,
but CloudFront deletes the function replicas only after some hours, so deleting the edge
stack (`cdk destroy` of `edge-lambda-stack-…`) can fail until then; retry later.

## Security settings (2.0 review)

**JWT secret (fail closed).** There is no default secret: synth throws without `JWT_SECRET`
(>= 32 characters) or `JWT_SECRET_PARAM`, and the functions refuse requests (500, logged)
when the secret is missing at runtime. Recommended, once:

```bash
# Same value as the current deployment, so nobody is signed out
aws ssm put-parameter --region eu-west-3 --name /patchtoy/jwt-secret --type SecureString --value "$JWT_SECRET"
# then in infra/.env:  JWT_SECRET_PARAM=/patchtoy/jwt-secret   (JWT_SECRET can then be removed)
```

The functions read it once per container (`ssm:GetParameter` on that parameter only, KMS
decrypt through SSM). SSM standard parameters are free. Without `JWT_SECRET_PARAM` the env
var keeps working (the secret is then visible in the Lambda configuration and `cdk.out`).

**tokenVersion migration: no forced sign-out.** Existing users have no `tokenVersion`
(read as 0). Session tokens issued by 1.x (no audience / type claims) stay valid until they
expire (30 days), as version 0. A password reset or a username change bumps the version and
ends every older token, 1.x ones included. To sign everyone out at release instead, set
`LEGACY_SESSION_TOKENS=reject` on the functions, or rotate the secret.

**AWS WAF (optional, off by default).** `ENABLE_WAF=true` adds a regional web ACL on the API
stage: per-IP rate rules on `/api/auth/*` (`WAF_AUTH_RATE_LIMIT`, default 100 requests per
5 minutes) and on everything (`WAF_GENERAL_RATE_LIMIT`, default 2000 per 5 minutes). Cost:
about $5/month for the web ACL + $1/month per rule + $0.60 per million requests. The code-level
limits below work without it.

**Abuse limits in code** (`infra/lambda/shared/limits.ts`, `PatchToy-Security` table, no setting):
sign-in lockout after 5 failures (30 s, doubling, max 15 min, same answer for unknown
accounts), 60 sign-ins / 15 min / IP, 30 registrations / hour / IP, 5 / hour / address,
sign-up mails per address 1 / minute, 3 / hour, 6 / day, 20 verification resends / hour / IP,
30 verification link submissions / hour / IP, 20 reset requests / hour / IP, one reset mail
per address per 5 minutes (5 a day), 500 projects per account, 200 counted views per viewer
per day.

**Visibility.** API: `visibility` = `private` | `unlisted` | `public` on save, update and
`PUT /api/projects/{id}/visibility`. The 1.x boolean `isPublic` is still accepted and means
link-only (`true` = unlisted). Only `public` sets the sparse GSI keys (`visibility`,
`publicOwner`). Making a project private deletes its thumbnail (and invalidates it on the CDN).

**Email-verification sign-up (SECURITY.md M5).** Registration no longer tells whether an
address has an account:
- `POST /api/auth/register` always answers `202 { pending: true, message: "Check your email to
  finish signing up…" }` (input errors, a taken *username* and rate limits stay explicit:
  none of them depends on the address). Both paths hash the password and send one mail, so
  the timing matches too.
- A new address gets **"Confirm your email to finish signing up for PatchToy"** with a
  single-use link `https://<site>/#verify=<token>` (24 hours; the token is in the fragment,
  so it never reaches a server log or a Referer, and the app removes it from the URL before
  it makes any request). The mail names the username being created, so someone who didn't
  sign up can tell. Opening the link (`POST /api/auth/verify-email`) creates the account and
  signs in. If the username was taken meanwhile, the account gets a numbered variant and the
  app asks the user to keep or change it.
- An address that already has an account gets **"Someone tried to sign up for PatchToy with
  your email"** (sign in, or use "Forgot password?"; nothing changed). It contains nothing the
  requester typed.
- Until the link is opened there is no account: the sign-up waits in `PatchToy-Security`
  (`signup#<keyed hash of the address>`, password as a bcrypt hash, token as SHA-256, TTL).
  Signing in fails like a wrong password; the sign-in dialog then offers "Didn’t confirm your
  email?" (`POST /api/auth/resend-verification`, same answer for every address).
- One pending sign-up per address: a newer sign-up or a resend replaces it and invalidates
  older links (so a stranger who signs up with your address first can't make your link
  create *their* account).
- Limits: sign-up / notice mails per address 1 per minute, 3 per hour, 6 per day (register
  and resend together; over a limit the answer is the same and nothing is sent or changed),
  resend 20 / hour / IP, link submissions 30 / hour / IP, plus the existing register limits.
  Unknown addresses on resend and reset wait about as long as a mail takes to send.
- **Existing users: nothing to migrate.** Accounts from 1.x (and anyone created before this
  change) have no `emailVerifiedAt`; that counts as verified, sign-in doesn't look at it, and
  no backfill or forced re-verification happens. New accounts get `emailVerifiedAt`.
- **SES must be out of the sandbox.** In the SES sandbox, mail only reaches verified
  addresses, so nobody else could finish signing up. Before deploying: verify the sender
  domain (`patchtoy.com`, with DKIM) in the backend's region and request production access
  (SES console → Account dashboard → "Request production access"; it usually takes about a
  day). Until it is granted, deploy with `SIGNUP_EMAIL_VERIFICATION=false` (the previous
  behaviour, with its enumeration trade-off).

**Known trade-offs / follow-ups.**
- The user page reads card attributes from `public-updatedAt-index` filtered by author (2
  pages max). For exact, cheaper user pages add `user-public-index` in its own deployment
  (`ENABLE_USER_PUBLIC_INDEX=true`, like the popular index; never both in one deployment).
  "My projects" still reads `userId-updatedAt-index`, which projects ALL attributes (bounded
  by the quota and a 500-item cap per request).
- JavaScript nodes still run in the page (the session token is in localStorage). Moving JS
  nodes to a sandboxed iframe / worker and the token out of localStorage are follow-ups.
- JS nodes' `loadScript()` can only load same-origin scripts in production now (the CSP no
  longer allows the whole cdnjs host).

## Rollback

- Site: redeploy the previous `dist/` (`git checkout v1.x && npm run build && cd infra && npx cdk deploy PatchToyStack`).
- Backend: the 1.x site works against the 2.0 backend, so the backend can stay. Removing
  the GSI or the thumbnail resources is another deployment (tables and the bucket are retained).

## Decisions / follow-ups

- **TODO (Render 3D models in the cloud):** glTF models are stored inside the project as data URLs (up to 15 MB, `src/render3d/ModelNode.js` `MODEL_SIZE_CAP`). Cloud saves have a much smaller project size limit, so before releasing projects with models to the community, models need their own upload path like thumbnails: a presigned S3 POST for `models/<userId>/<hash>.glb` (content-addressed, size-capped, `model/gltf-binary` only), served through CloudFront, with the project referencing the URL in `data.src` instead of the data URL. Not built yet.

- **Usernames**: every account created through the 1.x API already has one (registration
  required it). The login fallback + prompt covers anything else. Username changes are
  allowed any time; the old handle becomes free, and "forked from @old" labels on other
  users' forks keep the old name. Consider rate-limiting renames.
- **Thumbnails**: S3 + CloudFront (default `*.cloudfront.net` domain). Optional: a custom
  domain such as `thumbs.patchtoy.com` (certificate in us-east-1 + alias record), then the
  CSP can name it instead of `https://*.cloudfront.net`.
- **Social previews (Open Graph)**: implemented behind `ENABLE_SOCIAL_PREVIEWS` (step 8).
  Without it, crawlers see the generic PatchToy tags of `index.html`.
- **Sign-up links** are single use and expire after 24 hours; only the newest link of an
  address works.
- **CORS**: the API allows any origin (`*`) unless `API_ALLOWED_ORIGINS` is set. Set it to the
  site's domains (and `http://localhost:5200` for development) when convenient.
- **Password reset links** are single use and expire after 30 minutes.
- The SES sender (`FROM_EMAIL`, default `noreply@patchtoy.com`) must be a verified SES identity.
