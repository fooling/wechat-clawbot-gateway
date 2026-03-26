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
  send(userId: string, text: string): Promise<void>;
  notify(text: string): Promise<void>;
  onCommand(cmd: string, handler: CommandHandler): void;
  onDefault(handler: MessageHandler): void;
  debug(detail: string): void;
  onLog(handler: (entry: LogEntry) => void): void;
  onDebug(handler: (entry: DebugEntry) => void): void;
}

export interface Channel {
  readonly name: string;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
}
