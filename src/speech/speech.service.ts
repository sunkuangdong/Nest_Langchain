import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
type UploadedAudio = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

@Injectable()
export class SpeechService {
  constructor(private readonly configService: ConfigService) {}

  async recognizeBySentence(file: UploadedAudio): Promise<string> {
    const apiKey = this.configService.getOrThrow<string>('OPENAI_API_KEY');

    const baseURL = (
      this.configService.get<string>('OPENAI_BASE_URL') ||
      'https://api.openai.com/v1'
    ).replace(/\/$/, '');

    const model = this.configService.get<string>('ASR_MODEL') ?? 'whisper-1';
    const language = this.configService.get<string>('ASR_LANGUAGE');

    const formData = new FormData();
    const filename = file.originalname || 'audio.webm';
    formData.append(
      'file',
      new Blob([new Uint8Array(file.buffer)], {
        type: file.mimetype || 'application/octet-stream',
      }),
      filename,
    );
    formData.append('model', model);
    if (language) {
      formData.append('language', language);
    }
    formData.append(
      'prompt',
      'Simplified Chinese or English. Chinese speech: Simplified Chinese. English speech: English.',
    );

    const response = await fetch(`${baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new InternalServerErrorException(
        `ASR failed (${response.status}): ${errText}`,
      );
    }

    const data = (await response.json()) as { text?: string };
    return data.text ?? '';
  }
}
