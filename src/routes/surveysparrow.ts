import { Router, type IRouter } from "express";
import { normalizePlaceholdersInString } from "../lib/placeholders.js";

const router: IRouter = Router();

const REGION_URLS: Record<string, string> = {
  US: "https://api.surveysparrow.com",
  EU: "https://eu-api.surveysparrow.com",
  AP: "https://ap-api.surveysparrow.com",
  ME: "https://me-api.surveysparrow.com",
  UK: "https://eu-ln-api.surveysparrow.com",
  CA: "https://ca-api.surveysparrow.com",
  SYDNEY: "https://ap-sy-api.surveysparrow.com",
};

function getBaseUrl(region: string): string {
  return REGION_URLS[region] ?? REGION_URLS["US"];
}

async function ssGet(baseUrl: string, apiKey: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function ssPost(baseUrl: string, apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  return { ok: res.ok, status: res.status, data };
}

async function ssPut(baseUrl: string, apiKey: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json();
  return { ok: res.ok, status: res.status, data };
}

router.post("/folders", async (req, res) => {
  const { region, apiKey } = req.body as { region?: string; apiKey?: string };
  if (!region || !apiKey) { res.status(400).json({ error: "region and apiKey are required" }); return; }
  const baseUrl = getBaseUrl(region);
  try {
    const result = await ssGet(baseUrl, apiKey, "/v3/survey_folders?limit=100&page=1");
    if (!result.ok) { res.status(result.status).json({ error: JSON.stringify(result.data) }); return; }
    const raw = result.data;
    const rawItems: Record<string, unknown>[] = Array.isArray(raw.data) ? raw.data : Array.isArray(raw) ? raw : [];
    const folders = rawItems.map((f) => {
      const surveyFolderId = f.survey_folder_id as number | string | undefined;
      const id = f.id as number | string | undefined;
      // workspace_id is the deprecated alias for survey_folder_id — read as legacy fallback only.
      const legacyFolderId = f.workspace_id as number | string | undefined;
      const parentId = f.parent_id as number | string | undefined;
      // Prefer survey_folder_id, then id. Fall back to legacy folder ID only if both are absent.
      const value = surveyFolderId ?? id ?? legacyFolderId;
      const usedLegacyFolderIdAsFallback = !surveyFolderId && !id && legacyFolderId !== undefined;
      if (usedLegacyFolderIdAsFallback) {
        // Optional chaining so this is a no-op when pino-http isn't mounted
        // (e.g. in the minimal Netlify Function build that skips logging).
        req.log?.warn?.({ legacyFolderId }, "folder has only the legacy folder ID — survey_folder_id and id are absent");
      }
      return {
        id,
        survey_folder_id: surveyFolderId,
        legacy_folder_id: legacyFolderId,
        parent_id: parentId,
        name: (f.name ?? f.folder_name ?? String(value)) as string,
        value: value as number | string,
        usedLegacyFolderIdAsFallback,
      };
    });
    res.json({ folders, rawResponse: raw });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/create-survey", async (req, res) => {
  const {
    region, apiKey, surveyFolderId, surveyType, surveyTitle, primaryLanguage,
    prompt, displayLogicEnabled, trackIp, trackLocation, partialSubmission,
  } = req.body as {
    region?: string;
    apiKey?: string;
    surveyFolderId?: string | number | null;
    surveyType?: string;
    surveyTitle?: string;
    primaryLanguage?: string;
    prompt?: string;
    displayLogicEnabled?: boolean;
    trackIp?: boolean;
    trackLocation?: boolean;
    partialSubmission?: boolean;
  };

  if (!region || !apiKey || !prompt) {
    res.status(400).json({ error: "region, apiKey, and prompt are required" });
    return;
  }

  const baseUrl = getBaseUrl(region);
  const warnings: string[] = [];
  const debugLog: DebugEntry[] = [];
  const questionResults: QuestionResult[] = [];

  const parsed = parsePrompt(prompt);

  // Convert any `{{name}}` placeholders the user pasted into the SurveySparrow
  // `$name` syntax across every text field that ends up in a survey payload.
  // Counted once so we can show a single human-readable warning at the end.
  let placeholderConversions = 0;
  const normalize = (s: string | undefined | null): string => {
    const r = normalizePlaceholdersInString(s);
    placeholderConversions += r.count;
    return r.out;
  };
  parsed.title              = normalize(parsed.title);
  parsed.welcomeTitle       = normalize(parsed.welcomeTitle);
  parsed.welcomeDescription = normalize(parsed.welcomeDescription);
  parsed.thankYouMessage    = normalize(parsed.thankYouMessage);
  parsed.thankYouDescription = normalize(parsed.thankYouDescription);
  parsed.sections = parsed.sections.map((s) => normalize(s));
  for (const q of parsed.questions) {
    q.text        = normalize(q.text);
    q.description = normalize(q.description);
    q.consentText = normalize(q.consentText);
    q.minLabel    = normalize(q.minLabel);
    q.maxLabel    = normalize(q.maxLabel);
    q.section     = normalize(q.section);
    q.options = q.options.map((v) => normalize(v));
    q.rows    = q.rows.map((v) => normalize(v));
    q.columns = q.columns.map((v) => normalize(v));
    // Feedback-bucket follow-up text (NPSFeedback / CESFeedback / CSATFeedback).
    if (q.feedbackPromoter)     q.feedbackPromoter     = normalize(q.feedbackPromoter);
    if (q.feedbackPassive)      q.feedbackPassive      = normalize(q.feedbackPassive);
    if (q.feedbackDetractor)    q.feedbackDetractor    = normalize(q.feedbackDetractor);
    if (q.feedbackLowEffort)    q.feedbackLowEffort    = normalize(q.feedbackLowEffort);
    if (q.feedbackNeutral)      q.feedbackNeutral      = normalize(q.feedbackNeutral);
    if (q.feedbackHighEffort)   q.feedbackHighEffort   = normalize(q.feedbackHighEffort);
    if (q.feedbackSatisfied)    q.feedbackSatisfied    = normalize(q.feedbackSatisfied);
    if (q.feedbackDissatisfied) q.feedbackDissatisfied = normalize(q.feedbackDissatisfied);
  }
  // The form-supplied surveyTitle bypasses parsePrompt entirely, so normalize
  // it separately before it overrides parsed.title.
  const titleRaw = surveyTitle ?? parsed.title;
  const titleNorm = normalizePlaceholdersInString(titleRaw || "Untitled Survey");
  placeholderConversions += titleNorm.count;
  const title = titleNorm.out;
  if (placeholderConversions > 0) {
    warnings.push(`Converted ${placeholderConversions} curly-brace placeholder${placeholderConversions === 1 ? "" : "s"} to SurveySparrow $name syntax.`);
  }
  const type = surveyType || parsed.surveyType || "ClassicForm";

  // Defensive merge happens upfront so the native-score override is known
  // BEFORE POST /v3/surveys completes — we need it to PATCH the auto-created
  // score question on NPS/CES/CSAT surveys immediately after creation.
  const mergeResult = mergeFeedbackFollowups(parsed.questions, type);
  const questionsToCreate = mergeResult.questions;

  // Minimal payload matching the verified working SurveySparrow shape:
  //   { name, survey_type, primary_language, survey_folder_id }
  // visibility is intentionally omitted — SurveySparrow's defaults work and
  // extras can interfere with folder placement.
  const surveyPayload: Record<string, unknown> = {
    name: title,
    survey_type: type,
    primary_language: primaryLanguage || "en",
  };
  if (surveyFolderId) {
    surveyPayload.survey_folder_id = Number(surveyFolderId);
  }
  // Optional survey-behavior toggles. Only attach `settings` if the user opted
  // into at least one — empty objects can cause surprising defaults to apply.
  const settings: Record<string, unknown> = {};
  if (trackIp === true)            settings.track_ip = true;
  if (trackLocation === true)      settings.track_location = true;
  if (partialSubmission === true)  settings.partial_submission = true;
  if (Object.keys(settings).length > 0) {
    surveyPayload.settings = settings;
  }
  // Optional welcome and thank-you screens (kept — these are user-facing features).
  if (parsed.welcomeTitle) surveyPayload.welcome_text = parsed.welcomeTitle;
  if (parsed.welcomeDescription) surveyPayload.welcome_description = parsed.welcomeDescription;
  if (parsed.thankYouMessage) {
    surveyPayload.thankyou_json = [{
      preAdded: true,
      message: parsed.thankYouMessage,
      description: parsed.thankYouDescription || "",
      branding: false,
    }];
  }

  const surveyEndpoint = "/v3/surveys";
  let surveyResult;
  try {
    surveyResult = await ssPost(baseUrl, apiKey, surveyEndpoint, surveyPayload);
    debugLog.push({ step: "Create Survey", endpoint: `POST ${surveyEndpoint}`, status: surveyResult.status, payload: surveyPayload, response: surveyResult.data });
    // If rejected and had optional welcome/thankyou fields, retry without them
    if (!surveyResult.ok && surveyResult.status === 400 && (parsed.welcomeTitle || parsed.thankYouMessage)) {
      const minimalPayload = { ...surveyPayload };
      delete minimalPayload.welcome_text;
      delete minimalPayload.welcome_description;
      delete minimalPayload.thankyou_json;
      surveyResult = await ssPost(baseUrl, apiKey, surveyEndpoint, minimalPayload);
      debugLog.push({ step: "Create Survey (retry without welcome/thankyou)", endpoint: `POST ${surveyEndpoint}`, status: surveyResult.status, payload: minimalPayload, response: surveyResult.data });
      if (surveyResult.ok) warnings.push("Survey created without welcome/thank-you content — optional fields were rejected by SurveySparrow.");
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog.push({ step: "Create Survey", endpoint: `POST ${surveyEndpoint}`, status: "network error", payload: surveyPayload, response: null, error: msg });
    res.status(500).json({ error: "Failed to create survey: " + msg, debugLog });
    return;
  }

  if (!surveyResult.ok) {
    res.status(surveyResult.status).json({ error: "Survey creation failed: " + JSON.stringify(surveyResult.data), debugLog });
    return;
  }

  const surveyId: number | string = surveyResult.data?.data?.id ?? surveyResult.data?.id;
  if (!surveyId) {
    res.status(500).json({ error: "Could not determine survey ID: " + JSON.stringify(surveyResult.data), debugLog });
    return;
  }

  // NPS / CES / CSAT native score-question text patch.
  // When the survey type is one of those three, SurveySparrow auto-creates a
  // default account-level score question during POST /v3/surveys (using
  // text like "How satisfied are you with <YourCompany>?"). The merge step
  // captured the user's custom score-question text in `scoreOverride` —
  // apply it now so the survey ships with the right text.
  if (mergeResult.scoreOverride && (type === "NPS" || type === "CES" || type === "CSAT")) {
    const override = mergeResult.scoreOverride;
    const patchError = await patchNativeScoreQuestion(
      baseUrl, apiKey, surveyId, type, override, debugLog,
    );
    const feedbackType: string = type === "NPS" ? "NPSFeedback" : type === "CSAT" ? "CSATFeedback" : "CESFeedback";
    if (!patchError) {
      questionResults.push({
        localId: override.localId,
        text: override.text,
        intendedType: feedbackType,
        createdType: type,
        status: "created_compatible",
        warning: `Updated SurveySparrow's auto-created native ${type} score question with your custom text.`,
      });
      warnings.push(`Q${override.localId}: updated native ${type} score question text.`);
    } else {
      questionResults.push({
        localId: override.localId,
        text: override.text,
        intendedType: feedbackType,
        createdType: type,
        status: "failed",
        warning: `Could not update native ${type} score question — please edit Q1 manually in SurveySparrow. ${patchError}`.trim(),
      });
      warnings.push(`Q${override.localId}: could not update native ${type} score question — edit Q1 manually inside SurveySparrow.`);
    }
  }

  // V2: Create sections
  const sectionIdMap: Record<string, number | string> = {};
  let sectionsCreated = 0;
  if (parsed.sections.length > 0) {
    const sectionsPayload = {
      survey_id: Number(surveyId),
      sections: parsed.sections.map((name, i) => ({
        name,
        description: "",
        position: i + 1,
        properties: { label: "Next", section_randomise: false, single_page_view: false, section_intro: "separate" },
      })),
    };
    try {
      const sResult = await ssPost(baseUrl, apiKey, "/v3/sections", sectionsPayload);
      debugLog.push({ step: "Create Sections", endpoint: "POST /v3/sections", status: sResult.status, payload: sectionsPayload, response: sResult.data });
      if (sResult.ok) {
        const createdItems: Record<string, unknown>[] = Array.isArray(sResult.data?.data) ? sResult.data.data : [];
        createdItems.forEach((s, i) => {
          const name = parsed.sections[i] ?? (s.name as string);
          const sid = s.id as number | string | undefined;
          if (name && sid !== undefined) sectionIdMap[name] = sid;
        });
        sectionsCreated = Object.keys(sectionIdMap).length;
      } else {
        warnings.push("Section creation failed — questions will be created without section assignment");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Section creation error — questions will be created without section assignment: ${msg}`);
    }
  }

  // Per-question record built during the create loop and consumed by the
  // display-logic pass. `choiceMap` maps each choice's text (lowercased) to
  // the SurveySparrow-assigned choice ID — needed so a `Show if: Q3 equals
  // Product A` against a MultiChoice source resolves to the correct
  // `choice_id` field in the display-logic payload.
  const qIdMap: Record<string, { id: number | string; type: string; choiceMap?: Record<string, number | string> }> = {};
  let questionsCreated = 0;
  let enrichedCount = 0;
  let compatibleCount = 0;
  let fallbackCount = 0;
  const qEndpoint = "/v3/questions";

  // mergeResult / questionsToCreate are computed upfront, before POST
  // /v3/surveys (so the native-score-override is available immediately
  // after the survey is created). Iterate the merged list here.
  for (const q of questionsToCreate) {
    const originalIntendedType = inferType(q);
    const compat = getCompatibleQuestionType(q, originalIntendedType, type);
    const effectiveQ = compat.q;
    const effectiveType = compat.remappedType;
    const compatibilityNote = compat.note;

    // SurveySparrow rejects NPSFeedback / CSATFeedback / CESFeedback creation
    // when section_id is present ("CX feedback question cannot be added to a
    // section"). Drop the section assignment for these types so the feedback
    // Q ends up at the top level alongside the native score.
    const FEEDBACK_TYPES_NO_SECTION = new Set(["NPSFeedback", "CSATFeedback", "CESFeedback"]);
    const sectionId = (q.section && !FEEDBACK_TYPES_NO_SECTION.has(effectiveType))
      ? sectionIdMap[q.section]
      : undefined;
    const result = await attemptCreateQuestion(baseUrl, apiKey, surveyId, effectiveQ, effectiveType, qEndpoint, debugLog, sectionId);

    // If remapped for compatibility and creation succeeded, upgrade status and note
    let finalStatus = result.status;
    let finalWarning = result.warning;
    if (compatibilityNote && (result.status === "created" || result.status === "created_retry")) {
      finalStatus = "created_compatible";
      finalWarning = compatibilityNote;
    }

    // Track stats
    if (finalStatus === "created_enriched") enrichedCount++;
    else if (finalStatus === "created_compatible") compatibleCount++;
    else if (finalStatus === "created_fallback") fallbackCount++;

    questionResults.push({
      localId: q.localId,
      text: q.text,
      intendedType: originalIntendedType,
      createdType: result.createdType,
      status: finalStatus,
      warning: finalWarning,
      section: q.section || undefined,
    });

    if (result.id !== undefined) {
      // The most recently appended debug entry for this question carries the
      // create-question response — extract the choice ID list (if any) so the
      // display-logic pass can resolve MultiChoice / Dropdown source values.
      const lastEntry = debugLog[debugLog.length - 1];
      const responseRoot = (lastEntry?.response as Record<string, unknown> | null | undefined) ?? null;
      const responseData = ((responseRoot?.data as Record<string, unknown> | undefined) ?? responseRoot) as Record<string, unknown> | null;
      const rawChoices = responseData && Array.isArray(responseData.choices) ? responseData.choices : [];
      const choiceMap: Record<string, number | string> = {};
      for (const c of rawChoices as Array<Record<string, unknown>>) {
        const id = c?.id as number | string | undefined;
        const text = typeof c?.text === "string" ? (c.text as string) : null;
        if (id !== undefined && text !== null) {
          choiceMap[text.toLowerCase().trim()] = id;
        }
      }
      qIdMap[`Q${q.localId}`] = {
        id: result.id,
        type: result.createdType,
        choiceMap: Object.keys(choiceMap).length > 0 ? choiceMap : undefined,
      };
      questionsCreated++;
    }
    if (finalWarning) warnings.push(`Q${q.localId}: ${finalWarning}`);
  }

  let logicsApplied = 0;
  // Per-question display-logic summary surfaced to the frontend so the result
  // panel can show "Logic applied: 2/3" plus per-Q failure details.
  type DisplayLogicDetail = {
    localId: string;
    targetId: number | string | null;
    sourceRef: string;
    sourceId: number | string | null;
    status: "applied" | "skipped" | "failed";
    reason?: string;
  };
  const displayLogicDetails: DisplayLogicDetail[] = [];
  let dlAttempted = 0;
  let dlFailed = 0;

  if (displayLogicEnabled) {
    for (const q of questionsToCreate) {
      if (!q.showIf) continue;
      dlAttempted++;
      const targetEntry = qIdMap[`Q${q.localId}`];
      if (!targetEntry) {
        const reason = "target question was not created";
        warnings.push(`Q${q.localId}: skipping display logic — ${reason}`);
        displayLogicDetails.push({ localId: q.localId, targetId: null, sourceRef: q.showIf.source, sourceId: null, status: "skipped", reason });
        continue;
      }
      const sourceKey = q.showIf.source;
      const sourceEntry = qIdMap[sourceKey];
      if (!sourceEntry) {
        const reason = `source ${sourceKey} not found (was it dropped during NPS/CES/CSAT merge?)`;
        warnings.push(`Q${q.localId}: skipping display logic — ${reason}`);
        displayLogicDetails.push({ localId: q.localId, targetId: targetEntry.id, sourceRef: sourceKey, sourceId: null, status: "skipped", reason });
        continue;
      }
      const sourceQ = questionsToCreate.find((sq) => `Q${sq.localId}` === sourceKey);
      if (!sourceQ) {
        const reason = "source question not found in parsed set";
        warnings.push(`Q${q.localId}: skipping display logic — ${reason}`);
        displayLogicDetails.push({ localId: q.localId, targetId: targetEntry.id, sourceRef: sourceKey, sourceId: sourceEntry.id, status: "skipped", reason });
        continue;
      }
      // The created type is authoritative (a MultiChoice may have fallen back
      // to TextInput, which changes which comparator we should use).
      const sourceType = sourceEntry.type || inferType(sourceQ);
      const { comparator, value: mappedValue } = mapDisplayLogicComparator(sourceType, q.showIf.operator, q.showIf.value);

      // For MultiChoice / Dropdown sources, SurveySparrow expects the choice's
      // numeric ID in `choice_id` (the human-readable `value` is informational).
      // Resolve the choice ID by lowercased text from the choiceMap we
      // captured during create. If the user wrote a label that doesn't match
      // any captured option, leave choice_id null and let the API reject it.
      let resolvedChoiceId: number | string | null = null;
      if ((sourceType === "MultiChoice" || sourceType === "Dropdown") && sourceEntry.choiceMap) {
        const lookup = String(q.showIf.value).toLowerCase().trim();
        resolvedChoiceId = sourceEntry.choiceMap[lookup] ?? null;
      }

      // Payload shape matches the verified-working sample exactly:
      //   { id, displayLogic: { version: "1", logics: [{ ...full entry, choice_id }] } }
      const logicPayload = {
        id: Number(targetEntry.id),
        displayLogic: {
          version: "1",
          logics: [
            {
              join_condition: "and",
              type: "question",
              value: mappedValue,
              comparator,
              question_id: Number(sourceEntry.id),
              isVariable: false,
              isDefaultVariable: false,
              choice_id: resolvedChoiceId,
            },
          ],
        },
      };
      const logicEndpoint = `/v3/questions/${targetEntry.id}`;
      try {
        const lResult = await ssPut(baseUrl, apiKey, logicEndpoint, logicPayload);
        debugLog.push({ step: `Apply Display Logic Q${q.localId}`, endpoint: `PUT ${logicEndpoint}`, status: lResult.status, payload: logicPayload, response: lResult.data });
        if (!lResult.ok) {
          dlFailed++;
          warnings.push(`Q${q.localId}: display logic failed — ${JSON.stringify(lResult.data)}`);
          displayLogicDetails.push({ localId: q.localId, targetId: targetEntry.id, sourceRef: sourceKey, sourceId: sourceEntry.id, status: "failed", reason: typeof lResult.data === "string" ? lResult.data : JSON.stringify(lResult.data) });
        } else {
          logicsApplied++;
          displayLogicDetails.push({ localId: q.localId, targetId: targetEntry.id, sourceRef: sourceKey, sourceId: sourceEntry.id, status: "applied" });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog.push({ step: `Apply Display Logic Q${q.localId}`, endpoint: `PUT ${logicEndpoint}`, status: "network error", payload: logicPayload, response: null, error: msg });
        warnings.push(`Q${q.localId}: display logic error — ${msg}`);
        dlFailed++;
        displayLogicDetails.push({ localId: q.localId, targetId: targetEntry.id, sourceRef: sourceKey, sourceId: sourceEntry.id, status: "failed", reason: msg });
      }
    }
  }

  // Folder placement verification — read survey_folder_id directly from the
  // POST /v3/surveys response body (no extra GET round-trip). SurveySparrow
  // returns the freshly-placed survey under `data` with `survey_folder_id` and
  // `survey_folder_name` populated when placement succeeds.
  let folderMismatch: string | undefined;
  let folderVerified = false;
  let returnedFolderId: number | string | undefined;
  let returnedFolderName: string | undefined;
  if (surveyFolderId) {
    const createdSurvey = surveyResult.data?.data ?? surveyResult.data;
    const actualFolderId: number | string | undefined =
      createdSurvey?.survey_folder_id ?? createdSurvey?.folder_id;
    returnedFolderId = actualFolderId;
    returnedFolderName = createdSurvey?.survey_folder_name ?? createdSurvey?.folder_name;
    if (actualFolderId !== undefined) {
      folderVerified = true;
      if (String(actualFolderId) !== String(surveyFolderId)) {
        folderMismatch = `Requested folder ID ${surveyFolderId} but survey is in folder ${actualFolderId}. The folder was not applied — verify the folder ID is correct for this account.`;
        warnings.push(folderMismatch);
      }
    } else {
      // See comment above — optional chaining keeps this safe in the
      // pino-free serverless build.
      req.log?.warn?.({ surveyId }, "create-survey response did not include survey_folder_id");
    }
  }

  const displayLogic = {
    attempted: dlAttempted,
    succeeded: logicsApplied,
    failed: dlFailed,
    details: displayLogicDetails,
  };
  res.json({ surveyId, questionsCreated, logicsApplied, displayLogic, warnings, questionResults, debugLog, baseUrl, folderMismatch, folderVerified, folderRequested: surveyFolderId ?? null, returnedFolderId, returnedFolderName, sectionsCreated, enrichedCount, compatibleCount, fallbackCount, surveyCreateResponse: surveyResult.data });
});

/**
 * POST /api/variables-batch
 *
 * Attaches per-survey context variables to an already-created survey. Wraps
 * SurveySparrow's POST /v3/variables/batch endpoint:
 *   - Body: { survey_id, variables: [{ name, label, type, description? }] }
 *   - Types: STRING | NUMBER | DATE
 *   - Limit: 1–50 variables per call; name/label ≤ 500, description ≤ 200.
 *
 * Returns the standard { debugLog, ... } shape so the frontend can splice the
 * step into the existing debug log rendered for the create flow.
 */
router.post("/variables-batch", async (req, res) => {
  const { region, apiKey, surveyId, variables } =
    req.body as {
      region?: string;
      apiKey?: string;
      surveyId?: number | string;
      variables?: Array<{ name: string; label?: string; type: string; description?: string }>;
    };

  if (!region || !apiKey || !surveyId) {
    res.status(400).json({ error: "region, apiKey, and surveyId are required" });
    return;
  }
  if (!Array.isArray(variables) || variables.length === 0) {
    res.status(400).json({ error: "variables[] must be a non-empty array" });
    return;
  }
  if (variables.length > 50) {
    res.status(400).json({ error: "Maximum 50 variables per batch (SurveySparrow API limit)" });
    return;
  }

  const ALLOWED_TYPES = new Set(["STRING", "NUMBER", "DATE"]);
  for (const v of variables) {
    if (!v || typeof v.name !== "string" || !v.name.trim()) {
      res.status(400).json({ error: "every variable needs a non-empty name" });
      return;
    }
    if (v.name.length > 500 || (v.label != null && v.label.length > 500)) {
      res.status(400).json({ error: `variable "${v.name}": name/label must be ≤ 500 characters` });
      return;
    }
    if (v.description != null && v.description.length > 200) {
      res.status(400).json({ error: `variable "${v.name}": description must be ≤ 200 characters` });
      return;
    }
    if (!ALLOWED_TYPES.has(v.type)) {
      res.status(400).json({ error: `variable "${v.name}": type must be one of STRING, NUMBER, DATE` });
      return;
    }
  }

  const baseUrl = getBaseUrl(region);
  const debugLog: DebugEntry[] = [];

  const payload = {
    survey_id: Number(surveyId),
    variables: variables.map((v) => ({
      name: v.name,
      // The API requires both. If the user didn't give a separate display
      // label, reuse the name — SurveySparrow accepts it.
      label: v.label?.trim() || v.name,
      type: v.type,
      ...(v.description ? { description: v.description } : {}),
    })),
  };

  const endpoint = "/v3/variables/batch";
  try {
    const result = await ssPost(baseUrl, apiKey, endpoint, payload);
    debugLog.push({
      step: "Create Variables (batch)",
      endpoint: `POST ${endpoint}`,
      status: result.status,
      payload,
      response: result.data,
    });
    if (!result.ok) {
      res.status(result.status).json({
        error: "Variables batch creation failed: " + JSON.stringify(result.data),
        debugLog,
      });
      return;
    }
    const created = Array.isArray(result.data?.data) ? result.data.data : [];
    res.json({ variablesCreated: created.length, response: result.data, debugLog });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog.push({
      step: "Create Variables (batch)",
      endpoint: `POST ${endpoint}`,
      status: "network error",
      payload,
      response: null,
      error: msg,
    });
    res.status(500).json({ error: "Failed to attach variables: " + msg, debugLog });
  }
});

/**
 * For NPS / CES / CSAT surveys, SurveySparrow auto-creates a native score
 * question during POST /v3/surveys (using the account's default text — e.g.
 * "How satisfied are you with <YourCompany>?"). When the user's structured
 * prompt overrides that score with custom text, we patch the native question
 * in-place rather than creating a second one.
 *
 * Returns undefined on success, or a short error string on failure (which
 * the caller turns into a result-table warning). Never throws.
 */
async function patchNativeScoreQuestion(
  baseUrl: string,
  apiKey: string,
  surveyId: number | string,
  surveyType: "NPS" | "CES" | "CSAT",
  override: { text: string; required: boolean; localId: string },
  debugLog: DebugEntry[],
): Promise<string | undefined> {
  const listEndpoint = `/v3/questions?survey_id=${encodeURIComponent(String(surveyId))}`;
  let listResult;
  try {
    listResult = await ssGet(baseUrl, apiKey, listEndpoint);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog.push({
      step: `Lookup native ${surveyType} score question`,
      endpoint: `GET ${listEndpoint}`,
      status: "network error",
      payload: null,
      response: null,
      error: msg,
    });
    return `network error while listing questions: ${msg}`;
  }
  debugLog.push({
    step: `Lookup native ${surveyType} score question`,
    endpoint: `GET ${listEndpoint}`,
    status: listResult.status,
    payload: null,
    response: listResult.data,
  });
  if (!listResult.ok) {
    return `GET /v3/questions returned ${listResult.status}`;
  }

  // SurveySparrow may wrap the list in { data: [...] } or return the array
  // directly. Normalize before searching.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = listResult.data;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items: any[] = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
  if (items.length === 0) {
    return "no questions returned from list endpoint";
  }

  // Identify the native score question. SurveySparrow's question.type for the
  // native one matches the survey type (NPSFeedback / CSATFeedback /
  // CESFeedback), or sometimes just NPS/CSAT/CES. The native question is
  // always position 1 in a freshly-created survey, so position is the most
  // reliable tiebreaker.
  const nativeTypeNames = new Set([
    surveyType,
    `${surveyType}Feedback`,
    `${surveyType}Question`,
  ].map((s) => s.toLowerCase()));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let nativeQ: any = items.find((q) => {
    const t = String(q?.type ?? "").toLowerCase();
    return nativeTypeNames.has(t);
  });
  if (!nativeQ) {
    // Fallback: take the first question on the survey — for a brand-new
    // NPS/CES/CSAT survey there's only one auto-created question.
    nativeQ = items.find((q) => Number(q?.position ?? 0) === 1) ?? items[0];
  }
  const nativeId = nativeQ?.id;
  if (!nativeId) {
    return "could not identify native score question id in list response";
  }

  const patchEndpoint = `/v3/questions/${encodeURIComponent(String(nativeId))}`;
  const patchPayload = {
    survey_id: Number(surveyId),
    question: {
      text: override.text,
      required: override.required,
    },
  };
  let patchResult;
  try {
    patchResult = await ssPut(baseUrl, apiKey, patchEndpoint, patchPayload);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog.push({
      step: `Patch native ${surveyType} score question`,
      endpoint: `PUT ${patchEndpoint}`,
      status: "network error",
      payload: patchPayload,
      response: null,
      error: msg,
    });
    return `network error while updating question ${nativeId}: ${msg}`;
  }
  debugLog.push({
    step: `Patch native ${surveyType} score question`,
    endpoint: `PUT ${patchEndpoint}`,
    status: patchResult.status,
    payload: patchPayload,
    response: patchResult.data,
  });
  if (!patchResult.ok) {
    return `PUT /v3/questions/${nativeId} returned ${patchResult.status}`;
  }
  return undefined;
}

async function attemptCreateQuestion(
  baseUrl: string,
  apiKey: string,
  surveyId: number | string,
  q: ParsedQuestion,
  intendedType: string,
  endpoint: string,
  debugLog: DebugEntry[],
  sectionId?: number | string,
): Promise<{ id?: number | string; createdType: string; status: QuestionStatus; warning?: string }> {
  const sidField: Record<string, unknown> = sectionId !== undefined ? { section_id: Number(sectionId) } : {};
  const descField: Record<string, unknown> = q.description ? { description: q.description } : {};

  // Option-based types with no choices → fallback immediately (don't call API with empty choices)
  const CHOICE_REQUIRED = new Set(["MultiChoice", "Dropdown", "RankOrder"]);
  if (CHOICE_REQUIRED.has(intendedType) && q.options.length === 0) {
    return attemptFallback(baseUrl, apiKey, surveyId, q, intendedType, endpoint, debugLog, `${intendedType} has no options`, sectionId);
  }

  // ContactForm: go straight to TextInput fallback
  if (intendedType === "ContactForm") {
    return attemptFallback(baseUrl, apiKey, surveyId, q, intendedType, endpoint, debugLog, "ContactForm always falls back to TextInput", sectionId);
  }

  // DateTime: dedicated handler (enriched → minimal, no fallback to other types)
  if (intendedType === "DateTime") {
    return attemptDateTime(baseUrl, apiKey, surveyId, q, endpoint, debugLog, sectionId);
  }

  // Matrix / BipolarMatrix: dedicated handler
  if (intendedType === "Matrix" || intendedType === "BipolarMatrix") {
    return attemptMatrix(baseUrl, apiKey, surveyId, q, intendedType, endpoint, debugLog, sectionId);
  }

  // ConstantSum: dedicated handler
  if (intendedType === "ConstantSum") {
    return attemptConstantSum(baseUrl, apiKey, surveyId, q, endpoint, debugLog, sectionId);
  }

  // Consent: dedicated handler
  if (intendedType === "Consent") {
    return attemptConsent(baseUrl, apiKey, surveyId, q, endpoint, debugLog, sectionId);
  }

  // Enriched-first strategy for types that have enriched payloads
  const enrichedBody = buildEnrichedBody(q, intendedType);
  if (enrichedBody) {
    const enrichedPayload = { survey_id: Number(surveyId), ...sidField, question: { ...enrichedBody, ...descField } };
    const r1 = await ssPost(baseUrl, apiKey, endpoint, enrichedPayload);
    debugLog.push({ step: `Create Q${q.localId} (enriched)`, endpoint: `POST ${endpoint}`, status: r1.status, payload: enrichedPayload, response: r1.data });
    if (r1.ok) {
      const id = r1.data?.data?.id ?? r1.data?.id;
      return id !== undefined
        ? { id, createdType: intendedType, status: "created_enriched" }
        : { createdType: intendedType, status: "created_enriched", warning: "could not read question ID from response" };
    }
    if (r1.status !== 400) {
      return { createdType: intendedType, status: "failed", warning: `question creation failed — ${JSON.stringify(r1.data)}` };
    }
    // Enriched rejected (400) → retry with minimal payload (omit description — may have caused the 400)
    const minimalPayload = { survey_id: Number(surveyId), ...sidField, question: buildMinimalBody(q, intendedType) };
    const r2 = await ssPost(baseUrl, apiKey, endpoint, minimalPayload);
    debugLog.push({ step: `Create Q${q.localId} (minimal retry)`, endpoint: `POST ${endpoint}`, status: r2.status, payload: minimalPayload, response: r2.data });
    if (r2.ok) {
      const id = r2.data?.data?.id ?? r2.data?.id;
      const retryWarn = q.description
        ? "enriched payload rejected; created without description after retry"
        : "enriched payload rejected; created with minimal payload";
      return id !== undefined
        ? { id, createdType: intendedType, status: "created_retry", warning: retryWarn }
        : { createdType: intendedType, status: "created_retry", warning: retryWarn + "; could not read question ID" };
    }
    return attemptFallback(baseUrl, apiKey, surveyId, q, intendedType, endpoint, debugLog, undefined, sectionId);
  }

  // No enrichment available — standard minimal-first flow (MultiChoice, Dropdown, RankOrder, etc.)
  // Build option extras for MultiChoice
  const extras: Record<string, unknown> = {};
  if (intendedType === "MultiChoice") {
    const isMultiple = q.type.toLowerCase().includes("multiple");
    if (q.hasOther) { extras.other = true; extras.other_text = { text: "Other" }; }
    if (q.hasNoneOfAbove) extras.none_of_the_above = true;
    if (q.hasAllOfAbove && isMultiple) extras.all_of_the_above = true;
    if (q.randomizeOptions) extras.randomized = true;
  }
  const primaryPayload = { survey_id: Number(surveyId), ...sidField, question: { ...buildMinimalBody(q, intendedType), ...descField, ...extras } };
  const first = await ssPost(baseUrl, apiKey, endpoint, primaryPayload);
  debugLog.push({ step: `Create Q${q.localId}`, endpoint: `POST ${endpoint}`, status: first.status, payload: primaryPayload, response: first.data });
  if (first.ok) {
    const id = first.data?.data?.id ?? first.data?.id;
    return id !== undefined ? { id, createdType: intendedType, status: "created" } : { createdType: intendedType, status: "created", warning: "could not read question ID from response" };
  }
  if (first.status !== 400) {
    return { createdType: intendedType, status: "failed", warning: `question creation failed — ${JSON.stringify(first.data)}` };
  }

  // Retry without extras/description — bare minimum
  const retryPayload = { survey_id: Number(surveyId), ...sidField, question: { text: q.text, type: intendedType, required: Boolean(q.required) } };
  const retry = await ssPost(baseUrl, apiKey, endpoint, retryPayload);
  debugLog.push({ step: `Create Q${q.localId} (retry)`, endpoint: `POST ${endpoint}`, status: retry.status, payload: retryPayload, response: retry.data });
  if (retry.ok) {
    const id = retry.data?.data?.id ?? retry.data?.id;
    const retryWarn = q.description ? "created without description after retry" : "created with minimal payload after retry";
    return id !== undefined ? { id, createdType: intendedType, status: "created_retry", warning: retryWarn } : { createdType: intendedType, status: "created_retry", warning: retryWarn + "; could not read question ID" };
  }

  return attemptFallback(baseUrl, apiKey, surveyId, q, intendedType, endpoint, debugLog, undefined, sectionId);
}

async function attemptDateTime(
  baseUrl: string, apiKey: string, surveyId: number | string, q: ParsedQuestion,
  endpoint: string, debugLog: DebugEntry[], sectionId?: number | string,
): Promise<{ id?: number | string; createdType: string; status: QuestionStatus; warning?: string }> {
  const sidField: Record<string, unknown> = sectionId !== undefined ? { section_id: Number(sectionId) } : {};
  const enrichedBody = buildEnrichedBody(q, "DateTime");
  if (enrichedBody) {
    const enrichedPayload = { survey_id: Number(surveyId), ...sidField, question: enrichedBody };
    const r1 = await ssPost(baseUrl, apiKey, endpoint, enrichedPayload);
    debugLog.push({ step: `Create Q${q.localId} DateTime (enriched)`, endpoint: `POST ${endpoint}`, status: r1.status, payload: enrichedPayload, response: r1.data });
    if (r1.ok) {
      const id = r1.data?.data?.id ?? r1.data?.id;
      return id !== undefined
        ? { id, createdType: "DateTime", status: "created_enriched" }
        : { createdType: "DateTime", status: "created_enriched", warning: "could not read question ID from response" };
    }
    // Any enriched failure → retry minimal (do not hard-fail yet)
  }
  const minimalBody = { text: q.text, type: "DateTime", required: Boolean(q.required) };
  const minimalPayload = { survey_id: Number(surveyId), ...sidField, question: minimalBody };
  const r2 = await ssPost(baseUrl, apiKey, endpoint, minimalPayload);
  debugLog.push({ step: `Create Q${q.localId} DateTime (minimal retry)`, endpoint: `POST ${endpoint}`, status: r2.status, payload: minimalPayload, response: r2.data });
  if (r2.ok) {
    const id = r2.data?.data?.id ?? r2.data?.id;
    return id !== undefined
      ? { id, createdType: "DateTime", status: "created_retry", warning: "enriched DateTime payload rejected; created with minimal payload" }
      : { createdType: "DateTime", status: "created_retry", warning: "enriched DateTime payload rejected; minimal retry succeeded but could not read ID" };
  }
  return { createdType: "DateTime", status: "failed", warning: `DateTime question failed — enriched and minimal both rejected: ${JSON.stringify(r2.data)}` };
}

async function attemptFallback(
  baseUrl: string, apiKey: string, surveyId: number | string, q: ParsedQuestion,
  intendedType: string, endpoint: string, debugLog: DebugEntry[], reason?: string, sectionId?: number | string,
): Promise<{ id?: number | string; createdType: string; status: QuestionStatus; warning?: string }> {
  const sidField: Record<string, unknown> = sectionId !== undefined ? { section_id: Number(sectionId) } : {};
  const fallbackBody = buildFallbackBody(q, intendedType);
  const fallbackPayload = { survey_id: Number(surveyId), ...sidField, question: fallbackBody };
  const fallbackType = fallbackBody.type as string;
  const fb = await ssPost(baseUrl, apiKey, endpoint, fallbackPayload);
  debugLog.push({ step: `Create Q${q.localId} (fallback)`, endpoint: `POST ${endpoint}`, status: fb.status, payload: fallbackPayload, response: fb.data });
  if (fb.ok) {
    const id = fb.data?.data?.id ?? fb.data?.id;
    const msg = reason ? `${reason}; created as ${fallbackType}` : `created using fallback type ${fallbackType}`;
    return id !== undefined ? { id, createdType: fallbackType, status: "created_fallback", warning: msg } : { createdType: fallbackType, status: "created_fallback", warning: msg + "; could not read question ID" };
  }
  return { createdType: intendedType, status: "failed", warning: `failed after retry and fallback — ${JSON.stringify(fb.data)}` };
}

async function attemptMatrix(
  baseUrl: string, apiKey: string, surveyId: number | string, q: ParsedQuestion,
  type: "Matrix" | "BipolarMatrix", endpoint: string, debugLog: DebugEntry[], sectionId?: number | string,
): Promise<{ id?: number | string; createdType: string; status: QuestionStatus; warning?: string }> {
  const sidField: Record<string, unknown> = sectionId !== undefined ? { section_id: Number(sectionId) } : {};
  // Matrix/BipolarMatrix with missing rows or columns → fallback immediately (do not synthesise placeholder rows/cols)
  if (q.rows.length === 0 || q.columns.length === 0) {
    const missing = q.rows.length === 0 && q.columns.length === 0 ? "rows and columns" : q.rows.length === 0 ? "rows" : "columns";
    return attemptFallback(baseUrl, apiKey, surveyId, q, type, endpoint, debugLog, `${type} missing ${missing}`, sectionId);
  }
  const rows = q.rows;
  const cols = q.columns;

  // ── BipolarMatrix: each row must have left_text + right_text ──
  if (type === "BipolarMatrix") {
    // Auto-generate 1–5 columns when fewer than 3 are supplied
    const effectiveCols = cols.length >= 3 ? cols : ["1", "2", "3", "4", "5"];
    const colField = effectiveCols.map((c) => ({ name: c }));

    const rowField: { left_text: string; right_text: string }[] = [];
    for (const r of rows) {
      let left = "";
      let right = "";
      if (r.includes("|")) {
        const idx = r.indexOf("|");
        left = r.slice(0, idx).trim();
        right = r.slice(idx + 1).trim();
      } else if (r.includes(" / ")) {
        const parts = r.split(" / ");
        left = parts[0].trim();
        right = parts.slice(1).join(" / ").trim();
      } else if (/ vs /i.test(r)) {
        const parts = r.split(/ vs /i);
        left = parts[0].trim();
        right = parts.slice(1).join(" vs ").trim();
      } else if (r.includes(" - ")) {
        // Only use " - " when there is exactly one occurrence and both sides are non-empty
        const parts = r.split(" - ");
        if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
          left = parts[0].trim();
          right = parts[1].trim();
        }
      }
      if (!left || !right) {
        return attemptFallback(baseUrl, apiKey, surveyId, q, type, endpoint, debugLog,
          `BipolarMatrix row "${r}" has no right_text — use "Left label | Right label" format`, sectionId);
      }
      rowField.push({ left_text: left, right_text: right });
    }

    const payload = { survey_id: Number(surveyId), ...sidField, question: { text: q.text, type: "BipolarMatrix", required: Boolean(q.required), row: rowField, column: colField } };
    const r1 = await ssPost(baseUrl, apiKey, endpoint, payload);
    debugLog.push({ step: `Create Q${q.localId} (enriched)`, endpoint: `POST ${endpoint}`, status: r1.status, payload, response: r1.data });
    if (r1.ok) {
      const id = r1.data?.data?.id ?? r1.data?.id;
      return id !== undefined ? { id, createdType: "BipolarMatrix", status: "created_enriched" } : { createdType: "BipolarMatrix", status: "created_enriched", warning: "could not read question ID" };
    }
    return attemptFallback(baseUrl, apiKey, surveyId, q, type, endpoint, debugLog,
      `BipolarMatrix creation failed — ${JSON.stringify(r1.data)}`, sectionId);
  }

  // ── Regular Matrix ──
  const colField = cols.map((c) => ({ name: c }));
  const rowField = rows.map((r) => ({ left_text: r }));

  // Attempt 1 (enriched): row/column at root + properties.data.type = "SINGLE_ANSWER"
  const enrichedAttempt = {
    survey_id: Number(surveyId),
    ...sidField,
    question: { text: q.text, type, required: Boolean(q.required), row: rowField, column: colField, properties: { data: { type: "SINGLE_ANSWER" } } },
  };
  const r1 = await ssPost(baseUrl, apiKey, endpoint, enrichedAttempt);
  debugLog.push({ step: `Create Q${q.localId} (enriched)`, endpoint: `POST ${endpoint}`, status: r1.status, payload: enrichedAttempt, response: r1.data });
  if (r1.ok) {
    const id = r1.data?.data?.id ?? r1.data?.id;
    return id !== undefined ? { id, createdType: type, status: "created_enriched" } : { createdType: type, status: "created_enriched", warning: "could not read question ID" };
  }

  // Attempt 2 (minimal retry): row/column at root, no properties
  const bareAttempt = { survey_id: Number(surveyId), ...sidField, question: { text: q.text, type, required: Boolean(q.required), row: rowField, column: colField } };
  const r2 = await ssPost(baseUrl, apiKey, endpoint, bareAttempt);
  debugLog.push({ step: `Create Q${q.localId} (minimal retry)`, endpoint: `POST ${endpoint}`, status: r2.status, payload: bareAttempt, response: r2.data });
  if (r2.ok) {
    const id = r2.data?.data?.id ?? r2.data?.id;
    return id !== undefined ? { id, createdType: type, status: "created_retry", warning: "created without enriched properties" } : { createdType: type, status: "created_retry", warning: "minimal retry succeeded but could not read ID" };
  }

  // Fallback: TextInput with rows/columns embedded in question text
  const rowsStr = rows.join(", ");
  const colsStr = cols.join(", ");
  const fallbackText = `${q.text} (Rows: ${rowsStr} | Columns: ${colsStr})`;
  const fbPayload = { survey_id: Number(surveyId), ...sidField, question: { text: fallbackText, type: "TextInput", required: Boolean(q.required) } };
  const rfb = await ssPost(baseUrl, apiKey, endpoint, fbPayload);
  debugLog.push({ step: `Create Q${q.localId} (fallback TextInput)`, endpoint: `POST ${endpoint}`, status: rfb.status, payload: fbPayload, response: rfb.data });
  if (rfb.ok) {
    const id = rfb.data?.data?.id ?? rfb.data?.id;
    return { id, createdType: "TextInput", status: "created_fallback", warning: "Matrix not supported; created as TextInput with rows/columns in text" };
  }
  return { createdType: type, status: "failed", warning: `failed all attempts — ${JSON.stringify(rfb.data)}` };
}

async function attemptConstantSum(
  baseUrl: string, apiKey: string, surveyId: number | string, q: ParsedQuestion,
  endpoint: string, debugLog: DebugEntry[], sectionId?: number | string,
): Promise<{ id?: number | string; createdType: string; status: QuestionStatus; warning?: string }> {
  const sidField: Record<string, unknown> = sectionId !== undefined ? { section_id: Number(sectionId) } : {};
  // Determine rows: options → rows → fallback to TextInput immediately
  const rawItems = q.options.length > 0 ? q.options : q.rows.length > 0 ? q.rows : null;
  if (!rawItems) {
    const fbPayload = { survey_id: Number(surveyId), ...sidField, question: { text: q.text, type: "TextInput", required: Boolean(q.required) } };
    const rfb = await ssPost(baseUrl, apiKey, endpoint, fbPayload);
    debugLog.push({ step: `Create Q${q.localId} (fallback TextInput)`, endpoint: `POST ${endpoint}`, status: rfb.status, payload: fbPayload, response: rfb.data });
    if (rfb.ok) {
      const id = rfb.data?.data?.id ?? rfb.data?.id;
      return { id, createdType: "TextInput", status: "created_fallback", warning: "ConstantSum has no items; created as TextInput" };
    }
    return { createdType: "ConstantSum", status: "failed", warning: `ConstantSum has no items and TextInput fallback failed — ${JSON.stringify(rfb.data)}` };
  }

  const rows = rawItems.map((o) => ({ left_text: o }));

  // Extract total_sum: "total of 100", "total 100", "total of 10", "total 10"
  const totalMatch = q.text.match(/total\s+(?:of\s+)?(\d+)/i);
  const totalSum = totalMatch ? Number(totalMatch[1]) : 100;

  // Attempt 1 (enriched): row + properties.data with type, total_sum, show_total
  const attempt1 = {
    survey_id: Number(surveyId),
    ...sidField,
    question: {
      text: q.text, type: "ConstantSum", required: Boolean(q.required),
      row: rows,
      properties: { data: { type: "TEXT", total_sum: totalSum, show_total: true } },
    },
  };
  const r1 = await ssPost(baseUrl, apiKey, endpoint, attempt1);
  debugLog.push({ step: `Create Q${q.localId} (enriched)`, endpoint: `POST ${endpoint}`, status: r1.status, payload: attempt1, response: r1.data });
  if (r1.ok) {
    const id = r1.data?.data?.id ?? r1.data?.id;
    const note = `ConstantSum created enriched with total_sum ${totalSum}.`;
    return id !== undefined ? { id, createdType: "ConstantSum", status: "created_enriched", warning: note } : { createdType: "ConstantSum", status: "created_enriched", warning: note + " Could not read question ID." };
  }

  // Attempt 2 (minimal retry): row only, no properties
  const attempt2 = {
    survey_id: Number(surveyId),
    ...sidField,
    question: { text: q.text, type: "ConstantSum", required: Boolean(q.required), row: rows },
  };
  const r2 = await ssPost(baseUrl, apiKey, endpoint, attempt2);
  debugLog.push({ step: `Create Q${q.localId} (minimal retry)`, endpoint: `POST ${endpoint}`, status: r2.status, payload: attempt2, response: r2.data });
  if (r2.ok) {
    const id = r2.data?.data?.id ?? r2.data?.id;
    return id !== undefined ? { id, createdType: "ConstantSum", status: "created_retry", warning: "ConstantSum created with row only (properties rejected)." } : { createdType: "ConstantSum", status: "created_retry", warning: "ConstantSum row-only retry succeeded; could not read question ID." };
  }

  // Fallback: TextInput (preserve allocation wording — MultiChoice loses semantics)
  const fbPayload = { survey_id: Number(surveyId), ...sidField, question: { text: q.text, type: "TextInput", required: Boolean(q.required) } };
  const rfb = await ssPost(baseUrl, apiKey, endpoint, fbPayload);
  debugLog.push({ step: `Create Q${q.localId} (fallback TextInput)`, endpoint: `POST ${endpoint}`, status: rfb.status, payload: fbPayload, response: rfb.data });
  if (rfb.ok) {
    const id = rfb.data?.data?.id ?? rfb.data?.id;
    return { id, createdType: "TextInput", status: "created_fallback", warning: "ConstantSum failed, created as TextInput to preserve allocation wording." };
  }
  return { createdType: "ConstantSum", status: "failed", warning: `failed all attempts — ${JSON.stringify(rfb.data)}` };
}

async function attemptConsent(
  baseUrl: string, apiKey: string, surveyId: number | string, q: ParsedQuestion,
  endpoint: string, debugLog: DebugEntry[], sectionId?: number | string,
): Promise<{ id?: number | string; createdType: string; status: QuestionStatus; warning?: string }> {
  const sidField: Record<string, unknown> = sectionId !== undefined ? { section_id: Number(sectionId) } : {};
  const consentText = q.consentText || "I agree to the terms and conditions.";

  // Attempt 1 (enriched): properties.data with consent_text — do NOT send required for Consent
  const enriched = {
    survey_id: Number(surveyId),
    ...sidField,
    question: { text: q.text, type: "Consent", properties: { data: { consent_text: consentText, show_terms_and_condition: true } } },
  };
  const r1 = await ssPost(baseUrl, apiKey, endpoint, enriched);
  debugLog.push({ step: `Create Q${q.localId} (enriched)`, endpoint: `POST ${endpoint}`, status: r1.status, payload: enriched, response: r1.data });
  if (r1.ok) {
    const id = r1.data?.data?.id ?? r1.data?.id;
    return id !== undefined ? { id, createdType: "Consent", status: "created_enriched" } : { createdType: "Consent", status: "created_enriched", warning: "could not read question ID" };
  }

  // Attempt 2 (minimal retry): bare Consent — no required, no properties
  const bare = { survey_id: Number(surveyId), ...sidField, question: { text: q.text, type: "Consent" } };
  const r2 = await ssPost(baseUrl, apiKey, endpoint, bare);
  debugLog.push({ step: `Create Q${q.localId} (minimal retry)`, endpoint: `POST ${endpoint}`, status: r2.status, payload: bare, response: r2.data });
  if (r2.ok) {
    const id = r2.data?.data?.id ?? r2.data?.id;
    return id !== undefined ? { id, createdType: "Consent", status: "created_retry", warning: "enriched Consent rejected; created with bare payload" } : { createdType: "Consent", status: "created_retry", warning: "enriched rejected; bare retry succeeded but could not read ID" };
  }

  // Fallback: TextInput with consent text appended
  const fbText = q.consentText ? `${q.text} ${q.consentText}` : q.text;
  const fbPayload = { survey_id: Number(surveyId), ...sidField, question: { text: fbText, type: "TextInput", required: false } };
  const rfb = await ssPost(baseUrl, apiKey, endpoint, fbPayload);
  debugLog.push({ step: `Create Q${q.localId} (fallback TextInput)`, endpoint: `POST ${endpoint}`, status: rfb.status, payload: fbPayload, response: rfb.data });
  if (rfb.ok) {
    const id = rfb.data?.data?.id ?? rfb.data?.id;
    return { id, createdType: "TextInput", status: "created_fallback", warning: "Consent not supported; created as TextInput" };
  }
  return { createdType: "Consent", status: "failed", warning: `failed all attempts — ${JSON.stringify(rfb.data)}` };
}

function buildMinimalBody(q: ParsedQuestion, type: string): Record<string, unknown> {
  const base = { text: q.text, type, required: Boolean(q.required) };
  const choices = q.options.map((o) => ({ text: o }));
  const isMultiple = q.type.toLowerCase().includes("multiple");

  switch (type) {
    case "MultiChoice":
      return { ...base, multiple_answers: isMultiple, choices: choices.length > 0 ? choices : [] };
    case "Dropdown":
    case "RankOrder":
      return { ...base, choices: choices.length > 0 ? choices : [] };
    default:
      return base;
  }
}

function buildEnrichedBody(q: ParsedQuestion, type: string): Record<string, unknown> | null {
  const required = Boolean(q.required);
  const base = { text: q.text, type, required };

  switch (type) {
    case "TextInput": {
      const rawType = q.type.toLowerCase();
      const isLong = rawType.includes("long") || rawType === "paragraph" ||
        rawType === "open-ended" || rawType === "comment box" || rawType === "free text";
      return { ...base, properties: { data: { type: isLong ? "MULTI_LINE" : "SINGLE_LINE" } } };
    }
    case "Rating": {
      let ratingScale = 5;
      if (q.scale) {
        const rangeMatch = q.scale.match(/^(\d+)\s*-\s*(\d+)$/);
        if (rangeMatch) {
          ratingScale = parseInt(rangeMatch[2], 10);
        } else {
          const single = parseInt(q.scale, 10);
          if (!isNaN(single)) ratingScale = single;
        }
        ratingScale = Math.max(3, Math.min(10, ratingScale));
      }
      return { ...base, properties: { data: { rating_scale: ratingScale, icon_array_name: "RATING_STAR" } } };
    }
    case "OpinionScale": {
      let start = 0;
      let step = 10;
      if (q.scale) {
        const rangeMatch = q.scale.match(/^(\d+)\s*-\s*(\d+)$/);
        if (rangeMatch) {
          start = parseInt(rangeMatch[1], 10);
          step = parseInt(rangeMatch[2], 10);
        } else {
          const single = parseInt(q.scale, 10);
          if (!isNaN(single) && single > 0) step = single;
        }
      }
      return {
        ...base,
        properties: {
          data: {
            step,
            start,
            min: q.minLabel || "Not at all likely",
            max: q.maxLabel || "Extremely likely",
          },
        },
      };
    }
    case "YesNo":
      return { ...base, properties: { data: { yes_text: "Yes", no_text: "No", icon_shape: "YES_NO_ICON_TICK_CROSS" } } };
    case "DateTime": {
      const rawType = q.type.toLowerCase();
      const isDateOnly = rawType === "date" || rawType === "date_only" || rawType.includes("date only");
      if (isDateOnly) {
        return { ...base, properties: { data: { type: "DATE_ONLY", date_format: "DDMMYYYY", show_calendar: true } } };
      }
      return { ...base, properties: { data: { type: "DATETIME", date_format: "DDMMYYYY", time_format: "TWELVE_HOUR", show_calendar: true } } };
    }
    case "Signature":
      return { ...base, properties: { data: { draw_signature: true, type_signature: true, upload_signature: false } } };
    case "FileInput":
      return { ...base, properties: { data: { fileTypes: ["doc", "image"], maximum_number_of_files: 1 } } };
    case "NPSFeedback": {
      // Score question is implicit in NPS surveys; this payload is the per-rating
      // follow-up. If only one generic follow-up text was provided, reuse it for
      // all three buckets so the survey still has meaningful prompts.
      const fallback = q.text;
      return {
        ...base,
        properties: {
          data: {
            promoter:  q.feedbackPromoter  || fallback,
            passive:   q.feedbackPassive   || fallback,
            detractor: q.feedbackDetractor || fallback,
            include_feedback_by_rating: true,
          },
        },
      };
    }
    case "CESFeedback": {
      const fallback = q.text;
      return {
        ...base,
        properties: {
          data: {
            low_effort:  q.feedbackLowEffort  || fallback,
            neutral:     q.feedbackNeutral    || fallback,
            high_effort: q.feedbackHighEffort || fallback,
            include_feedback_by_rating: true,
          },
        },
      };
    }
    case "CSATFeedback": {
      const fallback = q.text;
      return {
        ...base,
        properties: {
          data: {
            satisfied:    q.feedbackSatisfied    || fallback,
            dissatisfied: q.feedbackDissatisfied || fallback,
            include_feedback_by_rating: true,
          },
        },
      };
    }
    default:
      return null;
  }
}

function buildFallbackBody(q: ParsedQuestion, originalType: string): Record<string, unknown> {
  const required = Boolean(q.required);
  const choices = q.options.map((o) => ({ text: o }));

  if (originalType === "YesNo") {
    return { text: q.text, type: "MultiChoice", required, multiple_answers: false, choices: [{ text: "Yes" }, { text: "No" }] };
  }
  if (originalType === "Rating" || originalType === "CESFeedback" || originalType === "CSATFeedback") {
    const suffix = originalType === "CESFeedback" ? "(CES 1-5)" : originalType === "CSATFeedback" ? "(CSAT 1-5)" : "(1-5)";
    const text = q.text.includes(suffix) ? q.text : `${q.text} ${suffix}`;
    return { text, type: "MultiChoice", required, multiple_answers: false, choices: Array.from({ length: 5 }, (_, i) => ({ text: String(i + 1) })) };
  }
  if (originalType === "OpinionScale" || originalType === "NPSFeedback") {
    const suffix = originalType === "NPSFeedback" ? "(NPS 0-10)" : "(0-10)";
    const text = q.text.includes(suffix) ? q.text : `${q.text} ${suffix}`;
    return { text, type: "MultiChoice", required, multiple_answers: false, choices: Array.from({ length: 11 }, (_, i) => ({ text: String(i) })) };
  }
  if (choices.length > 0 && (originalType === "Dropdown" || originalType === "RankOrder" || originalType === "ConstantSum")) {
    return { text: q.text, type: "MultiChoice", required, multiple_answers: false, choices };
  }
  if (originalType === "FileInput" || originalType === "AudioInput" || originalType === "CameraInput" || originalType === "Signature") {
    return { text: q.text, type: "TextInput", required: false };
  }
  return { text: q.text, type: "TextInput", required };
}

function getCompatibleQuestionType(
  q: ParsedQuestion,
  intendedType: string,
  surveyType: string,
): { q: ParsedQuestion; remappedType: string; note?: string } {
  const FEEDBACK_TYPES = new Set(["NPSFeedback", "CSATFeedback", "CESFeedback"]);

  // Which feedback type is "native" to the selected survey type
  const nativeFor: Record<string, string> = {
    NPS: "NPSFeedback",
    CSAT: "CSATFeedback",
    CES: "CESFeedback",
  };

  const native = nativeFor[surveyType];

  // Not a feedback type — no remapping needed
  if (!FEEDBACK_TYPES.has(intendedType)) return { q, remappedType: intendedType };

  // The intended type is natively supported by the survey type
  if (intendedType === native) return { q, remappedType: intendedType };

  // Remap
  if (intendedType === "NPSFeedback") {
    return {
      q: { ...q, text: `${q.text} (NPS 0-10)` },
      remappedType: "OpinionScale",
      note: `NPSFeedback is not allowed in ${surveyType}, created as OpinionScale.`,
    };
  }
  if (intendedType === "CESFeedback") {
    return {
      q: { ...q, text: `${q.text} (CES)` },
      remappedType: "Rating",
      note: `CESFeedback is not allowed in ${surveyType}, created as Rating.`,
    };
  }
  if (intendedType === "CSATFeedback") {
    return {
      q: { ...q, text: `${q.text} (CSAT)` },
      remappedType: "Rating",
      note: `CSATFeedback is not allowed in ${surveyType}, created as Rating.`,
    };
  }

  return { q, remappedType: intendedType };
}

function inferType(q: ParsedQuestion): string {
  const raw = q.type.toLowerCase().trim();

  const synonymMap: Record<string, string> = {
    "radio": "single choice", "radio button": "single choice",
    "checkbox": "multiple choice", "checkboxes": "multiple choice",
    "multi-select": "multiple choice", "select all that apply": "multiple choice",
    "free text": "long text", "comment box": "long text",
    "paragraph": "long text", "open-ended": "long text",
    "text": "short text",
    "star rating": "rating", "scale": "rating",
    "ranking": "rank order", "rank": "rank order",
    "file": "file upload", "upload": "file upload", "attachment": "file upload",
    "boolean": "yes/no", "y/n": "yes/no",
    "date picker": "date",
    "website": "url",
    // Explicit feedback-type names emitted by the formatting prompt
    "nps feedback": "npsfeedback",
    "ces feedback": "cesfeedback",
    "csat feedback": "csatfeedback",
  };

  const t = synonymMap[raw] ?? raw;

  if (t === "likert") return (q.rows.length > 0 && q.columns.length > 0) ? "Matrix" : "OpinionScale";

  if (t === "single choice")    return "MultiChoice";
  if (t === "multiple choice")  return "MultiChoice";
  if (t === "dropdown")         return "Dropdown";
  if (t === "rating")           return "Rating";
  if (t === "opinion scale")    return "OpinionScale";
  if (t === "nps")              return "NPSFeedback";
  if (t === "csat")             return "CSATFeedback";
  if (t === "ces")              return "CESFeedback";
  if (t === "npsfeedback")      return "NPSFeedback";
  if (t === "csatfeedback")     return "CSATFeedback";
  if (t === "cesfeedback")      return "CESFeedback";
  if (t === "yes/no")           return "YesNo";
  if (t === "short text")       return "TextInput";
  if (t === "long text")        return "TextInput";
  if (t === "email")            return "EmailInput";
  if (t === "phone")            return "PhoneNumber";
  if (t === "number")           return "NumberInput";
  if (t === "url")              return "URLInput";
  if (t === "date")             return "DateTime";
  if (t === "file upload")      return "FileInput";
  if (t === "image upload")     return "CameraInput";
  if (t === "audio upload")     return "AudioInput";
  if (t === "signature")        return "Signature";
  if (t === "consent")          return "Consent";
  if (t === "rank order")       return "RankOrder";
  if (t === "matrix")           return "Matrix";
  if (t === "bipolar matrix")   return "BipolarMatrix";
  if (t === "constant sum")     return "ConstantSum";
  if (t === "slider")           return "Slider";
  if (t === "message")          return "Message";
  if (t === "contact form")     return "ContactForm";

  if (!raw) {
    const text = q.text.toLowerCase();
    if (q.options.length > 0)                                           return "MultiChoice";
    if (q.rows.length > 0 && q.columns.length > 0)                     return "Matrix";
    if (/select all/i.test(q.text))                                     return "MultiChoice";
    if (/\bemail\b/i.test(text))                                        return "EmailInput";
    if (/phone|mobile|contact number/i.test(text))                      return "PhoneNumber";
    if (/\bdate\b/i.test(text) || /^when\b/i.test(q.text))             return "DateTime";
    if (/\brecommend\b/i.test(text))                                    return "NPSFeedback";
    if (/\beffort\b|\beasy\b|\bdifficult\b/i.test(text))               return "CESFeedback";
    if (/satisfi|satisfaction/i.test(text))                             return "Rating";
    if (/\brank\b/i.test(text))                                         return "RankOrder";
    if (/upload|screenshot|\bfile\b|attachment/i.test(text))            return "FileInput";
    if (/^(do you|have you|are you)\b/i.test(q.text) || /yes\/no/i.test(text)) return "YesNo";
    if (/explain|describe|\bcomment\b|feedback|reason|\bwhy\b/i.test(text)) return "TextInput";
    return "TextInput";
  }

  if (q.options.length > 0) return "MultiChoice";
  return "TextInput";
}

/**
 * Position-strict merge of NPS/CES/CSAT score Qs with their immediate follow-up.
 * SurveySparrow only allows ONE NPSFeedback / CESFeedback / CSATFeedback per
 * survey, and it must be attached to the implicit score step — i.e. it must
 * come directly after the score question. This function enforces that:
 *
 *   1. Explicit score Q (`Type: NPS|CES|CSAT`) followed immediately by an
 *      explicit feedback Q (`Type: NPSFeedback|CESFeedback|CSATFeedback`):
 *      drop the score Q (implicit in the survey type), keep the feedback Q
 *      with whatever per-bucket data the user supplied.
 *   2. Explicit score Q followed immediately by a plain open-text Q (any
 *      Short text / Long text / TextInput): drop the score, coerce the
 *      open-text Q into the matching feedback type, reuse its text across
 *      all rating buckets.
 *   3. Explicit score Q alone (no qualifying follow-up directly after): drop
 *      it — the rating step is implicit in NPS/CES/CSAT surveys.
 *   4. Explicit feedback Q that is NOT directly preceded by a score Q:
 *      downgrade to Long text. SurveySparrow rejects a second NPSFeedback
 *      with "feedback question already exists for survey", and the spec
 *      explicitly says only questions right after the score Q can be the
 *      feedback type.
 *   5. Any other open-text or non-score question is left alone.
 *
 * For ClassicForm (and any other survey type) this is a no-op.
 */
interface MergeFeedbackResult {
  questions: ParsedQuestion[];
  /**
   * If the user gave the prompt an explicit score question (Type: NPS / CES /
   * CSAT) inside a native NPS/CES/CSAT survey, we capture its text and
   * required flag here so the route can PATCH SurveySparrow's auto-created
   * default score question after the survey is created. Without this, the
   * user's custom score text was silently lost.
   */
  scoreOverride: { text: string; required: boolean; localId: string } | null;
}

function mergeFeedbackFollowups(
  questions: ParsedQuestion[],
  surveyType: string,
): MergeFeedbackResult {
  const FEEDBACK_FOR: Record<string, string> = {
    NPS: "NPSFeedback",
    CES: "CESFeedback",
    CSAT: "CSATFeedback",
  };
  const feedbackType = FEEDBACK_FOR[surveyType];
  if (!feedbackType) return { questions, scoreOverride: null };

  const isExplicitScore = (q: ParsedQuestion): boolean => {
    const raw = q.type.toLowerCase().trim();
    return raw === "nps" || raw === "ces" || raw === "csat";
  };

  const isExplicitFeedbackType = (q: ParsedQuestion): boolean => {
    const raw = q.type.toLowerCase().trim();
    return raw === "npsfeedback" || raw === "nps feedback" ||
           raw === "cesfeedback" || raw === "ces feedback" ||
           raw === "csatfeedback" || raw === "csat feedback";
  };

  // Any open-text-like question: inferType resolves to TextInput regardless of
  // the surface label (Short text, Long text, Open-ended, etc.).
  const isPlainOpenText = (q: ParsedQuestion): boolean => {
    if (isExplicitScore(q) || isExplicitFeedbackType(q)) return false;
    return inferType(q) === "TextInput";
  };

  // Silent merge: the score Q is dropped (rating is implicit in the survey
  // type) and the follow-up Q is coerced into the matching feedback type. We
  // don't surface a warning here — the user's structured prompt already reads
  // as a normal Long-text follow-up to them.
  const coerceToFeedback = (followup: ParsedQuestion): ParsedQuestion => {
    const text = followup.text;
    const merged: ParsedQuestion = { ...followup, type: feedbackType };
    if (feedbackType === "NPSFeedback") {
      if (!merged.feedbackPromoter)   merged.feedbackPromoter   = text;
      if (!merged.feedbackPassive)    merged.feedbackPassive    = text;
      if (!merged.feedbackDetractor)  merged.feedbackDetractor  = text;
    } else if (feedbackType === "CESFeedback") {
      if (!merged.feedbackLowEffort)  merged.feedbackLowEffort  = text;
      if (!merged.feedbackNeutral)    merged.feedbackNeutral    = text;
      if (!merged.feedbackHighEffort) merged.feedbackHighEffort = text;
    } else if (feedbackType === "CSATFeedback") {
      if (!merged.feedbackSatisfied)    merged.feedbackSatisfied    = text;
      if (!merged.feedbackDissatisfied) merged.feedbackDissatisfied = text;
    }
    return merged;
  };

  const result: ParsedQuestion[] = [];
  /**
   * We keep only the FIRST score-Q override we see. SurveySparrow surveys
   * have one native score question per type, so any subsequent explicit
   * score Qs would still be dropped (and we'd have nothing useful to do
   * with the extra text anyway).
   */
  let scoreOverride: MergeFeedbackResult["scoreOverride"] = null;
  const captureScoreOverride = (q: ParsedQuestion) => {
    if (scoreOverride) return;
    const text = (q.text || "").trim();
    if (!text) return;
    scoreOverride = { text, required: Boolean(q.required), localId: q.localId };
  };

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];

    if (isExplicitScore(q)) {
      // Always capture the score text — whether the score is alone, paired
      // with an explicit feedback Q, or paired with a plain open-text follow-up.
      captureScoreOverride(q);
      const next = questions[i + 1];
      if (next && isExplicitFeedbackType(next)) {
        // Score + explicit feedback Q — drop the score (we'll PATCH the
        // native one later), keep the feedback Q exactly as written.
        result.push(next);
        i++;
        continue;
      }
      if (next && isPlainOpenText(next)) {
        // Score + plain open-text right after — coerce the open-text into
        // the matching feedback type, drop the score.
        result.push(coerceToFeedback(next));
        i++;
        continue;
      }
      // Score Q with no qualifying immediate follow-up — drop it from the
      // questions-to-create list (the rating step is implicit / native),
      // but the override above ensures its custom text is applied later.
      continue;
    }

    if (isExplicitFeedbackType(q)) {
      // Strict rule: only the question immediately after a score Q can be a
      // feedback type. Silently downgrade orphan feedback Qs to Long text.
      result.push({ ...q, type: "Long text" });
      continue;
    }

    result.push(q);
  }
  return { questions: result, scoreOverride };
}

interface ShowIf {
  source: string;
  operator: string;
  value: string;
}

type QuestionStatus = "created" | "created_enriched" | "created_retry" | "created_fallback" | "created_compatible" | "failed";

interface ParsedQuestion {
  localId: string;
  text: string;
  type: string;
  options: string[];
  rows: string[];
  columns: string[];
  consentText: string;
  scale: string;
  required: boolean;
  showIf: ShowIf | null;
  minLabel: string;
  maxLabel: string;
  section: string;
  description: string;
  hasOther: boolean;
  hasNoneOfAbove: boolean;
  hasAllOfAbove: boolean;
  randomizeOptions: boolean;
  // Per-rating follow-up text for NPSFeedback / CESFeedback / CSATFeedback.
  // When unset, buildEnrichedBody falls back to q.text so a single generic
  // follow-up gets reused across all rating buckets.
  feedbackPromoter?: string;
  feedbackPassive?: string;
  feedbackDetractor?: string;
  feedbackLowEffort?: string;
  feedbackNeutral?: string;
  feedbackHighEffort?: string;
  feedbackSatisfied?: string;
  feedbackDissatisfied?: string;
}

interface ParsedPrompt {
  title: string;
  surveyType: string;
  questions: ParsedQuestion[];
  sections: string[];
  welcomeTitle: string;
  welcomeDescription: string;
  thankYouMessage: string;
  thankYouDescription: string;
}

interface DebugEntry {
  step: string;
  endpoint: string;
  status: number | string;
  payload: unknown;
  response: unknown;
  error?: unknown;
}

interface QuestionResult {
  localId: string;
  text: string;
  intendedType: string;
  createdType: string;
  status: QuestionStatus;
  warning?: string;
  section?: string;
}

function normalizeInput(raw: string): string {
  let s = raw;
  s = s.replace(/```[\w]*\n?/g, "").replace(/```\n?/g, "");
  s = s.replace(/[\uFFFC\uFFFD]/g, "");
  s = s.replace(/\u00A0/g, " ");
  s = s.replace(/\t/g, " ");
  s = s.replace(/ +$/gm, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/[\u201C\u201D]/g, '"');
  s = s.replace(/[\u2018\u2019]/g, "'");
  s = s.replace(/[\u2013\u2014]/g, "-");
  return s;
}

function parsePrompt(rawPrompt: string): ParsedPrompt {
  const prompt = normalizeInput(rawPrompt);
  const lines = prompt.split("\n");
  let title = "";
  let surveyType = "";
  let welcomeTitle = "";
  let welcomeDescription = "";
  let thankYouMessage = "";
  let thankYouDescription = "";
  let currentSection = "";
  const sectionNames: string[] = [];
  const questions: ParsedQuestion[] = [];
  let currentQ: ParsedQuestion | null = null;
  let mode: "options" | "rows" | "columns" | null = null;

  const RE_SURVEY_TITLE  = /^survey title\s*:/i;
  const RE_SURVEY_TYPE   = /^survey type\s*:/i;
  const RE_SECTION       = /^(section|page|block)\s*:/i;
  const RE_FIELD_TYPE    = /^(type|question type|answer type|input type|field type|question format)\s*:/i;
  const RE_FIELD_OPTS    = /^(options|choices|answer options|response options|select from|options are)\s*:/i;
  const RE_FIELD_ROWS    = /^(rows|statements|items|aspects)\s*:/i;
  const RE_FIELD_COLS    = /^(columns|scale|ratings|rating scale)\s*:/i;
  const RE_FIELD_REQ     = /^(required|mandatory|required\?|is required)\s*:/i;
  const RE_FIELD_OPT     = /^optional\s*:/i;
  const RE_FIELD_SHOWIF  = /^(show if|display if|ask if|only show if|conditional logic)\s*:/i;
  const RE_FIELD_CONSENT = /^(consent text|agreement text|terms text)\s*:/i;
  const RE_FIELD_SCALE   = /^scale\s*:/i;
  const RE_FIELD_MIN     = /^min label\s*:/i;
  const RE_FIELD_MAX     = /^max label\s*:/i;
  const RE_FIELD_DESC    = /^(description|help text|subtext|helper text)\s*:/i;
  const RE_FIELD_WLCT    = /^welcome title\s*:/i;
  const RE_FIELD_WLCD    = /^welcome description\s*:/i;
  const RE_FIELD_TYM     = /^thank you message\s*:/i;
  const RE_FIELD_TYD     = /^thank you description\s*:/i;
  const RE_FIELD_OTHER   = /^other\s*:/i;
  const RE_FIELD_NONE    = /^none of the above\s*:/i;
  const RE_FIELD_ALL     = /^all of the above\s*:/i;
  const RE_FIELD_RAND    = /^randomize options\s*:/i;
  // Per-rating bucket follow-up text for NPSFeedback / CESFeedback / CSATFeedback.
  const RE_FIELD_PROMOTER  = /^promoter\s*:/i;
  const RE_FIELD_PASSIVE   = /^passive\s*:/i;
  const RE_FIELD_DETRACTOR = /^detractor\s*:/i;
  const RE_FIELD_LOW_EFF   = /^low[\s_-]*effort\s*:/i;
  const RE_FIELD_NEUTRAL   = /^neutral\s*:/i;
  const RE_FIELD_HIGH_EFF  = /^high[\s_-]*effort\s*:/i;
  const RE_FIELD_SATISFIED = /^satisfied\s*:/i;
  const RE_FIELD_DISSAT    = /^dissatisfied\s*:/i;
  const RE_Q_PRIMARY     = /^(?:Q(\d+)[.:]|Question\s+(\d+)[.:])\s+(.+)/i;
  const RE_Q_NUMBERED    = /^(\d+)[.)]\s+(.+)/;
  const RE_BULLET        = /^[-*•◦–—]\s+|^\d+[.)]\s+|^[a-zA-Z][.)]\s+/;
  const IMPLICIT_OPT     = new Set(["single choice", "multiple choice", "dropdown", "rank order"]);

  function cleanBullet(line: string): string {
    return line.replace(/^[-*•◦–—]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/^[a-zA-Z][.)]\s+/, "").trim();
  }

  function parseInlineOpts(s: string): string[] {
    const clean = s.replace(/^\[/, "").replace(/\]$/, "").trim();
    if (clean.includes("|")) return clean.split("|").map((x) => x.trim()).filter(Boolean);
    if (clean.includes(",")) return clean.split(",").map((x) => x.trim()).filter(Boolean);
    return clean ? [clean] : [];
  }

  function newQ(localId: string, text: string): ParsedQuestion {
    return {
      localId, text, type: "", options: [], rows: [], columns: [], consentText: "", scale: "", required: false,
      showIf: null, minLabel: "", maxLabel: "", section: currentSection, description: "",
      hasOther: false, hasNoneOfAbove: false, hasAllOfAbove: false, randomizeOptions: false,
    };
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (RE_SURVEY_TITLE.test(line)) { title = line.replace(RE_SURVEY_TITLE, "").trim(); continue; }
    if (RE_SURVEY_TYPE.test(line))  { surveyType = line.replace(RE_SURVEY_TYPE, "").trim(); continue; }
    if (RE_FIELD_WLCT.test(line))   { welcomeTitle = line.replace(RE_FIELD_WLCT, "").trim(); continue; }
    if (RE_FIELD_WLCD.test(line))   { welcomeDescription = line.replace(RE_FIELD_WLCD, "").trim(); continue; }
    if (RE_FIELD_TYM.test(line))    { thankYouMessage = line.replace(RE_FIELD_TYM, "").trim(); continue; }
    if (RE_FIELD_TYD.test(line))    { thankYouDescription = line.replace(RE_FIELD_TYD, "").trim(); continue; }

    // Section headers
    if (RE_SECTION.test(line)) {
      const secName = line.replace(RE_SECTION, "").trim();
      if (secName) {
        currentSection = secName;
        if (!sectionNames.includes(secName)) sectionNames.push(secName);
      }
      continue;
    }

    // Primary question starts: Q1. Q1: Question 1. Question 1:
    const qm = line.match(RE_Q_PRIMARY);
    if (qm) {
      if (currentQ) questions.push(currentQ);
      currentQ = newQ(qm[1] ?? qm[2], qm[3].trim());
      mode = null;
      continue;
    }

    // Numbered question starts (1. / 1)) only when not in list mode
    if (mode === null && RE_Q_NUMBERED.test(line)) {
      const nm = line.match(RE_Q_NUMBERED)!;
      const text = nm[2].trim();
      if (!currentQ || text.split(/\s+/).length >= 3) {
        if (currentQ) questions.push(currentQ);
        currentQ = newQ(nm[1], text);
        mode = null;
        continue;
      }
    }

    if (!currentQ) continue;

    if (RE_FIELD_TYPE.test(line))    { currentQ.type = line.replace(RE_FIELD_TYPE, "").trim(); mode = null; continue; }
    if (RE_FIELD_SCALE.test(line))   { currentQ.scale = line.replace(RE_FIELD_SCALE, "").trim(); mode = null; continue; }
    if (RE_FIELD_MIN.test(line))     { currentQ.minLabel = line.replace(RE_FIELD_MIN, "").trim(); mode = null; continue; }
    if (RE_FIELD_MAX.test(line))     { currentQ.maxLabel = line.replace(RE_FIELD_MAX, "").trim(); mode = null; continue; }
    if (RE_FIELD_CONSENT.test(line)) { currentQ.consentText = line.replace(RE_FIELD_CONSENT, "").trim(); mode = null; continue; }
    if (RE_FIELD_DESC.test(line))    { currentQ.description = line.replace(RE_FIELD_DESC, "").trim(); mode = null; continue; }
    if (RE_FIELD_OTHER.test(line))   { const v = line.replace(RE_FIELD_OTHER, "").trim().toLowerCase(); currentQ.hasOther = v === "yes"; mode = null; continue; }
    if (RE_FIELD_NONE.test(line))    { const v = line.replace(RE_FIELD_NONE, "").trim().toLowerCase(); currentQ.hasNoneOfAbove = v === "yes"; mode = null; continue; }
    if (RE_FIELD_ALL.test(line))     { const v = line.replace(RE_FIELD_ALL, "").trim().toLowerCase(); currentQ.hasAllOfAbove = v === "yes"; mode = null; continue; }
    if (RE_FIELD_RAND.test(line))    { const v = line.replace(RE_FIELD_RAND, "").trim().toLowerCase(); currentQ.randomizeOptions = v === "yes"; mode = null; continue; }
    if (RE_FIELD_PROMOTER.test(line))  { currentQ.feedbackPromoter   = line.replace(RE_FIELD_PROMOTER, "").trim();  mode = null; continue; }
    if (RE_FIELD_PASSIVE.test(line))   { currentQ.feedbackPassive    = line.replace(RE_FIELD_PASSIVE, "").trim();   mode = null; continue; }
    if (RE_FIELD_DETRACTOR.test(line)) { currentQ.feedbackDetractor  = line.replace(RE_FIELD_DETRACTOR, "").trim(); mode = null; continue; }
    if (RE_FIELD_LOW_EFF.test(line))   { currentQ.feedbackLowEffort  = line.replace(RE_FIELD_LOW_EFF, "").trim();   mode = null; continue; }
    if (RE_FIELD_NEUTRAL.test(line))   { currentQ.feedbackNeutral    = line.replace(RE_FIELD_NEUTRAL, "").trim();   mode = null; continue; }
    if (RE_FIELD_HIGH_EFF.test(line))  { currentQ.feedbackHighEffort = line.replace(RE_FIELD_HIGH_EFF, "").trim();  mode = null; continue; }
    if (RE_FIELD_SATISFIED.test(line)) { currentQ.feedbackSatisfied  = line.replace(RE_FIELD_SATISFIED, "").trim(); mode = null; continue; }
    if (RE_FIELD_DISSAT.test(line))    { currentQ.feedbackDissatisfied = line.replace(RE_FIELD_DISSAT, "").trim();  mode = null; continue; }

    if (RE_FIELD_OPTS.test(line)) {
      const inline = line.replace(RE_FIELD_OPTS, "").trim();
      if (inline) { currentQ.options.push(...parseInlineOpts(inline)); mode = null; }
      else { mode = "options"; }
      continue;
    }
    if (RE_FIELD_ROWS.test(line)) {
      const inline = line.replace(RE_FIELD_ROWS, "").trim();
      if (inline) { currentQ.rows.push(...parseInlineOpts(inline)); mode = null; }
      else { mode = "rows"; }
      continue;
    }
    if (RE_FIELD_COLS.test(line)) {
      const inline = line.replace(RE_FIELD_COLS, "").trim();
      if (inline) { currentQ.columns.push(...parseInlineOpts(inline)); mode = null; }
      else { mode = "columns"; }
      continue;
    }

    if (RE_FIELD_REQ.test(line)) {
      const v = line.replace(RE_FIELD_REQ, "").trim().toLowerCase();
      currentQ.required = v === "yes" || v === "true"; mode = null; continue;
    }
    if (RE_FIELD_OPT.test(line)) {
      const v = line.replace(RE_FIELD_OPT, "").trim().toLowerCase();
      currentQ.required = v === "no"; mode = null; continue;
    }
    if (RE_FIELD_SHOWIF.test(line)) {
      currentQ.showIf = parseShowIf(line.replace(RE_FIELD_SHOWIF, "").trim()); mode = null; continue;
    }

    if (RE_BULLET.test(line)) {
      const val = cleanBullet(line);
      if (!val) continue;
      if (mode === "options")  { currentQ.options.push(val); continue; }
      if (mode === "rows")     { currentQ.rows.push(val); continue; }
      if (mode === "columns")  { currentQ.columns.push(val); continue; }
      if (mode === null && IMPLICIT_OPT.has(currentQ.type.toLowerCase())) {
        currentQ.options.push(val); continue;
      }
    }
  }

  if (currentQ) questions.push(currentQ);
  return { title, surveyType, questions, sections: sectionNames, welcomeTitle, welcomeDescription, thankYouMessage, thankYouDescription };
}

function parseShowIf(cond: string): ShowIf | null {
  const patterns: { re: RegExp; operator: string }[] = [
    { re: /^(Q\d+)\s+(is less than)\s+(.+)$/i,    operator: "is less than" },
    { re: /^(Q\d+)\s+(is greater than)\s+(.+)$/i, operator: "is greater than" },
    { re: /^(Q\d+)\s+(is not)\s+(.+)$/i,          operator: "is not" },
    { re: /^(Q\d+)\s+(equals)\s+(.+)$/i,          operator: "equals" },
    { re: /^(Q\d+)\s+(contains)\s+(.+)$/i,        operator: "contains" },
  ];
  for (const p of patterns) {
    const m = cond.match(p.re);
    if (m) return { source: m[1], operator: p.operator, value: m[3].trim() };
  }
  return null;
}

function mapDisplayLogicComparator(sourceType: string, operator: string, rawValue: string): { comparator: string; value: unknown } {
  const op = operator.toLowerCase().trim();

  if (sourceType === "Rating") {
    if (op.includes("less than"))    return { comparator: "lessThanForRating",    value: String(rawValue) };
    if (op.includes("greater than")) return { comparator: "greaterThanForRating", value: String(rawValue) };
    if (op.includes("not"))          return { comparator: "notEqualToForRating",  value: String(rawValue) };
    return                                  { comparator: "equalToForRating",     value: String(rawValue) };
  }
  if (sourceType === "YesNo") {
    // SurveySparrow expects a raw boolean, not a stringified one — verified
    // against the working PUT payload sample.
    const boolValue = rawValue.trim().toLowerCase() === "yes";
    if (op.includes("not")) return { comparator: "notEqualToForYesNo", value: boolValue };
    return                          { comparator: "equalToForYesNo",    value: boolValue };
  }
  if (sourceType === "OpinionScale") {
    if (op.includes("less than"))    return { comparator: "lessThanForScale",    value: String(rawValue) };
    if (op.includes("greater than")) return { comparator: "greaterThanForScale", value: String(rawValue) };
    if (op.includes("not"))          return { comparator: "notEqualToForScale",  value: String(rawValue) };
    return                                  { comparator: "equalToForScale",     value: String(rawValue) };
  }
  if (sourceType === "NumberInput") {
    if (op.includes("less than"))    return { comparator: "lessThanForNumber",    value: String(rawValue) };
    if (op.includes("greater than")) return { comparator: "greaterThanForNumber", value: String(rawValue) };
    if (op.includes("not"))          return { comparator: "notEqualToForNumber",  value: String(rawValue) };
    return                                  { comparator: "equalToForNumber",     value: String(rawValue) };
  }
  if (sourceType === "DateTime") {
    if (op.includes("not")) return { comparator: "notEqualToForDate", value: String(rawValue) };
    return                          { comparator: "equalToForDate",    value: String(rawValue) };
  }
  if (sourceType === "MultiChoice" || sourceType === "Dropdown") {
    if (op.includes("not")) return { comparator: "isNotSelected", value: String(rawValue) };
    return                          { comparator: "isSelected",    value: String(rawValue) };
  }
  if (op.includes("contains")) return { comparator: "contains",     value: String(rawValue) };
  if (op.includes("not"))      return { comparator: "notEqualTo",   value: String(rawValue) };
  return                               { comparator: "equalsString", value: String(rawValue) };
}

export default router;
