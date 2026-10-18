import { createHash } from 'node:crypto';

export const COMPLETED_WINDOW_SKIP_CODE = 'NO_ELIGIBLE_LOGS_IN_WINDOW';
const RULES_VERSION = 'complete-loadout-v1';
const CATALOG_IDENTITY = Object.freeze({ source: 'raidbots', environment: 'live', wowBuild: '12.1.5.70391',
  contentHash: 'f02a0a3a2a62e92685f29b00835a249f' });
// This consumer pins the reviewed producer contract independently. A changed
// policy/catalog needs review here before it can authorize the new safe gap.
const POLICY = Object.freeze({ policyVersion: 'independent-support-v1', canonicalizationVersion: 'deterministic-grants-v1',
  evidenceSchemaVersion: 1, emptyOutcomePolicy: 'completed-window-v1', recentWindowDays: 14,
  targetDistinctCharacters: 100, minimumCohortCharacters: 20, minimumSupportingCharacters: 5,
  minimumSupportingLoggedFights: 3, maxPagesPerStratum: 3, overallExtraPages: 6,
  observationPolicy: 'newest-character-per-key', weightingPolicy: 'one-total-character-vote',
  selectionPolicy: 'support-then-weighted-relative-median' });
const EXCLUSIONS = ['catalogIncompatible', 'emptyTalents', 'exportFailed', 'incompleteLoadout', 'invalidLoadout',
  'invalidOutput', 'missingTimestamp', 'outsideWindow', 'missingKeystoneLevel', 'contextMismatch'];
const SAFE_EXCLUSIONS = new Set(['outsideWindow', 'catalogIncompatible', 'emptyTalents']);
const ZERO_COUNTERS = ['eligibleLogs', 'distinctCharacters', 'distinctLoggedFights', 'duplicateRows',
  'votingObservations', 'unknownCharacterLogs', 'unknownFightLogs', 'totalVotingWeight',
  'supersededCharacterLogs', 'undatedLogs'];
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const matches = (actual, expected) => Object.entries(expected).every(([key, value]) => actual?.[key] === value);
function reject(reason) { throw new Error(`Completed-window evidence rejected: ${reason}.`); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  return record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
}
export const COMPLETED_WINDOW_POLICY_FINGERPRINT = hash(stable(POLICY)).slice(0, 20);

function validRules(spec, catalog) {
  const rules = spec?.eligibilityRules;
  if (!record(rules)) return false;
  const { fingerprint, ...body } = rules;
  return rules.status === 'verified' && rules.version === RULES_VERSION
    && fingerprint === hash(body) && matches(rules.catalogIdentity, CATALOG_IDENTITY)
    && matches(catalog, CATALOG_IDENTITY) && rules.specId === spec.specId && rules.sourceKey === spec.sourceKey
    && rules.id === `${RULES_VERSION}:${CATALOG_IDENTITY.contentHash}:${spec.specId}`
    && rules.maxLevel === 90 && Array.isArray(rules.unknownReasons) && rules.unknownReasons.length === 0
    && ['class', 'spec', 'hero'].every((tree) => integer(rules.pointBudgets?.[tree]) && rules.pointBudgets[tree] > 0)
    && Array.isArray(rules.heroSelections) && rules.heroSelections.length > 0;
}

export function inspectCompletedWindowCatalog(catalog) {
  if (!matches(catalog, CATALOG_IDENTITY) || !record(catalog?.specs)) reject('catalog is not the reviewed current catalog');
  const entries = Object.entries(catalog.specs).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length !== 40 || entries.some(([, spec]) => !validRules(spec, catalog))) reject('catalog eligibility rules are unknown or invalid');
  const descriptor = { version: RULES_VERSION,
    fingerprint: hash(entries.map(([key, spec]) => ({ key, fingerprint: spec.eligibilityRules.fingerprint }))),
    specCount: 40, verifiedSpecCount: 40, complete: true };
  if (!matches(catalog.eligibilityRules, descriptor)) reject('catalog eligibility rules descriptor is inconsistent');
  return descriptor;
}

function timestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}
function keyLevels(value) {
  return Array.isArray(value) && value.every((level, index) => Number.isSafeInteger(level) && level >= 15
    && (index === 0 || value[index - 1] < level));
}

export function validateCompletedWindowEvidence({ evidence: value, mode, specRecord, catalog, artifactEligibilityRules, expectedKeyLevels }) {
  const descriptor = inspectCompletedWindowCatalog(catalog);
  if (!matches(artifactEligibilityRules, descriptor)) reject('artifact eligibility rules descriptor is missing or inconsistent');
  const evidence = value;
  if (!record(evidence) || evidence.schemaVersion !== POLICY.evidenceSchemaVersion
    || evidence.policyVersion !== POLICY.policyVersion || evidence.policyFingerprint !== COMPLETED_WINDOW_POLICY_FINGERPRINT
    || evidence.canonicalizationVersion !== POLICY.canonicalizationVersion || evidence.emptyOutcomePolicy !== POLICY.emptyOutcomePolicy
    || evidence.weightingPolicy !== POLICY.weightingPolicy) reject('policy identity is missing or unknown');
  if (!validRules(specRecord, catalog) || evidence.eligibilityEnforced !== true
    || !Array.isArray(evidence.eligibilityRulesFingerprints) || evidence.eligibilityRulesFingerprints.length !== 1
    || evidence.eligibilityRulesFingerprints[0] !== specRecord.eligibilityRules.fingerprint) reject('selection eligibility rules do not match its catalog spec');
  if (evidence.acquisitionComplete !== true || evidence.publicationEligible !== true
    || !['upstream_exhausted', 'page_cap'].includes(evidence.stopReason)
    || typeof evidence.truncated !== 'boolean'
    || evidence.truncated !== (evidence.stopReason === 'page_cap')) reject('acquisition is incomplete or inconsistent');
  if (!timestamp(evidence.windowStart) || !timestamp(evidence.windowEnd) || !timestamp(evidence.captureAnchor)
    || Date.parse(evidence.windowStart) >= Date.parse(evidence.windowEnd)
    || Date.parse(evidence.windowEnd) !== Date.parse(evidence.captureAnchor)
    || Date.parse(evidence.windowEnd) - Date.parse(evidence.windowStart) > POLICY.recentWindowDays * 86_400_000
    || !timestamp(evidence.sourceFetchedAtMin) || !timestamp(evidence.sourceFetchedAtMax)
    || Date.parse(evidence.sourceFetchedAtMin) > Date.parse(evidence.sourceFetchedAtMax)
    || !Array.isArray(evidence.sourceRevisions) || evidence.sourceRevisions.length !== 1
    || typeof evidence.sourceRevisions[0] !== 'string' || !evidence.sourceRevisions[0].trim()) reject('capture or source provenance is incomplete');
  const overall = mode === 'mplus';
  const advertisedLevels = Array.isArray(expectedKeyLevels)
    ? [...new Set(expectedKeyLevels.map(Number).filter((level) => Number.isSafeInteger(level) && level >= 15))].sort((a, b) => a - b)
    : [];
  if (!['mplus', 'raid'].includes(mode) || evidence.selectionScope !== (overall ? 'selected-dungeon-overall' : 'exact-context')
    || !keyLevels(evidence.requestedKeyLevels) || !keyLevels(evidence.sampledKeyLevels)
    || JSON.stringify(evidence.requestedKeyLevels) !== JSON.stringify(evidence.sampledKeyLevels)
    || (overall && (advertisedLevels.length === 0 || JSON.stringify(evidence.requestedKeyLevels) !== JSON.stringify(advertisedLevels)))
    || (overall ? evidence.requestedKeyLevels.length === 0 : evidence.requestedKeyLevels.length !== 0)
    || !Array.isArray(evidence.missingKeyLevels) || evidence.missingKeyLevels.length !== 0
    || !Array.isArray(evidence.perKey) || evidence.perKey.length !== 0
    || !integer(evidence.pagesFetched) || evidence.pagesFetched < Math.max(1, evidence.requestedKeyLevels.length)
    || (!overall && evidence.stopReason === 'page_cap' && evidence.pagesFetched !== POLICY.maxPagesPerStratum)
    || evidence.pagesFetched > (overall ? Math.min(evidence.requestedKeyLevels.length * POLICY.maxPagesPerStratum,
      evidence.requestedKeyLevels.length + POLICY.overallExtraPages) : POLICY.maxPagesPerStratum)) reject('selection page or key coverage is incomplete');
  if (ZERO_COUNTERS.some((name) => evidence[name] !== 0) || evidence.winner !== null
    || evidence.qualityStatus !== 'no-eligible-build' || evidence.oldestLogAt !== null || evidence.newestLogAt !== null) reject('empty selection contains eligible observations or a winner');
  if (!record(evidence.exclusions) || EXCLUSIONS.some((name) => !integer(evidence.exclusions[name]))
    || Object.entries(evidence.exclusions).some(([name, count]) => !EXCLUSIONS.includes(name) || !integer(count) || (!SAFE_EXCLUSIONS.has(name) && count !== 0))
    || evidence.exclusions.outsideWindow <= 0 || !integer(evidence.scannedRows) || evidence.scannedRows <= 0
    || evidence.scannedRows !== [...SAFE_EXCLUSIONS].reduce((sum, name) => sum + evidence.exclusions[name], 0)
    || evidence.talentCompatibleRows !== evidence.exclusions.outsideWindow) reject('exclusion counts do not prove a safe completed window');
  return true;
}
