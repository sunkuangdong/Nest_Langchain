import { Module } from '@nestjs/common';
import { MailerModule, MailerService } from '@nestjs-modules/mailer';
import { ConfigService } from '@nestjs/config';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { UserService } from './user.service';
import {
  AI_CHAIN,
  AI_MODEL,
  AI_PROMPT,
  QUERY_USER_TOOL,
  SEND_MAIL_TOOL,
} from './ai.tokens';

@Module({
  imports: [MailerModule],
  controllers: [AiController],
  providers: [
    {
      provide: AI_PROMPT,
      useFactory: () =>
        PromptTemplate.fromTemplate('请回答以下问题：\n\n{query}'),
    },
    {
      provide: AI_MODEL,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const apiKey = configService.getOrThrow<string>('OPENAI_API_KEY');
        const baseURL = configService.getOrThrow<string>('OPENAI_BASE_URL');
        const modelName =
          configService.get<string>('MODEL_NAME') ?? 'qwen-plus';

        return new ChatOpenAI({
          temperature: 0.7,
          modelName,
          apiKey,
          configuration: { baseURL },
        });
      },
    },
    {
      provide: AI_CHAIN,
      inject: [AI_PROMPT, AI_MODEL],
      useFactory: (
        prompt: PromptTemplate<{ query: string }>,
        model: ChatOpenAI,
      ) => prompt.pipe(model).pipe(new StringOutputParser()),
    },
    {
      provide: QUERY_USER_TOOL,
      useFactory: (userService: UserService) => {
        const queryUserArgsSchema = z.object({
          userId: z.string().describe('用户 ID，例如: 001, 002, 003'),
        });

        return tool(
          async ({ userId }: { userId: string }) => {
            const user = await Promise.resolve(userService.findOne(userId));

            if (!user) {
              const availableIds = userService
                .findAll()
                .map((u) => u.id)
                .join(', ');

              return `用户 ID ${userId} 不存在。可用的 ID: ${availableIds}`;
            }

            return `用户信息：\n- ID: ${user.id}\n- 姓名: ${user.name}\n- 邮箱: ${user.email}\n- 角色: ${user.role}`;
          },
          {
            name: 'query_user',
            description:
              '查询数据库中的用户信息。输入用户 ID，返回该用户的详细信息（姓名、邮箱、角色）。',
            schema: queryUserArgsSchema,
          },
        );
      },
      inject: [UserService],
    },
    {
      provide: SEND_MAIL_TOOL,
      inject: [MailerService, ConfigService],
      useFactory: (
        mailerService: MailerService,
        configService: ConfigService,
      ) => {
        const sendMailArgsSchema = z.object({
          to: z.email().describe('收件人邮箱地址，例如：someone@example.com'),
          subject: z.string().describe('邮件主题'),
          text: z.string().optional().describe('纯文本内容，可选'),
          html: z.string().optional().describe('HTML 内容，可选'),
        });

        return tool(
          async ({
            to,
            subject,
            text,
            html,
          }: {
            to: string;
            subject: string;
            text?: string;
            html?: string;
          }) => {
            const fallbackFrom = configService.get<string>('MAIL_FROM');

            await mailerService.sendMail({
              to,
              subject,
              text: text ?? '（无文本内容）',
              html: html ?? `<p>${text ?? '（无 HTML 内容）'}</p>`,
              from: fallbackFrom,
            });

            return `邮件已发送到 ${to}，主题为「${subject}」`;
          },
          {
            name: 'send_mail',
            description:
              '发送电子邮件。需要提供收件人邮箱、主题，可选文本内容和 HTML 内容。',
            schema: sendMailArgsSchema,
          },
        );
      },
    },
    UserService,
    AiService,
  ],
})
export class AiModule {}
