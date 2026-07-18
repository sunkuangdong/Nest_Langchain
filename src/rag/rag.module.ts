import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MilvusRagService } from './milvus-rag.service';

@Module({
  imports: [ConfigModule],
  providers: [MilvusRagService],
  exports: [MilvusRagService],
})
export class RagModule {}
