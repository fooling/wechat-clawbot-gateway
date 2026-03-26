import mqtt from "mqtt";
import type { MqttClient } from "mqtt";
import type { Channel, ChannelContext } from "./channel.js";
import type { MqttConfig } from "../config.js";

export class MqttChannel implements Channel {
  readonly name = "mqtt";
  private client: MqttClient | null = null;
  private readonly config: MqttConfig;

  constructor(config: MqttConfig) {
    this.config = config;
  }

  async start(ctx: ChannelContext): Promise<void> {
    const { config } = this;

    this.client = await mqtt.connectAsync(config.broker, {
      username: config.username || undefined,
      password: config.password || undefined,
    });

    ctx.debug("broker connected");

    const client = this.client;

    client.on("reconnect", () => ctx.debug("broker reconnecting"));
    client.on("close", () => ctx.debug("broker disconnected"));
    client.on("error", (err) => ctx.debug("broker error: " + err.message));

    // Outbound (MQTT -> WeChat): subscribe to topics and forward as notifications
    const topicTagMap = new Map<string, string>();
    for (const sub of config.subscribe) {
      topicTagMap.set(sub.topic, sub.tag);
      await client.subscribeAsync(sub.topic);
    }

    client.on("message", (topic, payload) => {
      const tag = topicTagMap.get(topic);
      if (tag) {
        ctx.notify("[" + tag + "] " + payload.toString()).catch((err) => {
          ctx.debug("notify error: " + (err as Error).message);
        });
      }
    });

    // Inbound (WeChat -> MQTT): register commands that publish to topics
    for (const [cmd, cmdCfg] of Object.entries(config.commands)) {
      ctx.onCommand(cmd, async (_userId: string, args: string) => {
        client.publish(cmdCfg.topic, args);
        return "[" + cmd + "] 已发送";
      });
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.endAsync();
      this.client = null;
    }
  }
}
