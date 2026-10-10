/**
 * 需求 24 — Audio stream proxy
 *
 * GET /api/v1/audio/stream/:audio_id
 *
 * 仅在 AUDIO_ACCESS_MODE=backend_proxy_stream 下被 App 访问（meta.url
 * 由 AudioAccessUrlService 指向这里）。即使 mode 是 cos，本 endpoint
 * 仍然挂着；直接访问也合法，只是 App 不会主动来。
 *
 * 鉴权：无（公开接口）。App 用 audioplayers UrlSource / http.get 直接拉
 * meta.url，不带 Bearer token；挂 AuthGuard 会在 AUTH_ENFORCE=true 的
 * 生产环境全量 401。与 audio metadata 接口、/pronunciation 口径一致，
 * 也等价于此前 COS 公网读的可见性。
 *
 * 行为：
 *   1. 查 audio_assets 行（含 status='ready' 校验）
 *   2. 从 audio_assets.url 反解出 COS object key
 *   3. CosStorageService 用 internal endpoint 拉对象流
 *   4. set Content-Type / Content-Length / Cache-Control / ETag
 *   5. stream.pipe(res) —— backpressure-safe，不一次性读进内存
 *
 * 错误：
 *   - 400 audio_id 格式非法
 *   - 404 audio_id 不存在 / status != 'ready' / COS NoSuchKey
 *   - 500 COS 配置缺失 / COS 故障 / url 反解失败
 */

import {
  Controller,
  Get,
  BadRequestException,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { getPool } from '../infrastructure/postgres/client';
import { CosStorageService } from '../services/cos-storage.service';

interface AudioAssetForStream {
  url: string;
  format: string;
  bytes: number;
  audio_version: string;
}

const CONTENT_TYPE_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/opus',
  aac: 'audio/aac',
};

@Controller('audio')
export class AudioStreamController {
  constructor(private readonly cosStorage: CosStorageService) {}

  @Get('stream/:audio_id')
  async stream(
    @Param('audio_id') audioId: string,
    @Res() res: Response,
  ): Promise<void> {
    // audio_assets.id 由 ingest 管线生成（content-addressable hex hash，
    // 32 chars），允许稍宽的允许集防未来扩展，但必须杜绝 path traversal。
    if (!/^[a-zA-Z0-9_\-]{1,128}$/.test(audioId)) {
      throw new BadRequestException({
        error_code: 'INVALID_AUDIO_ID',
        message: 'audio_id contains illegal characters',
      });
    }

    const row = await this.lookupAudio(audioId);
    if (!row) {
      throw new NotFoundException({
        error_code: 'AUDIO_NOT_FOUND',
        audio_id: audioId,
      });
    }

    const objectKey = this.cosStorage.urlToObjectKey(row.url);
    const { stream, contentType, contentLength, etag } =
      await this.cosStorage.getCosObjectStream(objectKey);

    const resolvedContentType =
      contentType || CONTENT_TYPE_BY_FORMAT[row.format] || 'application/octet-stream';
    const resolvedLength =
      contentLength != null && contentLength > 0
        ? contentLength
        : row.bytes > 0
          ? row.bytes
          : undefined;

    res.set({
      'Content-Type': resolvedContentType,
      // 30 天浏览器/中间层缓存。audio_id 是 content-addressable，URL 变
      // 即内容变，长缓存安全。
      'Cache-Control': 'public, max-age=2592000, immutable',
    });
    if (resolvedLength != null) {
      res.set('Content-Length', String(resolvedLength));
    }
    if (etag) {
      res.set('ETag', etag);
    }

    // pipe 是 backpressure-safe，按 chunk 写出，不会全量加载到 heap。
    // 错误处理：上游 stream 错误 → 断开 response（headers 已发，无法
    // 转 500，只能 destroy 让 client 感知到 truncated）。
    stream.on('error', (err: Error) => {
      // 简单 log，避免错误信息泄漏到客户端
      // eslint-disable-next-line no-console
      console.error(`[audio-stream] upstream error audio_id=${audioId} err=${err.message}`);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  }

  private async lookupAudio(audioId: string): Promise<AudioAssetForStream | null> {
    const result = await getPool().query<AudioAssetForStream>(
      `SELECT url, format, bytes, audio_version
       FROM audio_assets
       WHERE id = $1 AND status = 'ready'
       LIMIT 1`,
      [audioId],
    );
    return result.rows[0] ?? null;
  }
}
