import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailerService } from '@nestjs-modules/mailer';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod';

@Injectable()
export class SendMailToolService {
  readonly tool: DynamicStructuredTool;

  constructor(
    private readonly mailerService: MailerService,
    private readonly configService: ConfigService,
  ) {
    const sendMailArgsSchema = z.object({
      to: z.email().describe('Recipient email, e.g. someone@example.com'),
      subject: z.string().describe('Email subject'),
      text: z.string().optional().describe('Plain text body'),
      html: z.string().optional().describe('HTML body'),
    });

    this.tool = tool(
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
        const fallbackFrom = this.configService.get<string>('MAIL_FROM');

        await this.mailerService.sendMail({
          to,
          subject,
          text: text ?? '(no text)',
          html: html ?? `<p>${text ?? '(no HTML)'}</p>`,
          from: fallbackFrom,
        });

        return `Email sent to ${to}, subject: "${subject}"`;
      },
      {
        name: 'send_mail',
        description:
          'Send email. Requires to, subject; optional text and html body.',
        schema: sendMailArgsSchema,
      },
    );
  }
}
