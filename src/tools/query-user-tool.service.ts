import { Injectable } from '@nestjs/common';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { UserService } from '../ai/user.service';

@Injectable()
export class QueryUserToolService {
  readonly tool: DynamicStructuredTool;

  constructor(private readonly userService: UserService) {
    const queryUserArgsSchema = z.object({
      userId: z.string().describe('User ID, e.g. 001, 002, 003'),
    });

    this.tool = tool(
      async ({ userId }: { userId: string }) => {
        const user = await Promise.resolve(this.userService.findOne(userId));

        if (!user) {
          const availableIds = this.userService
            .findAll()
            .map((u) => u.id)
            .join(', ');

          return `User ID ${userId} not found. Available IDs: ${availableIds}`;
        }

        return `User info:\n- ID: ${user.id}\n- Name: ${user.name}\n- Email: ${user.email}\n- Role: ${user.role}`;
      },
      {
        name: 'query_user',
        description:
          'Look up in-memory demo users by ID. Returns name, email, and role.',
        schema: queryUserArgsSchema,
      },
    );
  }
}
