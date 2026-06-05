import { Injectable } from '@nestjs/common';

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
};

@Injectable()
export class UserService {
  private readonly users = new Map<string, User>([
    [
      '001',
      {
        id: '001',
        name: 'Zhao Yun',
        email: 'zhaoyun@example.com',
        role: 'admin',
      },
    ],
    [
      '002',
      {
        id: '002',
        name: 'Zhuge Liang',
        email: 'zhugeliang@example.com',
        role: 'manager',
      },
    ],
    [
      '003',
      {
        id: '003',
        name: 'Guan Yu',
        email: 'guanyu@example.com',
        role: 'user',
      },
    ],
    [
      '004',
      {
        id: '004',
        name: 'Zhang Fei',
        email: 'zhangfei@example.com',
        role: 'user',
      },
    ],
    [
      '005',
      {
        id: '005',
        name: 'Liu Bei',
        email: 'liubei@example.com',
        role: 'owner',
      },
    ],
    [
      '006',
      {
        id: '006',
        name: 'Huang Zhong',
        email: 'huangzhong@example.com',
        role: 'user',
      },
    ],
  ]);

  findAll(): User[] {
    return Array.from(this.users.values());
  }

  findOne(id: string): User | undefined {
    return this.users.get(id);
  }

  create(user: User): User {
    this.users.set(user.id, user);
    return user;
  }

  update(id: string, partial: Partial<Omit<User, 'id'>>): User | undefined {
    const existing = this.users.get(id);
    if (!existing) {
      return undefined;
    }

    const updated: User = {
      ...existing,
      ...partial,
      id: existing.id,
    };

    this.users.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.users.delete(id);
  }
}
