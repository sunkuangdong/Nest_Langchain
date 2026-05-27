import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SpeechService } from './speech.service';
import { TtsRelayService } from './tts-relay.service';

@Controller('speech')
export class SpeechController {
  constructor(
    private readonly speechService: SpeechService,
    private readonly ttsRelay: TtsRelayService,
  ) {}

  @Post('asr')
  @UseInterceptors(FileInterceptor('audio'))
  async recognize(
    @UploadedFile()
    file?: {
      buffer: Buffer;
      originalname: string;
      mimetype: string;
      size: number;
    },
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException(
        '请通过 FormData 的 audio 字段上传音频文件',
      );
    }

    const text = await this.speechService.recognizeBySentence(file);
    return { text };
  }

  /**
   * Dev: stream OpenAI TTS to an active WS session (step 3 test).
   * Example: GET /speech/tts/test?text=你好&sessionId=<from asr.html status>
   */
  @Get('tts/test')
  async ttsTest(
    @Query('text') text: string,
    @Query('sessionId') sessionId: string,
  ) {
    if (!sessionId?.trim()) {
      throw new BadRequestException(
        '缺少 sessionId：先打开 asr.html 等待 TTS 已连接，从状态栏或 WS 消息获取',
      );
    }
    return this.ttsRelay.synthesizeToSession(sessionId, text ?? '你好');
  }
}
