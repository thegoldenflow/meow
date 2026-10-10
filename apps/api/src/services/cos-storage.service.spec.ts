/**
 * 需求 24 — CosStorageService unit tests
 *
 * 只测 urlToObjectKey（纯函数 + 易边界出错）。getCosObjectStream 涉
 * 及真 COS / 网络，由 controller 的 mock-injection 测试覆盖。
 */

import { InternalServerErrorException } from '@nestjs/common';
import { CosStorageService } from './cos-storage.service';

describe('CosStorageService.urlToObjectKey (需求 24)', () => {
  const service = new CosStorageService();

  it('标准 COS URL → 去掉 host + 前导斜杠', () => {
    expect(
      service.urlToObjectKey(
        'https://meow-app-1430708523.cos.ap-shanghai.myqcloud.com/audio/example/v1/ab/abc123.mp3',
      ),
    ).toBe('audio/example/v1/ab/abc123.mp3');
  });

  it('深层路径 → 完整保留', () => {
    expect(
      service.urlToObjectKey(
        'https://bucket.cos.ap-shanghai.myqcloud.com/pronunciation/en-US/am_michael/v1/a/abandon.wav',
      ),
    ).toBe('pronunciation/en-US/am_michael/v1/a/abandon.wav');
  });

  it('http 也支持', () => {
    expect(
      service.urlToObjectKey('http://bucket.cos.ap-shanghai.myqcloud.com/x/y.mp3'),
    ).toBe('x/y.mp3');
  });

  it('多个前导斜杠 → 全去掉', () => {
    // URL 类规范化会把 /// 折成 //，但保险起见。
    expect(
      service.urlToObjectKey('https://bucket.cos.ap-shanghai.myqcloud.com//abc.mp3'),
    ).toBe('abc.mp3');
  });

  it('pathname 为空 → 抛 500', () => {
    expect(() =>
      service.urlToObjectKey('https://bucket.cos.ap-shanghai.myqcloud.com/'),
    ).toThrow(InternalServerErrorException);
  });

  it('非法 URL → 抛 500', () => {
    expect(() => service.urlToObjectKey('not-a-url')).toThrow(
      InternalServerErrorException,
    );
  });
});
