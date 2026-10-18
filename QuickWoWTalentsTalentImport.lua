local ADDON_NAME, NS = ...
local Import = {}
NS.TalentImport = Import

local TIMEOUT_SECONDS = 30
local SHARED_BARS_POLL_SECONDS = 0.1
local NATIVE_POLL_SECONDS = 0.1
local CLEANUP_POLL_SECONDS = 0.1
local operation
local eventFrame
local lastStatus = { phase = "idle", message = "No import attempted." }
local Evaluate

local function SafeText(value)
  if (issecretvalue and issecretvalue(value)) or type(value) ~= "string" then return nil end
  value = value:gsub("[%c|]", " "):sub(1, 160)
  -- Keep unexpected import/export strings out of user-facing API errors.
  value = value:gsub("[A-Za-z0-9+/]+", function(word)
    return #word >= 24 and "[redacted]" or word
  end)
  return value ~= "" and value or nil
end

local function CannotEditMessage(changeError)
  local reason = SafeText(changeError)
  return "Talents cannot be changed right now." .. (reason and (" " .. reason) or "")
end

local function CurrentSpecID()
  local getSpec = C_SpecializationInfo and C_SpecializationInfo.GetSpecialization or GetSpecialization
  local getInfo = C_SpecializationInfo and C_SpecializationInfo.GetSpecializationInfo or GetSpecializationInfo
  local index = getSpec()
  return index and getInfo(index)
end

local function Notify(op, message, done, success)
  lastStatus = { phase = op.phase, message = message, success = success,
    oldConfigID = op.oldID, newConfigID = op.newID, remainingCount = op.remainingCount }
  if type(op.onStatus) == "function" then
    pcall(op.onStatus, message, done, success)
  end
end

local NATIVE_DELETE_EVENT = "TRAIT_CONFIG_DELETED"
local NATIVE_HIDE_CALLBACK = "PlayerSpellsFrame.TalentTab.Hide"

local function KeepNativeDeleteListener(op)
  if operation ~= op or (op.phase ~= "cleanup" and op.phase ~= "deleting") then return end
  local frame = op.nativeDeleteFrame
  if not frame then return end
  pcall(function()
    if not frame:IsEventRegistered(NATIVE_DELETE_EVENT) then
      op.nativeDeleteRegistrationAdded = true
      frame:RegisterEvent(NATIVE_DELETE_EVENT)
    end
  end)
end

local function AcquireNativeDeleteListener(op)
  if not op.nativeDeleteFrame then
    local frame = PlayerSpellsFrame and PlayerSpellsFrame.TalentsFrame
    if not frame or type(frame.IsEventRegistered) ~= "function" or type(frame.RegisterEvent) ~= "function"
      or type(frame.UnregisterEvent) ~= "function" or type(frame.IsVisible) ~= "function" then return end
    op.nativeDeleteFrame = frame
    -- OnHide unregisters this event, then publishes TalentTab.Hide. Keep the
    -- genuine native handler listening if the window closes during cleanup.
    local registry = EventRegistry
    if registry and type(registry.RegisterCallback) == "function" and type(registry.UnregisterCallback) == "function" then
      op.nativeDeleteRegistry = registry
      pcall(registry.RegisterCallback, registry, NATIVE_HIDE_CALLBACK, function()
        KeepNativeDeleteListener(op)
      end, op)
    end
  end
  KeepNativeDeleteListener(op)
end

local function ReleaseNativeDeleteListener(op)
  local registry = op.nativeDeleteRegistry
  if registry then pcall(registry.UnregisterCallback, registry, NATIVE_HIDE_CALLBACK, op) end
  local frame = op.nativeDeleteFrame
  if frame and op.nativeDeleteRegistrationAdded then
    local ok, visible = pcall(frame.IsVisible, frame)
    -- A visible native window owns its normal registration. Only undo the
    -- extra hidden-window subscription that this operation installed.
    if ok and visible == false then
      pcall(frame.UnregisterEvent, frame, NATIVE_DELETE_EVENT)
    end
  end
  op.nativeDeleteFrame, op.nativeDeleteRegistry = nil, nil
end

local function Finish(op, success, message)
  if operation ~= op then return end
  operation = nil
  ReleaseNativeDeleteListener(op)
  op.phase = success and "complete" or "stopped"
  Notify(op, message, true, success)
end

-- Blizzard's visible creation handler can select the newly imported config
-- before our CREATED listener runs. This only permits observing that selection:
-- Evaluate still requires acceptance, unique inventory membership, CREATED and
-- full saved-build verification before any follow-up mutation.
local function ExpectedTarget(op, id)
  if id == nil then return false end
  if op.newID then return id == op.newID end
  if not op.importRequested or op.baseline[id] then return false end
  local info = C_Traits.GetConfigInfo(id)
  if not info or info.ID ~= id or info.name ~= op.name or info.type ~= Enum.TraitConfigType.Combat
    or (C_ClassTalents.IsSavedConfig and not C_ClassTalents.IsSavedConfig(id)) then return false end
  for _, candidate in ipairs(C_ClassTalents.GetConfigIDsBySpecID(op.specID)) do
    if candidate == id then return true end
  end
  return false
end

local function Guard(op)
  if operation ~= op then return false end
  if InCombatLockdown() then
    Finish(op, false, "Import stopped in combat. Remaining loadouts were kept; copy the import string when ready.")
    return false
  end
  if CurrentSpecID() ~= op.specID or C_ClassTalents.GetActiveConfigID() ~= op.activeID then
    Finish(op, false, "Import stopped because the active specialization changed. Remaining loadouts were kept.")
    return false
  end
  local selectedID = C_ClassTalents.GetLastSelectedSavedConfigID(op.specID)
  if selectedID ~= op.initialSelectedID and not ExpectedTarget(op, selectedID) then
    Finish(op, false, "Import stopped because another loadout was selected. Remaining loadouts were kept.")
    return false
  end
  if C_ClassTalents.GetStarterBuildActive and C_ClassTalents.GetStarterBuildActive() then
    Finish(op, false, "Import stopped because Starter Build is active. Copy the import string.")
    return false
  end
  local parent = PlayerSpellsFrame
  local talents = parent and parent.TalentsFrame
  if parent and (parent.inspectUnit ~= nil or parent.inspectString ~= nil) then
    Finish(op, false, "Import stopped because talent inspection opened. Remaining loadouts were kept.")
    return false
  end
  if parent and parent.SpecFrame and parent.SpecFrame.activatedSpecIndex ~= nil then
    Finish(op, false, "Import stopped because another talent change started. Remaining loadouts were kept.")
    return false
  end
  for _, field in ipairs({ "commitedConfigID", "autoLoadNewConfigID" }) do
    local pendingID = talents and talents[field]
    if pendingID ~= nil and not ExpectedTarget(op, pendingID) then
      Finish(op, false, "Import stopped because another talent change started. Remaining loadouts were kept.")
      return false
    end
    if pendingID ~= nil and field == "commitedConfigID"
      and (op.phase == "importing" or op.phase == "saved" or op.phase == "sharing" or op.phase == "ready") then
      op.nativeCommitObserved = true
    end
  end
  return true
end

local function Inventory(specID)
  local result = {}
  for _, id in ipairs(C_ClassTalents.GetConfigIDsBySpecID(specID)) do
    local info = C_Traits.GetConfigInfo(id)
    if not info or info.ID ~= id then error("Loadout inventory is unavailable.") end
    result[id] = info
  end
  return result
end

local function CharacterInventory()
  local getCount = C_SpecializationInfo and C_SpecializationInfo.GetNumSpecializations or GetNumSpecializations
  local getInfo = C_SpecializationInfo and C_SpecializationInfo.GetSpecializationInfo or GetSpecializationInfo
  local count = getCount and getCount()
  if type(count) ~= "number" or count < 1 or count > 5 then error("Specialization inventory is unavailable.") end
  local result, specs = {}, {}
  for index = 1, count do
    local specID = getInfo(index)
    if type(specID) ~= "number" then error("Specialization inventory is unavailable.") end
    for id, info in pairs(Inventory(specID)) do
      if specs[id] and specs[id] ~= specID then error("Loadout membership is ambiguous.") end
      result[id], specs[id] = info, specID
    end
  end
  return result, specs
end

local function Saved(info)
  return info and info.type == Enum.TraitConfigType.Combat
    and (not C_ClassTalents.IsSavedConfig or C_ClassTalents.IsSavedConfig(info.ID))
end

local function ManagedName(name, canonical, prefixes)
  if type(name) ~= "string" then return false end
  if name == "QWT" then return true end -- migrate the legacy fixed loadout name
  for _, prefix in ipairs(prefixes) do
    if name:sub(1, #prefix) == prefix then return true end
  end
  return false
end

local function Defer(op, polling)
  if operation ~= op then return end
  if op.queued then
    -- A real event takes precedence over a pending lightweight readback poll.
    if not polling then op.queuedFromPoll = false end
    return
  end
  op.queued = true
  op.queuedFromPoll = polling == true
  C_Timer.After(0, function()
    local fromPoll = op.queuedFromPoll
    op.queued = false
    if operation ~= op then return end
    local ok = pcall(Evaluate, op, fromPoll)
    if not ok then
      Finish(op, false, "WoW could not verify the import. No further changes will be attempted; copy the import string.")
    end
  end)
end

local function WaitForSharedBars(op)
  if operation ~= op or op.sharedPollScheduled then return end
  op.sharedPollScheduled = true
  C_Timer.After(SHARED_BARS_POLL_SECONDS, function()
    op.sharedPollScheduled = false
    if operation == op and op.phase == "sharing" then Defer(op, true) end
  end)
end

local function WaitForCleanup(op)
  if operation ~= op or op.cleanupPollScheduled then return end
  op.cleanupPollScheduled = true
  C_Timer.After(CLEANUP_POLL_SECONDS, function()
    op.cleanupPollScheduled = false
    if operation == op and op.phase == "deleting" then Defer(op, true) end
  end)
end

local function WaitForNativeTransition(op)
  local talents = PlayerSpellsFrame and PlayerSpellsFrame.TalentsFrame
  local pendingID = talents and (talents.commitedConfigID or talents.autoLoadNewConfigID)
  if pendingID == nil then
    op.nativeWaitingID = nil
    return false
  end
  op.nativeWaitingID = pendingID
  -- Native listeners can clear their fields after delivering an update to us.
  -- Observe that completion without reissuing a switch or modifying UI fields.
  if not op.nativePollScheduled then
    op.nativePollScheduled = true
    C_Timer.After(NATIVE_POLL_SECONDS, function()
      op.nativePollScheduled = false
      if operation == op then Defer(op, true) end
    end)
  end
  return true
end

local function SharedBarsEnabled(op, info)
  info = info or C_Traits.GetConfigInfo(op.newID)
  local shared = info and info.usesSharedActionBars
  if (issecretvalue and issecretvalue(shared)) or type(shared) ~= "boolean" then shared = nil end
  return shared == true
end

local function Verified(op, configID)
  local matches, reason = NS.TalentCodec.Verify(configID, op.entries, op.metadata)
  if matches == true then return true end
  op.verificationReason = SafeText(reason) or "Talent verification failed."
  return false
end

local function Applied(op)
  return not C_Traits.ConfigHasStagedChanges(op.activeID)
    and SharedBarsEnabled(op)
    and Verified(op, op.activeID)
    and Verified(op, op.newID)
end

local function NativeLoadoutIndex(op)
  local parent = PlayerSpellsFrame
  local talents = parent and parent.TalentsFrame
  local spec = parent and parent.SpecFrame
  -- The secure delegate reads Blizzard's cached dropdown, not the current API
  -- inventory. Only read native state; refreshing or assigning it here can taint
  -- the very change flow the delegate is intended to own.
  if not talents or not spec then return nil end
  if talents.variablesLoaded ~= true then return nil end
  if parent.inspectUnit ~= nil or parent.inspectString ~= nil then return nil end
  if talents.commitedConfigID ~= nil then return nil end
  if talents.autoLoadNewConfigID ~= nil then return nil end
  if spec.activatedSpecIndex ~= nil then return nil end
  if not talents.configurationInfo or talents.configurationInfo.ID ~= op.activeID then return nil end
  if talents.talentTreeID ~= op.metadata.treeID then return nil end
  if type(talents.configIDs) ~= "table" or type(talents.configIDToName) ~= "table" then return nil end
  local targetIndex
  for index, configID in ipairs(talents.configIDs) do
    if configID == op.newID then
      if targetIndex then return nil end
      if talents.configIDToName[configID] ~= op.name then return nil end
      targetIndex = index
    end
  end
  return targetIndex
end

local function CleanupNext(op)
  if not Guard(op) then return end
  local inventory, specs = CharacterInventory()
  local newInfo = inventory[op.newID]
  if not Saved(newInfo) or newInfo.name ~= op.name then
    Finish(op, false, "The new loadout changed before verification. Remaining loadouts were kept.")
    return
  end
  if not Applied(op) or C_ClassTalents.GetLastSelectedSavedConfigID(op.specID) ~= op.newID then
    Finish(op, false, "Talent selection changed before cleanup. Remaining loadouts were kept.")
    return
  end
  -- Never expand the snapshot to absorb builds another action created or renamed.
  for id, info in pairs(inventory) do
    if id ~= op.newID and id ~= op.activeID
      and ManagedName(info.name, op.name, op.prefixes) and not op.managedSnapshot[id] then
      Finish(op, false, "QWT applied. Another managed loadout appeared during import; remaining loadouts were kept. Import again to consolidate them.")
      return
    end
  end
  -- Check all remaining originals before deleting any of them. Missing IDs may
  -- have been deleted elsewhere; an ID still present outside this spec is unsafe.
  for index = op.cleanupIndex, #op.cleanup do
    local previous = op.cleanup[index]
    local info = inventory[previous.id]
    if info and (not Saved(info) or info.name ~= previous.name or specs[previous.id] ~= previous.specID
        or previous.id == op.activeID or previous.id == op.newID) then
      Finish(op, false, "QWT applied. An earlier loadout changed before cleanup; remaining loadouts were kept.")
      return
    end
  end
  while op.cleanup[op.cleanupIndex] and not inventory[op.cleanup[op.cleanupIndex].id] do
    op.cleanupIndex = op.cleanupIndex + 1
  end
  op.remainingCount = #op.cleanup - op.cleanupIndex + 1
  local previous = op.cleanup[op.cleanupIndex]
  op.oldID = previous and previous.id or nil
  if not previous then
    Finish(op, true, "Applied " .. op.name .. "; earlier QWT builds removed.")
    return
  end
  if not Guard(op) then return end
  if WaitForNativeTransition(op) then return end
  -- Hidden Talents windows normally miss deletion events, leaving ghost rows.
  -- Deliver the real game event to Blizzard's existing handler; never call its
  -- refresh method directly or write the cache used by secure loadout switching.
  AcquireNativeDeleteListener(op)
  -- Exactly one attempt per snapshot ID, even if trait events fire synchronously.
  if op.attempted[previous.id] then
    Finish(op, false, "QWT applied. Cleanup stopped without retrying a previous removal.")
    return
  end
  op.attempted[previous.id] = true
  op.phase = "deleting"
  op.deleteReturned = false
  op.deletedEventReceived = false
  local ok = pcall(C_ClassTalents.DeleteConfig, previous.id)
  if operation ~= op then return end
  if not ok then
    Finish(op, false, "New loadout applied. WoW did not confirm cleanup; check Talents. No retry was attempted.")
    return
  end
  -- Some clients report false even for a completed removal. A return value alone
  -- is never proof: require the exact deletion event AND updated spec inventories.
  op.deleteReturned = true
  Defer(op)
end

local function FinishApplied(op)
  Notify(op, "QWT verified. Finishing import...", false)
  if not Guard(op) then return end
  op.phase = "cleanup"
  Defer(op)
end

Evaluate = function(op, polling)
  local quietPoll = polling and (op.phase == "sharing" or op.nativeWaitingID ~= nil)
  if not Guard(op) then return end
  if WaitForNativeTransition(op) then return end
  if op.phase == "importing" or op.phase == "saved" then
    if op.phase == "importing" and not op.importAccepted then return end
    local inventory = Inventory(op.specID)
    local candidate = op.reusing and op.newID
    if not op.reusing then
      for id, info in pairs(inventory) do
        if info.name == op.name and not op.baseline[id] then
          if candidate or not Saved(info) then
            Finish(op, false, "The new loadout could not be uniquely identified. Remaining loadouts were kept.")
            return
          end
          candidate = id
        end
      end
    end
    if not candidate then
      return
    end
    if not op.reusing and not op.created[candidate] then
      return
    end
    op.newID = candidate
    if not C_ClassTalents.IsConfigPopulated(candidate) then
      return
    end
    if not Verified(op, candidate) then
      Finish(op, false, "The saved import could not be verified. Remaining loadouts were kept; copy the import string."
        .. (op.verificationReason and (" " .. op.verificationReason) or ""))
      return
    end
    if op.nativeCommitObserved and (C_ClassTalents.GetLastSelectedSavedConfigID(op.specID) ~= candidate
      or C_Traits.ConfigHasStagedChanges(op.activeID) or not Verified(op, op.activeID)) then
      Finish(op, false, "WoW could not apply the talents. Remaining loadouts were kept; copy the import string.")
      return
    end
    if SharedBarsEnabled(op, inventory[candidate]) then
      op.phase = "ready"
    else
      op.phase = "sharing"
      Notify(op, "Loadout saved. Enabling shared action bars...", false)
      if not Guard(op) then return end
      if WaitForNativeTransition(op) then op.phase = "saved"; return end
      local info = Inventory(op.specID)[candidate]
      if not Saved(info) or info.name ~= op.name or not C_ClassTalents.IsConfigPopulated(candidate) or not Verified(op, candidate) then
        Finish(op, false, "The saved loadout changed before application. Remaining loadouts were kept.")
        return
      end
      local canEdit, changeError = C_ClassTalents.CanEditTalents()
      if not canEdit then
        Finish(op, false, "Loadout saved. " .. CannotEditMessage(changeError) .. " Earlier loadouts were kept.")
        return
      end
      -- The clicked QWT target uses shared bars, including an existing verified
      -- target. Other saved configurations and private layouts are untouched.
      if SharedBarsEnabled(op, info) then
        op.phase = "ready"
      else
        local ok = pcall(C_ClassTalents.SetUsesSharedActionBars, candidate, true)
        if operation ~= op then return end
        if not ok then
          Finish(op, false, "Shared action bars could not be enabled. Earlier loadouts were kept; check Talents before trying again.")
          return
        end
        op.sharedRequestReturned = true
      end
    end
    Defer(op)
  elseif op.phase == "sharing" then
    if not op.sharedRequestReturned then return end
    local info = Inventory(op.specID)[op.newID]
    if not Saved(info) or info.name ~= op.name or not C_ClassTalents.IsConfigPopulated(op.newID) then
      Finish(op, false, "The saved loadout changed before application. Remaining loadouts were kept.")
      return
    end
    local shared = SharedBarsEnabled(op, info)
    -- Recheck identity on every poll, but avoid repeatedly exporting an unchanged
    -- build while waiting. Events and confirmed sharing still fully verify it.
    if (not quietPoll or shared) and not Verified(op, op.newID) then
      Finish(op, false, "The saved loadout changed before application. Remaining loadouts were kept.")
      return
    end
    -- The setter has no success return or documented synchronous readback.
    -- Request once; observe updates without retrying the setting mutation.
    if not shared then
      WaitForSharedBars(op)
      return
    end
    op.phase = "ready"
    Defer(op)
  elseif op.phase == "ready" then
    if not op.readyNotified then
      op.readyNotified = true
      Notify(op, "Loadout saved. Waiting for Blizzard's talent system...", false)
    end
    if not Guard(op) then return end
    if WaitForNativeTransition(op) then return end
    local info = Inventory(op.specID)[op.newID]
    if not Saved(info) or info.name ~= op.name or not Verified(op, op.newID) then
      Finish(op, false, "The saved loadout changed before application. Remaining loadouts were kept.")
      return
    end
    if not SharedBarsEnabled(op, info) then
      Finish(op, false, "Shared action bar settings changed before application. Earlier loadouts were kept.")
      return
    end
    if op.nativeCommitObserved and (C_ClassTalents.GetLastSelectedSavedConfigID(op.specID) ~= op.newID
      or not Applied(op)) then
      Finish(op, false, "WoW could not apply the talents. Remaining loadouts were kept; copy the import string.")
      return
    end
    -- Blizzard may already have applied a newly created loadout, or the
    -- selected saved loadout may already match. Adopt only a settled, fully
    -- verified result without asking Blizzard to apply the same build again.
    if C_ClassTalents.GetLastSelectedSavedConfigID(op.specID) == op.newID
      and Applied(op) then
      op.phase = "selecting"
      Defer(op)
      return
    end
    local canEdit, changeError = C_ClassTalents.CanEditTalents()
    if not canEdit then
      Finish(op, false, "Loadout saved. " .. CannotEditMessage(changeError) .. " Earlier loadouts were kept.")
      return
    end
    -- This explicit import replaces the current talent state. The current build
    -- need not be complete or free of pending edits before native switching.
    -- Applied() still requires the replacement to finish with no staged edits.
    local index = NativeLoadoutIndex(op)
    -- Population updates refresh the native dropdown even while it is hidden.
    -- Wait for that event's deferred evaluation instead of guessing an index.
    if not index then return end
    Notify(op, "Loadout saved. Applying talents...", false)
    if not Guard(op) then return end
    if WaitForNativeTransition(op) then return end
    info = Inventory(op.specID)[op.newID]
    if not Saved(info) or info.name ~= op.name or not Verified(op, op.newID) then
      Finish(op, false, "The saved loadout changed before application. Remaining loadouts were kept.")
      return
    end
    if not SharedBarsEnabled(op, info) then
      Finish(op, false, "Shared action bar settings changed before application. Earlier loadouts were kept.")
      return
    end
    index = NativeLoadoutIndex(op)
    if not index then return end
    op.wasAlreadyApplied = NS.TalentCodec.Verify(op.activeID, op.entries, op.metadata) == true
    op.phase = "loading"
    -- Register the phase before invoking the delegate: updates may be synchronous.
    -- Blizzard owns commit tracking and saved-selection bookkeeping throughout.
    local ok = pcall(C_ClassTalents.SwitchToLoadoutByIndex, index)
    if operation ~= op then return end
    if not ok then
      Finish(op, false, "New loadout saved. Apply it in Talents; earlier loadouts were kept. No retry was attempted.")
      return
    end
    op.switchRequested = true
    Defer(op)
  elseif op.phase == "loading" then
    -- The delegate has no success return. A real change needs the active/base
    -- update; an identical build may complete without an event. Both paths still
    -- require Blizzard's selected saved ID, unstaged state, and full verification.
    if not op.switchRequested or (not op.activeUpdated and not op.wasAlreadyApplied) then return end
    if C_ClassTalents.GetLastSelectedSavedConfigID(op.specID) ~= op.newID then return end
    if not Applied(op) then return end
    if not Guard(op) then return end
    op.phase = "selecting"
    Defer(op)
  elseif op.phase == "selecting" then
    if not Applied(op) or C_ClassTalents.GetLastSelectedSavedConfigID(op.specID) ~= op.newID then
      Finish(op, false, "Talent selection changed before cleanup. Remaining loadouts were kept.")
      return
    end
    FinishApplied(op)
  elseif op.phase == "cleanup" then
    CleanupNext(op)
  elseif op.phase == "deleting" then
    if not op.deleteReturned then return end
    if not Applied(op) or C_ClassTalents.GetLastSelectedSavedConfigID(op.specID) ~= op.newID then
      Finish(op, false, "Talent selection changed during cleanup. Remaining loadouts were kept.")
      return
    end
    local previous = op.cleanup[op.cleanupIndex]
    local inventory, specs = CharacterInventory()
    local info = inventory[previous.id]
    if not info then
      -- Cached metadata may outlive deletion. The matching event and absence
      -- from all this character's spec lists are the completion signals.
      if not op.deletedEventReceived then WaitForCleanup(op); return end
      op.cleanupIndex = op.cleanupIndex + 1
      op.remainingCount = #op.cleanup - op.cleanupIndex + 1
      op.oldID = op.cleanup[op.cleanupIndex] and op.cleanup[op.cleanupIndex].id or nil
      op.deleteReturned = false
      op.deletedEventReceived = false
      op.phase = "cleanup"
      Defer(op)
    elseif not Saved(info) or info.name ~= previous.name or specs[previous.id] ~= previous.specID then
      Finish(op, false, "QWT applied. An earlier loadout changed during cleanup; remaining loadouts were kept.")
    else
      -- The deletion event and inventory readback can settle separately. Poll
      -- until both agree or the operation deadline expires; never delete twice.
      WaitForCleanup(op)
    end
  end
end

function Import.HandleEvent(event, arg)
  local op = operation
  if not op then return end
  if event == "PLAYER_REGEN_DISABLED" then
    Finish(op, false, "Import stopped in combat. Remaining loadouts were kept.")
    return
  end
  if (event == "ADDON_ACTION_BLOCKED" or event == "ADDON_ACTION_FORBIDDEN") and arg == ADDON_NAME then
    Finish(op, false, "WoW blocked this import action. No further changes will be attempted; copy the import string.")
    return
  end
  if event == "ACTIVE_COMBAT_CONFIG_CHANGED" and arg ~= op.activeID then
    Finish(op, false, "Import stopped because the active talent configuration changed. Remaining loadouts were kept.")
    return
  end
  if event == "SELECTED_LOADOUT_CHANGED" then
    local ok, safe = pcall(Guard, op)
    if not ok then Finish(op, false, "Loadout selection could not be verified. No further changes will be attempted.") end
    if not ok or not safe then return end
  end
  if event == "ACTIVE_PLAYER_SPECIALIZATION_CHANGED"
    or (event == "PLAYER_SPECIALIZATION_CHANGED" and (arg == nil or arg == "player")) then
    Finish(op, false, "Import stopped because the specialization changed. Remaining loadouts were kept.")
    return
  end
  if event == "CONFIG_COMMIT_FAILED" and (arg == op.activeID or ExpectedTarget(op, arg)) then
    Finish(op, false, "WoW could not apply the talents. Remaining loadouts were kept; copy the import string.")
    return
  end
  if event == "TRAIT_CONFIG_CREATED" and op.phase == "importing" and type(arg) == "table" and type(arg.ID) == "number" then
    op.created[arg.ID] = true
  elseif event == "TRAIT_CONFIG_DELETED" and op.phase == "deleting" and arg == op.oldID
    and op.attempted[arg] then
    op.deletedEventReceived = true
  elseif event == "TRAIT_CONFIG_UPDATED" and op.phase == "loading" and arg == op.activeID then
    op.activeUpdated = true
  end
  Defer(op)
end

local function EnsureEvents()
  if eventFrame then return end
  eventFrame = CreateFrame("Frame")
  for _, event in ipairs({ "TRAIT_CONFIG_CREATED", "TRAIT_CONFIG_UPDATED", "TRAIT_CONFIG_DELETED",
    "TRAIT_CONFIG_LIST_UPDATED", "CONFIG_COMMIT_FAILED", "ACTIVE_COMBAT_CONFIG_CHANGED",
    "SELECTED_LOADOUT_CHANGED", "PLAYER_REGEN_DISABLED", "ACTIVE_PLAYER_SPECIALIZATION_CHANGED",
    "PLAYER_SPECIALIZATION_CHANGED", "ADDON_ACTION_BLOCKED", "ADDON_ACTION_FORBIDDEN" }) do
    eventFrame:RegisterEvent(event)
  end
  eventFrame:SetScript("OnEvent", function(_, event, ...)
    local op = operation
    local ok = pcall(Import.HandleEvent, event, ...)
    if not ok and op then
      Finish(op, false, "Talent import stopped because an event could not be verified. No further changes will be attempted.")
    end
  end)
end

local function Begin(options)
  if type(options) ~= "table" then return false, "Import options are missing." end
  local prefix = NS.Identity and NS.Identity.loadoutPrefix
  local canonical = options.name
  if prefix ~= "QWT-" or type(canonical) ~= "string" or canonical:sub(1, 4) ~= prefix
    or #canonical <= 4 or #canonical > 124 or canonical:find("[%c|]")
    or select(2, canonical:gsub("[^\128-\191]", "")) > 31 then
    return false, "Managed imports must use QWT- followed by the dungeon or boss name."
  end
  local prefixes, seenPrefixes = {}, {}
  if type(NS.Identity.managedLoadoutPrefixes) ~= "table" then return false, "Managed loadout prefixes are unavailable." end
  for _, prefix in ipairs(NS.Identity.managedLoadoutPrefixes) do
    if prefix ~= "QWT-" and prefix ~= "QWTTest-" then return false, "Managed loadout prefixes are invalid." end
    if seenPrefixes[prefix] then return false, "Managed loadout prefixes are invalid." end
    seenPrefixes[prefix] = true
    prefixes[#prefixes + 1] = prefix
  end
  if not seenPrefixes["QWT-"] or not seenPrefixes["QWTTest-"] then return false, "Managed loadout prefixes are incomplete." end
  if InCombatLockdown() then return false, "Import is unavailable in combat. Copy the import string." end
  if CurrentSpecID() ~= options.specID then return false, "Switch to the matching specialization first." end
  if not NS.TalentCodec or not NS.TalentCodec.Decode or not NS.TalentCodec.Verify
    or not C_ClassTalents or not C_Traits or not C_Timer or not C_Timer.After then
    return false, "Talent import APIs are unavailable. Copy the import string."
  end
  for _, name in ipairs({ "GetActiveConfigID", "CanEditTalents", "CanCreateNewConfig",
    "GetConfigIDsBySpecID", "IsConfigPopulated", "GetLastSelectedSavedConfigID",
    "ImportLoadout", "SwitchToLoadoutByIndex", "DeleteConfig",
    "SetUsesSharedActionBars" }) do
    if type(C_ClassTalents[name]) ~= "function" then
      return false, "Talent import APIs are unavailable. Copy the import string."
    end
  end
  if C_ClassTalents.GetStarterBuildActive and C_ClassTalents.GetStarterBuildActive() then
    return false, "Select a regular talent loadout before importing. Copy the import string."
  end
  local activeID = C_ClassTalents.GetActiveConfigID()
  local initialSelectedID = C_ClassTalents.GetLastSelectedSavedConfigID(options.specID)
  if not activeID then return false, "The active talent configuration is unavailable. Copy the import string." end
  local canEdit, changeError = C_ClassTalents.CanEditTalents()
  if not canEdit then return false, CannotEditMessage(changeError) .. " Copy the import string." end
  -- Load (without opening) the native UI before creating a config, so it receives
  -- population updates and owns the later secure loadout switch. Do not call its
  -- methods, edit cached fields, or open/hide the frame from this importer.
  if not PlayerSpellsFrame or not PlayerSpellsFrame.TalentsFrame then
    if not C_AddOns or type(C_AddOns.LoadAddOn) ~= "function" then
      return false, "Blizzard's talent system is unavailable. Copy the import string."
    end
    local loaded = C_AddOns.LoadAddOn("Blizzard_PlayerSpells")
    if not loaded or not PlayerSpellsFrame or not PlayerSpellsFrame.TalentsFrame then
      return false, "Blizzard's talent system could not load. Copy the import string."
    end
  end
  local parent = PlayerSpellsFrame
  local talents = parent.TalentsFrame
  if parent.inspectUnit ~= nil or parent.inspectString ~= nil then
    return false, "Exit talent inspection before importing."
  end
  if talents.commitedConfigID ~= nil or talents.autoLoadNewConfigID ~= nil
    or (parent.SpecFrame and parent.SpecFrame.activatedSpecIndex ~= nil) then
    return false, "Wait for Blizzard's current talent change to finish, then import again."
  end
  if CurrentSpecID() ~= options.specID or C_ClassTalents.GetActiveConfigID() ~= activeID
    or C_ClassTalents.GetLastSelectedSavedConfigID(options.specID) ~= initialSelectedID then
    return false, "Talent selection changed while preparing the import. Try again when it is ready."
  end
  local entries, decodeError, metadata = NS.TalentCodec.Decode(options.importString, options.specID, activeID)
  if not entries then return false, decodeError or "The import string could not be validated. Copy the import string." end
  local baseline, baselineSpecs = CharacterInventory()
  local managed, managedSnapshot, canonicalIDs = {}, {}, {}
  for id, info in pairs(baseline) do
    if id ~= activeID and ManagedName(info.name, canonical, prefixes) then
      if not Saved(info) then
        return false, "A QWT loadout could not be identified as a saved combat loadout. Resolve it in Talents before importing."
      end
      managed[#managed + 1] = { id = id, name = info.name, specID = baselineSpecs[id] }
      managedSnapshot[id] = info.name
      if info.name == canonical and baselineSpecs[id] == options.specID then canonicalIDs[#canonicalIDs + 1] = id end
    end
  end
  table.sort(managed, function(a, b) return a.id < b.id end)
  table.sort(canonicalIDs, function(a, b)
    if a == b then return false end
    if a == initialSelectedID then return true end
    if b == initialSelectedID then return false end
    return a < b
  end)
  local reusedID
  for _, id in ipairs(canonicalIDs) do
    if C_ClassTalents.IsConfigPopulated(id) and NS.TalentCodec.Verify(id, entries, metadata) == true then
      reusedID = id
      break
    end
  end
  local cleanup = {}
  for _, previous in ipairs(managed) do
    if previous.id ~= reusedID then cleanup[#cleanup + 1] = previous end
  end
  local reusing = reusedID ~= nil
  if not reusing and not C_ClassTalents.CanCreateNewConfig() then
    return false, "A free loadout slot is required to preserve the previous version. Copy the import string."
  end
  EnsureEvents()
  local op = { phase = reusing and "saved" or "importing", name = options.name, specID = options.specID,
    activeID = activeID, oldID = cleanup[1] and cleanup[1].id or nil, newID = reusedID,
    initialSelectedID = initialSelectedID, reusing = reusing, baseline = baseline, entries = entries,
    prefixes = prefixes, managedSnapshot = managedSnapshot, cleanup = cleanup, cleanupIndex = 1,
    remainingCount = #cleanup, attempted = {}, metadata = metadata, created = {}, onStatus = options.onStatus }
  operation = op
  C_Timer.After(TIMEOUT_SECONDS, function()
    if op.phase == "sharing" then
      Finish(op, false, "Shared action bars were not confirmed before timeout. Earlier loadouts were kept; check Talents before trying again.")
    else
      Finish(op, false, "Import timed out. No further changes will be attempted; check Talents or copy the import string.")
    end
  end)
  Notify(op, (reusing and "Using existing " or "Saving ") .. op.name .. "...", false)
  if not Guard(op) then return false, lastStatus.message end
  if reusing then
    Defer(op)
    return true
  end
  op.importRequested = true
  local ok, accepted, importError = pcall(C_ClassTalents.ImportLoadout, activeID, entries, op.name, options.importString)
  if operation ~= op then return false, lastStatus.message end
  if not ok or accepted ~= true then
    local reason = ok and SafeText(importError)
    Finish(op, false, "WoW did not accept the import." .. (reason and (" " .. reason) or "")
      .. " Remaining loadouts were kept; copy the import string.")
    return false, lastStatus.message
  end
  op.importAccepted = true
  Defer(op)
  return true
end

function Import.Begin(options)
  if operation then
    return false, "An import is already in progress."
  end
  local ok, success, message = pcall(Begin, options)
  if not ok then
    if operation then Finish(operation, false, "Talent import stopped because an API was unavailable. Copy the import string.") end
    return false, "Talent import APIs are unavailable. Copy the import string."
  end
  if not success and not operation then
    lastStatus = { phase = "stopped", message = message, success = false }
  end
  return success, message
end

function Import.IsBusy()
  return operation ~= nil
end

function Import.GetStatus()
  local current = operation
  local oldID, newID = lastStatus.oldConfigID, lastStatus.newConfigID
  if current then oldID, newID = current.oldID, current.newID end
  return { phase = current and current.phase or lastStatus.phase, message = lastStatus.message,
    success = lastStatus.success, oldConfigID = oldID, newConfigID = newID,
    remainingCount = current and current.remainingCount or lastStatus.remainingCount }
end
