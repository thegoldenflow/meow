/**
 * 需求 24 — PronunciationController mode 切换测试
 *
 * 覆盖：
 *   - mode=backend_issued_cos_url (默认): res.redirect(302, COS URL)（现状）
 *   - mode=backend_proxy_stream: 调 CosStorageService.getCosObjectStream + pipe
 *   - 校验仍然在最前面拦（mode 无关）
 */

import { BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { Readable } from 'stream';

import { PronunciationController } from './pronunciation.controller';
import { CosStorageService } from '../services/cos-storage.service';
import { AudioAccessUrlService } from '../services/audio-access-url.service';

function makeRes() {
  const setCalls: Array<Record<string, string>> = [];
  const redirects: Array<{ status: number; url: string }> = [];
  const res: any = {
    headersSent: false,
    set(headers: Record<string, string> | string, value?: string) {
      if (typeof headers === 'string') {
        setCalls.push({ [headers]: value ?? '' });
      } else {
        setCalls.push(headers);
      }
      return res;
    },
    redirect(status: number, url: string) {
      redirects.push({ status, url });
      return res;
    },
    status() {
      return res;
    },
    end() {
      return res;
    },
    destroy() {
      return res;
    },
  };
  return { res, setCalls, redirects };
}

function makeCos(): CosStorageService {
  return {
    urlToObjectKey: jest.fn(),
    getCosObjectStream: jest.fn(),
  } as unknown as CosStorageService;
}

describe('PronunciationController (需求 24)', () => {
  let originalMode: string | undefined;
  let originalOrigin: string | undefined;

  beforeEach(() => {
    originalMode = process.env.AUDIO_ACCESS_MODE;
    originalOrigin = process.env.PRONUNCIATION_CDN_ORIGIN;
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.AUDIO_ACCESS_MODE;
    } else {
      process.env.AUDIO_ACCESS_MODE = originalMode;
    }
    if (originalOrigin === undefined) {
      delete process.env.PRONUNCIATION_CDN_ORIGIN;
    } else {
      process.env.PRONUNCIATION_CDN_ORIGIN = originalOrigin;
    }
  });

  describe('校验（mode 无关）', () => {
    it('非法 word → 400', async () => {
      const controller = new PronunciationController(makeCos(), new AudioAccessUrlService());
      const { res } = makeRes();
      await expect(
        controller.getAudio('1bad', 'en-US', 'am_michael', res),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('非法 locale → 400', async () => {
      const controller = new PronunciationController(makeCos(), new AudioAccessUrlService());
      const { res } = makeRes();
      await expect(
        controller.getAudio('abandon', 'zh_CN!', 'am_michael', res),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('非法 voice → 400', async () => {
      const controller = new PronunciationController(makeCos(), new AudioAccessUrlService());
      const { res } = makeRes();
      await expect(
        controller.getAudio('abandon', 'en-US', 'BAD-VOICE', res),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('mode = backend_issued_cos_url (默认 / 兼容模式)', () => {
    it('合法请求 → 302 redirect 到 COS public URL', async () => {
      process.env.AUDIO_ACCESS_MODE = 'backend_issued_cos_url';
      process.env.PRONUNCIATION_CDN_ORIGIN = 'https://bucket.cos.ap-shanghai.myqcloud.com';
      const controller = new PronunciationController(makeCos(), new AudioAccessUrlService());
      const { res, redirects } = makeRes();

      await controller.getAudio('abandon', 'en-US', 'am_michael', res);

      expect(redirects).toEqual([
        {
          status: 302,
          url: 'https://bucket.cos.ap-shanghai.myqcloud.com/pronunciation/en-US/am_michael/v1/a/abandon.wav',
        },
      ]);
    });

    it('PRONUNCIATION_CDN_ORIGIN 缺失 → 500', async () => {
      process.env.AUDIO_ACCESS_MODE = 'backend_issued_cos_url';
      delete process.env.PRONUNCIATION_CDN_ORIGIN;
      const controller = new PronunciationController(makeCos(), new AudioAccessUrlService());
      const { res } = makeRes();
      await expect(
        controller.getAudio('abandon', 'en-US', 'am_michael', res),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

  });

  describe('mode = backend_proxy_stream（默认，自 II 起）', () => {
    it('未设置 AUDIO_ACCESS_MODE → 走 stream 路径（不再 302）', async () => {
      delete process.env.AUDIO_ACCESS_MODE;
      const fakeStream = Readable.from(Buffer.from('wav-bytes'));
      jest.spyOn(fakeStream, 'pipe').mockImplementation((dest: any) => dest);
      const cos = makeCos();
      (cos.getCosObjectStream as jest.Mock).mockResolvedValue({
        stream: fakeStream,
        contentType: 'audio/wav',
        contentLength: 42,
        etag: undefined,
      });
      const controller = new PronunciationController(cos, new AudioAccessUrlService());
      const { res, redirects } = makeRes();

      await controller.getAudio('abandon', 'en-US', 'am_michael', res);

      expect(redirects).toEqual([]);
      expect(cos.getCosObjectStream).toHaveBeenCalledWith(
        'pronunciation/en-US/am_michael/v1/a/abandon.wav',
      );
    });

    it('合法请求 → 调 CosStorageService stream + pipe', async () => {
      process.env.AUDIO_ACCESS_MODE = 'backend_proxy_stream';
      const fakeStream = Readable.from(Buffer.from('wav-bytes'));
      const pipeSpy = jest
        .spyOn(fakeStream, 'pipe')
        .mockImplementation((dest: any) => dest);
      const cos = makeCos();
      (cos.getCosObjectStream as jest.Mock).mockResolvedValue({
        stream: fakeStream,
        contentType: 'audio/wav',
        contentLength: 42,
        etag: '"wav-etag"',
      });
      const controller = new PronunciationController(cos, new AudioAccessUrlService());
      const { res, setCalls, redirects } = makeRes();

      await controller.getAudio('abandon', 'en-US', 'am_michael', res);

      // 用正确 COS object key 调用
      expect(cos.getCosObjectStream).toHaveBeenCalledWith(
        'pronunciation/en-US/am_michael/v1/a/abandon.wav',
      );
      // 没有 302
      expect(redirects).toEqual([]);
      // pipe 调到 res
      expect(pipeSpy).toHaveBeenCalledWith(res);

      const flat: Record<string, string> = {};
      for (const c of setCalls) Object.assign(flat, c);
      expect(flat['Content-Type']).toBe('audio/wav');
      expect(flat['Content-Length']).toBe('42');
      expect(flat['Cache-Control']).toContain('public');
      expect(flat['ETag']).toBe('"wav-etag"');
    });

    it('CosStorageService 缺 contentType → 默认 audio/wav', async () => {
      process.env.AUDIO_ACCESS_MODE = 'backend_proxy_stream';
      const fakeStream = Readable.from(Buffer.from('x'));
      jest.spyOn(fakeStream, 'pipe').mockImplementation((dest: any) => dest);
      const cos = makeCos();
      (cos.getCosObjectStream as jest.Mock).mockResolvedValue({
        stream: fakeStream,
        contentType: undefined,
        contentLength: undefined,
        etag: undefined,
      });
      const controller = new PronunciationController(cos, new AudioAccessUrlService());
      const { res, setCalls } = makeRes();

      await controller.getAudio('abandon', 'en-US', 'am_michael', res);

      const flat: Record<string, string> = {};
      for (const c of setCalls) Object.assign(flat, c);
      expect(flat['Content-Type']).toBe('audio/wav');
    });
  });
});
