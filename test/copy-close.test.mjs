import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const addonLuaPath = new URL('../QuickWoWTalents/QuickWoWTalents.lua', import.meta.url);

async function readAddonLua() {
  return readFile(addonLuaPath, 'utf8');
}

test('copy button arms close-on-copy without arming plain text selection', async () => {
  const source = await readAddonLua();

  assert.match(source, /selectButton:SetScript\("OnClick", function\(\) SelectImportText\(true\) end\)/);
  assert.match(source, /local function SelectImportText\(closeOnNextCopy\)/);
  assert.match(source, /if closeOnNextCopy then\s+UI\.closeOnNextCopy = true/s);
  assert.match(source, /elseif UI\.hint then\s+UI\.hint:SetText\("Selected\. Press Ctrl\+C or Cmd\+C, then paste in Talents → Loadouts → Import\."\)/s);
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
