import OpenAI from "openai";
import type { Channel, ChannelContext } from "./channel.js";
import type { LlmModelConfig } from "../config.js";

export class LlmChannel implements Channel {
  readonly name: string;
  private client: OpenAI;
  private config: LlmModelConfig;

  constructor(name: string, config: LlmModelConfig) {
    this.name = name;
    this.config = config;

    const apiKey = process.env[config.api_key_env];
    if (!apiKey) {
      throw new Error(
        `LLM channel "${name}": env var ${config.api_key_env} not set`,
      );
    }

    this.client = new OpenAI({ apiKey, baseURL: config.base_url });
  }

  async start(ctx: ChannelContext): Promise<void> {
    ctx.onCommand(this.name, async (_userId: string, args: string) => {
      if (!args.trim()) {
        return `[${this.name}] 请输入问题`;
      }

      ctx.debug("请求发送: " + this.config.model);

      const messages: OpenAI.ChatCompletionMessageParam[] = [];
      if (this.config.system_prompt) {
        messages.push({ role: "system", content: this.config.system_prompt });
      }
      messages.push({ role: "user", content: args });

      try {
        const completion = await this.client.chat.completions.create({
          model: this.config.model,
          messages,
        });

        const content = completion.choices[0]?.message?.content ?? "";
        return `[${this.name}] ${content}`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.debug("请求失败: " + message);
        return `[${this.name}] 请求失败: ${message}`;
      }
    });

    ctx.debug("registered command /" + this.name + " → " + this.config.model);
  }

  async stop(): Promise<void> {
    // OpenAI client needs no cleanup
  }
}
