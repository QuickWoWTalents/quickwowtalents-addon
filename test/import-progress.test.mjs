import assert from 'node:assert/strict';
import test from 'node:test';

import { createAddonHarness } from './helpers/lua-addon-harness.mjs';

const namespaceSource = `{
  TalentImport = {
    IsBusy = function() return TEST.importBusy == true end,
    GetStatus = function() return { phase = TEST.importPhase or "importing" } end,
    Begin = function(request)
      TEST.request = request
      TEST.beginCount = (TEST.beginCount or 0) + 1
      if TEST.rejectImport then return false, "Cannot apply talents here." end
      TEST.importBusy = true
      if TEST.onBegin then TEST.onBegin() end
      return true
    end
  }
}`;

async function openHarness(options = {}) {
  const harness = await createAddonHarness({
    addonName: 'QuickWoWTalents', namespaceSource, ...options
  });
  harness.slash();
  return harness;
}

function shown(harness) {
  return harness.boolean('QuickWoWTalentsApplyProgress:IsShown()');
}

function startCast(harness, { spellID = 384255, unit = 'player' } = {}) {
  harness.run(`TEST.cast = { startMS = 99000, endMS = 103000, spellID = ${spellID} }`);
  harness.fire('UNIT_SPELLCAST_START', unit, 'Cast-Test-1', spellID);
}

test('progress stays hidden for unrelated casts until this window starts an import', async () => {
  const harness = await openHarness();
  assert.equal(shown(harness), false);
  startCast(harness);
  harness.update();
  assert.equal(shown(harness), false, 'even a talent cast from another source must not claim an import');
  harness.run('TEST.cast = nil');
  harness.clickImport();
  assert.equal(shown(harness), true);
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0);
  assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '');
  assert.match(harness.string('QuickWoWTalentsProgressLabel:GetText()'), /preparing/i);
});

test('native talent cast timing updates the embedded bar without deciding import success', async () => {
  const harness = await openHarness();
  harness.clickImport();
  startCast(harness);
  harness.update();
  assert.equal(shown(harness), true);
  assert.equal(harness.number('QuickWoWTalentsApplyProgress.minimum'), 0);
  assert.equal(harness.number('QuickWoWTalentsApplyProgress.maximum'), 4);
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 1);
  assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '3.0s');
  assert.match(harness.string('QuickWoWTalentsProgressLabel:GetText()'), /applying talents/i);

  harness.run('TEST.now = 102');
  harness.update();
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 3);
  assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '1.0s');
  harness.run('TEST.now = 104; TEST.cast = nil; TEST.importPhase = "selecting"');
  harness.fire('UNIT_SPELLCAST_STOP', 'player', 'Cast-Test-1', 384255);
  harness.update();
  assert.equal(shown(harness), true, 'cast completion is not importer completion');
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0);
  assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '');
  assert.match(harness.string('QuickWoWTalentsProgressLabel:GetText()'), /verifying/i);
  assert.equal(harness.boolean('TEST.importBusy'), true);
  assert.equal(harness.number('TEST.beginCount'), 1);

  harness.run('TEST.importBusy = false; TEST.request.onStatus("Applied QWT-Altar of Fangs.", true, true)');
  assert.equal(shown(harness), false);
  assert.equal(harness.boolean('QuickWoWTalentsImportButton:IsEnabled()'), true);
  assert.equal(harness.string('TEST.hint:GetText()'), 'Applied QWT-Altar of Fangs.');
});

test('an import captures a native cast that starts synchronously inside Begin', async () => {
  const harness = await openHarness();
  harness.run(`TEST.onBegin = function()
    TEST.cast = { startMS = 99000, endMS = 103000, spellID = 384255 }
    TEST.Fire("UNIT_SPELLCAST_START", "player", "Cast-Test-1", 384255)
  end`);
  harness.clickImport();
  harness.update();
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 1);
  assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '3.0s');
});

test('static preparation, sharing, verification and cleanup stages do not fabricate timing', async () => {
  const harness = await openHarness();
  harness.clickImport();
  for (const [phase, label] of [
    ['importing', /preparing/i], ['saved', /preparing/i],
    ['sharing', /shared action bars/i], ['ready', /waiting/i],
    ['loading', /waiting/i], ['selecting', /verifying/i],
    ['cleanup', /removing earlier QWT builds/i], ['deleting', /removing earlier QWT builds/i]
  ]) {
    harness.run(`TEST.importPhase = ${JSON.stringify(phase)}`);
    harness.update();
    assert.equal(shown(harness), true, phase);
    assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0, phase);
    assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '', phase);
    assert.match(harness.string('QuickWoWTalentsProgressLabel:GetText()'), label, phase);
  }
});

test('only the native talent spell contributes timing; other player spells and channels do not', async () => {
  const harness = await openHarness();
  harness.clickImport();
  startCast(harness, { spellID: 133 });
  harness.update();
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0);
  assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '');
  harness.run('TEST.cast = nil; TEST.channel = { startMS = 99000, endMS = 103000, spellID = 384255 }');
  harness.fire('UNIT_SPELLCAST_CHANNEL_START', 'player');
  harness.update();
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0);
  assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '');
});

for (const [label, setup] of [
  ['missing API', 'UnitCastingInfo = nil'],
  ['API exception', 'UnitCastingInfo = function() error("unavailable") end'],
  ['missing timing', 'TEST.cast = { spellID = 384255 }'],
  ['string timing', 'TEST.cast = { startMS = "99000", endMS = 103000, spellID = 384255 }'],
  ['nonfinite timing', 'TEST.cast = { startMS = 99000, endMS = math.huge, spellID = 384255 }'],
  ['NaN timing', 'TEST.cast = { startMS = 0/0, endMS = 103000, spellID = 384255 }'],
  ['reversed timing', 'TEST.cast = { startMS = 103000, endMS = 99000, spellID = 384255 }'],
  ['expired timing', 'TEST.cast = { startMS = 97000, endMS = 99000, spellID = 384255 }'],
  ['secret timing', 'TEST.cast = { startMS = 99000, endMS = 103000, spellID = 384255 }; TEST.secretValues[99000] = true'],
  ['secret spell identity', 'TEST.cast = { startMS = 99000, endMS = 103000, spellID = 384255 }; TEST.secretValues[384255] = true']
]) {
  test(`${label} falls back to stage text without disrupting the import`, async () => {
    const harness = await openHarness();
    harness.clickImport();
    harness.run(setup);
    harness.fire('UNIT_SPELLCAST_START', 'player', 'Cast-Test-1', 384255);
    harness.update();
    assert.equal(shown(harness), true);
    assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0);
    assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '');
    assert.equal(harness.boolean('TEST.importBusy'), true);
    assert.equal(harness.number('TEST.beginCount'), 1);
    harness.run('TEST.importBusy = false; TEST.request.onStatus("Build applied.", true, true)');
    assert.equal(shown(harness), false);
    assert.equal(harness.string('TEST.hint:GetText()'), 'Build applied.');
  });
}

test('preflight rejection and an importer failure both dismiss the progress indicator', async () => {
  const harness = await openHarness();
  harness.run('TEST.rejectImport = true');
  harness.clickImport();
  assert.equal(shown(harness), false);
  assert.equal(harness.boolean('QuickWoWTalentsImportButton:IsEnabled()'), true);
  harness.run('TEST.rejectImport = false');
  harness.clickImport();
  startCast(harness);
  harness.run('TEST.importBusy = false; TEST.request.onStatus("Talent change interrupted.", true, false)');
  assert.equal(shown(harness), false);
  assert.equal(harness.string('TEST.hint:GetText()'), 'Talent change interrupted.');
  harness.update();
  assert.equal(shown(harness), false, 'a stale native cast cannot revive completed progress');
});

test('showing progress keeps content selectors locked and survives closing then reopening the widget', async () => {
  const harness = await openHarness();
  harness.clickImport();
  startCast(harness);
  harness.run('QuickWoWTalentsModeDropdownControl.scripts.OnClick()');
  assert.equal(harness.boolean('QuickWoWTalentsModeDropdown:IsShown()'), false);
  harness.run('QuickWoWTalentsFrame:Hide(); TEST.now = 101');
  harness.slash();
  harness.update();
  assert.equal(shown(harness), true);
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 2);
  assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '2.0s');
  assert.equal(harness.number('TEST.beginCount'), 1);
});

for (const event of ['UNIT_SPELLCAST_STOP', 'UNIT_SPELLCAST_FAILED', 'UNIT_SPELLCAST_INTERRUPTED', 'UNIT_SPELLCAST_SUCCEEDED']) {
  test(`${event} clears a stale native snapshot without claiming import completion`, async () => {
    const harness = await openHarness();
    harness.clickImport();
    startCast(harness);
    assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 1);
    harness.fire(event, 'player', 'Cast-Test-1', 384255);
    harness.update();
    assert.equal(shown(harness), true);
    assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0);
    assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '');
    assert.equal(harness.boolean('TEST.importBusy'), true);
    assert.equal(harness.boolean('QuickWoWTalentsImportButton:IsEnabled()'), false);
    harness.fire('UNIT_SPELLCAST_START', 'party1', 'Cast-Test-1', 384255);
    harness.update();
    assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0,
      'another unit cannot reactivate a stopped player cast');
    harness.run('TEST.cast = { startMS = 99500, endMS = 104000, spellID = 384255, castID = "Cast-Test-2" }');
    harness.fire('UNIT_SPELLCAST_START', 'player', 'Cast-Test-2', 384255);
    harness.update();
    assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0.5);
    assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '4.0s');
  });
}

test('a delayed old-cast stop cannot erase timing from a newer cast', async () => {
  const harness = await openHarness();
  harness.clickImport();
  startCast(harness);
  harness.run('TEST.cast = { startMS = 99500, endMS = 104000, spellID = 384255, castID = "Cast-Test-2" }');
  harness.fire('UNIT_SPELLCAST_START', 'player', 'Cast-Test-2', 384255);
  harness.fire('UNIT_SPELLCAST_STOP', 'player', 'Cast-Test-1', 384255);
  harness.update();
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0.5);
  assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '4.0s');
});

test('delayed cast timing comes from the refreshed native values', async () => {
  const harness = await openHarness();
  harness.clickImport();
  startCast(harness);
  harness.run('TEST.cast.endMS = 105000; TEST.now = 102');
  harness.fire('UNIT_SPELLCAST_DELAYED', 'player', 'Cast-Test-1', 384255);
  assert.equal(harness.number('QuickWoWTalentsApplyProgress.maximum'), 6);
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 3);
  assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '3.0s');
});

test('the native trait spell constant takes precedence over the compatibility fallback', async () => {
  const harness = await openHarness({
    beforeAddonSource: 'Constants = { TraitConsts = { COMMIT_COMBAT_TRAIT_CONFIG_CHANGES_SPELL_ID = 999999 } }'
  });
  harness.clickImport();
  startCast(harness);
  harness.update();
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0);
  startCast(harness, { spellID: 999999 });
  harness.update();
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 1);
});

test('verification and cleanup replace any lingering cast with their actual stage', async () => {
  const harness = await openHarness();
  harness.clickImport();
  startCast(harness);
  for (const phase of ['selecting', 'cleanup', 'deleting']) {
    harness.run(`TEST.importPhase = ${JSON.stringify(phase)}`);
    harness.update();
    assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 0, phase);
    assert.equal(harness.string('QuickWoWTalentsProgressTime:GetText()'), '', phase);
    assert.equal(harness.boolean('TEST.importBusy'), true, phase);
  }
});

test('missing or throwing status inspection never blocks the native cast display', async () => {
  const harness = await openHarness();
  harness.run('TEST.namespace.TalentImport.GetStatus = function() error("unavailable") end');
  harness.clickImport();
  assert.equal(shown(harness), true);
  assert.match(harness.string('QuickWoWTalentsProgressLabel:GetText()'), /preparing/i);
  harness.run('TEST.namespace.TalentImport.GetStatus = nil');
  startCast(harness);
  harness.update();
  assert.equal(harness.number('QuickWoWTalentsApplyProgress:GetValue()'), 1);
});

test('synchronous importer completion cannot leave progress stuck on screen', async () => {
  const harness = await openHarness();
  harness.run(`TEST.onBegin = function()
    TEST.importBusy = false
    TEST.request.onStatus("Build applied.", true, true)
  end`);
  harness.clickImport();
  harness.update();
  assert.equal(shown(harness), false);
  assert.equal(harness.boolean('QuickWoWTalentsImportButton:IsEnabled()'), true);
  assert.equal(harness.string('TEST.hint:GetText()'), 'Build applied.');
});
