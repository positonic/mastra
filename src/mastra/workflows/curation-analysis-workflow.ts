import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { curationAgent } from '../agents/ostrom-agent';

// Each step calls the curation agent with a focused instruction.
// The agent has access to all the curation platform tools, so it can
// retrieve and analyze data as instructed.

async function runAgentStep(prompt: string): Promise<string> {
  const result = await curationAgent.generate(prompt);
  return result.text ?? '';
}

const validateConnection = createStep({
  id: 'validate-connection',
  inputSchema: z.object({
    eventId: z.string().uuid('Event ID must be a valid UUID'),
    analysisType: z.enum(['quality', 'scoring', 'trends', 'comprehensive']).default('comprehensive'),
    includeRecommendations: z.boolean().default(true),
  }),
  outputSchema: z.object({
    eventId: z.string(),
    analysisType: z.string(),
    includeRecommendations: z.boolean(),
    validationReport: z.string(),
  }),
  execute: async ({ inputData }) => {
    const validationReport = await runAgentStep(`
      First, test the connection to the Curation Platform API using test_connection.
      Then validate that the eventId "${inputData.eventId}" exists by attempting to retrieve basic event data.

      Report:
      - API connection status
      - Event validation results
      - Any connectivity or access issues

      If there are any connection problems, provide troubleshooting guidance.
    `);

    return {
      eventId: inputData.eventId,
      analysisType: inputData.analysisType ?? 'comprehensive',
      includeRecommendations: inputData.includeRecommendations ?? true,
      validationReport,
    };
  },
});

const fetchComprehensiveData = createStep({
  id: 'fetch-comprehensive-data',
  inputSchema: z.object({
    eventId: z.string(),
    analysisType: z.string(),
    includeRecommendations: z.boolean(),
    validationReport: z.string(),
  }),
  outputSchema: z.object({
    eventId: z.string(),
    analysisType: z.string(),
    includeRecommendations: z.boolean(),
    dataReport: z.string(),
  }),
  execute: async ({ inputData }) => {
    const dataReport = await runAgentStep(`
      For eventId "${inputData.eventId}", retrieve ALL available data:

      1. Applications: Use get_event_applications to fetch all applications
      2. Evaluation Criteria: Use get_evaluation_criteria to get scoring rubrics
      3. Evaluations: Use get_event_evaluations to get completed assessments
      4. Questions: Use get_application_questions to understand application structure

      For each data source, provide:
      - Count of records retrieved
      - Key data quality indicators
      - Any notable patterns or issues identified
      - Summary of data completeness
    `);

    return {
      eventId: inputData.eventId,
      analysisType: inputData.analysisType,
      includeRecommendations: inputData.includeRecommendations,
      dataReport,
    };
  },
});

const performAnalysis = createStep({
  id: 'perform-analysis',
  inputSchema: z.object({
    eventId: z.string(),
    analysisType: z.string(),
    includeRecommendations: z.boolean(),
    dataReport: z.string(),
  }),
  outputSchema: z.object({
    eventId: z.string(),
    analysisType: z.string(),
    includeRecommendations: z.boolean(),
    analysisReport: z.string(),
  }),
  execute: async ({ inputData }) => {
    const analysisReport = await runAgentStep(`
      Based on the previously retrieved data and analysisType "${inputData.analysisType}", perform detailed analysis.

      For 'quality': Application completeness rates, response quality indicators, missing sections, quality distribution.
      For 'scoring': Score distributions, evaluation consistency, criteria effectiveness, scoring patterns.
      For 'trends': Temporal patterns, evaluation outcome trends, applicant behavior, process improvement opportunities.
      For 'comprehensive': All of the above plus cross-correlations and holistic process assessment.

      Structure your analysis with Key Findings, Detailed Analysis, Notable Patterns, and Data Insights sections.
    `);

    return {
      eventId: inputData.eventId,
      analysisType: inputData.analysisType,
      includeRecommendations: inputData.includeRecommendations,
      analysisReport,
    };
  },
});

const generateRecommendations = createStep({
  id: 'generate-recommendations',
  inputSchema: z.object({
    eventId: z.string(),
    analysisType: z.string(),
    includeRecommendations: z.boolean(),
    analysisReport: z.string(),
  }),
  outputSchema: z.object({
    eventId: z.string(),
    analysisType: z.string(),
    analysisReport: z.string(),
    recommendations: z.string(),
  }),
  execute: async ({ inputData }) => {
    const recommendations = inputData.includeRecommendations
      ? await runAgentStep(`
          Based on your analysis of event "${inputData.eventId}", generate specific, actionable recommendations
          organized by category: Application Process, Evaluation Process, System & Technology, Policy & Procedures.
          Rank by impact/effort matrix and include success metrics.
        `)
      : 'Recommendations skipped (includeRecommendations=false).';

    return {
      eventId: inputData.eventId,
      analysisType: inputData.analysisType,
      analysisReport: inputData.analysisReport,
      recommendations,
    };
  },
});

const createExecutiveSummary = createStep({
  id: 'create-executive-summary',
  inputSchema: z.object({
    eventId: z.string(),
    analysisType: z.string(),
    analysisReport: z.string(),
    recommendations: z.string(),
  }),
  outputSchema: z.object({
    eventId: z.string(),
    analysisType: z.string(),
    executiveSummary: z.string(),
  }),
  execute: async ({ inputData }) => {
    const executiveSummary = await runAgentStep(`
      Create a comprehensive executive summary for event "${inputData.eventId}" (analysis type: ${inputData.analysisType}).

      Include: Executive Overview, Key Metrics Dashboard, Critical Findings, Priority Recommendations,
      Risk Areas, and Next Steps. Make it suitable for executive review and decision-making.
    `);

    return {
      eventId: inputData.eventId,
      analysisType: inputData.analysisType,
      executiveSummary,
    };
  },
});

export const analyzeApplicationsWorkflow = createWorkflow({
  id: 'analyze-curation-applications',
  inputSchema: z.object({
    eventId: z.string().uuid('Event ID must be a valid UUID'),
    analysisType: z.enum(['quality', 'scoring', 'trends', 'comprehensive']).default('comprehensive'),
    includeRecommendations: z.boolean().default(true),
  }),
  outputSchema: z.object({
    eventId: z.string(),
    analysisType: z.string(),
    executiveSummary: z.string(),
  }),
})
  .then(validateConnection)
  .then(fetchComprehensiveData)
  .then(performAnalysis)
  .then(generateRecommendations)
  .then(createExecutiveSummary)
  .commit();
