import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';

const SUPPORTED_REASONING_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function resolveReasoningEffort(
  configuredValue: string | undefined,
  modelName: string,
): string | undefined {
  const configured = (
    configuredValue ?? (modelName.toLowerCase() === 'gpt-6-luna' ? 'none' : '')
  )
    .trim()
    .toLowerCase();

  if (configured && !SUPPORTED_REASONING_EFFORTS.has(configured)) {
    throw new Error(
      `MODEL_REASONING_EFFORT=${JSON.stringify(configured)} is invalid`,
    );
  }

  return configured || undefined;
}

@Injectable()
export class LlmService {
  constructor(private readonly configService: ConfigService) {}

  getModel() {
    const apiKey = this.configService.getOrThrow<string>('OPENAI_API_KEY');
    const baseURL = this.configService.getOrThrow<string>('OPENAI_BASE_URL');
    const modelName =
      this.configService.get<string>('MODEL_NAME') ?? 'qwen-plus';
    const reasoningEffort = resolveReasoningEffort(
      this.configService.get<string>('MODEL_REASONING_EFFORT'),
      modelName,
    );

    return new ChatOpenAI({
      temperature: 0.7,
      modelName,
      apiKey,
      configuration: { baseURL },
      // @langchain/openai 1.4.x does not yet classify gpt-6-* as reasoning
      // models, so pass the Chat Completions field through explicitly.
      modelKwargs: reasoningEffort
        ? { reasoning_effort: reasoningEffort }
        : undefined,
    });
  }
}
