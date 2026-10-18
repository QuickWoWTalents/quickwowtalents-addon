import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createAddonHarness, makeRuntimeData } from './helpers/lua-addon-harness.mjs';

const importer = `{
  TalentImport = {
    IsBusy = function() return TEST.importBusy == true end,
    Begin = function(request)
      TEST.request = request
      TEST.importBusy = true
      request.onStatus("Applying build...", false, false)
      return true
    end
  }
}`;


test('one-button import passes the displayed build and reports completion, keeping manual copy available', async () => {
  const harness = await createAddonHarness({ addonName: 'QuickWoWTalents', namespaceSource: importer });
  harness.slash();
  harness.clickImport();
  assert.equal(harness.string('TEST.request.name'), 'QWT-Altar of Fangs');
  assert.equal(harness.string('TEST.hint.text'), 'Applying build...');
  assert.equal(harness.boolean('TEST.copyButton.enabled == false'), false);
  harness.run('TEST.importBusy = false; TEST.request.onStatus("Build applied; previous version removed.", true, true)');
  assert.equal(harness.string('TEST.hint.text'), 'Build applied; previous version removed.');
  assert.equal(harness.messages().some(message => message.includes('previous version removed')), true);
  harness.clickCopy();
  assert.equal(harness.boolean('TEST.importBox.focused'), true);
});

test('combat and mismatched data never reach the import coordinator', async () => {
  const harness = await createAddonHarness({ addonName: 'QuickWoWTalents', namespaceSource: importer });
  harness.slash();
  harness.run('InCombatLockdown = function() return true end');
  harness.clickImport();
  assert.equal(harness.boolean('TEST.request == nil'), true);
  harness.run('InCombatLockdown = function() return false end; QuickWoWTalentsData.schemaVersion = 2');
  harness.clickImport();
  assert.equal(harness.boolean('TEST.request == nil'), true);
});

test('localized loadout names preserve complete UTF-8 characters within the name limit', async () => {
  const data = makeRuntimeData();
  data.modes.mplus.dungeons[0].name = 'É'.repeat(40);
  const harness = await createAddonHarness({ addonName: 'QuickWoWTalents', namespaceSource: importer, data });
  harness.slash();
  harness.clickImport();
  const name = harness.string('TEST.request.name');
  assert.equal(name, 'QWT-' + 'É'.repeat(27));
  assert.equal([...name].length, 31);
});

test('loadout names use sanitized encounter labels rather than full recommendation descriptions', async () => {
  const data = makeRuntimeData();
  data.modes.mplus.dungeons[0].name = '  |cffff0000Altar|r\n of\t Fangs  ';
  data.recommendations[62].mplus.encounters[12993].label = 'Arcane Mage — Altar of Fangs Best Overall (15+)';
  const harness = await createAddonHarness({ namespaceSource: importer, data });
  harness.slash();
  harness.clickImport();
  assert.equal(harness.string('TEST.request.name'), 'QWT-Altar of Fangs');
});

test('visible recommendation follows player specialization changes without importing', async () => {
  const data = makeRuntimeData();
  data.recommendations[63] = structuredClone(data.recommendations[62]);
  data.recommendations[63].mplus.encounters[12993].importString = 'FIRE-BUILD';
  const harness = await createAddonHarness({ addonName: 'QuickWoWTalents', namespaceSource: importer, data });
  harness.slash();
  harness.run('C_SpecializationInfo.GetSpecializationInfo = function() return 63, "Fire" end');
  harness.fire('PLAYER_SPECIALIZATION_CHANGED', 'party1');
  assert.equal(harness.string('TEST.importBox:GetText()'), 'TEST_IMPORT_STRING');
  harness.fire('PLAYER_SPECIALIZATION_CHANGED', 'player');
  assert.equal(harness.string('TEST.importBox:GetText()'), 'FIRE-BUILD');
  assert.equal(harness.boolean('TEST.request == nil'), true);
  harness.clickImport();
  assert.equal(harness.number('TEST.request.specID'), 63);
  assert.equal(harness.string('TEST.request.importString'), 'FIRE-BUILD');
});

test('busy import retains its selection and status, then refreshes a changed specialization', async () => {
  const data = makeRuntimeData();
  data.recommendations[63] = structuredClone(data.recommendations[62]);
  data.recommendations[63].mplus.encounters[12993].importString = 'FIRE-BUILD';
  const harness = await createAddonHarness({ addonName: 'QuickWoWTalents', namespaceSource: importer, data });
  harness.slash();
  harness.clickImport();
  harness.run('TEST.originalRequest = TEST.request; C_SpecializationInfo.GetSpecializationInfo = function() return 63, "Fire" end');
  harness.fire('PLAYER_SPECIALIZATION_CHANGED', 'player');
  harness.slash();
  harness.run('QuickWoWTalentsModeDropdownControl.scripts.OnClick(QuickWoWTalentsModeDropdownControl)');
  assert.equal(harness.boolean('QuickWoWTalentsModeDropdown:IsShown()'), false);
  harness.clickImport();
  assert.equal(harness.boolean('TEST.originalRequest == TEST.request'), true);
  assert.equal(harness.string('TEST.hint.text'), 'Applying build...');
  assert.equal(harness.string('TEST.importBox:GetText()'), 'TEST_IMPORT_STRING');
  assert.equal(harness.string('QuickWoWTalentsModeDropdownControl.Text:GetText()'), 'Mythic+');
  harness.run('TEST.importBusy = false; TEST.request.onStatus("Stopped after specialization changed.", true, false)');
  assert.equal(harness.string('TEST.importBox:GetText()'), 'FIRE-BUILD');
  assert.equal(harness.string('TEST.hint.text'), 'Add and apply this build, replacing any pending talent edits.');
  assert.equal(harness.messages().some(message => message.includes('Stopped after specialization changed.')), true);
});

test('completion after an unsupported spec change does not re-enable importing or claim that build applied', async () => {
  const harness = await createAddonHarness({ addonName: 'QuickWoWTalents', namespaceSource: importer });
  harness.slash();
  harness.clickImport();
  harness.run('C_SpecializationInfo.GetSpecializationInfo = function() return 63, "Fire" end');
  harness.fire('PLAYER_SPECIALIZATION_CHANGED', 'player');
  harness.run('TEST.importBusy = false; TEST.request.onStatus("Prior build applied.", true, true)');
  assert.equal(harness.string('TEST.importBox:GetText()'), '');
  assert.match(harness.string('TEST.hint.text'), /No bundled recommendations for Fire/);
  assert.equal(harness.boolean('((function() for _, widget in ipairs(TEST.frames) do if widget.text == "Add & Use Build" then return widget.enabled end end end)())'), false);
});

test('switching dungeons and raid modes uses the selected encounter name and recommendation', async () => {
  const data = makeRuntimeData();
  data.modes.mplus.dungeons.push({ id: 12813, name: 'Murder Row' });
  data.recommendations[62].mplus.encounters[12813] = {
    ...data.recommendations[62].mplus.encounters[12993],
    dungeonId: 12813, dungeonName: 'Murder Row', importString: 'MURDER-ROW-BUILD'
  };
  data.recommendations[62].raid.encounters[3159] = {
    className: 'Mage', specName: 'Arcane', mode: 'raid', bossId: 3159,
    bossName: 'Rotmire', importString: 'RAID-BUILD'
  };
  const harness = await createAddonHarness({ addonName: 'QuickWoWTalents', namespaceSource: importer, data });
  harness.slash();
  harness.clickImport();
  assert.equal(harness.string('TEST.request.name'), 'QWT-Altar of Fangs');
  harness.run('TEST.importBusy = false; QuickWoWTalentsEncounterDropdownControl.scripts.OnClick(QuickWoWTalentsEncounterDropdownControl); QuickWoWTalentsEncounterDropdown.rows[2].scripts.OnClick(QuickWoWTalentsEncounterDropdown.rows[2])');
  harness.clickImport();
  assert.equal(harness.string('TEST.request.name'), 'QWT-Murder Row');
  assert.equal(harness.string('TEST.request.importString'), 'MURDER-ROW-BUILD');
  harness.run('TEST.importBusy = false; QuickWoWTalentsModeDropdownControl.scripts.OnClick(QuickWoWTalentsModeDropdownControl); QuickWoWTalentsModeDropdown.rows[2].scripts.OnClick(QuickWoWTalentsModeDropdown.rows[2])');
  harness.clickImport();
  assert.equal(harness.string('TEST.request.name'), 'QWT-Rotmire');
  assert.equal(harness.string('TEST.request.importString'), 'RAID-BUILD');
});

test('production loads the codec and importer without temporary logging or test commands', async () => {
  const harness = await createAddonHarness({ loadImportModules: true });
  harness.fire('ADDON_LOADED', 'QuickWoWTalents');
  harness.slash();
  assert.equal(harness.boolean('type(TEST.namespace.TalentCodec.Decode) == "function"'), true);
  assert.equal(harness.boolean('TEST.namespace.TalentImport.IsBusy()'), false);
  assert.equal(harness.boolean('TEST.namespace.TestLog == nil'), true);
  assert.equal(harness.string('SLASH_QUICKWOWTALENTS1'), '/qwt');
  assert.equal(harness.boolean('SlashCmdList.QUICKWOWTALENTSTEST == nil'), true);
  harness.slash('import status');
  assert.match(harness.messages().join('\n'), /Import idle:/);
  harness.slash('debug');
  assert.equal(harness.messages().some(message => /trace|debug|diagnostic/i.test(message)), false);
  for (const name of ['QuickWoWTalents.lua', 'QuickWoWTalentsTalentImport.lua', 'QuickWoWTalentsTalentCodec.lua', 'QuickWoWTalents.toc']) {
    const source = await readFile(new URL('../' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /TestLog|QuickWoWTalentsTestDB|\/qwtt|importDiagnostic|cleanupDiagnostic|TEST\s+\d+/);
  }
});
