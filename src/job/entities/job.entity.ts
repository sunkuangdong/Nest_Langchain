import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type JobType = 'cron' | 'every' | 'at';

@Entity()
export class Job {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' })
  instruction: string;

  @Column({ type: 'varchar', length: 10, default: 'cron' })
  type: JobType;

  /** cron type: Cron expression */
  @Column({ type: 'varchar', length: 100, nullable: true })
  cron: string | null;

  /** every type: interval in milliseconds */
  @Column({ type: 'int', nullable: true })
  everyMs: number | null;

  /** at type: one-shot trigger time */
  @Column({ type: 'timestamp', nullable: true })
  at: Date | null;

  @Column({ default: true })
  isEnabled: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastRun: Date | null;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;
}
