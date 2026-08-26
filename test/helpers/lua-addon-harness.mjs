import fs from 'node:fs/promises';

import fengari from 'fengari';

import { toLua } from '../../scripts/build-data.mjs';

const { lua, lauxlib, lualib, to_luastring } = fengari;
const addonSource = await fs.readFile(new URL('../../QuickWoWTalents.lua', import.meta.url), 'utf8');

export const UPDATE_REQUIRED_MESSAGE = 'Update required: install the latest Quick WoW Talents.';
export const TEST_IMPORT_STRING = 'TEST_IMPORT_STRING';

export function makeRuntimeData({
  schemaVersion = 3,
  clientInterface = 120100,
  catalogWowBuild = '12.1.0.99999'
} = {}) {
  return {
    schemaVersion,
    clientInterface,
    generatedAt: '2026-08-25T12:00:00.000Z',
    talentCatalog: { wowBuild: catalogWowBuild },
    modes: {
      mplus: {
        recommendationLabel: 'Best Overall (15+)',
        minimumKeystoneLevel: 15,
        dungeons: [{ id: 12993, name: 'Altar of Fangs' }]
      },
      raid: {
        difficulty: { id: 4, name: 'Heroic' },
        bosses: [{ id: 3159, name: 'Rotmire' }]
      }
    },
    counts: { skipped: 0 },
    recommendations: {
      62: {
        className: 'Mage',
        specName: 'Arcane',
        role: 'DPS',
        mplus: {
          encounters: {
            12993: {
              className: 'Mage',
              specName: 'Arcane',
              mode: 'mplus',
              dungeonId: 12993,
              dungeonName: 'Altar of Fangs',
              importString: TEST_IMPORT_STRING
            }
          }
        },
        raid: { encounters: {} }
      }
    },
    skipped: []
  };
}

function quoteLua(value) {
  return JSON.stringify(String(value));
}

function bootstrapSource({ data, clientInterface }) {
  return `
TEST = {
  interface = ${Number(clientInterface)},
  messages = {},
  timers = {},
  frames = {}
}
QuickWoWTalentsData = ${toLua(data)}
QuickWoWTalentsDB = nil
SlashCmdList = {}
UIParent = {}
ChatFontNormal = {}
GameFontNormalLarge = {}
GameFontHighlightSmall = {}
GameFontNormalSmall = {}
GameFontHighlight = {}
GameFontDisableSmall = {}

DEFAULT_CHAT_FRAME = {
  AddMessage = function(_, message)
    table.insert(TEST.messages, tostring(message))
  end
}

function GetBuildInfo()
  return "12.1.0", "99999", "Aug 25 2026", TEST.interface
end

function InCombatLockdown()
  return false
end

function strtrim(value)
  return tostring(value):match("^%s*(.-)%s*$")
end

C_SpecializationInfo = {
  GetSpecialization = function() return 1 end,
  GetSpecializationInfo = function() return 62, "Arcane" end
}

C_ChallengeMode = {
  GetActiveChallengeMapID = function() return 588 end
}

function IsInInstance()
  return true, "party"
end

function GetInstanceInfo()
  return nil, nil, nil, nil, nil, nil, nil, 2993
end

C_Timer = {
  After = function(_, callback)
    table.insert(TEST.timers, callback)
  end
}

local function NewWidget(frameType, name, template)
  local widget = {
    frameType = frameType,
    name = name,
    template = template,
    scripts = {},
    shown = false,
    text = ""
  }
  function widget:SetSize(...) end
  function widget:SetPoint(...) end
  function widget:SetFrameStrata(...) end
  function widget:SetMovable(...) end
  function widget:EnableMouse(...) end
  function widget:RegisterForDrag(...) end
  function widget:SetBackdrop(...) end
  function widget:RegisterEvent(...) end
  function widget:SetAutoFocus(...) end
  function widget:SetFontObject(...) end
  function widget:SetJustifyH(...) end
  function widget:SetFocus() self.focused = true end
  function widget:ClearFocus() self.focused = false end
  function widget:SetCursorPosition(position) self.cursor = position end
  function widget:HighlightText(first, last) self.highlightFirst = first; self.highlightLast = last end
  function widget:SetText(value)
    self.text = tostring(value or "")
    if self.text == "Copy" then TEST.copyButton = self end
    if self.text:match("^Press Copy") then TEST.hint = self end
  end
  function widget:GetText() return self.text end
  function widget:SetScript(scriptName, callback)
    self.scripts[scriptName] = callback
    if scriptName == "OnEvent" then TEST.eventFrame = self end
  end
  function widget:Hide()
    self.shown = false
    if self.scripts.OnHide then self.scripts.OnHide(self) end
  end
  function widget:Show() self.shown = true end
  function widget:IsShown() return self.shown end
  function widget:StartMoving() end
  function widget:StopMovingOrSizing() end
  function widget:CreateFontString(...)
    local child = NewWidget("FontString", nil, nil)
    table.insert(TEST.frames, child)
    return child
  end
  table.insert(TEST.frames, widget)
  return widget
end

function CreateFrame(frameType, name, parent, template)
  local widget = NewWidget(frameType, name, template)
  if name == "QuickWoWTalentsFrame" then TEST.mainFrame = widget end
  if template == "InputBoxTemplate" then TEST.importBox = widget end
  return widget
end

function UIDropDownMenu_SetText(widget, text) widget.dropdownText = text end
function UIDropDownMenu_SetWidth(...) end
function UIDropDownMenu_Initialize(widget, callback) widget.dropdownInitializer = callback end
function UIDropDownMenu_CreateInfo() return {} end
function UIDropDownMenu_AddButton(...) end

function TEST.RunTimers()
  while #TEST.timers > 0 do
    local timers = TEST.timers
    TEST.timers = {}
    for _, callback in ipairs(timers) do callback() end
  end
end
`;
}

export async function createAddonHarness({
  data = makeRuntimeData(),
  clientInterface = 120100
} = {}) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);

  function assertLuaOk(status, label) {
    if (status === lua.LUA_OK) return;
    const message = lua.lua_tojsstring(state, -1);
    lua.lua_pop(state, 1);
    throw new Error(`${label}: ${message}`);
  }

  const source = `${bootstrapSource({ data, clientInterface })}\n${addonSource}`;
  assertLuaOk(lauxlib.luaL_loadstring(state, to_luastring(source)), 'load addon Lua');
  lua.lua_pushstring(state, to_luastring('QuickWoWTalents'));
  assertLuaOk(lua.lua_pcall(state, 1, 0, 0), 'execute addon Lua');

  function run(code) {
    assertLuaOk(lauxlib.luaL_loadstring(state, to_luastring(code)), 'load harness command');
    assertLuaOk(lua.lua_pcall(state, 0, 0, 0), 'execute harness command');
  }

  function evaluate(code, convert) {
    assertLuaOk(lauxlib.luaL_loadstring(state, to_luastring(`return ${code}`)), 'load harness expression');
    assertLuaOk(lua.lua_pcall(state, 0, 1, 0), 'execute harness expression');
    const value = convert(state, -1);
    lua.lua_pop(state, 1);
    return value;
  }

  return {
    run,
    string(expression) {
      return evaluate(expression, (L, index) => lua.lua_tojsstring(L, index));
    },
    number(expression) {
      return evaluate(expression, (L, index) => lua.lua_tonumber(L, index));
    },
    boolean(expression) {
      return evaluate(expression, (L, index) => lua.lua_toboolean(L, index));
    },
    slash(message = '') {
      run(`SlashCmdList.QUICKWOWTALENTS(${quoteLua(message)})`);
    },
    fire(event, argument = null) {
      const value = argument == null ? 'nil' : quoteLua(argument);
      run(`TEST.eventFrame.scripts.OnEvent(TEST.eventFrame, ${quoteLua(event)}, ${value})`);
    },
    runTimers() {
      run('TEST.RunTimers()');
    },
    clickCopy() {
      run('TEST.copyButton.scripts.OnClick(TEST.copyButton)');
    },
    updateData({ schemaVersion, clientInterface: dataInterface } = {}) {
      if (schemaVersion !== undefined) run(`QuickWoWTalentsData.schemaVersion = ${Number(schemaVersion)}`);
      if (dataInterface !== undefined) run(`QuickWoWTalentsData.clientInterface = ${Number(dataInterface)}`);
    },
    messages() {
      const count = evaluate('#TEST.messages', (L, index) => lua.lua_tointeger(L, index));
      return Array.from({ length: count }, (_, index) => (
        evaluate(`TEST.messages[${index + 1}]`, (L, stackIndex) => lua.lua_tojsstring(L, stackIndex))
      ));
    }
  };
}
