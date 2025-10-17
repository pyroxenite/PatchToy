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

### Authentication

- `POST /api/auth/register` - Create account
  - Body: `{ email, password }`
  - Returns: `{ token, userId, email }`

- `POST /api/auth/login` - Sign in
  - Body: `{ email, password }`
  - Returns: `{ token, userId, email }`

- `GET /api/auth/verify` - Verify token
  - Headers: `Authorization: Bearer <token>`
  - Returns: `{ valid: true, userId, email }`

### Projects

- `GET /api/projects` - List user's projects
  - Headers: `Authorization: Bearer <token>`
  - Returns: `{ projects: [{ id, name, createdAt, updatedAt }] }`

- `GET /api/projects/:id` - Get project
  - Headers: `Authorization: Bearer <token>`
  - Returns: `{ id, name, data, createdAt, updatedAt }`

- `POST /api/projects` - Save new project
  - Headers: `Authorization: Bearer <token>`
  - Body: `{ name, data }`
  - Returns: `{ id, name, createdAt, updatedAt }`

- `PUT /api/projects/:id` - Update project
  - Headers: `Authorization: Bearer <token>`
  - Body: `{ name?, data? }`
  - Returns: `{ id, name, updatedAt }`

- `DELETE /api/projects/:id` - Delete project
  - Headers: `Authorization: Bearer <token>`
  - Returns: `{ success: true }`

## Database Schema

### Users Table
```
PK: userId (UUID)
Attributes:
  - email (string)
  - passwordHash (bcrypt)
  - createdAt (ISO timestamp)

GSI: email-index (for login lookup)
```

### Projects Table
```
PK: projectId (UUID)
Attributes:
  - userId (string)
  - name (string)
  - data (JSON - full project)
  - createdAt (ISO timestamp)
  - updatedAt (ISO timestamp)

GSI: userId-updatedAt-index (for listing user's projects)
```

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

- Password hashing with bcrypt
- JWT tokens with expiration (30 days)
- CORS configured (restrict origins in production)
- DynamoDB encryption at rest
- Point-in-time recovery enabled
- Data retention on stack deletion

## Flexibility Notes

The backend is designed to be flexible for early-stage development:

1. **Pay-per-request billing** - No fixed costs, scales with usage
2. **Loose validation** - Password requirements are minimal (can be tightened later)
3. **CORS allows all origins** - Easy to test from localhost (restrict in production)
4. **No email verification** - Can be added later if needed
5. **No rate limiting on auth** - Add if abuse becomes an issue
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
