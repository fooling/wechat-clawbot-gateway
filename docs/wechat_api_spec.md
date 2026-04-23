# WeChat iLink Bot API — 媒体消息协议规格

基于 `@tencent-weixin/openclaw-weixin` 官方类型定义 + 实际抓包验证。

## 消息结构

```typescript
interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;        // xxx@im.wechat (用户) | xxx@im.bot (机器人)
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;        // 1=USER, 2=BOT
  message_state?: number;       // 0=NEW, 1=GENERATING, 2=FINISH
  item_list?: MessageItem[];
  context_token?: string;       // 回复时必须携带
}
```

## MessageItem 类型

```typescript
interface MessageItem {
  type?: number;                // 1=TEXT, 2=IMAGE, 3=VOICE, 4=FILE, 5=VIDEO
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
}
```

## TEXT (type: 1)

```typescript
interface TextItem {
  text?: string;
}
```

## IMAGE (type: 2)

```typescript
interface ImageItem {
  media?: CDNMedia;             // 原图 CDN 引用
  thumb_media?: CDNMedia;       // 缩略图 CDN 引用（不一定存在）
  aeskey?: string;              // 32 字符 hex AES-128 key
  url?: string;                 // 微信内部媒体 ID（hex，不是 HTTP URL）
  mid_size?: number;            // 原图加密后大小
  thumb_size?: number;          // 缩略图加密后大小
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;             // 高清图大小
}
```

**实际抓包（2026-03-27）：**

```json
{
  "type": 2,
  "is_completed": true,
  "image_item": {
    "url": "3057020100...",
    "aeskey": "67d7629cbc252ed5a16979c098e6f3e1",
    "media": {
      "encrypt_query_param": "NFN4Z28y...",
      "aes_key": "NjdkNzYyOWNiYzI1MmVkNWExNjk3OWMwOThlNmYzZTE="
    },
    "mid_size": 333111,
    "thumb_size": 21251,
    "thumb_height": 210,
    "thumb_width": 210,
    "hd_size": 333111
  }
}
```

注意：`url` 字段是 hex 编码的微信内部引用，不是可直接访问的 HTTP URL。`thumb_media` 未出现。

## VOICE (type: 3)

```typescript
interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;         // 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex
  bits_per_sample?: number;
  sample_rate?: number;         // Hz
  playtime?: number;            // 毫秒
  text?: string;                // 微信语音转文字结果（重要！零成本可用）
}
```

**实际抓包：**

```json
{
  "type": 3,
  "is_completed": true,
  "voice_item": {
    "media": {
      "encrypt_query_param": "dFItZUhE...",
      "aes_key": "MzE3ZjVj..."
    },
    "encode_type": 4,
    "bits_per_sample": 16,
    "sample_rate": 16000,
    "playtime": 2061,
    "text": "哈喽哈喽哈喽"
  }
}
```

`text` 字段确认存在，微信服务端已完成语音识别。

## FILE (type: 4)

```typescript
interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;                 // 注意：string 类型，不是 number
}
```

**实际抓包：**

```json
{
  "type": 4,
  "is_completed": true,
  "file_item": {
    "media": {
      "encrypt_query_param": "QU41Mnh...",
      "aes_key": "Y2IxMmNm..."
    },
    "file_name": "720packet",
    "md5": "48076cfd195e18b0993c72ba112e39ce",
    "len": "11638"
  }
}
```

## VIDEO (type: 5)

```typescript
interface VideoItem {
  media?: CDNMedia;             // 视频文件
  thumb_media?: CDNMedia;       // 视频封面
  video_size?: number;
  play_length?: number;         // 播放时长
  video_md5?: string;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}
```

*未实际验证，结构来自官方 types.ts。*

## CDNMedia 结构

所有媒体类型共用的 CDN 引用：

```typescript
interface CDNMedia {
  encrypt_query_param?: string;  // CDN 下载所需参数
  aes_key?: string;              // base64 编码的 AES-128 key
  encrypt_type?: number;         // 0=只加密fileid, 1=包含缩略图等
}
```

## AES Key 编码

存在两种编码格式，需要都尝试：

- **Format A**: `base64(raw 16 bytes)` → 解码得到 16 字节二进制
- **Format B**: `base64(hex string)` → 解码得到 32 字符 hex 字符串 → 转 16 字节二进制

实际观察：`media.aes_key` 用的是 Format B（base64 of hex），`image_item.aeskey` 是原始 hex。

示例：
```
image_item.aeskey      = "67d7629cbc252ed5a16979c098e6f3e1"  (hex, 32 chars)
media.aes_key (base64) = "NjdkNzYyOWNiYzI1MmVkNWExNjk3OWMwOThlNmYzZTE="
                        → decode → "67d7629cbc252ed5a16979c098e6f3e1" (same hex)
```

## 媒体下载流程

**CDN 域名：** `https://novac2c.cdn.weixin.qq.com/c2c`

```
1. 从 media.encrypt_query_param 获取参数（标准 base64 字符串）
2. GET https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param={encodeURIComponent(param)}
3. 用 AES-128-ECB 解密响应 body（key 从 media.aes_key 解码，注意两种格式）
4. 得到原始文件
```

**注意：** 下载 URL 的 query 参数名是 `encrypted_query_param`，值需要 URL 编码。

**实测验证（2026-03-27）：**

```bash
# 正确 ✅
GET /c2c/download?encrypted_query_param=NFN4Z28yTzd2WkZQ... → 200

# 错误 ❌（缺参数名）
GET /c2c/download?NFN4Z28yTzd2WkZQ... → 400
```

## 媒体上传流程

完整的上传需要 3 步：getuploadurl → CDN POST → sendmessage。

**实测验证（2026-04-24）**：iLink 图片上传链路在 3 月初次跑通后，服务端 4 月有过不公开协议变更，下文已经反映新版实况（见各步骤的「⚠️ 协议更新」标注）。

### Step 1: getuploadurl — 获取上传参数

```
POST {baseUrl}/ilink/bot/getuploadurl
Authorization: Bearer {token}
Content-Type: application/json

{
  "filekey": "{随机 hex 32 字符}",          // crypto.randomBytes(16).toString('hex')
  "media_type": 1,                          // UploadMediaType 枚举
  "to_user_id": "xxx@im.wechat",           // 接收者（可选）
  "rawsize": 4368393,                       // 原始文件大小
  "rawfilemd5": "abc123...",                // 原始文件 MD5 hex
  "filesize": 4368400,                      // AES 加密后文件大小
  "aeskey": "a182e4fe52ea1616...",          // AES key hex 字符串（32 字符）
  "no_need_thumb": true                     // 不需要缩略图上传
}

→ 响应（新版，2026-04）:
{
  "upload_full_url": "https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=...&filekey=...&taskid=..."
}

→ 响应（老版，已弃用）:
{
  "upload_param": "UC1wVWEtOHJXXzhQ...",
  "thumb_upload_param": "..."
}
```

**⚠️ 协议更新（2026-04）**：服务端从单独返 `upload_param` 切换成返 **`upload_full_url`**（完整拼好的 URL，带新字段 `taskid`）。客户端应该直接把 `upload_full_url` 当 CDN POST 目标。兼容代码里两种都要处理；`taskid` 对客户端透明，不需要主动回传。

**`media_type` 枚举（注意与 MessageItemType 不同）：**

```typescript
const UploadMediaType = {
  IMAGE: 1,    // MessageItemType.IMAGE = 2
  VIDEO: 2,    // MessageItemType.VIDEO = 5
  FILE: 3,     // MessageItemType.FILE = 4
  VOICE: 4,    // MessageItemType.VOICE = 3
} as const;
```

**加密后大小计算：** AES-128-ECB + PKCS7 padding，`Math.ceil((rawsize + 1) / 16) * 16`。

### Step 2: CDN 上传 — POST 加密文件

```
POST https://novac2c.cdn.weixin.qq.com/c2c/upload
  ?encrypted_query_param={encodeURIComponent(upload_param)}
  &filekey={encodeURIComponent(filekey)}
Content-Type: application/octet-stream
Body: {AES-128-ECB 加密后的文件 binary}

→ 响应 Headers（新版，2026-04）:
  x-encrypted-param: ogACNtQ6fJxbhdAi...    ← ✅ 这就是 downloadParam

→ 响应 Headers（老版）:
  x-encrypted-param: C_k00QSN...            ← 老版下载会 400
  x-encrypted-query-param: U0J1R2dkTkcw...  ← 老版才返这个
```

**⚠️ 协议更新（2026-04）**：新版 CDN 响应**只返 `x-encrypted-param`**（不再返 `x-encrypted-query-param`），格式也变了——现在这个值就是可以直接填进 ImageItem 的 downloadParam。兼容代码里两个 header 都要尝试。

### Step 3: sendmessage — 发送图片消息

```json
{
  "msg": {
    "to_user_id": "xxx@im.wechat",
    "message_type": 2,
    "message_state": 2,
    "item_list": [{
      "type": 2,
      "image_item": {
        "media": {
          "encrypt_query_param": "ogACNtQ6fJxbhdAi...",
          "aes_key": "YTE4MmU0ZmU1MmVhMTYxNmI0NGFhOWM4MGE2MDE3NWE=",
          "encrypt_type": 1
        },
        "mid_size": 4368400
      }
    }]
  }
}
```

**字段说明：**

| 字段 | 值 | 说明 |
|------|-----|------|
| `media.encrypt_query_param` | base64 字符串 | 来自 CDN 响应 `x-encrypted-param` header |
| `media.aes_key` | base64(hex) 字符串 | AES key 先 hex 编码再 base64 |
| `media.encrypt_type` | `1`（硬编码） | **⚠️ 必填**，缺了 WeChat 接单但客户端不显示图 |
| `mid_size` | number | 加密后文件大小（PKCS7 padding 后） |

**⚠️ 协议更新（2026-04）**：
- `media.encrypt_type: 1` **必填**。之前按没这个字段的 payload 发，服务端 `sendmessage` 返 `{}` 成功但客户端收不到——最隐蔽的坑
- **不要**设 `image_item.aeskey`（hex 顶层字段）、**不要**设 `hd_size`、**不要**设 `thumb_media` / `thumb_size` / `thumb_width` / `thumb_height`。photon-hq/wechat-ilink-client 的最简字段集只有上面 4 个

### 完整流程验证日志

```
1. getuploadurl → upload_param: UC1wVWEtOHJX...
2. CDN POST → 200, x-encrypted-query-param: U0J1R2dkTkcw...
3. 验证下载 → 200, 解密后 4368393 bytes, 与原文件一致 ✅
4. sendmessage → 微信收到图片，可正常打开 ✅
```

## 引用消息

```typescript
interface RefMessage {
  message_item?: MessageItem;   // 被引用的消息内容
  title?: string;               // 摘要文本
}
```

## 其他 API

### SendTyping（输入状态）

```
POST ilink/bot/sendtyping
{ ilink_user_id, typing_ticket, status: 1|2 }
// 1=正在输入, 2=取消输入
// typing_ticket 从 getconfig 获取
```

### GetConfig

```
POST ilink/bot/getconfig
→ { typing_ticket }
```

## Bot 发送能力矩阵

**实测验证（2026-03-27），基于 iLink Bot API + 多个开源 SDK 交叉验证。**

| 类型 | 接收 | 发送 | 说明 |
|------|------|------|------|
| TEXT (1) | ✅ | ✅ | |
| IMAGE (2) | ✅ | ✅ | CDN 上传 + sendmessage image_item，实测通过 |
| VOICE (3) | ✅ | ❌ | 接收含 STT 文字（`voice_item.text`）；发送 API 不报错但微信不显示 |
| FILE (4) | ✅ | ✅ | 实测通过，文件名和大小正确 |
| VIDEO (5) | ✅ | ❌ | 发送 API 不报错但微信不显示 |

### 验证细节

**VOICE 发送测试：**
- 用 silk-wasm 编码为 SILK 格式（`#!SILK_V3` header 正确）
- CDN 上传成功（UploadMediaType.VOICE = 4）
- sendmessage 返回成功
- 测试了 encode_type: 4 (speex) / 6 (silk)，sample_rate: 16000 / 24000
- 微信端均无显示
- 官方 SDK（openclaw-weixin）无 voice 上传函数
- cc-weixin 的"语音发送"实际是以 FILE 类型发送音频文件

**VIDEO 发送测试：**
- 带缩略图上传：CDN 报 `probe preview error, cdngetaeskey failed`
- 不带缩略图上传：CDN 成功，sendmessage 返回成功
- 微信端无显示
- cc-weixin 明确标注 Video 发送为 "—"（不支持）

### 变通方案

| 需求 | 方案 |
|------|------|
| 发送音频 | 以 FILE 类型发送（用户可下载播放） |
| 发送视频 | 以 FILE 类型发送（用户可下载播放） |
| 回复语音消息 | 使用 `voice_item.text`（微信 STT 结果）作为文本处理 |

### 平台限制总结

iLink Bot API（message_type=BOT）仅支持发送以下 item_list 类型：
- `text_item` (type: 1)
- `image_item` (type: 2)
- `file_item` (type: 4)

`voice_item` (type: 3) 和 `video_item` (type: 5) 在 sendmessage 中被静默忽略。微信限制：**文字和媒体必须在不同消息中分开发送**，不支持单条消息混合 text + image。

## 参考

- [官方类型定义 (types.ts)](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/packages/openclaw-weixin/src/api/types.ts)
- [协议规格文档](https://github.com/epiral/weixin-bot/blob/main/docs/protocol-spec.md)
- [iLink Bot API 文档](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md)
