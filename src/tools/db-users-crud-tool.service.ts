import { Injectable } from '@nestjs/common';
import { DynamicStructuredTool, tool } from '@langchain/core/tools';
import { z } from 'zod';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';

@Injectable()
export class DbUsersCrudToolService {
  readonly tool: DynamicStructuredTool;

  constructor(private readonly usersService: UsersService) {
    const dbUsersCrudArgsSchema = z.object({
      action: z
        .enum(['create', 'list', 'get', 'update', 'delete'])
        .describe('Operation: create, list, get, update, delete'),
      id: z.number().int().positive().optional().describe('User ID'),
      name: z.string().min(1).max(50).optional().describe('User name'),
      email: z.email().max(50).optional().describe('User email'),
    });

    const formatUser = (u: User) =>
      `ID=${u.id}, name=${u.name}, email=${u.email}, createdAt=${u.createdAt instanceof Date ? u.createdAt.toISOString() : ''}`;

    this.tool = tool(
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
              return 'create requires both name and email.';
            }
            const created = await this.usersService.create({ name, email });
            return `User created: ${formatUser(created)}`;
          }
          case 'list': {
            const users = await this.usersService.findAll();
            if (!users.length) return 'No users in database.';
            return `Users:\n${users.map((u) => formatUser(u)).join('\n')}`;
          }
          case 'get': {
            if (!id) return 'get requires id.';
            const user = await this.usersService.findOne(id);
            if (!user) return `User id=${id} not found.`;
            return `User: ${formatUser(user)}`;
          }
          case 'update': {
            if (!id) return 'update requires id.';
            const payload: { name?: string; email?: string } = {};
            if (name !== undefined) payload.name = name;
            if (email !== undefined) payload.email = email;
            if (!Object.keys(payload).length) {
              return 'update requires name or email.';
            }
            const existing = await this.usersService.findOne(id);
            if (!existing) return `User id=${id} not found.`;
            await this.usersService.update(id, payload);
            const updated = await this.usersService.findOne(id);
            if (!updated) return `User id=${id} not found after update.`;
            return `User updated: ${formatUser(updated)}`;
          }
          case 'delete': {
            if (!id) return 'delete requires id.';
            const existing = await this.usersService.findOne(id);
            if (!existing) return `User id=${id} not found.`;
            await this.usersService.remove(id);
            return `User deleted: ${formatUser(existing)}`;
          }
          default:
            return `Unsupported action: ${String(action)}`;
        }
      },
      {
        name: 'db_users_crud',
        description:
          'CRUD on MySQL users table via action: create/list/get/update/delete.',
        schema: dbUsersCrudArgsSchema,
      },
    );
  }
}
