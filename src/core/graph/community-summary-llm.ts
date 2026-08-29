/**
 * LLM boundary for index-time community summaries.
 *
 * This is separate from triple extraction: a summary is plain text and must
 * never be interpreted as a fact or written to the triples ledger.
 */
import Anthropic from "@anthropic-ai/sdk";

export interface CommunitySummaryClient {
  summarize(entityNames: readonly string[]): Promise<string>;
}

interface MessageLike {
  content: Array<{ type: string; text?: string }>;
}

interface AnthropicLike {
  messages: {
    create: (params: unknown) => Promise<MessageLike>;
  };
}

export interface AnthropicCommunitySummaryClientOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  anthropic?: AnthropicLike;
}

export class AnthropicCommunitySummaryClient implements CommunitySummaryClient {
  private readonly model: string;
  private readonly anthropic: AnthropicLike;

  constructor(options: AnthropicCommunitySummaryClientOptions) {
    this.model = options.model;
    this.anthropic =
      options.anthropic ??
      (new Anthropic({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
      }) as unknown as AnthropicLike);
  }

  async summarize(entityNames: readonly string[]): Promise<string> {
    const message = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 512,
      thinking: { type: "disabled" },
      system:
        "Summarize the shared topic of the supplied knowledge-graph entities. " +
        "Return only concise plain text, without a title or markdown.",
      messages: [
        {
          role: "user",
          content: `Community entities:\n${entityNames
            .map((name) => `- ${name}`)
            .join("\n")}`,
        },
      ],
    });
    const text = message.content.find((block) => block.type === "text")?.text;
    if (text === undefined || text.trim() === "") {
      throw new Error("community summary LLM returned no text");
    }
    return text.trim();
  }
}
