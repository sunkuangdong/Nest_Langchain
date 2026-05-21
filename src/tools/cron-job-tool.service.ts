import { Injectable } from '@nestjs/common';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { Job } from '../job/entities/job.entity';
import { JobService } from '../job/job.service';

type JobListItem = Job & { running: boolean };

@Injectable()
export class CronJobToolService {
  readonly tool: DynamicStructuredTool;

  constructor(private readonly jobService: JobService) {
    const formatAt = (value: Date | string | null | undefined) => {
      if (value instanceof Date) return value.toISOString();
      return value ?? '';
    };

    const formatJobLine = (j: JobListItem) =>
      `id=${j.id} type=${j.type} enabled=${j.isEnabled} running=${j.running} cron=${j.cron ?? ''} everyMs=${j.everyMs ?? ''} at=${formatAt(j.at)} instruction=${j.instruction ?? ''}`;

    const cronJobArgsSchema = z.object({
      action: z
        .enum(['list', 'add', 'toggle'])
        .describe('Operation: list, add, or toggle'),
      id: z.string().optional().describe('Job ID (required for toggle)'),
      enabled: z
        .boolean()
        .optional()
        .describe('Enable flag for toggle (optional; toggles when omitted)'),
      type: z
        .enum(['cron', 'every', 'at'])
        .optional()
        .describe('Job type for add: cron, every, or at'),
      instruction: z
        .string()
        .optional()
        .describe('Task instruction for add (natural language only)'),
      cron: z.string().optional().describe('Cron expression when type=cron'),
      everyMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Interval ms when type=every'),
      at: z.string().optional().describe('ISO datetime when type=at'),
    });

    this.tool = tool(
      async ({
        action,
        id,
        enabled,
        type,
        instruction,
        cron,
        everyMs,
        at,
      }: {
        action: 'list' | 'add' | 'toggle';
        id?: string;
        enabled?: boolean;
        type?: 'cron' | 'every' | 'at';
        instruction?: string;
        cron?: string;
        everyMs?: number;
        at?: string;
      }) => {
        switch (action) {
          case 'list': {
            const jobs = await this.jobService.listJobs();
            if (!jobs.length) return 'No scheduled jobs found.';
            return `Scheduled jobs:\n${jobs.map((j) => formatJobLine(j)).join('\n')}`;
          }
          case 'add': {
            if (!type) return 'add requires type (cron/every/at).';
            if (!instruction) return 'add requires instruction.';

            if (type === 'cron') {
              if (!cron) return 'type=cron requires cron.';
              const created = await this.jobService.addJob({
                type,
                instruction,
                cron,
                isEnabled: true,
              });
              return `Job created: id=${created.id} type=cron cron=${created.cron} enabled=${created.isEnabled}`;
            }

            if (type === 'every') {
              if (typeof everyMs !== 'number' || everyMs <= 0) {
                return 'type=every requires everyMs (positive integer, ms).';
              }
              const created = await this.jobService.addJob({
                type,
                instruction,
                everyMs,
                isEnabled: true,
              });
              return `Job created: id=${created.id} type=every everyMs=${created.everyMs} enabled=${created.isEnabled}`;
            }

            if (type === 'at') {
              if (!at) return 'type=at requires at (ISO datetime string).';
              const date = new Date(at);
              if (Number.isNaN(date.getTime())) {
                return 'type=at: at is not a valid ISO datetime string.';
              }
              const created = await this.jobService.addJob({
                type,
                instruction,
                at: date,
                isEnabled: true,
              });
              const atIso =
                created.at instanceof Date ? created.at.toISOString() : '';
              return `Job created: id=${created.id} type=at at=${atIso} enabled=${created.isEnabled}`;
            }

            return `Unsupported job type: ${String(type)}`;
          }
          case 'toggle': {
            if (!id) return 'toggle requires id.';
            const updated = await this.jobService.toggleJob(id, enabled);
            return `Job updated: id=${updated.id} enabled=${updated.isEnabled}`;
          }
          default:
            return `Unsupported action: ${String(action)}`;
        }
      },
      {
        name: 'cron_job',
        description: 'Manage server-side scheduled jobs (list/add/toggle).',
        schema: cronJobArgsSchema,
      },
    );
  }
}
