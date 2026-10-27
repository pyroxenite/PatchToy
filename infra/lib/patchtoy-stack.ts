import { AssetHashType, DockerImage, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface PatchToyStackProps extends StackProps {
  hostedZoneId: string;
  zoneName: string;
  /** optional subdomain (e.g. 'app' or 'www'). Leave blank for apex */
  siteSubdomain?: string;
  /**
   * CSP sources, narrower than the defaults once the backend outputs are known
   * (RELEASE.md): the API origin, the thumbnails CDN origin and the S3 upload origin.
   */
  cspApiOrigins?: string[];
  cspThumbnailOrigins?: string[];
  cspUploadOrigins?: string[];

  /**
   * Social link previews (ENABLE_SOCIAL_PREVIEWS, off by default): a Lambda@Edge
   * origin-request function on `/p/*` and `/u/*` returns index.html with Open Graph /
   * Twitter tags of the project or user (infra/lambda/edge/social-preview.ts). Lambda@Edge
   * lives in us-east-1: CDK deploys it in an extra stack there (`cdk bootstrap` that
   * region first, see RELEASE.md).
   */
  enableSocialPreviews?: boolean;
  socialPreviews?: SocialPreviewSettings;
}

export interface SocialPreviewSettings {
  /** Public API base URL (SOCIAL_PREVIEW_API_URL), e.g. https://abc.execute-api.eu-west-3.amazonaws.com/prod. Required. */
  apiUrl?: string;
  /** Previews for unlisted (link-only) projects (SOCIAL_PREVIEWS_UNLISTED, default true). Private projects never get one. */
  unlisted?: boolean;
  /** Allowed og:image origins (default: CSP_THUMBNAIL_ORIGINS when set, else any https URL). */
  imageOrigins?: string[];
  /** og:image for pages without a thumbnail (SOCIAL_PREVIEW_DEFAULT_IMAGE, https URL). */
  defaultImage?: string;
  /** Budget for the API / index.html fetches in ms (default 1500). */
  timeoutMs?: number;
  /** Browser / CDN cache of a page with a preview, seconds (default 300). */
  cacheSeconds?: number;
}

/** Source of the edge function (bundled with esbuild at synth, config compiled in). */
export const SOCIAL_PREVIEW_SOURCE = path.join(__dirname, '..', 'lambda', 'edge', 'social-preview.ts');

/** Monaco editor (loaded on demand from cdnjs with SRI, src/ui/monacoLoader.js). Only this path is allowed. */
export const MONACO_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/';

/** The site's Content-Security-Policy (exported for the synth check). */
export function siteCsp({
  apiOrigins = ['https://*.execute-api.eu-west-3.amazonaws.com'],
  thumbnailOrigins = ['https://*.cloudfront.net'],
  uploadOrigins = ['https://*.s3.eu-west-3.amazonaws.com', 'https://*.s3.amazonaws.com'],
}: { apiOrigins?: string[]; thumbnailOrigins?: string[]; uploadOrigins?: string[] } = {}): string {
  return [
    "default-src 'self'",
    // 'unsafe-eval': JS nodes (new Function). No other script host than the Monaco path:
    // a whole-CDN allowance would let old libraries on it act as CSP bypass gadgets.
    `script-src 'self' 'unsafe-eval' ${MONACO_CDN}`,
    `style-src 'self' 'unsafe-inline' ${MONACO_CDN}`,
    // API + direct thumbnail uploads to S3 (presigned POST) + Monaco's AMD loader
    `connect-src 'self' ${[...apiOrigins, ...uploadOrigins].join(' ')} ${MONACO_CDN}`,
    // Project thumbnails are served by the backend's CloudFront distribution
    `img-src 'self' data: blob: ${thumbnailOrigins.join(' ')}`,
    `font-src 'self' data: ${MONACO_CDN}`,
    "worker-src 'self' blob:",
    // Music files (blob:) and Video URL / audio URL sources (opened only after consent
    // for projects from someone else, src/core/contentGate.js)
    "media-src 'self' blob: data: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ') + ';';
}

export class PatchToyStack extends Stack {
  constructor(scope: Construct, id: string, props: PatchToyStackProps) {
    super(scope, id, props);

    const {
      hostedZoneId, zoneName, siteSubdomain = '', cspApiOrigins, cspThumbnailOrigins, cspUploadOrigins,
      enableSocialPreviews = false, socialPreviews = {},
    } = props;
    if (enableSocialPreviews && !socialPreviews.apiUrl) {
      throw new Error('PatchToyStack: ENABLE_SOCIAL_PREVIEWS needs SOCIAL_PREVIEW_API_URL (the public API base URL, e.g. the backend ApiUrl output)');
    }

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId,
      zoneName,
    });

    const siteDomain = siteSubdomain ? `${siteSubdomain}.${zoneName}` : zoneName;
    const altNames: string[] = [];

    if (siteSubdomain === '') {
      altNames.push(`www.${zoneName}`);
    } else {
      altNames.push(zoneName);
    }

    const certificate = new certificatemanager.DnsValidatedCertificate(this, 'SiteCertificate', {
      domainName: siteDomain,
      subjectAlternativeNames: altNames,
      hostedZone: zone,
      region: 'us-east-1',
    });

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      autoDeleteObjects: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: 'PatchToySecurityHeaders',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: siteCsp({ apiOrigins: cspApiOrigins, thumbnailOrigins: cspThumbnailOrigins, uploadOrigins: cspUploadOrigins }),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        // Never send the full URL (paths, ?query) to other origins
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        // The legacy XSS auditor is deprecated and can itself be abused: disable it (X-XSS-Protection: 0)
        xssProtection: {
          protection: false,
          override: true,
        },
      },
      corsBehavior: {
        accessControlAllowCredentials: false,
        accessControlAllowHeaders: ['*'],
        accessControlAllowMethods: ['GET', 'HEAD', 'OPTIONS'],
        accessControlAllowOrigins: ['*'],
        accessControlExposeHeaders: ['*'],
        originOverride: true,
      },
    });

    const siteOrigin = new origins.S3Origin(siteBucket);

    // Social link previews: /p/<id> and /u/<name> get index.html with Open Graph tags
    // (Lambda@Edge origin-request, so crawlers see them; every visitor gets the same page)
    let additionalBehaviors: Record<string, cloudfront.BehaviorOptions> | undefined;
    if (enableSocialPreviews) {
      const previewFn = socialPreviewFunction(this, {
        apiUrl: String(socialPreviews.apiUrl).replace(/\/+$/, ''),
        siteUrl: `https://${siteDomain}`,
        unlisted: socialPreviews.unlisted !== false,
        imageOrigins: socialPreviews.imageOrigins ?? cspThumbnailOrigins?.filter(o => !o.includes('*')) ?? [],
        defaultImage: socialPreviews.defaultImage,
        timeoutMs: socialPreviews.timeoutMs ?? 1500,
        cacheSeconds: socialPreviews.cacheSeconds ?? 300,
      });
      const previewCache = new cloudfront.CachePolicy(this, 'SocialPreviewCache', {
        comment: 'PatchToy share / user pages with social preview tags (path only)',
        defaultTtl: Duration.minutes(5),
        minTtl: Duration.seconds(0),
        maxTtl: Duration.hours(1),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
        headerBehavior: cloudfront.CacheHeaderBehavior.none(),
        cookieBehavior: cloudfront.CacheCookieBehavior.none(),
        enableAcceptEncodingGzip: true,
        enableAcceptEncodingBrotli: true,
      });
      const previewBehavior: cloudfront.BehaviorOptions = {
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy,
        cachePolicy: previewCache,
        edgeLambdas: [{ functionVersion: previewFn.currentVersion, eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST }],
      };
      additionalBehaviors = { '/p/*': previewBehavior, '/u/*': previewBehavior };
    }

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      certificate,
      domainNames: [siteDomain, ...altNames],
      defaultBehavior: {
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy,
      },
      additionalBehaviors,
      // SPA fallback: /p/<id>, /u/<name> and other app routes have no S3 object, so
      // S3's 403 (and 404) become index.html with 200 and the client router takes over
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
    });

    new route53.ARecord(this, 'SiteAliasRecord', {
      zone,
      recordName: siteSubdomain || undefined,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    if (siteSubdomain === '') {
      new route53.ARecord(this, 'WwwAliasRecord', {
        zone,
        recordName: 'www',
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
    }

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [s3deploy.Source.asset('../dist')],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });
  }
}

/**
 * The social preview Lambda@Edge function. Lambda@Edge has no environment variables, so
 * the settings are compiled into the bundle (esbuild `define`); the asset hash covers the
 * source and the settings, so changing either publishes a new version.
 */
function socialPreviewFunction(scope: Construct, config: Record<string, unknown>): cloudfront.experimental.EdgeFunction {
  const define = { __PREVIEW_CONFIG__: JSON.stringify(config) };
  const source = fs.readFileSync(SOCIAL_PREVIEW_SOURCE, 'utf8');
  return new cloudfront.experimental.EdgeFunction(scope, 'SocialPreviewFunction', {
    description: 'PatchToy social link previews (Open Graph tags for /p/* and /u/*)',
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    memorySize: 128,
    timeout: Duration.seconds(5),
    code: lambda.Code.fromAsset(path.dirname(SOCIAL_PREVIEW_SOURCE), {
      assetHashType: AssetHashType.CUSTOM,
      assetHash: createHash('sha256').update(source).update(define.__PREVIEW_CONFIG__).digest('hex'),
      bundling: {
        image: DockerImage.fromRegistry('public.ecr.aws/sam/build-nodejs20.x'),
        local: {
          tryBundle(outputDir: string) {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const esbuild = require('esbuild');
            esbuild.buildSync({
              entryPoints: [SOCIAL_PREVIEW_SOURCE],
              outfile: path.join(outputDir, 'index.js'),
              bundle: true,
              platform: 'node',
              target: 'node20',
              format: 'cjs',
              define,
              logLevel: 'error',
            });
            return true;
          },
        },
      },
    }),
  });
}
