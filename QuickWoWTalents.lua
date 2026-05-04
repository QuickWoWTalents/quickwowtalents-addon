local ADDON_NAME = ...
local PREFIX = "|cff00c8ffQuick WoW Talents|r"
local UI = { state = { mode = "mplus", encounterIds = {} } }
local AUTO_OPEN_DELAY_SECONDS = 1.5

-- Current Mythic+ client IDs, cross-checked against Raider.IO's public dungeon DB.
-- WoW exposes challenge map / instance map IDs in-game; QWT recommendation data uses
-- Warcraft Logs encounter IDs, so auto-open needs an explicit translation layer.
local MPLUS_DUNGEON_CONTEXTS = {
  { qwtDungeonId = 10658, challengeMapId = 556, instanceMapIds = { 658 }, name = "Pit of Saron" },
  { qwtDungeonId = 61209, challengeMapId = 161, instanceMapIds = { 1209 }, name = "Skyreach" },
  { qwtDungeonId = 361753, challengeMapId = 239, instanceMapIds = { 1753 }, name = "Seat of the Triumvirate" },
  { qwtDungeonId = 112526, challengeMapId = 402, instanceMapIds = { 2526 }, name = "Algeth'ar Academy" },
  { qwtDungeonId = 12805, challengeMapId = 557, instanceMapIds = { 2805 }, name = "Windrunner Spire" },
  { qwtDungeonId = 12811, challengeMapId = 558, instanceMapIds = { 2811 }, name = "Magisters' Terrace" },
  { qwtDungeonId = 12874, challengeMapId = 560, instanceMapIds = { 2874 }, name = "Maisara Caverns" },
  { qwtDungeonId = 12915, challengeMapId = 559, instanceMapIds = { 2915 }, name = "Nexus-Point Xenas" }
}

local MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID = {}
local MPLUS_DUNGEON_BY_INSTANCE_MAP_ID = {}

for _, context in ipairs(MPLUS_DUNGEON_CONTEXTS) do
  MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID[context.challengeMapId] = context
  for _, instanceMapId in ipairs(context.instanceMapIds) do
    MPLUS_DUNGEON_BY_INSTANCE_MAP_ID[instanceMapId] = context
  end
end

local function Print(message)
  DEFAULT_CHAT_FRAME:AddMessage(PREFIX .. ": " .. tostring(message))
end

local function IsInCombat()
  return InCombatLockdown and InCombatLockdown()
end

local function CountRecommendationTable(encounters)
  local count = 0
  if type(encounters) == "table" then
    for _, recommendation in pairs(encounters) do
      if type(recommendation) == "table" and recommendation.importString then
        count = count + 1
      end
    end
  end
  return count
end

local function CountRecommendations()
  local data = QuickWoWTalentsData or {}
  local count = 0

  if type(data.recommendations) == "table" then
    for _, entry in pairs(data.recommendations) do
      if type(entry) == "table" then
        if type(entry.mplusBestOverall) == "table" and entry.mplusBestOverall.importString then
          count = count + 1
        end
        if type(entry.mplus) == "table" then
          count = count + CountRecommendationTable(entry.mplus.encounters)
        end
        if type(entry.raid) == "table" then
          count = count + CountRecommendationTable(entry.raid.encounters)
        end
      end
    end
  end

  return count
end

local function GetCurrentSpecInfo()
  if not GetSpecialization or not GetSpecializationInfo then
    return nil, nil, "Specialization API is not available."
  end

  local specIndex = GetSpecialization()
  if not specIndex then
    return nil, nil, "Choose a specialization first, then run /qwt again."
  end

  local specID, specName = GetSpecializationInfo(specIndex)
  if not specID then
    return nil, nil, "Could not detect current specialization."
  end

  return specID, specName, nil
end

local function GetModeConfig(mode)
  local data = QuickWoWTalentsData or {}
  if data.modes and data.modes[mode] then
    return data.modes[mode]
  end
  return nil
end

local function GetModeLabel(mode)
  if mode == "raid" then
    local config = GetModeConfig("raid")
    local difficulty = config and config.difficulty and config.difficulty.name or "Heroic"
    return difficulty .. " Raid"
  end
  return "Mythic+"
end

local function GetMplusRecommendationLabel()
  local config = GetModeConfig("mplus")
  if config and config.recommendationLabel then
    return tostring(config.recommendationLabel)
  end
  if config and config.minimumKeystoneLevel then
    return "Best Overall (" .. tostring(config.minimumKeystoneLevel) .. "+)"
  end
  return "Best Overall"
end

local function GetEncounterList(mode)
  local config = GetModeConfig(mode)
  if not config then
    return {}
  end
  if mode == "raid" then
    return config.bosses or {}
  end
  return config.dungeons or {}
end

local function FindEncounter(mode, encounterId)
  local id = tonumber(encounterId)
  for _, encounter in ipairs(GetEncounterList(mode)) do
    if tonumber(encounter.id) == id then
      return encounter
    end
  end
  return nil
end

local function GetFirstEncounterId(mode)
  local encounters = GetEncounterList(mode)
  if encounters[1] then
    return tonumber(encounters[1].id)
  end
  return nil
end

local function NormalizeMode(mode)
  if mode == "raid" and GetModeConfig("raid") then
    return "raid"
  end
  return "mplus"
end

local function EnsureState()
  QuickWoWTalentsDB = QuickWoWTalentsDB or {}
  QuickWoWTalentsDB.encounterIds = QuickWoWTalentsDB.encounterIds or {}
  if QuickWoWTalentsDB.autoOpenEnabled == nil then
    QuickWoWTalentsDB.autoOpenEnabled = true
  end

  UI.state.mode = NormalizeMode(QuickWoWTalentsDB.mode or UI.state.mode or "mplus")
  UI.state.encounterIds = UI.state.encounterIds or {}

  for _, mode in ipairs({ "mplus", "raid" }) do
    local savedId = tonumber(QuickWoWTalentsDB.encounterIds[mode])
    local currentId = tonumber(UI.state.encounterIds[mode]) or savedId
    if currentId and FindEncounter(mode, currentId) then
      UI.state.encounterIds[mode] = currentId
    else
      UI.state.encounterIds[mode] = GetFirstEncounterId(mode)
    end
  end
end

local function SaveState()
  QuickWoWTalentsDB = QuickWoWTalentsDB or {}
  QuickWoWTalentsDB.encounterIds = QuickWoWTalentsDB.encounterIds or {}
  QuickWoWTalentsDB.mode = UI.state.mode
  QuickWoWTalentsDB.encounterIds.mplus = UI.state.encounterIds.mplus
  QuickWoWTalentsDB.encounterIds.raid = UI.state.encounterIds.raid
end

local function GetSelectedEncounterId()
  EnsureState()
  return UI.state.encounterIds[UI.state.mode]
end

local function GetSelectedEncounter()
  return FindEncounter(UI.state.mode, GetSelectedEncounterId())
end

local function GetRecommendation()
  EnsureState()

  local data = QuickWoWTalentsData or {}
  local specID, specName, errorMessage = GetCurrentSpecInfo()
  if errorMessage then
    return nil, errorMessage
  end

  local specEntry = data.recommendations and data.recommendations[specID]
  if not specEntry then
    return nil, "No bundled recommendations for " .. tostring(specName) .. " (spec ID " .. tostring(specID) .. "). Data has " .. CountRecommendations() .. " total strings."
  end

  local selectedEncounterId = GetSelectedEncounterId()
  local recommendation = nil

  if UI.state.mode == "raid" then
    recommendation = specEntry.raid and specEntry.raid.encounters and specEntry.raid.encounters[selectedEncounterId]
  else
    recommendation = specEntry.mplus and specEntry.mplus.encounters and specEntry.mplus.encounters[selectedEncounterId]
    if not recommendation and type(specEntry.mplusBestOverall) == "table" then
      recommendation = specEntry.mplusBestOverall
    end
  end

  if not recommendation or not recommendation.importString then
    local encounter = GetSelectedEncounter()
    local encounterName = encounter and encounter.name or tostring(selectedEncounterId or "unknown encounter")
    return nil, "No bundled " .. GetModeLabel(UI.state.mode) .. " recommendation for " .. tostring(specName) .. " / " .. encounterName .. "."
  end

  return recommendation, nil
end

local function DisarmCloseAfterCopy()
  UI.closeOnNextCopy = false
  UI.copyModifierDown = false
  UI.copyCloseToken = (UI.copyCloseToken or 0) + 1
end

local function ShowImportTextFromStart()
  DisarmCloseAfterCopy()
  if UI.importBox then
    UI.importBox:HighlightText(0, 0)
    UI.importBox:SetCursorPosition(0)
    UI.importBox:ClearFocus()
  end
end

local function IsCopyModifierKey(key)
  return key == "LCTRL" or key == "RCTRL" or key == "LMETA" or key == "RMETA"
end

local function CloseAfterNativeCopy()
  local token = (UI.copyCloseToken or 0) + 1
  UI.copyCloseToken = token

  -- Defer the hide very briefly so the native WoW/OS copy shortcut can complete first.
  C_Timer.After(0.1, function()
    if UI.closeOnNextCopy and UI.copyCloseToken == token and UI.frame and UI.frame:IsShown() then
      UI.frame:Hide()
    end
    DisarmCloseAfterCopy()
  end)
end

local function SelectImportText(closeOnNextCopy)
  if UI.importBox then
    local text = UI.importBox:GetText() or ""
    UI.importBox:SetFocus()
    UI.importBox:SetCursorPosition(0)
    UI.importBox:HighlightText(0, string.len(text))
  end

  if closeOnNextCopy then
    UI.closeOnNextCopy = true
    UI.copyModifierDown = false
    if UI.hint then
      UI.hint:SetText("Selected. Press Ctrl+C or Cmd+C to copy; this window will close after copy.")
    end
  elseif UI.hint then
    UI.hint:SetText("Selected. Press Ctrl+C or Cmd+C, then paste in Talents → Loadouts → Import.")
  end
end

local function SetDropdownText(dropdown, text)
  if dropdown and UIDropDownMenu_SetText then
    UIDropDownMenu_SetText(dropdown, text)
  end
end

local function UpdateDropdownLabels()
  EnsureState()
  SetDropdownText(UI.modeDropdown, GetModeLabel(UI.state.mode))

  local encounter = GetSelectedEncounter()
  if UI.state.mode == "raid" then
    SetDropdownText(UI.encounterDropdown, encounter and encounter.name or "Select boss")
  else
    SetDropdownText(UI.encounterDropdown, encounter and encounter.name or "Select dungeon")
  end

  if UI.encounterLabel then
    UI.encounterLabel:SetText(UI.state.mode == "raid" and "Boss" or "Dungeon")
  end
end

local function UpdateRecommendation(selectText)
  local recommendation, errorMessage = GetRecommendation()
  local data = QuickWoWTalentsData or {}
  local specID, specName = GetCurrentSpecInfo()
  local encounter = GetSelectedEncounter()

  UpdateDropdownLabels()

  if UI.specLine then
    UI.specLine:SetText(specName and ("Current spec: " .. tostring(specName) .. " (" .. tostring(specID) .. ")") or "Current spec: unknown")
  end

  if errorMessage then
    DisarmCloseAfterCopy()
    UI.subtitle:SetText(errorMessage)
    UI.meta:SetText("Try another encounter, or regenerate the bundled addon data.")
    UI.importBox:SetText("")
    ShowImportTextFromStart()
    UI.footer:SetText("Bundled strings: " .. tostring(CountRecommendations()) .. " · Offline addon data; no live calls from WoW.")
    return
  end

  local snapshot = recommendation.snapshotDate or "unknown snapshot"
  local generated = data.generatedAt or recommendation.generatedAt or "unknown generation time"
  local sampleCount = recommendation.sampleCount or 0
  local encounterName = encounter and encounter.name or recommendation.dungeonName or recommendation.bossName or "selected encounter"
  local contextText = UI.state.mode == "raid"
    and (tostring(recommendation.difficultyName or "Heroic") .. " raid")
    or ("Mythic+ " .. GetMplusRecommendationLabel())

  DisarmCloseAfterCopy()
  UI.subtitle:SetText(recommendation.label or ((recommendation.specName or "Current spec") .. " — " .. encounterName))
  UI.meta:SetText(contextText .. " · " .. encounterName .. " · Metric: " .. tostring(recommendation.metric or "default") .. " · Samples: " .. tostring(sampleCount))
  UI.importBox:SetText(recommendation.importString or "")
  UI.hint:SetText("Press Copy to select the full string, then press Ctrl+C or Cmd+C.")
  UI.footer:SetText("Snapshot: " .. tostring(snapshot) .. " · Bundled: " .. tostring(generated) .. " · Offline addon data; no live calls from WoW.")

  if selectText then
    SelectImportText()
  else
    ShowImportTextFromStart()
  end
end

local function SetMode(mode)
  UI.state.mode = NormalizeMode(mode)
  if not UI.state.encounterIds[UI.state.mode] then
    UI.state.encounterIds[UI.state.mode] = GetFirstEncounterId(UI.state.mode)
  end
  SaveState()
  UpdateRecommendation(false)
end

local function SetEncounter(mode, encounterId)
  UI.state.mode = NormalizeMode(mode)
  UI.state.encounterIds[UI.state.mode] = tonumber(encounterId)
  SaveState()
  UpdateRecommendation(false)
end

local function InitializeModeDropdown(dropdown)
  UIDropDownMenu_Initialize(dropdown, function(_, level)
    if level ~= 1 then return end

    for _, option in ipairs({
      { id = "mplus", text = "Mythic+" },
      { id = "raid", text = GetModeLabel("raid") }
    }) do
      if GetModeConfig(option.id) then
        local mode = option.id
        local info = UIDropDownMenu_CreateInfo()
        info.text = option.text
        info.checked = UI.state.mode == mode
        info.func = function()
          SetMode(mode)
        end
        UIDropDownMenu_AddButton(info, level)
      end
    end
  end)
end

local function InitializeEncounterDropdown(dropdown)
  UIDropDownMenu_Initialize(dropdown, function(_, level)
    if level ~= 1 then return end

    local mode = UI.state.mode
    local selectedEncounterId = GetSelectedEncounterId()
    for _, encounter in ipairs(GetEncounterList(mode)) do
      local encounterId = tonumber(encounter.id)
      local info = UIDropDownMenu_CreateInfo()
      info.text = encounter.name
      info.checked = selectedEncounterId == encounterId
      info.func = function()
        SetEncounter(mode, encounterId)
      end
      UIDropDownMenu_AddButton(info, level)
    end
  end)
end

local function CreateMainFrame()
  if UI.frame then
    return UI.frame
  end

  local frame = CreateFrame("Frame", "QuickWoWTalentsFrame", UIParent, "BackdropTemplate")
  frame:SetSize(700, 340)
  frame:SetPoint("CENTER")
  frame:SetFrameStrata("DIALOG")
  frame:SetMovable(true)
  frame:EnableMouse(true)
  frame:RegisterForDrag("LeftButton")
  frame:SetScript("OnDragStart", frame.StartMoving)
  frame:SetScript("OnDragStop", frame.StopMovingOrSizing)
  frame:SetBackdrop({
    bgFile = "Interface\\DialogFrame\\UI-DialogBox-Background",
    edgeFile = "Interface\\DialogFrame\\UI-DialogBox-Border",
    tile = true,
    tileSize = 32,
    edgeSize = 32,
    insets = { left = 10, right = 10, top = 10, bottom = 10 }
  })
  frame:Hide()
  frame:SetScript("OnHide", function()
    if UI.autoOpenedContextKey then
      UI.dismissedAutoOpenKey = UI.autoOpenedContextKey
      UI.autoOpenedContextKey = nil
    end
    DisarmCloseAfterCopy()
  end)

  local closeButton = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
  closeButton:SetPoint("TOPRIGHT", -6, -6)

  local title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalLarge")
  title:SetPoint("TOPLEFT", 24, -22)
  title:SetText("Quick WoW Talents")
  UI.title = title

  local specLine = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  specLine:SetPoint("TOPLEFT", title, "BOTTOMLEFT", 0, -8)
  specLine:SetPoint("RIGHT", frame, "RIGHT", -28, 0)
  specLine:SetJustifyH("LEFT")
  UI.specLine = specLine

  local modeLabel = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  modeLabel:SetPoint("TOPLEFT", specLine, "BOTTOMLEFT", 0, -20)
  modeLabel:SetText("Mode")
  UI.modeLabel = modeLabel

  local modeDropdown = CreateFrame("Frame", "QuickWoWTalentsModeDropdown", frame, "UIDropDownMenuTemplate")
  modeDropdown:SetPoint("LEFT", modeLabel, "RIGHT", -10, -2)
  UIDropDownMenu_SetWidth(modeDropdown, 150)
  InitializeModeDropdown(modeDropdown)
  UI.modeDropdown = modeDropdown

  local encounterLabel = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
  encounterLabel:SetPoint("LEFT", modeDropdown, "RIGHT", 12, 2)
  encounterLabel:SetText("Dungeon")
  UI.encounterLabel = encounterLabel

  local encounterDropdown = CreateFrame("Frame", "QuickWoWTalentsEncounterDropdown", frame, "UIDropDownMenuTemplate")
  encounterDropdown:SetPoint("LEFT", encounterLabel, "RIGHT", -10, -2)
  UIDropDownMenu_SetWidth(encounterDropdown, 245)
  InitializeEncounterDropdown(encounterDropdown)
  UI.encounterDropdown = encounterDropdown

  local subtitle = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlight")
  subtitle:SetPoint("TOPLEFT", modeLabel, "BOTTOMLEFT", 0, -32)
  subtitle:SetPoint("RIGHT", frame, "RIGHT", -28, 0)
  subtitle:SetJustifyH("LEFT")
  UI.subtitle = subtitle

  local meta = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  meta:SetPoint("TOPLEFT", subtitle, "BOTTOMLEFT", 0, -8)
  meta:SetPoint("RIGHT", frame, "RIGHT", -28, 0)
  meta:SetJustifyH("LEFT")
  UI.meta = meta

  local importBox = CreateFrame("EditBox", nil, frame, "InputBoxTemplate")
  importBox:SetPoint("TOPLEFT", meta, "BOTTOMLEFT", 0, -18)
  importBox:SetSize(640, 32)
  importBox:SetAutoFocus(false)
  importBox:SetFontObject(ChatFontNormal)
  importBox:SetScript("OnEscapePressed", importBox.ClearFocus)
  importBox:SetScript("OnEditFocusGained", function(self) self:SetCursorPosition(0) end)
  importBox:SetScript("OnMouseUp", function(self) self:SetFocus(); self:SetCursorPosition(0) end)
  importBox:SetScript("OnKeyDown", function(_, key)
    if UI.closeOnNextCopy and IsCopyModifierKey(key) then
      UI.copyModifierDown = true
    end
  end)
  importBox:SetScript("OnKeyUp", function(_, key)
    if IsCopyModifierKey(key) then
      -- Match SimulationCraft's proven copy UX: keep a brief modifier grace period
      -- because some Ctrl/Cmd+C key sequences release the modifier before C.
      C_Timer.After(0.2, function() UI.copyModifierDown = false end)
      return
    end

    if UI.closeOnNextCopy and UI.copyModifierDown and key == "C" then
      CloseAfterNativeCopy()
    end
  end)
  UI.importBox = importBox

  local selectButton = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
  selectButton:SetSize(120, 26)
  selectButton:SetPoint("TOPLEFT", importBox, "BOTTOMLEFT", 0, -14)
  selectButton:SetText("Copy")
  selectButton:SetScript("OnClick", function() SelectImportText(true) end)
  UI.selectButton = selectButton

  local hint = frame:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
  hint:SetPoint("LEFT", selectButton, "RIGHT", 14, 0)
  hint:SetPoint("RIGHT", frame, "RIGHT", -28, 0)
  hint:SetJustifyH("LEFT")
  hint:SetText("Press Copy to select the full string, then press Ctrl+C or Cmd+C.")
  UI.hint = hint

  local footer = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
  footer:SetPoint("BOTTOMLEFT", frame, "BOTTOMLEFT", 24, 22)
  footer:SetPoint("RIGHT", frame, "RIGHT", -28, 0)
  footer:SetJustifyH("LEFT")
  UI.footer = footer

  UI.frame = frame
  return frame
end

local function GetMplusContextFromClient()
  local challengeMapId = nil
  if C_ChallengeMode and C_ChallengeMode.GetActiveChallengeMapID then
    challengeMapId = C_ChallengeMode.GetActiveChallengeMapID()
    if challengeMapId and MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID[challengeMapId] then
      return MPLUS_DUNGEON_BY_CHALLENGE_MAP_ID[challengeMapId], challengeMapId, "challenge-map"
    end
  end

  local inInstance, instanceType = IsInInstance()
  if not inInstance or instanceType ~= "party" then
    return nil, nil, "not-party-instance"
  end

  local _, _, _, _, _, _, _, instanceMapId = GetInstanceInfo()
  if instanceMapId and MPLUS_DUNGEON_BY_INSTANCE_MAP_ID[instanceMapId] then
    return MPLUS_DUNGEON_BY_INSTANCE_MAP_ID[instanceMapId], instanceMapId, "instance-map"
  end

  return nil, instanceMapId or challengeMapId, "unmapped-instance"
end

local function HasMplusRecommendationForSpec(specID, dungeonId)
  local data = QuickWoWTalentsData or {}
  local specEntry = data.recommendations and data.recommendations[specID]
  local recommendation = specEntry
    and specEntry.mplus
    and specEntry.mplus.encounters
    and specEntry.mplus.encounters[dungeonId]

  return type(recommendation) == "table" and recommendation.importString ~= nil
end

local function BuildAutoOpenContext(reason)
  EnsureState()

  if QuickWoWTalentsDB.autoOpenEnabled == false then
    return nil, "disabled"
  end

  local context, clientMapId, source = GetMplusContextFromClient()
  if not context then
    return nil, source
  end

  local specID, specName, errorMessage = GetCurrentSpecInfo()
  if errorMessage then
    return nil, errorMessage
  end

  if not HasMplusRecommendationForSpec(specID, context.qwtDungeonId) then
    return nil, "no bundled Mythic+ recommendation for " .. tostring(specName) .. " / " .. tostring(context.name)
  end

  local zoneToken = UI.autoOpenZoneToken or 0
  return {
    key = tostring(zoneToken) .. ":mplus:" .. tostring(specID) .. ":" .. tostring(context.qwtDungeonId),
    reason = reason or "event",
    specID = specID,
    specName = specName,
    dungeonId = context.qwtDungeonId,
    dungeonName = context.name,
    clientMapId = clientMapId,
    source = source
  }, nil
end

local function OpenAutoRecommendation(context)
  if not context or not context.dungeonId then
    return false
  end

  if UI.frame and UI.frame:IsShown() then
    return false
  end

  if UI.dismissedAutoOpenKey == context.key or UI.lastAutoOpenKey == context.key then
    return false
  end

  if IsInCombat() then
    UI.pendingAutoOpenContext = context
    return false
  end

  EnsureState()
  UI.state.mode = "mplus"
  UI.state.encounterIds.mplus = context.dungeonId
  SaveState()

  local frame = CreateMainFrame()
  UI.autoOpenedContextKey = context.key
  UI.lastAutoOpenKey = context.key
  UI.pendingAutoOpenContext = nil
  frame:Show()
  UpdateRecommendation(false)
  Print("opened " .. tostring(context.dungeonName) .. " build for " .. tostring(context.specName) .. ". Use /qwt auto off to disable automatic opening.")
  return true
end

local function TryAutoOpen(reason)
  local context = BuildAutoOpenContext(reason)
  if context then
    OpenAutoRecommendation(context)
  end
end

local function ScheduleAutoOpenCheck(reason)
  EnsureState()
  if QuickWoWTalentsDB.autoOpenEnabled == false then
    return
  end

  UI.autoOpenCheckToken = (UI.autoOpenCheckToken or 0) + 1
  local token = UI.autoOpenCheckToken
  C_Timer.After(AUTO_OPEN_DELAY_SECONDS, function()
    if UI.autoOpenCheckToken == token then
      TryAutoOpen(reason)
    end
  end)
end

local function ShowRecommendation()
  if IsInCombat() then
    Print("can't open during combat. Try /qwt again when combat ends.")
    return
  end

  EnsureState()
  local frame = CreateMainFrame()
  frame:Show()
  UpdateRecommendation(false)
end

local function SetAutoOpenEnabled(enabled)
  EnsureState()
  QuickWoWTalentsDB.autoOpenEnabled = enabled
  UI.pendingAutoOpenContext = nil
  UI.dismissedAutoOpenKey = nil

  if enabled then
    Print("auto-open enabled. The addon will open once when you enter a supported Mythic+ dungeon with a bundled build.")
    ScheduleAutoOpenCheck("slash")
  else
    Print("auto-open disabled. Use /qwt to open manually or /qwt auto on to enable it again.")
  end
end

local function ShowAutoOpenStatus()
  EnsureState()
  local status = QuickWoWTalentsDB.autoOpenEnabled == false and "disabled" or "enabled"
  Print("auto-open is " .. status .. ". Commands: /qwt auto on, /qwt auto off, /qwt auto status.")
end

local function ShowInfo()
  local data = QuickWoWTalentsData or {}
  local counts = data.counts or {}
  local mplusCount = data.modes and data.modes.mplus and data.modes.mplus.dungeons and #data.modes.mplus.dungeons or 0
  local raidCount = data.modes and data.modes.raid and data.modes.raid.bosses and #data.modes.raid.bosses or 0
  local raidDifficulty = data.modes and data.modes.raid and data.modes.raid.difficulty and data.modes.raid.difficulty.name or "Heroic"

  Print("loaded. Bundled import strings: " .. CountRecommendations() .. ".")
  Print("M+: " .. tostring(mplusCount) .. " dungeons, Best Overall only. Raid: " .. tostring(raidCount) .. " bosses, " .. tostring(raidDifficulty) .. " only.")
  Print("Data source: " .. tostring(data.source or "unknown") .. "; skipped: " .. tostring(counts.skipped or 0) .. ".")
  ShowAutoOpenStatus()
end

local eventFrame = CreateFrame("Frame")
eventFrame:RegisterEvent("ADDON_LOADED")
eventFrame:RegisterEvent("PLAYER_REGEN_DISABLED")
eventFrame:RegisterEvent("PLAYER_REGEN_ENABLED")
eventFrame:RegisterEvent("PLAYER_ENTERING_WORLD")
eventFrame:RegisterEvent("ZONE_CHANGED_NEW_AREA")
eventFrame:RegisterEvent("PLAYER_SPECIALIZATION_CHANGED")
eventFrame:RegisterEvent("CHALLENGE_MODE_START")
eventFrame:RegisterEvent("CHALLENGE_MODE_RESET")
eventFrame:SetScript("OnEvent", function(_, event, addonName)
  if event == "ADDON_LOADED" and addonName == ADDON_NAME then
    QuickWoWTalentsDB = QuickWoWTalentsDB or {}
    EnsureState()
  elseif event == "PLAYER_ENTERING_WORLD" then
    UI.autoOpenZoneToken = (UI.autoOpenZoneToken or 0) + 1
    ScheduleAutoOpenCheck(event)
  elseif event == "PLAYER_SPECIALIZATION_CHANGED" then
    local unit = addonName
    if not unit or unit == "player" then
      ScheduleAutoOpenCheck(event)
    end
  elseif event == "ZONE_CHANGED_NEW_AREA" or event == "CHALLENGE_MODE_START" or event == "CHALLENGE_MODE_RESET" then
    ScheduleAutoOpenCheck(event)
  elseif event == "PLAYER_REGEN_DISABLED" and UI.frame and UI.frame:IsShown() then
    UI.frame:Hide()
    Print("hidden for combat. Run /qwt again when combat ends.")
  elseif event == "PLAYER_REGEN_ENABLED" and UI.pendingAutoOpenContext then
    OpenAutoRecommendation(UI.pendingAutoOpenContext)
  end
end)

SLASH_QUICKWOWTALENTS1 = "/qwt"
SLASH_QUICKWOWTALENTS2 = "/quickwowtalents"
SlashCmdList.QUICKWOWTALENTS = function(message)
  local command = string.lower(strtrim(message or ""))
  if command == "info" or command == "version" then
    ShowInfo()
  elseif command == "auto" or command == "auto status" then
    ShowAutoOpenStatus()
  elseif command == "auto on" or command == "auto enable" then
    SetAutoOpenEnabled(true)
  elseif command == "auto off" or command == "auto disable" then
    SetAutoOpenEnabled(false)
  elseif command == "hide" then
    if UI.frame then UI.frame:Hide() end
  else
    ShowRecommendation()
  end
end
