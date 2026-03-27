import type { MessageItem, CDNMedia, IncomingMessage } from "../protocol/weixin.js";

export interface LogEntry {
  timestamp: number;
  source: string;
  direction: "in" | "out";
  userId: string;
  text: string;
}

export interface DebugEntry {
  timestamp: number;
  channel: string;
  detail: string;
}

export type CommandHandler = (userId: string, args: string) => Promise<string | void>;
export type MessageHandler = (userId: string, text: string) => Promise<string | void>;

export interface ChannelContext {
  // Text messaging
  send(userId: string, text: string): Promise<void>;
  notify(text: string): Promise<void>;

  // Media messaging (text and media must be sent separately per WeChat limitation)
  sendMedia(userId: string, items: MessageItem[]): Promise<void>;
  notifyMedia(items: MessageItem[]): Promise<void>;

  // CDN download
  downloadMedia(cdnMedia: CDNMedia): Promise<Buffer>;

  // Handler registration
  onCommand(cmd: string, handler: CommandHandler, help?: string): void;
  onDefault(handler: MessageHandler): void;
  onMessage(handler: (msg: IncomingMessage) => void): void;

  // Observability
  debug(detail: string): void;
  onLog(handler: (entry: LogEntry) => void): void;
  onDebug(handler: (entry: DebugEntry) => void): void;
}

export interface Channel {
  readonly name: string;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
}
