import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

/** ws 客户端在本服务里用到的能力（避免与 DOM WebSocket 类型混淆） */
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
export class TtsRelayService implements OnModuleDestroy {
  private readonly logger = new Logger(TtsRelayService.name);
  private readonly sessions = new Map<string, ClientSession>();

  constructor(private readonly configService: ConfigService) {}

  onModuleDestroy(): void {
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

  handleClientMessage(
    sessionId: string,
    raw: Buffer | ArrayBuffer | Buffer[],
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;

    const text = Buffer.isBuffer(raw)
      ? raw.toString('utf8')
      : Buffer.from(raw as ArrayBuffer).toString('utf8');

    let msg: { type?: string; text?: string };
    try {
      msg = JSON.parse(text) as { type?: string; text?: string };
    } catch {
      return;
    }

    if (msg.type === 'tts_test' && typeof msg.text === 'string') {
      void this.synthesizeToSession(sessionId, msg.text).catch(
        (error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(`tts_test failed for ${sessionId}: ${message}`);
        },
      );
    }
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
    if (!session) return;
    session.closed = true;

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
