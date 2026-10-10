/**
 * 需求 24 — AudioAccessUrlService unit tests
 *
 * 截留 env 防止跨 spec 串味（参照 auth.guard.spec.ts 的 beforeEach/afterEach
 * 模式）。
 */

import {
  AudioAccessUrlService,
  assertAudioAccessModeReady,
} from './audio-access-url.service';

describe('AudioAccessUrlService (需求 24)', () => {
  let service: AudioAccessUrlService;
  let originalMode: string | undefined;
  let originalBase: string | undefined;

  const cosRow = {
    audio_id: 'abc123def456',
    url: 'https://meow-app-1430708523.cos.ap-shanghai.myqcloud.com/audio/example/v1/ab/abc123.mp3',
  };

  beforeEach(() => {
    originalMode = process.env.AUDIO_ACCESS_MODE;
    originalBase = process.env.API_PUBLIC_BASE;
    service = new AudioAccessUrlService();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.AUDIO_ACCESS_MODE;
    } else {
      process.env.AUDIO_ACCESS_MODE = originalMode;
    }
    if (originalBase === undefined) {
      delete process.env.API_PUBLIC_BASE;
    } else {
      process.env.API_PUBLIC_BASE = originalBase;
    }
  });

  describe('getMode', () => {
    it('未设置 AUDIO_ACCESS_MODE → 默认 backend_proxy_stream（II 切换后）', () => {
      delete process.env.AUDIO_ACCESS_MODE;
      expect(service.getMode()).toBe('backend_proxy_stream');
    });

    it('显式 backend_issued_cos_url → 返回 backend_issued_cos_url', () => {
      process.env.AUDIO_ACCESS_MODE = 'backend_issued_cos_url';
      expect(service.getMode()).toBe('backend_issued_cos_url');
    });

    it('显式 backend_proxy_stream → 返回 backend_proxy_stream', () => {
      process.env.AUDIO_ACCESS_MODE = 'backend_proxy_stream';
      expect(service.getMode()).toBe('backend_proxy_stream');
    });

    it('非法值 → fallback 默认 backend_proxy_stream（不抛错）', () => {
      process.env.AUDIO_ACCESS_MODE = 'something_bogus';
      expect(service.getMode()).toBe('backend_proxy_stream');
    });
  });

  describe('resolve', () => {
    it('cos 模式 → 返回 row.url 原值', () => {
      process.env.AUDIO_ACCESS_MODE = 'backend_issued_cos_url';
      expect(service.resolve(cosRow)).toBe(cosRow.url);
    });

    it('stream 模式 + API_PUBLIC_BASE 已配 → 返回 /audio/stream/<audio_id>', () => {
      process.env.AUDIO_ACCESS_MODE = 'backend_proxy_stream';
      process.env.API_PUBLIC_BASE = 'https://api.meow.com/api/v1';
      expect(service.resolve(cosRow)).toBe(
        'https://api.meow.com/api/v1/audio/stream/abc123def456',
      );
    });

    it('stream 模式 + API_PUBLIC_BASE 带尾斜杠 → 不出现双斜杠', () => {
      process.env.AUDIO_ACCESS_MODE = 'backend_proxy_stream';
      process.env.API_PUBLIC_BASE = 'https://api.meow.com/api/v1/';
      expect(service.resolve(cosRow)).toBe(
        'https://api.meow.com/api/v1/audio/stream/abc123def456',
      );
    });

    it('stream 模式 + 未配 API_PUBLIC_BASE → 回落相对路径 /api/v1', () => {
      process.env.AUDIO_ACCESS_MODE = 'backend_proxy_stream';
      delete process.env.API_PUBLIC_BASE;
      expect(service.resolve(cosRow)).toBe('/api/v1/audio/stream/abc123def456');
    });

    it('未设置 AUDIO_ACCESS_MODE（默认）→ 返回 stream URL（II 切换后行为）', () => {
      delete process.env.AUDIO_ACCESS_MODE;
      process.env.API_PUBLIC_BASE = 'https://api.miaory.chat/api/v1';
      expect(service.resolve(cosRow)).toBe(
        'https://api.miaory.chat/api/v1/audio/stream/abc123def456',
      );
    });
  });
});

describe('assertAudioAccessModeReady (需求 24 II)', () => {
  const COS_KEYS = ['COS_REGION', 'COS_BUCKET', 'COS_SECRET_ID', 'COS_SECRET_KEY'];
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    snapshot.AUDIO_ACCESS_MODE = process.env.AUDIO_ACCESS_MODE;
    for (const k of COS_KEYS) snapshot[k] = process.env[k];
    for (const k of COS_KEYS) delete process.env[k];
  });

  afterEach(() => {
    if (snapshot.AUDIO_ACCESS_MODE === undefined) {
      delete process.env.AUDIO_ACCESS_MODE;
    } else {
      process.env.AUDIO_ACCESS_MODE = snapshot.AUDIO_ACCESS_MODE;
    }
    for (const k of COS_KEYS) {
      if (snapshot[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = snapshot[k];
      }
    }
  });

  function fillAllCos(): void {
    process.env.COS_REGION = 'ap-shanghai';
    process.env.COS_BUCKET = 'test-bucket';
    process.env.COS_SECRET_ID = 'test-id';
    process.env.COS_SECRET_KEY = 'test-key';
  }

  it('cos 模式（显式）→ 不检查 COS env，no throw', () => {
    process.env.AUDIO_ACCESS_MODE = 'backend_issued_cos_url';
    // 全部 COS env 都没设
    expect(() => assertAudioAccessModeReady()).not.toThrow();
  });

  it('stream 模式（显式）+ 全配齐 → no throw', () => {
    process.env.AUDIO_ACCESS_MODE = 'backend_proxy_stream';
    fillAllCos();
    expect(() => assertAudioAccessModeReady()).not.toThrow();
  });

  it('默认（未设 AUDIO_ACCESS_MODE = stream）+ 全配齐 → no throw', () => {
    delete process.env.AUDIO_ACCESS_MODE;
    fillAllCos();
    expect(() => assertAudioAccessModeReady()).not.toThrow();
  });

  it('stream 模式 + 缺 COS_SECRET_KEY → throw，错误消息列出该 key', () => {
    process.env.AUDIO_ACCESS_MODE = 'backend_proxy_stream';
    fillAllCos();
    delete process.env.COS_SECRET_KEY;
    expect(() => assertAudioAccessModeReady()).toThrow(/COS_SECRET_KEY/);
  });

  it('stream 模式 + 全缺 → throw，错误消息列出 4 个 key', () => {
    process.env.AUDIO_ACCESS_MODE = 'backend_proxy_stream';
    // 所有 COS_* 都已被 beforeEach 删掉
    expect(() => assertAudioAccessModeReady()).toThrow(
      /COS_REGION.*COS_BUCKET.*COS_SECRET_ID.*COS_SECRET_KEY/,
    );
  });

  it('默认（未设）+ 缺凭证 → throw（保证生产忘配 secret 不会静默启动）', () => {
    delete process.env.AUDIO_ACCESS_MODE;
    // 所有 COS_* 都已被 beforeEach 删掉
    expect(() => assertAudioAccessModeReady()).toThrow(
      /AUDIO_ACCESS_MODE=backend_proxy_stream/,
    );
  });
});
