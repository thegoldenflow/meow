import {
  Controller,
  Get,
  BadRequestException,
  InternalServerErrorException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CosStorageService } from '../services/cos-storage.service';
import { AudioAccessUrlService } from '../services/audio-access-url.service';

/**
 * Pronunciation controller — 单词 WAV 发音。
 *
 * GET /api/v1/pronunciation/:word?locale=en-US&voice=am_michael
 *
 * COS object key 约定：
 *   pronunciation/{locale}/{voice}/v1/{firstLetter}/{word}.wav
 *
 * 行为按 AUDIO_ACCESS_MODE 切换（需求 24，与 audio-assets 同源开关）：
 *
 *   - 'backend_issued_cos_url'（兼容模式）：
 *     302 redirect 到 `${PRONUNCIATION_CDN_ORIGIN}/<key>`，mobile `http`
 *     包默认 maxRedirects=5 自动跟随，client 代码不变。
 *
 *   - 'backend_proxy_stream'（默认，自 v0.2）：
 *     服务端用 CosStorageService 走 internal endpoint 拉 WAV，stream
 *     回传给 App。COS 公网下行流量降为 0。
 *
 * Validation（保留 PR-A 防御 path traversal）：
 *   - word:   /^[a-z][a-z0-9'\-]{0,59}$/
 *   - locale: /^[A-Za-z\-]{1,16}$/
 *   - voice:  /^[a-z_]{1,32}$/
 *
 * Errors:
 *   - 400 BadRequest      → invalid word/locale/voice format
 *   - 404 NotFound        → COS NoSuchKey（mode=stream 时）/ 跟随 302 后 COS 404
 *   - 500 InternalError   → 服务端配置缺失 / COS 故障
 */
@Controller('pronunciation')
export class PronunciationController {
  constructor(
    private readonly cosStorage: CosStorageService,
    private readonly audioAccessUrl: AudioAccessUrlService,
  ) {}

  @Get(':word')
  async getAudio(
    @Param('word') word: string,
    @Query('locale') locale = 'en-US',
    @Query('voice') voice = 'am_michael',
    @Res() res: Response,
  ): Promise<void> {
    const normalized = word.toLowerCase().trim();

    if (!/^[a-z][a-z0-9'\-]{0,59}$/.test(normalized)) {
      throw new BadRequestException('Invalid word');
    }
    if (!/^[A-Za-z\-]{1,16}$/.test(locale)) {
      throw new BadRequestException('Invalid locale');
    }
    if (!/^[a-z_]{1,32}$/.test(voice)) {
      throw new BadRequestException('Invalid voice');
    }

    const objectKey = `pronunciation/${locale}/${voice}/v1/${normalized[0]}/${normalized}.wav`;

    if (this.audioAccessUrl.getMode() === 'backend_proxy_stream') {
      await this.streamFromCos(objectKey, res);
      return;
    }

    // 兼容模式：302 → COS public
    const cdnOrigin = process.env.PRONUNCIATION_CDN_ORIGIN;
    if (!cdnOrigin) {
      throw new InternalServerErrorException({
        error: 'PRONUNCIATION_CDN_ORIGIN not configured on server',
      });
    }
    const origin = cdnOrigin.replace(/\/+$/, '');
    res.redirect(302, `${origin}/${objectKey}`);
  }

  private async streamFromCos(objectKey: string, res: Response): Promise<void> {
    const { stream, contentType, contentLength, etag } =
      await this.cosStorage.getCosObjectStream(objectKey);

    res.set({
      'Content-Type': contentType || 'audio/wav',
      'Cache-Control': 'public, max-age=2592000, immutable',
    });
    if (contentLength != null && contentLength > 0) {
      res.set('Content-Length', String(contentLength));
    }
    if (etag) {
      res.set('ETag', etag);
    }

    stream.on('error', (err: Error) => {
      // eslint-disable-next-line no-console
      console.error(`[pronunciation] upstream error key=${objectKey} err=${err.message}`);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  }
}
