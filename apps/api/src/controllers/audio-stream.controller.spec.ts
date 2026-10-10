/**
 * 需求 24 — AudioStreamController unit tests
 *
 * 不走完整 NestJS e2e（避开真 PG 依赖），用 jest.mock 替掉 pg client
 * 和 CosStorageService 后直接调 controller 方法。覆盖：
 *   - audio_id 格式校验（400）
 *   - row 不存在 → 404
 *   - CosStorageService 抛 NotFoundException → bubble up（已由 service 内部 mock 验证）
 *   - happy path：headers 正确 + stream.pipe(res) 被调用
 *   - 公开接口：不挂 guard
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Readable } from 'stream';

jest.mock('../infrastructure/postgres/client', () => ({
  getPool: jest.fn(),
}));

import { AudioStreamController } from './audio-stream.controller';
import { CosStorageService } from '../services/cos-storage.service';
import { getPool } from '../infrastructure/postgres/client';

const mockedGetPool = getPool as jest.MockedFunction<typeof getPool>;

function makeRes(): {
  res: any;
  setCalls: Array<Record<string, string>>;
  pipeReceived: Readable | null;
} {
  const setCalls: Array<Record<string, string>> = [];
  const pipeReceived: Readable | null = null;
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
  // Readable.pipe 写到 res；用 mock 截获即可
  return {
    res,
    setCalls,
    get pipeReceived() {
      return pipeReceived;
    },
    // 提供给外部判断 pipe 被调用了
  } as any;
}

function makeCosService(overrides?: Partial<CosStorageService>): CosStorageService {
  const svc = {
    urlToObjectKey: jest.fn(
      (url: string) => new URL(url).pathname.replace(/^\/+/, ''),
    ),
    getCosObjectStream: jest.fn(),
  } as unknown as CosStorageService;
  Object.assign(svc, overrides);
  return svc;
}

describe('AudioStreamController (需求 24)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('audio_id 含非法字符 → 400', async () => {
    const controller = new AudioStreamController(makeCosService());
    const { res } = makeRes();
    await expect(
      controller.stream('../etc/passwd', res),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('audio_id 为空 → 400 (Nest 路由前置拦截，但直接调也应抛)', async () => {
    const controller = new AudioStreamController(makeCosService());
    const { res } = makeRes();
    await expect(controller.stream('', res)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('audio_assets 没匹配行 → 404', async () => {
    mockedGetPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
    } as any);
    const controller = new AudioStreamController(makeCosService());
    const { res } = makeRes();
    await expect(
      controller.stream('valid_id_123', res),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('CosStorageService 抛 NotFoundException → bubble up（不被吞）', async () => {
    mockedGetPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            url: 'https://bucket.cos.ap-shanghai.myqcloud.com/audio/x.mp3',
            format: 'mp3',
            bytes: 12345,
            audio_version: 'v1',
          },
        ],
      }),
    } as any);
    const cos = makeCosService();
    (cos.getCosObjectStream as jest.Mock).mockRejectedValue(
      new NotFoundException({ error_code: 'COS_OBJECT_NOT_FOUND' }),
    );
    const controller = new AudioStreamController(cos);
    const { res } = makeRes();
    await expect(
      controller.stream('valid_id_123', res),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('happy path：headers 正确 + pipe 调用', async () => {
    mockedGetPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            url: 'https://bucket.cos.ap-shanghai.myqcloud.com/audio/example/v1/ab/abc.mp3',
            format: 'mp3',
            bytes: 24182,
            audio_version: 'v1',
          },
        ],
      }),
    } as any);

    const fakeStream = Readable.from(Buffer.from('fake-mp3-bytes'));
    // res mock 不是真 Writable，避免 pipe 真执行
    const pipeSpy = jest
      .spyOn(fakeStream, 'pipe')
      .mockImplementation((dest: any) => dest);
    const cos = makeCosService();
    (cos.getCosObjectStream as jest.Mock).mockResolvedValue({
      stream: fakeStream,
      contentType: 'audio/mpeg',
      contentLength: 24182,
      etag: '"abc123etag"',
    });

    const controller = new AudioStreamController(cos);
    const { res, setCalls } = makeRes();
    await controller.stream('valid_id_123', res);

    // pipe 被调到了我们的 res mock
    expect(pipeSpy).toHaveBeenCalledTimes(1);
    expect(pipeSpy).toHaveBeenCalledWith(res);

    // headers 合并查看
    const flatHeaders: Record<string, string> = {};
    for (const call of setCalls) {
      Object.assign(flatHeaders, call);
    }
    expect(flatHeaders['Content-Type']).toBe('audio/mpeg');
    expect(flatHeaders['Content-Length']).toBe('24182');
    expect(flatHeaders['Cache-Control']).toContain('public');
    expect(flatHeaders['Cache-Control']).toContain('immutable');
    expect(flatHeaders['ETag']).toBe('"abc123etag"');

    // 路径反解被调用
    expect(cos.urlToObjectKey).toHaveBeenCalledWith(
      'https://bucket.cos.ap-shanghai.myqcloud.com/audio/example/v1/ab/abc.mp3',
    );
    // 用反解结果调 stream
    expect(cos.getCosObjectStream).toHaveBeenCalledWith(
      'audio/example/v1/ab/abc.mp3',
    );
  });

  it('contentLength 缺失时 fallback 用 row.bytes', async () => {
    mockedGetPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            url: 'https://bucket.cos.ap-shanghai.myqcloud.com/audio/x.mp3',
            format: 'mp3',
            bytes: 999,
            audio_version: 'v1',
          },
        ],
      }),
    } as any);

    const fakeStream = Readable.from(Buffer.from('x'));
    jest.spyOn(fakeStream, 'pipe').mockImplementation((dest: any) => dest);
    const cos = makeCosService();
    (cos.getCosObjectStream as jest.Mock).mockResolvedValue({
      stream: fakeStream,
      contentType: undefined,
      contentLength: undefined,
      etag: undefined,
    });

    const controller = new AudioStreamController(cos);
    const { res, setCalls } = makeRes();
    await controller.stream('valid_id_123', res);

    const flat: Record<string, string> = {};
    for (const c of setCalls) Object.assign(flat, c);
    expect(flat['Content-Length']).toBe('999');
    // format=mp3 → fallback content-type
    expect(flat['Content-Type']).toBe('audio/mpeg');
  });

  it('不挂任何 guard（App 的 UrlSource / http.get 不带 token，挂 AuthGuard 会在 prod 全量 401）', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AudioStreamController)).toBeUndefined();
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AudioStreamController.prototype.stream),
    ).toBeUndefined();
  });
});
