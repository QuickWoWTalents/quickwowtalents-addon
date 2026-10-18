import fs from 'node:fs/promises';

// Reviewed rule profiles only; this fixture intentionally contains no leaderboard
// identities or loadouts and does not claim to be a complete talent tree archive.
const catalogRules = JSON.parse(await fs.readFile(new URL('../fixtures/completed-window-catalog-rules.json', import.meta.url), 'utf8'));
export function createCompletedWindowCatalog() { return structuredClone(catalogRules); }
export function createCompletedWindowEvidence(catalog, key, mode = 'raid') {
  return {
    schemaVersion: 1, policyVersion: 'independent-support-v1', policyFingerprint: '5b226a02f3c8416a1420',
    canonicalizationVersion: 'deterministic-grants-v1', emptyOutcomePolicy: 'completed-window-v1',
    weightingPolicy: 'one-total-character-vote', selectionScope: mode === 'raid' ? 'exact-context' : 'selected-dungeon-overall',
    eligibilityEnforced: true, eligibilityRulesFingerprints: [catalog.specs[key].eligibilityRules.fingerprint],
    acquisitionComplete: true, publicationEligible: true, stopReason: 'page_cap', truncated: true,
    windowStart: '2026-10-04T19:35:39.366Z', windowEnd: '2026-10-18T19:35:39.366Z', captureAnchor: '2026-10-18T19:35:39.366Z',
    sourceFetchedAtMin: '2026-10-18T19:37:35.346Z', sourceFetchedAtMax: '2026-10-18T19:37:39.422Z', sourceRevisions: ['source-revision'],
    requestedKeyLevels: mode === 'raid' ? [] : [15, 16], sampledKeyLevels: mode === 'raid' ? [] : [15, 16],
    missingKeyLevels: [], perKey: [], pagesFetched: 3,
    eligibleLogs: 0, distinctCharacters: 0, distinctLoggedFights: 0, duplicateRows: 0, votingObservations: 0,
    unknownCharacterLogs: 0, unknownFightLogs: 0, totalVotingWeight: 0, supersededCharacterLogs: 0, undatedLogs: 0,
    winner: null, qualityStatus: 'no-eligible-build', oldestLogAt: null, newestLogAt: null,
    scannedRows: 300, talentCompatibleRows: 299,
    exclusions: { outsideWindow: 299, catalogIncompatible: 0, emptyTalents: 1, exportFailed: 0, incompleteLoadout: 0,
      invalidLoadout: 0, invalidOutput: 0, missingTimestamp: 0, missingKeystoneLevel: 0, contextMismatch: 0 }
  };
}
