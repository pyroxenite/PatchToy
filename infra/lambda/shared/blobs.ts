/**
 * Thumbnail storage. In AWS: an S3 bucket (private) behind CloudFront, written
 * by the browser through presigned POST uploads. Tests and the mock API install
 * their own implementation with setBlobStore().
 */

export const THUMB_MAX_BYTES = 150 * 1024;
export const THUMB_CONTENT_TYPE = 'image/jpeg';

export interface PresignedUpload {
  /** POST target (multipart/form-data). */
  url: string;
  /** Form fields to send before the `file` field. */
  fields: Record<string, string>;
  maxBytes: number;
}

export interface BlobStore {
  presignUpload(key: string): Promise<PresignedUpload>;
  /** Public URL of a stored object, or null when thumbnails are not configured. */
  publicUrl(key: string | undefined | null): string | null;
  delete(key: string): Promise<void>;
}

class S3BlobStore implements BlobStore {
  private bucket = process.env.THUMBS_BUCKET || '';
  private baseUrl = (process.env.THUMBS_BASE_URL || '').replace(/\/+$/, '');
  private client: any = null;

  private s3() {
    if (!this.client) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { S3Client } = require('@aws-sdk/client-s3');
      this.client = new S3Client({});
    }
    return this.client;
  }

  async presignUpload(key: string): Promise<PresignedUpload> {
    if (!this.bucket) throw new Error('Thumbnail storage is not configured');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
    const { url, fields } = await createPresignedPost(this.s3(), {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['content-length-range', 1, THUMB_MAX_BYTES],
        ['eq', '$Content-Type', THUMB_CONTENT_TYPE],
      ],
      Fields: {
        'Content-Type': THUMB_CONTENT_TYPE,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
      Expires: 300,
    });
    return { url, fields, maxBytes: THUMB_MAX_BYTES };
  }

  publicUrl(key: string | undefined | null): string | null {
    if (!key || !this.baseUrl) return null;
    return `${this.baseUrl}/${key}`;
  }

  async delete(key: string): Promise<void> {
    if (!this.bucket || !key) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    // Objects are cached `immutable` at the edge: purge the path so it stops being served
    const distributionId = process.env.THUMBS_DISTRIBUTION_ID;
    if (distributionId) {
      try {
        // Provided by the Lambda Node.js runtime (marked external in the CDK bundling)
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
        await new CloudFrontClient({}).send(new CreateInvalidationCommand({
          DistributionId: distributionId,
          InvalidationBatch: { CallerReference: `${key}-${Date.now()}`, Paths: { Quantity: 1, Items: [`/${key}`] } },
        }));
      } catch (err: any) {
        console.warn('Thumbnail invalidation failed', err?.name || err);
      }
    }
  }
}

let current: BlobStore | null = null;

export function getBlobStore(): BlobStore {
  if (!current) current = new S3BlobStore();
  return current;
}

export function setBlobStore(store: BlobStore | null): void {
  current = store;
}

/**
 * Thumbnail object key for a project: a new key per upload (CDN caches never go stale),
 * with a random part so a key can't be guessed from the project id and upload time.
 */
export function thumbKeyFor(projectId: string, now = Date.now()): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomBytes } = require('crypto');
  return `thumbs/${projectId}/${now.toString(36)}-${randomBytes(9).toString('base64url')}.jpg`;
}
