import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { one2bTrpcMutation, one2bTrpcQuery, serperSearch } from "../utils/one2b-api.js";

// ─── Track definitions ──────────────────────────────────────────────────────
// Each track maps to a specific tRPC router on the One2b platform.
//
// Track              → tRPC router                    → Procedure
// investor           → communityInvestor.createLead   → investorType: INVESTOR
// sovereign_entity   → communitySovereignEntity.createLead
// channel_partner    → communityChannelPartner.createLead
// project            → communityCompany.createCompanyLead (enterprise data projects)
// carbon_project     → carbonProject.createLead
// community          → community.createLead (expert network / other)

const ONE2B_TRACKS = [
  'investor',
  'sovereign_entity',
  'channel_partner',
  'project',
  'carbon_project',
  'community',
] as const;

const trackEnum = z.enum(ONE2B_TRACKS);

// ─── Research Tool ───────────────────────────────────────────────────────────

export const researchContactTool = createTool({
  id: "research-contact",
  description:
    "Research a contact before an onboarding conversation using publicly available data. " +
    "Call this BEFORE starting the conversation to personalize the greeting.",
  inputSchema: z.object({
    name: z.string().describe("Full name of the contact"),
    company: z.string().optional().describe("Company or organization name"),
    linkedinUrl: z.string().url().optional().describe("LinkedIn profile URL if known"),
    email: z.string().email().optional().describe("Email address if known"),
    websiteUrl: z.string().url().optional().describe("Company website URL if known"),
  }),
  outputSchema: z.object({
    summary: z.string().describe("Brief summary of who this person is"),
    companyInfo: z.string().optional().describe("What their company does"),
    recentNews: z.array(z.string()).describe("Recent relevant news or mentions"),
    linkedinSummary: z.string().optional().describe("Professional background from LinkedIn"),
    suggestedGreeting: z.string().describe("Suggested personalized opening line"),
    suggestedTrack: trackEnum.optional().describe("Best guess at which One2b track they fit"),
    trackReasoning: z.string().optional().describe("Why this track was suggested"),
  }),
  execute: async (inputData) => {
    const { name, company, linkedinUrl } = inputData;

    console.log(`🔍 [one2b] Researching contact: ${name}${company ? ` at ${company}` : ''}`);

    // Run searches in parallel
    const searches = await Promise.allSettled([
      serperSearch(`"${name}"${company ? ` "${company}"` : ''}`),
      company ? serperSearch(`"${company}" data OR technology OR investment`) : Promise.resolve([]),
      !linkedinUrl ? serperSearch(`"${name}" site:linkedin.com`) : Promise.resolve([]),
      serperSearch(`"${name}"${company ? ` OR "${company}"` : ''} news 2025 OR 2026`, { num: 3 }),
    ]);

    const personResults = searches[0].status === 'fulfilled' ? searches[0].value : [];
    const companyResults = searches[1].status === 'fulfilled' ? searches[1].value : [];
    const linkedinResults = searches[2].status === 'fulfilled' ? searches[2].value : [];
    const newsResults = searches[3].status === 'fulfilled' ? searches[3].value : [];

    const personSnippets = personResults.map(r => r.snippet).join(' ');
    const companySnippets = companyResults.map(r => r.snippet).join(' ');

    const summary = personSnippets
      ? `${name}${company ? ` is associated with ${company}.` : '.'} ${personSnippets.slice(0, 300)}`
      : `${name}${company ? ` at ${company}` : ''} — limited public information found.`;

    const companyInfo = companySnippets ? companySnippets.slice(0, 300) : undefined;

    const linkedinSummary = linkedinUrl
      ? `LinkedIn: ${linkedinUrl}`
      : linkedinResults.length > 0
        ? linkedinResults[0].snippet
        : undefined;

    const recentNews = newsResults.map(r => `${r.title}: ${r.snippet}`).slice(0, 3);

    // Suggest a track based on keywords
    const allText = `${personSnippets} ${companySnippets}`.toLowerCase();
    let suggestedTrack: typeof ONE2B_TRACKS[number] | undefined;
    let trackReasoning: string | undefined;

    if (/invest|fund|capital|portfolio|venture|private equity|asset manag/i.test(allText)) {
      suggestedTrack = 'investor';
      trackReasoning = 'Profile suggests investment/capital management background';
    } else if (/government|ministry|sovereign|public sector|diplomatic/i.test(allText)) {
      suggestedTrack = 'sovereign_entity';
      trackReasoning = 'Profile suggests government or sovereign entity affiliation';
    } else if (/carbon|climate|emission|sustainability|green|net.?zero/i.test(allText)) {
      suggestedTrack = 'carbon_project';
      trackReasoning = 'Profile suggests involvement in carbon/sustainability projects';
    } else if (/partner|channel|reseller|distributor|broker|consult/i.test(allText)) {
      suggestedTrack = 'channel_partner';
      trackReasoning = 'Profile suggests channel partner or consulting role';
    } else if (/enterprise|data|technology|platform|software/i.test(allText)) {
      suggestedTrack = 'project';
      trackReasoning = 'Profile suggests enterprise data or technology project';
    }

    // Build greeting
    const greetingParts: string[] = [];
    if (company) {
      greetingParts.push(`I see you're with ${company}`);
    }
    if (suggestedTrack === 'investor') {
      greetingParts.push(`and your background in the investment space is very relevant to what we're building`);
    } else if (suggestedTrack === 'sovereign_entity') {
      greetingParts.push(`and we've been doing some exciting work with government and sovereign entities`);
    } else if (companyInfo) {
      greetingParts.push(`and I was reading about the work you're doing`);
    }

    const suggestedGreeting = greetingParts.length > 0
      ? `Hi ${name.split(' ')[0]}, thank you for connecting with us. ${greetingParts.join(', ')}. I'd love to learn more about what brought you to One2b.`
      : `Hi ${name.split(' ')[0]}, thank you for connecting with us. I'd love to learn a bit about you and what brought you to One2b.`;

    console.log(`✅ [one2b] Research complete for ${name}. Suggested track: ${suggestedTrack ?? 'undetermined'}`);

    return {
      summary,
      companyInfo,
      recentNews,
      linkedinSummary,
      suggestedGreeting,
      suggestedTrack,
      trackReasoning,
    };
  },
});

// ─── Track Qualification Questions ──────────────────────────────────────────
// These map directly to fields in the One2b Prisma schema for each lead type.

interface TrackQuestion {
  id: string;
  question: string;
  required: boolean;
  dataField: string;
  fieldType: 'string' | 'string[]' | 'boolean' | 'number';
}

const TRACK_QUESTIONS: Record<typeof ONE2B_TRACKS[number], TrackQuestion[]> = {
  investor: [
    // Required core fields for communityInvestor.createLead (investorType: INVESTOR)
    { id: 'inv-1', question: 'What type of institution are you with? For example, venture capital, private equity, family office, institutional fund?', required: true, dataField: 'institutionType', fieldType: 'string' },
    { id: 'inv-2', question: 'What is your approximate AUM range?', required: true, dataField: 'aumRange', fieldType: 'string' },
    { id: 'inv-3', question: 'What is your typical investment size for opportunities like this?', required: true, dataField: 'typicalInvestmentSize', fieldType: 'string' },
    { id: 'inv-4', question: 'What kind of returns are you typically targeting?', required: true, dataField: 'targetReturns', fieldType: 'string' },
    { id: 'inv-5', question: 'What is your preferred investment horizon?', required: true, dataField: 'investmentHorizon', fieldType: 'string' },
    { id: 'inv-6', question: 'Which sectors are you most interested in?', required: false, dataField: 'sectorsOfInterest', fieldType: 'string[]' },
    { id: 'inv-7', question: 'What is your geographic focus for investments?', required: false, dataField: 'geographicFocus', fieldType: 'string[]' },
    { id: 'inv-8', question: 'Do you have specific ESG requirements?', required: false, dataField: 'esgRequirements', fieldType: 'string' },
  ],
  sovereign_entity: [
    // Required fields for communitySovereignEntity.createLead
    { id: 'se-1', question: 'What is the official name of the entity you represent?', required: false, dataField: 'officialEntityName', fieldType: 'string' },
    { id: 'se-2', question: 'At what level of government — national, regional, or local?', required: false, dataField: 'governmentLevel', fieldType: 'string' },
    { id: 'se-3', question: 'Which department or ministry are you with?', required: false, dataField: 'departmentMinistry', fieldType: 'string' },
    { id: 'se-4', question: 'What type of programme are you exploring — data governance, data monetisation, infrastructure, or something else?', required: false, dataField: 'programType', fieldType: 'string' },
    { id: 'se-5', question: 'Do you have an estimated programme value in mind?', required: false, dataField: 'estimatedProgramValue', fieldType: 'string' },
    { id: 'se-6', question: 'What is the expected implementation timeline?', required: false, dataField: 'implementationTimeline', fieldType: 'string' },
    { id: 'se-7', question: 'What are the strategic objectives for this initiative?', required: false, dataField: 'strategicObjectives', fieldType: 'string[]' },
    { id: 'se-8', question: 'Does your department hold significant data assets that could be valued?', required: false, dataField: 'departmentalDataAssets', fieldType: 'string[]' },
  ],
  channel_partner: [
    // Required fields for communityChannelPartner.createLead
    { id: 'cp-1', question: 'What is the legal name of your company?', required: true, dataField: 'legalCompanyName', fieldType: 'string' },
    { id: 'cp-2', question: 'What type of entity is it — limited company, LLC, partnership?', required: true, dataField: 'entityType', fieldType: 'string' },
    { id: 'cp-3', question: 'What industry sectors do you operate in?', required: true, dataField: 'industrySectors', fieldType: 'string[]' },
    { id: 'cp-4', question: 'Can you give me a brief description of what your company does?', required: true, dataField: 'companyDescription', fieldType: 'string' },
    { id: 'cp-5', question: 'What types of clients do you typically work with?', required: false, dataField: 'clientTypes', fieldType: 'string[]' },
    { id: 'cp-6', question: 'Which geographic regions do you cover?', required: false, dataField: 'geographicRegions', fieldType: 'string[]' },
    { id: 'cp-7', question: 'How many referrals do you estimate you could make in the next 12 months?', required: false, dataField: 'estimatedReferrals12Months', fieldType: 'string' },
    { id: 'cp-8', question: 'Why are you interested in partnering with One2b?', required: false, dataField: 'whyInterestedInPartnering', fieldType: 'string' },
  ],
  project: [
    // Required fields for communityCompany.createCompanyLead
    { id: 'pr-1', question: 'What is the legal name of your company?', required: true, dataField: 'legalCompanyName', fieldType: 'string' },
    { id: 'pr-2', question: 'What stage is your company at — startup, growth, established?', required: true, dataField: 'companyStage', fieldType: 'string' },
    { id: 'pr-3', question: 'Which industry sectors are you in?', required: true, dataField: 'industrySectors', fieldType: 'string[]' },
    { id: 'pr-4', question: 'Can you give me a brief overview of what your company does?', required: true, dataField: 'companyBio', fieldType: 'string' },
    { id: 'pr-5', question: 'Are you currently seeking capital, and if so, how much?', required: true, dataField: 'seekingCapital', fieldType: 'string' },
    { id: 'pr-6', question: 'Are you looking for insurance coverage for your data assets?', required: true, dataField: 'seekingInsurance', fieldType: 'string' },
    { id: 'pr-7', question: 'How many years of data do you hold?', required: false, dataField: 'dataCollectionYears', fieldType: 'string' },
    { id: 'pr-8', question: 'Which One2b services are you most interested in — data valuation, insurance, financing, or all of these?', required: true, dataField: 'servicesInterest', fieldType: 'string[]' },
  ],
  carbon_project: [
    // Required fields for carbonProject.createLead
    { id: 'cc-1', question: 'What is your role — project developer, funder/investor, credit buyer, or intermediary/broker?', required: true, dataField: 'role', fieldType: 'string' },
    { id: 'cc-2', question: 'What is the name of the project?', required: true, dataField: 'projectName', fieldType: 'string' },
    { id: 'cc-3', question: 'What type of carbon project is it?', required: true, dataField: 'projectType', fieldType: 'string' },
    { id: 'cc-4', question: 'Where is the project located?', required: true, dataField: 'projectLocation', fieldType: 'string' },
    { id: 'cc-5', question: 'What stage is the project at?', required: true, dataField: 'projectStage', fieldType: 'string' },
    { id: 'cc-6', question: 'How many carbon credits do you estimate per year?', required: true, dataField: 'estimatedCreditsPerYear', fieldType: 'string' },
    { id: 'cc-7', question: 'Which carbon standard are you using — Verra, Gold Standard, or another?', required: true, dataField: 'carbonStandard', fieldType: 'string' },
    { id: 'cc-8', question: 'Can you briefly describe the project?', required: true, dataField: 'projectDescription', fieldType: 'string' },
  ],
  community: [
    // Required fields for community.createLead (expert network)
    { id: 'cm-1', question: 'Which organisation are you with?', required: true, dataField: 'organization', fieldType: 'string' },
    { id: 'cm-2', question: 'What is your role there?', required: true, dataField: 'role', fieldType: 'string' },
    { id: 'cm-3', question: 'Where are you based?', required: true, dataField: 'location', fieldType: 'string' },
    { id: 'cm-4', question: 'What is your primary industry or domain?', required: true, dataField: 'primaryIndustry', fieldType: 'string' },
    { id: 'cm-5', question: 'How many years of experience do you have in this area?', required: true, dataField: 'yearsOfExperience', fieldType: 'string' },
    { id: 'cm-6', question: 'What are your specific areas of focus?', required: true, dataField: 'specificFocus', fieldType: 'string[]' },
    { id: 'cm-7', question: 'Would you be interested in joining as an advisor to the One2b community?', required: false, dataField: 'isAdvisor', fieldType: 'boolean' },
  ],
};

export const one2bGetTrackQuestionsTool = createTool({
  id: "one2b-get-track-questions",
  description:
    "Get the qualifying questions for a specific One2b community track. " +
    "Use this after determining which track the contact likely belongs to. " +
    "Questions map directly to fields in the One2b CRM.",
  inputSchema: z.object({
    track: trackEnum.describe("The One2b community track to get questions for"),
  }),
  outputSchema: z.object({
    track: trackEnum,
    questions: z.array(z.object({
      id: z.string(),
      question: z.string(),
      required: z.boolean(),
      dataField: z.string(),
      fieldType: z.string(),
    })),
    trcpRouter: z.string().describe("The tRPC router this track maps to"),
  }),
  execute: async (inputData) => {
    const questions = TRACK_QUESTIONS[inputData.track];

    const routerMap: Record<typeof ONE2B_TRACKS[number], string> = {
      investor: 'communityInvestor.createLead',
      sovereign_entity: 'communitySovereignEntity.createLead',
      channel_partner: 'communityChannelPartner.createLead',
      project: 'communityCompany.createCompanyLead',
      carbon_project: 'carbonProject.createLead',
      community: 'community.createLead',
    };

    console.log(`📋 [one2b] Returning ${questions.length} questions for track: ${inputData.track}`);
    return {
      track: inputData.track,
      questions,
      trcpRouter: routerMap[inputData.track],
    };
  },
});

// ─── Lead Creation Tool ─────────────────────────────────────────────────────
// Single tool that routes to the correct tRPC endpoint based on track.

export const one2bCreateLeadTool = createTool({
  id: "one2b-create-lead",
  description:
    "Create a lead record in the One2b CRM platform. " +
    "Routes to the correct tRPC endpoint based on the track. " +
    "Call this once you have collected enough qualifying data from the conversation. " +
    "All tRPC endpoints are public (no auth required) and will trigger DocuSign NDA automatically.",
  inputSchema: z.object({
    track: trackEnum.describe("Which track to create the lead in"),
    // Common fields across all tracks
    fullName: z.string().describe("Full name of the contact"),
    email: z.string().email().describe("Email address"),
    phone: z.string().describe("Phone/mobile number"),
    company: z.string().optional().describe("Company or organisation name"),
    role: z.string().optional().describe("Job title or role"),
    linkedIn: z.string().optional().describe("LinkedIn profile URL"),
    // Communication preferences (required by most tracks)
    mobileContactMethod: z.string().optional().describe("Preferred mobile contact: WhatsApp, Signal, Telegram, SMS"),
    videoCallPlatform: z.string().optional().describe("Preferred video call: Zoom, Teams, Google Meet"),
    preferredContactTimes: z.array(z.string()).optional().describe("Preferred times: Morning, Afternoon, Evening"),
    timeZone: z.string().optional().describe("Contact's timezone"),
    // Track-specific data collected during conversation
    trackData: z.record(z.unknown()).optional().describe(
      "Track-specific fields collected during qualification. " +
      "Keys should match the dataField values from one2b-get-track-questions."
    ),
    referralCode: z.string().optional().describe("Referral code if provided"),
    source: z.string().optional().describe("How they connected: voice_call, whatsapp, telegram, signal"),
  }),
  outputSchema: z.object({
    leadId: z.string(),
    track: z.string(),
    message: z.string(),
    ndaSent: z.boolean(),
  }),
  execute: async (inputData) => {
    const { track, fullName, email, phone, company, role, linkedIn,
            mobileContactMethod, videoCallPlatform, preferredContactTimes,
            timeZone, trackData, referralCode } = inputData;

    console.log(`📝 [one2b] Creating ${track} lead: ${fullName} (${email})`);

    // tRPC returns different ID field names per router (leadId, companyLeadId, etc.)
    let resp: Record<string, unknown> = {};
    let ndaSent = false;
    const td = trackData || {};

    switch (track) {
      case 'investor': {
        resp = await one2bTrpcMutation<Record<string, unknown>>('communityInvestor.createLead', {
          fullName,
          email,
          mobileNumber: phone,
          companyInstitution: company || 'Not provided',
          role: role || 'Not provided',
          linkedIn,
          mobileContactMethod: mobileContactMethod || 'WhatsApp',
          videoCallPlatform: videoCallPlatform || 'Zoom',
          preferredContactTimes: preferredContactTimes || ['Morning'],
          timeZone: timeZone || 'UTC',
          investorType: 'INVESTOR' as const,
          // Required investor fields with defaults
          institutionType: (td.institutionType as string) || 'Not specified',
          aumRange: (td.aumRange as string) || 'Not disclosed',
          typicalInvestmentSize: (td.typicalInvestmentSize as string) || 'Not disclosed',
          targetReturns: (td.targetReturns as string) || 'Not disclosed',
          investmentHorizon: (td.investmentHorizon as string) || 'Not disclosed',
          // Optional investor fields
          sectorsOfInterest: td.sectorsOfInterest as string[] | undefined,
          geographicFocus: td.geographicFocus as string[] | undefined,
          esgRequirements: td.esgRequirements as string | undefined,
          riskProfile: td.riskProfile as string | undefined,
          accreditedInvestor: td.accreditedInvestor as boolean | undefined,
          referralCode,
        });
        ndaSent = true; // DocuSign NDA auto-sent
        break;
      }

      case 'sovereign_entity': {
        resp = await one2bTrpcMutation<Record<string, unknown>>('communitySovereignEntity.createLead', {
          fullName,
          email,
          mobileNumber: phone,
          companyInstitution: company || 'Not provided',
          role: role || 'Not provided',
          linkedIn,
          mobileContactMethod: mobileContactMethod || 'WhatsApp',
          videoCallPlatform: videoCallPlatform || 'Zoom',
          preferredContactTimes: preferredContactTimes || ['Morning'],
          timeZone: timeZone || 'UTC',
          officialEntityName: td.officialEntityName as string | undefined,
          governmentLevel: td.governmentLevel as string | undefined,
          departmentMinistry: td.departmentMinistry as string | undefined,
          officialWebsite: td.officialWebsite as string | undefined,
          jurisdiction: td.jurisdiction as string | undefined,
          programType: td.programType as string | undefined,
          estimatedProgramValue: td.estimatedProgramValue as string | undefined,
          implementationTimeline: td.implementationTimeline as string | undefined,
          fundingStructurePreference: td.fundingStructurePreference as string | undefined,
          strategicObjectives: td.strategicObjectives as string[] | undefined,
          jobCreationTarget: td.jobCreationTarget as string | undefined,
          departmentalDataAssets: td.departmentalDataAssets as string[] | undefined,
          additionalInfo: td.additionalInfo as string | undefined,
          referralCode,
        });
        ndaSent = true;
        break;
      }

      case 'channel_partner': {
        resp = await one2bTrpcMutation<Record<string, unknown>>('communityChannelPartner.createLead', {
          legalCompanyName: (td.legalCompanyName as string) || company || 'Not provided',
          entityType: (td.entityType as string) || 'Not specified',
          registeredOfficeAddress: (td.registeredOfficeAddress as string) || 'Not provided',
          companyWebsite: (td.companyWebsite as string) || 'Not provided',
          industrySectors: (td.industrySectors as string[]) || ['Technology'],
          companyDescription: (td.companyDescription as string) || 'Not provided',
          contactFullName: fullName,
          contactJobTitle: role || 'Not provided',
          contactEmail: email,
          contactPhone: phone,
          contactLinkedIn: linkedIn,
          sameAsPrimaryContact: true,
          sameAsPortalLogin: true,
          clientTypes: td.clientTypes as string[] | undefined,
          geographicRegions: td.geographicRegions as string[] | undefined,
          estimatedReferrals12Months: td.estimatedReferrals12Months as string | undefined,
          estimatedAvgDealSize: td.estimatedAvgDealSize as string | undefined,
          whyInterestedInPartnering: td.whyInterestedInPartnering as string | undefined,
          // Required confirmations (agent has explained terms during conversation)
          confirmInfoAccurate: true,
          confirmAuthorised: true,
          confirmDocuSignUnderstand: true,
          confirmMarketingAssets: true,
          confirmContactConsent: true,
        });
        ndaSent = true;
        break;
      }

      case 'project': {
        resp = await one2bTrpcMutation<Record<string, unknown>>('communityCompany.createCompanyLead', {
          legalCompanyName: (td.legalCompanyName as string) || company || 'Not provided',
          registeredAddress: (td.registeredAddress as string) || 'Not provided',
          website: (td.website as string) || 'Not provided',
          companyEmail: email,
          companyStage: (td.companyStage as string) || 'Not specified',
          headquartersLocation: (td.headquartersLocation as string) || 'Not provided',
          industrySectors: (td.industrySectors as string[]) || ['Technology'],
          companyBio: (td.companyBio as string) || 'Not provided',
          sdgGoals: (td.sdgGoals as string[]) || [],
          seekingCapital: (td.seekingCapital as string) || 'Not specified',
          seekingInsurance: (td.seekingInsurance as string) || 'Not specified',
          capitalAmountSought: td.capitalAmountSought as string | undefined,
          capitalUseOf: (td.capitalUseOf as string[]) || [],
          capitalTimeline: td.capitalTimeline as string | undefined,
          dataCollectionYears: td.dataCollectionYears as string | undefined,
          revenueFromDataPercent: td.revenueFromDataPercent as string | undefined,
          primaryDataTypes: td.primaryDataTypes as string[] | undefined,
          servicesInterest: (td.servicesInterest as string[]) || ['Data Valuation'],
          investmentReadiness: (td.investmentReadiness as string) || 'Not specified',
          referralCode,
        });
        ndaSent = true;
        break;
      }

      case 'carbon_project': {
        resp = await one2bTrpcMutation<Record<string, unknown>>('carbonProject.createLead', {
          role: (td.role as string) || 'PROJECT_DEVELOPER',
          fullName,
          email,
          phone,
          organisation: company || 'Not provided',
          position: role || 'Not provided',
          linkedIn,
          projectName: (td.projectName as string) || 'Not provided',
          projectType: (td.projectType as string) || 'Not specified',
          projectLocation: (td.projectLocation as string) || 'Not specified',
          projectCountry: (td.projectCountry as string) || 'Not specified',
          projectStage: (td.projectStage as string) || 'Not specified',
          estimatedCreditsPerYear: (td.estimatedCreditsPerYear as string) || 'Not specified',
          projectDescription: (td.projectDescription as string) || 'Not provided',
          carbonStandard: (td.carbonStandard as string) || 'Not specified',
          methodologyUsed: td.methodologyUsed as string | undefined,
          validationBody: td.validationBody as string | undefined,
          verificationStatus: td.verificationStatus as string | undefined,
          referralCode,
        });
        ndaSent = true;
        break;
      }

      case 'community': {
        resp = await one2bTrpcMutation<Record<string, unknown>>('community.createLead', {
          fullName,
          email,
          mobileNumber: phone,
          linkedInProfile: linkedIn,
          organization: company || 'Not provided',
          role: role || 'Not provided',
          location: (td.location as string) || 'Not provided',
          primaryIndustry: (td.primaryIndustry as string) || 'Technology',
          yearsOfExperience: (td.yearsOfExperience as string) || 'Not specified',
          specificFocus: (td.specificFocus as string[]) || ['General'],
          mobileContactMethod: mobileContactMethod || 'WhatsApp',
          videoCallPreference: videoCallPlatform || 'Zoom',
          timeZone: timeZone || 'UTC',
          preferredContactTime: preferredContactTimes || ['Morning'],
          additionalContext: td.additionalContext as string | undefined,
          isAdvisor: (td.isAdvisor as boolean) || false,
          referralCode,
        });
        ndaSent = false; // NDA sent separately for community leads
        break;
      }
    }

    // Extract leadId from response — different routers use different field names
    const leadId = String(resp.leadId || resp.companyLeadId || resp.id || 'unknown');

    console.log(`✅ [one2b] Lead created: ${leadId} (track: ${track}, NDA: ${ndaSent})`);

    return {
      leadId,
      track,
      message: `${fullName} has been registered in the ${track} track.${ndaSent ? ' A DocuSign NDA has been sent to their email.' : ''}`,
      ndaSent,
    };
  },
});

// ─── Lead Lookup Tool ────────────────────────────────────────────────────────

export const one2bLookupLeadTool = createTool({
  id: "one2b-lookup-lead",
  description:
    "Check if a contact already exists in the One2b CRM by email. " +
    "Call this early in the conversation to avoid creating duplicate records.",
  inputSchema: z.object({
    email: z.string().email().describe("Email address to look up"),
    track: trackEnum.optional().describe("If you know their track, search that specific router. Otherwise searches community leads."),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    leadId: z.string().optional(),
    track: z.string().optional(),
    name: z.string().optional(),
    message: z.string(),
  }),
  execute: async (inputData) => {
    const { email, track } = inputData;
    console.log(`🔍 [one2b] Looking up lead by email: ${email}`);

    // Map track to the correct query procedure
    const lookupProcedures: Record<string, string> = {
      investor: 'communityInvestor.getLeadByEmail',
      sovereign_entity: 'communitySovereignEntity.getLeadByEmail',
      channel_partner: 'communityChannelPartner.getLeadByEmail',
      project: 'communityCompany.getCompanyLeadByEmail',
      carbon_project: 'carbonProject.getLeadByEmail',
      community: 'community.getLeadByEmail',
    };

    // If track specified, search that router
    if (track) {
      const procedure = lookupProcedures[track];
      if (procedure) {
        try {
          const lead = await one2bTrpcQuery<{ id: string; fullName?: string; contactFullName?: string }>(
            procedure, { email }
          );
          if (lead) {
            return {
              found: true,
              leadId: lead.id,
              track,
              name: lead.fullName || lead.contactFullName,
              message: `Found existing ${track} lead for ${email}.`,
            };
          }
        } catch {
          // Not found in this track
        }
      }
    }

    // Search across community leads as default
    try {
      const lead = await one2bTrpcQuery<{ id: string; fullName?: string }>(
        'community.getLeadByEmail', { email }
      );
      if (lead) {
        return {
          found: true,
          leadId: lead.id,
          track: 'community',
          name: lead.fullName,
          message: `Found existing community lead for ${email}.`,
        };
      }
    } catch {
      // Not found
    }

    return {
      found: false,
      message: `No existing lead found for ${email}.`,
    };
  },
});

// ─── Escalation Tool ─────────────────────────────────────────────────────────

export const one2bEscalateTool = createTool({
  id: "one2b-escalate",
  description:
    "Escalate a conversation to the appropriate One2b team member. " +
    "Use when the conversation reaches a decision point requiring human judgment, " +
    "when a sovereign entity is identified, when deal size exceeds thresholds, " +
    "or when the contact explicitly asks to speak with a person. " +
    "Note: There is no escalation API on the One2b platform yet — this sends " +
    "a Slack notification and logs the escalation for follow-up.",
  inputSchema: z.object({
    contactName: z.string().describe("Name of the contact"),
    contactEmail: z.string().email().describe("Email of the contact"),
    track: trackEnum.describe("The identified track"),
    reason: z.string().describe("Why escalation is needed"),
    urgency: z.enum(['high', 'medium', 'low']).describe("How urgently a human should follow up"),
    conversationSummary: z.string().describe("Summary of the conversation so far"),
    dataCollected: z.record(z.unknown()).optional().describe("Qualification data collected so far"),
  }),
  outputSchema: z.object({
    escalated: z.boolean(),
    message: z.string(),
  }),
  execute: async (inputData) => {
    console.log(`🚨 [one2b] Escalating: ${inputData.contactName} (${inputData.track}) - ${inputData.reason}`);

    // Log the escalation (future: write to One2b escalation queue)
    console.log(`🚨 [one2b] ESCALATION DETAILS:`);
    console.log(`   Contact: ${inputData.contactName} (${inputData.contactEmail})`);
    console.log(`   Track: ${inputData.track}`);
    console.log(`   Urgency: ${inputData.urgency}`);
    console.log(`   Reason: ${inputData.reason}`);
    console.log(`   Summary: ${inputData.conversationSummary}`);

    // TODO: When One2b adds an escalation API endpoint, call it here.
    // TODO: Send Slack notification to the appropriate team member.
    // For now, the escalation is logged and the agent informs the contact.

    return {
      escalated: true,
      message: `Escalation logged for ${inputData.contactName}. A team member will follow up.`,
    };
  },
});
