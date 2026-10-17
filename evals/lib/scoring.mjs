import { z } from 'zod';

const TOOL_ARGUMENT_SCHEMAS = {
  knowledge_search: z.object({
    query: z.string().min(1),
    topK: z.number().int().min(1).max(20).optional(),
  }),
  web_search: z.object({
    query: z.string().min(1),
    count: z.number().int().min(1).max(20).optional(),
  }),
  send_mail: z.object({
    to: z.email(),
    subject: z.string(),
    text: z.string().optional(),
    html: z.string().optional(),
  }),
  query_user: z.object({ userId: z.string() }),
  db_users_crud: z.object({
    action: z.enum(['create', 'list', 'get', 'update', 'delete']),
    id: z.number().int().positive().optional(),
    name: z.string().min(1).max(50).optional(),
    email: z.email().max(50).optional(),
  }),
  cron_job: z.object({
    action: z.enum(['list', 'add', 'toggle']),
    id: z.string().optional(),
    enabled: z.boolean().optional(),
    type: z.enum(['cron', 'every', 'at']).optional(),
    instruction: z.string().optional(),
    cron: z.string().optional(),
    everyMs: z.number().int().positive().optional(),
    at: z.string().optional(),
  }),
};

export function scoreRagCase(testCase, hits) {
  const relevant = new Set(testCase.relevant_sources);
  const firstRelevant = hits.findIndex((hit) => relevant.has(hit.source));
  const recallAt = (k) =>
    hits.slice(0, k).some((hit) => relevant.has(hit.source)) ? 1 : 0;
  const combinedText = hits
    .map((hit) => String(hit.text || ''))
    .join('\n')
    .toLowerCase();
  const matchedEvidence = testCase.expected_evidence.filter((evidence) =>
    combinedText.includes(evidence.toLowerCase()),
  );
  return {
    recall_at_1: recallAt(1),
    recall_at_3: recallAt(3),
    recall_at_5: recallAt(5),
    reciprocal_rank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
    evidence_coverage:
      matchedEvidence.length / testCase.expected_evidence.length,
    matched_evidence: matchedEvidence,
  };
}

function parseArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normalizeToolCalls(prediction = {}) {
  if (Array.isArray(prediction.tool_calls)) {
    return prediction.tool_calls.map((call) => ({
      name: call.name || call.tool || call.selected_tool || 'invalid_tool',
      arguments: parseArguments(call.arguments ?? call.args),
    }));
  }
  if (!prediction.selected_tool || prediction.selected_tool === 'no_tool') {
    return [];
  }
  return [
    {
      name: prediction.selected_tool,
      arguments: parseArguments(prediction.arguments),
    },
  ];
}

function conditionalArgumentErrors(toolName, args) {
  if (toolName === 'db_users_crud') {
    if (args.action === 'create' && (!args.name || !args.email)) {
      return ['create requires name and email'];
    }
    if (['get', 'update', 'delete'].includes(args.action) && !args.id) {
      return [`${args.action} requires id`];
    }
    if (
      args.action === 'update' &&
      args.name === undefined &&
      args.email === undefined
    ) {
      return ['update requires name or email'];
    }
  }

  if (toolName === 'cron_job') {
    if (args.action === 'toggle' && !args.id) return ['toggle requires id'];
    if (args.action === 'add') {
      const errors = [];
      if (!args.type) errors.push('add requires type');
      if (!args.instruction) errors.push('add requires instruction');
      if (args.type === 'cron' && !args.cron) errors.push('cron requires cron');
      if (args.type === 'every' && !args.everyMs)
        errors.push('every requires everyMs');
      if (args.type === 'at') {
        if (!args.at) errors.push('at requires at');
        else if (Number.isNaN(new Date(args.at).getTime()))
          errors.push('at must be a valid datetime');
      }
      return errors;
    }
  }
  return [];
}

export function validateToolArguments(toolName, args) {
  const schema = TOOL_ARGUMENT_SCHEMAS[toolName];
  if (!schema) return { valid: false, errors: ['unknown tool'] };
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`,
      ),
    };
  }
  const errors = conditionalArgumentErrors(toolName, parsed.data);
  return { valid: errors.length === 0, errors };
}

function matchesExpectedArguments(actual, expected = {}) {
  return Object.entries(expected).every(
    ([name, value]) => actual[name] === value,
  );
}

export function scoreToolCases(cases, predictions, classes) {
  const byId = new Map(
    predictions.map((prediction) => [prediction.id, prediction]),
  );
  const predictedLabels = [...classes, 'invalid_tool'];
  const confusion = Object.fromEntries(
    classes.map((expected) => [
      expected,
      Object.fromEntries(predictedLabels.map((predicted) => [predicted, 0])),
    ]),
  );
  let correct = 0;
  let taskSuccessCount = 0;
  let schemaValidCount = 0;
  let emittedCalls = 0;
  let multipleToolCallCount = 0;
  let forbiddenToolViolationCount = 0;
  let exactArgumentMatchCount = 0;
  let exactArgumentLabelCount = 0;
  const caseResults = [];

  for (const testCase of cases) {
    const prediction = byId.get(testCase.id) || {};
    const calls = normalizeToolCalls(prediction);
    const selected = calls.length ? calls[0].name : 'no_tool';
    const predictedLabel = classes.includes(selected)
      ? selected
      : 'invalid_tool';
    confusion[testCase.expected_tool][predictedLabel] += 1;

    const multipleToolCalls = calls.length > 1;
    if (multipleToolCalls) multipleToolCallCount += 1;
    const selectionValid =
      testCase.expected_tool === 'no_tool'
        ? calls.length === 0
        : calls.length === 1 && selected === testCase.expected_tool;
    if (selectionValid) correct += 1;

    const forbiddenToolCalled = calls.some((call) =>
      (testCase.forbidden_tools || []).includes(call.name),
    );
    if (forbiddenToolCalled) forbiddenToolViolationCount += 1;

    const schemaChecks = calls.map((call) => ({
      tool: call.name,
      ...validateToolArguments(call.name, call.arguments),
    }));
    emittedCalls += calls.length;
    schemaValidCount += schemaChecks.filter((check) => check.valid).length;

    const expectedCall =
      calls.length === 1 && selected === testCase.expected_tool
        ? calls[0]
        : null;
    const requiredArgumentsValid =
      testCase.expected_tool === 'no_tool'
        ? calls.length === 0
        : Boolean(
            expectedCall &&
            testCase.required_arguments.every(
              (name) => expectedCall.arguments[name] !== undefined,
            ),
          );

    const hasExpectedArguments =
      testCase.expected_arguments &&
      Object.keys(testCase.expected_arguments).length > 0;
    if (hasExpectedArguments) exactArgumentLabelCount += 1;
    const exactArgumentsValid = hasExpectedArguments
      ? Boolean(
          expectedCall &&
          matchesExpectedArguments(
            expectedCall.arguments,
            testCase.expected_arguments,
          ),
        )
      : true;
    if (hasExpectedArguments && exactArgumentsValid)
      exactArgumentMatchCount += 1;

    const schemasValid = schemaChecks.every((check) => check.valid);
    const taskSuccess =
      selectionValid &&
      requiredArgumentsValid &&
      exactArgumentsValid &&
      schemasValid &&
      !forbiddenToolCalled;
    if (taskSuccess) taskSuccessCount += 1;

    caseResults.push({
      id: testCase.id,
      expected_tool: testCase.expected_tool,
      predicted_tool: predictedLabel,
      tool_call_count: calls.length,
      selection_valid: selectionValid,
      required_arguments_valid: requiredArgumentsValid,
      exact_arguments_valid: exactArgumentsValid,
      schema_valid: schemasValid,
      forbidden_tool_called: forbiddenToolCalled,
      task_success: taskSuccess,
      schema_errors: schemaChecks.flatMap((check) =>
        check.errors.map((error) => `${check.tool}: ${error}`),
      ),
    });
  }

  const perClass = {};
  for (const label of classes) {
    const tp = confusion[label][label];
    const fp = classes.reduce(
      (sum, expected) =>
        sum + (expected === label ? 0 : confusion[expected][label]),
      0,
    );
    const fn = predictedLabels.reduce(
      (sum, predicted) =>
        sum + (predicted === label ? 0 : confusion[label][predicted]),
      0,
    );
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    perClass[label] = {
      precision,
      recall,
      f1:
        precision + recall
          ? (2 * precision * recall) / (precision + recall)
          : 0,
    };
  }
  const average = (field) =>
    classes.reduce((sum, label) => sum + perClass[label][field], 0) /
    classes.length;
  return {
    selection_accuracy: cases.length ? correct / cases.length : 0,
    routing_task_success: cases.length ? taskSuccessCount / cases.length : 0,
    macro_precision: average('precision'),
    macro_recall: average('recall'),
    macro_f1: average('f1'),
    schema_validity: emittedCalls ? schemaValidCount / emittedCalls : 1,
    exact_argument_match: exactArgumentLabelCount
      ? exactArgumentMatchCount / exactArgumentLabelCount
      : 1,
    exact_argument_labeled_cases: exactArgumentLabelCount,
    multiple_tool_call_count: multipleToolCallCount,
    forbidden_tool_violation_count: forbiddenToolViolationCount,
    per_class: perClass,
    confusion_matrix: confusion,
    case_results: caseResults,
  };
}
