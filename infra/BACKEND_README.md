# PatchToy Backend

Backend infrastructure for PatchToy with user accounts and cloud project storage.

## Architecture

- **API Gateway**: REST API for auth and projects
- **Lambda Functions**: Serverless handlers (Node.js 20)
- **DynamoDB**: NoSQL database for users and projects
- **JWT**: Stateless authentication tokens

## Setup

### 1. Enable backend deployment

Edit `infra/.env`:

```bash
DEPLOY_BACKEND=true
JWT_SECRET=<generate-strong-random-secret>
```

Generate a strong JWT secret:
```bash
openssl rand -base64 32
```

### 2. Install dependencies

```bash
cd infra
npm install
cd lambda
npm install
cd ..
```

### 3. Deploy

```bash
npm run deploy
```

This will deploy both the frontend (S3/CloudFront) and backend (API Gateway/Lambda/DynamoDB).

After deployment, note the API URL in the output:
```
PatchToyBackendStack.ApiUrl = https://xxxxx.execute-api.us-east-1.amazonaws.com/prod/
```

### 4. Update frontend config

Add the API URL to your frontend environment configuration (see frontend integration below).

## API Endpoints

All responses are JSON with `Access-Control-Allow-Origin: *` (errors from API Gateway
itself too). Bodies are size-limited (380 KB request, 350 KB project data) and validated.
Emails are never part of a public response.

### Authentication

- `POST /api/auth/register` `{ email, username, password }` -> `202 { pending: true, message }` for
  every address (username: 3-20 of `a-z 0-9 _ -`, unique, some names reserved). A new address
  gets a verification link (`<FRONTEND_URL>/#verify=<token>`, 24 h, single use); an address
  with an account gets a "someone tried to sign up" notice. With `SIGNUP_VERIFICATION=off`:
  `201 { token, userId, email, username, user }` / `409 Email already in use` (previous behaviour).
- `POST /api/auth/verify-email` `{ token }` -> `{ token, userId, email, username, user }` (creates
  the account, signs in); invalid / expired / used / replaced links: `401 { code: 'verify_invalid' }`
- `POST /api/auth/resend-verification` `{ email }` -> `{ message }` (same answer for every address)
- `POST /api/auth/login` `{ login, password }` (email or username) -> same shape. Accounts
  without a username get one derived from their email (`user.usernameGenerated: true`;
  the app asks the user to keep or change it).
- `GET /api/auth/verify` (auth) -> `{ valid, userId, email, username }`
- `POST /api/auth/request-password-reset`, `POST /api/auth/reset-password`

### Users

- `GET /api/users/{username}?cursor=` (public) -> `{ user: { username, displayName, createdAt }, projects: [card], cursor }`
- `PUT /api/users/me` (auth) `{ username?, displayName? }` -> `{ token, username, user }`
  (a new token: it carries the username; renaming re-labels the user's projects)

### Projects

A *card* is `{ id, name, description, username, isPublic, visibility, thumbUrl, views, forks, nodeCount, hasJS, forkedFrom, createdAt, updatedAt }`.

- `GET /api/projects` (auth) -> `{ projects: [card] }` (own projects, public and private)
- `GET /api/projects/public?sort=new|popular&q=&cursor=&limit=` (public) -> `{ projects: [card], cursor }`
  (q matches title or author; `cursor` is opaque)
- `GET /api/projects/{id}` (optional auth) -> card + `{ data, userId, isOwner }`. Private
  projects: 404 "private or does not exist" for everyone but the owner.
- `POST /api/projects` (auth) `{ name, data, description?, visibility?, forkedFrom?: { id } }` -> card.
  `visibility`: `'private'` (default) | `'unlisted'` | `'public'`; the 1.x `isPublic: true` still works and means unlisted.
  `forkedFrom` must be public (or yours); author and name are recorded from the source.
- `PUT /api/projects/{id}` (owner) `{ name?, data?, description?, visibility? }`
- `PUT /api/projects/{id}/visibility` (owner) `{ visibility: 'private' | 'unlisted' | 'public' }` (or the 1.x `{ isPublic }`)
- `DELETE /api/projects/{id}` (owner) (also deletes the thumbnail)
- `POST /api/projects/{id}/view` (public) -> `{ counted, views }`: counts an open of a
  public or unlisted project; owners are not counted, the same viewer (HMAC of the user id, or
  of the IP when signed out; the User-Agent is ignored) at most once per project per 24 h,
  and at most `LIMITS.viewsPerViewerDaily` counted views per viewer per day
- `POST /api/projects/{id}/thumbnail` (owner) -> `{ upload: { url, fields, maxBytes }, thumbUrl }`:
  presigned S3 POST for a JPEG of at most 150 KB; the browser uploads directly to S3

## Database Schema

### Users table (`PatchToy-Users`)
```
PK: userId (UUID)
  email, username, passwordHash, createdAt, displayName?, usernameGenerated?, usernameChangedAt?,
  tokenVersion?, projectCount?, emailVerifiedAt? (missing = verified: accounts from before the
  verification sign-up)
GSI email-index (email), username-index (username)
Reservation items: userId = "username#<name>", handleOwner  (conditional puts keep usernames unique)
```

### Projects table (`PatchToy-Projects`)
```
PK: projectId (UUID)
  userId, username (denormalized), name, nameLower, description, data (project JSON),
  isPublic, visibility ("public" only while public), thumbKey, views, forks,
  nodeCount, hasJS, forkedFrom { id, username, name }, createdAt, updatedAt, publishedAt,
  lastViewKey, lastViewAt
GSI userId-updatedAt-index   (userId, updatedAt)      ALL
GSI public-updatedAt-index   (visibility, updatedAt)  INCLUDE card attributes   [2.0, sparse]
GSI public-views-index       (visibility, views)      INCLUDE card attributes   [optional, later deploy]
```

Without `public-views-index`, "popular" ranks the 500 most recently updated public
projects in the Lambda. DynamoDB creates only one GSI per table per deployment, so the
views index is behind `ENABLE_POPULAR_INDEX=true` for a later deploy (see `RELEASE.md`).

### Security table (`PatchToy-Security`)
```
PK: pk, TTL: ttl
  rl#<scope>#<hmac>#<window>   rate-limit counters
  af#<key>                     sign-in failures / lockout
  reset#<sha256(token)>        single-use password reset tokens (30 min)
  signup#<hmac(email)>         pending sign-ups: email, username, passwordHash, tokenHash, expiresAt (24 h)
  once#<key>                   view / fork claims
```

### Thumbnails

Private S3 bucket (`ThumbnailsBucket`, keys `thumbs/<projectId>/<stamp>.jpg`) served by a
CloudFront distribution with Origin Access Control (`ThumbnailsUrl` output). Uploads are
presigned POSTs whose policy caps the size and content type.

## Code layout and tests

- `lambda/shared/store.ts`: data access interface; `dynamo-store.ts` (AWS) and
  `memory-store.ts` (tests, local mock API) implement it. `blobs.ts`: thumbnail storage.
- `lambda/shared/validate.ts`: input validation and size limits; `http.ts`: auth, body
  parsing, error mapping, public card shape.
- `cd lambda && npm test`: handler tests against the in-memory store, plus DynamoStore
  command-shape tests (no AWS).
- `npx ts-node test/synth-check.ts`: offline synth of both stacks with template assertions.
- `lambda/edge/social-preview.ts`: the optional Lambda@Edge link-preview function of the site
  stack (`ENABLE_SOCIAL_PREVIEWS`, RELEASE.md step 8); tests in `lambda/test/social-preview.test.ts`.
- `node scripts/backfill-community.mjs [--apply]`: one-off backfill after the 2.0 deploy.
- `../scripts/mock-api.mjs`: the whole API locally (real handlers, in-memory data).

## Configuration Options

### JWT Secret
**IMPORTANT**: Use a strong random secret in production. The default is only for development.

### API Key (Optional)
Add an additional security layer:
```bash
REQUIRE_API_KEY=true
```

Clients will need to include `X-Api-Key` header. Retrieve the key from AWS Console after deployment.

### Billing
The stack uses:
- **DynamoDB**: Pay-per-request (no minimum)
- **Lambda**: First 1M requests/month free
- **API Gateway**: Pay per request

Estimated cost for early stage: **$0-5/month** (depending on usage)

## Security Features

- Password hashing with bcrypt, cost 12 (1.x hashes at cost 10 are upgraded on the next sign-in)
- Password policy: 8-256 characters, a small common-password blocklist, not the username / email
- Session JWTs (HS256 only, `aud`/`iss`/`typ`, 30 days) carry the user's `tokenVersion`; every
  authenticated request checks it against the users table, so a password reset or a username
  change signs out every other session
- Password reset links: opaque single-use tokens (stored as SHA-256, 30 minutes), in the URL
  fragment (`/#reset=…`), never usable as a session
- Sign-up by email verification: register answers the same for every address (no account
  enumeration); the account exists once the single-use link (`/#verify=…`, 24 hours, SHA-256
  stored, newest link only) is opened
- No default JWT secret: the stack and the functions fail closed without one (>= 32 characters,
  preferably an SSM SecureString, `JWT_SECRET_PARAM`)
- Abuse limits in DynamoDB (`PatchToy-Security`, TTL): per-account sign-in lockout with
  exponential backoff, per-IP limits on sign-in / register / reset, one reset mail per address
  per 5 minutes, per-user project quota (500); optional AWS WAF rate rules (`ENABLE_WAF`)
- Author names on projects come from the users table, never from the token
- CORS without credentials; allowed origins configurable (`API_ALLOWED_ORIGINS`)
- DynamoDB encryption at rest
- Point-in-time recovery enabled
- Data retention on stack deletion

See `RELEASE.md` (security settings) for the deploy-time options.

## Flexibility Notes

The backend is designed to be flexible for early-stage development:

1. **Pay-per-request billing** - No fixed costs, scales with usage
2. **Basic password policy** - length, blocklist, not username/email (no complexity rules)
3. **CORS allows all origins by default** - set `API_ALLOWED_ORIGINS` to restrict
4. **Email verification** - sign-up completes through an emailed link (SES must be out of the
   sandbox); `SIGNUP_EMAIL_VERIFICATION=false` falls back to immediate sign-up
5. **Rate limits in code; WAF optional** - `ENABLE_WAF=true` adds per-IP rules (costs money)
6. **Tables retained on stack deletion** - Won't lose data accidentally

## Deployment Commands

```bash
# Deploy everything (frontend + backend)
npm run deploy

# Deploy without approval prompts
npm run deploy:no-approval

# Deploy only backend stack
npx cdk deploy PatchToyBackendStack

# Destroy backend (keeps DynamoDB tables)
npx cdk destroy PatchToyBackendStack
```

## Frontend Integration

See main README for frontend code to integrate with this API.

The frontend should:
1. Store JWT token in localStorage
2. Include `Authorization: Bearer <token>` header in requests
3. Handle 401 responses (redirect to login)
4. Implement login/register UI
5. Add cloud save/load buttons
