import { Module } from '@nestjs/common';
import { SpeechService } from './speech.service';
import { SpeechController } from './speech.controller';
import { TtsRelayService } from './tts-relay.service';

@Module({
  providers: [SpeechService, TtsRelayService],
  controllers: [SpeechController],
  exports: [TtsRelayService],
})
export class SpeechModule {}
