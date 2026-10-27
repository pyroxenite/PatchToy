#!/usr/bin/env node
import 'source-map-support/register';
import { App } from 'aws-cdk-lib';
import { PatchToyStack } from '../lib/patchtoy-stack';
import { PatchToyBackendStack } from '../lib/patchtoy-backend-stack';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  dotenv.config({ path: envFile });
} else {
  dotenv.config();
}

const app = new App();

const zoneName = process.env.zoneName;
const hostedZoneId = process.env.hostedZoneId;
const siteSubdomain = process.env.siteSubdomain ?? '';
const deployBackend = process.env.DEPLOY_BACKEND === 'true';
const jwtSecret = process.env.JWT_SECRET;
const list = (v?: string) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined);
const isBootstrapCommand = process.argv.includes('bootstrap');

if (!zoneName || !hostedZoneId) {
  const message = 'CDK stack not synthesized: set zoneName and hostedZoneId (see infra/.env.example).';
  if (isBootstrapCommand) {
    console.warn(message);
  } else {
    throw new Error(message);
  }
} else {
  new PatchToyStack(app, 'PatchToyStack', {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.CDK_DEFAULT_REGION,
    },
    hostedZoneId,
    zoneName,
    siteSubdomain,
    // Optional CSP narrowing (see RELEASE.md): e.g. CSP_API_ORIGINS=https://7c11mva4zg.execute-api.eu-west-3.amazonaws.com
    cspApiOrigins: list(process.env.CSP_API_ORIGINS),
    cspThumbnailOrigins: list(process.env.CSP_THUMBNAIL_ORIGINS),
    cspUploadOrigins: list(process.env.CSP_UPLOAD_ORIGINS),
    // Social link previews (Lambda@Edge in us-east-1, off by default; see RELEASE.md)
    enableSocialPreviews: process.env.ENABLE_SOCIAL_PREVIEWS === 'true',
    socialPreviews: {
      apiUrl: process.env.SOCIAL_PREVIEW_API_URL || undefined,
      unlisted: process.env.SOCIAL_PREVIEWS_UNLISTED !== 'false',
      imageOrigins: list(process.env.SOCIAL_PREVIEW_IMAGE_ORIGINS),
      defaultImage: process.env.SOCIAL_PREVIEW_DEFAULT_IMAGE || undefined,
    },
  });

  // Optionally deploy backend stack
  if (deployBackend) {
    console.log('Deploying backend stack...');
    new PatchToyBackendStack(app, 'PatchToyBackendStack', {
      env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
      },
      jwtSecret,
      // Preferred: an SSM SecureString name (e.g. /patchtoy/jwt-secret); JWT_SECRET is then unused
      jwtSecretParameterName: process.env.JWT_SECRET_PARAM || undefined,
      requireApiKey: process.env.REQUIRE_API_KEY === 'true',
      // AWS WAF rate limits (costs money, off by default)
      enableWaf: process.env.ENABLE_WAF === 'true',
      wafAuthRateLimit: process.env.WAF_AUTH_RATE_LIMIT ? Number(process.env.WAF_AUTH_RATE_LIMIT) : undefined,
      wafGeneralRateLimit: process.env.WAF_GENERAL_RATE_LIMIT ? Number(process.env.WAF_GENERAL_RATE_LIMIT) : undefined,
      allowedOrigins: list(process.env.API_ALLOWED_ORIGINS),
      // Third optional GSI (user pages), in its own deployment like the popular index
      enableUserPublicIndex: process.env.ENABLE_USER_PUBLIC_INDEX === 'true',
      fromEmail: process.env.FROM_EMAIL || undefined,
      frontendUrl: process.env.FRONTEND_URL || undefined,
      // Email-verification sign-up (default on). false = immediate sign-up (e.g. SES still in sandbox)
      signupEmailVerification: process.env.SIGNUP_EMAIL_VERIFICATION !== 'false',
      // Second GSI ("popular" index): enable only in a deployment after the one that
      // created public-updatedAt-index (one GSI per table per deployment, see RELEASE.md)
      enablePopularIndex: process.env.ENABLE_POPULAR_INDEX === 'true',
      thumbnailUploadOrigins: process.env.THUMBNAIL_UPLOAD_ORIGINS
        ? process.env.THUMBNAIL_UPLOAD_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
        : undefined,
    });
  } else {
    console.log('Backend stack disabled (set DEPLOY_BACKEND=true to enable)');
  }
}
