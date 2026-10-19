import assert from 'node:assert/strict';
import test from 'node:test';
import { createAddonHarness, makeRuntimeData } from './helpers/lua-addon-harness.mjs';

const namespaceSource = `{
  TalentImport = {
    IsBusy = function() return TEST.importBusy == true end,
    Begin = function(request) TEST.request = request; TEST.importBusy = true; return true end
  },
  TalentCodec = {
    Decode = function() if TEST.decodeFails then return nil end; return TEST.preferenceEntries end,
    ApplyChoices = function(text, specID, configID, overrides)
      TEST.overrides = overrides
      local values = {}
      for node, entry in pairs(overrides) do values[#values + 1] = node .. ":" .. entry end
      table.sort(values)
      return text .. "/" .. table.concat(values, ","), nil, { changedCount = #values }
    end
  }
}`;

async function preferenceHarness() {
  const data = makeRuntimeData();
  for (const [id, specName, className] of [[262, 'Elemental', 'Shaman'], [64, 'Frost', 'Mage']]) {
    data.recommendations[id] = structuredClone(data.recommendations[62]);
    data.recommendations[id].className = className;
    data.recommendations[id].specName = specName;
    Object.assign(data.recommendations[id].mplus.encounters[12993], { className, specName });
  }
  const harness = await createAddonHarness({ data, namespaceSource, loadPreferences: true,
    beforeAddonSource: `
      TEST.guid = "Player-1-A"
      function UnitGUID() return TEST.guid end
      C_SpecializationInfo.GetSpecializationInfo = function() return 262, "Elemental" end
      C_ClassTalents = { GetActiveConfigID = function() return 117 end }
      Enum = { TraitNodeType = { Selection = 2 } }
    ` });
  harness.run(`
    TEST.preferenceEntries, TEST.preferenceNodes, TEST.preferenceEntryInfo, TEST.preferenceDefinitions = {}, {}, {}, {}
    for _, definition in ipairs(TEST.namespace.Preferences.List(262)) do
      local node = { ID = definition.nodeID, type = 2, maxRanks = 1, entryIDs = {} }
      for index = 2, 3 do
        local choice = definition.choices[index]
        node.entryIDs[#node.entryIDs + 1] = choice.entryID
        TEST.preferenceEntryInfo[choice.entryID] = { maxRanks = 1, definitionID = choice.entryID }
        TEST.preferenceDefinitions[choice.entryID] = { spellID = choice.spellID }
      end
      TEST.preferenceNodes[definition.nodeID] = node
      TEST.preferenceEntries[#TEST.preferenceEntries + 1] = {
        nodeID = definition.nodeID, selectionEntryID = node.entryIDs[1], ranksPurchased = 1, ranksGranted = 0
      }
    end
    C_Traits = {
      GetNodeInfo = function(_, id) return TEST.preferenceNodes[id] end,
      GetEntryInfo = function(_, id) return TEST.preferenceEntryInfo[id] end,
      GetDefinitionInfo = function(id) return TEST.preferenceDefinitions[id] end
    }
  `);
  return harness;
}

function choose(harness, row, option) {
  harness.run(`local menu = QuickWoWTalentsPreference${row}; menu.control.scripts.OnClick(); menu.rows[${option}].scripts.OnClick()`);
}

test('preferences are relevant to spec, collapsed by default, and leave recommended data unchanged', async () => {
  const h = await preferenceHarness();
  h.slash();
  assert.equal(h.boolean('QuickWoWTalentsPreferencesPanel:IsShown()'), false);
  assert.equal(h.number('QuickWoWTalentsFrame:GetHeight()'), 450);
  assert.equal(h.string('QuickWoWTalentsPreferenceRow1.Label:GetText()'), 'Earthquake');
  assert.equal(h.string('QuickWoWTalentsPreferenceRow2.Label:GetText()'), 'Shaman movement');
  h.run('QuickWoWTalentsPreferencesToggle.scripts.OnClick()');
  choose(h, 1, 3);
  assert.equal(h.string('TEST.namespace.Preferences.Get(262, "earthquakeTargeting")'), 'ground');
  assert.equal(h.boolean('TEST.request == nil'), true, 'setting a preference never imports');
  assert.equal(h.string('QuickWoWTalentsData.recommendations[262].mplus.encounters[12993].importString'), 'TEST_IMPORT_STRING');
  assert.equal(h.number('TEST.overrides[80985]'), 127925);
  const effective = h.string('TEST.importBox:GetText()');
  h.clickCopy();
  assert.equal(h.string('TEST.importBox:GetText()'), effective);
  h.clickImport();
  assert.equal(h.string('TEST.request.importString'), effective);
  assert.equal(h.string('TEST.request.name'), 'QWT-Altar of Fangs');
});

test('busy import freezes preferences and the copy string, then follows spec change', async () => {
  const h = await preferenceHarness();
  h.slash();
  h.run('QuickWoWTalentsPreferencesToggle.scripts.OnClick()');
  choose(h, 1, 3);
  h.clickImport();
  const original = h.string('TEST.request.importString');
  h.run('QuickWoWTalentsPreference1Control.scripts.OnClick()');
  assert.equal(h.boolean('QuickWoWTalentsPreference1:IsShown()'), false);
  assert.equal(h.boolean('QuickWoWTalentsPreferencesToggle:IsEnabled()'), false);
  h.run('C_SpecializationInfo.GetSpecializationInfo = function() return 64, "Frost" end');
  h.fire('PLAYER_SPECIALIZATION_CHANGED', 'player');
  h.clickCopy();
  assert.equal(h.string('TEST.importBox:GetText()'), original);
  assert.equal(h.string('TEST.request.importString'), original);
  h.run('TEST.importBusy = false; TEST.request.onStatus("Applied previous build.", true, true)');
  assert.equal(h.string('QuickWoWTalentsPreferenceRow1.Label:GetText()'), 'Blizzard');
  assert.equal(h.string('QuickWoWTalentsPreferenceRow3.Label:GetText()'), 'Water Elemental');
  assert.equal(h.string('TEST.importBox:GetText()'), 'TEST_IMPORT_STRING');
  assert.equal(h.string('TEST.namespace.Preferences.Get(262, "earthquakeTargeting")'), 'ground');
});

test('unsafe personalization blocks import and copying until Use recommended is selected', async () => {
  const h = await preferenceHarness();
  h.slash();
  h.run('QuickWoWTalentsPreferencesToggle.scripts.OnClick(); TEST.decodeFails = true');
  choose(h, 1, 3);
  assert.match(h.string('TEST.hint:GetText()'), /could not be read safely/);
  assert.equal(h.boolean('TEST.importButton:IsEnabled()'), false);
  assert.equal(h.string('TEST.importBox:GetText()'), '');
  h.clickImport();
  h.clickCopy();
  assert.equal(h.boolean('TEST.request == nil'), true);
  assert.equal(h.string('TEST.importBox:GetText()'), '');
  choose(h, 1, 1);
  assert.equal(h.boolean('TEST.importButton:IsEnabled()'), true);
  assert.equal(h.string('TEST.importBox:GetText()'), 'TEST_IMPORT_STRING');
});

test('unavailable choices stay saved and show skipped warnings; unsupported saved formats are visible', async () => {
  const h = await preferenceHarness();
  h.slash();
  h.run('QuickWoWTalentsPreferencesToggle.scripts.OnClick(); TEST.preferenceEntries = {}');
  choose(h, 1, 3);
  assert.match(h.string('TEST.hint:GetText()'), /1 preference skipped/);
  assert.match(h.string('QuickWoWTalentsPreferenceRow1.Description:GetText()'), /Not selected/);
  assert.equal(h.string('TEST.namespace.Preferences.Get(262, "earthquakeTargeting")'), 'ground');
  assert.equal(h.string('TEST.importBox:GetText()'), 'TEST_IMPORT_STRING');
  h.run('QuickWoWTalentsDB.talentPreferences.version = 99');
  h.slash();
  assert.match(h.string('TEST.hint:GetText()'), /preference skipped/);
  assert.equal(h.number('QuickWoWTalentsDB.talentPreferences.version'), 99);
});

test('expanded preferences keep import, progress, copy field and footer separated', async () => {
  const h = await preferenceHarness();
  h.slash();
  h.run('C_SpecializationInfo.GetSpecializationInfo = function() return 64, "Frost" end');
  h.fire('PLAYER_SPECIALIZATION_CHANGED', 'player');
  h.run('QuickWoWTalentsPreferencesToggle.scripts.OnClick()');
  assert.equal(h.number('QuickWoWTalentsPreferencesPanel:GetHeight()'), 286);
  assert.equal(h.number('QuickWoWTalentsFrame:GetHeight()'), 736);
  assert.equal(h.number('QuickWoWTalentsImportButton.points[1][3]'), -574);
  assert.equal(h.number('QuickWoWTalentsApplyProgress.points[1][3]'), -616);
  h.clickCopy();
  assert.equal(h.number('QuickWoWTalentsFrame:GetHeight()'), 782);
  assert.equal(h.number('QuickWoWTalentsCopyPanel.points[1][3]'), -682);
  h.run('QuickWoWTalentsPreferencesToggle.scripts.OnClick()');
  assert.equal(h.number('QuickWoWTalentsFrame:GetHeight()'), 496);
  assert.equal(h.number('QuickWoWTalentsImportButton.points[1][3]'), -288);
});
