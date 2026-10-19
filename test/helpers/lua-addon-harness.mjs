import fs from 'node:fs/promises';

import fengari from 'fengari';

import { toLua } from '../../scripts/build-data.mjs';

const { lua, lauxlib, lualib, to_luastring } = fengari;
const addonSource = await fs.readFile(new URL('../../QuickWoWTalents.lua', import.meta.url), 'utf8');

export const UPDATE_REQUIRED_MESSAGE = 'Update required: install the latest Quick WoW Talents.';
export const TEST_IMPORT_STRING = 'TEST_IMPORT_STRING';

export function makeRuntimeData({
  schemaVersion = 3,
  clientInterface = 120105,
  catalogWowBuild = '12.1.5.99999'
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

function bootstrapSource({ data, clientInterface, ellesmere }) {
  return `
TEST = {
  interface = ${Number(clientInterface)},
  messages = {},
  timers = {},
  frames = {},
  skinRegistrations = {},
  skinCalls = {},
  now = 100,
  secretValues = {},
  ellesmere = ${quoteLua(ellesmere)}
}
QuickWoWTalentsData = ${toLua(data)}
QuickWoWTalentsDB = nil
SlashCmdList = {}
unpack = table.unpack
UIParent = {}
ChatFontNormal = {}
GameFontNormalLarge = {}
GameFontNormal = {}
GameFontHighlightSmall = {}
GameFontNormalSmall = {}
GameFontHighlight = {}
GameFontDisableSmall = {}
STANDARD_TEXT_FONT = "Fonts\\\\FRIZQT__.TTF"
UNIT_NAME_FONT = "Fonts\\\\ARIALN.TTF"
RAID_CLASS_COLORS = { MAGE = { r = 0.25, g = 0.78, b = 0.92 } }

function UnitClass() return "Mage", "MAGE", 8 end
function GetSpecialization() return 1 end
function GetSpecializationInfo() return 62, "Arcane", nil, 135932 end
function GetTime() return TEST.now end
function issecretvalue(value) return TEST.secretValues[value] == true end
function UnitCastingInfo(unit)
  if unit ~= "player" or not TEST.cast then return nil end
  local cast = TEST.cast
  return cast.name or "Changing Talents", cast.name or "Changing Talents", cast.texture or 135932,
    cast.startMS, cast.endMS, false, cast.castID or "Cast-Test-1", false, cast.spellID or 384255
end
function UnitChannelInfo(unit)
  if unit ~= "player" or not TEST.channel then return nil end
  local cast = TEST.channel
  return cast.name or "Changing Talents", cast.name or "Changing Talents", cast.texture or 135932,
    cast.startMS, cast.endMS, false, false, cast.spellID or 384255, false
end

DEFAULT_CHAT_FRAME = {
  AddMessage = function(_, message)
    table.insert(TEST.messages, tostring(message))
  end
}

function GetBuildInfo()
  return "12.1.5", "99999", "Oct 13 2026", TEST.interface
end

function InCombatLockdown()
  return false
end

function strtrim(value)
  return tostring(value):match("^%s*(.-)%s*$")
end

C_SpecializationInfo = {
  GetSpecialization = function() return 1 end,
  GetSpecializationInfo = function() return 62, "Arcane", nil, 135932 end
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
    shown = true,
    enabled = true,
    text = "",
    points = {},
    regions = {},
    children = {},
    width = 0,
    height = 0,
    alpha = 1,
    frameLevel = 1,
    events = {},
    id = #TEST.frames + 1
  }
  function widget:GetName() return self.name end
  function widget:GetParent() return self.parent end
  function widget:IsObjectType(value) return self.frameType == value end
  function widget:IsForbidden() return false end
  function widget:SetSize(width, height) self.width = width; self.height = height end
  function widget:SetWidth(width) self.width = width end
  function widget:SetHeight(height) self.height = height end
  function widget:GetWidth() return self.width end
  function widget:GetHeight() return self.height end
  function widget:GetSize() return self.width, self.height end
  function widget:GetEffectiveScale() return 1 end
  function widget:SetEnabled(enabled)
    local changed = self.enabled ~= (enabled == true)
    self.enabled = enabled == true
    local callback = self.scripts[self.enabled and "OnEnable" or "OnDisable"]
    if changed and callback then callback(self) end
  end
  function widget:Enable() self:SetEnabled(true) end
  function widget:Disable() self:SetEnabled(false) end
  function widget:IsEnabled() return self.enabled end
  function widget:SetChecked(checked) self.checked = checked == true end
  function widget:GetChecked() return self.checked == true end
  function widget:SetPoint(...) table.insert(self.points, { ... }) end
  function widget:ClearAllPoints() self.points = {}; self.allPoints = nil end
  function widget:SetAllPoints(target) self.allPoints = target or self.parent end
  function widget:SetFrameStrata(value) self.frameStrata = value end
  function widget:SetFrameLevel(value) self.frameLevel = value end
  function widget:GetFrameLevel() return self.frameLevel end
  function widget:SetAlpha(value) self.alpha = value end
  function widget:GetAlpha() return self.alpha end
  function widget:SetMovable(...) end
  function widget:EnableMouse(value) self.mouseEnabled = value end
  function widget:EnableMouseWheel(value) self.mouseWheelEnabled = value end
  function widget:EnableKeyboard(value) self.keyboardEnabled = value end
  function widget:SetPropagateKeyboardInput(value) self.propagateKeyboardInput = value end
  function widget:SetClampedToScreen(value) self.clampedToScreen = value end
  function widget:IsMouseOver() return self.mouseOver == true end
  function widget:RegisterForDrag(...) end
  function widget:SetBackdrop(value) self.backdrop = value end
  function widget:SetBackdropColor(...) self.backdropColor = { ... } end
  function widget:SetBackdropBorderColor(...) self.backdropBorderColor = { ... } end
  function widget:RegisterEvent(event) self.events[event] = true end
  function widget:RegisterUnitEvent(event, ...) self.events[event] = { ... } end
  function widget:UnregisterEvent(event) self.events[event] = nil end
  function widget:IsEventRegistered(event) return self.events[event] ~= nil end
  function widget:SetMinMaxValues(minimum, maximum) self.minimum = minimum; self.maximum = maximum end
  function widget:GetMinMaxValues() return self.minimum, self.maximum end
  function widget:SetValue(value) self.value = value end
  function widget:GetValue() return self.value end
  function widget:SetStatusBarTexture(texture) self.statusBarTexture = texture end
  function widget:SetStatusBarColor(...) self.statusBarColor = { ... } end
  function widget:SetOrientation(value) self.orientation = value end
  function widget:SetReverseFill(value) self.reverseFill = value end
  function widget:SetAutoFocus(...) end
  function widget:SetFontObject(value) self.fontObject = value end
  function widget:SetFont(path, size, flags) self.font = { path, size, flags or "" }; return true end
  function widget:GetFont() return table.unpack(self.font or { STANDARD_TEXT_FONT, 14, "" }) end
  function widget:SetShadowOffset(...) self.shadowOffset = { ... } end
  function widget:SetShadowColor(...) self.shadowColor = { ... } end
  function widget:SetJustifyH(value) self.justifyH = value end
  function widget:SetJustifyV(value) self.justifyV = value end
  function widget:SetWordWrap(value) self.wordWrap = value end
  function widget:SetMaxLines(value) self.maxLines = value end
  function widget:SetTextInsets(...) self.textInsets = { ... } end
  function widget:SetFontString(value) self.fontString = value end
  function widget:GetFontString() return self.fontString end
  function widget:SetFocus() self.focused = true end
  function widget:ClearFocus() self.focused = false end
  function widget:SetCursorPosition(position) self.cursor = position end
  function widget:HighlightText(first, last) self.highlightFirst = first; self.highlightLast = last end
  function widget:SetTextColor(red, green, blue, alpha)
    self.textColor = { red = red, green = green, blue = blue, alpha = alpha }
    if self.isStatus or (self.name and self.name:match("Status$")) then TEST.hint = self end
  end
  function widget:SetText(value)
    self.text = tostring(value or "")
    if self.fontString then self.fontString:SetText(value) end
    if self.text == "Add and apply this build, replacing any pending talent edits." then
      self.isStatus = true
      TEST.hint = self
    end
  end
  function widget:GetText() return self.text end
  function widget:SetScript(scriptName, callback)
    self.scripts[scriptName] = callback
    if scriptName == "OnEvent" and not self.name then TEST.eventFrame = self end
  end
  function widget:HookScript(scriptName, callback)
    local previous = self.scripts[scriptName]
    self.scripts[scriptName] = function(...)
      if previous then previous(...) end
      callback(...)
    end
  end
  function widget:Hide()
    self.shown = false
    if self.scripts.OnHide then self.scripts.OnHide(self) end
  end
  function widget:Show()
    local changed = not self.shown
    self.shown = true
    if changed and self.scripts.OnShow then self.scripts.OnShow(self) end
  end
  function widget:IsShown() return self.shown end
  function widget:IsVisible() return self.shown and (not self.parent or not self.parent.IsVisible or self.parent:IsVisible()) end
  function widget:StartMoving() end
  function widget:StopMovingOrSizing() end
  function widget:CreateFontString(childName, layer, childTemplate)
    local child = NewWidget("FontString", childName, childTemplate)
    child.parent = self
    child.layer = layer
    table.insert(self.regions, child)
    if childName then _G[childName] = child end
    if childName and childName:match("Status$") then child.isStatus = true; TEST.hint = child end
    return child
  end
  function widget:CreateTexture(childName, layer, childTemplate, subLevel)
    local child = NewWidget("Texture", childName, childTemplate)
    child.parent = self
    child.layer = layer
    child.subLevel = subLevel
    table.insert(self.regions, child)
    if childName then _G[childName] = child end
    return child
  end
  function widget:GetRegions() return table.unpack(self.regions) end
  function widget:GetChildren() return table.unpack(self.children) end
  function widget:SetColorTexture(...) self.colorTexture = { ... } end
  function widget:SetTexture(value) self.texture = value; return true end
  function widget:GetTexture() return self.texture end
  function widget:SetVertexColor(...) self.vertexColor = { ... } end
  function widget:SetTexCoord(...) self.texCoord = { ... } end
  function widget:SetRotation(value) self.rotation = value end
  function widget:SetAtlas(value) self.atlas = value end
  function widget:SetBlendMode(value) self.blendMode = value end
  function widget:SetDrawLayer(layer, subLevel) self.layer = layer; self.subLevel = subLevel end
  for _, kind in ipairs({ "Normal", "Pushed", "Highlight", "Disabled", "Checked", "DisabledChecked" }) do
    widget["Set" .. kind .. "Texture"] = function(self, value)
      if type(value) == "string" or type(value) == "number" then
        local texture = self[kind .. "Texture"] or self:CreateTexture(nil, "ARTWORK")
        texture:SetTexture(value)
        self[kind .. "Texture"] = texture
      else self[kind .. "Texture"] = value end
    end
    widget["Get" .. kind .. "Texture"] = function(self) return self[kind .. "Texture"] end
  end
  table.insert(TEST.frames, widget)
  return widget
end

function CreateFrame(frameType, name, parent, template)
  local widget = NewWidget(frameType, name, template)
  widget.parent = parent
  if parent and parent.children then table.insert(parent.children, widget) end
  if name then _G[name] = widget end
  if name == "QuickWoWTalentsFrame" then TEST.mainFrame = widget end
  if (name and name:match("ImportBox$")) or template == "InputBoxTemplate" then TEST.importBox = widget end
  if (name and name:match("CopyButton$")) or template == "UIPanelButtonTemplate" then TEST.copyButton = widget end
  if name and name:match("ImportButton$") then TEST.importButton = widget end
  if name and name:match("CopyPanel$") then TEST.copyPanel = widget end
  return widget
end

for _, name in ipairs({ "UIDropDownMenu_SetText", "UIDropDownMenu_SetWidth", "UIDropDownMenu_Initialize",
  "UIDropDownMenu_CreateInfo", "UIDropDownMenu_AddButton", "ToggleDropDownMenu" }) do
  _G[name] = function() error("QWT selectors must not use Blizzard menu globals: " .. name) end
end

if TEST.ellesmere ~= "absent" then
  EllesmereUI = {
    RegisterSkin = function(name, callback)
      if TEST.ellesmere == "throw-register" then error("Mock skin registration failure") end
      if TEST.skinRegistrations[name] then return end
      TEST.skinRegistrations[name] = callback
      if TEST.ellesmere == "disabled" then return true end
      local skin = { apiVersion = 3 }
      for _, method in ipairs({ "Shell", "Panel", "Button", "StateButtonLabel", "WhiteButtonLabel", "Dropdown", "EditBox", "Checkbox", "CloseButton", "Font" }) do
        skin[method] = function(target, options)
          table.insert(TEST.skinCalls, { registration = name, method = method, target = target, options = options })
          if TEST.ellesmere == "throw-skin" then error("Mock skin primitive failure") end
        end
      end
      skin.GetFont = function() return "MockEllesmereFont.ttf", "" end
      skin.GetAccentColor = function() return 12/255, 210/255, 157/255 end
      skin.GetPanelColor = function() return 0.069, 0.058, 0.047, 1 end
      skin.OnLooksChanged = function(fn) TEST.looksChanged = fn end
      skin.IsEnabled = function() return true end
      callback(skin)
      return true
    end
  }
end

function TEST.RunTimers()
  while #TEST.timers > 0 do
    local timers = TEST.timers
    TEST.timers = {}
    for _, callback in ipairs(timers) do callback() end
  end
end

function TEST.Fire(event, ...)
  local unit = select(1, ...)
  for _, widget in ipairs(TEST.frames) do
    local registration = widget.events[event]
    local acceptsUnit = type(registration) ~= "table"
    if type(registration) == "table" then
      for _, registeredUnit in ipairs(registration) do
        if unit == registeredUnit then acceptsUnit = true; break end
      end
    end
    if registration and acceptsUnit and widget.scripts.OnEvent then
      widget.scripts.OnEvent(widget, event, ...)
    end
  end
end
`;
}

export async function createAddonHarness({
  data = makeRuntimeData(),
  clientInterface = 120105,
  addonName = 'QuickWoWTalents',
  namespaceSource = '{}',
  loadImportModules = false,
  loadPreferences = false,
  ellesmere = 'absent',
  beforeAddonSource = ''
} = {}) {
  const moduleSources = loadImportModules ? await Promise.all([
    fs.readFile(new URL('../../QuickWoWTalentsTalentCodec.lua', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../QuickWoWTalentsTalentImport.lua', import.meta.url), 'utf8')
  ]) : [];
  if (loadPreferences) moduleSources.push(await fs.readFile(new URL('../../QuickWoWTalentsPreferences.lua', import.meta.url), 'utf8'));
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);

  function assertLuaOk(status, label) {
    if (status === lua.LUA_OK) return;
    const message = lua.lua_tojsstring(state, -1);
    lua.lua_pop(state, 1);
    throw new Error(`${label}: ${message}`);
  }

  const source = `${bootstrapSource({ data, clientInterface, ellesmere })}\n${beforeAddonSource}\n`;
  assertLuaOk(lauxlib.luaL_loadstring(state, to_luastring(source)), 'load addon Lua');
  assertLuaOk(lua.lua_pcall(state, 0, 0, 0), 'execute addon bootstrap');

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

  function plainValue(L, index) {
    const type = lua.lua_type(L, index);
    if (type === lua.LUA_TNIL) return null;
    if (type === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, index);
    if (type === lua.LUA_TNUMBER) return lua.lua_tonumber(L, index);
    if (type === lua.LUA_TSTRING) return lua.lua_tojsstring(L, index);
    if (type !== lua.LUA_TTABLE) return undefined;
    const absoluteIndex = lua.lua_absindex(L, index);
    const result = {};
    lua.lua_pushnil(L);
    while (lua.lua_next(L, absoluteIndex) !== 0) {
      const key = lua.lua_type(L, -2) === lua.LUA_TNUMBER
        ? lua.lua_tonumber(L, -2)
        : lua.lua_tojsstring(L, -2);
      result[key] = plainValue(L, -1);
      lua.lua_pop(L, 1);
    }
    const keys = Object.keys(result);
    if (keys.length > 0 && keys.every((key, position) => Number(key) === position + 1)) {
      return keys.map((key) => result[key]);
    }
    return result;
  }

  function loadAddon(name, { data: bundle = data, namespaceSource: namespace = '{}' } = {}) {
    run(`_G[${quoteLua(`${name}Data`)}] = ${toLua(bundle)}\nTEST.namespace = ${namespace}\nTEST.namespaces = TEST.namespaces or {}\nTEST.namespaces[${quoteLua(name)}] = TEST.namespace;`);
    for (const moduleSource of [...moduleSources, addonSource]) {
      run(`(function(...)\n${moduleSource}\nend)(${quoteLua(name)}, TEST.namespace)`);
    }
  }
  loadAddon(addonName, { namespaceSource });

  return {
    run,
    loadAddon,
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
      run(`SlashCmdList[${quoteLua(addonName.toUpperCase())}](${quoteLua(message)})`);
    },
    fire(event, ...args) {
      const values = [quoteLua(event), ...args.map((value) => value == null ? 'nil' : toLua(value))];
      run(`TEST.Fire(${values.join(', ')})`);
    },
    update(elapsed = 0.1) {
      run(`for _, widget in ipairs(TEST.frames) do if widget:IsVisible() and widget.scripts.OnUpdate then widget.scripts.OnUpdate(widget, ${Number(elapsed)}) end end`);
    },
    runTimers() {
      run('TEST.RunTimers()');
    },
    clickCopy() {
      run('TEST.copyButton.scripts.OnClick(TEST.copyButton)');
    },
    clickImport() {
      run(`local button = _G[${quoteLua(`${addonName}ImportButton`)}]; if button then button.scripts.OnClick(button) else for _, widget in ipairs(TEST.frames) do if widget.text == "Add & Use Build" and widget.parent == _G[${quoteLua(`${addonName}Frame`)}] then widget.scripts.OnClick(widget); break end end end`);
    },
    clickAutoOpen(enabled) {
      run(`local checkbox = _G[${quoteLua(`${addonName}AutoOpenCheckbox`)}]; checkbox:SetChecked(${enabled ? 'true' : 'false'}); checkbox.scripts.OnClick(checkbox)`);
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
    },
    layout() {
      return evaluate(`(function()
        local result = {}
        for _, widget in ipairs(TEST.frames) do
          local points = {}
          for _, point in ipairs(widget.points) do
            local copy = {}
            for index, value in ipairs(point) do
              copy[index] = type(value) == "table" and { id = value.id, name = value.name } or value
            end
            table.insert(points, copy)
          end
          table.insert(result, {
            id = widget.id, name = widget.name, type = widget.frameType,
            parentId = widget.parent and widget.parent.id,
            parentName = widget.parent and widget.parent.name,
            template = widget.template, width = widget.width, height = widget.height,
            points = points, allPoints = widget.allPoints and widget.allPoints.id,
            shown = widget.shown, visible = widget:IsVisible(), enabled = widget.enabled,
            frameLevel = widget.frameLevel, frameStrata = widget.frameStrata,
            text = widget.text, dropdownText = widget.dropdownText,
            font = widget.font, textColor = widget.textColor,
            justifyH = widget.justifyH, justifyV = widget.justifyV,
            wordWrap = widget.wordWrap, textInsets = widget.textInsets,
            checked = widget.checked, focused = widget.focused,
            alpha = widget.alpha, layer = widget.layer, subLevel = widget.subLevel,
            texture = widget.texture, colorTexture = widget.colorTexture,
            vertexColor = widget.vertexColor, texCoord = widget.texCoord,
            rotation = widget.rotation, atlas = widget.atlas,
            backdrop = widget.backdrop, backdropColor = widget.backdropColor,
            backdropBorderColor = widget.backdropBorderColor,
            minimum = widget.minimum, maximum = widget.maximum, value = widget.value,
            statusBarTexture = widget.statusBarTexture, statusBarColor = widget.statusBarColor,
            orientation = widget.orientation, reverseFill = widget.reverseFill
          })
        end
        return result
      end)()`, plainValue);
    }
  };
}
