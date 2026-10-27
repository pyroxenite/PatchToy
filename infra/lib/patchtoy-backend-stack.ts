import { Duration, RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';

/** Sparse GSI listing public projects by last update (community "Newest"). */
export const PUBLIC_INDEX = 'public-updatedAt-index';
/** Optional GSI listing public projects by views (community "Popular"). See RELEASE.md. */
export const POPULAR_INDEX = 'public-views-index';
/** Optional sparse GSI listing one user's listed projects (user pages, card attributes only). */
export const USER_PUBLIC_INDEX = 'user-public-index';
/** Rate counters, single-use reset tokens, view / fork claims (items expire through TTL). */
export const SECURITY_TABLE = 'PatchToy-Security';
/** Minimum JWT secret length (same rule as infra/lambda/shared/jwt.ts). */
export const MIN_JWT_SECRET_LENGTH = 32;

/** Card attributes projected into the public indexes (the graph `data` is not). */
const PUBLIC_INDEX_ATTRIBUTES = [
  'userId', 'username', 'name', 'nameLower', 'description', 'isPublic', 'thumbKey', 'views', 'forks',
  'nodeCount', 'hasJS', 'forkedFrom', 'createdAt', 'publishedAt',
];

export interface PatchToyBackendStackProps extends StackProps {
  /**
   * JWT signing secret (>= 32 characters), passed as a Lambda environment variable.
   * Ignored when `jwtSecretParameterName` is set. One of the two is required: there
   * is no default (synth fails).
   */
  jwtSecret?: string;

  /**
   * Name of an SSM Parameter Store SecureString holding the JWT secret (e.g.
   * `/patchtoy/jwt-secret`, created once with the CLI, see RELEASE.md). The functions
   * read it at cold start; the secret is then neither in the template nor in the
   * Lambda configuration.
   */
  jwtSecretParameterName?: string;

  /**
   * Attach an AWS WAF web ACL to the API stage with per-IP rate rules (costs money:
   * ~$5/month per web ACL + $1 per rule + $0.60 per million requests). Off by default.
   */
  enableWaf?: boolean;
  /** WAF: requests per 5 minutes per IP to /api/auth/* (default 100). */
  wafAuthRateLimit?: number;
  /** WAF: requests per 5 minutes per IP to the whole API (default 2000). */
  wafGeneralRateLimit?: number;

  /**
   * Origins allowed to call the API (CORS). Default: any origin (`*`). The API uses
   * bearer tokens, never cookies, so credentials are never allowed.
   */
  allowedOrigins?: string[];

  /**
   * Add the `user-public-index` GSI (user pages read card attributes of listed
   * projects only). One GSI per table per deployment: enable it in its own deployment.
   */
  enableUserPublicIndex?: boolean;

  /** SES sender of password reset and sign-up mails (must be a verified SES identity). */
  fromEmail?: string;
  /** Site URL used in password reset and sign-up verification links. */
  frontendUrl?: string;

  /**
   * Email-verification sign-up (default true): register answers "check your email" for
   * every address and the account exists once the emailed link is opened. `false`
   * (SIGNUP_EMAIL_VERIFICATION=false) restores the immediate sign-up with its "Email
   * already in use" answer, e.g. while SES is still in sandbox mode (see RELEASE.md).
   */
  signupEmailVerification?: boolean;

  /**
   * Enable API key requirement (optional layer of security)
   */
  requireApiKey?: boolean;

  /**
   * Add the `public-views-index` GSI (popular sort without an in-memory ranking).
   * DynamoDB creates only one GSI per table per deployment, so enable this in a
   * deployment AFTER the one that created `public-updatedAt-index`.
   */
  enablePopularIndex?: boolean;

  /**
   * Origins allowed to upload thumbnails directly to S3 (bucket CORS).
   * Defaults to any origin: uploads are authorised by the presigned policy, not by origin.
   */
  thumbnailUploadOrigins?: string[];
}

export class PatchToyBackendStack extends Stack {
  public readonly api: apigateway.RestApi;
  public readonly usersTable: dynamodb.Table;
  public readonly projectsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: PatchToyBackendStackProps) {
    super(scope, id, props);

    const {
      jwtSecret,
      jwtSecretParameterName,
      requireApiKey = false,
      enablePopularIndex = false,
      enableUserPublicIndex = false,
      thumbnailUploadOrigins = ['*'],
      enableWaf = false,
      wafAuthRateLimit = 100,
      wafGeneralRateLimit = 2000,
      allowedOrigins = ['*'],
      fromEmail = 'noreply@patchtoy.com',
      frontendUrl = 'https://patchtoy.com',
      signupEmailVerification = true,
    } = props || {};

    // Fail closed: no silent default signing key
    if (!jwtSecretParameterName && (!jwtSecret || jwtSecret.length < MIN_JWT_SECRET_LENGTH)) {
      throw new Error(`PatchToyBackendStack: set JWT_SECRET_PARAM (SSM SecureString name) or a JWT_SECRET of at least ${MIN_JWT_SECRET_LENGTH} characters`);
    }
    if (enablePopularIndex && enableUserPublicIndex) {
      throw new Error('PatchToyBackendStack: DynamoDB creates one GSI per deployment; enable the popular and user-public indexes in separate deployments');
    }

    // =====================
    // DynamoDB Tables
    // =====================

    // Users table
    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: 'PatchToy-Users',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // Flexible for early stage
      removalPolicy: RemovalPolicy.RETAIN, // Keep data on stack deletion
      pointInTimeRecovery: true, // Enable backups
    });

    // GSI for querying by email
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'email-index',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for querying by username (for login & uniqueness check)
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'username-index',
      partitionKey: { name: 'username', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Projects table
    this.projectsTable = new dynamodb.Table(this, 'ProjectsTable', {
      tableName: 'PatchToy-Projects',
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
    });

    // GSI for querying user's projects sorted by update time
    this.projectsTable.addGlobalSecondaryIndex({
      indexName: 'userId-updatedAt-index',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for the community feed: only public projects carry `visibility` ('public'),
    // so the index is sparse. NOTE: one new GSI per table per deployment (see RELEASE.md).
    this.projectsTable.addGlobalSecondaryIndex({
      indexName: PUBLIC_INDEX,
      partitionKey: { name: 'visibility', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: PUBLIC_INDEX_ATTRIBUTES,
    });

    if (enablePopularIndex) {
      // Second deployment only: DynamoDB rejects two GSI creations in one update
      this.projectsTable.addGlobalSecondaryIndex({
        indexName: POPULAR_INDEX,
        partitionKey: { name: 'visibility', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'views', type: dynamodb.AttributeType.NUMBER },
        projectionType: dynamodb.ProjectionType.INCLUDE,
        nonKeyAttributes: [...PUBLIC_INDEX_ATTRIBUTES, 'updatedAt'],
      });
    }

    if (enableUserPublicIndex) {
      // Own deployment (one GSI per update): sparse, only listed projects carry publicOwner
      this.projectsTable.addGlobalSecondaryIndex({
        indexName: USER_PUBLIC_INDEX,
        partitionKey: { name: 'publicOwner', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'updatedAt', type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.INCLUDE,
        nonKeyAttributes: [...PUBLIC_INDEX_ATTRIBUTES, 'visibility'],
      });
    }

    // Abuse limits and single-use tokens: small items, expired by TTL
    const securityTable = new dynamodb.Table(this, 'SecurityTable', {
      tableName: SECURITY_TABLE,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY, // counters and tokens only, nothing to keep
    });

    // =====================
    // Thumbnails (S3 + CloudFront)
    // =====================

    // Private bucket; the browser uploads with presigned POSTs (size-capped policy),
    // CloudFront serves thumbs/* publicly through Origin Access Control.
    const thumbnailsBucket = new s3.Bucket(this, 'ThumbnailsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.POST],
          allowedOrigins: thumbnailUploadOrigins,
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
      ],
    });

    const thumbnailsCdn = new cloudfront.Distribution(this, 'ThumbnailsDistribution', {
      comment: 'PatchToy project thumbnails',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(thumbnailsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'ThumbnailsHeaders', {
          comment: 'PatchToy thumbnails: CORS GET from any origin, nosniff, HSTS, no active content',
          corsBehavior: {
            accessControlAllowCredentials: false,
            accessControlAllowHeaders: ['*'],
            accessControlAllowMethods: ['GET', 'HEAD'],
            accessControlAllowOrigins: ['*'],
            originOverride: true,
          },
          securityHeadersBehavior: {
            contentTypeOptions: { override: true },
            strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
            contentSecurityPolicy: { contentSecurityPolicy: "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", override: true },
            frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
            referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
          },
        }),
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });
    const thumbnailsBaseUrl = `https://${thumbnailsCdn.distributionDomainName}`;

    // =====================
    // Lambda Functions
    // =====================

    /** More memory = more CPU: bcrypt cost 12 takes ~0.3 s at 1 GB, several seconds at 256 MB. */
    const HASH_MEMORY = 1024;

    const commonLambdaProps = {
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        USERS_TABLE: this.usersTable.tableName,
        PROJECTS_TABLE: this.projectsTable.tableName,
        SECURITY_TABLE: securityTable.tableName,
        // Either the SSM parameter name (read at cold start) or the secret itself
        ...(jwtSecretParameterName ? { JWT_SECRET_PARAM: jwtSecretParameterName } : { JWT_SECRET: jwtSecret as string }),
        PUBLIC_INDEX,
        POPULAR_INDEX: enablePopularIndex ? POPULAR_INDEX : '',
        USER_PUBLIC_INDEX: enableUserPublicIndex ? USER_PUBLIC_INDEX : '',
        THUMBS_BUCKET: thumbnailsBucket.bucketName,
        THUMBS_BASE_URL: thumbnailsBaseUrl,
        THUMBS_DISTRIBUTION_ID: thumbnailsCdn.distributionId,
        ALLOWED_ORIGINS: allowedOrigins.join(','),
      } as Record<string, string>,
      bundling: {
        minify: true,
        sourceMap: true,
        // SSM / CloudFront clients come from the Node.js 20 runtime's bundled AWS SDK v3
        externalModules: ['aws-sdk', '@aws-sdk/client-ssm', '@aws-sdk/client-cloudfront'],
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    };

    /** Functions that send mail: the sender and the site URL for links. */
    const mailEnvironment = {
      ...commonLambdaProps.environment,
      FROM_EMAIL: fromEmail,
      FRONTEND_URL: frontendUrl,
    };

    // Auth functions
    const registerFn = new NodejsFunction(this, 'RegisterFunction', {
      ...commonLambdaProps,
      memorySize: HASH_MEMORY, // bcrypt cost 12
      entry: 'lambda/auth/register.ts',
      handler: 'handler',
      environment: {
        ...mailEnvironment,
        SIGNUP_VERIFICATION: signupEmailVerification ? 'required' : 'off',
      },
    });

    // Email-verification sign-up: opening the link creates the account
    const verifyEmailFn = new NodejsFunction(this, 'VerifyEmailFunction', {
      ...commonLambdaProps,
      entry: 'lambda/auth/verify-email.ts',
      handler: 'handler',
    });

    const resendVerificationFn = new NodejsFunction(this, 'ResendVerificationFunction', {
      ...commonLambdaProps,
      entry: 'lambda/auth/resend-verification.ts',
      handler: 'handler',
      environment: mailEnvironment,
    });

    const loginFn = new NodejsFunction(this, 'LoginFunction', {
      ...commonLambdaProps,
      memorySize: HASH_MEMORY, // bcrypt cost 12
      entry: 'lambda/auth/login.ts',
      handler: 'handler',
    });

    const verifyFn = new NodejsFunction(this, 'VerifyFunction', {
      ...commonLambdaProps,
      entry: 'lambda/auth/verify.ts',
      handler: 'handler',
    });

    const requestPasswordResetFn = new NodejsFunction(this, 'RequestPasswordResetFunction', {
      ...commonLambdaProps,
      entry: 'lambda/auth/request-password-reset.ts',
      handler: 'handler',
      environment: mailEnvironment,
    });

    const resetPasswordFn = new NodejsFunction(this, 'ResetPasswordFunction', {
      ...commonLambdaProps,
      memorySize: HASH_MEMORY, // bcrypt cost 12
      entry: 'lambda/auth/reset-password.ts',
      handler: 'handler',
    });

    // Project functions
    const listProjectsFn = new NodejsFunction(this, 'ListProjectsFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/list.ts',
      handler: 'handler',
    });

    const getProjectFn = new NodejsFunction(this, 'GetProjectFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/get.ts',
      handler: 'handler',
    });

    const saveProjectFn = new NodejsFunction(this, 'SaveProjectFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/save.ts',
      handler: 'handler',
    });

    const updateProjectFn = new NodejsFunction(this, 'UpdateProjectFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/update.ts',
      handler: 'handler',
    });

    const deleteProjectFn = new NodejsFunction(this, 'DeleteProjectFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/delete.ts',
      handler: 'handler',
    });

    const toggleVisibilityFn = new NodejsFunction(this, 'ToggleVisibilityFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/toggle-visibility.ts',
      handler: 'handler',
    });

    // Community functions
    const publicProjectsFn = new NodejsFunction(this, 'PublicProjectsFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/public.ts',
      handler: 'handler',
    });

    const recordViewFn = new NodejsFunction(this, 'RecordViewFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/view.ts',
      handler: 'handler',
    });

    const thumbnailFn = new NodejsFunction(this, 'ThumbnailUploadFunction', {
      ...commonLambdaProps,
      entry: 'lambda/projects/thumbnail.ts',
      handler: 'handler',
    });

    const getUserFn = new NodejsFunction(this, 'GetUserFunction', {
      ...commonLambdaProps,
      entry: 'lambda/users/get.ts',
      handler: 'handler',
    });

    const updateMeFn = new NodejsFunction(this, 'UpdateMeFunction', {
      ...commonLambdaProps,
      entry: 'lambda/users/update-me.ts',
      handler: 'handler',
    });

    const allFns = [
      registerFn, loginFn, verifyFn, requestPasswordResetFn, resetPasswordFn, listProjectsFn, getProjectFn,
      saveProjectFn, updateProjectFn, deleteProjectFn, toggleVisibilityFn, publicProjectsFn, recordViewFn,
      thumbnailFn, getUserFn, updateMeFn, verifyEmailFn, resendVerificationFn,
    ];

    // Every authenticated request reads the user (tokenVersion check, current username)
    for (const fn of allFns) this.usersTable.grantReadData(fn);
    // Writes: registration, login (generated usernames, rehash), resets (password, tokenVersion),
    // project quota (save / delete), profile (username, tokenVersion)
    // (verify-email creates the account and claims its username)
    for (const fn of [registerFn, loginFn, resetPasswordFn, saveProjectFn, deleteProjectFn, updateMeFn, verifyEmailFn]) {
      this.usersTable.grantReadWriteData(fn);
    }
    // Rate limits, reset tokens, pending sign-ups, view / fork claims
    for (const fn of [registerFn, loginFn, requestPasswordResetFn, resetPasswordFn, saveProjectFn, recordViewFn, verifyEmailFn, resendVerificationFn]) {
      securityTable.grantReadWriteData(fn);
    }

    // SES: only the sender identity (address and its domain), only the functions that mail
    const fromDomain = fromEmail.split('@')[1];
    for (const fn of [requestPasswordResetFn, registerFn, resendVerificationFn]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: [
            Stack.of(this).formatArn({ service: 'ses', resource: 'identity', resourceName: fromEmail }),
            Stack.of(this).formatArn({ service: 'ses', resource: 'identity', resourceName: fromDomain }),
          ],
        })
      );
    }

    if (jwtSecretParameterName) {
      const paramArn = Stack.of(this).formatArn({
        service: 'ssm',
        resource: 'parameter',
        resourceName: jwtSecretParameterName.replace(/^\//, ''),
      });
      for (const fn of allFns) {
        fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [paramArn] }));
        // SecureString with the AWS managed key (aws/ssm), only through SSM
        fn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: ['*'],
          conditions: { StringEquals: { 'kms:ViaService': `ssm.${Stack.of(this).region}.amazonaws.com` } },
        }));
      }
    }

    this.projectsTable.grantReadData(listProjectsFn);
    this.projectsTable.grantReadData(getProjectFn);
    // Save reads the source project of a fork and bumps its fork count
    this.projectsTable.grantReadWriteData(saveProjectFn);
    this.projectsTable.grantReadWriteData(updateProjectFn);
    this.projectsTable.grantReadWriteData(deleteProjectFn);
    this.projectsTable.grantReadWriteData(toggleVisibilityFn);
    this.projectsTable.grantReadData(publicProjectsFn);
    this.projectsTable.grantReadWriteData(recordViewFn);
    this.projectsTable.grantReadWriteData(thumbnailFn);
    this.projectsTable.grantReadData(getUserFn);
    // Renaming a user re-labels the denormalized username on their projects
    this.projectsTable.grantReadWriteData(updateMeFn);

    // Thumbnails: presigned POSTs are signed with the thumbnail function's role.
    // Making a project private (visibility / update) deletes its thumbnail.
    thumbnailsBucket.grantPut(thumbnailFn, 'thumbs/*');
    const thumbDeleters = [thumbnailFn, deleteProjectFn, toggleVisibilityFn, updateProjectFn];
    for (const fn of thumbDeleters) {
      thumbnailsBucket.grantDelete(fn, 'thumbs/*');
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [Stack.of(this).formatArn({ service: 'cloudfront', region: '', resource: 'distribution', resourceName: thumbnailsCdn.distributionId })],
      }));
    }

    // =====================
    // API Gateway
    // =====================

    this.api = new apigateway.RestApi(this, 'PatchToyApi', {
      restApiName: 'PatchToy API',
      description: 'Backend API for PatchToy',
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins.includes('*') ? apigateway.Cors.ALL_ORIGINS : allowedOrigins,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Api-Key'],
        // Bearer tokens only: no cookies, so no credentials
        allowCredentials: false,
      },
      deployOptions: {
        stageName: 'prod',
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
      },
    });

    // Errors produced by API Gateway itself (throttling, 413, missing routes, 5xx)
    // carry CORS headers too, so the browser can read them instead of a CORS failure
    this.api.addGatewayResponse('Default4xx', {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
    });
    this.api.addGatewayResponse('Default5xx', {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: { 'Access-Control-Allow-Origin': "'*'" },
    });

    // Optional: Add API key requirement
    let apiKey: apigateway.IApiKey | undefined;
    let usagePlan: apigateway.UsagePlan | undefined;

    if (requireApiKey) {
      const key = new apigateway.ApiKey(this, 'ApiKey', {
        apiKeyName: 'PatchToyApiKey',
      });
      apiKey = key;

      usagePlan = this.api.addUsagePlan('UsagePlan', {
        name: 'Standard',
        throttle: {
          rateLimit: 100,
          burstLimit: 200,
        },
        quota: {
          limit: 10000,
          period: apigateway.Period.DAY,
        },
      });

      usagePlan.addApiKey(key);
      usagePlan.addApiStage({ stage: this.api.deploymentStage });
    }

    // API routes
    const apiRoot = this.api.root.addResource('api');

    // Auth routes
    const auth = apiRoot.addResource('auth');
    auth.addResource('register').addMethod('POST', new apigateway.LambdaIntegration(registerFn), {
      apiKeyRequired: requireApiKey,
    });
    auth.addResource('login').addMethod('POST', new apigateway.LambdaIntegration(loginFn), {
      apiKeyRequired: requireApiKey,
    });
    auth.addResource('verify').addMethod('GET', new apigateway.LambdaIntegration(verifyFn), {
      apiKeyRequired: requireApiKey,
    });
    auth.addResource('request-password-reset').addMethod('POST', new apigateway.LambdaIntegration(requestPasswordResetFn), {
      apiKeyRequired: requireApiKey,
    });
    auth.addResource('reset-password').addMethod('POST', new apigateway.LambdaIntegration(resetPasswordFn), {
      apiKeyRequired: requireApiKey,
    });
    auth.addResource('verify-email').addMethod('POST', new apigateway.LambdaIntegration(verifyEmailFn), {
      apiKeyRequired: requireApiKey,
    });
    auth.addResource('resend-verification').addMethod('POST', new apigateway.LambdaIntegration(resendVerificationFn), {
      apiKeyRequired: requireApiKey,
    });

    // Projects routes
    const projects = apiRoot.addResource('projects');
    projects.addMethod('GET', new apigateway.LambdaIntegration(listProjectsFn), {
      apiKeyRequired: requireApiKey,
    });
    projects.addMethod('POST', new apigateway.LambdaIntegration(saveProjectFn), {
      apiKeyRequired: requireApiKey,
    });

    // Community feed (static segment wins over {id})
    projects.addResource('public').addMethod('GET', new apigateway.LambdaIntegration(publicProjectsFn), {
      apiKeyRequired: requireApiKey,
    });

    const project = projects.addResource('{id}');
    project.addMethod('GET', new apigateway.LambdaIntegration(getProjectFn), {
      apiKeyRequired: requireApiKey,
    });
    project.addMethod('PUT', new apigateway.LambdaIntegration(updateProjectFn), {
      apiKeyRequired: requireApiKey,
    });
    project.addMethod('DELETE', new apigateway.LambdaIntegration(deleteProjectFn), {
      apiKeyRequired: requireApiKey,
    });

    const visibility = project.addResource('visibility');
    visibility.addMethod('PUT', new apigateway.LambdaIntegration(toggleVisibilityFn), {
      apiKeyRequired: requireApiKey,
    });

    project.addResource('view').addMethod('POST', new apigateway.LambdaIntegration(recordViewFn), {
      apiKeyRequired: requireApiKey,
    });
    project.addResource('thumbnail').addMethod('POST', new apigateway.LambdaIntegration(thumbnailFn), {
      apiKeyRequired: requireApiKey,
    });

    // Users routes ("me" is a reserved username, so the static segment is unambiguous)
    const users = apiRoot.addResource('users');
    users.addResource('me').addMethod('PUT', new apigateway.LambdaIntegration(updateMeFn), {
      apiKeyRequired: requireApiKey,
    });
    users.addResource('{username}').addMethod('GET', new apigateway.LambdaIntegration(getUserFn), {
      apiKeyRequired: requireApiKey,
    });

    // =====================
    // Optional AWS WAF (per-IP rate limits in front of the API)
    // =====================
    if (enableWaf) {
      const visibility = (name: string) => ({ cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: true });
      const webAcl = new wafv2.CfnWebACL(this, 'ApiWebAcl', {
        name: 'PatchToyApiWebAcl',
        scope: 'REGIONAL',
        defaultAction: { allow: {} },
        visibilityConfig: visibility('PatchToyApi'),
        rules: [
          {
            name: 'AuthRateLimit',
            priority: 0,
            action: { block: {} },
            visibilityConfig: visibility('PatchToyAuthRate'),
            statement: {
              rateBasedStatement: {
                limit: wafAuthRateLimit,
                aggregateKeyType: 'IP',
                evaluationWindowSec: 300,
                scopeDownStatement: {
                  byteMatchStatement: {
                    fieldToMatch: { uriPath: {} },
                    positionalConstraint: 'CONTAINS',
                    searchString: '/api/auth/',
                    textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                  },
                },
              },
            },
          },
          {
            name: 'GeneralRateLimit',
            priority: 1,
            action: { block: {} },
            visibilityConfig: visibility('PatchToyGeneralRate'),
            statement: { rateBasedStatement: { limit: wafGeneralRateLimit, aggregateKeyType: 'IP', evaluationWindowSec: 300 } },
          },
        ],
      });
      const stageArn = `arn:${cdk.Aws.PARTITION}:apigateway:${Stack.of(this).region}::/restapis/${this.api.restApiId}/stages/${this.api.deploymentStage.stageName}`;
      const assoc = new wafv2.CfnWebACLAssociation(this, 'ApiWebAclAssociation', { resourceArn: stageArn, webAclArn: webAcl.attrArn });
      assoc.node.addDependency(this.api.deploymentStage);
    }

    // Output API URL
    new CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'PatchToy API Gateway URL',
    });

    new CfnOutput(this, 'ThumbnailsUrl', {
      value: thumbnailsBaseUrl,
      description: 'CloudFront URL serving project thumbnails',
    });

    new CfnOutput(this, 'ThumbnailsBucketName', {
      value: thumbnailsBucket.bucketName,
      description: 'S3 bucket holding project thumbnails',
    });

    if (apiKey) {
      new CfnOutput(this, 'ApiKeyId', {
        value: apiKey.keyId,
        description: 'API Key ID (retrieve value from console)',
      });
    }
  }
}
