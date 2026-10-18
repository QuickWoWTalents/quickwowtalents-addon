import assert from 'node:assert/strict';
import test from 'node:test';

import { createAddonHarness, makeRuntimeData } from './helpers/lua-addon-harness.mjs';

const addon = 'QuickWoWTalents';
const menu = `${addon}EncounterDropdown`;
const modeMenu = `${addon}ModeDropdown`;
const namespaceSource = `{
  TalentImport = {
    IsBusy = function() return TEST.importBusy == true end,
    Begin = function(request)
      TEST.request = request
      TEST.importBusy = true
      return true
    end
  }
}`;

function manyEncounters(count = 21) {
  const data = makeRuntimeData();
  const base = data.recommendations[62].mplus.encounters[12993];
  for (let index = 2; index <= count; index += 1) {
    const id = 20000 + index;
    const name = `Dungeon ${String(index).padStart(2, '0')}`;
    data.modes.mplus.dungeons.push({ id, name });
    data.recommendations[62].mplus.encounters[id] = {
      ...base, dungeonId: id, dungeonName: name, importString: `BUILD-${index}`
    };
  }
  return data;
}

async function openHarness(options = {}) {
  const harness = await createAddonHarness({ addonName: addon, namespaceSource, ...options });
  harness.slash();
  return harness;
}

function toggle(harness, name = menu) {
  harness.run(`${name}Control.scripts.OnClick(${name}Control)`);
}

function key(harness, value, name = menu) {
  harness.run(`${name}.scripts.OnKeyDown(${name}, ${JSON.stringify(value)})`);
}

function clickRow(harness, index, name = menu) {
  harness.run(`${name}.rows[${index}].scripts.OnClick(${name}.rows[${index}])`);
}

test('open selectors own a flat dark popup and rows without touching Blizzard menu globals', async () => {
  const harness = await openHarness({ data: manyEncounters(2) });
  harness.run('DropDownList1 = { sentinel = true }; TEST.blizzardMenu = DropDownList1');
  toggle(harness);
  assert.equal(harness.boolean(`${menu}:IsShown()`), true);
  assert.equal(harness.boolean(`${menu}.clampedToScreen`), true);
  assert.equal(harness.boolean(`${menu}.keyboardEnabled`), true);
  assert.equal(harness.boolean(`${menu}.mouseWheelEnabled`), true);
  assert.equal(harness.string(`${menu}.frameType`), 'Frame');
  assert.equal(harness.number(`#${menu}.options`), 2);
  assert.equal(harness.boolean(`${menu}.options[1].checked`), true);
  assert.equal(harness.boolean(`${menu}.options[2].checked`), false);
  assert.equal(harness.boolean(`${menu}.rows[1].Selected:IsShown()`), true);
  assert.equal(harness.boolean(`${menu}.rows[2].Selected:IsShown()`), false);
  assert.equal(harness.boolean(`${menu}.rows[1].Text.wordWrap`), false, 'long encounter names stay inside one row');
  assert.equal(harness.boolean('DropDownList1 == TEST.blizzardMenu and DropDownList1.sentinel'), true);

  const popup = harness.layout().find(({ name }) => name === menu);
  assert.equal(popup.backdrop.bgFile, 'Interface\\Buttons\\WHITE8X8');
  assert.ok(popup.backdropColor.slice(0, 3).every(value => value < 0.2), 'popup has the addon’s charcoal fill');
  assert.ok(popup.backdropBorderColor.slice(0, 3).every(value => value < 0.5), 'popup keeps the subdued flat border');
  for (const widget of harness.layout()) {
    assert.doesNotMatch(widget.template || '', /UIDropDown|UIDropDownMenu|UIDropDownMenuButton|UIPanelButton/);
  }

  toggle(harness);
  assert.equal(harness.boolean(`${menu}:IsShown()`), false, 'second trigger click closes the same popup');
});

test('selecting a custom row updates the recommendation, checked row and one-click import', async () => {
  const harness = await openHarness({ data: manyEncounters(2) });
  toggle(harness);
  clickRow(harness, 2);
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
  assert.equal(harness.string(`${menu}Control.Text:GetText()`), 'Dungeon 02');
  assert.equal(harness.string(`${addon}ImportBox:GetText()`), 'BUILD-2');
  assert.equal(harness.boolean('TEST.request == nil'), true, 'selecting a recommendation alone never imports it');
  toggle(harness);
  assert.equal(harness.boolean(`${menu}.options[2].checked`), true);
  assert.equal(harness.boolean(`${menu}.options[1].checked`), false);
  assert.equal(harness.boolean(`${menu}.rows[1].Selected:IsShown()`), false);
  assert.equal(harness.boolean(`${menu}.rows[2].Selected:IsShown()`), true);
  harness.clickImport();
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
  assert.equal(harness.string('TEST.request.name'), 'QWT-Dungeon 02');
  assert.equal(harness.string('TEST.request.importString'), 'BUILD-2');
});

test('switching selectors closes the earlier popup and escape closes only the open list', async () => {
  const harness = await openHarness();
  toggle(harness);
  toggle(harness, modeMenu);
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
  assert.equal(harness.boolean(`${modeMenu}:IsShown()`), true);
  key(harness, 'ESCAPE', modeMenu);
  assert.equal(harness.boolean(`${modeMenu}:IsShown()`), false);
  assert.equal(harness.boolean(`${addon}Frame:IsShown()`), true);
});

test('keyboard navigation reaches distant options and Enter or Space selects the focused row', async () => {
  const harness = await openHarness({ data: manyEncounters() });
  toggle(harness);
  key(harness, 'END');
  assert.equal(harness.number(`${menu}.focused`), 21);
  assert.ok(harness.number(`${menu}.offset`) > 0);
  key(harness, 'PAGEDOWN');
  assert.equal(harness.number(`${menu}.focused`), 21, 'navigation is bounded at the end');
  key(harness, 'PAGEUP');
  assert.ok(harness.number(`${menu}.focused`) < 21);
  key(harness, 'HOME');
  assert.equal(harness.number(`${menu}.focused`), 1);
  key(harness, 'UP');
  assert.equal(harness.number(`${menu}.focused`), 1, 'navigation is bounded at the start');
  key(harness, 'DOWN');
  assert.equal(harness.number(`${menu}.focused`), 2);
  key(harness, 'ENTER');
  assert.equal(harness.string(`${menu}Control.Text:GetText()`), 'Dungeon 02');
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);

  toggle(harness);
  key(harness, 'END');
  key(harness, 'SPACE');
  assert.equal(harness.string(`${menu}Control.Text:GetText()`), 'Dungeon 21');
  assert.equal(harness.string(`${addon}ImportBox:GetText()`), 'BUILD-21');
  assert.equal(harness.boolean('TEST.request == nil'), true);
});

test('mousewheel pages a bounded row pool and picking a scrolled row selects its current option', async () => {
  const harness = await openHarness({ data: manyEncounters() });
  toggle(harness);
  assert.equal(harness.number(`#${menu}.rows`), 8, 'large lists reuse a small visible row pool');
  harness.run(`${menu}.scripts.OnMouseWheel(${menu}, -1)`);
  const offset = harness.number(`${menu}.offset`);
  assert.ok(offset > 0);
  clickRow(harness, 1);
  assert.equal(harness.string(`${addon}ImportBox:GetText()`), `BUILD-${offset + 1}`);
  toggle(harness);
  harness.run(`for i = 1, 50 do ${menu}.scripts.OnMouseWheel(${menu}, -1) end`);
  assert.ok(harness.number(`${menu}.offset`) <= 21 - 8);
  harness.run(`for i = 1, 50 do ${menu}.scripts.OnMouseWheel(${menu}, 1) end`);
  assert.equal(harness.number(`${menu}.offset`), 0);
  assert.equal(harness.number(`#${menu}.rows`), 8, 'paging does not accumulate new frames');
});

test('long lists expose working previous and next controls with bounded page counts', async () => {
  const harness = await openHarness({ data: manyEncounters() });
  toggle(harness);
  assert.equal(harness.boolean(`${menu}.Previous:IsShown()`), true);
  assert.equal(harness.boolean(`${menu}.Previous:IsEnabled()`), false);
  assert.equal(harness.boolean(`${menu}.Next:IsEnabled()`), true);
  assert.equal(harness.string(`${menu}.Count:GetText()`), '1–8 / 21');
  harness.run(`${menu}.Next.scripts.OnClick(${menu}.Next)`);
  assert.equal(harness.number(`${menu}.offset`), 8);
  assert.equal(harness.string(`${menu}.Count:GetText()`), '9–16 / 21');
  harness.run(`${menu}.Next.scripts.OnClick(${menu}.Next)`);
  assert.equal(harness.string(`${menu}.Count:GetText()`), '14–21 / 21');
  assert.equal(harness.boolean(`${menu}.Next:IsEnabled()`), false);
  harness.run(`${menu}.Previous.scripts.OnClick(${menu}.Previous)`);
  assert.equal(harness.number(`${menu}.offset`), 5);
  assert.equal(harness.boolean(`${menu}.Next:IsEnabled()`), true);

  toggle(harness, modeMenu);
  assert.equal(harness.boolean(`${modeMenu}.Previous:IsShown()`), false);
  assert.equal(harness.boolean(`${modeMenu}.Next:IsShown()`), false);
  assert.equal(harness.boolean(`${modeMenu}.Count:IsShown()`), false);
});

test('menu keyboard consumes navigation while ordinary keys propagate and combat prevents selection', async () => {
  const harness = await openHarness({ data: manyEncounters(2) });
  toggle(harness);
  assert.equal(harness.boolean(`${menu}.propagateKeyboardInput`), true);
  key(harness, 'DOWN');
  assert.equal(harness.boolean(`${menu}.propagateKeyboardInput`), false);
  key(harness, 'W');
  assert.equal(harness.boolean(`${menu}.propagateKeyboardInput`), true, 'movement keys are not swallowed');
  harness.run(`InCombatLockdown = function() return true end
    ${menu}.SetPropagateKeyboardInput = function() error("Protected propagation cannot change in combat") end`);
  key(harness, 'ENTER');
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
  assert.equal(harness.string(`${menu}Control.Text:GetText()`), 'Altar of Fangs');
  toggle(harness);
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
  assert.equal(harness.boolean('TEST.request == nil'), true);
});

test('dismissed rows cannot apply stale options and re-opening reuses the same row pool', async () => {
  const harness = await openHarness({ data: manyEncounters(2) });
  toggle(harness);
  const rowCount = harness.number('#TEST.frames');
  toggle(harness);
  clickRow(harness, 2);
  assert.equal(harness.string(`${menu}Control.Text:GetText()`), 'Altar of Fangs');
  assert.equal(harness.number(`#${menu}.options`), 0);
  toggle(harness);
  assert.equal(harness.number('#TEST.frames'), rowCount);
  clickRow(harness, 2);
  assert.equal(harness.string(`${menu}Control.Text:GetText()`), 'Dungeon 02');
});

test('outside clicks dismiss menus while clicks inside the menu or trigger retain them', async () => {
  const harness = await openHarness();
  toggle(harness);
  harness.run(`${menu}.mouseOver = true`);
  harness.fire('GLOBAL_MOUSE_DOWN', 'LeftButton');
  assert.equal(harness.boolean(`${menu}:IsShown()`), true);
  harness.run(`${menu}.mouseOver = false; ${menu}Control.mouseOver = true`);
  harness.fire('GLOBAL_MOUSE_DOWN', 'LeftButton');
  assert.equal(harness.boolean(`${menu}:IsShown()`), true);
  harness.run(`${menu}Control.mouseOver = false`);
  harness.fire('GLOBAL_MOUSE_DOWN', 'LeftButton');
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
});

test('hiding the window or changing player specialization dismisses stale menu choices', async () => {
  const harness = await openHarness();
  toggle(harness);
  harness.run(`${addon}Frame:Hide()`);
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
  harness.slash();
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
  toggle(harness);
  harness.fire('PLAYER_SPECIALIZATION_CHANGED', 'party1');
  assert.equal(harness.boolean(`${menu}:IsShown()`), true, 'another unit does not change the user’s selection');
  harness.run('C_SpecializationInfo.GetSpecializationInfo = function() return 63, "Fire" end');
  harness.fire('PLAYER_SPECIALIZATION_CHANGED', 'player');
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
});

test('import busy state blocks both fresh menu openings and callbacks retained from an earlier row', async () => {
  const harness = await openHarness({ data: manyEncounters(2) });
  toggle(harness);
  harness.run(`TEST.savedChoice = ${menu}.options[2].func`);
  harness.clickImport();
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
  toggle(harness);
  toggle(harness, modeMenu);
  assert.equal(harness.boolean(`${menu}:IsShown()`), false);
  assert.equal(harness.boolean(`${modeMenu}:IsShown()`), false);
  harness.run('TEST.savedChoice()');
  assert.equal(harness.string(`${menu}Control.Text:GetText()`), 'Altar of Fangs');
  assert.equal(harness.string('TEST.request.name'), 'QWT-Altar of Fangs');
});

test('Ellesmere theme integration skins only its own menu and never a global dropdown', async () => {
  const harness = await openHarness({ ellesmere: 'enabled' });
  toggle(harness);
  harness.run(`
    local popupPanels = {}
    for _, call in ipairs(TEST.skinCalls) do
      if call.method == "Panel" and call.target.name and call.target.name:match("Dropdown$") then
        popupPanels[call.target.name] = true
        assert(call.target:GetParent() == _G[call.registration .. "Frame"])
      end
      assert(not call.target.name or not call.target.name:match("^DropDownList"))
    end
    assert(popupPanels.QuickWoWTalentsEncounterDropdown)
  `);
  assert.equal(harness.string(`${menu}Control.Text:GetText()`), 'Altar of Fangs');
});
