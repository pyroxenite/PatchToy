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
      requireApiKey: process.env.REQUIRE_API_KEY === 'true',
    });
  } else {
    console.log('Backend stack disabled (set DEPLOY_BACKEND=true to enable)');
  }
}
