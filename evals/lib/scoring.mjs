export function scoreRagCase(testCase, hits) {
  const relevant = new Set(testCase.relevant_sources);
  const firstRelevant = hits.findIndex((hit) => relevant.has(hit.source));
  const recallAt = (k) =>
    hits.slice(0, k).some((hit) => relevant.has(hit.source)) ? 1 : 0;
  const combinedText = hits.map((hit) => String(hit.text || '')).join('\n').toLowerCase();
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

export function scoreToolCases(cases, predictions, classes) {
  const byId = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  const confusion = Object.fromEntries(
    classes.map((expected) => [
      expected,
      Object.fromEntries(classes.map((predicted) => [predicted, 0])),
    ]),
  );
  let correct = 0;
  let schemaValidCount = 0;
  let emittedCalls = 0;

  for (const testCase of cases) {
    const prediction = byId.get(testCase.id) || {
      selected_tool: 'no_tool',
      arguments: {},
    };
    const selected = prediction.selected_tool;
    confusion[testCase.expected_tool][selected] += 1;
    if (selected === testCase.expected_tool) correct += 1;
    if (selected !== 'no_tool') {
      emittedCalls += 1;
      const args = prediction.arguments || {};
      if (testCase.required_arguments.every((name) => args[name] !== undefined)) {
        schemaValidCount += 1;
      }
    }
  }

  const perClass = {};
  for (const label of classes) {
    const tp = confusion[label][label];
    const fp = classes.reduce(
      (sum, expected) => sum + (expected === label ? 0 : confusion[expected][label]),
      0,
    );
    const fn = classes.reduce(
      (sum, predicted) => sum + (predicted === label ? 0 : confusion[label][predicted]),
      0,
    );
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    perClass[label] = {
      precision,
      recall,
      f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
    };
  }
  const average = (field) =>
    classes.reduce((sum, label) => sum + perClass[label][field], 0) /
    classes.length;
  return {
    selection_accuracy: cases.length ? correct / cases.length : 0,
    macro_precision: average('precision'),
    macro_recall: average('recall'),
    macro_f1: average('f1'),
    schema_validity: emittedCalls ? schemaValidCount / emittedCalls : 1,
    per_class: perClass,
    confusion_matrix: confusion,
  };
}
