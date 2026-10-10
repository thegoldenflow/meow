import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { Pool } from 'pg';
import { getPool } from '../infrastructure/postgres/client';
import { AudioAccessUrlService } from '../services/audio-access-url.service';

/**
 * Audio Assets — resolve example AND word audio metadata for the App.
 *
 * Two endpoints, one storage layer (audio_assets table; target_kind column
 * distinguishes 'example' vs 'word'):
 *
 *   GET /api/v1/examples/:stable_id/audio?voice=&format=&audio_version=
 *   GET /api/v1/words/:word_id/audio?voice=&format=&audio_version=
 *
 * Both share `lookupAudioAsset()` — the only difference is the param
 * shape and validation (24-hex stable_id vs canonical word_id).
 *
 * Response shape (200):
 *   {
 *     "audio_id": "...",
 *     "url": "http://10.0.2.2:3000/cdn/audio/v1/...",
 *     "checksum_sha256": "...",
 *     "duration_ms": 1985,
 *     "bytes": 24182,
 *     "voice": "af_bella",
 *     "format": "mp3",
 *     "audio_version": "v1"
 *   }
 *
 * Responses:
 *   404 — not found OR status != 'ready' (App should disable play button)
 *   400 — invalid id / voice / format / audio_version
 *
 * The App is contractually forbidden from computing audio_id or assembling
 * URLs (see DB §3.4 / §6.2.2). All hash work happens in the pipeline; this
 * endpoint is the only path the App uses to discover playback URLs.
 */

/** Validate query params shared by both endpoints. */
function validateAudioQuery(
  voice: string,
  format: string,
  audioVersion: string | undefined,
): void {
  if (!/^[a-z0-9_\-]{1,32}$/i.test(voice)) {
    throw new BadRequestException({ error: 'Invalid voice' });
  }
  if (!/^(mp3|opus|aac|wav)$/i.test(format)) {
    throw new BadRequestException({ error: 'Invalid format' });
  }
  if (audioVersion !== undefined && !/^v[0-9]+$/.test(audioVersion)) {
    throw new BadRequestException({
      error: 'Invalid audio_version',
      expected: 'matches ^v[0-9]+$',
    });
  }
}

/** SQL row → public response shape. */
interface AudioAssetRow {
  // Renamed from `id` so the JSON response field is `audio_id` — matches the
  // documented contract above and what the Dart App reads in
  // `AudioMeta.fromJson`. SQL queries below alias `audio_assets.id AS audio_id`.
  audio_id: string;
  url: string;
  checksum_sha256: string;
  duration_ms: number;
  bytes: number;
  voice: string;
  format: string;
  audio_version: string;
}

/**
 * Shared lookup. Returns undefined if no matching ready audio exists.
 *
 * Lookup strategy:
 *   - If audioVersion specified → exact match.
 *   - Else → JOIN content_manifest WHERE is_active=true to prefer the
 *     currently-active package version; fall back to most recently
 *     generated if no manifest match.
 */
async function lookupAudioAsset(
  pool: Pool,
  targetKind: 'example' | 'word',
  targetId: string,
  voice: string,
  format: string,
  audioVersion: string | undefined,
): Promise<AudioAssetRow | undefined> {
  if (audioVersion) {
    const result = await pool.query<AudioAssetRow>(
      `SELECT id AS audio_id, url, checksum_sha256, duration_ms, bytes, voice, format, audio_version
       FROM audio_assets
       WHERE target_kind = $1
         AND target_id = $2
         AND voice = $3
         AND format = $4
         AND audio_version = $5
         AND status = 'ready'
       LIMIT 1`,
      [targetKind, targetId, voice, format, audioVersion],
    );
    return result.rows[0];
  }

  const result = await pool.query<AudioAssetRow>(
    `SELECT a.id AS audio_id, a.url, a.checksum_sha256, a.duration_ms, a.bytes,
            a.voice, a.format, a.audio_version
     FROM audio_assets a
     LEFT JOIN content_manifest m
       ON m.package_kind = 'audio_meta'
       AND m.is_active = true
       AND m.content_version = a.audio_version
     WHERE a.target_kind = $1
       AND a.target_id = $2
       AND a.voice = $3
       AND a.format = $4
       AND a.status = 'ready'
     ORDER BY (m.id IS NOT NULL) DESC, a.generated_at DESC
     LIMIT 1`,
    [targetKind, targetId, voice, format],
  );
  return result.rows[0];
}

/**
 * Examples — content-addressable stable_id (24-hex sha256).
 */
@Controller('examples')
export class AudioAssetsExamplesController {
  constructor(private readonly audioAccessUrl: AudioAccessUrlService) {}

  @Get(':stable_id/audio')
  async getExampleAudio(
    @Param('stable_id') stableId: string,
    @Query('voice') voice = 'af_bella',
    @Query('format') format = 'mp3',
    @Query('audio_version') audioVersion?: string,
  ): Promise<AudioAssetRow> {
    if (!/^[a-f0-9]{24}$/.test(stableId)) {
      throw new BadRequestException({
        error: 'Invalid stable_id format',
        expected: '24 lowercase hex chars',
      });
    }
    validateAudioQuery(voice, format, audioVersion);

    const row = await lookupAudioAsset(
      getPool(),
      'example',
      stableId,
      voice,
      format,
      audioVersion,
    );
    if (!row) {
      throw new NotFoundException({
        error: 'Audio asset not found',
        target_kind: 'example',
        stable_id: stableId,
        voice,
        format,
        ...(audioVersion ? { audio_version: audioVersion } : {}),
      });
    }
    // 需求 24: meta.url 由 AudioAccessUrlService 根据 AUDIO_ACCESS_MODE
    // 决定是 COS public URL（兼容模式）还是后端 stream URL（代理模式）。
    return { ...row, url: this.audioAccessUrl.resolve(row) };
  }
}

/**
 * Words — canonical lowercase word_id (e.g. 'abandon', 'fire-proof').
 *
 * v0.3.0 P2.2: replaces the legacy `/api/v1/pronunciation/{word}` WAV path
 * once Codex pipeline finishes generating word audio. During the
 * transition, mobile WordAudioService can fall back to PronunciationService
 * if this returns 404.
 */
@Controller('words')
export class AudioAssetsWordsController {
  constructor(private readonly audioAccessUrl: AudioAccessUrlService) {}

  @Get(':word_id/audio')
  async getWordAudio(
    @Param('word_id') wordId: string,
    @Query('voice') voice = 'af_bella',
    @Query('format') format = 'mp3',
    @Query('audio_version') audioVersion?: string,
  ): Promise<AudioAssetRow> {
    // Word IDs are normalize_word output: lowercase, allows letters / digits
    // / hyphen / apostrophe / single space / common diacritics. We accept
    // a permissive pattern; the real validation is whether a row exists.
    if (!/^[\p{L}\p{N}\-' ]{1,64}$/u.test(wordId)) {
      throw new BadRequestException({
        error: 'Invalid word_id format',
        expected: '1-64 lowercase letters / digits / hyphens / apostrophes',
      });
    }
    validateAudioQuery(voice, format, audioVersion);

    const row = await lookupAudioAsset(
      getPool(),
      'word',
      wordId,
      voice,
      format,
      audioVersion,
    );
    if (!row) {
      throw new NotFoundException({
        error: 'Audio asset not found',
        target_kind: 'word',
        word_id: wordId,
        voice,
        format,
        ...(audioVersion ? { audio_version: audioVersion } : {}),
      });
    }
    // 需求 24: 见 AudioAssetsExamplesController 同名注释。
    return { ...row, url: this.audioAccessUrl.resolve(row) };
  }
}

// Re-export the legacy alias for backwards compat (old import path).
export { AudioAssetsExamplesController as AudioAssetsController };
