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
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from 'src/users/entities/user.entity';
import {
  AI_CHAIN,
  AI_MODEL,
  AI_PROMPT,
  QUERY_USER_TOOL,
  SEND_MAIL_TOOL,
  WEB_SEARCH_TOOL,
  DB_USERS_CRUD_TOOL,
} from './ai.tokens';
import { UsersModule } from 'src/users/users.module';
import { UsersService } from '../users/users.service';

interface BochaWebPage {
  name?: string;
  url?: string;
  summary?: string;
  siteName?: string;
  siteIcon?: string;
  dateLastCrawled?: string;
}

interface BochaSearchResponse {
  code?: number | string;
  msg?: string;
  message?: string;
  data?: {
    webPages?: {
      value?: BochaWebPage[];
    };
  };
  webPages?: {
    value?: BochaWebPage[];
  };
}

@Module({
  imports: [
    MailerModule,
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: 'localhost',
      port: 3306,
      username: 'root',
      password: '',
      database: 'hello',
      synchronize: true,
      logging: true,
      entities: [User],
    }),
    UsersModule,
  ],
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
    {
      provide: WEB_SEARCH_TOOL,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const webSearchArgsSchema = z.object({
          query: z
            .string()
            .min(1)
            .describe('搜索关键词，例如：公司年报、某个事件等'),
          count: z
            .number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .describe('返回的搜索结果数量，默认 10 条'),
        });

        return tool(
          async ({ query, count }: { query: string; count?: number }) => {
            const apiKey = configService.get<string>('BOCHA_API_KEY');
            if (!apiKey) {
              return 'Bocha Web Search 的 API Key 未配置（环境变量 BOCHA_API_KEY），请先在服务端配置后再重试。';
            }

            const url = 'https://api.bochaai.com/v1/web-search';
            const body = {
              query,
              freshness: 'noLimit',
              summary: true,
              count: count ?? 10,
            };

            const response = await fetch(url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            });

            if (!response.ok) {
              const errorText = await response.text();
              try {
                const errJson = JSON.parse(errorText) as BochaSearchResponse;
                if (String(errJson.code) === '403') {
                  return `博查搜索 API 配额不足或余额不够（403：${errJson.message ?? 'no quota'}）。请到 https://open.bochaai.com/ 充值或开通套餐后重试。`;
                }
              } catch {
                // ignore JSON parse error, fall through
              }
              return `搜索 API 请求失败，HTTP ${response.status}：${errorText}`;
            }

            let json: BochaSearchResponse;
            try {
              json = (await response.json()) as BochaSearchResponse;
            } catch (e) {
              return `搜索 API 请求失败：响应 JSON 解析失败 ${(e as Error).message}`;
            }

            const apiCode = json.code;
            if (apiCode !== undefined && String(apiCode) !== '200') {
              return `博查搜索 API 业务错误（${String(apiCode)}）：${json.message ?? json.msg ?? '未知错误'}`;
            }

            const webpages =
              json.data?.webPages?.value ?? json.webPages?.value ?? [];
            if (!webpages.length) {
              return '未找到相关结果。';
            }

            return webpages
              .map(
                (page, idx) =>
                  `引用: ${idx + 1}
                    标题: ${page.name ?? ''}
                    URL: ${page.url ?? ''}
                    摘要: ${page.summary ?? ''}
                    网站名称: ${page.siteName ?? ''}
                    网站图标: ${page.siteIcon ?? ''}
                    发布时间: ${page.dateLastCrawled ?? ''}`,
              )
              .join('\n\n');
          },
          {
            name: 'web_search',
            description:
              '【联网搜索】通过博查 API 检索互联网实时信息。当用户询问最新资讯、新闻、2026 趋势、需要查证的事实时，必须调用本工具。参数 query 为搜索词，可选 count（1-20，默认 10）。',
            schema: webSearchArgsSchema,
          },
        );
      },
    },
    {
      provide: DB_USERS_CRUD_TOOL,
      inject: [UsersService],
      useFactory: (usersService: UsersService) => {
        const dbUsersCrudArgsSchema = z.object({
          action: z
            .enum(['create', 'list', 'get', 'update', 'delete'])
            .describe('要执行的操作：create、list、get、update、delete'),
          id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('用户 ID（get / update / delete 时需要）'),
          name: z
            .string()
            .min(1)
            .max(50)
            .optional()
            .describe('用户姓名（create 或 update 时可用）'),
          email: z
            .string()
            .email()
            .max(50)
            .optional()
            .describe('用户邮箱（create 或 update 时可用）'),
        });

        const formatUser = (u: User) => {
          const createdAt =
            u.createdAt instanceof Date
              ? u.createdAt.toISOString()
              : String(u.createdAt ?? '');
          return `ID=${u.id}，姓名=${u.name}，邮箱=${u.email}，创建时间=${createdAt}`;
        };

        return tool(
          async ({
            action,
            id,
            name,
            email,
          }: {
            action: 'create' | 'list' | 'get' | 'update' | 'delete';
            id?: number;
            name?: string;
            email?: string;
          }) => {
            switch (action) {
              case 'create': {
                if (!name || !email) {
                  return '创建用户需要同时提供 name 和 email。';
                }
                const created = await usersService.create({ name, email });
                return `已创建用户：${formatUser(created)}`;
              }
              case 'list': {
                const users = await usersService.findAll();
                if (!users.length) {
                  return '数据库中还没有任何用户记录。';
                }
                const lines = users.map((u) => formatUser(u)).join('\n');
                return `当前数据库 users 表中的用户列表：\n${lines}`;
              }
              case 'get': {
                if (!id) {
                  return '查询单个用户需要提供 id。';
                }
                const user = await usersService.findOne(id);
                if (!user) {
                  return `ID 为 ${id} 的用户在数据库中不存在。`;
                }
                return `用户信息：${formatUser(user)}`;
              }
              case 'update': {
                if (!id) {
                  return '更新用户需要提供 id。';
                }
                const payload: { name?: string; email?: string } = {};
                if (name !== undefined) payload.name = name;
                if (email !== undefined) payload.email = email;
                if (!Object.keys(payload).length) {
                  return '未提供需要更新的字段（name 或 email），本次不执行更新。';
                }
                const existing = await usersService.findOne(id);
                if (!existing) {
                  return `ID 为 ${id} 的用户在数据库中不存在。`;
                }
                await usersService.update(id, payload);
                const updated = await usersService.findOne(id);
                if (!updated) {
                  return `ID 为 ${id} 的用户更新后查询失败。`;
                }
                return `已更新用户：${formatUser(updated)}`;
              }
              case 'delete': {
                if (!id) {
                  return '删除用户需要提供 id。';
                }
                const existing = await usersService.findOne(id);
                if (!existing) {
                  return `ID 为 ${id} 的用户在数据库中不存在，无需删除。`;
                }
                await usersService.remove(id);
                return `已删除用户：${formatUser(existing)}`;
              }
              default: {
                const unsupported: never = action;
                return `不支持的操作: ${String(unsupported)}`;
              }
            }
          },
          {
            name: 'db_users_crud',
            description:
              '对数据库 users 表执行增删改查操作。通过 action 字段选择 create/list/get/update/delete，并按需提供 id、name、email 等参数。',
            schema: dbUsersCrudArgsSchema,
          },
        );
      },
    },
    UserService,
    AiService,
  ],
})
export class AiModule {}
