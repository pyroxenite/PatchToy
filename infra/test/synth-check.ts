/**
 * Offline synth check of the backend + site stacks (no AWS calls, no bundling).
 *
 *   cd infra && npx ts-node test/synth-check.ts
 *
 * Asserts the parts of the templates the 2.0 community release depends on.
 */
import { App, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PatchToyBackendStack, PUBLIC_INDEX, POPULAR_INDEX, USER_PUBLIC_INDEX, SECURITY_TABLE, PatchToyBackendStackProps } from '../lib/patchtoy-backend-stack';
import { PatchToyStack, MONACO_CDN, SOCIAL_PREVIEW_SOURCE, PatchToyStackProps } from '../lib/patchtoy-stack';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const env = { account: '123456789012', region: 'eu-west-3' };

const TEST_SECRET = 'synth-check-secret-0123456789abcdef01234';

function synthBackend(enablePopularIndex: boolean, extra: Partial<PatchToyBackendStackProps> = {}) {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new PatchToyBackendStack(app, 'PatchToyBackendStack', { env, jwtSecret: TEST_SECRET, enablePopularIndex, ...extra });
  return Template.fromStack(stack);
}

function gsiNames(t: Template, tableName: string): string[] {
  const tables = t.findResources('AWS::DynamoDB::Table', { Properties: { TableName: tableName } });
  const [table] = Object.values(tables);
  return (table.Properties.GlobalSecondaryIndexes || []).map((g: any) => g.IndexName);
}

// --- First deployment: exactly one new GSI on the projects table
const t1 = synthBackend(false);
assert.deepStrictEqual(gsiNames(t1, 'PatchToy-Projects').sort(), ['public-updatedAt-index', 'userId-updatedAt-index'].sort());
assert.deepStrictEqual(gsiNames(t1, 'PatchToy-Users').sort(), ['email-index', 'username-index']);
t1.hasResourceProperties('AWS::DynamoDB::Table', {
  TableName: 'PatchToy-Projects',
  GlobalSecondaryIndexes: Match.arrayWith([Match.objectLike({
    IndexName: PUBLIC_INDEX,
    KeySchema: [{ AttributeName: 'visibility', KeyType: 'HASH' }, { AttributeName: 'updatedAt', KeyType: 'RANGE' }],
    Projection: Match.objectLike({ ProjectionType: 'INCLUDE' }),
  })]),
});

// Routes
const resources = Object.values(t1.findResources('AWS::ApiGateway::Resource')).map((r: any) => r.Properties.PathPart);
for (const part of ['public', 'view', 'thumbnail', 'users', 'me', '{username}', 'verify-email', 'resend-verification']) {
  assert.ok(resources.includes(part), `missing API resource ${part}`);
}
t1.resourceCountIs('AWS::ApiGateway::GatewayResponse', 2);

// Thumbnails bucket is private, served through CloudFront
t1.hasResourceProperties('AWS::S3::Bucket', {
  PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
  CorsConfiguration: Match.anyValue(),
});
t1.resourceCountIs('AWS::CloudFront::Distribution', 1);
t1.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);

// Every function knows the index and thumbnail settings
const fns = Object.values(t1.findResources('AWS::Lambda::Function')).filter((f: any) => f.Properties.Environment?.Variables?.USERS_TABLE);
assert.ok(fns.length >= 16, `expected >= 16 API functions, got ${fns.length}`);
for (const f of fns as any[]) {
  const v = f.Properties.Environment.Variables;
  assert.strictEqual(v.PUBLIC_INDEX, PUBLIC_INDEX);
  assert.strictEqual(v.POPULAR_INDEX, '');
  assert.strictEqual(v.USER_PUBLIC_INDEX, '');
  assert.ok(v.THUMBS_BUCKET && v.THUMBS_BASE_URL && v.THUMBS_DISTRIBUTION_ID);
  assert.ok(v.SECURITY_TABLE, 'functions know the security table');
  assert.strictEqual(v.JWT_SECRET, TEST_SECRET);
  assert.strictEqual(v.ALLOWED_ORIGINS, '*');
}

// --- Security (2.0 review)
// No default JWT secret: synth fails closed
for (const bad of [undefined, 'short-secret']) {
  assert.throws(() => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    new PatchToyBackendStack(app, 'NoSecret', { env, jwtSecret: bad });
  }, /JWT_SECRET/);
}
// SSM SecureString: the secret is not in the template, functions may read only that parameter
{
  const t = synthBackend(false, { jwtSecret: undefined, jwtSecretParameterName: '/patchtoy/jwt-secret' });
  const tpl = JSON.stringify(t.toJSON());
  assert.ok(!tpl.includes(TEST_SECRET));
  const vars = (Object.values(t.findResources('AWS::Lambda::Function')) as any[]).filter(f => f.Properties.Environment?.Variables?.USERS_TABLE).map(f => f.Properties.Environment.Variables);
  assert.ok(vars.every(v => v.JWT_SECRET_PARAM === '/patchtoy/jwt-secret' && v.JWT_SECRET === undefined));
  assert.ok(tpl.includes('parameter/patchtoy/jwt-secret') && tpl.includes('ssm:GetParameter'));
}
// Security table with TTL
t1.hasResourceProperties('AWS::DynamoDB::Table', {
  TableName: SECURITY_TABLE,
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
});
// WAF off by default; on with the flag, associated to the API stage
t1.resourceCountIs('AWS::WAFv2::WebACL', 0);
{
  const t = synthBackend(false, { enableWaf: true, wafAuthRateLimit: 50 });
  t.resourceCountIs('AWS::WAFv2::WebACL', 1);
  t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  t.hasResourceProperties('AWS::WAFv2::WebACL', {
    Scope: 'REGIONAL',
    Rules: Match.arrayWith([Match.objectLike({ Name: 'AuthRateLimit', Statement: { RateBasedStatement: Match.objectLike({ Limit: 50, AggregateKeyType: 'IP' }) } })]),
  });
}
// CORS without credentials; configurable origins
{
  const tpl = JSON.stringify(t1.toJSON());
  assert.ok(!tpl.includes('Access-Control-Allow-Credentials'), 'preflight must not allow credentials');
  const t = synthBackend(false, { allowedOrigins: ['https://patchtoy.com', 'http://localhost:5200'] });
  const vars = (Object.values(t.findResources('AWS::Lambda::Function')) as any[]).find(f => f.Properties.Environment?.Variables?.USERS_TABLE).Properties.Environment.Variables;
  assert.strictEqual(vars.ALLOWED_ORIGINS, 'https://patchtoy.com,http://localhost:5200');
}
// SES limited to the sender identity
{
  const tpl = JSON.stringify(t1.toJSON());
  assert.ok(tpl.includes('identity/noreply@patchtoy.com'), 'SES scoped to the sender');
}
// Thumbnails: nosniff + HSTS on the CDN
t1.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
  ResponseHeadersPolicyConfig: Match.objectLike({
    SecurityHeadersConfig: Match.objectLike({
      ContentTypeOptions: { Override: true },
      StrictTransportSecurity: Match.objectLike({ Override: true }),
    }),
  }),
});
// bcrypt cost 12: hashing functions get more CPU
assert.ok((Object.values(t1.findResources('AWS::Lambda::Function')) as any[]).filter(f => f.Properties.MemorySize === 1024).length >= 3, 'register / login / reset at 1024 MB');
t1.hasResourceProperties('AWS::Lambda::Function', { Environment: Match.objectLike({ Variables: Match.objectLike({ FROM_EMAIL: 'noreply@patchtoy.com', FRONTEND_URL: 'https://patchtoy.com' }) }) });

// Email-verification sign-up: on by default, register / resend / reset may mail (sender only)
{
  const fnVars = (t: Template) => (Object.values(t.findResources('AWS::Lambda::Function')) as any[])
    .map(f => f.Properties.Environment?.Variables || {});
  const register = fnVars(t1).filter(v => v.SIGNUP_VERIFICATION !== undefined);
  assert.strictEqual(register.length, 1, 'only register reads SIGNUP_VERIFICATION');
  assert.strictEqual(register[0].SIGNUP_VERIFICATION, 'required');
  assert.ok(register[0].FROM_EMAIL && register[0].FRONTEND_URL, 'register mails links');
  const off = fnVars(synthBackend(false, { signupEmailVerification: false })).find(v => v.SIGNUP_VERIFICATION !== undefined);
  assert.strictEqual(off.SIGNUP_VERIFICATION, 'off');
  const sesPolicies = (Object.values(t1.findResources('AWS::IAM::Policy')) as any[])
    .filter(p => JSON.stringify(p.Properties.PolicyDocument).includes('ses:SendEmail'));
  assert.strictEqual(sesPolicies.length, 3, `SES for register, resend and reset only (got ${sesPolicies.length})`);
}

// --- Second (optional) deployment adds the popular index
const t2 = synthBackend(true);
assert.ok(gsiNames(t2, 'PatchToy-Projects').includes(POPULAR_INDEX));
assert.strictEqual(gsiNames(t2, 'PatchToy-Projects').length, 3);
// --- Optional user-public index (its own deployment)
const t3 = synthBackend(false, { enableUserPublicIndex: true });
assert.ok(gsiNames(t3, 'PatchToy-Projects').includes(USER_PUBLIC_INDEX));
assert.strictEqual(gsiNames(t3, 'PatchToy-Projects').length, 3);
assert.throws(() => synthBackend(true, { enableUserPublicIndex: true }), /one GSI per deployment/);

// --- Site: SPA fallback + CSP allows thumbnails and uploads
{
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const site = new PatchToyStack(app, 'PatchToyStack', { env, hostedZoneId: 'Z123', zoneName: 'example.com' });
  const t = Template.fromStack(site);
  t.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      CustomErrorResponses: Match.arrayWith([
        Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
      ]),
    }),
  });
  const policies = Object.values(t.findResources('AWS::CloudFront::ResponseHeadersPolicy')) as any[];
  const csp = policies[0].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
  assert.ok(csp.includes('img-src') && csp.includes('https://*.cloudfront.net'), 'CSP img-src misses thumbnails');
  assert.ok(csp.includes('https://*.s3.eu-west-3.amazonaws.com'), 'CSP connect-src misses S3 uploads');
  for (const d of ["object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'", "form-action 'self'"]) {
    assert.ok(csp.includes(d), `CSP misses ${d}`);
  }
  assert.ok(csp.includes(`script-src 'self' 'unsafe-eval' ${MONACO_CDN};`), 'script-src pinned to the Monaco path');
  assert.ok(!/https:\/\/cdnjs\.cloudflare\.com[ ;]/.test(csp), 'no whole-cdnjs allowance');
  const sec = policies[0].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
  assert.strictEqual(sec.ReferrerPolicy.ReferrerPolicy, 'strict-origin-when-cross-origin');
  assert.strictEqual(sec.XSSProtection.Protection, false);
  assert.ok(sec.StrictTransportSecurity && sec.ContentTypeOptions, 'HSTS + nosniff');
  // Narrowed CSP origins
  const app2 = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const site2 = new PatchToyStack(app2, 'PatchToyStack2', { env, hostedZoneId: 'Z123', zoneName: 'example.com', cspThumbnailOrigins: ['https://d123.cloudfront.net'] });
  const csp2 = (Object.values(Template.fromStack(site2).findResources('AWS::CloudFront::ResponseHeadersPolicy')) as any[])[0].Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy;
  assert.ok(csp2.includes('img-src \'self\' data: blob: https://d123.cloudfront.net;'));
}

// --- Social link previews (Lambda@Edge, off by default)
{
  const siteApp = (props: Partial<PatchToyStackProps> = {}) => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const site = new PatchToyStack(app, 'PatchToyStack', { env, hostedZoneId: 'Z123', zoneName: 'example.com', ...props });
    return { app, site, t: Template.fromStack(site) };
  };
  const off = siteApp();
  const dist = (t: Template) => (Object.values(t.findResources('AWS::CloudFront::Distribution')) as any[])[0].Properties.DistributionConfig;
  assert.strictEqual(dist(off.t).CacheBehaviors, undefined, 'no extra behaviours without the flag');
  assert.ok(!JSON.stringify(off.t.toJSON()).includes('LambdaFunctionAssociations'), 'no Lambda@Edge without the flag');
  assert.strictEqual(off.app.node.children.filter(c => c instanceof Stack).length, 1, 'no us-east-1 stack without the flag');

  assert.throws(() => siteApp({ enableSocialPreviews: true }), /SOCIAL_PREVIEW_API_URL/);

  const on = siteApp({ enableSocialPreviews: true, socialPreviews: { apiUrl: 'https://api.example.com/prod/' }, cspThumbnailOrigins: ['https://d123.cloudfront.net'] });
  const behaviors = dist(on.t).CacheBehaviors as any[];
  assert.deepStrictEqual(behaviors.map(b => b.PathPattern).sort(), ['/p/*', '/u/*']);
  for (const b of behaviors) {
    assert.strictEqual(b.LambdaFunctionAssociations.length, 1);
    assert.strictEqual(b.LambdaFunctionAssociations[0].EventType, 'origin-request');
    assert.strictEqual(b.ViewerProtocolPolicy, 'redirect-to-https');
    assert.ok(b.ResponseHeadersPolicyId, 'same security headers (CSP) as the rest of the site');
  }
  on.t.hasResourceProperties('AWS::CloudFront::CachePolicy', {
    CachePolicyConfig: Match.objectLike({
      DefaultTTL: 300,
      ParametersInCacheKeyAndForwardedToOrigin: Match.objectLike({
        QueryStringsConfig: { QueryStringBehavior: 'none' },
        HeadersConfig: { HeaderBehavior: 'none' },
        CookiesConfig: { CookieBehavior: 'none' },
      }),
    }),
  });
  // The function itself lives in a us-east-1 stack (Lambda@Edge), without environment variables
  const edgeStacks = on.app.node.children.filter(c => c instanceof Stack && c !== on.site) as Stack[];
  assert.strictEqual(edgeStacks.length, 1, 'one support stack for the edge function');
  assert.strictEqual(edgeStacks[0].region, 'us-east-1');
  const edgeT = Template.fromStack(edgeStacks[0]);
  edgeT.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs20.x', Handler: 'index.handler', MemorySize: 128, Timeout: 5 });
  for (const f of Object.values(edgeT.findResources('AWS::Lambda::Function')) as any[]) {
    assert.strictEqual(f.Properties.Environment, undefined, 'Lambda@Edge cannot have environment variables');
  }

  // The bundle builds and carries its configuration (what the asset bundling runs at deploy)
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'patchtoy-edge-'));
  try {
    const config = { apiUrl: 'https://api.example.com/prod', siteUrl: 'https://example.com', unlisted: true };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('esbuild').buildSync({
      entryPoints: [SOCIAL_PREVIEW_SOURCE], outfile: path.join(out, 'index.js'), bundle: true, platform: 'node',
      target: 'node20', format: 'cjs', define: { __PREVIEW_CONFIG__: JSON.stringify(config) }, logLevel: 'error',
    });
    const code = fs.readFileSync(path.join(out, 'index.js'), 'utf8');
    assert.ok(code.includes('https://api.example.com/prod'), 'config compiled in');
    assert.ok(!/require\(["']aws-sdk|@aws-sdk/.test(code), 'no AWS SDK in the edge bundle');
    assert.ok(Buffer.byteLength(code) < 1024 * 1024, 'small bundle');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const edge = require(path.join(out, 'index.js'));
    const request = { uri: '/explore', method: 'GET', headers: {}, querystring: '', clientIp: '1.2.3.4' };
    edge.handler({ Records: [{ cf: { config: {}, request } }] }).then((r: any) => assert.strictEqual(r, request, 'non-preview paths pass through'));
  } finally {
    setTimeout(() => fs.rmSync(out, { recursive: true, force: true }), 100);
  }
}

console.log('synth-check: OK');
