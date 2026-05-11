export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterClientConfig {
  apiKey: string;
  baseUrl: string;
}

export interface ChatCompletionResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ChatCompletionOpts {
  signal: AbortSignal;
  maxTokens?: number;
}

export class OpenRouterClient {
  constructor(private readonly cfg: OpenRouterClientConfig) {}

  async chatCompletion(
    modelId: string,
    messages: ChatMessage[],
    opts: ChatCompletionOpts,
  ): Promise<ChatCompletionResult> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.cfg.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://urateams.com",
        "X-Title": "urateam",
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`openrouter ${res.status} ${body.slice(0, 200)}`);
    }
    // Some providers (notably free-tier / community models) return 200 OK with
    // an error body and no `choices` field. Treat missing/empty choices as a
    // failure with a meaningful message instead of letting `json.choices[0]`
    // throw "Cannot read properties of undefined (reading '0')".
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string; code?: string | number };
    };
    if (!Array.isArray(json.choices) || json.choices.length === 0) {
      const providerErr = json.error?.message ?? "no error message in response body";
      throw new Error(
        `openrouter response missing choices — provider returned 200 OK but no completion: ${providerErr}`,
      );
    }
    return {
      content: json.choices[0]?.message?.content ?? "",
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
  }
}
