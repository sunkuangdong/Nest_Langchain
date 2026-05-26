import { NestFactory } from '@nestjs/core';
import type { Server as HttpServer } from 'node:http';
import { AppModule } from './app.module';
import { TtsRelayService } from './speech/tts-relay.service';
import { WebSocketServer } from 'ws';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const ttsRelay = app.get(TtsRelayService);
  const httpServer = app.getHttpServer() as HttpServer;

  const ttsWss = new WebSocketServer({
    server: httpServer,
    path: '/speech/tts/ws',
  });

  ttsWss.on('connection', (socket, req) => {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const wantedSessionId = url.searchParams.get('sessionId') ?? undefined;
    const sessionId = ttsRelay.registerClient(socket, wantedSessionId);

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      ttsRelay.handleClientMessage(sessionId, data);
    });

    socket.on('close', () => {
      ttsRelay.unregisterClient(sessionId);
    });
  });

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
