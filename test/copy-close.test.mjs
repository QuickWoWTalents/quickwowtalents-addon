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

async function readAddonLua() {
  return readFile(addonLuaPath, 'utf8');
}

test('actual Lua runtime exposes the compatible encounter recommendation', async () => {
  const harness = await createAddonHarness({
    data: makeRuntimeData({ catalogWowBuild: '12.1.0.70000' })
  });

  assert.equal(harness.string('QuickWoWTalentsData.talentCatalog.wowBuild'), '12.1.0.70000');
  assert.equal(harness.string('(select(1, GetBuildInfo())) .. "." .. (select(2, GetBuildInfo()))'), '12.1.0.99999');
  assert.equal(harness.number('QuickWoWTalentsData.clientInterface'), 120100);
  assert.equal(harness.number('select(4, GetBuildInfo())'), 120100);
  harness.slash();

  assert.equal(harness.boolean('TEST.mainFrame ~= nil and TEST.mainFrame:IsShown()'), true);
  assert.equal(harness.string('TEST.importBox:GetText()'), TEST_IMPORT_STRING);
  assert.equal(harness.messages().some((message) => message.includes(UPDATE_REQUIRED_MESSAGE)), false);
});

for (const [name, data] of [
  ['schema mismatch', makeRuntimeData({ schemaVersion: 2 })],
  ['interface mismatch', makeRuntimeData({ clientInterface: 120000 })]
]) {
  test(`actual Lua runtime blocks manual UI entry on ${name}`, async () => {
    const harness = await createAddonHarness({ data });
    harness.slash();

    assert.equal(harness.boolean('TEST.mainFrame == nil'), true);
    assert.deepEqual(harness.messages(), [`|cff00c8ffQuick WoW Talents|r: ${UPDATE_REQUIRED_MESSAGE}`]);
  });
}

test('actual Lua copy flow clears a recommendation if data becomes incompatible', async () => {
  const harness = await createAddonHarness();
  harness.slash();
  assert.equal(harness.string('TEST.importBox:GetText()'), TEST_IMPORT_STRING);

  harness.updateData({ schemaVersion: 2 });
  harness.clickCopy();

  assert.equal(harness.string('TEST.importBox:GetText()'), '');
  assert.equal(harness.string('TEST.hint.text'), UPDATE_REQUIRED_MESSAGE);
});

test('schema 3 never falls back to a legacy Mythic+ recommendation', async () => {
  const source = await readAddonLua();
  assert.doesNotMatch(source, /mplusBestOverall/);
});

test('copy UI presents the import string as a clear two-step Windows flow', async () => {
  const source = await readAddonLua();

  assert.match(source, /selectButton:SetScript\("OnClick", function\(\) SelectImportText\(true\) end\)/);
  assert.match(source, /local function SelectImportText\(closeOnNextCopy\)/);
  assert.match(source, /if closeOnNextCopy then\s+UI\.closeOnNextCopy = true/s);
  assert.match(source, /selectButton:SetText\("1\. Select Import String"\)/);
  assert.match(source, /local hint = frame:CreateFontString\(nil, "OVERLAY", "GameFontNormal"\)/);
  assert.match(source, /UI\.hint:SetText\("2\. Press Ctrl\+C to copy"\)/);
  assert.match(source, /UI\.hint:SetText\("2\. Import string selected — press Ctrl\+C now"\)/);
  assert.match(source, /UI\.hint:SetTextColor\(0\.2, 1, 0\.2\)/);
  assert.match(source, /copyNote:SetText\("WoW requires this keyboard shortcut; the window closes after copying\."\)/);
  assert.match(source, /importBox:SetScript\("OnMouseUp", function\(\) SelectImportText\(true\) end\)/);

  const visibleText = [...source.matchAll(/:SetText\("([^"]*)"\)/g)]
    .map(([, text]) => text)
    .join('\n');
  assert.doesNotMatch(visibleText, /Cmd\+C/);
});

test('copy-close handler supports Ctrl and Mac Command shortcuts on the focused edit box', async () => {
  const source = await readAddonLua();

  assert.match(source, /key == "LCTRL" or key == "RCTRL" or key == "LMETA" or key == "RMETA"/);
  assert.match(source, /importBox:SetScript\("OnKeyDown"/);
  assert.match(source, /importBox:SetScript\("OnKeyUp"/);
  assert.match(source, /UI\.closeOnNextCopy and UI\.copyModifierDown and key == "C"/);
});

test('copy-close defers hiding so native copy can complete and disarms stale state', async () => {
  const source = await readAddonLua();

  assert.match(source, /local function CloseAfterNativeCopy\(\)/);
  assert.match(source, /C_Timer\.After\(0\.1, function\(\)/);
  assert.match(source, /UI\.frame:Hide\(\)/);
  assert.match(source, /DisarmCloseAfterCopy\(\)/);
  assert.match(source, /UI\.copyCloseToken == token/);
});
