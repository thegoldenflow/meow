# API 变更文档 — 需求 24 Audio Access Mode（COS 公网 ↔ 后端代理 stream 切换）

- **版本：** v0.3（`/audio/stream` 去掉 AuthGuard）
- **日期：** 2026-10-10
- **范围：** 后端 audio metadata / pronunciation / 新增 stream proxy 接口
- **状态：** Code-truth implemented reality（已落地代码 + 默认切到 stream）
- **Base URL：** `/api/v1`
- **鉴权：** 全部 audio 端点（含 `/audio/stream/:audio_id`）均为公开接口，不走 AuthGuard
- **关联分支：** `feature/24-cos-audio-switch`

---

## v0.3 变更记录（2026-10-10）

| 项 | v0.2 | v0.3 |
|---|---|---|
| `/audio/stream/:audio_id` 鉴权 | `@UseGuards(AuthGuard)` | 无（公开） |

**触发原因**：App 播放用 audioplayers `UrlSource(meta.url)`、后台缓存用 `http.get(meta.url)`，两处都不带 Bearer token。`NODE_ENV=production` 强制 `AUTH_ENFORCE=true`（`assertProductionAuthEnforce`），v0.2 的写法在生产会让单词 / 例句音频全量 401，「前端零改动」不成立。

**口径**：与 audio metadata 接口（`/words/:word_id/audio`、`/examples/:stable_id/audio`）和 `/pronunciation/:word` 一致，均不鉴权；也等价于 v0.1 之前 COS 公网读的可见性。

**已知代价**：任何人可经服务端拉音频，消耗服务器公网下行。`audio_id` 为 32 位 content-addressable hash，不易枚举。若需防盗刷，后续另立需求做签名短期 URL（不在本轮范围）。

---

## v0.2 切换记录（2026-05-22）

| 项 | v0.1 | v0.2 |
|---|---|---|
| 默认 `AUDIO_ACCESS_MODE` | `backend_issued_cos_url` | `backend_proxy_stream` |
| 启动 fail-fast | 无 | stream 模式缺 COS 凭证 → 拒绝启动（`assertAudioAccessModeReady`） |
| docker-compose env | 未补全 | `docker-compose.prod.yml` + `docker-compose.yml` + `deploy/server.env.example` 全补齐 |

**触发原因**：腾讯云 COS 已关闭外网读，cos 模式实际已不可用；后端即将打 Docker 部署到腾讯云 ap-shanghai CVM（与 COS 桶同地域），具备走 internal endpoint 的条件。

**对已部署 App 的影响**：无。`meta.url` 仍是合法 URL，App 透明 GET 即可。

**回滚条件**：要回到 `backend_issued_cos_url`，**必须先**在腾讯云控制台重新打开 COS 外网读，否则切回去客户端仍然 403。

---

## 概览

本轮变更引入 **`AUDIO_ACCESS_MODE`** 进程级开关，让所有音频访问的流量路径可灰度切换：

| Mode | 流量路径 | 默认 |
|---|---|---|
| `backend_proxy_stream` | App → 后端 → COS 内网（meta.url 是后端 stream URL；pronunciation 服务端 stream） | ✅ |
| `backend_issued_cos_url` | App → COS 公网（meta.url 是 COS URL；pronunciation 302 → COS）。仅在 COS 外网读打开时可用 | — |

**前端零改动**：App 继续读 `meta.url`、继续跟随 302，对 mode 切换无感知。

---

## 一、新增配置项

### `AUDIO_ACCESS_MODE`
- 类型：`'backend_issued_cos_url' | 'backend_proxy_stream'`
- 默认：`'backend_proxy_stream'`（自 v0.2；任何无效值都 fallback 默认）
- 作用范围：影响 audio metadata 接口返回的 `url` 字段、`/pronunciation/:word` 行为、`/audio/stream/:audio_id` 的有效流量
- **启动 fail-fast**：默认 / 显式 stream 模式下若缺 `COS_REGION/BUCKET/SECRET_ID/SECRET_KEY` 任一个，进程拒绝启动（`apps/api/src/services/audio-access-url.service.ts::assertAudioAccessModeReady`，main.ts 调用）

### `API_PUBLIC_BASE`（仅 stream 模式必填）
- 类型：URL string，含 `/api/v1` 前缀
- 默认：未设置时 fallback 相对路径 `/api/v1`（仅适合同源场景）
- 作用：stream 模式下 `meta.url` 的前缀，必须与移动端 `apiV1Base`（dart-define `API_BASE`）对齐

### COS 服务端访问凭证（仅 stream 模式必填）
| Env | 用途 | 备注 |
|---|---|---|
| `COS_INTERNAL_ENDPOINT` | VPC 内网 endpoint | 例 `https://cos-internal.ap-shanghai.tencentcos.cn`，未设置时 fallback public endpoint |
| `COS_REGION` | 桶 region | 例 `ap-shanghai`，与 `AUDIO_CDN_ORIGIN` 一致 |
| `COS_BUCKET` | 桶名 | 例 `meow-app-1430708523` |
| `COS_SECRET_ID` / `COS_SECRET_KEY` | API 凭证 | 建议只读子账号；**永不**外泄给 App |

完整说明见 `apps/api/.env.example`。

---

## 二、既有接口语义变化（shape 不变）

### 2.1 `GET /examples/:stable_id/audio` / `GET /words/:word_id/audio`

Response shape 完全不变（仍然返回 `audio_id` / `url` / `checksum_sha256` / `duration_ms` / `bytes` / `voice` / `format` / `audio_version`）。

**变化点**：`url` 字段的来源不再恒等于 `audio_assets.url`：

| Mode | `url` 字段值 |
|---|---|
| `backend_issued_cos_url` | `audio_assets.url` 原值（COS public URL） |
| `backend_proxy_stream` | `${API_PUBLIC_BASE}/audio/stream/{audio_id}` |

实现：`apps/api/src/services/audio-access-url.service.ts` → 在 controller response 阶段调用 `audioAccessUrl.resolve(row)` 覆盖 row.url。

### 2.2 `GET /pronunciation/:word`

校验 / 错误码不变（400 invalid word/locale/voice；500 配置缺失）。**行为按 mode 切换**：

| Mode | 行为 |
|---|---|
| `backend_issued_cos_url` | `302 Location: ${PRONUNCIATION_CDN_ORIGIN}/pronunciation/{locale}/{voice}/v1/{firstLetter}/{word}.wav`（现状不变） |
| `backend_proxy_stream` | `200` + WAV 二进制流，`Content-Type: audio/wav`，`Cache-Control: public, max-age=2592000, immutable`，stream pipe（不一次性读进内存） |

实现：`apps/api/src/controllers/pronunciation.controller.ts` 注入 `AudioAccessUrlService.getMode()` + `CosStorageService`。

---

## 三、新增接口

### 3.1 `GET /audio/stream/:audio_id`

后端 stream 代理。仅在 `AUDIO_ACCESS_MODE=backend_proxy_stream` 时被 App 命中（mode=cos 时 App 拿到的 meta.url 不指向这里）。直接访问也合法，行为一致。

#### 鉴权
无（公开接口，v0.3 起）—— 与 audio metadata 接口、`/pronunciation/:word` 口径一致。App 直接用 `UrlSource` / `http.get` 拉 `meta.url`，不带 token。见「v0.3 变更记录」。

#### 请求
| 位置 | 字段 | 类型 | 说明 |
|---|---|---|---|
| Path | `audio_id` | `string`（`/^[a-zA-Z0-9_\-]{1,128}$/`） | `audio_assets.id`（即 audio metadata 接口返回的 `audio_id`） |

#### 响应 `200 OK`
| Header | 说明 |
|---|---|
| `Content-Type` | 优先用 COS 返回的 `ContentType`；fallback 用 `audio_assets.format` 映射（mp3→`audio/mpeg`、wav→`audio/wav`、opus→`audio/opus`、aac→`audio/aac`） |
| `Content-Length` | 优先用 COS 返回的 `ContentLength`；fallback 用 `audio_assets.bytes`（若 > 0） |
| `Cache-Control` | `public, max-age=2592000, immutable`（audio_id 是 content-addressable，URL 变即内容变，长缓存安全） |
| `ETag` | COS 返回的 ETag（若存在） |
| Body | 音频二进制流（pipe stream，backpressure-safe） |

#### 错误
| Status | error_code | 触发条件 |
|---|---|---|
| 400 | `INVALID_AUDIO_ID` | audio_id 含非法字符 |
| 404 | `AUDIO_NOT_FOUND` | `audio_assets` 没匹配行 或 `status != 'ready'` |
| 404 | `COS_OBJECT_NOT_FOUND` | COS NoSuchKey（DB row 在但 COS 文件被删） |
| 500 | `COS_CONFIG_MISSING` | 服务端 COS env 未配置 |
| 500 | `COS_FETCH_FAILED` | COS 网络/权限错误（脱敏：不泄漏 bucket name） |
| 500 | `INVALID_AUDIO_URL` | `audio_assets.url` 反解 object_key 失败（不应该发生，ingest 写入时已校验） |

---

## 四、对前端的影响

**0 改动**。`apps/mobile/lib/core/audio/` 三个服务的实现完全不变：
- `ExampleAudioService` / `WordAudioService`：读 response.meta.url，无论 mode 都正确工作
- `PronunciationService`：`http` 包默认 maxRedirects=5 自动跟随 302（兼容模式），stream 模式则直接 200 拿 WAV bytes
- 本地 `audio_file_cache` 表按 `audio_id` 索引，与 url 形态无关

---

## 五、运维 / 部署

### 部署步骤（v0.2 起：默认即 stream 模式）
1. `deploy/.env` 填好 COS_REGION / COS_BUCKET / COS_SECRET_ID / COS_SECRET_KEY（建议 CAM 只读子账号）
2. `deploy/.env` 填 API_PUBLIC_BASE（与 App apiV1Base 对齐，如 `https://api.miaory.chat/api/v1`）
3. `COS_INTERNAL_ENDPOINT` 已在 docker-compose.prod.yml 配 default `https://cos-internal.ap-shanghai.tencentcos.cn`，如需覆盖在 deploy/.env 显式写
4. `AUDIO_ACCESS_MODE` 不需手动设（默认就是 `backend_proxy_stream`），如需回滚到 cos 显式设 `AUDIO_ACCESS_MODE=backend_issued_cos_url`
5. `docker compose --env-file deploy/.env -f docker-compose.prod.yml up -d` —— 缺 env 立刻报错（`${VAR:?}` 风格）；启动后 `assertAudioAccessModeReady` 再校验一道

### 监控
切换后预期：
- 腾讯云 COS 公网下行流量曲线下降到接近 0
- 服务器公网下行流量曲线上升
- 服务器 CPU / 带宽监控；并发上来需扩容

### 回滚
v0.2 起回滚比单纯改 env 多一步：
1. 腾讯云控制台**先重新打开** COS 公网读权限（否则 cos 模式同样 403）
2. `deploy/.env` 显式加 `AUDIO_ACCESS_MODE=backend_issued_cos_url`（光 unset 不行——默认已是 stream）
3. `docker compose ... up -d --force-recreate api` 重启
4. 无需 DB 变更

---

## 六、测试覆盖

| 文件 | 覆盖点 |
|---|---|
| `apps/api/src/services/audio-access-url.service.spec.ts` | mode 切换返回正确 url（9 cases） |
| `apps/api/src/services/cos-storage.service.spec.ts` | `urlToObjectKey` 反解边界（6 cases） |
| `apps/api/src/controllers/audio-stream.controller.spec.ts` | 校验 / 404 / happy path / 头字段（6 cases） |
| `apps/api/src/controllers/pronunciation.controller.spec.ts` | mode 分支 + 校验 + 302/stream 行为（8 cases） |

E2E 验证（手工，部署阶段）：
- mode=cos 回归：抓包确认 meta.url 仍是 COS URL，pronunciation 仍是 302
- mode=stream：抓包确认 meta.url 形如 `/api/v1/audio/stream/<id>`，**不出现** `cos.ap-*.myqcloud.com`；pronunciation 返回 200 + WAV
