import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import {
  AI_TTS_STREAM_EVENT,
  type AiTtsStreamEvent,
} from '../common/stream-events';

/** Minimal WS client surface used here (avoids DOM WebSocket type clashes). */
export type TtsClientSocket = {
  readonly readyState: number;
  send(data: string | Buffer, options?: { binary?: boolean }): void;
  close(): void;
};

/** ws readyState: 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED */
const WS_OPEN = 1;
const WS_CLOSING = 2;

type ClientSession = {
  sessionId: string;
  clientWs: TtsClientSocket;
  closed: boolean;
  synthesizing: boolean;
};

@Injectable()
export class TtsRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TtsRelayService.name);
  private readonly sessions = new Map<string, ClientSession>();
  private readonly sessionSynthesisQueues = new Map<string, Promise<void>>();
  private readonly onAiTtsStreamBound = (event: AiTtsStreamEvent) =>
    this.onAiTtsStreamEvent(event);

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    // Avoid duplicate listeners on hot reload (would synthesize/play each sentence twice).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.eventEmitter.off(AI_TTS_STREAM_EVENT, this.onAiTtsStreamBound);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.eventEmitter.on(AI_TTS_STREAM_EVENT, this.onAiTtsStreamBound);
  }

  onModuleDestroy(): void {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    this.eventEmitter.off(AI_TTS_STREAM_EVENT, this.onAiTtsStreamBound);
    for (const session of this.sessions.values()) {
      this.closeSession(session.sessionId, 'module destroy');
    }
  }

  registerClient(clientWs: TtsClientSocket, wantedSessionId?: string): string {
    const sessionId = wantedSessionId?.trim() || randomUUID();
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.closeSession(sessionId, 'client reconnected');
    }

    this.sessions.set(sessionId, {
      sessionId,
      clientWs,
      closed: false,
      synthesizing: false,
    });
    this.sendClientJson(clientWs, { type: 'session', sessionId });
    this.logger.log(`TTS client connected: ${sessionId}`);
    return sessionId;
  }

  unregisterClient(sessionId: string): void {
    this.closeSession(sessionId, 'client disconnected');
  }

  onAiTtsStreamEvent(event: AiTtsStreamEvent): void {
    if (event.type === 'start') {
      const session = this.sessions.get(event.sessionId);
      if (session) {
        this.sendClientJson(session.clientWs, {
          type: 'tts_stream_started',
          sessionId: event.sessionId,
        });
      }
      return;
    }

    if (event.type === 'end') {
      const session = this.sessions.get(event.sessionId);
      if (session) {
        this.sendClientJson(session.clientWs, {
          type: 'tts_stream_ended',
          sessionId: event.sessionId,
        });
      }
      return;
    }

    if (event.type === 'error') {
      const session = this.sessions.get(event.sessionId);
      if (session) {
        this.sendClientJson(session.clientWs, {
          type: 'tts_error',
          sessionId: event.sessionId,
          message: event.error,
        });
      }
      return;
    }

    if (!this.isSessionActive(event.sessionId)) return;
    this.enqueueSynthesis(event.sessionId, event.chunk);
  }

  async synthesizeToSession(
    sessionId: string,
    text: string,
  ): Promise<{ sessionId: string; bytes: number }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) {
      throw new NotFoundException(
        `TTS session 不存在或已关闭: ${sessionId}。请先打开 asr.html 建立 WebSocket。`,
      );
    }

    const input = text.trim();
    if (!input) {
      throw new BadRequestException('text 不能为空');
    }

    if (session.synthesizing) {
      throw new BadRequestException('当前 session 正在合成，请稍后再试');
    }

    session.synthesizing = true;
    this.sendClientJson(session.clientWs, {
      type: 'tts_started',
      sessionId,
      text: input,
    });

    try {
      const bytes = await this.streamOpenAiSpeechToClient(
        input,
        session.clientWs,
      );
      this.sendClientJson(session.clientWs, { type: 'tts_final', sessionId });
      this.logger.log(`TTS streamed ${bytes} bytes to ${sessionId}`);
      return { sessionId, bytes };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendClientJson(session.clientWs, {
        type: 'tts_error',
        sessionId,
        message,
      });
      throw error;
    } finally {
      session.synthesizing = false;
    }
  }

  private isSessionActive(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && !session.closed;
  }

  private enqueueSynthesis(sessionId: string, text: string): void {
    if (!this.isSessionActive(sessionId)) return;

    const previous =
      this.sessionSynthesisQueues.get(sessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        if (!this.isSessionActive(sessionId)) return;
        try {
          await this.synthesizeToSession(sessionId, text);
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `AI TTS synthesize failed for ${sessionId}: ${message}`,
          );
        }
      });

    this.sessionSynthesisQueues.set(sessionId, current);
    void current.finally(() => {
      if (this.sessionSynthesisQueues.get(sessionId) === current) {
        this.sessionSynthesisQueues.delete(sessionId);
      }
    });
  }

  private async streamOpenAiSpeechToClient(
    input: string,
    clientWs: TtsClientSocket,
  ): Promise<number> {
    const apiKey = this.configService.getOrThrow<string>('OPENAI_API_KEY');
    const baseURL = (
      this.configService.get<string>('OPENAI_BASE_URL') ||
      'https://api.openai.com/v1'
    ).replace(/\/$/, '');
    const model = this.configService.get<string>('TTS_MODEL') ?? 'tts-1';
    const voice = this.configService.get<string>('TTS_VOICE') ?? 'alloy';

    const response = await fetch(`${baseURL}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input, voice }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`TTS failed (${response.status}): ${errText}`);
    }

    if (!response.body) {
      throw new Error('TTS response body is empty');
    }

    const reader = response.body.getReader();
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;

      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      this.sendClientBinary(clientWs, chunk);
    }

    return totalBytes;
  }

  private closeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sessionSynthesisQueues.delete(sessionId);
      return;
    }
    session.closed = true;
    session.synthesizing = false;
    this.sessionSynthesisQueues.delete(sessionId);

    if (session.clientWs.readyState < WS_CLOSING) {
      this.sendClientJson(session.clientWs, { type: 'tts_closed', reason });
      session.clientWs.close();
    }
    this.sessions.delete(sessionId);
    this.logger.log(`TTS session closed: ${sessionId}, reason: ${reason}`);
  }

  private sendClientJson(
    clientWs: TtsClientSocket,
    payload: Record<string, unknown>,
  ): void {
    if (clientWs.readyState !== WS_OPEN) return;
    clientWs.send(JSON.stringify(payload));
  }

  private sendClientBinary(clientWs: TtsClientSocket, data: Buffer): void {
    if (clientWs.readyState !== WS_OPEN) return;
    clientWs.send(data, { binary: true });
  }
}
