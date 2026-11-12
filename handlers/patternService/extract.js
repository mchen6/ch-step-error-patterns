'use strict';
// ch-step-error-patterns/patternService.extract: {steps, maxLines?} ->
// {failingStep, lines, truncated}.
const {extractErrors} = require('../../lib/patterns');

const DEFAULT_MAX = 40;
const MAX = 200;

const isStep = (s) => s != null && typeof s.name === 'string' && Array.isArray(s.lines) && s.lines.every((l) => typeof l === 'string');

module.exports = async (input) => {
  const steps = input != null ? input.steps : null;
  if (!Array.isArray(steps) || !steps.every(isStep)) {
    throw new DeviceError('ARGUMENTS_INVALID', 'steps must be an array of {name: string, lines: string[]}, as ch-step-log-clean returns it');
  }
  const maxLines = input.maxLines === undefined ? DEFAULT_MAX : input.maxLines;
  if (!Number.isInteger(maxLines) || maxLines < 1 || maxLines > MAX) {
    throw new DeviceError('ARGUMENTS_INVALID', `maxLines must be an integer from 1 to ${MAX}`);
  }
  const stepConclusions = input.stepConclusions;
  if (stepConclusions !== undefined && !(Array.isArray(stepConclusions)
    && stepConclusions.every((c) => c != null && typeof c.name === 'string' && (c.conclusion === null || typeof c.conclusion === 'string')))) {
    throw new DeviceError('ARGUMENTS_INVALID', 'stepConclusions must be [{name, conclusion}], the job\'s steps as the jobs API lists them');
  }
  return {output: extractErrors(steps, maxLines, stepConclusions)};
};
