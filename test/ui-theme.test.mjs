import assert from 'node:assert/strict';
import test from 'node:test';

import { createAddonHarness, TEST_IMPORT_STRING } from './helpers/lua-addon-harness.mjs';

const importingNamespace = `{
  TalentImport = {
    IsBusy = function() return TEST.importBusy == true end,
    Begin = function(request)
      TEST.request = request
      TEST.importBusy = true
      return true
    end
  }
}`;

test('compact layout keeps import primary and reveals the copy field only when requested', async () => {
  const harness = await createAddonHarness({ addonName: 'QuickWoWTalents' });
  harness.slash();

  assert.equal(harness.boolean('QuickWoWTalentsCopyPanel:IsShown()'), false);
  assert.equal(harness.boolean('QuickWoWTalentsImportBox:IsVisible()'), false);
  assert.equal(harness.number('QuickWoWTalentsFrame:GetHeight()'), 410);
  assert.equal(harness.string('QuickWoWTalentsImportBox:GetText()'), TEST_IMPORT_STRING);

  const widgets = harness.layout();
  const frame = widgets.find(({ name }) => name === 'QuickWoWTalentsFrame');
  const primary = widgets.find(({ name }) => name === 'QuickWoWTalentsImportButton');
  const secondary = widgets.find(({ name }) => name === 'QuickWoWTalentsCopyButton');
  assert.ok(primary.width > secondary.width, 'import has the primary action area');
  assert.ok(primary.height >= 30 && secondary.height >= 30, 'both actions remain usable click targets');
  assert.ok(primary.points[0][1] + primary.width < secondary.points[0][1], 'action buttons do not overlap');
  assert.ok(secondary.points[0][1] + secondary.width <= frame.width, 'copy action fits inside the window');

  harness.clickCopy();
  assert.equal(harness.boolean('QuickWoWTalentsImportBox:IsVisible()'), true);
  assert.equal(harness.boolean('QuickWoWTalentsImportBox.focused'), true);
  assert.equal(harness.number('QuickWoWTalentsFrame:GetHeight()'), 456);
  assert.equal(harness.number('QuickWoWTalentsImportBox.highlightFirst'), 0);
  assert.equal(harness.number('QuickWoWTalentsImportBox.highlightLast'), TEST_IMPORT_STRING.length);
  assert.equal(harness.string('TEST.hint.name'), 'QuickWoWTalentsStatus');

  harness.run('QuickWoWTalentsImportBox.scripts.OnEscapePressed(QuickWoWTalentsImportBox)');
  assert.equal(harness.boolean('QuickWoWTalentsCopyPanel:IsShown()'), false);
  assert.equal(harness.boolean('QuickWoWTalentsImportBox.focused'), false);
  assert.equal(harness.number('QuickWoWTalentsFrame:GetHeight()'), 410);
  assert.equal(harness.string('QuickWoWTalentsImportBox:GetText()'), TEST_IMPORT_STRING);
});

test('copy shortcut still completes through the focused field before hiding the redesigned window', async () => {
  const harness = await createAddonHarness();
  harness.slash();
  harness.clickCopy();
  harness.run(`
    QuickWoWTalentsImportBox.scripts.OnKeyDown(QuickWoWTalentsImportBox, "LCTRL")
    QuickWoWTalentsImportBox.scripts.OnKeyUp(QuickWoWTalentsImportBox, "C")
  `);
  assert.equal(harness.boolean('QuickWoWTalentsFrame:IsShown()'), true);
  harness.runTimers();
  assert.equal(harness.boolean('QuickWoWTalentsFrame:IsShown()'), false);
  assert.equal(harness.boolean('QuickWoWTalentsImportBox.focused'), false);
  harness.slash();
  assert.equal(harness.boolean('QuickWoWTalentsCopyPanel:IsShown()'), false);
  assert.equal(harness.number('QuickWoWTalentsFrame:GetHeight()'), 410);
});

for (const ellesmere of ['absent', 'disabled', 'throw-register', 'throw-skin']) {
  test(`optional Ellesmere integration (${ellesmere}) cannot prevent importing or copying`, async () => {
    const harness = await createAddonHarness({
      addonName: 'QuickWoWTalents', ellesmere, namespaceSource: importingNamespace
    });
    harness.slash();
    assert.equal(harness.boolean('QuickWoWTalentsFrame:IsShown()'), true);
    harness.clickImport();
    assert.equal(harness.string('TEST.request.name'), 'QWT-Altar of Fangs');
    assert.equal(harness.string('TEST.request.importString'), TEST_IMPORT_STRING);
    assert.equal(harness.number('TEST.request.specID'), 62);
    assert.equal(harness.boolean('QuickWoWTalentsImportButton:IsEnabled()'), false);
    assert.equal(harness.boolean('QuickWoWTalentsAutoOpenCheckbox:GetChecked()'), true);
    harness.clickCopy();
    assert.equal(harness.boolean('QuickWoWTalentsImportBox.focused'), true);
    assert.equal(harness.string('TEST.hint.name'), 'QuickWoWTalentsStatus');
  });
}

test('Ellesmere styles only the addon’s own widgets', async () => {
  const harness = await createAddonHarness({ ellesmere: 'enabled', namespaceSource: importingNamespace });
  assert.equal(harness.number('#TEST.skinCalls'), 0, 'registration works before the lazy windows exist');
  harness.slash();

  assert.equal(harness.boolean('type(TEST.skinRegistrations.QuickWoWTalents) == "function"'), true);
  harness.run(`
    local shells = {}
    for _, call in ipairs(TEST.skinCalls) do
      local root = call.target
      while root and root.parent and root.parent ~= UIParent do root = root.parent end
      assert(root == _G[call.registration .. "Frame"], "skin must stay inside its own addon window")
      if call.method == "Shell" then shells[call.registration] = call.target end
      if call.method == "Button" then
        assert(call.target ~= _G[call.registration .. "ImportButton"], "class-colored action keeps its own fill")
      end
    end
    assert(shells.QuickWoWTalents == QuickWoWTalentsFrame)
  `);
  assert.equal(harness.number('QuickWoWTalentsImportButton.backdropColor[1]'), 0.25);
  assert.equal(harness.number('QuickWoWTalentsImportButton.backdropColor[2]'), 0.78);
  assert.equal(harness.number('QuickWoWTalentsImportButton.backdropColor[3]'), 0.92);
});

test('styled selectors use their own menus and do not change selection during an import', async () => {
  const harness = await createAddonHarness({ namespaceSource: importingNamespace });
  harness.slash();
  harness.run('QuickWoWTalentsEncounterDropdownControl.scripts.OnClick()');
  assert.equal(harness.boolean('QuickWoWTalentsEncounterDropdown:IsShown()'), true);
  assert.equal(harness.boolean('QuickWoWTalentsEncounterDropdown.control == QuickWoWTalentsEncounterDropdownControl'), true);
  assert.equal(harness.string('QuickWoWTalentsEncounterDropdownControl.Text:GetText()'), 'Altar of Fangs');
  harness.clickImport();
  assert.equal(harness.boolean('QuickWoWTalentsEncounterDropdown:IsShown()'), false);
  harness.run('QuickWoWTalentsModeDropdownControl.scripts.OnClick()');
  assert.equal(harness.boolean('QuickWoWTalentsModeDropdown:IsShown()'), false);
  assert.equal(harness.string('TEST.request.name'), 'QWT-Altar of Fangs');
});

test('button hover and busy-state repainting preserve import status and return enabled styling on completion', async () => {
  const harness = await createAddonHarness({ namespaceSource: importingNamespace });
  harness.slash();
  harness.clickImport();
  harness.run(`
    TEST.request.onStatus("Saving selected build.", false, false)
    QuickWoWTalentsImportButton.scripts.OnEnter()
    QuickWoWTalentsCopyButton.scripts.OnEnter()
  `);
  assert.equal(harness.string('TEST.hint.name'), 'QuickWoWTalentsStatus');
  assert.equal(harness.string('TEST.hint:GetText()'), 'Saving selected build.');
  assert.equal(harness.boolean('QuickWoWTalentsImportButton:IsEnabled()'), false);
  harness.run('TEST.importBusy = false; TEST.request.onStatus("Build applied.", true, true)');
  assert.equal(harness.boolean('QuickWoWTalentsImportButton:IsEnabled()'), true);
  assert.equal(harness.string('TEST.hint:GetText()'), 'Build applied.');
  assert.equal(harness.number('TEST.hint.textColor.green'), 1);
});

test('production branding uses the packaged logo without a test badge', async () => {
  const harness = await createAddonHarness();
  harness.slash();
  assert.equal(harness.string('QuickWoWTalentsLogo:GetTexture()'), 'Interface\\AddOns\\QuickWoWTalents\\Media\\Logo.tga');
  assert.equal(harness.boolean('QuickWoWTalentsVersionLabel == nil'), true);
  assert.equal(harness.boolean('QuickWoWTalentsLogo:GetParent():GetParent() == QuickWoWTalentsFrame'), true);
});
