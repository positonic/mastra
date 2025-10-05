import { Workflow, Step } from '@mastra/core';
import { z } from 'zod';
import { curationAgent } from '../agents/curation-agent';

export const analyzeApplicationsWorkflow = new Workflow({
  name: 'Analyze Curation Applications',
  triggerSchema: z.object({
    eventId: z.string().uuid('Event ID must be a valid UUID'),
    analysisType: z.enum(['quality', 'scoring', 'trends', 'comprehensive']).default('comprehensive'),
    includeRecommendations: z.boolean().default(true)
  })
});

// Step 1: Test connection and validate event
analyzeApplicationsWorkflow.step('validate-connection', {
  agent: curationAgent,
  instruction: `
    First, test the connection to the Curation Platform API using test_connection.
    Then validate that the provided eventId exists by attempting to retrieve basic event data.
    
    Report:
    - API connection status
    - Event validation results
    - Any connectivity or access issues
    
    If there are any connection problems, provide troubleshooting guidance.
  `
});

// Step 2: Comprehensive data retrieval
analyzeApplicationsWorkflow.step('fetch-comprehensive-data', {
  agent: curationAgent,
  instruction: `
    For the given eventId, retrieve ALL available data:
    
    1. **Applications**: Use get_event_applications to fetch all applications
    2. **Evaluation Criteria**: Use get_evaluation_criteria to get scoring rubrics
    3. **Evaluations**: Use get_event_evaluations to get completed assessments
    4. **Questions**: Use get_application_questions to understand application structure
    
    For each data source, provide:
    - Count of records retrieved
    - Key data quality indicators
    - Any notable patterns or issues identified
    - Summary of data completeness
    
    Structure your response as:
    ## Data Retrieval Summary
    - **Applications**: [count] applications retrieved
    - **Evaluation Criteria**: [details about criteria structure]
    - **Evaluations**: [count] evaluations retrieved  
    - **Questions**: [summary of application structure]
    
    ## Initial Data Quality Assessment
    [Brief assessment of data completeness and quality]
  `
});

// Step 3: Perform targeted analysis based on type
analyzeApplicationsWorkflow.step('perform-analysis', {
  agent: curationAgent,
  instruction: `
    Based on the retrieved data and the requested analysisType, perform detailed analysis:

    **For 'quality' analysis:**
    - Application completeness rates
    - Response quality indicators  
    - Missing or incomplete sections
    - Overall application quality distribution

    **For 'scoring' analysis:**
    - Score distributions across criteria
    - Evaluation consistency metrics
    - Criteria effectiveness assessment
    - Scoring patterns and anomalies

    **For 'trends' analysis:**
    - Temporal patterns in applications
    - Evaluation outcome trends
    - Applicant behavior patterns
    - Process improvement opportunities

    **For 'comprehensive' analysis:**
    - All of the above plus cross-correlations
    - Holistic process assessment
    - End-to-end evaluation effectiveness

    Structure your analysis with:
    ## Analysis Results: [Analysis Type]
    
    ### Key Findings
    [3-5 bullet points of major findings]
    
    ### Detailed Analysis
    [In-depth analysis with specific data points]
    
    ### Notable Patterns
    [Interesting patterns or anomalies discovered]
    
    ### Data Insights
    [Actionable insights derived from the data]
  `
});

// Step 4: Generate actionable recommendations
analyzeApplicationsWorkflow.step('generate-recommendations', {
  agent: curationAgent,
  instruction: `
    Based on your analysis, generate specific, actionable recommendations organized by category:

    ## Process Improvement Recommendations

    ### Application Process
    - Specific improvements for application forms/questions
    - User experience enhancements
    - Guidance improvements for applicants

    ### Evaluation Process  
    - Criteria refinements or adjustments
    - Evaluator training recommendations
    - Consistency improvements

    ### System & Technology
    - Platform enhancements
    - Data collection improvements
    - Reporting and analytics suggestions

    ### Policy & Procedures
    - Process policy recommendations
    - Quality assurance improvements
    - Best practice implementations

    ## Implementation Priorities
    Rank recommendations by:
    1. **High Impact, Low Effort** (Quick wins)
    2. **High Impact, High Effort** (Strategic initiatives)
    3. **Low Impact, Low Effort** (Easy improvements)

    ## Success Metrics
    For each major recommendation, suggest:
    - How to measure success
    - Expected improvement targets
    - Timeline for implementation

    Make all recommendations specific, measurable, and actionable with clear next steps.
  `
});

// Step 5: Create executive summary
analyzeApplicationsWorkflow.step('create-executive-summary', {
  agent: curationAgent,
  instruction: `
    Create a comprehensive executive summary that synthesizes all previous analysis:

    # Curation Platform Analysis Executive Summary
    **Event ID:** [eventId]
    **Analysis Type:** [analysisType]
    **Analysis Date:** [current date]

    ## Executive Overview
    [2-3 paragraph high-level summary of key findings and recommendations]

    ## Key Metrics Dashboard
    - **Applications Analyzed:** [count]
    - **Evaluations Reviewed:** [count]  
    - **Completion Rate:** [percentage]
    - **Average Score:** [if applicable]
    - **Quality Score:** [derived metric]

    ## Critical Findings
    [Top 3-5 most important discoveries]

    ## Priority Recommendations
    [Top 3 recommendations with expected impact]

    ## Risk Areas
    [Any identified risks or concerns requiring immediate attention]

    ## Next Steps
    [Specific action items with ownership and timelines]

    ## Appendices Reference
    - Detailed analysis in Step 3 results
    - Complete recommendations in Step 4 results
    - Raw data summaries in Step 2 results

    This summary should be suitable for executive review and decision-making.
  `
});

// Optional: Export data step for further analysis
analyzeApplicationsWorkflow.step('prepare-data-export', {
  agent: curationAgent,
  instruction: `
    Prepare a summary of key data points that could be exported for further analysis:

    ## Data Export Summary

    ### Recommended Export Formats
    - **CSV**: Application and evaluation data for spreadsheet analysis
    - **JSON**: Complete data structures for system integration
    - **PDF**: Executive summary and recommendations for distribution

    ### Key Data Points for Export
    - Application completion metrics
    - Evaluation score distributions  
    - Criteria performance data
    - Trend analysis data points

    ### Data Privacy Considerations
    - Identify any PII that should be redacted
    - Suggest anonymization approaches
    - Compliance recommendations

    This step provides guidance for data export but does not actually export data.
  `
});

export { analyzeApplicationsWorkflow };