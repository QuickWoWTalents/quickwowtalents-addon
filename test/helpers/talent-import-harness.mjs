import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';

const source = readFileSync(new URL('../../QuickWoWTalentsTalentImport.lua', import.meta.url), 'utf8');

const prelude = String.raw`
NS = { Identity = {loadoutPrefix = "QWT-", legacyLoadoutName = "QWT", managedLoadoutPrefixes = {"QWT-", "QWTTest-"},
  dbGlobal = "QuickWoWTalentsDB", slash = "/qwt"} }
QuickWoWTalentsDB = {autoOpenEnabled = false}
S = {spec = 262, active = 1, selected = 10, combat = false, editable = true, capacity = true,
  configs = {
    [1] = {ID = 1, name = "Base", type = 1, spec = 262},
    [10] = {ID = 10, name = "QWT-Altar of Fangs", type = 1, spec = 262},
    [11] = {ID = 11, name = "Personal", type = 1, spec = 262},
    [12] = {ID = 12, name = "QWT Personal", type = 1, spec = 262},
    [13] = {ID = 13, name = "My QWTTest-Other", type = 1, spec = 262},
    [14] = {ID = 14, name = "Other spec personal", type = 1, spec = 263}
  },
  populated = {}, valid = {}, staged = {}, timers = {}, calls = {}, statuses = {}, depth = 0,
  loadResult = 2, nextID = 20, allowedDeletes = {[10] = true}, deleteCounts = {}, cachedConfigs = {}
}
for _, info in pairs(S.configs) do info.usesSharedActionBars = false end
Enum = {TraitConfigType = {Combat = 1}, LoadConfigResult = {Error = 0, NoChangesNecessary = 1, LoadInProgress = 2, Ready = 3}}
function GetSpecialization() return S.spec == 262 and 1 or 2 end
function GetNumSpecializations() return 2 end
function GetSpecializationInfo(index) return index == 1 and 262 or 263 end
function InCombatLockdown() return S.combat end
PlayerSpellsFrame = {
  IsShown = function() return S.spellsShown == true end,
  SpecFrame = {},
  TalentsFrame = { IsShown = function() return S.talentsShown == true end,
    variablesLoaded = true, configurationInfo = {ID = 1}, talentTreeID = 5,
    configIDs = {}, configIDToName = {} }
}
local nativeFrame = PlayerSpellsFrame
local nativeTalents = nativeFrame.TalentsFrame
S.nativeEvents = {}
S.nativeRegistrationCalls = {}
function nativeTalents:IsVisible()
  if S.nativeVisibilityThrows then error("native visibility unavailable") end
  return S.spellsShown == true and S.talentsShown == true
end
function nativeTalents:IsEventRegistered(event)
  if S.nativeEventCheckThrows then error("native event state unavailable") end
  return S.nativeEvents[event] == true
end
function nativeTalents:RegisterEvent(event)
  if S.nativeRegisterThrows then error("native registration unavailable") end
  assert(event == "TRAIT_CONFIG_DELETED", "addon registered an unrelated native event")
  table.insert(S.nativeRegistrationCalls, {event = event, registered = true})
  S.nativeEvents[event] = true
end
function nativeTalents:UnregisterEvent(event)
  if S.nativeUnregisterThrows then error("native unregistration unavailable") end
  assert(event == "TRAIT_CONFIG_DELETED", "addon unregistered an unrelated native event")
  table.insert(S.nativeRegistrationCalls, {event = event, registered = false})
  S.nativeEvents[event] = nil
end
function nativeTalents:RefreshLoadoutOptions()
  S.directNativeCalls = (S.directNativeCalls or 0) + 1
  error("addon invoked native refresh instead of allowing the genuine event handler")
end
function nativeTalents:OnEvent()
  S.directNativeCalls = (S.directNativeCalls or 0) + 1
  error("addon fabricated a native event")
end
function nativeTalents:OnTraitConfigDeleted()
  S.directNativeCalls = (S.directNativeCalls or 0) + 1
  error("addon invoked the native deletion handler")
end
C_AddOns = {LoadAddOn = function(name)
  assert(name == "Blizzard_PlayerSpells")
  if S.uiLoadFails then return false end
  PlayerSpellsFrame = nativeFrame
  RefreshNative()
  if S.uiLoadHook then S.uiLoadHook() end
  return true
end}
function RefreshNative()
  if S.nativeStale or not PlayerSpellsFrame then return end
  local talents = PlayerSpellsFrame.TalentsFrame
  talents.configIDs = C_ClassTalents.GetConfigIDsBySpecID(S.spec)
  talents.configIDToName = {}
  for _, id in ipairs(talents.configIDs) do talents.configIDToName[id] = S.configs[id].name end
end
function NativeSelected()
  local id = S.nativePending
  S.nativePending = nil
  if not id then return end
  table.insert(S.calls, {kind = "select", id = id}) -- native bookkeeping, never an addon mutation
  if not S.selectReject then S.selected = id end
  Emit("SELECTED_LOADOUT_CHANGED")
end
-- Explicitly enabled by visibility tests. This models Blizzard's own CREATED
-- listener, which can begin/finish activation before or after addon listeners.
function NativeCompleteImport(keepMarkers, omitEvents)
  local id = S.nativeAutoTarget
  assert(id and S.configs[id], "no native import activation pending")
  S.valid[S.active] = S.valid[id]
  S.staged[S.active] = false
  if not keepMarkers then
    PlayerSpellsFrame.TalentsFrame.commitedConfigID = nil
    PlayerSpellsFrame.TalentsFrame.autoLoadNewConfigID = nil
    S.nativeAutoTarget = nil
  end
  table.insert(S.calls, {kind = "native-select", id = id})
  S.selected = id
  if not omitEvents then
    if S.nativeUpdatedFirst then Emit("TRAIT_CONFIG_UPDATED", S.active) end
    Emit("SELECTED_LOADOUT_CHANGED")
    if not S.nativeUpdatedFirst then Emit("TRAIT_CONFIG_UPDATED", S.active) end
  end
end
function NativeImportCreated(info)
  if not (S.nativeAutoApply and S.spellsShown and S.talentsShown) then return end
  if type(info) ~= "table" or not info.ID or info.type ~= Enum.TraitConfigType.Combat then return end
  if S.nativeAutoSeen and S.nativeAutoSeen[info.ID] then return end
  S.nativeAutoSeen = S.nativeAutoSeen or {}; S.nativeAutoSeen[info.ID] = true
  RefreshNative()
  S.nativeAutoTarget = info.ID
  table.insert(S.calls, {kind = "native-auto-load", id = info.ID})
  if not S.populated[info.ID] or S.nativeWaitPopulation then
    PlayerSpellsFrame.TalentsFrame.autoLoadNewConfigID = info.ID
  else
    PlayerSpellsFrame.TalentsFrame.commitedConfigID = info.ID
  end
  if not S.nativeAutoDelayed and not S.nativeWaitPopulation and S.populated[info.ID] then
    NativeCompleteImport(S.nativeKeepMarkers)
  end
end
EventRegistry = {
  callbacks = {},
  RegisterCallback = function(self, event, callback, owner)
    if S.registryRegisterThrows then error("callback registration unavailable") end
    self.callbacks[event] = self.callbacks[event] or {}
    self.callbacks[event][owner] = callback
  end,
  UnregisterCallback = function(self, event, owner)
    if S.registryUnregisterThrows then error("callback unregistration unavailable") end
    if self.callbacks[event] then self.callbacks[event][owner] = nil end
  end,
  TriggerEvent = function(self, event, ...)
    local callbacks = {}; for owner, callback in pairs(self.callbacks[event] or {}) do callbacks[owner] = callback end
    for owner, callback in pairs(callbacks) do callback(owner, ...) end
  end
}
function CallbackCount(event)
  local count = 0; for _ in pairs(EventRegistry.callbacks[event] or {}) do count = count + 1 end
  return count
end
function SetNativeVisibility(shown)
  S.spellsShown, S.talentsShown = shown, shown
  -- Native OnShow registers the event. OnHide unregisters it before sending its
  -- public Hide callback. This native action is not an addon registration call.
  S.nativeEvents.TRAIT_CONFIG_DELETED = shown and true or nil
  EventRegistry:TriggerEvent("PlayerSpellsFrame.TalentTab." .. (shown and "Show" or "Hide"))
end
function NativeDeleted()
  if S.nativeEvents.TRAIT_CONFIG_DELETED then
    S.nativeDeleteRefreshes = (S.nativeDeleteRefreshes or 0) + 1
    RefreshNative()
  end
end
function CreateFrame()
  local frame = {events = {}}
  function frame:RegisterEvent(event) self.events[event] = true end
  function frame:SetScript(kind, callback) self.callback = callback end
  S.frame = frame
  S.frames = S.frames or {}; table.insert(S.frames, frame)
  return frame
end
C_Timer = { After = function(delay, callback) table.insert(S.timers, {delay = delay, callback = callback}) end }
function Emit(event, arg)
  if event == "TRAIT_CONFIG_CREATED" and S.nativeCreatedOrder ~= "after" then NativeImportCreated(arg) end
  if event == "TRAIT_CONFIG_DELETED" and S.nativeDeletedOrder ~= "after" then NativeDeleted() end
  if event == "SELECTED_LOADOUT_CHANGED" and S.nativePending
    and S.selected ~= S.nativeInitialSelection and S.selected ~= S.nativePending then S.nativePending = nil end
  if event == "TRAIT_CONFIG_UPDATED" or event == "TRAIT_CONFIG_LIST_UPDATED" then RefreshNative() end
  if event == "TRAIT_CONFIG_UPDATED" and arg == S.active and S.valid[S.active] and not S.staged[S.active] then NativeSelected() end
  for _, frame in ipairs(S.frames or {}) do
    if frame.events[event] then frame.callback(frame, event, arg) end
  end
  if event == "TRAIT_CONFIG_CREATED" and S.nativeCreatedOrder == "after" then NativeImportCreated(arg) end
  if event == "TRAIT_CONFIG_DELETED" and S.nativeDeletedOrder == "after" then NativeDeleted() end
end
function Step()
  for i, timer in ipairs(S.timers) do
    if timer.delay == 0 then table.remove(S.timers, i); timer.callback(); return true end
  end
  return false
end
function Flush()
  local count = 0
  while Step() do count = count + 1; assert(count < 100, "unexpected repeated work") end
end
function Timeout()
  local timers = S.timers
  S.timers = {}
  for _, timer in ipairs(timers) do if timer.delay > 0 then timer.callback() end end
  Flush()
end
function Poll()
  for i, timer in ipairs(S.timers) do
    if timer.delay > 0 and timer.delay < 30 then
      table.remove(S.timers, i); timer.callback(); Flush(); return true
    end
  end
  return false
end
function Record(kind, id)
  assert(S.depth == 0, "reentrant mutation: " .. kind)
  assert(not S.combat, "mutation in combat")
  S.depth = S.depth + 1
  table.insert(S.calls, {kind = kind, id = id})
end
function Count(kind)
  local count = 0
  for _, call in ipairs(S.calls) do if call.kind == kind then count = count + 1 end end
  return count
end
function CreateImported(populated, id)
  id = id or S.nextID
  S.configs[id] = {ID = id, name = S.requestName or "QWT-Altar of Fangs", type = 1, spec = S.spec,
    usesSharedActionBars = S.createdShared == true}
  S.populated[id] = populated ~= false
  S.valid[id] = true
  Emit("TRAIT_CONFIG_CREATED", S.configs[id])
  RefreshNative()
  return id
end
function AddManaged(id, name, spec)
  S.configs[id] = {ID = id, name = name, type = 1, spec = spec or S.spec, usesSharedActionBars = false}
  S.allowedDeletes[id] = true
end
C_ClassTalents = {
  GetActiveConfigID = function() return S.active end,
  GetStarterBuildActive = function() return S.starter or false end,
  CanCreateNewConfig = function() return S.capacity end,
  CanEditTalents = function() return S.editable, S.editError end,
  GetConfigIDsBySpecID = function(spec)
    local ids = {}
    for id, info in pairs(S.configs) do if info.spec == spec and (id ~= 1 or S.includeBase) then table.insert(ids, id) end end
    table.sort(ids)
    return ids
  end,
  IsSavedConfig = function(id) return id ~= 1 and S.configs[id] ~= nil and not S.unsaved and not (S.unsavedIDs and S.unsavedIDs[id]) end,
  IsConfigPopulated = function(id) return S.populated[id] == true end,
  SetUsesSharedActionBars = function(id, shared)
    Record("bars", id)
    assert(id == (S.expectedLoadID or (S.reusing and 10 or S.nextID)) and shared == true)
    if not S.barsReject and not S.barsDelayed then S.configs[id].usesSharedActionBars = true end
    if S.barsHook then S.barsHook() end
    S.depth = S.depth - 1
    if S.barsThrows then error("blocked") end
  end,
  GetLastSelectedSavedConfigID = function() return S.selected end,
  ImportLoadout = function(id, entries, name, importString)
    Record("import", id)
    assert(id == 1 and name == (S.requestName or "QWT-Altar of Fangs") and importString == "VALID")
    assert(entries[1].nodeID == 101)
    if S.importHook then S.importHook() end
    S.depth = S.depth - 1
    if S.importThrows then error("blocked") end
    return not S.importReject
  end,
  SwitchToLoadoutByIndex = function(index)
    local id = PlayerSpellsFrame.TalentsFrame.configIDs[index]
    Record("load", id)
    assert(id == (S.expectedLoadID or (S.reusing and 10 or S.nextID)))
    if S.loadResult == 1 or S.loadResult == 2 then S.nativePending = id; S.nativeInitialSelection = S.selected end
    if S.loadHook then S.loadHook() end
    S.depth = S.depth - 1
    if S.loadThrows then error("blocked") end
    if S.loadResult == 1 then NativeSelected() end
  end,
  LoadConfig = function() error("addon bypassed native delegate") end,
  CommitConfig = function() error("addon bypassed native commit flow") end,
  CanChangeTalents = function() error("addon checked the current build instead of replacement availability") end,
  UpdateLastSelectedSavedConfigID = function() error("addon wrote native bookkeeping") end,
  DeleteConfig = function(id)
    Record("delete", id)
    S.deleteCounts[id] = (S.deleteCounts[id] or 0) + 1
    assert(S.deleteCounts[id] == 1, "retried deletion")
    assert(S.allowedDeletes[id], "deleted an unrelated loadout")
    assert(S.valid[S.active] and S.selected == (S.expectedLoadID or (S.reusing and 10 or S.nextID)), "deleted before apply")
    assert(id ~= S.selected and id ~= S.active, "deleted active/selected config")
    if S.deleteHook then S.deleteHook(id) end
    local reject, delayed, throws = S.deleteReject or S.rejectID == id, S.deleteDelayed or S.delayedID == id, S.deleteThrows or S.throwID == id
    if not reject and not delayed and not throws then
      if S.retainDeletedInfo then S.cachedConfigs[id] = S.configs[id] end
      S.configs[id] = nil
      if not S.omitDeleteEvent then Emit("TRAIT_CONFIG_DELETED", id) end
    end
    S.depth = S.depth - 1
    if throws then error("blocked") end
    return not reject
  end
}
C_Traits = {
  RollbackConfig = function() error("addon discarded edits outside native replacement") end,
  ResetTree = function() error("addon reset the current build outside native replacement") end,
  GetConfigInfo = function(id)
    local info = S.configs[id] or S.cachedConfigs[id]
    if not info or not S.hideSpec then return info end
    local copy = {}; for key, value in pairs(info) do if key ~= "spec" then copy[key] = value end end
    return copy
  end,
  ConfigHasStagedChanges = function(id) return S.staged[id] == true end
}
NS.TalentCodec = {
  Decode = function(text, spec, id)
    if S.decodeError then return nil, "invalid talents" end
    assert(text == "VALID" and spec == 262 and id == 1)
    return {{nodeID = 101, ranksGranted = 0, ranksPurchased = 1, selectionEntryID = 201}}, nil, {treeID = 5, specID = spec}
  end,
  Verify = function(id, entries, metadata)
    assert(entries[1].nodeID == 101 and metadata.specID == 262)
    return S.valid[id] == true, S.verifyReason or "mismatch"
  end
}
function Start()
  RefreshNative()
  return NS.TalentImport.Begin({importString = "VALID", specID = 262, name = S.requestName or "QWT-Altar of Fangs", onStatus = function(message, done, success)
    table.insert(S.statuses, {message = message, done = done, success = success})
    if S.statusHook then S.statusHook(message, done, success) end
  end})
end
function Applied()
  S.valid[1] = true
  S.staged[1] = false
  Emit("TRAIT_CONFIG_UPDATED", 1)
  Flush()
end
function AssertPreserved()
  assert(S.configs[10], "old loadout missing")
  for _, id in ipairs({11, 12, 13, 14}) do assert(S.configs[id], "unrelated loadout missing") end
  assert(Count("delete") == 0)
end
function AssertComplete()
  assert(not NS.TalentImport.IsBusy())
  assert(NS.TalentImport.GetStatus().success == true)
  assert(Count("import") == 1 and Count("load") == 1 and Count("select") == 1 and Count("delete") == 1)
  assert(not S.configs[10] and S.configs[20])
  for _, id in ipairs({11, 12, 13, 14}) do assert(S.configs[id], "unrelated loadout missing") end
end
function AssertNativeComplete()
  assert(not NS.TalentImport.IsBusy() and NS.TalentImport.GetStatus().success == true)
  assert(Count("import") == 1 and Count("native-auto-load") == 1 and Count("native-select") == 1)
  assert(Count("load") == 0 and Count("select") == 0 and Count("bars") == 1 and Count("delete") == 1)
  assert(not S.configs[10] and S.configs[20] and S.selected == 20)
  assert(S.configs[20].usesSharedActionBars == true and not S.staged[S.active])
  for _, id in ipairs({11, 12, 13, 14}) do assert(S.configs[id], "unrelated loadout missing") end
end
`;

export function runImportScenario(scenario, { addonName = 'QuickWoWTalents' } = {}) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const code = `${prelude}\nassert(load(${luaLiteral(source)}))(${luaLiteral(addonName)}, NS)\n${scenario}`;
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? null : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(result, lua.LUA_OK, error);
}

function luaLiteral(value) {
  return `[====[${value}]====]`;
}
