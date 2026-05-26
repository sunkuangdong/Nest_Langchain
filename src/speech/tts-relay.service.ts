import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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
};

@Injectable()
export class TtsRelayService implements OnModuleDestroy {
  private readonly logger = new Logger(TtsRelayService.name);
  private readonly sessions = new Map<string, ClientSession>();

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
    });
    this.sendClientJson(clientWs, { type: 'session', sessionId });
    this.logger.log(`TTS client connected: ${sessionId}`);
    return sessionId;
  }

  unregisterClient(sessionId: string): void {
    this.closeSession(sessionId, 'client disconnected');
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
}
