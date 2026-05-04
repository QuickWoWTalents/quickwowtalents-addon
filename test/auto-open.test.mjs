import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const addonLuaPath = new URL('../QuickWoWTalents.lua', import.meta.url);
const addonDataPath = new URL('../QuickWoWTalentsData.lua', import.meta.url);
const readmePath = new URL('../README.md', import.meta.url);
const researchPath = new URL('../docs/research.md', import.meta.url);

async function readAddonLua() {
  return readFile(addonLuaPath, 'utf8');
}

test('auto-open uses explicit current Mythic+ client ID mappings', async () => {
  const source = await readAddonLua();

  const expectedMappings = [
    { qwtDungeonId: 10658, challengeMapId: 556, instanceMapIds: [658], name: 'Pit of Saron' },
    { qwtDungeonId: 61209, challengeMapId: 161, instanceMapIds: [1209], name: 'Skyreach' },
    { qwtDungeonId: 361753, challengeMapId: 239, instanceMapIds: [1753], name: 'Seat of the Triumvirate' },
    { qwtDungeonId: 112526, challengeMapId: 402, instanceMapIds: [2526], name: "Algeth'ar Academy" },
    { qwtDungeonId: 12805, challengeMapId: 557, instanceMapIds: [2805], name: 'Windrunner Spire' },
    { qwtDungeonId: 12811, challengeMapId: 558, instanceMapIds: [2811], name: "Magisters' Terrace" },
    { qwtDungeonId: 12874, challengeMapId: 560, instanceMapIds: [2874], name: 'Maisara Caverns' },
    { qwtDungeonId: 12915, challengeMapId: 559, instanceMapIds: [2915], name: 'Nexus-Point Xenas' }
  ];

  for (const mapping of expectedMappings) {
    assert.match(source, new RegExp(`qwtDungeonId = ${mapping.qwtDungeonId}, challengeMapId = ${mapping.challengeMapId}`));
    assert.match(source, new RegExp(`instanceMapIds = \\{ ${mapping.instanceMapIds.join(', ')} \\}`));
    assert.match(source, new RegExp(`name = "${mapping.name.replaceAll("'", "\\'")}"`));
  }

  assert.match(source, /MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID\[context\.challengeMapId\] = context/);
  assert.match(source, /MPLUS_DUNGEON_BY_INSTANCE_MAP_ID\[instanceMapId\] = context/);
});

test('auto-open mapped dungeons exist in the committed recommendation bundle', async () => {
  const data = await readFile(addonDataPath, 'utf8');
  const expectedSpecCount = Number(data.match(/specs = (\d+)/)?.[1]);
  const mappedDungeonIds = [10658, 61209, 361753, 112526, 12805, 12811, 12874, 12915];

  assert.equal(expectedSpecCount, 40);
  for (const dungeonId of mappedDungeonIds) {
    const recommendationMatches = data.match(new RegExp(`\\[${dungeonId}\\] = \\{`, 'g')) ?? [];
    assert.equal(recommendationMatches.length, expectedSpecCount, `expected one ${dungeonId} recommendation per spec`);
  }
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
