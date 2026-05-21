import { forwardRef, Module } from '@nestjs/common';
import { MailerModule } from '@nestjs-modules/mailer';
import { UsersModule } from '../users/users.module';
import {
  AI_MODEL,
  CRON_JOB_TOOL,
  DB_USERS_CRUD_TOOL,
  QUERY_USER_TOOL,
  SEND_MAIL_TOOL,
  WEB_SEARCH_TOOL,
  TIME_NOW_TOOL,
} from '../ai/ai.tokens';
import { UserService } from '../ai/user.service';
import { LlmService } from './llm.service';
import { SendMailToolService } from './send-mail-tool.service';
import { WebSearchToolService } from './web-search-tool.service';
import { DbUsersCrudToolService } from './db-users-crud-tool.service';
import { TimeNowToolService } from './time-now-tool.service';
import { CronJobToolService } from './cron-job-tool.service';
import { QueryUserToolService } from './query-user-tool.service';
import { JobModule } from '../job/job.module';

@Module({
  imports: [MailerModule, UsersModule, forwardRef(() => JobModule)],
  providers: [
    UserService,
    LlmService,
    SendMailToolService,
    WebSearchToolService,
    DbUsersCrudToolService,
    TimeNowToolService,
    CronJobToolService,
    QueryUserToolService,
    {
      provide: AI_MODEL,
      useFactory: (llmService: LlmService) => llmService.getModel(),
      inject: [LlmService],
    },
    {
      provide: QUERY_USER_TOOL,
      useFactory: (svc: QueryUserToolService) => svc.tool,
      inject: [QueryUserToolService],
    },
    {
      provide: SEND_MAIL_TOOL,
      useFactory: (svc: SendMailToolService) => svc.tool,
      inject: [SendMailToolService],
    },
    {
      provide: WEB_SEARCH_TOOL,
      useFactory: (svc: WebSearchToolService) => svc.tool,
      inject: [WebSearchToolService],
    },
    {
      provide: DB_USERS_CRUD_TOOL,
      useFactory: (svc: DbUsersCrudToolService) => svc.tool,
      inject: [DbUsersCrudToolService],
    },
    {
      provide: CRON_JOB_TOOL,
      useFactory: (svc: CronJobToolService) => svc.tool,
      inject: [CronJobToolService],
    },
    {
      provide: TIME_NOW_TOOL,
      useFactory: (svc: TimeNowToolService) => svc.tool,
      inject: [TimeNowToolService],
    },
  ],
  exports: [
    AI_MODEL,
    QUERY_USER_TOOL,
    SEND_MAIL_TOOL,
    WEB_SEARCH_TOOL,
    DB_USERS_CRUD_TOOL,
    CRON_JOB_TOOL,
    TIME_NOW_TOOL,
  ],
})
export class ToolModule {}
