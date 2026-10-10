/**
 * 需求 24 — AudioAccessUrlService
 *
 * 单一职责：把 audio_assets 行解析成「最终给前端 App 的 meta.url」。
 * 根据 AUDIO_ACCESS_MODE 在两种模式之间切换：
 *
 *   - 'backend_proxy_stream'（默认，自 2026-05-22 切换）：返回后端
 *     stream 接口 URL（${API_PUBLIC_BASE}/audio/stream/:audio_id）。
 *     App 拉服务端，服务端走 COS internal endpoint 读流转发。
 *     COS 已关闭外网读，这是默认且唯一可用路径。
 *   - 'backend_issued_cos_url'（兼容模式 / 回滚开关）：返回
 *     audio_assets.url 原值（即 COS public URL）。仅在腾讯云控制台
 *     重新打开 COS 外网读后才能正常工作。
 *
 * 设计动机见分支 feature/24-cos-audio-switch 的 plan 文件。
 *
 * 关键约束：
 *   - response shape 不变 —— meta.url 还是 meta.url，前端零感知。
 *   - 模式切换是进程级 env 切换，无需重启（每次调用读 process.env）。
 *   - 不暴露 COS object key / bucket / region / secret 给前端。
 */

import { Injectable } from '@nestjs/common';

export type AudioAccessMode = 'backend_issued_cos_url' | 'backend_proxy_stream';

export const DEFAULT_AUDIO_ACCESS_MODE: AudioAccessMode = 'backend_proxy_stream';

export interface AudioAccessUrlInput {
  /** audio_assets.id (即 metadata 响应里的 audio_id) */
  audio_id: string;
  /** audio_assets.url 原值 (COS public URL) */
  url: string;
}

@Injectable()
export class AudioAccessUrlService {
  /**
   * 返回最终给前端 App 的 meta.url。
   * 调用方：audio-assets.controller.ts 在 response 阶段调用。
   */
  resolve(input: AudioAccessUrlInput): string {
    if (this.getMode() === 'backend_proxy_stream') {
      const base = (process.env.API_PUBLIC_BASE ?? '/api/v1').replace(/\/+$/, '');
      return `${base}/audio/stream/${input.audio_id}`;
    }
    return input.url;
  }

  /**
   * 读当前 AUDIO_ACCESS_MODE。无效值或未设置 → 默认
   * 'backend_proxy_stream'（COS 外网读已关闭，必须走代理）。
   */
  getMode(): AudioAccessMode {
    const raw = process.env.AUDIO_ACCESS_MODE;
    if (raw === 'backend_issued_cos_url') return 'backend_issued_cos_url';
    if (raw === 'backend_proxy_stream') return 'backend_proxy_stream';
    return DEFAULT_AUDIO_ACCESS_MODE;
  }
}

/**
 * 需求 24 增量改动 II — 启动时 fail-fast 守门。
 *
 * 若 AUDIO_ACCESS_MODE=backend_proxy_stream（含默认走到这里）且任何
 * 必需的 COS 凭证缺失，立刻抛错让进程拒绝启动；防止「运维忘配 secret
 * → 进程起得来 → 第一个真实音频请求 500」的延迟错误。
 *
 * 参考 `assertProductionAuthEnforce()`（apps/api/src/auth/auth.guard.ts:92）
 * 的成熟 fail-fast 模式。在 `main.ts` bootstrap 开头调用。
 *
 * 注意：COS_INTERNAL_ENDPOINT 不在 required 列表里 ——
 *   - 本地 dev 通常不在 VPC，CosStorageService 会 fallback 到
 *     `https://cos.${region}.myqcloud.com` public endpoint。
 *   - 生产应在 docker-compose.prod.yml 显式给值（有 default
 *     `cos-internal.ap-shanghai.tencentcos.cn`），不需要在这里阻塞。
 */
export function assertAudioAccessModeReady(): void {
  const mode = (process.env.AUDIO_ACCESS_MODE ?? DEFAULT_AUDIO_ACCESS_MODE) as
    | AudioAccessMode
    | string;
  if (mode !== 'backend_proxy_stream') return;
  const required = ['COS_REGION', 'COS_BUCKET', 'COS_SECRET_ID', 'COS_SECRET_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `[audio] AUDIO_ACCESS_MODE=backend_proxy_stream but COS env missing: ${missing.join(', ')}. ` +
        'Set them in deploy/.env (server) or shell env (dev), or switch ' +
        'AUDIO_ACCESS_MODE=backend_issued_cos_url after re-opening COS public read.',
    );
  }
}
