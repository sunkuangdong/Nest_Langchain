import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

@Module({
  imports: [
    EventEmitterModule.forRoot({
      maxListeners: 200,
    }),
  ],
  exports: [EventEmitterModule],
})
export class AppEventEmitterModule {}
