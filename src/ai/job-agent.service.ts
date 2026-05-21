import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChatOpenAI } from '@langchain/openai';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import {
  AI_MODEL,
  DB_USERS_CRUD_TOOL,
  SEND_MAIL_TOOL,
  TIME_NOW_TOOL,
  WEB_SEARCH_TOOL,
} from './ai.tokens';

const JOB_AGENT_SYSTEM_PROMPT = `You are a background task agent. Follow the given instruction and call tools when needed (db_users_crud, send_mail, web_search, time_now). Summarize steps and results clearly. Do not claim you cannot use these tools.`;

function toolResultContent(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result);
}

function aiMessageText(content: AIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  return JSON.stringify(content);
}

@Injectable()
export class JobAgentService {
  private readonly logger = new Logger(JobAgentService.name);
  private readonly modelWithTools: Runnable<BaseMessage[], AIMessage>;

  constructor(
    @Inject(AI_MODEL) model: ChatOpenAI,
    @Inject(SEND_MAIL_TOOL)
    private readonly sendMailTool: DynamicStructuredTool,
    @Inject(WEB_SEARCH_TOOL)
    private readonly webSearchTool: DynamicStructuredTool,
    @Inject(DB_USERS_CRUD_TOOL)
    private readonly dbUsersCrudTool: DynamicStructuredTool,
    @Inject(TIME_NOW_TOOL)
    private readonly timeNowTool: DynamicStructuredTool,
  ) {
    this.modelWithTools = model.bindTools([
      this.sendMailTool,
      this.webSearchTool,
      this.dbUsersCrudTool,
      this.timeNowTool,
    ]);
  }

  async runJob(instruction: string): Promise<string> {
    const messages: BaseMessage[] = [
      new SystemMessage(JOB_AGENT_SYSTEM_PROMPT),
      new HumanMessage(instruction),
    ];

    while (true) {
      const aiMessage = await this.modelWithTools.invoke(messages);
      messages.push(aiMessage);

      const toolCalls = aiMessage.tool_calls ?? [];

      if (!toolCalls.length) {
        return aiMessageText(aiMessage.content);
      }

      for (const toolCall of toolCalls) {
        const toolCallId = toolCall.id || '';
        const toolName = toolCall.name;
        const toolArgs: unknown = toolCall.args;

        if (toolName === 'send_mail') {
          const result: unknown = await this.sendMailTool.invoke(toolArgs);
          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: toolResultContent(result),
            }),
          );
        } else if (toolName === 'web_search') {
          const result: unknown = await this.webSearchTool.invoke(toolArgs);
          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: toolResultContent(result),
            }),
          );
        } else if (toolName === 'db_users_crud') {
          const result: unknown = await this.dbUsersCrudTool.invoke(toolArgs);
          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: toolResultContent(result),
            }),
          );
        } else if (toolName === 'time_now') {
          const result: unknown = await this.timeNowTool.invoke({});
          messages.push(
            new ToolMessage({
              tool_call_id: toolCallId,
              name: toolName,
              content: toolResultContent(result),
            }),
          );
        } else {
          this.logger.warn(`Unknown tool call: ${toolName}`);
        }
      }
    }
  }
}
