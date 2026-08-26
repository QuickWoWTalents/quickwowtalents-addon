import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  TEST_IMPORT_STRING,
  UPDATE_REQUIRED_MESSAGE,
  createAddonHarness,
  makeRuntimeData
} from './helpers/lua-addon-harness.mjs';

const addonLuaPath = new URL('../QuickWoWTalents.lua', import.meta.url);
const addonDataPath = new URL('../QuickWoWTalentsData.lua', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);
const researchPath = new URL('../docs/research.md', import.meta.url);

async function readAddonLua() {
  return readFile(addonLuaPath, 'utf8');
}

function parseMplusContextDungeonIds(source) {
  const contextBlock = source.match(
    /local MPLUS_DUNGEON_CONTEXTS = \{([\s\S]*?)\n\}\n\nlocal MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID/,
  )?.[1];
  assert.ok(contextBlock, 'expected MPLUS_DUNGEON_CONTEXTS block');
  return [...contextBlock.matchAll(/\bqwtDungeonId = (\d+)/g)].map((match) => Number(match[1]));
}

function parseBundleMplusDungeonIds(source) {
  const dungeonIdsBlock = source.match(
    /activities = \{[\s\S]*?mythicPlus = \{[\s\S]*?dungeonIds = \{([\s\S]*?)\n\s*\}/,
  )?.[1];
  assert.ok(dungeonIdsBlock, 'expected schema-3 Mythic+ dungeonIds block');
  return [...dungeonIdsBlock.matchAll(/\b\d+\b/g)].map((match) => Number(match[0]));
}

test('auto-open includes explicit Midnight Season 2 Mythic+ client ID mappings in bundle order', async () => {
  const source = await readAddonLua();
  const data = await readFile(addonDataPath, 'utf8');

  const expectedMappings = [
    { qwtDungeonId: 12993, challengeMapId: 588, instanceMapIds: [2993], name: 'Altar of Fangs' },
    { qwtDungeonId: 12825, challengeMapId: 586, instanceMapIds: [2825], name: 'Den of Nalorakk' },
    { qwtDungeonId: 61762, challengeMapId: 249, instanceMapIds: [1762], name: "Kings' Rest" },
    { qwtDungeonId: 12813, challengeMapId: 587, instanceMapIds: [2813], name: 'Murder Row' },
    { qwtDungeonId: 112521, challengeMapId: 399, instanceMapIds: [2521], name: 'Ruby Life Pools' },
    { qwtDungeonId: 61877, challengeMapId: 250, instanceMapIds: [1877], name: 'Temple of Sethraliss' },
    { qwtDungeonId: 12859, challengeMapId: 584, instanceMapIds: [2859], name: 'The Blinding Vale' },
    { qwtDungeonId: 12923, challengeMapId: 585, instanceMapIds: [2923], name: 'Voidscar Arena' }
  ];

  for (const mapping of expectedMappings) {
    assert.match(source, new RegExp(`qwtDungeonId = ${mapping.qwtDungeonId}, challengeMapId = ${mapping.challengeMapId}`));
    assert.match(source, new RegExp(`instanceMapIds = \\{ ${mapping.instanceMapIds.join(', ')} \\}`));
    assert.match(source, new RegExp(`name = "${mapping.name.replaceAll("'", "\\'")}"`));
  }

  assert.match(source, /MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID\[context\.challengeMapId\] = context/);
  assert.match(source, /MPLUS_DUNGEON_BY_INSTANCE_MAP_ID\[instanceMapId\] = context/);
  assert.deepEqual(parseMplusContextDungeonIds(source), parseBundleMplusDungeonIds(data));
});

test('auto-open checks settled instance context and current spec before opening', async () => {
  const source = await readAddonLua();

  assert.match(source, /AUTO_OPEN_DELAY_SECONDS = 1\.5/);
  assert.match(source, /C_ChallengeMode\.GetActiveChallengeMapID\(\)/);
  assert.match(source, /IsInInstance\(\)/);
  assert.match(source, /GetInstanceInfo\(\)/);
  assert.match(source, /GetCurrentSpecInfo\(\)/);
  assert.match(source, /HasMplusRecommendationForSpec\(specID, context\.qwtDungeonId\)/);
  assert.match(source, /UI\.state\.mode = "mplus"/);
  assert.match(source, /UI\.state\.encounterIds\.mplus = context\.dungeonId/);
});

test('actual Lua auto-open flow exposes a compatible encounter recommendation', async () => {
  const harness = await createAddonHarness();
  harness.fire('ADDON_LOADED', 'QuickWoWTalents');
  harness.fire('PLAYER_ENTERING_WORLD');
  harness.runTimers();

  assert.equal(harness.boolean('TEST.mainFrame ~= nil and TEST.mainFrame:IsShown()'), true);
  assert.equal(harness.string('TEST.importBox:GetText()'), TEST_IMPORT_STRING);
});

test('scheduled and explicit auto-open report incompatible data once without opening', async () => {
  const harness = await createAddonHarness({ data: makeRuntimeData({ schemaVersion: 2 }) });
  harness.fire('ADDON_LOADED', 'QuickWoWTalents');
  harness.fire('PLAYER_ENTERING_WORLD');
  harness.fire('ZONE_CHANGED_NEW_AREA');
  harness.slash('auto on');
  harness.slash('auto on');
  harness.runTimers();

  const compatibilityMessages = harness.messages().filter((message) => message.includes(UPDATE_REQUIRED_MESSAGE));
  assert.equal(compatibilityMessages.length, 1);
  assert.equal(harness.boolean('TEST.mainFrame == nil'), true);
  assert.equal(harness.number('#TEST.timers'), 0);
});

test('current specialization detection prefers the 12.1 namespace API with legacy fallback', async () => {
  const source = await readAddonLua();

  assert.match(source, /C_SpecializationInfo and C_SpecializationInfo\.GetSpecialization/);
  assert.match(source, /C_SpecializationInfo and C_SpecializationInfo\.GetSpecializationInfo/);
  assert.match(source, /or GetSpecialization/);
  assert.match(source, /or GetSpecializationInfo/);
});

test('auto-open is throttled, dismissible, and combat-safe', async () => {
  const source = await readAddonLua();

  assert.match(source, /QuickWoWTalentsDB\.autoOpenEnabled = true/);
  assert.match(source, /UI\.dismissedAutoOpenKey == context\.key or UI\.lastAutoOpenKey == context\.key/);
  assert.match(source, /UI\.pendingAutoOpenContext = context/);
  assert.match(source, /eventFrame:RegisterEvent\("PLAYER_REGEN_ENABLED"\)/);
  assert.match(source, /event == "PLAYER_REGEN_ENABLED" and UI\.pendingAutoOpenContext/);
  assert.match(source, /frame:SetScript\("OnHide"/);
  assert.match(source, /UI\.dismissedAutoOpenKey = UI\.autoOpenedContextKey/);
});

test('auto-open has public user controls and documentation', async () => {
  const source = await readAddonLua();
  const readme = await readFile(readmePath, 'utf8');
  const research = await readFile(researchPath, 'utf8');

  assert.match(source, /command == "auto" or command == "auto status"/);
  assert.match(source, /command == "auto on" or command == "auto enable"/);
  assert.match(source, /command == "auto off" or command == "auto disable"/);
  assert.match(readme, /\/qwt auto status/);
  assert.match(readme, /Automatic opening is enabled by default/);
  assert.match(readme, /No in-game network calls are made/);
  assert.match(research, /Mythic\+ auto-open prior art/);
  assert.match(research, /Raider\.IO is the closest Mythic\+ mapping reference/);
});
