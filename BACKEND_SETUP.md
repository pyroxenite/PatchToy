# Backend Setup Guide

Complete backend with user accounts and cloud project storage for PatchToy.

## Current State

✅ **Backend infrastructure is ready but NOT deployed**
- Lambda functions implemented (8 endpoints)
- CDK stack configured
- DynamoDB tables defined
- Frontend auth UI integrated
- Account button hidden by default

## Quick Start

### Option 1: Local Development Only (No Backend)

Everything works as-is. Projects are saved to:
- LocalStorage (automatic)
- JSON files (💾 button)

The account button (👤) stays hidden.

### Option 2: Enable Backend

#### 1. Configure Backend

Edit `infra/.env`:

```bash
DEPLOY_BACKEND=true
JWT_SECRET=$(openssl rand -base64 32)
```

#### 2. Deploy Infrastructure

```bash
cd infra
npm install
npm run deploy
```

This deploys:
- API Gateway (REST API)
- 8 Lambda functions
- 2 DynamoDB tables
- Outputs API URL

#### 3. Update Frontend Config

Edit `src/config.js`:

```javascript
export const config = {
  API_URL: 'https://xxxxx.execute-api.us-east-1.amazonaws.com/prod',
};
```

Use the URL from CDK deploy output.

#### 4. Build & Deploy Frontend

```bash
npm run build
cd infra
npm run deploy
```

## Features

### When Backend is Disabled (Default)
- ✅ Full node editor works
- ✅ Local save/load (💾 📁)
- ✅ Custom nodes
- ✅ Feedback nodes
- ✅ All features except cloud sync

### When Backend is Enabled
- ✅ All above features
- ✅ User registration/login (👤 button appears)
- ✅ Cloud project storage (coming soon in UI)
- ✅ Sync across devices

## UI Components

### Account Button (👤)
- Hidden by default
- Shows when `API_URL` is configured
- Click when logged out → Login/Register dialog
- Click when logged in → Account menu

### Auth Dialog
- Email + password fields
- Login and Register buttons
- Error handling
- Enter key to submit

### Account Menu
- Shows user email
- Cloud Projects button (placeholder for now)
- Logout button

## API Endpoints

### Auth
- `POST /api/auth/register` - Create account
- `POST /api/auth/login` - Sign in
- `GET /api/auth/verify` - Verify token

### Projects
- `GET /api/projects` - List user's projects
- `GET /api/projects/:id` - Get project
- `POST /api/projects` - Save new project
- `PUT /api/projects/:id` - Update project
- `DELETE /api/projects/:id` - Delete project

## Architecture

```
Frontend (S3 + CloudFront)
    ↓
API Gateway
    ↓
Lambda Functions (Node.js 20)
    ↓
DynamoDB (Users + Projects)
```

## Cost Estimate

**Without backend**: $0
**With backend**: $0-5/month (depending on usage)

- DynamoDB: Pay-per-request
- Lambda: First 1M requests/month free
- API Gateway: Pay per request

## Security

- Passwords hashed with bcrypt
- JWT tokens (30-day expiry)
- HTTPS only
- CORS configured
- DynamoDB encryption at rest

## Next Steps

To fully implement cloud projects:

1. **Implement `showCloudProjects()`** in main.js
   - List projects from API
   - Load/save to cloud
   - Delete projects

2. **Add cloud save button** next to 💾
   - "Save to Cloud" option
   - Prompt for project name

3. **Auto-sync** (optional)
   - Save to cloud on changes
   - Conflict resolution

## Development Tips

**Testing locally without deploying:**
1. Use AWS SAM Local or `sam local start-api`
2. Point `API_URL` to `http://localhost:3000`

**Reset user account:**
- Delete from DynamoDB console
- Or: Clear localStorage token

**View API logs:**
```bash
aws logs tail /aws/lambda/PatchToyBackendStack-LoginFunction --follow
```

## Files Overview

```
/infra
  /lambda
    /auth          - Auth Lambda functions
    /projects      - Project CRUD functions
    /shared        - Utilities (JWT, DB, etc)
  /lib
    patchtoy-backend-stack.ts  - CDK infrastructure
  BACKEND_README.md            - Detailed backend docs

/src
  config.js      - API URL configuration
  ApiClient.js   - Backend API wrapper

main.js          - Auth UI integration
```

## Troubleshooting

**Account button not showing:**
- Check `src/config.js` has valid `API_URL`
- Reload page

**Login fails:**
- Check API URL is correct
- Check CORS in backend
- View browser console for errors

**Deploy fails:**
- Ensure AWS credentials configured
- Check `infra/.env` has valid values
- Run `cdk bootstrap` first

**TypeScript errors:**
- Run `npm run build` in `infra/` directory
- Check Node.js version (needs 18+)
