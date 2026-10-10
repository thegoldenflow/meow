/**
 * 需求 24 — CosStorageService
 *
 * 封装腾讯云 COS 对象读取。**internal endpoint 优先**：生产环境服务
 * 部署在腾讯云 VPC 内，走 internal endpoint 不计公网下行流量；本地
 * dev / staging 若未配 internal endpoint，则 fallback 到 public endpoint
 * （腾讯云 S3 兼容接口）。
 *
 * 与 apps/api/scripts/cos-sync-helper.ts 的关系：
 *   - cos-sync-helper 是**写**方向（PutObject 上传），在 build/ingest
 *     管线里跑，使用 public endpoint，凭证来自 scripts/content_pipeline/.env
 *   - 本 service 是**读**方向（GetObject 流式拉取），在 runtime API
 *     里跑，使用 internal endpoint，凭证来自 server 进程 env
 *
 * 关键约束：
 *   - 返回 Readable stream，**不一次性读进内存**（pipe 到 res 即可）
 *   - 不暴露 COS object key / bucket / region / secret 给前端
 *   - NoSuchKey / 网络错误由调用方映射到 HTTP 状态码（避免错误信息泄漏 bucket）
 */

import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'stream';

export interface CosObjectStream {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
  etag?: string;
}

@Injectable()
export class CosStorageService {
  private readonly logger = new Logger(CosStorageService.name);
  private client: S3Client | null = null;
  private bucket: string | null = null;

  /**
   * 拉取 COS 对象的可读流。失败映射：
   *   - NoSuchKey → NotFoundException
   *   - 配置缺失 → InternalServerErrorException（不应该到 runtime；fail-fast）
   *   - 其他网络/权限错误 → InternalServerErrorException（脱敏错误信息）
   */
  async getCosObjectStream(objectKey: string): Promise<CosObjectStream> {
    const { client, bucket } = this.ensureClient();
    try {
      const out = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
      );
      // AWS SDK v3 在 Node.js runtime 下 Body 是 Readable。
      const body = out.Body as Readable | undefined;
      if (!body) {
        throw new InternalServerErrorException({
          error_code: 'COS_EMPTY_BODY',
          message: 'COS returned empty body',
        });
      }
      return {
        stream: body,
        contentType: out.ContentType,
        contentLength: typeof out.ContentLength === 'number' ? out.ContentLength : undefined,
        etag: out.ETag ?? undefined,
      };
    } catch (err: unknown) {
      // S3 NoSuchKey: err.name === 'NoSuchKey' or err.$metadata?.httpStatusCode === 404
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) {
        throw new NotFoundException({
          error_code: 'COS_OBJECT_NOT_FOUND',
          message: 'Audio file not found in storage',
        });
      }
      // 透传已知 HTTP 异常
      if (err instanceof NotFoundException || err instanceof InternalServerErrorException) {
        throw err;
      }
      // 其他错误脱敏：日志记原始 err，response 只给通用消息
      this.logger.error(
        `COS getObject failed: key=${objectKey} name=${e?.name ?? 'unknown'} status=${e?.$metadata?.httpStatusCode ?? 'n/a'}`,
      );
      throw new InternalServerErrorException({
        error_code: 'COS_FETCH_FAILED',
        message: 'Failed to fetch audio from storage',
      });
    }
  }

  /**
   * 把 audio_assets.url（完整 COS URL）解析回 COS object key。
   * `https://meow-app-xxx.cos.ap-shanghai.myqcloud.com/audio/example/v1/ab/abc.mp3`
   * → `audio/example/v1/ab/abc.mp3`
   *
   * 当前 ingest 管线（apps/api/scripts/ingest-audio-assets.ts）把 url
   * 字段写成 `${AUDIO_CDN_ORIGIN}/<object_key>`，所以 pathname 去掉前
   * 导斜杠即可。
   */
  urlToObjectKey(url: string): string {
    try {
      const u = new URL(url);
      const key = u.pathname.replace(/^\/+/, '');
      if (!key) {
        throw new InternalServerErrorException({
          error_code: 'INVALID_AUDIO_URL',
          message: 'Audio URL pathname is empty',
        });
      }
      return key;
    } catch (err) {
      if (err instanceof InternalServerErrorException) throw err;
      throw new InternalServerErrorException({
        error_code: 'INVALID_AUDIO_URL',
        message: 'Audio URL is not a valid URL',
      });
    }
  }

  private ensureClient(): { client: S3Client; bucket: string } {
    if (this.client && this.bucket) {
      return { client: this.client, bucket: this.bucket };
    }
    const region = process.env.COS_REGION;
    const bucket = process.env.COS_BUCKET;
    const secretId = process.env.COS_SECRET_ID;
    const secretKey = process.env.COS_SECRET_KEY;
    // internal 优先；缺失则回落 public（dev 友好）。
    const endpoint =
      process.env.COS_INTERNAL_ENDPOINT ||
      (region ? `https://cos.${region}.myqcloud.com` : undefined);

    if (!region || !bucket || !secretId || !secretKey || !endpoint) {
      throw new InternalServerErrorException({
        error_code: 'COS_CONFIG_MISSING',
        message:
          'COS storage not configured (need COS_REGION, COS_BUCKET, COS_SECRET_ID, COS_SECRET_KEY)',
      });
    }

    this.client = new S3Client({
      region,
      endpoint,
      credentials: { accessKeyId: secretId, secretAccessKey: secretKey },
    });
    this.bucket = bucket;
    return { client: this.client, bucket: this.bucket };
  }
}
