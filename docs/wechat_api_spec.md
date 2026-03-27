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

```
1. 从 media.encrypt_query_param 获取参数
2. GET https://novac2c.cdn.weixin.qq.com/c2c/download?{encrypt_query_param}
3. 用 AES-128-ECB 解密（key 从 media.aes_key 解码，注意两种格式）
4. 得到原始文件
```

## 媒体上传流程

```
1. 生成随机 AES-128 key
2. AES-128-ECB 加密文件
3. POST ilink/bot/getuploadurl 获取上传参数
   请求: { media_type, rawsize, filesize, rawfilemd5, aeskey, ... }
   响应: { upload_param, thumb_upload_param }
4. PUT 加密文件到 CDN
5. 构建 CDNMedia { encrypt_query_param: upload_param, aes_key: base64(key) }
6. 放入 sendmessage 的 item_list 中对应的 *_item 字段
```

`getuploadurl` 的 `media_type` 枚举（注意与 MessageItemType 不同）：

```typescript
const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;
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

## 参考

- [官方类型定义 (types.ts)](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/packages/openclaw-weixin/src/api/types.ts)
- [协议规格文档](https://github.com/epiral/weixin-bot/blob/main/docs/protocol-spec.md)
- [iLink Bot API 文档](https://github.com/hao-ji-xing/openclaw-weixin/blob/main/weixin-bot-api.md)
